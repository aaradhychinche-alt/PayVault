'use strict';
/**
 * src/investigation/ai/model/qwenModel.js
 *
 * Local Qwen Model Adapter for Payvault.
 * Invokes a local open-source Qwen model (via Ollama or compatible local runtime)
 * ONLY when difficult/ambiguous cases are escalated by the Model Router.
 *
 * SECURITY & CONTAINMENT:
 * - Operates 100% locally on localhost (NO cloud LLM APIs, NO Gemini, NO OpenAI, NO Claude).
 * - Receives ONLY structured InvestigationCase evidence facts.
 * - ZERO access to filesystem, environment secrets, database, or Razorpay API.
 * - Strict anti-hallucination prompt constraints.
 */

const http = require('http');
const { URL } = require('url');

const DEFAULT_OLLAMA_BASE_URL = process.env.OLLAMA_BASE_URL || 'http://127.0.0.1:11434';
const DEFAULT_QWEN_MODEL      = process.env.QWEN_MODEL || 'qwen2.5:7b';
const DEFAULT_TIMEOUT_MS      = parseInt(process.env.QWEN_TIMEOUT_MS, 10) || 12000;

class QwenLocalModel {
  constructor(options = {}) {
    this.baseUrl   = options.baseUrl || DEFAULT_OLLAMA_BASE_URL;
    this.model     = options.model || DEFAULT_QWEN_MODEL;
    this.timeoutMs = options.timeoutMs || DEFAULT_TIMEOUT_MS;
  }

  /**
   * Check if the local Ollama instance with Qwen is reachable.
   *
   * @returns {Promise<boolean>}
   */
  async isAvailable() {
    return new Promise((resolve) => {
      try {
        const u = new URL('/api/tags', this.baseUrl);
        const req = http.request(
          {
            protocol: u.protocol,
            hostname: u.hostname,
            port: u.port || (u.protocol === 'https:' ? 443 : 80),
            path: u.pathname,
            method: 'GET',
            timeout: 1500,
          },
          (res) => {
            let body = '';
            res.on('data', chunk => { body += chunk; });
            res.on('end', () => {
              if (res.statusCode >= 200 && res.statusCode < 300) {
                try {
                  const data = JSON.parse(body);
                  const names = (data.models || []).map(m => m.name || m.model);
                  if (names.length > 0 && !names.includes(this.model)) {
                    const qwenMatch = names.find(n => n.includes('qwen')) || names[0];
                    if (qwenMatch) this.model = qwenMatch;
                  }
                } catch (_) {}
                resolve(true);
              } else {
                resolve(false);
              }
            });
          }
        );

        req.on('error', () => resolve(false));
        req.on('timeout', () => {
          req.destroy();
          resolve(false);
        });
        req.end();
      } catch {
        resolve(false);
      }
    });
  }

