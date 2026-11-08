'use strict';
/**
 * src/routes/demo.js
 *
 * Demo endpoints:
 *   POST /api/demo/reset          — Regenerates the deterministic synthetic dataset (Mode A).
 *   POST /api/demo/sync-razorpay  — Fetches real Razorpay Test Mode data & runs settlement simulator (Mode B).
 */

const express = require('express');
const router  = express.Router();
const store   = require('../store/dataStore');

// POST /api/demo/reset (Mode A: Full Synthetic)
router.post('/reset', (req, res) => {
  try {
    store.reset();
    const summary = store.getSummary();
    return res.json({
      success: true,
      mode: 'SYNTHETIC',
      message: 'Demo dataset reset to deterministic synthetic baseline. Results are identical on every run.',
      summary,
    });
  } catch (err) {
    console.error('[demo/reset] Error:', err);
    return res.status(500).json({ error: 'Failed to reset demo dataset.' });
  }
});

// POST /api/demo/reset-synthetic (Explicit Synthetic Benchmark)
router.post('/reset-synthetic', (req, res) => {
  try {
    store.reset();
    const summary = store.getSummary();
    return res.json({
      success: true,
      mode: 'SYNTHETIC',
      message: '79-record deterministic benchmark dataset loaded successfully.',
      ...summary,
      summary,
    });
  } catch (err) {
    console.error('[demo/reset-synthetic] Error:', err);
    return res.status(500).json({ error: 'Failed to load synthetic benchmark.' });
  }
});

// POST /api/demo/clear (Reset to empty LIVE session)
router.post('/clear', (req, res) => {
  try {
    store.clear();
    const summary = store.getSummary();
    return res.json({
      success: true,
      mode: 'LIVE',
      message: 'Application store cleared to empty state.',
      ...summary,
      summary,
    });
  } catch (err) {
    console.error('[demo/clear] Error:', err);
    return res.status(500).json({ error: 'Failed to clear store.' });
  }
});

module.exports = router;
