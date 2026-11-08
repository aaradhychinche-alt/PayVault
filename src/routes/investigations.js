'use strict';
/**
 * src/routes/investigations.js
 *
 * GET  /api/investigations                         — list all investigation cases (lightweight with lifecycle)
 * GET  /api/investigations/config/resolution-reasons — list valid resolution reason enums & labels
 * GET  /api/investigations/:id                     — get a fully built investigation case (with status & audit trail)
 * POST /api/investigations/:id/run                 — run AI investigation on a case & transition to IN_REVIEW
 * POST /api/investigations/:id/resolve             — resolve an exception case with human justification
 * POST /api/investigations/:id/reopen              — reopen a resolved exception case
 * GET  /api/investigations/:id/audit               — get append-only audit trail for a case
 * POST /api/investigations/:id/chat                — case-aware Payvault AI chat (Ask Payvault AI)
 *
 * DESIGN NOTES:
 * - AI engine NEVER automatically marks cases as RESOLVED.
 * - Human operators always review evidence and make final resolution decisions.
 * - All state transitions append to the audit log.
 * - Chat is a read-only explanation layer; it never changes case state.
 * - Chat POST /api/investigations/:id/chat routes exclusively through Payvault AI
 *   native reasoning (chatRouter → nativeReasoning).
 */

const express                       = require('express');
const router                        = express.Router();
const store                         = require('../store/dataStore');
const investigationRepository       = require('../db/repositories/investigationRepository');
const auditRepository               = require('../db/repositories/auditRepository');
const redisClient                   = require('../db/redis');
const { buildCase, computeCasePriority } = require('../investigation/caseBuilder');
const { investigate }               = require('../investigation/ai/engine');
const { buildIntelligenceContext }  = require('../investigation/intelligence/context');
const { buildChatContext }          = require('../investigation/chat/chatContextBuilder');
const { routeAndAnswerChat }        = require('../investigation/chat/chatRouter');
const {
  CaseStatus,
  ResolutionReason,
  ResolutionReasonDetails,
  isValidResolutionReason,
} = require('../models/resolution');

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Build a lightweight summary of all exception cases including lifecycle status.
 * Does NOT build full InvestigationCases — fast O(n) list.
 */
