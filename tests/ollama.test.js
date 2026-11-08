'use strict';
/**
 * tests/ollama.test.js
 *
 * Focused tests for Local Ollama AI Investigation & Chat Integration:
 * - Evidence pack extraction with stable IDs ([EV-01] to [EV-08])
 * - Case isolation: Case A evidence facts cannot bleed into Case B
 * - Explicit fallback when Ollama is disabled or unreachable
 * - Provenance tracking & model name transparency
 * - Anti-hallucination verification
 * - REAL local inference execution against localhost:11434 with qwen2.5:1.5b
 */

const {
  OllamaChatEngine,
  enforceDeterministicGrounding,
  DETERMINISTIC_TOOLS,
  executeDeterministicTool,
} = require('../src/investigation/ai/model/ollamaChat');
const { PayvaultAI } = require('../src/investigation/chat/chatRouter');

describe('Local Ollama Investigation & Chat Intelligence Suite', () => {
  // Sample Test Contexts for Case Isolation testing
  const caseA_FeeTax = {
    case_id: 'exc_fee_001',
    exception_category: 'FEE_TAX_VARIANCE',
    status: 'OPEN',
    exception_description: 'Gateway deducted 4.5% fee instead of contracted 2.0%.',
    amount_at_risk_paise: 2950,
    amount_at_risk_formatted: '₹29.50',
    gross_amount_paise: 100000,
    gross_amount_formatted: '₹1,000.00',
    fee_actual_paise: 4500,
    fee_actual_formatted: '₹45.00',
    fee_expected_paise: 2000,
    fee_expected_formatted: '₹20.00',
    fee_variance_paise: 2500,
    fee_variance_formatted: '₹25.00',
    tax_actual_paise: 810,
    tax_actual_formatted: '₹8.10',
    tax_expected_paise: 360,
    tax_expected_formatted: '₹3.60',
    tax_variance_paise: 450,
    tax_variance_formatted: '₹4.50',
    actual_settlement_paise: 94690,
    actual_settlement_formatted: '₹946.90',
    expected_net_paise: 97640,
    expected_net_formatted: '₹976.40',
    net_shortfall_formatted: '₹29.50',
    payment_id: 'pay_live_alpha_01',
    order_id: 'order_cust_alpha_01',
    settlement_id: 'setl_batch_alpha',
    settlement_utr: 'UTR_ALPHA_9999',
    suggested_actions: [
      { priority: 'HIGH', description: 'Request ₹29.50 fee correction credit from gateway.' },
    ],
  };

  const caseB_Timing = {
    case_id: 'exc_timing_002',
    exception_category: 'TIMING_MISMATCH',
    status: 'IN_REVIEW',
    exception_description: 'Refund posted in settlement cycle T+3 whereas payment was settled in T+2.',
    amount_at_risk_paise: 50000,
    amount_at_risk_formatted: '₹500.00',
    gross_amount_formatted: '₹500.00',
    fee_actual_formatted: '₹0.00',
    fee_expected_formatted: '₹0.00',
    fee_variance_formatted: '₹0.00',
    tax_actual_formatted: '₹0.00',
    tax_expected_formatted: '₹0.00',
    tax_variance_formatted: '₹0.00',
    actual_settlement_formatted: '₹0.00',
    expected_net_formatted: '₹500.00',
    net_shortfall_formatted: '₹500.00',
    payment_id: 'pay_live_beta_02',
    order_id: 'order_cust_beta_02',
    settlement_id: 'setl_batch_beta',
    settlement_utr: 'UTR_BETA_8888',
    suggested_actions: [
      { priority: 'MEDIUM', description: 'Verify cross-period batch split on gateway portal.' },
    ],
  };

  describe('1. Evidence Extraction & Citation Pack', () => {
    test('extracts all verified evidence items with stable [EV-xx] identifiers', () => {
      const engine = new OllamaChatEngine({ enabled: false });
      const pack = engine.extractEvidencePack(caseA_FeeTax);

      expect(Array.isArray(pack)).toBe(true);
      expect(pack.length).toBeGreaterThanOrEqual(8);

      const ids = pack.map(e => e.id);
      expect(ids).toContain('EV-01'); // Category & finding
      expect(ids).toContain('EV-02'); // Amount at risk
      expect(ids).toContain('EV-03'); // Gross amount
      expect(ids).toContain('EV-04'); // Fee breakdown
      expect(ids).toContain('EV-05'); // GST breakdown
      expect(ids).toContain('EV-06'); // Net shortfall
      expect(ids).toContain('EV-07'); // Identifiers
      expect(ids).toContain('EV-08'); // Next action

      // Verify facts are strictly grounded in Case A data
      const ev04 = pack.find(e => e.id === 'EV-04');
      expect(ev04.fact).toContain('₹45.00');
      expect(ev04.fact).toContain('₹20.00');
      expect(ev04.fact).toContain('₹25.00');

      const ev07 = pack.find(e => e.id === 'EV-07');
      expect(ev07.fact).toContain('pay_live_alpha_01');
      expect(ev07.fact).toContain('UTR_ALPHA_9999');
    });

    test('preserves strict case isolation between Case A and Case B', () => {
      const engine = new OllamaChatEngine({ enabled: false });
      const packA = engine.extractEvidencePack(caseA_FeeTax);
      const packB = engine.extractEvidencePack(caseB_Timing);

      const stringA = JSON.stringify(packA);
      const stringB = JSON.stringify(packB);

      // Case A must never contain Case B identifiers or figures
      expect(stringA).not.toContain('pay_live_beta_02');
      expect(stringA).not.toContain('UTR_BETA_8888');
      expect(stringA).not.toContain('TIMING_MISMATCH');

      // Case B must never contain Case A identifiers or figures
      expect(stringB).not.toContain('pay_live_alpha_01');
      expect(stringB).not.toContain('UTR_ALPHA_9999');
      expect(stringB).not.toContain('FEE_TAX_VARIANCE');
      expect(stringB).not.toContain('₹29.50');
    });
  });

  describe('2. Fallback Mechanics & Provenance Transparency', () => {
    test('explicitly executes native fallback when Ollama is disabled by config', async () => {
      const engine = new OllamaChatEngine({ enabled: false });
      const res = await engine.generateAnswer({
        message: 'Why was this flagged?',
        ctx: caseA_FeeTax,
      });

      expect(res.fallback_used).toBe(true);
      expect(res.fallback_reason).toBe('OLLAMA_DISABLED_BY_CONFIG');
      expect(res.model).toBe('Payvault AI (Native Fallback)');
      expect(res.execution_mode).toBe('DIRECT_PAYVAULT_AI');
      expect(res.answer).toContain('Fee / Tax Variance');
      expect(res.cited_evidence).toBeDefined();
    });

    test('explicitly executes native fallback when Ollama endpoint is unreachable', async () => {
      // Point to an invalid non-existent port
      const engine = new OllamaChatEngine({ baseUrl: 'http://127.0.0.1:59999', timeoutMs: 800 });
      const res = await engine.generateAnswer({
        message: 'How much was the fee overcharge?',
        ctx: caseA_FeeTax,
      });

      expect(res.fallback_used).toBe(true);
      expect(res.model).toBe('Payvault AI (Native Fallback)');
      expect(res.execution_mode).toBe('DIRECT_PAYVAULT_AI');
      expect(res.answer).toContain('₹25.00'); // deterministic mathematical fact
    });
  });

  describe('3. Real Local Model Inference Test (localhost:11434)', () => {
    test('successfully executes real inference against local running Ollama model with deterministic evidence composition (Case A: Fee/Tax)', async () => {
      const engine = new OllamaChatEngine({
        baseUrl: 'http://127.0.0.1:11434',
        model: 'qwen2.5:1.5b',
        timeoutMs: 15000,
      });

      const avail = await engine.checkAvailability();
      if (!avail.available) {
        console.warn('Ollama daemon not running; skipping live inference test.');
        return;
      }

      console.log(`[REAL OLLAMA TEST 1] Running inference on model: ${avail.model} (Case A: Fee/Tax)`);
      expect(avail.models.length).toBeGreaterThan(0);

      const res = await engine.generateAnswer({
        message: 'What is the platform fee overcharge and why was this case flagged?',
        ctx: caseA_FeeTax,
      });

      expect(res.success !== false).toBe(true);
      expect(res.answer).toBeDefined();
      expect(typeof res.answer).toBe('string');
      expect(res.answer.length).toBeGreaterThan(20);

      console.log('[REAL OLLAMA FACTUAL ANSWER 1]:', res.answer);
      console.log('[REAL OLLAMA RAW COMMENTARY 1]:', res.raw_model_response);

      // Honest provenance:
      expect(res.model).toContain('Ollama');
      expect(res.execution_mode).toBe('LOCAL_OLLAMA_ASSISTED');
      expect(res.answer_composed_by).toBe('payvault_deterministic_evidence_composer');
      expect(res.fallback_used).toBe(false);
      // No unconditional truthfulness claim on free prose:
      expect(res.grounding_verified).toBe(false);
      expect(res.model_confidence).toBe(0.60);
      expect(res.raw_model_response).toBeDefined();
      expect(res.unverified_model_commentary).toContain('[UNVERIFIED LOCAL MODEL COMMENTARY]');

      // Deterministic financial facts:
      expect(res.answer).toContain('₹25.00'); // deterministic fee variance
      expect(res.answer).not.toMatch(/net (?:settlement )?payout of (?:₹|INR\s*)?29\.50/i);
      expect(res.answer).not.toMatch(/(?:exceeds?|exceeded) (?:the )?expected net payout/i);
    }, 25000);

    test('successfully executes repeated real inference on synthetic Case B (Timing Mismatch)', async () => {
      const engine = new OllamaChatEngine({
        baseUrl: 'http://127.0.0.1:11434',
        model: 'qwen2.5:1.5b',
        timeoutMs: 15000,
      });

      const avail = await engine.checkAvailability();
      if (!avail.available) {
        console.warn('Ollama daemon not running; skipping live inference test.');
        return;
      }

      console.log(`[REAL OLLAMA TEST 2] Running inference on model: ${avail.model} (Case B: Timing Mismatch)`);

      const res = await engine.generateAnswer({
        message: 'Why was this timing mismatch exception flagged and what is the amount at risk?',
        ctx: caseB_Timing,
      });

      expect(res.success !== false).toBe(true);
      expect(res.answer).toBeDefined();
      expect(typeof res.answer).toBe('string');

      console.log('[REAL OLLAMA FACTUAL ANSWER 2]:', res.answer);
      expect(res.model).toContain('Ollama');
      expect(res.execution_mode).toBe('LOCAL_OLLAMA_ASSISTED');
      expect(res.answer_composed_by).toBe('payvault_deterministic_evidence_composer');
      expect(res.fallback_used).toBe(false);
      expect(res.grounding_verified).toBe(false);

      // Timing mismatch financial assertions:
      expect(res.answer).toContain('₹500.00'); // amount at risk
      // Case isolation: must not invent fee/tax variance for timing mismatch
      expect(res.answer).not.toContain('₹25.00');
      expect(res.answer).not.toContain('₹29.50');
    }, 25000);
  });

  describe('4. Deterministic Grounding & Anti-Hallucination Controller', () => {
    test('regression: detects, rejects, and replaces exact hallucinated statement claiming shortfall is payout exceeding expected', () => {
      const exactHallucinatedText =
        'The platform fee overcharge was ₹25.00, as the gateway deducted a fee of ₹45.00 instead of the contracted amount of ₹20.00. This overcharge resulted in a net settlement payout of ₹29.50, which exceeds the expected net payout of ₹976.40, leading to the case being flagged.';

      const grounded = enforceDeterministicGrounding(exactHallucinatedText, caseA_FeeTax);

      expect(grounded.modified).toBe(true);
      expect(grounded.unsupported_claims_rejected.length).toBeGreaterThan(0);
      expect(grounded.unsupported_claims_rejected).toContain('Misidentified shortfall (₹29.50) as net settlement payout');
      expect(grounded.unsupported_claims_rejected).toContain('Incorrectly claimed deficit/shortfall exceeds expected net payout (₹976.40)');

      // Critical financial facts:
      // 1. ₹29.50 is NOT labeled as net payout
      expect(grounded.text).not.toMatch(/net (?:settlement )?payout of ₹29\.50/i);
      // 2. Never claims payout exceeds expected
      expect(grounded.text).not.toMatch(/which exceeds the expected net payout of ₹976\.40/i);
      // 3. Grounded with the true actual payout (₹946.90) and shortfall (₹29.50)
      expect(grounded.text).toContain('₹946.90');
      expect(grounded.text).toContain('₹976.40');
      expect(grounded.text).toContain('₹29.50');
    });

    test('preserves factual text when model generation is already accurate and grounded', () => {
      const accurateText =
        'The gateway deducted a fee of ₹45.00 [EV-04] instead of ₹20.00 [EV-04]. Merchant received net settlement credit of ₹946.90 [EV-06] against expected ₹976.40 [EV-06], leaving a net shortfall of ₹29.50 [EV-02].';

      const grounded = enforceDeterministicGrounding(accurateText, caseA_FeeTax);

      expect(grounded.modified).toBe(false);
      expect(grounded.unsupported_claims_rejected.length).toBe(0);
      expect(grounded.text).toBe(accurateText);
    });

    test('end-to-end immunity: novel wrong amounts and bizarre phrasing bypassing regexes are completely excluded from displayed answer', async () => {
      const engine = new OllamaChatEngine({
        baseUrl: 'http://127.0.0.1:11434',
        model: 'qwen2.5:1.5b',
      });

      // Bizarre novel hallucination that no regex looking for ₹29.50 would catch:
      const bizarreProse =
        'Bank seized ₹88,888.00 in international sanctions penalties. Merchant owes an offshore audit fine of $50,000.00, and settlement was rerouted to a Swiss numbered escrow account with 0% tax waiver.';

      jest.spyOn(engine, 'checkAvailability').mockResolvedValue({
        available: true,
        model: 'qwen2.5:1.5b',
        models: ['qwen2.5:1.5b'],
      });
      jest.spyOn(engine, '_callOllamaChat').mockResolvedValue({
        role: 'assistant',
        content: bizarreProse,
      });
      jest.spyOn(engine, '_callOllama').mockResolvedValue(bizarreProse);

      const res = await engine.generateAnswer({
        message: 'Explain this fee discrepancy.',
        ctx: caseA_FeeTax,
      });

      // 1. The displayed factual answer is owned exclusively by deterministic composer:
      expect(res.answer_composed_by).toBe('payvault_deterministic_evidence_composer');
      expect(res.answer).toBeDefined();
      expect(typeof res.answer).toBe('string');

      // 2. Proves complete immunity from novel hallucinations in displayed factual answer:
      expect(res.answer).not.toContain('88,888');
      expect(res.answer).not.toContain('50,000');
      expect(res.answer).not.toContain('Swiss numbered escrow');
      expect(res.answer).not.toContain('sanctions penalties');

      // 3. Factual ground truth is preserved accurately:
      expect(res.answer).toContain('₹25.00'); // true fee variance

      // 4. Honest provenance tracking through router/API:
      expect(res.grounding_verified).toBe(false); // NO false claim of total truthfulness
      expect(res.model_confidence).toBe(0.60);    // Capped, never 0.95
      expect(res.raw_model_response).toBe(bizarreProse);
      expect(res.unverified_model_commentary).toContain('[UNVERIFIED LOCAL MODEL COMMENTARY]');
      expect(res.unverified_model_commentary).toContain(bizarreProse);

      jest.restoreAllMocks();
    });

    test('HTTP route /api/investigations/:id/chat preserves honest provenance and deterministic answer composition', async () => {
      const request = require('supertest');
      const app = require('../server');
      const store = require('../src/store/dataStore');
      store.reset();
      const s = store.getStore();
      const sampleEx = s.exceptions[0];

      const res = await request(app)
        .post(`/api/investigations/${sampleEx.id}/chat`)
        .send({
          message: 'What is the platform fee overcharge?',
          use_ollama: true,
        });

      expect(res.status).toBe(200);
      expect(res.body.answer).toBeDefined();
      expect(res.body.answer_composed_by).toBe('payvault_deterministic_evidence_composer');
      expect(res.body.model_used).toBeDefined();
      expect(res.body.grounding_verified).toBe(false); // No unconditional truthfulness claim on free prose
      expect(res.body.confidence).toBeDefined();
      expect(res.body.unverified_model_commentary !== undefined).toBe(true);
    });
  });

  describe('7. Deterministic Tool-Calling & Copilot Function Execution', () => {
    test('DETERMINISTIC_TOOLS defines standard tool schemas with typed parameters', () => {
      expect(Array.isArray(DETERMINISTIC_TOOLS)).toBe(true);
      expect(DETERMINISTIC_TOOLS.length).toBe(3);

      const toolNames = DETERMINISTIC_TOOLS.map(t => t.function?.name);
      expect(toolNames).toContain('get_case_financials');
      expect(toolNames).toContain('calculate_variance');
      expect(toolNames).toContain('get_cited_evidence');

      const varTool = DETERMINISTIC_TOOLS.find(t => t.function?.name === 'calculate_variance');
      expect(varTool.function.parameters.required).toContain('expected_amount');
      expect(varTool.function.parameters.required).toContain('actual_amount');
    });

    test('executeDeterministicTool returns authoritative figures directly from case context', () => {
      const fin = executeDeterministicTool('get_case_financials', { case_id: caseA_FeeTax.case_id }, caseA_FeeTax, []);
      expect(fin.case_id).toBe('exc_fee_001');
      expect(fin.platform_fee_actual).toBe('₹45.00');
      expect(fin.platform_fee_expected).toBe('₹20.00');
      expect(fin.net_shortfall_amount_at_risk).toBe('₹29.50');
      expect(fin.verified).toBe(true);

      const variance = executeDeterministicTool('calculate_variance', { expected_amount: 976.40, actual_amount: 946.90 }, caseA_FeeTax, []);
      expect(variance.variance_amount).toBe('29.50');
      expect(variance.variance_minor).toBe(2950);
      expect(variance.is_shortfall).toBe(true);
      expect(variance.verified).toBe(true);

      const engine = new OllamaChatEngine({ enabled: false });
      const pack = engine.extractEvidencePack(caseA_FeeTax);
      const evTool = executeDeterministicTool('get_cited_evidence', { case_id: caseA_FeeTax.case_id }, caseA_FeeTax, pack);
      expect(evTool.evidence.length).toBeGreaterThanOrEqual(8);
      expect(evTool.verified).toBe(true);
    });

    test('OllamaChatEngine executes tool-calling multi-turn flow with priority for deterministic figures', async () => {
      const engine = new OllamaChatEngine({
        baseUrl: 'http://127.0.0.1:11434',
        model: 'qwen2.5:1.5b',
      });

      jest.spyOn(engine, 'checkAvailability').mockResolvedValue({
        available: true,
        model: 'qwen2.5:1.5b',
      });

      // Mock first turn returning a tool call for get_case_financials
      const firstTurnResponse = {
        role: 'assistant',
        content: null,
        tool_calls: [
          {
            id: 'call_case_fin_001',
            type: 'function',
            function: {
              name: 'get_case_financials',
              arguments: { case_id: 'exc_fee_001' },
            },
          },
        ],
      };

      // Mock second turn returning commentary after tool output was received
      const secondTurnResponse = {
        role: 'assistant',
        content: 'Based on verified case financials, the gateway overcharged fee by ₹25.00 [EV-04] and GST by ₹4.50 [EV-05].',
      };

      let turnCount = 0;
      jest.spyOn(engine, '_callOllamaChat').mockImplementation(async ({ messages }) => {
        turnCount++;
        if (turnCount === 1) {
          return firstTurnResponse;
        } else {
          // Verify that tool execution result was passed to turn 2
          const toolMsg = messages.find(m => m.role === 'tool');
          expect(toolMsg).toBeDefined();
          const toolContent = JSON.parse(toolMsg.content);
          expect(toolContent.platform_fee_actual).toBe('₹45.00');
          return secondTurnResponse;
        }
      });

      const res = await engine.generateAnswer({
        message: 'What was the exact platform fee overcharge?',
        ctx: caseA_FeeTax,
      });

      // 1. Tool execution recorded in result
      expect(res.tools_called).toContain('get_case_financials');
      expect(res.tool_results.length).toBe(1);
      expect(res.tool_results[0].tool).toBe('get_case_financials');
      expect(res.tool_results[0].result.verified).toBe(true);

      // 2. Deterministic evidence composer owns the displayed factual answer
      expect(res.answer_composed_by).toBe('payvault_deterministic_evidence_composer');
      expect(res.answer).toBeDefined();
      expect(res.answer).toContain('₹25.00');

      // 3. Raw model commentary isolated as UNVERIFIED
      expect(res.grounding_verified).toBe(false);
      expect(res.unverified_model_commentary).toContain('[UNVERIFIED LOCAL MODEL COMMENTARY]');
      expect(res.unverified_model_commentary).toContain('₹25.00');

      jest.restoreAllMocks();
    });
  });
});
