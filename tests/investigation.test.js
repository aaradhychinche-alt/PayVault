'use strict';
/**
 * tests/investigation.test.js
 *
 * Comprehensive Test Suite for Chunk 2: Payvault AI Investigation Engine.
 *
 * Verifies:
 *   1. financialAnalysis — integer paise safety & breakdowns
 *   2. timeline — sorted timestamps & provenance
 *   3. relationships — explicit graph with MISSING states
 *   4. suggestedActions — rule-based resolution steps
 *   5. caseBuilder — complete contract assembly across all cases
 *   6. evidence extraction — field-level provenance & types
 *   7. pattern detection — deterministic signals for all categories
 *   8. AI reasoning — candidate root causes, probabilities, evidence links
 *   9. confidence engine — measurable scoring with factor breakdown
 *  10. consistency checker — contradiction detection & conflict marking
 *  11. local model adapter — offline abstract interface
 *  12. end-to-end engine — offline execution across all 24 exceptions
 *  13. HTTP route integration — GET list, GET detail, POST /run
 */

const { generateDataset }         = require('../src/data/generator');
const { reconcile }               = require('../src/engine/reconcile');
const { buildFinancialAnalysis }   = require('../src/investigation/financialAnalysis');
const { buildTimeline }            = require('../src/investigation/timeline');
const { buildRelationships }       = require('../src/investigation/relationships');
const { getSuggestedActions }      = require('../src/investigation/suggestedActions');
const { buildCase }                = require('../src/investigation/caseBuilder');
const { extractEvidence }          = require('../src/investigation/ai/evidence');
const { detectPatterns }           = require('../src/investigation/ai/patterns');
const { reasonOverCase }           = require('../src/investigation/ai/reasoning');
const { calculateConfidence }      = require('../src/investigation/ai/confidence');
const { validateConsistency }      = require('../src/investigation/ai/consistency');
const { LocalModelAdapter }        = require('../src/investigation/ai/model/localModel');
const { investigate }              = require('../src/investigation/ai/engine');
const store                        = require('../src/store/dataStore');

// ── Test fixtures ─────────────────────────────────────────────────────────────

let dataset, results, exceptions, s;

beforeAll(() => {
  store.reset();
  s          = store.getStore();
  dataset    = { settlementRecords: s.settlementRecords, merchantOrders: s.merchantOrders, merchantLedger: s.merchantLedger };
  results    = s.reconciliationResults;
  exceptions = s.exceptions;
});

// ─────────────────────────────────────────────────────────────────────────────
// 1. Financial Analysis
// ─────────────────────────────────────────────────────────────────────────────