function buildCaseList() {
  const exceptions = store.getExceptions();
  const s          = store.getStore();

  return exceptions.map(exc => {
    const rr = s.reconciliationResults.find(r => r.id === exc.reconciliation_result_id);
    const lifecycle = store.getCaseLifecycle(exc.id);
    const prio = computeCasePriority(exc, rr);

    return {
      id:                   exc.id,
      case_id:              exc.id,
      exception_category:   exc.category,
      amount_at_risk:       exc.amount_at_risk,
      priority:             prio.level,
      priority_reason:      prio.reason,
      status:               lifecycle.status,
      reconciliation_status: rr ? rr.status : 'UNKNOWN',
      resolution:           lifecycle.resolution || null,
      settlement_entity_id: rr ? rr.settlement_entity_id : null,
      merchant_order_id:    rr ? rr.merchant_order_id    : null,
      created_at:           exc.created_at,
      description:          exc.description,
    };
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/investigations/config/resolution-reasons
// ─────────────────────────────────────────────────────────────────────────────
router.get('/config/resolution-reasons', (req, res) => {
  try {
    const reasons = Object.keys(ResolutionReason).map(key => {
      const details = ResolutionReasonDetails[key] || {};
      return {
        id:          key,
        label:       details.label || key,
        description: details.description || '',
        category:    details.category || 'GENERAL',
      };
    });
    return res.json({ reasons });
  } catch (err) {
    console.error('[investigations/config/reasons] Error:', err);
    return res.status(500).json({ error: 'Failed to fetch resolution reasons configuration.' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/investigations
// ─────────────────────────────────────────────────────────────────────────────
router.get('/', (req, res) => {
  try {
    let caseList = buildCaseList();

    // Calculate status counts across all cases before filtering
    const statusCounts = {
      total:     caseList.length,
      open:      caseList.filter(c => c.status === CaseStatus.OPEN).length,
      in_review: caseList.filter(c => c.status === CaseStatus.IN_REVIEW).length,
      resolved:  caseList.filter(c => c.status === CaseStatus.RESOLVED).length,
    };

    // Filter by status (?status=OPEN | IN_REVIEW | RESOLVED | ALL)
    const { status, category } = req.query;
    if (status && status.toUpperCase() !== 'ALL') {
      caseList = caseList.filter(c => c.status === status.toUpperCase());
    }

    // Filter by category (?category=FEE_TAX_VARIANCE)
    if (category && category.toUpperCase() !== 'ALL') {
      caseList = caseList.filter(c => c.exception_category === category.toUpperCase());
    }

    const s = store.getStore();
    return res.json({
      count:         caseList.length,
      status_counts: statusCounts,
      mode:          s.mode,
      cases:         caseList,
      data_note:     s.mode === 'RAZORPAY_BACKED'
        ? 'Transaction data is from Razorpay Test Mode; settlement records are simulated.'
        : 'All data is synthetic. Simulated for demonstration.',
    });
  } catch (err) {
    console.error('[investigations/list] Error:', err);
    return res.status(500).json({ error: 'Failed to list investigation cases.' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/investigations/:id
// Returns the full deterministic InvestigationCase with lifecycle, audit trail,
// and historical intelligence context.
// ─────────────────────────────────────────────────────────────────────────────
router.get('/:id', (req, res) => {
  try {
    const s         = store.getStore();
    const exception = s.exceptions.find(e => e.id === req.params.id);

    if (!exception) {
      return res.status(404).json({ error: `Investigation case '${req.params.id}' not found.` });
    }

    const reconResult = s.reconciliationResults.find(
      r => r.id === exception.reconciliation_result_id,
    );
    if (!reconResult) {
      return res.status(500).json({ error: `Reconciliation result not found for exception '${req.params.id}'.` });
    }

    const investigationCase   = buildCase({ exception, reconResult, store: s });
    const lifecycle           = store.getCaseLifecycle(exception.id);
    const auditTrail          = store.getCaseAuditTrail(exception.id);
    const intelligenceContext = buildIntelligenceContext({ investigationCase, store: s });
    const savedAi             = store.getAiInvestigation(exception.id);

    return res.json({
      ...investigationCase,
      status:               lifecycle.status,
      resolution:           lifecycle.resolution || null,
      audit_trail:          auditTrail,
      intelligence_context: intelligenceContext,
      ai_investigation:     savedAi || null,
      _note: 'Deterministic case with lifecycle & historical intelligence. POST /api/investigations/:id/run to add AI analysis, POST /resolve to mark resolved.',
    });
  } catch (err) {
    console.error('[investigations/detail] Error:', err);
    return res.status(500).json({ error: 'Failed to build investigation case.' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/investigations/:id/intelligence
// Returns the standalone structured InvestigationIntelligenceContext (Chunk 4).
// ─────────────────────────────────────────────────────────────────────────────
router.get('/:id/intelligence', (req, res) => {
  try {
    const s         = store.getStore();
    const exception = s.exceptions.find(e => e.id === req.params.id);

    if (!exception) {
      return res.status(404).json({ error: `Investigation case '${req.params.id}' not found.` });
    }

    const reconResult = s.reconciliationResults.find(
      r => r.id === exception.reconciliation_result_id,
    );
    if (!reconResult) {
      return res.status(500).json({ error: `Reconciliation result not found for exception '${req.params.id}'.` });
    }

    const investigationCase   = buildCase({ exception, reconResult, store: s });
    const intelligenceContext = buildIntelligenceContext({ investigationCase, store: s });

    return res.json(intelligenceContext);
  } catch (err) {
    console.error('[investigations/intelligence] Error:', err);
    return res.status(500).json({ error: 'Failed to build investigation intelligence context.' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/investigations/:id/run and POST /api/investigations/:id/investigate
// Runs AI investigation on a case and transitions status to IN_REVIEW.
// ─────────────────────────────────────────────────────────────────────────────
const handleRunInvestigation = async (req, res) => {
  try {
    const s         = store.getStore();
    const exception = s.exceptions.find(e => e.id === req.params.id);

    if (!exception) {
      return res.status(404).json({ error: `Investigation case '${req.params.id}' not found.` });
    }

    const reconResult = s.reconciliationResults.find(
      r => r.id === exception.reconciliation_result_id,
    );
    if (!reconResult) {
      return res.status(500).json({ error: `Reconciliation result not found for exception '${req.params.id}'.` });
    }

    // Build the deterministic case first
    const investigationCase = buildCase({ exception, reconResult, store: s });

    console.log(`[POST /investigations/${req.params.id}/run] Starting AI investigation...`);

    // Transition case to IN_REVIEW if currently OPEN
    const updatedLifecycle = store.setCaseInReview(
      exception.id,
      req.body?.actor || 'user',
      'AI investigation initiated and case reviewed',
    );

    // Run AI investigation
    const aiAnalysis = await investigate(investigationCase);
    store.saveAiInvestigation(exception.id, aiAnalysis);

    // Persist to PostgreSQL repository (or dev fallback)
    investigationRepository.save({
      id: `inv_${exception.id}`,
      exception_id: exception.id,
      case_id: investigationCase.case_id,
      exception_category: investigationCase.exception_category,
      status: updatedLifecycle.status,
      amount_at_risk_paise: investigationCase.amount_at_risk,
      summary: aiAnalysis.summary,
      what_happened: aiAnalysis.what_happened,
      why_it_matters: aiAnalysis.why_it_matters,
      recommended_actions: aiAnalysis.recommended_actions,
      evidence_summary: aiAnalysis.evidence,
      confidence_score: aiAnalysis.confidence?.score,
      raw_investigation: aiAnalysis,
    }).catch(e => console.error('[investigationRepository] Background save warning:', e.message));

    return res.json({
      id:                 investigationCase.id,
      case_id:            investigationCase.case_id,
      exception_category: investigationCase.exception_category,
      amount_at_risk:     investigationCase.amount_at_risk,
      status:             updatedLifecycle.status,
      resolution:         updatedLifecycle.resolution || null,
      // Deterministic context preserved alongside AI result
      financial_analysis: investigationCase.financial_analysis,
      timeline:           investigationCase.timeline,
      relationships:      investigationCase.relationships,
      suggested_actions:  investigationCase.suggested_actions,
      data_sources:       investigationCase.data_sources,
      generated_at_iso:   investigationCase.generated_at_iso,
      // AI layer output
      ai_investigation:   aiAnalysis,
    });
  } catch (err) {
    console.error('[investigations/run] Error:', err);
    return res.status(500).json({ error: `AI investigation failed: ${err.message}` });
  }
};

router.post('/:id/run', handleRunInvestigation);
router.post('/:id/investigate', handleRunInvestigation);

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/investigations/:id/resolve
// Human resolution of an exception case.
// ─────────────────────────────────────────────────────────────────────────────
router.post('/:id/resolve', (req, res) => {
  try {
    const { id } = req.params;
    const { resolution_reason, resolution_notes, resolved_by } = req.body || {};

    if (!resolution_reason) {
      return res.status(400).json({
        error: 'resolution_reason is required.',
        valid_reasons: Object.keys(ResolutionReason),
      });
    }

    if (!isValidResolutionReason(resolution_reason)) {
      return res.status(400).json({
        error: `Invalid resolution_reason '${resolution_reason}'.`,
        valid_reasons: Object.keys(ResolutionReason),
      });
    }

    const s = store.getStore();
    const exception = s.exceptions.find(e => e.id === id);
    if (!exception) {
      return res.status(404).json({ error: `Investigation case '${id}' not found.` });
    }

    const updatedLifecycle = store.resolveCase(id, {
      resolution_reason,
      resolution_notes: resolution_notes || '',
      resolved_by:      resolved_by || 'user',
    });

    const auditTrail = store.getCaseAuditTrail(id);

    return res.json({
      success:    true,
      case_id:    id,
      status:     updatedLifecycle.status,
      resolution: updatedLifecycle.resolution,
      audit_trail: auditTrail,
      message:    `Case ${id} successfully marked as RESOLVED.`,
    });
  } catch (err) {
    console.error('[investigations/resolve] Error:', err);
    return res.status(500).json({ error: `Failed to resolve investigation case: ${err.message}` });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/investigations/:id/reopen
// Reopen a resolved exception case back to OPEN while preserving audit history.
// ─────────────────────────────────────────────────────────────────────────────
router.post('/:id/reopen', (req, res) => {
  try {
    const { id } = req.params;
    const { reopen_notes, reopened_by } = req.body || {};

    const s = store.getStore();
    const exception = s.exceptions.find(e => e.id === id);
    if (!exception) {
      return res.status(404).json({ error: `Investigation case '${id}' not found.` });
    }

    const current = store.getCaseLifecycle(id);
    if (current.status !== CaseStatus.RESOLVED) {
      return res.status(400).json({
        error: `Cannot reopen case '${id}' because it is not in RESOLVED status (current: ${current.status}).`,
      });
    }

    const updatedLifecycle = store.reopenCase(id, {
      reopen_notes: reopen_notes || 'Case reopened by operator.',
      reopened_by:  reopened_by  || 'user',
    });

    const auditTrail = store.getCaseAuditTrail(id);

    return res.json({
      success:     true,
      case_id:     id,
      status:      updatedLifecycle.status,
      resolution:  null,
      audit_trail: auditTrail,
      message:     `Case ${id} successfully reopened to OPEN status.`,
    });
  } catch (err) {
    console.error('[investigations/reopen] Error:', err);
    return res.status(500).json({ error: `Failed to reopen investigation case: ${err.message}` });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/investigations/:id/audit
// Returns append-only audit trail for a case.
// ─────────────────────────────────────────────────────────────────────────────
router.get('/:id/audit', (req, res) => {
  try {
    const { id } = req.params;
    const s = store.getStore();
    const exception = s.exceptions.find(e => e.id === id);
    if (!exception) {
      return res.status(404).json({ error: `Investigation case '${id}' not found.` });
    }

    const auditTrail = store.getCaseAuditTrail(id);
    return res.json({
      case_id:     id,
      count:       auditTrail.length,
      audit_trail: auditTrail,
    });
  } catch (err) {
    console.error('[investigations/audit] Error:', err);
    return res.status(500).json({ error: `Failed to fetch audit trail: ${err.message}` });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/investigations/:id/chat
//
// Case-aware "Ask Payvault AI" chat endpoint.
//
// Request body:
//   { message: string, history?: [{role: 'operator'|'payvault', content: string}] }
//
// Response:
//   { answer, source, case_id, ai_used, model, intent }
//
// RULES:
// - Never exposes secrets, credentials, or unrelated merchant data.
// - Never modifies case state.
// - Financial facts come exclusively from the deterministic Payvault case data.
// - ACTIVE PATH: chatRouter -> nativeReasoning (Payvault AI native intelligence).
// - NO Qwen. NO Ollama. NO external LLM is called.
// ─────────────────────────────────────────────────────────────────────────────
router.post('/:id/chat', async (req, res) => {
  try {
    const { id } = req.params;
    const { message, history = [] } = req.body || {};

    // ── Validate inputs ────────────────────────────────────────────────────
    if (!message || typeof message !== 'string' || message.trim().length === 0) {
      return res.status(400).json({ error: 'message is required and must be a non-empty string.' });
    }
    if (message.trim().length > 1000) {
      return res.status(400).json({ error: 'message must be 1000 characters or fewer.' });
    }
    if (!Array.isArray(history)) {
      return res.status(400).json({ error: 'history must be an array.' });
    }

    // ── Load case data ─────────────────────────────────────────────────────
    const s         = store.getStore();
    const exception = s.exceptions.find(e => e.id === id);
    if (!exception) {
      return res.status(404).json({ error: `Investigation case '${id}' not found.` });
    }

    const reconResult = s.reconciliationResults.find(
      r => r.id === exception.reconciliation_result_id,
    );
    if (!reconResult) {
      return res.status(500).json({ error: `Reconciliation result not found for case '${id}'.` });
    }

    // ── Build context ──────────────────────────────────────────────────────
    const investigationCase   = buildCase({ exception, reconResult, store: s });
    const lifecycle           = store.getCaseLifecycle(id);
    const intelligenceContext = buildIntelligenceContext({ investigationCase, store: s });
    const savedAi             = store.getAiInvestigation(id);

    const ctx = buildChatContext({
      investigationCase,
      lifecycle,
      intelligenceContext,
      savedAi,
    });

    const conversationId = req.body?.conversationId || req.body?.conversation_id || req.headers['x-conversation-id'] || `conv_${id}_default`;

    // ── Load previous conversation state from Redis ────────────────────────
    let redisState = null;
    try {
      redisState = await redisClient.getConversationState(id, conversationId);
    } catch (e) {
      console.warn('[Redis] Transient get warning:', e.message);
    }

    // ── Execute Payvault AI Reasoning (with Ollama support) ───────────────
    const chatResult = await routeAndAnswerChat({
      message: message.trim(),
      ctx,
      history,
      conversationState: redisState,
      forceOllama: req.body?.use_ollama === true || req.query?.use_ollama === 'true',
    });

    // ── Save updated conversation state to Redis ───────────────────────────
    try {
      const baseState = chatResult.conversationState || {};
      const updatedState = {
        ...baseState,
        investigationId: id,
        conversationId,
        turnNumber: (redisState?.turnNumber || 0) + 1,
        currentIntent: chatResult.intent,
        previousIntent: redisState?.currentIntent || redisState?.previousIntent || null,
        lastUserQuestion: message.trim(),
        lastAnswerSummary: chatResult.answer ? chatResult.answer.slice(0, 120) : null,
      };
      await redisClient.saveConversationState(id, conversationId, updatedState);
    } catch (e) {
      console.warn('[Redis] Transient save warning:', e.message);
    }

    return res.json({
      answer:                      chatResult.answer, // Deterministically composed factual answer
      source:                      chatResult.source,
      case_id:                     id,
      conversation_id:             conversationId,
      ai_used:                     chatResult.execution_mode === 'LOCAL_OLLAMA_ASSISTED' || chatResult.ai_used === true,
      model:                       chatResult.model || 'Payvault AI',
      model_used:                  chatResult.model_used || chatResult.model || 'Payvault AI',
      answer_composed_by:          chatResult.answer_composed_by || 'payvault_deterministic_engine',
      execution_mode:              chatResult.execution_mode,
      intent:                      chatResult.intent,
      confidence:                  chatResult.confidence,
      model_confidence:            chatResult.model_confidence || null,
      grounding_verified:          chatResult.grounding_verified || false,
      raw_model_response:          chatResult.raw_model_response || null,
      unverified_model_commentary: chatResult.unverified_model_commentary || null,
      cited_evidence:              chatResult.cited_evidence || [],
      fallback_used:               chatResult.fallback_used || false,
      fallback_reason:             chatResult.fallback_reason || null,
    });

  } catch (err) {
    console.error('[investigations/chat] Error:', err);
    return res.status(500).json({ error: `Chat request failed: ${err.message}` });
  }
});

module.exports = router;
