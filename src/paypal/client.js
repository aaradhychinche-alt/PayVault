'use strict';
/**
 * src/paypal/client.js
 *
 * PayPal REST API v2 Client for Sandbox environment.
 * Handles OAuth2 bearer token acquisition with automatic caching,
 * request execution with idempotency, and credential diagnostics.
 *
 * Credentials are read strictly from process.env and NEVER exposed to frontend.
 */

const https = require('https');
const http = require('http');
const { URL } = require('url');

const DEFAULT_SANDBOX_BASE = 'https://api-m.sandbox.paypal.com';

class PayPalClient {
  constructor(options = {}) {
    this.clientId = options.clientId || process.env.PAYPAL_CLIENT_ID || null;
    this.clientSecret = options.clientSecret || process.env.PAYPAL_CLIENT_SECRET || null;
    
    // Strict Sandbox-only safety enforcement:
    const rawApiBase = options.apiBase || process.env.PAYPAL_API_BASE || DEFAULT_SANDBOX_BASE;
    try {
      const u = new URL(rawApiBase);
      if (!u.hostname.endsWith('sandbox.paypal.com') && !u.hostname.includes('localhost') && !u.hostname.includes('127.0.0.1')) {
        console.warn(`[PayPal Security Alert] Non-sandbox URL '${rawApiBase}' detected. Forcing sandbox base: ${DEFAULT_SANDBOX_BASE}`);
        this.apiBase = DEFAULT_SANDBOX_BASE;
      } else {
        this.apiBase = rawApiBase;
      }
    } catch {
      this.apiBase = DEFAULT_SANDBOX_BASE;
    }

    this.webhookId = options.webhookId || process.env.PAYPAL_WEBHOOK_ID || null;
    this.timeoutMs = options.timeoutMs || 15000;

    // In-memory token cache
    this._accessToken = null;
    this._tokenExpiresAt = 0;
  }

  /**
   * Check if PayPal sandbox credentials are fully configured.
   * @returns {boolean}
   */
  isConfigured() {
    return !!(this.clientId && this.clientSecret);
  }

  /**
   * Return a safe diagnostic status with masked client ID.
   * @returns {Object}
   */
  getStatus() {
    const maskedClientId = this.clientId && this.clientId.length > 8
      ? `${this.clientId.slice(0, 6)}...${this.clientId.slice(-4)}`
      : (this.clientId ? 'CONFIGURED' : 'NOT_SET');

    return {
      configured: this.isConfigured(),
      environment: this.apiBase.includes('sandbox') ? 'sandbox' : 'live',
      sandbox_mode: this.apiBase.includes('sandbox'),
      api_base: this.apiBase,
      client_id_masked: maskedClientId,
      client_secret_present: !!this.clientSecret,
      webhook_configured: !!this.webhookId,
    };
  }

  /**
   * Obtain an OAuth2 Bearer Access Token from PayPal Sandbox using Client Credentials.
   * Caches token until 60 seconds before expiration.
   *
   * @returns {Promise<string>}
   */
  async getAccessToken() {
    if (!this.isConfigured()) {
      throw new Error('PayPal credentials missing: PAYPAL_CLIENT_ID or PAYPAL_CLIENT_SECRET is not configured.');
    }

    const now = Date.now();
    if (this._accessToken && this._tokenExpiresAt > now + 60000) {
      return this._accessToken;
    }

    const authHeader = 'Basic ' + Buffer.from(`${this.clientId}:${this.clientSecret}`).toString('base64');
    const postData = 'grant_type=client_credentials';

    const response = await this._makeRequest({
      endpoint: '/v1/oauth2/token',
      method: 'POST',
      headers: {
        'Authorization': authHeader,
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(postData),
      },
      body: postData,
    });

    if (response.status < 200 || response.status >= 300) {
      const errDetail = response.data?.error_description || response.data?.message || JSON.stringify(response.data);
      throw new Error(`PayPal OAuth2 token request failed [${response.status}]: ${errDetail}`);
    }

    const tokenData = response.data;
    this._accessToken = tokenData.access_token;
    const expiresInSec = tokenData.expires_in || 32400; // default 9 hours
    this._tokenExpiresAt = now + (expiresInSec * 1000);

    return this._accessToken;
  }

  /**
   * Make an authenticated HTTP request to PayPal REST API.
   *
   * @param {Object} opts
   * @param {string} opts.endpoint
   * @param {string} opts.method - GET, POST, PATCH, DELETE
   * @param {Object} [opts.data] - JSON body
   * @param {string} [opts.idempotencyKey] - PayPal-Request-Id header for idempotency
   * @param {Object} [opts.customHeaders]
   * @returns {Promise<{ status: number, headers: Object, data: any }>}
   */
  async request({ endpoint, method = 'GET', data = null, idempotencyKey = null, customHeaders = {} }) {
    const token = await this.getAccessToken();

    const headers = {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      ...customHeaders,
    };

    if (idempotencyKey) {
      headers['PayPal-Request-Id'] = idempotencyKey;
    }

    let postData = null;
    if (data !== null && data !== undefined) {
      postData = typeof data === 'string' ? data : JSON.stringify(data);
      headers['Content-Length'] = Buffer.byteLength(postData);
    }

    return this._makeRequest({
      endpoint,
      method,
      headers,
      body: postData,
    });
  }

  /**
   * Low-level HTTP transport.
   * @private
   */
  _makeRequest({ endpoint, method, headers, body }) {
    return new Promise((resolve, reject) => {
      let targetUrl;
      try {
        targetUrl = new URL(endpoint, this.apiBase);
      } catch (err) {
        return reject(new Error(`Invalid PayPal URL: ${endpoint} against base ${this.apiBase}`));
      }

      const isHttps = targetUrl.protocol === 'https:';
      const transport = isHttps ? https : http;

      const reqOptions = {
        protocol: targetUrl.protocol,
        hostname: targetUrl.hostname,
        port: targetUrl.port || (isHttps ? 443 : 80),
        path: targetUrl.pathname + targetUrl.search,
        method: method.toUpperCase(),
        headers: headers || {},
        timeout: this.timeoutMs,
      };

      const req = transport.request(reqOptions, (res) => {
        let rawBody = '';
        res.on('data', chunk => { rawBody += chunk; });
        res.on('end', () => {
          let parsedData;
          try {
            parsedData = rawBody ? JSON.parse(rawBody) : {};
          } catch {
            parsedData = { raw: rawBody };
          }

          resolve({
            status: res.statusCode,
            headers: res.headers,
            data: parsedData,
          });
        });
      });

      req.on('error', (err) => {
        reject(new Error(`PayPal API network error [${method} ${endpoint}]: ${err.message}`));
      });

      req.on('timeout', () => {
        req.destroy();
        reject(new Error(`PayPal API timeout after ${this.timeoutMs}ms [${method} ${endpoint}]`));
      });

      if (body) {
        req.write(body);
      }
      req.end();
    });
  }
}

// Default singleton client
const defaultPayPalClient = new PayPalClient();

module.exports = {
  PayPalClient,
  defaultPayPalClient,
  DEFAULT_SANDBOX_BASE,
};