  /**
   * Run local Qwen reasoning on an escalated InvestigationCase.
   *
   * @param {Object} investigationCase - Standard InvestigationCase containing extracted evidence
   * @returns {Promise<Object>} Structured investigation output or failure flag
   */
  async investigate(investigationCase) {
    const isAvail = await this.isAvailable();
    if (!isAvail) {
      return {
        success: false,
        reason: 'OLLAMA_UNAVAILABLE',
        error: `Local Ollama instance not reachable at ${this.baseUrl}`,
      };
    }

    const prompt = this._buildInvestigationPrompt(investigationCase);

    return new Promise((resolve) => {
      let isSettled = false;
      const postData = JSON.stringify({
        model: this.model,
        prompt: prompt,
        stream: false,
        format: 'json',
        options: {
          temperature: 0.1, // Low temperature for high factual precision
          top_p: 0.9,
        },
      });

      let parsedUrl;
      try {
        parsedUrl = new URL('/api/generate', this.baseUrl);
      } catch (err) {
        return resolve({
          success: false,
          reason: 'INVALID_BASE_URL',
          error: err.message,
        });
      }

      const req = http.request(
        {
          protocol: parsedUrl.protocol,
          hostname: parsedUrl.hostname,
          port: parsedUrl.port || (parsedUrl.protocol === 'https:' ? 443 : 80),
          path: parsedUrl.pathname,
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(postData),
          },
          timeout: this.timeoutMs,
        },
        (res) => {
          let responseBody = '';
          res.on('data', (chunk) => { responseBody += chunk; });
          res.on('end', () => {
            if (isSettled) return;
            isSettled = true;

            try {
              const parsedOllama = JSON.parse(responseBody);
              const rawText = parsedOllama.response || '';
              const structured = this._parseQwenJson(rawText);

              if (structured) {
                resolve({
                  success: true,
                  model: this.model,
                  analysis: structured,
                });
              } else {
                resolve({
                  success: false,
                  reason: 'INVALID_JSON_RESPONSE',
                  rawOutput: rawText.slice(0, 300),
                });
              }
            } catch (err) {
              resolve({
                success: false,
                reason: 'MALFORMED_OLLAMA_RESPONSE',
                error: err.message,
              });
            }
          });
        }
      );

      req.on('error', (err) => {
        if (!isSettled) {
          isSettled = true;
          resolve({
            success: false,
            reason: 'NETWORK_ERROR',
            error: err.message,
          });
        }
      });

      req.on('timeout', () => {
        if (!isSettled) {
          isSettled = true;
          req.destroy();
          resolve({
            success: false,
            reason: 'TIMEOUT',
            error: `Qwen local inference timed out after ${this.timeoutMs}ms`,
          });
        }
      });

      req.write(postData);
      req.end();
    });
  }

  /**
   * Formats structured prompt for local Qwen with strict anti-hallucination constraints.
   *
   * @private
   */
  _buildInvestigationPrompt(investigationCase) {
    const evidenceFacts = (investigationCase.evidence || []).map(e => ({
      field: e.field || e.name,
      value: e.value,
      type: e.type,
    }));

    const relationships = (investigationCase.relationships || []).map(r => ({
      relationship: r.relationship_type,
      status: r.status,
      details: r.details,
    }));

    const financial = investigationCase.financial_analysis || {};

    return `You are Payvault's internal financial investigation engine.
Analyze the following payment reconciliation exception using ONLY the supplied facts below.

CRITICAL CONSTRAINTS:
1. Ground your response ONLY in the provided evidence.
2. NEVER invent transactions, settlement records, refunds, amounts, or timestamps.
3. Clearly distinguish facts from conclusions.
4. Keep the explanation concise and professional for a finance/operations user.
5. Return your response in valid JSON matching the exact schema below.

CASE DATA:
- Case ID: ${investigationCase.case_id}
- Exception Category: ${investigationCase.exception_category}
- Exception Finding: ${investigationCase.exception?.description || investigationCase.reconciliation_result?.reason || 'Reconciliation discrepancy detected.'}
- Amount at Risk: ₹${((investigationCase.amount_at_risk || 0) / 100).toFixed(2)}
- Gross Amount: ₹${((financial.gross_amount || 0) / 100).toFixed(2)}
- Fee Actual: ₹${((financial.fee_actual || 0) / 100).toFixed(2)}
- Fee Expected: ₹${((financial.fee_expected || 0) / 100).toFixed(2)}
- Net Credit: ₹${((financial.settlement_credit || 0) / 100).toFixed(2)}
- Expected Net: ₹${((financial.expected_merchant_amount || 0) / 100).toFixed(2)}
- Net Variance: ₹${((financial.merchant_variance || 0) / 100).toFixed(2)}

RELATIONSHIPS:
${JSON.stringify(relationships, null, 2)}

EXTRACTED FACTS:
${JSON.stringify(evidenceFacts, null, 2)}

REQUIRED JSON OUTPUT SCHEMA:
{
  "summary": "<1 sentence concise summary>",
  "what_happened": "<1-2 sentences explaining the discrepancy>",
  "why_it_matters": "<1 sentence explaining the financial or operational impact>",
  "recommended_action": "<1-2 sentences with concrete next steps for operations>",
  "assessment": "NEEDS_REVIEW",
  "supporting_evidence": [
    "<Fact 1 from provided evidence>",
    "<Fact 2 from provided evidence>"
  ]
}`;
  }

  /**
   * Parses JSON from Qwen output safely.
   *
   * @private
   */
  _parseQwenJson(rawText) {
    if (!rawText || typeof rawText !== 'string') return null;

    try {
      return JSON.parse(rawText.trim());
    } catch {
      // Attempt markdown code block extraction
      const match = rawText.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
      if (match && match[1]) {
        try {
          return JSON.parse(match[1].trim());
        } catch {
          return null;
        }
      }
      return null;
    }
  }
}

const defaultQwenModel = new QwenLocalModel();

module.exports = {
  QwenLocalModel,
  defaultQwenModel,
};