describe('financialAnalysis', () => {
  test('all monetary fields are null or integer paise', () => {
    for (const exc of exceptions) {
      const rr  = results.find(r => r.id === exc.reconciliation_result_id);
      const sr  = s.settlementRecords.find(r => r.entity_id === rr.settlement_entity_id) || null;
      const le  = rr.merchant_ledger_id ? s.merchantLedger.find(l => l.id === rr.merchant_ledger_id) : null;
      const rfds = (rr.refund_entity_ids || []).map(id => s.settlementRecords.find(r => r.entity_id === id)).filter(Boolean);

      const fa = buildFinancialAnalysis({ reconResult: rr, settlementRecord: sr, merchantLedger: le, refundRecords: rfds });

      for (const [key, val] of Object.entries(fa)) {
        if (['currency', 'unit', 'comparisons'].includes(key)) continue;
        if (val !== null) {
          expect(Number.isInteger(val)).toBe(true);
        }
      }
    }
  });

  test('currency defaults to INR and unit to paise', () => {
    const exc = exceptions[0];
    const rr  = results.find(r => r.id === exc.reconciliation_result_id);
    const sr  = s.settlementRecords.find(r => r.entity_id === rr.settlement_entity_id) || null;
    const fa  = buildFinancialAnalysis({ reconResult: rr, settlementRecord: sr, merchantLedger: null, refundRecords: [] });
    expect(fa.currency).toBe('INR');
    expect(fa.unit).toBe('paise');
  });

  test('comparisons array is always present', () => {
    for (const exc of exceptions.slice(0, 5)) {
      const rr  = results.find(r => r.id === exc.reconciliation_result_id);
      const sr  = s.settlementRecords.find(r => r.entity_id === rr.settlement_entity_id) || null;
      const le  = rr.merchant_ledger_id ? s.merchantLedger.find(l => l.id === rr.merchant_ledger_id) : null;
      const rfds = (rr.refund_entity_ids || []).map(id => s.settlementRecords.find(r => r.entity_id === id)).filter(Boolean);
      const fa  = buildFinancialAnalysis({ reconResult: rr, settlementRecord: sr, merchantLedger: le, refundRecords: rfds });
      expect(Array.isArray(fa.comparisons)).toBe(true);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. Timeline
// ─────────────────────────────────────────────────────────────────────────────

describe('timeline', () => {
  test('all timestamps are valid positive integers', () => {
    for (const exc of exceptions.slice(0, 10)) {
      const rr     = results.find(r => r.id === exc.reconciliation_result_id);
      const sr     = s.settlementRecords.find(r => r.entity_id === rr.settlement_entity_id) || null;
      const mo     = rr.merchant_order_id ? s.merchantOrders.find(m => m.id === rr.merchant_order_id) : null;
      const le     = rr.merchant_ledger_id ? s.merchantLedger.find(l => l.id === rr.merchant_ledger_id) : null;
      const rfds   = (rr.refund_entity_ids || []).map(id => s.settlementRecords.find(r => r.entity_id === id)).filter(Boolean);
      const tl     = buildTimeline({ exception: exc, reconResult: rr, settlementRecord: sr, merchantOrder: mo, merchantLedger: le, refundRecords: rfds });

      for (const ev of tl) {
        expect(typeof ev.timestamp).toBe('number');
        expect(ev.timestamp).toBeGreaterThan(0);
        expect(Number.isInteger(ev.timestamp)).toBe(true);
      }
    }
  });

  test('timeline is sorted ascending by timestamp', () => {
    for (const exc of exceptions.slice(0, 10)) {
      const rr  = results.find(r => r.id === exc.reconciliation_result_id);
      const sr  = s.settlementRecords.find(r => r.entity_id === rr.settlement_entity_id) || null;
      const mo  = rr.merchant_order_id ? s.merchantOrders.find(m => m.id === rr.merchant_order_id) : null;
      const le  = rr.merchant_ledger_id ? s.merchantLedger.find(l => l.id === rr.merchant_ledger_id) : null;
      const rfds = (rr.refund_entity_ids || []).map(id => s.settlementRecords.find(r => r.entity_id === id)).filter(Boolean);
      const tl  = buildTimeline({ exception: exc, reconResult: rr, settlementRecord: sr, merchantOrder: mo, merchantLedger: le, refundRecords: rfds });

      for (let i = 1; i < tl.length; i++) {
        expect(tl[i].timestamp).toBeGreaterThanOrEqual(tl[i - 1].timestamp);
      }
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. Relationships
// ─────────────────────────────────────────────────────────────────────────────

describe('relationships', () => {
  test('each relationship has required fields and valid status', () => {
    const exc  = exceptions[0];
    const rr   = results.find(r => r.id === exc.reconciliation_result_id);
    const sr   = s.settlementRecords.find(r => r.entity_id === rr.settlement_entity_id) || null;
    const rels = buildRelationships({ exception: exc, reconResult: rr, settlementRecord: sr, merchantOrder: null, merchantLedger: null, refundRecords: [] });

    for (const rel of rels) {
      expect(rel).toHaveProperty('relationship');
      expect(rel).toHaveProperty('from');
      expect(rel).toHaveProperty('status');
      expect(rel).toHaveProperty('description');
      expect(['PRESENT', 'MISSING', 'SIMULATED']).toContain(rel.status);
    }
  });

  test('MISSING_ORDER exception has MISSING payment-to-merchant-order relationship', () => {
    const missingOrderExc = exceptions.find(e => e.category === 'MISSING_ORDER');
    if (!missingOrderExc) return;

    const rr   = results.find(r => r.id === missingOrderExc.reconciliation_result_id);
    const sr   = s.settlementRecords.find(r => r.entity_id === rr.settlement_entity_id) || null;
    const rels = buildRelationships({ exception: missingOrderExc, reconResult: rr, settlementRecord: sr, merchantOrder: null, merchantLedger: null, refundRecords: [] });

    const missingRel = rels.find(r => r.relationship === 'PAYMENT_TO_MERCHANT_ORDER' && r.status === 'MISSING');
    expect(missingRel).toBeDefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. Suggested Actions
// ─────────────────────────────────────────────────────────────────────────────

describe('suggestedActions', () => {
  test('every exception category produces at least 2 actions sorted by priority', () => {
    const categories = ['FEE_TAX_VARIANCE', 'MISSING_ORDER', 'MISSING_PAYMENT', 'DUPLICATE', 'TIMING_MISMATCH', 'ADJUSTMENT', 'UNEXPLAINED'];
    const fakeExc  = (category) => ({ id: 'exc_test', category, amount_at_risk: 1000, reconciliation_result_id: 'r1' });
    const fakeRr   = { id: 'r1', settlement_entity_id: 'pay_x', merchant_order_id: 'mo_y', merchant_ledger_id: 'le_z', refund_entity_ids: [], status: 'EXCEPTION' };
    const fakeAnalysis = { gross_amount: 1000, fee_expected: 20, fee_actual: 40, fee_variance: 20, merchant_variance: 0, amount_at_risk: 1000 };

    for (const cat of categories) {
      const actions = getSuggestedActions({ exception: fakeExc(cat), reconResult: fakeRr, financialAnalysis: fakeAnalysis });
      expect(actions.length).toBeGreaterThanOrEqual(2);
      expect(actions.map(a => a.action_type)).toContain('DOCUMENT_FINDING');

      for (let i = 1; i < actions.length; i++) {
        expect(actions[i].priority).toBeGreaterThanOrEqual(actions[i - 1].priority);
      }
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. Case Builder
// ─────────────────────────────────────────────────────────────────────────────

describe('caseBuilder', () => {
  test('builds a valid InvestigationCase for every exception', () => {
    for (const exc of exceptions) {
      const rr = results.find(r => r.id === exc.reconciliation_result_id);
      const ic = buildCase({ exception: exc, reconResult: rr, store: s });

      expect(ic.case_id).toBe(exc.id);
      expect(ic.exception_category).toBe(exc.category);
      expect(ic.amount_at_risk).toBe(exc.amount_at_risk);
      expect(ic.status).toBe('open');
      expect(ic.financial_analysis).toBeDefined();
      expect(Array.isArray(ic.timeline)).toBe(true);
      expect(Array.isArray(ic.relationships)).toBe(true);
      expect(Array.isArray(ic.suggested_actions)).toBe(true);
    }
  });

  test('ground truth is strictly omitted from InvestigationCase', () => {
    const exc = exceptions[0];
    const rr  = results.find(r => r.id === exc.reconciliation_result_id);
    const ic  = buildCase({ exception: exc, reconResult: rr, store: s });

    expect(ic).not.toHaveProperty('ground_truth');
    expect(ic).not.toHaveProperty('_groundTruth');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 6. Evidence Engine
// ─────────────────────────────────────────────────────────────────────────────

describe('evidence extraction', () => {
  test('extracts structured facts with IDs and importance levels', () => {
    const exc = exceptions[0];
    const rr  = results.find(r => r.id === exc.reconciliation_result_id);
    const ic  = buildCase({ exception: exc, reconResult: rr, store: s });

    const evidence = extractEvidence(ic);
    expect(Array.isArray(evidence)).toBe(true);
    expect(evidence.length).toBeGreaterThan(5);

    for (const item of evidence) {
      expect(item).toHaveProperty('id');
      expect(item.id).toMatch(/^ev_\d{3}$/);
      expect(item).toHaveProperty('source');
      expect(item).toHaveProperty('field');
      expect(item).toHaveProperty('value');
      expect(item.type).toBe('FACT');
      expect(['HIGH', 'MEDIUM', 'LOW']).toContain(item.importance);
    }
  });

  test('evidence values are facts matching case fields exactly', () => {
    const exc = exceptions[0];
    const rr  = results.find(r => r.id === exc.reconciliation_result_id);
    const ic  = buildCase({ exception: exc, reconResult: rr, store: s });

    const evidence = extractEvidence(ic);
    const catItem = evidence.find(e => e.source === 'exception' && e.field === 'category');
    expect(catItem).toBeDefined();
    expect(catItem.value).toBe(exc.category);

    const riskItem = evidence.find(e => e.source === 'exception' && e.field === 'amount_at_risk');
    expect(riskItem).toBeDefined();
    expect(riskItem.value).toBe(exc.amount_at_risk);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 7. Pattern Engine
// ─────────────────────────────────────────────────────────────────────────────

describe('pattern detection', () => {
  test('detects pattern corresponding to exception category', () => {
    for (const exc of exceptions) {
      const rr = results.find(r => r.id === exc.reconciliation_result_id);
      const ic = buildCase({ exception: exc, reconResult: rr, store: s });
      const evidence = extractEvidence(ic);
      const patterns = detectPatterns(ic, evidence);

      expect(Array.isArray(patterns)).toBe(true);
      expect(patterns.length).toBeGreaterThan(0);

      for (const p of patterns) {
        expect(p).toHaveProperty('pattern_id');
        expect(p).toHaveProperty('name');
        expect(p).toHaveProperty('severity');
        expect(Array.isArray(p.evidence_ids)).toBe(true);
        expect(typeof p.explanation).toBe('string');
      }
    }
  });

  test('FEE_TAX_VARIANCE triggers PATTERN_FEE_MISMATCH', () => {
    const feeExc = exceptions.find(e => e.category === 'FEE_TAX_VARIANCE');
    if (!feeExc) return;

    const rr = results.find(r => r.id === feeExc.reconciliation_result_id);
    const ic = buildCase({ exception: feeExc, reconResult: rr, store: s });
    const evidence = extractEvidence(ic);
    const patterns = detectPatterns(ic, evidence);

    const feePattern = patterns.find(p => p.pattern_id === 'PATTERN_FEE_MISMATCH');
    expect(feePattern).toBeDefined();
    expect(feePattern.severity).toMatch(/HIGH|MEDIUM/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 8. AI Reasoning Engine
// ─────────────────────────────────────────────────────────────────────────────

describe('reasoning engine', () => {
  test('generates ranked candidate root causes citing valid evidence IDs', () => {
    for (const exc of exceptions.slice(0, 8)) {
      const rr = results.find(r => r.id === exc.reconciliation_result_id);
      const ic = buildCase({ exception: exc, reconResult: rr, store: s });
      const evidence = extractEvidence(ic);
      const patterns = detectPatterns(ic, evidence);
      const reasoning = reasonOverCase(ic, evidence, patterns);

      expect(reasoning.candidate_root_causes.length).toBeGreaterThan(0);
      expect(reasoning.primary_root_cause).toBeDefined();
      expect(reasoning.primary_root_cause.cause).toBeTruthy();
      expect(['Supported by evidence', 'Likely', 'Possible', 'Insufficient evidence']).toContain(
        reasoning.primary_root_cause.support_status
      );

      const validEvIds = new Set(evidence.map(e => e.id));
      for (const evId of reasoning.primary_root_cause.evidence_ids) {
        expect(validEvIds.has(evId)).toBe(true);
      }
    }
  });

  test('financial impact includes amount_at_risk and integer paise fields', () => {
    const exc = exceptions[0];
    const rr  = results.find(r => r.id === exc.reconciliation_result_id);
    const ic  = buildCase({ exception: exc, reconResult: rr, store: s });
    const evidence = extractEvidence(ic);
    const patterns = detectPatterns(ic, evidence);
    const reasoning = reasonOverCase(ic, evidence, patterns);

    expect(reasoning.financial_impact.amount_at_risk).toBe(exc.amount_at_risk);
    expect(reasoning.financial_impact.currency).toBe('INR');
    expect(reasoning.financial_impact.unit).toBe('paise');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 9. Confidence Engine
// ─────────────────────────────────────────────────────────────────────────────

describe('confidence engine', () => {
  test('calculates score between 0 and 100 with factor breakdown', () => {
    for (const exc of exceptions.slice(0, 8)) {
      const rr = results.find(r => r.id === exc.reconciliation_result_id);
      const ic = buildCase({ exception: exc, reconResult: rr, store: s });
      const evidence = extractEvidence(ic);
      const patterns = detectPatterns(ic, evidence);
      const reasoning = reasonOverCase(ic, evidence, patterns);
      const confidence = calculateConfidence({
        primaryRootCause: reasoning.primary_root_cause,
        evidence,
        patterns,
        investigationCase: ic,
      });

      expect(confidence.score).toBeGreaterThanOrEqual(0);
      expect(confidence.score).toBeLessThanOrEqual(100);
      expect(['LOW', 'MEDIUM', 'HIGH']).toContain(confidence.level);
      expect(Array.isArray(confidence.factors)).toBe(true);
      expect(confidence.factors.length).toBeGreaterThan(0);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 10. Consistency Checker & Contradiction Detection
// ─────────────────────────────────────────────────────────────────────────────

describe('consistency checker', () => {
  test('passes on valid case reasoning', () => {
    const exc = exceptions[0];
    const rr  = results.find(r => r.id === exc.reconciliation_result_id);
    const ic  = buildCase({ exception: exc, reconResult: rr, store: s });
    const evidence = extractEvidence(ic);
    const patterns = detectPatterns(ic, evidence);
    const reasoning = reasonOverCase(ic, evidence, patterns);
    const confidence = calculateConfidence({
      primaryRootCause: reasoning.primary_root_cause,
      evidence,
      patterns,
      investigationCase: ic,
    });

    const validation = validateConsistency({
      investigationCase: ic,
      evidence,
      reasoningOutput: reasoning,
      confidenceOutput: confidence,
    });

    expect(validation.isValid).toBe(true);
    expect(validation.conflicts.length).toBe(0);
  });

  test('detects fabricated evidence IDs and flags violation', () => {
    const exc = exceptions[0];
    const rr  = results.find(r => r.id === exc.reconciliation_result_id);
    const ic  = buildCase({ exception: exc, reconResult: rr, store: s });
    const evidence = extractEvidence(ic);
    const patterns = detectPatterns(ic, evidence);
    const reasoning = reasonOverCase(ic, evidence, patterns);

    // Corrupt evidence ID
    reasoning.primary_root_cause.evidence_ids.push('ev_fabricated_999');

    const confidence = calculateConfidence({
      primaryRootCause: reasoning.primary_root_cause,
      evidence,
      patterns,
      investigationCase: ic,
    });

    const validation = validateConsistency({
      investigationCase: ic,
      evidence,
      reasoningOutput: reasoning,
      confidenceOutput: confidence,
    });

    expect(validation.isValid).toBe(false);
    expect(validation.conflicts.some(c => c.type === 'INVALID_EVIDENCE_REFERENCE')).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 11. Local Model Adapter
// ─────────────────────────────────────────────────────────────────────────────

describe('local model adapter', () => {
  test('gracefully reports unavailable when offline/no server without crashing', async () => {
    const adapter = new LocalModelAdapter({ host: '127.0.0.1', port: 65530 }); // non-existent port
    const isAvail = await adapter.isAvailable();
    expect(isAvail).toBe(false);

    const result = await adapter.generate('test prompt');
    expect(result.success).toBe(false);
    expect(result.model).toBe('none');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 12. Payvault Local ML Adapter & ModelRouter
// ─────────────────────────────────────────────────────────────────────────────

const { PayvaultLocalModel, defaultPayvaultModel } = require('../src/investigation/ai/model/payvaultModel');

describe('PayvaultLocalModel (Python ML Subsystem Integration)', () => {
  test('invokes Python predict.py and returns valid predictions and probabilities', async () => {
    const exc = exceptions[0];
    const rr  = results.find(r => r.id === exc.reconciliation_result_id);
    const ic  = buildCase({ exception: exc, reconResult: rr, store: s });

    const mlResult = await defaultPayvaultModel.predict(ic);

    expect(mlResult).toHaveProperty('model', 'Payvault Local ML');
    expect(mlResult).toHaveProperty('model_version', 'payvault-ml-v1');
    expect(mlResult).toHaveProperty('predicted_category');
    expect(typeof mlResult.confidence).toBe('number');
    expect(mlResult.confidence).toBeGreaterThanOrEqual(0.0);
    expect(mlResult.confidence).toBeLessThanOrEqual(1.0);
    expect(mlResult).toHaveProperty('probabilities');
    expect(mlResult).toHaveProperty('all_probabilities');
    expect(Array.isArray(mlResult.top_features)).toBe(true);
    expect(mlResult.top_features.length).toBeGreaterThan(0);

    // Sum of all probabilities should be ~1.0
    const sumProbs = Object.values(mlResult.all_probabilities).reduce((a, b) => a + b, 0);
    expect(sumProbs).toBeCloseTo(1.0, 2);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 12. Difficulty Evaluation & Qwen Escalation Routing
// ─────────────────────────────────────────────────────────────────────────────

const { evaluateDifficulty } = require('../src/investigation/ai/difficulty');
const { QwenLocalModel }     = require('../src/investigation/ai/model/qwenModel');
const { ModelRouter }        = require('../src/investigation/ai/model/modelRouter');

describe('Difficulty Evaluation & Qwen Escalation Routing', () => {
  test('1. Easy case with high confidence is handled locally without escalation', () => {
    const exc = exceptions.find(e => e.category === 'CLEAN_MATCH') || exceptions[0];
    const rr  = results.find(r => r.id === exc.reconciliation_result_id);
    const ic  = buildCase({ exception: exc, reconResult: rr, store: s });

    const mlAnalysis = {
      predicted_category: exc.category,
      confidence: 0.95,
      all_probabilities: { [exc.category]: 0.95, UNEXPLAINED: 0.05 },
    };

    const diff = evaluateDifficulty(ic, mlAnalysis);
    expect(diff.shouldEscalate).toBe(false);
    expect(diff.complexityLevel).toBe('LOW');
  });

  test('2. Ambiguous case with narrow probability margin escalates to Qwen', () => {
    const exc = exceptions[0];
    const rr  = results.find(r => r.id === exc.reconciliation_result_id);
    const ic  = buildCase({ exception: exc, reconResult: rr, store: s });

    const mlAnalysis = {
      predicted_category: 'FEE_TAX_VARIANCE',
      confidence: 0.52,
      all_probabilities: { FEE_TAX_VARIANCE: 0.52, UNEXPLAINED: 0.48 },
    };

    const diff = evaluateDifficulty(ic, mlAnalysis);
    expect(diff.shouldEscalate).toBe(true);
    expect(diff.reasons.length).toBeGreaterThan(0);
  });

  test('3. Complex UNEXPLAINED or broken relationship case triggers escalation', () => {
    const unexpExc = exceptions.find(e => e.category === 'UNEXPLAINED') || exceptions[0];
    const rr = results.find(r => r.id === unexpExc.reconciliation_result_id);
    const ic = buildCase({ exception: unexpExc, reconResult: rr, store: s });

    const diff = evaluateDifficulty(ic, { confidence: 0.60, all_probabilities: { UNEXPLAINED: 0.60, FEE_TAX_VARIANCE: 0.40 } });
    expect(diff.shouldEscalate).toBe(true);
    expect(diff.difficultyScore).toBeGreaterThanOrEqual(50);
  });

  test('4. QwenLocalModel reports unavailable when Ollama is offline without throwing', async () => {
    const qwen = new QwenLocalModel({ baseUrl: 'http://127.0.0.1:59999' }); // unreachable port
    const isAvail = await qwen.isAvailable();
    expect(isAvail).toBe(false);

    const exc = exceptions[0];
    const rr  = results.find(r => r.id === exc.reconciliation_result_id);
    const ic  = buildCase({ exception: exc, reconResult: rr, store: s });

    const res = await qwen.investigate(ic);
    expect(res.success).toBe(false);
    expect(res.reason).toBe('OLLAMA_UNAVAILABLE');
  });

  test('5. ModelRouter falls back safely when Qwen is unavailable', async () => {
    const mockOfflineQwen = new QwenLocalModel({ baseUrl: 'http://127.0.0.1:59999' });
    const router = new ModelRouter({ qwenModel: mockOfflineQwen });

    const exc = exceptions[0];
    const rr  = results.find(r => r.id === exc.reconciliation_result_id);
    const ic  = buildCase({ exception: exc, reconResult: rr, store: s });

    const routed = await router.route(ic);
    expect(['LOCAL_MODEL_SUFFICIENT', 'QWEN_FAILED']).toContain(routed.internal_state);
    expect(routed.ml_result).toBeDefined();
  });

  test('6. ModelRouter successfully incorporates mock Qwen response when escalated', async () => {
    const mockQwen = {
      isAvailable: async () => true,
      investigate: async () => ({
        success: true,
        model: 'qwen2.5:7b',
        analysis: {
          summary: 'Qwen verified settlement variance.',
          what_happened: 'Gateway fee deducted exceeded standard 2% rate.',
          why_it_matters: 'Reduces merchant payout.',
          recommended_action: 'Verify contracted rate.',
          assessment: 'NEEDS_REVIEW',
          supporting_evidence: ['Fee variance of 50 paise detected'],
        },
      }),
    };

    const mockPrimaryML = {
      predict: async () => ({
        predicted_category: 'FEE_TAX_VARIANCE',
        confidence: 0.45, // low confidence to force escalation
        all_probabilities: { FEE_TAX_VARIANCE: 0.45, UNEXPLAINED: 0.45 },
        top_features: [],
      }),
    };

    const router = new ModelRouter({ primaryModel: mockPrimaryML, qwenModel: mockQwen, qwenEnabled: true });
    const exc = exceptions[0];
    const rr  = results.find(r => r.id === exc.reconciliation_result_id);
    const ic  = buildCase({ exception: exc, reconResult: rr, store: s });

    const routed = await router.route(ic);
    expect(routed.internal_state).toBe('FINAL_ANALYSIS_READY');
    expect(routed.qwen_result.success).toBe(true);
    expect(routed.qwen_result.analysis.what_happened).toBeTruthy();
  });

  test('7. End-to-end investigation produces unified schema regardless of model invoked', async () => {
    const exc = exceptions[0];
    const rr  = results.find(r => r.id === exc.reconciliation_result_id);
    const ic  = buildCase({ exception: exc, reconResult: rr, store: s });

    const report = await investigate(ic);

    // Verify Unified Contract Fields
    expect(typeof report.summary).toBe('string');
    expect(typeof report.what_happened).toBe('string');
    expect(typeof report.why_it_matters).toBe('string');
    expect(typeof report.recommended_action).toBe('string');
    expect(['MATCHED', 'NEEDS_REVIEW', 'HIGH_RISK']).toContain(report.assessment);
    expect(Array.isArray(report.supporting_evidence)).toBe(true);
    expect(report.supporting_evidence.length).toBeGreaterThan(0);

    // Verify user-facing fields contain NO raw model names
    const textCorpus = `${report.what_happened} ${report.why_it_matters} ${report.recommended_action}`;
    expect(textCorpus).not.toMatch(/Random Forest/i);
    expect(textCorpus).not.toMatch(/Qwen/i);
    expect(textCorpus).not.toMatch(/Ollama/i);
    expect(textCorpus).not.toMatch(/scikit-learn/i);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 13. End-to-End Engine Investigation
// ─────────────────────────────────────────────────────────────────────────────

describe('Payvault AI Engine End-to-End', () => {
  test('investigates all 24 exceptions producing strict schema with ml_analysis', async () => {
    for (const exc of exceptions) {
      const rr = results.find(r => r.id === exc.reconciliation_result_id);
      const ic = buildCase({ exception: exc, reconResult: rr, store: s });

      const report = await investigate(ic);

      // Verify strict schema
      expect(report.case_id).toBe(exc.id);
      expect(report.exception_category).toBe(exc.category);
      expect(typeof report.executive_summary).toBe('string');
      expect(report.root_cause).toBeDefined();
      expect(report.root_cause.conclusion).toBeTruthy();
      expect(report.root_cause.confidence).toBeDefined();
      expect(Array.isArray(report.contributing_factors)).toBe(true);
      expect(report.financial_impact).toBeDefined();
      expect(Array.isArray(report.timeline_findings)).toBe(true);
      expect(Array.isArray(report.relationship_findings)).toBe(true);
      expect(Array.isArray(report.evidence)).toBe(true);
      expect(report.risk_assessment).toBeDefined();
      expect(Array.isArray(report.recommended_actions)).toBe(true);
      expect(Array.isArray(report.explanation)).toBe(true);
      expect(Array.isArray(report.uncertainty)).toBe(true);

      // Verify ML Analysis
      expect(report.ml_analysis).toBeDefined();
      expect(report.ml_analysis.model).toBe('Payvault Local ML');
      expect(report.ml_analysis.model_type).toBe('LOCAL TRAINED MODEL');
      expect(typeof report.ml_analysis.confidence).toBe('number');

      // Verify AI metadata
      expect(report.ai_metadata.engine).toBe('payvault_ai');
      expect(report.ai_metadata.mode).toBe('LOCAL');

      // Verify explanation statements have FACT / INFERENCE / RECOMMENDATION
      const types = new Set(report.explanation.map(e => e.type));
      expect(types.has('FACT') || types.has('INFERENCE')).toBe(true);
    }
  }, 90000);
});

// ─────────────────────────────────────────────────────────────────────────────
// 13. Investigation Routes (HTTP integration via supertest)
// ─────────────────────────────────────────────────────────────────────────────

const request = require('supertest');
const express = require('express');

function buildTestApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/investigations', require('../src/routes/investigations'));
  return app;
}

describe('GET /api/investigations', () => {
  let app;
  beforeAll(() => { store.reset(); app = buildTestApp(); });

  test('returns 200 with count and cases array', async () => {
    const res = await request(app).get('/api/investigations').expect(200);
    expect(res.body.count).toBeGreaterThan(0);
    expect(Array.isArray(res.body.cases)).toBe(true);
  });

  test('filters by category', async () => {
    const res = await request(app).get('/api/investigations?category=TIMING_MISMATCH').expect(200);
    for (const c of res.body.cases) {
      expect(c.exception_category).toBe('TIMING_MISMATCH');
    }
  });

  test('each case has required lightweight fields', async () => {
    const res = await request(app).get('/api/investigations').expect(200);
    for (const c of res.body.cases) {
      expect(c).toHaveProperty('case_id');
      expect(c).toHaveProperty('exception_category');
      expect(c).toHaveProperty('amount_at_risk');
    }
  });
});

describe('GET /api/investigations/:id', () => {
  let app;
  beforeAll(() => { store.reset(); app = buildTestApp(); });

  test('returns 200 with full InvestigationCase', async () => {
    const id  = store.getExceptions()[0].id;
    const res = await request(app).get(`/api/investigations/${id}`).expect(200);

    expect(res.body.case_id).toBe(id);
    expect(Array.isArray(res.body.timeline)).toBe(true);
    expect(Array.isArray(res.body.relationships)).toBe(true);
    expect(Array.isArray(res.body.suggested_actions)).toBe(true);
    expect(res.body.financial_analysis).toBeDefined();
  });

  test('returns 404 for unknown id', async () => {
    await request(app).get('/api/investigations/exc_nonexistent').expect(404);
  });
});

describe('POST /api/investigations/:id/run', () => {
  let app;
  beforeAll(() => { store.reset(); app = buildTestApp(); });

  test('returns 200 with payvault_ai investigation in response', async () => {
    const id  = store.getExceptions()[0].id;
    const res = await request(app).post(`/api/investigations/${id}/run`).expect(200);

    expect(res.body.case_id).toBe(id);
    expect(res.body.ai_investigation).toBeDefined();
    expect(res.body.ai_investigation.ai_metadata.engine).toBe('payvault_ai');
    expect(res.body.ai_investigation.ai_metadata.mode).toBe('LOCAL');
    expect(res.body.ai_investigation.root_cause).toBeDefined();
    expect(res.body.ai_investigation.ml_analysis).toBeDefined();
    expect(res.body.ai_investigation.ml_analysis.model).toBe('Payvault Local ML');
    expect(typeof res.body.ai_investigation.executive_summary).toBe('string');
    expect(Array.isArray(res.body.ai_investigation.explanation)).toBe(true);
  });

  test('returns 404 for unknown id', async () => {
    await request(app).post('/api/investigations/exc_nonexistent/run').expect(404);
  });

  test('preserves deterministic fields alongside AI analysis', async () => {
    const id  = store.getExceptions()[0].id;
    const res = await request(app).post(`/api/investigations/${id}/run`).expect(200);

    expect(Array.isArray(res.body.timeline)).toBe(true);
    expect(Array.isArray(res.body.suggested_actions)).toBe(true);
    expect(res.body.financial_analysis).toBeDefined();
  });
});
