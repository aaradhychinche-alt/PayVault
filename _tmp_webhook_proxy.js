'use strict';
/**
 * _tmp_webhook_proxy.js
 * Allowlist proxy: forwards ONLY POST /api/paypal/webhook to 127.0.0.1:3002.
 * Everything else gets 404. Binds to 127.0.0.1:3003.
 * Temporary file — delete after use.
 */
const http = require('http');

const PROXY_PORT = 3003;
const UPSTREAM_HOST = '127.0.0.1';
const UPSTREAM_PORT = 3002;
const ALLOWED_METHOD = 'POST';
const ALLOWED_PATH = '/api/paypal/webhook';

const server = http.createServer((req, res) => {
  if (req.method !== ALLOWED_METHOD || req.url !== ALLOWED_PATH) {
    console.log(`[proxy] REJECTED ${req.method} ${req.url}`);
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not Found');
    return;
  }
  console.log(`[proxy] FORWARDING POST ${req.url} → ${UPSTREAM_HOST}:${UPSTREAM_PORT}`);
  const chunks = [];
  req.on('data', c => chunks.push(c));
  req.on('end', () => {
    const body = Buffer.concat(chunks);
    const opts = {
      hostname: UPSTREAM_HOST,
      port: UPSTREAM_PORT,
      path: ALLOWED_PATH,
      method: 'POST',
      headers: { ...req.headers, host: `${UPSTREAM_HOST}:${UPSTREAM_PORT}` },
    };
    const proxy = http.request(opts, (upRes) => {
      res.writeHead(upRes.statusCode, upRes.headers);
      upRes.pipe(res);
    });
    proxy.on('error', (e) => {
      console.error('[proxy] upstream error:', e.message);
      res.writeHead(502);
      res.end('Bad Gateway');
    });
    proxy.write(body);
    proxy.end();
  });
});

server.listen(PROXY_PORT, '127.0.0.1', () => {
  console.log(`[proxy] Listening on 127.0.0.1:${PROXY_PORT} — only POST ${ALLOWED_PATH} forwarded`);
});
