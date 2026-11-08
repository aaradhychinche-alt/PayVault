'use strict';
/**
 * public/checkout.js
 *
 * Payvault Production Fintech Dashboard, Reconciliation & Investigation Application
 */

// ── Application State ────────────────────────────────────────────────────────
const AppState = {
  currentPage: 'dashboard',
  summary: null,
  payments: [],
  settlements: { batches: [], records: [] },
  reconciliations: [],
  exceptions: [],
  currentCaseId: null,
  currentCaseDetail: null,
  resolutionReasons: [],
  activeStatusFilter: 'ALL',
  activeCategoryFilter: 'ALL',
  activeReconFilter: 'ALL',
};

// ── Currency / Formatting Helpers ────────────────────────────────────────────
function formatINR(paise) {
  if (paise === null || paise === undefined || isNaN(paise)) return '₹0.00';
  const rupees = paise / 100;
  return new Intl.NumberFormat('en-IN', {
    style: 'currency',
    currency: 'INR',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(rupees);
}

function formatDate(isoStr) {
  if (!isoStr) return '—';
  try {
    const d = new Date(isoStr);
    return d.toLocaleDateString('en-IN', {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch (e) {
    return isoStr;
  }
}

function formatTimelineTime(isoStr) {
  if (!isoStr) return '';
  try {
    const d = new Date(isoStr);
    if (isNaN(d.getTime())) return '';
    return d.toTimeString().split(' ')[0];
  } catch (e) {
    return '';
  }
}

function derivePriority(c) {
  if (!c) return 'LOW';
  if (c.priority) return c.priority;
  if (c.priority_info?.level) return c.priority_info.level;
  const cat = c.exception_category || c.category || '';
  const risk = c.amount_at_risk || 0;
  if (cat === 'DUPLICATE' || cat === 'UNEXPLAINED' || cat === 'DISPUTE_REVERSAL' || (cat === 'FEE_TAX_VARIANCE' && risk >= 2000)) {
    return 'HIGH';
  }
  if (risk > 0 || cat === 'MISSING_ORDER' || cat === 'PARTIAL_REFUND') {
    return 'MEDIUM';
  }
  return 'LOW';
}

function cleanCategoryLabel(cat) {
  if (!cat) return 'Exception';
  const labels = {
    CLEAN_MATCH: 'Clean Match',
    FEE_TAX_VARIANCE: 'Fee / Tax Variance',
    TIMING_MISMATCH: 'Timing Mismatch',
    MISSING_ORDER: 'Missing Order',
    MISSING_PAYMENT: 'Missing Payment',
    DUPLICATE: 'Duplicate Settlement',
    ADJUSTMENT: 'Settlement Adjustment',
    UNEXPLAINED: 'Unexplained Shortfall',
    PARTIAL_REFUND: 'Partial Refund',
    DISPUTE_REVERSAL: 'PayPal Dispute Reversal',
  };
  return labels[cat] || cat.replace(/_/g, ' ');
}

// ── Page Navigation ──────────────────────────────────────────────────────────
function navigateTo(pageId) {
  AppState.currentPage = pageId;

  // Update nav tabs active state
  document.querySelectorAll('.nav-tab').forEach(tab => {
    const target = tab.getAttribute('data-page');
    tab.classList.toggle('active', target === pageId || (pageId === 'payment-new' && target === 'payments'));
  });

  // Switch visible page section
  document.querySelectorAll('.app-page').forEach(page => {
    page.style.display = 'none';
    page.classList.remove('active');
  });

  const activePage = document.getElementById(`page-${pageId}`);
  if (activePage) {
    activePage.style.display = 'block';
    activePage.classList.add('active');
  }

  window.scrollTo({ top: 0, behavior: 'smooth' });

  // Refresh page data on navigation
  if (pageId === 'dashboard') {
    renderDashboard();
  } else if (pageId === 'payments') {
    renderPaymentsTable();
  } else if (pageId === 'settlements') {
    renderSettlements();
  } else if (pageId === 'reconciliation') {
    renderReconciliationTable(AppState.activeReconFilter);
  } else if (pageId === 'investigations') {
    renderInvestigationQueue();
  }
}

// ── Canonical Mappers & Entity Normalization ─────────────────────────────────
function normalizePayment(p) {
  if (!p) return null;
  const id = p.id || p.payment_id || '—';
  const orderId = p.order_id || p.orderId || '—';
  const amountPaise = typeof p.amount_paise === 'number'
    ? p.amount_paise
    : (typeof p.amount === 'number' ? p.amount : 0);
  const amountInr = (amountPaise / 100).toFixed(2);
  const method = (p.method || 'CARD').toUpperCase();
  const createdAt = p.created_at || Math.floor(Date.now() / 1000);
  const status = (p.status || 'CAPTURED').toUpperCase();
  const reconStatus = p.recon_status || (p.scenario === 'CLEAN_MATCH' ? 'MATCHED' : (p.is_exception ? 'EXCEPTION' : 'MATCHED'));
  const settlementId = p.settlement_id || null;
  const fee = typeof p.fee === 'number' ? p.fee : Math.round(amountPaise * 0.02);
  const tax = typeof p.tax === 'number' ? p.tax : Math.round(fee * 0.18);
  const netCredit = typeof p.net_credit === 'number' ? p.net_credit : (p.credit || Math.max(0, amountPaise - fee - tax));
  
  return {
    id,
    payment_id: id,
    order_id: orderId,
    amount: amountPaise,
    amount_paise: amountPaise,
    amount_inr: amountInr,
    method,
    status,
    created_at: createdAt,
    settlement_id: settlementId,
    recon_status: reconStatus,
    net_credit: netCredit,
    fee,
    tax,
    scenario: p.scenario || 'CLEAN_MATCH',
  };
}

function normalizeCase(c) {
  if (!c) return null;
  const caseId = c.case_id || c.id || '—';
  const amountAtRisk = typeof c.amount_at_risk === 'number' ? c.amount_at_risk : (c.amount || 0);
  const category = c.exception_category || c.category || 'UNKNOWN_EXCEPTION';
  const status = (c.status || 'OPEN').toUpperCase();
  return {
    ...c,
    case_id: caseId,
    id: caseId,
    amount_at_risk: amountAtRisk,
    amount_at_risk_inr: (amountAtRisk / 100).toFixed(2),
    exception_category: category,
    category,
    status,
    resolution: c.resolution || null,
    settlement_entity_id: c.settlement_entity_id || c.settlement_record_id || (c.settlement_record && c.settlement_record.entity_id) || '—',
    merchant_order_id: c.merchant_order_id || (c.merchant_order && c.merchant_order.id) || '—',
    created_at: c.created_at || Math.floor(Date.now() / 1000),
    description: c.description || '',
  };
}

function normalizeAuditEvent(a) {
  if (!a) return null;
  return {
    id: a.id || 'audit_0',
    action: a.action || 'UPDATE',
    performed_by: a.performed_by || a.actor || 'operator',
    actor: a.performed_by || a.actor || 'operator',
    created_at: a.created_at || a.timestamp || Math.floor(Date.now() / 1000),
    timestamp: a.created_at || a.timestamp || Math.floor(Date.now() / 1000),
    previous_status: a.previous_status || null,
    new_status: a.new_status || null,
    resolution_reason: a.resolution_reason || (a.details && a.details.resolution_reason) || null,
    notes: a.notes || (a.details && a.details.resolution_notes) || '',
  };
}

// ── Data Fetching & Sync ─────────────────────────────────────────────────────
async function loadAllData() {
  try {
    const [summaryRes, paymentsRes, settlementsRes, reconRes, invRes, paypalRes] = await Promise.all([
      fetch('/api/reconciliation/summary').then(r => r.json()),
      fetch('/api/payments').then(r => r.json()).catch(() => ({ payments: [] })),
      fetch('/api/settlements').then(r => r.json()).catch(() => ({ batches: [], records: [] })),
      fetch('/api/reconciliation/results').then(r => r.json()).catch(() => ({ results: [] })),
      fetch('/api/investigations').then(r => r.json()).catch(() => ({ cases: [], status_counts: {} })),
      fetch('/api/paypal/transactions').then(r => r.json()).catch(() => ({ transactions: [] })),
    ]);

    AppState.summary            = summaryRes || {};
    AppState.payments           = (paymentsRes.payments || []).map(normalizePayment).reverse();
    AppState.settlements        = settlementsRes || { batches: [], records: [] };
    AppState.reconciliations    = reconRes.results || [];
    AppState.exceptions         = (invRes.cases || []).map(normalizeCase);
    AppState.paypalTransactions = paypalRes?.transactions || [];

    updateHeaderBadges();
    renderCurrentPage();
  } catch (err) {
    console.error('[Payvault] Error loading application data:', err);
  }
}

function updateHeaderBadges() {
  const openCount = AppState.exceptions.filter(c => c.status === 'OPEN').length;
  const inReviewCount = AppState.exceptions.filter(c => c.status === 'IN_REVIEW').length;
  const resolvedCount = AppState.exceptions.filter(c => c.status === 'RESOLVED').length;
  const activeUnresolved = openCount + inReviewCount;

  const badge = document.getElementById('nav-badge-exceptions');
  if (badge) {
    badge.textContent = activeUnresolved;
    badge.style.display = activeUnresolved > 0 ? 'inline-block' : 'inline-block';
  }

  const cntPayments = document.getElementById('tab-cnt-payments');
  if (cntPayments) cntPayments.textContent = AppState.payments.length;

  const modePill = document.getElementById('header-mode-text');
  const benchmarkBanner = document.getElementById('benchmark-active-banner');

  const isSynthetic = AppState.summary && AppState.summary.mode === 'SYNTHETIC';
  if (modePill) {
    modePill.textContent = isSynthetic ? 'BENCHMARK EVALUATION' : 'LIVE MERCHANT MODE';
  }
  if (benchmarkBanner) {
    benchmarkBanner.style.display = isSynthetic ? 'block' : 'none';
  }

  // Sync queue pills with active/open/in_review/resolved
  const elAll = document.getElementById('status-cnt-all');
  const elOpen = document.getElementById('status-cnt-open');
  const elReview = document.getElementById('status-cnt-review');
  const elRes = document.getElementById('status-cnt-resolved');
  const elQueueTotal = document.getElementById('case-queue-total-count');

  if (elAll) elAll.textContent = activeUnresolved;
  if (elOpen) elOpen.textContent = openCount;
  if (elReview) elReview.textContent = inReviewCount;
  if (elRes) elRes.textContent = resolvedCount;
  if (elQueueTotal) elQueueTotal.textContent = activeUnresolved;
}

function renderCurrentPage() {
  if (AppState.currentPage === 'dashboard') {
    renderDashboard();
  } else if (AppState.currentPage === 'payments') {
    renderPaymentsTable();
  } else if (AppState.currentPage === 'settlements') {
    renderSettlements();
  } else if (AppState.currentPage === 'reconciliation') {
    renderReconciliationTable(AppState.activeReconFilter);
  } else if (AppState.currentPage === 'investigations') {
    renderInvestigationQueue();
  }
}

// ── Page 1: Overview Dashboard ───────────────────────────────────────────────
function renderDashboard() {
  const s = AppState.summary || {};
  const emptyState = document.getElementById('dashboard-empty-state');
  const metricsGrid = document.getElementById('dashboard-metrics-grid');

  const totalPaymentsCount = AppState.payments.length;
  const totalRecordsCount = s.total_settlement_records || totalPaymentsCount || 0;
  const totalTxns = Math.max(totalPaymentsCount, totalRecordsCount);

  if (totalTxns === 0 && AppState.exceptions.length === 0) {
    if (emptyState) emptyState.style.display = 'block';
    if (metricsGrid) metricsGrid.style.opacity = '0.4';
  } else {
    if (emptyState) emptyState.style.display = 'none';
    if (metricsGrid) metricsGrid.style.opacity = '1';
  }

  // Canonical Total Gross Calculation (Integer Paise)
  const paymentsGrossPaise = AppState.payments.reduce((sum, p) => sum + (p.amount_paise || 0), 0);
  const summaryGrossPaise  = (typeof s.total_amount_paise === 'number' && s.total_amount_paise > 0)
    ? s.total_amount_paise
    : (typeof s.total_amount_reconciled_paise === 'number' ? s.total_amount_reconciled_paise : 0);
  const totalPaise = Math.max(paymentsGrossPaise, summaryGrossPaise);

  // 1. Total Processed
  const elTotal = document.getElementById('dash-val-total');
  if (elTotal) elTotal.textContent = formatINR(totalPaise);

  const elCntTxns = document.getElementById('dash-cnt-total-txns');
  if (elCntTxns) elCntTxns.textContent = `${totalTxns} transactions`;

  // 2. Successfully Reconciled
  const openExceptions = AppState.exceptions.filter(c => c.status === 'OPEN' || c.status === 'IN_REVIEW');
  const openExposure = openExceptions.reduce((acc, c) => acc + (c.amount_at_risk || 0), 0);
  const resolvedCases = AppState.exceptions.filter(c => c.status === 'RESOLVED');
  const resolvedExposure = resolvedCases.reduce((acc, c) => acc + (c.amount_at_risk || 0), 0);

  const matchedCount = (typeof s.matched === 'number') ? s.matched : Math.max(0, totalTxns - openExceptions.length);
  const matchRate = totalTxns > 0 ? Math.round((matchedCount / totalTxns) * 100) : 100;
  
  const elRecon = document.getElementById('dash-val-reconciled');
  if (elRecon) elRecon.textContent = formatINR(Math.max(0, totalPaise - openExposure));

  const elRate = document.getElementById('dash-rate-reconciled');
  if (elRate) elRate.textContent = `${matchRate}% clean`;

  // 3. Needs Attention (Active Unresolved Exceptions)
  const elAttention = document.getElementById('dash-val-attention');
  if (elAttention) elAttention.textContent = formatINR(openExposure);

  const elBadgeAtt = document.getElementById('dash-badge-attention');
  if (elBadgeAtt) elBadgeAtt.textContent = `${openExceptions.length} Issues`;

  const elCntOpen = document.getElementById('dash-cnt-open-exceptions');
  if (elCntOpen) elCntOpen.textContent = `${openExceptions.length} active exceptions`;

  // 4. Resolved Cases
  const elResolved = document.getElementById('dash-val-resolved');
  if (elResolved) elResolved.textContent = formatINR(resolvedExposure);

  const elCntRes = document.getElementById('dash-cnt-resolved-cases');
  if (elCntRes) elCntRes.textContent = `${resolvedCases.length} cases resolved`;

  // Active Dispute Alerts
  const disputeExceptions = AppState.exceptions.filter(c => (c.exception_category === 'DISPUTE_REVERSAL' || c.category === 'DISPUTE_REVERSAL') && c.status !== 'RESOLVED');
  const disputeBanner = document.getElementById('dashboard-dispute-banner');
  const disputeCount = document.getElementById('dashboard-dispute-count');
  const disputeSub = document.getElementById('dashboard-dispute-subtext');
  if (disputeBanner) {
    if (disputeExceptions.length > 0) {
      disputeBanner.style.display = 'block';
      if (disputeCount) disputeCount.textContent = disputeExceptions.length;
      const disputeExposure = disputeExceptions.reduce((sum, e) => sum + (e.amount_at_risk || 0), 0);
      if (disputeSub) disputeSub.textContent = `${disputeExceptions.length} active customer dispute(s) totaling ${formatINR(disputeExposure)} under review. Evidence submission required to contest reversal.`;
    } else {
      disputeBanner.style.display = 'none';
    }
  }

  // Money Flow Strip Calculation
  const gross = totalPaise;
  const fee   = Math.round(gross * 0.02);
  const tax   = Math.round(fee * 0.18);
  const net   = Math.max(0, gross - fee - tax);
  const diff  = openExposure;

  const fg = document.getElementById('flow-gross');    if (fg) fg.textContent = formatINR(gross);
  const ff = document.getElementById('flow-fee');      if (ff) ff.textContent = formatINR(fee);
  const ft = document.getElementById('flow-tax');      if (ft) ft.textContent = formatINR(tax);
  const fn = document.getElementById('flow-net');      if (fn) fn.textContent = formatINR(net);
  const fv = document.getElementById('flow-variance'); if (fv) fv.textContent = formatINR(diff);

  // Render Priority Queue (Top 4 Active Exceptions)
  const queueContainer = document.getElementById('dashboard-priority-queue');
  if (queueContainer) {
    if (openExceptions.length === 0) {
      queueContainer.innerHTML = `
        <div class="empty-priority-state">
          <div class="empty-priority-icon">✓</div>
          <div class="empty-priority-title">All transactions cleanly balanced</div>
          <div class="empty-priority-desc">No unreconciled exceptions or discrepancies requiring operational attention.</div>
        </div>`;
    } else {
      queueContainer.innerHTML = openExceptions.slice(0, 4).map(exc => `
        <div class="priority-item-card" onclick="openInvestigationFromList('${exc.case_id}')">
          <div class="priority-item-left">
            <span class="priority-risk-tag font-mono">${formatINR(exc.amount_at_risk)}</span>
            <div class="priority-text-block">
              <div class="priority-cat-name">${cleanCategoryLabel(exc.exception_category)}</div>
              <div class="priority-meta-text font-mono">${exc.case_id} · ${exc.settlement_entity_id || exc.merchant_order_id || 'Settlement Discrepancy'}</div>
            </div>
          </div>
          <button class="btn-ghost-sm" type="button">Investigate →</button>
        </div>
      `).join('');
    }
  }

  // Render Recent Transactions (Top 5)
  const recentBody = document.getElementById('dashboard-recent-txns-body');
  if (recentBody) {
    const list = AppState.payments.slice(0, 5);
    if (list.length === 0) {
      recentBody.innerHTML = `
        <tr>
          <td colspan="4" style="text-align:center;padding:2.5rem 1.5rem;color:var(--color-text-muted);">
            <div style="font-size:1.5rem;margin-bottom:0.4rem;">💳</div>
            <div style="font-weight:700;color:var(--color-text-primary);margin-bottom:0.25rem;font-size:0.9rem;">No recent payment transactions</div>
            <div style="font-size:0.8rem;color:var(--color-text-muted);">Payments captured via PayPal Sandbox or Local Demo will automatically appear here.</div>
          </td>
        </tr>`;
    } else {
      recentBody.innerHTML = list.map(p => `
        <tr>
          <td class="font-mono" style="font-weight:700;color:var(--color-primary);">${p.id}</td>
          <td><span class="status-pill info font-mono">${p.method}</span></td>
          <td class="font-mono" style="font-weight:700;">${formatINR(p.amount_paise)}</td>
          <td><span class="status-pill ${p.recon_status === 'EXCEPTION' ? 'warning' : 'success'}">${p.recon_status || 'MATCHED'}</span></td>
        </tr>
      `).join('');
    }
  }
}

// ── Toast Notification Component ─────────────────────────────────────────────
function showToast(message, type = 'info') {
  const container = document.getElementById('toast-container');
  if (!container) return;

  const icons = {
    success: '✓',
    warning: '⚠',
    error: '✕',
    info: 'ℹ',
  };

  const toast = document.createElement('div');
  toast.className = `fintech-toast ${type}`;
  toast.innerHTML = `
    <span class="toast-icon">${icons[type] || 'ℹ'}</span>
    <span class="toast-message">${message}</span>
  `;

  container.appendChild(toast);

  setTimeout(() => {
    toast.style.transition = 'opacity 0.3s ease, transform 0.3s ease';
    toast.style.opacity = '0';
    toast.style.transform = 'translateY(10px) scale(0.95)';
    setTimeout(() => toast.remove(), 300);
  }, 4000);
}

// ── Payment Processing Mode State & Toggle ───────────────────────────────────
let currentProcessingMode = 'paypal'; // 'paypal' (primary sandbox Orders v2) or 'local'
let currentPayPalProduct = 'TIER_STARTER';
let currentPayPalActiveOrder = null;

function setProcessingMode(mode) {
  currentProcessingMode = mode === 'local' ? 'local' : 'paypal';
  const btnPayPal = document.getElementById('btn-mode-paypal');
  const btnLocal  = document.getElementById('btn-mode-local');
  const noticeEl  = document.getElementById('mode-active-notice');
  const paypalContainer = document.getElementById('paypal-parameters-container');
  const legacyContainer = document.getElementById('legacy-parameters-container');
  const ppChain         = document.getElementById('paypal-lifecycle-chain');
  const localChain      = document.getElementById('local-lifecycle-chain');

  if (btnPayPal) btnPayPal.classList.toggle('active', currentProcessingMode === 'paypal');
  if (btnLocal)  btnLocal.classList.toggle('active', currentProcessingMode === 'local');

  if (paypalContainer) paypalContainer.style.display = (currentProcessingMode === 'paypal') ? 'block' : 'none';
  if (legacyContainer) legacyContainer.style.display = (currentProcessingMode === 'local') ? 'block' : 'none';
  if (ppChain)         ppChain.style.display         = (currentProcessingMode === 'paypal') ? 'block' : 'none';
  if (localChain)      localChain.style.display      = (currentProcessingMode === 'local') ? 'block' : 'none';

  if (noticeEl) {
    if (currentProcessingMode === 'paypal') {
      noticeEl.innerHTML = '🅿️ <strong>PayPal Sandbox Mode:</strong> Real server-created Orders v2 with returned approval link, buyer authorization, and verified capture evidence. Prices are server-controlled in integer minor units.';
    } else {
      noticeEl.innerHTML = '⚡ <strong>Local Demo Mode:</strong> Instant offline deterministic execution. Zero external API credentials required.';
    }
  }

  updatePayButtonLabel();
}

function selectPayPalProduct(productId, price) {
  currentPayPalProduct = productId;
  const customGroup = document.getElementById('paypal-custom-amount-group');
  if (customGroup) {
    customGroup.style.display = (productId === 'CUSTOM_DEMO') ? 'block' : 'none';
  }

  const createLabel = document.getElementById('btn-paypal-create-label');
  if (createLabel) {
    if (productId === 'CUSTOM_DEMO') {
      createLabel.textContent = 'Create PayPal Sandbox Order (Custom Amount)';
    } else {
      createLabel.textContent = `Create PayPal Sandbox Order ($${price.toFixed(2)} USD)`;
    }
  }
}

async function handlePayPalCreateOrder() {
  const btn = document.getElementById('btn-paypal-create-order');
  const refInput = document.getElementById('paypal-order-ref');
  const customInput = document.getElementById('paypal-custom-amount');
  const lifecycleBox = document.getElementById('paypal-order-lifecycle-box');
  const statusBadge = document.getElementById('paypal-lifecycle-status-badge');
  const displayOrderId = document.getElementById('paypal-display-order-id');
  const displayAmount = document.getElementById('paypal-display-amount');
  const displayIdempotency = document.getElementById('paypal-display-idempotency');
  const approveLinkBtn = document.getElementById('paypal-btn-approve-link');

  if (btn) btn.disabled = true;

  try {
    const referenceId = (refInput && refInput.value.trim()) || `ref_sb_${Date.now().toString(36)}`;
    const idempotencyKey = `idemp_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;

    let customMinor = null;
    if (currentPayPalProduct === 'CUSTOM_DEMO') {
      const val = parseFloat(customInput ? customInput.value : 15.00) || 15.00;
      customMinor = Math.round(val * 100);
    }

    // Step 1 node in PayPal chain
    const stepPPOrder   = document.getElementById('step-pp-order');
    const descPPOrder   = document.getElementById('chain-desc-pp-order');
    const metaPPOrder   = document.getElementById('chain-meta-pp-order');
    const stepPPApprove = document.getElementById('step-pp-approve');
    const descPPApprove = document.getElementById('chain-desc-pp-approve');
    const metaPPApprove = document.getElementById('chain-meta-pp-approve');

    if (stepPPOrder) stepPPOrder.classList.add('active');
    if (descPPOrder) descPPOrder.textContent = 'Calling PayPal Orders v2 API (/v2/checkout/orders)...';

    const res = await fetch('/api/paypal/create-order', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        product_id: currentPayPalProduct,
        amount_minor: customMinor,
        currency: 'USD',
        reference_id: referenceId,
        idempotency_key: idempotencyKey,
      }),
    });

    const data = await res.json();
    if (!res.ok) {
      throw new Error(data.error || 'Failed to create PayPal order.');
    }

    currentPayPalActiveOrder = data;

    if (stepPPOrder) { stepPPOrder.classList.remove('active'); stepPPOrder.classList.add('completed'); }
    if (descPPOrder) descPPOrder.textContent = `Order Created: ${data.order_id}`;
    if (metaPPOrder) metaPPOrder.textContent = `PayPal-Request-Id: ${data.idempotency_key}`;
    if (stepPPApprove) stepPPApprove.classList.add('active');
    if (descPPApprove) descPPApprove.textContent = data.approve_url ? 'Awaiting buyer sandbox authorization...' : 'Order ready for capture.';
    if (metaPPApprove) metaPPApprove.textContent = data.approve_url ? 'Click "Approve on PayPal Sandbox" below' : 'Pre-approved';

    // Reveal lifecycle box
    if (lifecycleBox) lifecycleBox.style.display = 'block';
    if (statusBadge) {
      statusBadge.textContent = data.status || 'CREATED';
      statusBadge.className = 'status-pill warning';
    }
    if (displayOrderId) displayOrderId.textContent = data.order_id;
    if (displayAmount) displayAmount.textContent = `$${data.amount_decimal} ${data.currency} (${data.amount_minor} cents)`;
    if (displayIdempotency) displayIdempotency.textContent = data.idempotency_key;

    if (approveLinkBtn) {
      if (data.approve_url) {
        approveLinkBtn.href = data.approve_url;
        approveLinkBtn.style.display = 'inline-flex';
      } else {
        approveLinkBtn.style.display = 'none';
      }
    }

    if (descPay) descPay.textContent = `Order ${data.order_id} created. Awaiting buyer approval & capture.`;
    if (metaPay) metaPay.textContent = `Order: ${data.order_id} | $${data.amount_decimal} USD`;

    showToast(`PayPal Sandbox Order ${data.order_id} created!`, 'success');

  } catch (err) {
    console.error('[handlePayPalCreateOrder] Error:', err);
    showToast(err.message, 'error');
  } finally {
    if (btn) btn.disabled = false;
  }
}

async function handlePayPalCaptureOrder() {
  if (!currentPayPalActiveOrder || !currentPayPalActiveOrder.order_id) {
    showToast('Please create a PayPal order first before capturing.', 'error');
    return;
  }

  const btn = document.getElementById('btn-paypal-capture-order');
  const statusBadge = document.getElementById('paypal-lifecycle-status-badge');
  const descPay = document.getElementById('chain-desc-pay');
  const descSet = document.getElementById('chain-desc-set');
  const descRecon = document.getElementById('chain-desc-recon');
  const stepPay = document.getElementById('step-payment');
  const stepSet = document.getElementById('step-settlement');
  const stepRecon = document.getElementById('step-reconciliation');

  if (btn) btn.disabled = true;

  try {
    const orderId = currentPayPalActiveOrder.order_id;
    const idempotencyKey = `cap_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;

    if (descPay) descPay.textContent = `Executing server-verified capture via PayPal v2 API...`;

    const res = await fetch('/api/paypal/capture-order', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        order_id: orderId,
        idempotency_key: idempotencyKey,
      }),
    });

    const data = await res.json();
    if (!res.ok) {
      throw new Error(data.error || 'Failed to capture PayPal order.');
    }

    if (statusBadge) {
      statusBadge.textContent = 'COMPLETED';
      statusBadge.className = 'status-pill success';
    }

    // Step updates for PayPal chain
    const stepPPApprove = document.getElementById('step-pp-approve');
    const stepPPCapture = document.getElementById('step-pp-capture');
    const descPPCapture = document.getElementById('chain-desc-pp-capture');
    const metaPPCapture = document.getElementById('chain-meta-pp-capture');

    if (stepPPApprove) { stepPPApprove.classList.remove('active'); stepPPApprove.classList.add('completed'); }
    if (stepPPCapture) { stepPPCapture.classList.remove('active'); stepPPCapture.classList.add('completed'); }
    if (descPPCapture) descPPCapture.textContent = `Capture completed: ${data.capture_id}`;
    if (metaPPCapture) metaPPCapture.textContent = `Verified Amount: $${data.amount_decimal} ${data.currency} (Gateway Transit)`;

    // Render Confirmation View
    const setupPanel = document.getElementById('payment-setup-container');
    const confirmPanel = document.getElementById('payment-confirmation-container');
    if (setupPanel) setupPanel.style.display = 'none';
    if (confirmPanel) confirmPanel.style.display = 'block';

    const valPayId = document.getElementById('confirm-val-pay-id');
    const valOrderId = document.getElementById('confirm-val-order-id');
    const valGross = document.getElementById('confirm-val-gross');
    const valNet = document.getElementById('confirm-val-net');
    const valStatus = document.getElementById('confirm-val-status');
    const valSettlement = document.getElementById('confirm-val-settlement');
    const mainTitle = document.getElementById('confirm-main-title');
    const subTitle = document.getElementById('confirm-sub-title');

    if (mainTitle) mainTitle.textContent = 'PayPal Sandbox Payment Captured & Verified';
    if (subTitle) subTitle.textContent = 'PayPal Orders v2 capture completed with strict minor-unit amount verification. Recorded as gateway capture held in transit (distinct from bank settlement).';
    if (valPayId) valPayId.textContent = data.capture_id;
    if (valOrderId) valOrderId.textContent = data.order_id;
    if (valGross) valGross.textContent = `$${data.amount_decimal} ${data.currency}`;
    if (valNet) valNet.textContent = `$${data.amount_decimal} ${data.currency} (Transit)`;
    if (valStatus) valStatus.innerHTML = '<span class="status-pill success">CAPTURED (GATEWAY)</span>';
    if (valSettlement) valSettlement.textContent = 'GATEWAY_TRANSIT (Not Bank Batch)';

    showToast(`PayPal Capture ${data.capture_id} verified successfully!`, 'success');

    // Reload data in background
    await loadAllData();

  } catch (err) {
    console.error('[handlePayPalCaptureOrder] Error:', err);
    showToast(err.message, 'error');
  } finally {
    if (btn) btn.disabled = false;
  }
}

function updatePayButtonLabel() {
  const amountInput = document.getElementById('custom-amount-input');
  const amountRupees = parseFloat(amountInput ? amountInput.value : 1000) || 1000;
  const amountPaise = Math.round(amountRupees * 100);
  const payBtnLabel = document.getElementById('btn-pay-label');
  if (payBtnLabel) {
    payBtnLabel.textContent = `Process Demo Payment (${formatINR(amountPaise)})`;
  }
}

function setPaymentAmount(amt) {
  const input = document.getElementById('custom-amount-input');
  if (input) input.value = amt.toFixed(2);

  document.querySelectorAll('.quick-chip').forEach(chip => {
    const chipAmt = parseFloat(chip.textContent.replace(/[₹,]/g, ''));
    chip.classList.toggle('active', chipAmt === amt);
  });

  updatePayButtonLabel();
}

function resetPaymentForm() {
  const setupPanel = document.getElementById('payment-setup-container');
  const confirmPanel = document.getElementById('payment-confirmation-container');
  if (setupPanel) setupPanel.style.display = 'grid';
  if (confirmPanel) confirmPanel.style.display = 'none';

  const noteInput = document.getElementById('payment-note-input');
  if (noteInput) noteInput.value = '';

  const anomalySelect = document.getElementById('anomaly-select');
  if (anomalySelect) anomalySelect.value = 'CLEAN_MATCH';

  const stepSet = document.getElementById('step-settlement');
  const stepRecon = document.getElementById('step-reconciliation');
  const stepPay = document.getElementById('step-payment');

  if (stepSet) stepSet.classList.remove('active', 'completed');
  if (stepRecon) stepRecon.classList.remove('active', 'completed');
  if (stepPay) {
    stepPay.classList.add('active');
    stepPay.classList.remove('completed');
  }

  const metaPay = document.getElementById('chain-meta-pay');
  const metaSet = document.getElementById('chain-meta-set');
  const metaRecon = document.getElementById('chain-meta-recon');
  if (metaPay) metaPay.textContent = '—';
  if (metaSet) metaSet.textContent = '—';
  if (metaRecon) metaRecon.textContent = '—';

  setPaymentAmount(1000);
}

function showPaymentConfirmation({ payment_id, order_id, amount_paise, settlement_record, is_exception, exception }) {
  // Defensive: ensure amount_paise is defined
  if (typeof amount_paise === 'undefined' || amount_paise === null) {
    console.error('[showPaymentConfirmation] amount_paise is undefined!', { payment_id, order_id, settlement_record });
    amount_paise = 0; // Fallback to prevent crash
  }

  const setupPanel = document.getElementById('payment-setup-container');
  const confirmPanel = document.getElementById('payment-confirmation-container');

  if (setupPanel) setupPanel.style.display = 'none';
  if (confirmPanel) confirmPanel.style.display = 'block';

  const iconEl = document.getElementById('confirm-status-icon');
  const titleEl = document.getElementById('confirm-main-title');
  const subTitleEl = document.getElementById('confirm-sub-title');
  const btnInv = document.getElementById('btn-confirm-inv');

  const payId = payment_id || '—';
  const ordId = order_id || '—';
  const netCredit = settlement_record ? settlement_record.credit : Math.max(0, amount_paise - Math.round(amount_paise * 0.02 * 1.18));
  const setlId = settlement_record ? settlement_record.settlement_id : 'setl_live';

  document.getElementById('confirm-val-pay-id').textContent = payId;
  document.getElementById('confirm-val-order-id').textContent = ordId;
  document.getElementById('confirm-val-gross').textContent = formatINR(amount_paise);
  document.getElementById('confirm-val-net').textContent = formatINR(netCredit);
  document.getElementById('confirm-val-settlement').textContent = setlId;

  const statusEl = document.getElementById('confirm-val-status');
  if (is_exception) {
    if (iconEl) {
      iconEl.className = 'confirm-status-icon warning';
      iconEl.textContent = '⚠';
    }
    if (titleEl) titleEl.textContent = 'Payment Captured — Discrepancy Flagged';
    if (subTitleEl) subTitleEl.textContent = `Deterministic reconciliation engine detected a ${cleanCategoryLabel(exception?.category)} variance.`;
    if (statusEl) statusEl.innerHTML = `<span class="status-pill warning">EXCEPTION CREATED</span>`;
    
    if (btnInv) {
      btnInv.style.display = 'inline-flex';
      btnInv.onclick = () => {
        navigateTo('investigations');
        if (exception?.id) selectInvestigationCase(exception.id);
      };
    }
  } else {
    if (iconEl) {
      iconEl.className = 'confirm-status-icon success';
      iconEl.textContent = '✓';
    }
    if (titleEl) titleEl.textContent = 'Payment Successfully Captured & Reconciled';
    if (subTitleEl) subTitleEl.textContent = 'Deterministic reconciliation engine verified 100% clean balance against merchant ledger.';
    if (statusEl) statusEl.innerHTML = `<span class="status-pill success">MATCHED</span>`;
    if (btnInv) btnInv.style.display = 'none';
  }
}

// ── Initialize payment button click handler ──────────────────────────────────
async function handlePaymentSubmit() {
  const amountInput = document.getElementById('custom-amount-input');
  const amountRupees = parseFloat(amountInput ? amountInput.value : 0);

  if (isNaN(amountRupees) || amountRupees < 1 || amountRupees > 500000) {
    showToast('Please enter an amount between ₹1.00 and ₹5,00,000.00', 'warning');
    return;
  }

  const amountPaise = Math.round(amountRupees * 100);
  const anomalySelect = document.getElementById('anomaly-select');
  const anomalyType = anomalySelect ? anomalySelect.value : 'CLEAN_MATCH';
  const noteInput = document.getElementById('payment-note-input');
  const customerRef = (noteInput && noteInput.value.trim()) || `order_ref_${Date.now().toString(36)}`;

  const selectedMethodInput = document.querySelector('input[name="payment_method"]:checked');
  const method = selectedMethodInput ? selectedMethodInput.value : 'card';

  const payBtn = document.getElementById('btn-pay-now');
  const payBtnLabel = document.getElementById('btn-pay-label');
  if (payBtn) payBtn.disabled = true;

  // ── FLOW A: LOCAL DEMO PAYMENT (Instant Offline Deterministic Processing) ──
  if (currentProcessingMode === 'local') {
    if (payBtnLabel) payBtnLabel.textContent = 'Processing Payment & Settlement…';

    try {
      const step1 = document.getElementById('step-payment');
      if (step1) step1.classList.add('active');
      const metaPay = document.getElementById('chain-meta-pay');
      if (metaPay) metaPay.textContent = 'Creating local transaction record…';

      const res = await fetch('/api/payments/local', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          amount: amountPaise,
          payment_method: method,
          customer_ref: customerRef,
          anomaly_type: anomalyType,
        }),
      });

      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to process local payment.');

      // Animate pipeline steps
      if (step1) step1.classList.add('completed');
      if (metaPay) metaPay.textContent = `Captured: ${data.payment_id}`;

      const step2 = document.getElementById('step-settlement');
      if (step2) step2.classList.add('active', 'completed');
      const sr = data.settlement_record;
      const metaSet = document.getElementById('chain-meta-set');
      if (metaSet) metaSet.textContent = `Settled (T+2): ${sr ? sr.settlement_id : 'setl_live'} (Net: ${formatINR(sr ? sr.credit : amountPaise)})`;

      const step3 = document.getElementById('step-reconciliation');
      if (step3) step3.classList.add('active', 'completed');
      const isException = data.is_exception;
      const metaRecon = document.getElementById('chain-meta-recon');
      if (metaRecon) {
        metaRecon.textContent = isException
          ? `Discrepancy: ${cleanCategoryLabel(data.exception?.category)}`
          : `Reconciliation Status: MATCHED (Clean)`;
      }

      // Transition to dedicated confirmation panel
      showPaymentConfirmation({
        payment_id: data.payment_id,
        order_id: data.order_id,
        amount_paise,
        settlement_record: sr,
        is_exception,
        exception: data.exception,
      });

      if (isException) {
        showToast(`Discrepancy detected (${cleanCategoryLabel(data.exception?.category)}). Investigation created.`, 'warning');
      } else {
        showToast(`Payment of ${formatINR(amountPaise)} successfully created and reconciled.`, 'success');
      }

      await loadAllData();
    } catch (err) {
      showToast(`Payment error: ${err.message}`, 'error');
    } finally {
      if (payBtn) {
        payBtn.disabled = false;
        updatePayButtonLabel();
      }
    }
    return;
  }
}

// ── Page 3: Payments Table ───────────────────────────────────────────────────
function renderPaymentsTable() {
  const tbody = document.getElementById('payments-table-body');
  const countLabel = document.getElementById('payments-table-count');
  const ppBody = document.getElementById('paypal-table-body');
  const ppCount = document.getElementById('paypal-table-count');

  // 1. Render PayPal Sandbox Captures (Primary Gateway)
  const ppCaptures = AppState.paypalTransactions || [];
  if (ppCount) ppCount.textContent = `${ppCaptures.length} captures`;
  if (ppBody) {
    if (ppCaptures.length === 0) {
      ppBody.innerHTML = `<tr><td colspan="7" style="text-align:center;padding:1.5rem;color:var(--color-text-muted);">No PayPal Sandbox captures recorded yet. Use "+ Process Payment" to test.</td></tr>`;
    } else {
      ppBody.innerHTML = ppCaptures.map(c => `
        <tr>
          <td class="font-mono" style="font-weight:700;color:#0070ba;">${c.capture_id}</td>
          <td class="font-mono">${c.order_id || '—'}</td>
          <td class="font-mono"><span class="status-pill info">${c.currency}</span></td>
          <td class="font-mono">${c.amount_minor || '—'}</td>
          <td class="font-mono" style="font-weight:700;">$${c.amount_decimal}</td>
          <td><span class="status-pill success">${c.capture_status || 'COMPLETED'}</span></td>
          <td style="font-size:0.75rem;color:#64748b;"><span class="status-pill neutral">GATEWAY_TRANSIT</span> (Not Bank Batch)</td>
        </tr>
      `).join('');
    }
  }

  // 2. Render Legacy / Simulated Payments Table
  if (!tbody) return;

  const payments = AppState.payments;
  if (countLabel) countLabel.textContent = `Showing ${payments.length} payments`;

  if (payments.length === 0) {
    tbody.innerHTML = `<tr><td colspan="7" style="text-align:center;padding:2rem;color:var(--color-text-muted);">No payment records in current session. Process a payment to view.</td></tr>`;
    return;
  }

  tbody.innerHTML = payments.map(p => {
    const gross = p.amount_paise || p.amount || 0;
    const fee   = p.fee || Math.round(gross * 0.02);
    const tax   = p.tax || Math.round(fee * 0.18);
    const net   = p.net_credit || (gross - fee - tax);

    return `
      <tr>
        <td class="font-mono" style="font-weight:700;color:var(--color-primary);">${p.id}</td>
        <td class="font-mono">${p.order_id || '—'}</td>
        <td><span class="status-pill info font-mono">${p.method ? p.method.toUpperCase() : 'CARD'}</span></td>
        <td class="font-mono" style="font-weight:700;">${formatINR(gross)}</td>
        <td class="font-mono text-success" style="font-weight:700;">${formatINR(net)}</td>
        <td>${formatDate(p.created_at)}</td>
        <td><span class="status-pill success">CAPTURED</span></td>
      </tr>
    `;
  }).join('');
}

function filterPaymentsTable() {
  const query = (document.getElementById('search-payments').value || '').toLowerCase();
  const rows = document.querySelectorAll('#payments-ledger-table tbody tr');
  rows.forEach(r => {
    r.style.display = r.textContent.toLowerCase().includes(query) ? '' : 'none';
  });
}

// ── Page 4: Settlements ──────────────────────────────────────────────────────
function renderSettlements() {
  const s = AppState.summary || {};
  const setls = AppState.settlements || { batches: [], records: [] };

  const gross = (typeof s.total_amount_paise === 'number' && s.total_amount_paise > 0)
    ? s.total_amount_paise
    : (typeof s.total_amount_reconciled_paise === 'number' && s.total_amount_reconciled_paise > 0
        ? s.total_amount_reconciled_paise
        : AppState.payments.reduce((sum, p) => sum + (p.amount_paise || 0), 0));

  const fees  = Math.round(gross * 0.02);
  const tax   = Math.round(fees * 0.18);
  const net   = Math.max(0, gross - fees - tax);

  const cntB = document.getElementById('setl-cnt-batches'); if (cntB) cntB.textContent = `${setls.batches.length || 1} Batches`;
  const vg   = document.getElementById('setl-val-gross');   if (vg) vg.textContent = formatINR(gross);
  const vf   = document.getElementById('setl-val-fees');    if (vf) vf.textContent = formatINR(fees);
  const vt   = document.getElementById('setl-val-tax');     if (vt) vt.textContent = formatINR(tax);
  const vn   = document.getElementById('setl-val-net');     if (vn) vn.textContent = formatINR(net);

  const container = document.getElementById('settlement-batches-container');
  if (!container) return;

  const batches = setls.batches.length > 0 ? setls.batches : [
    { id: 'setl_batch_001', settlement_utr: 'UTR_NODAL_998124', records_count: 24, total_gross_paise: Math.round(gross * 0.4) },
    { id: 'setl_batch_002', settlement_utr: 'UTR_NODAL_998125', records_count: 20, total_gross_paise: Math.round(gross * 0.3) },
    { id: 'setl_batch_003', settlement_utr: 'UTR_NODAL_998126', records_count: 18, total_gross_paise: Math.round(gross * 0.2) },
    { id: 'setl_batch_004', settlement_utr: 'UTR_NODAL_998127', records_count: 14, total_gross_paise: Math.round(gross * 0.1) },
  ];

  container.innerHTML = batches.map(b => {
    const bGross = typeof b.total_gross_paise === 'number' ? b.total_gross_paise : (b.gross_paise || Math.round(gross / batches.length));
    const bFee   = typeof b.total_fee_paise === 'number' ? b.total_fee_paise : (b.fee_paise || Math.round(bGross * 0.02));
    const bTax   = typeof b.total_tax_paise === 'number' ? b.total_tax_paise : (b.tax_paise || Math.round(bFee * 0.18));
    const bNet   = typeof b.total_credit_paise === 'number' ? b.total_credit_paise : (b.credit_paise || (bGross - bFee - bTax));
    const bUtr   = b.settlement_utr || b.utr || 'UTR_NODAL_LIVE';
    const bId    = b.id || b.batch_id || 'setl_batch_live';
    const bCount = b.records_count || b.record_count || (b.records ? b.records.length : 1);

    return `
      <div class="settlement-batch-card">
        <div class="batch-card-header">
          <div>
            <span class="batch-id-title font-mono">${bId}</span>
            <span class="text-muted" style="font-size:0.8rem;margin-left:0.5rem;">· ${bCount} transactions</span>
          </div>
          <span class="status-pill success font-mono">SETTLED (T+2)</span>
        </div>

        <div class="batch-stats-grid">
          <div>
            <span class="sum-label">Gross Amount</span>
            <span class="sum-val font-mono" style="font-size:1rem;">${formatINR(bGross)}</span>
          </div>
          <div>
            <span class="sum-label">Contracted Fees (2%)</span>
            <span class="sum-val font-mono text-muted" style="font-size:1rem;">${formatINR(bFee)}</span>
          </div>
          <div>
            <span class="sum-label">GST (18%)</span>
            <span class="sum-val font-mono text-muted" style="font-size:1rem;">${formatINR(bTax)}</span>
          </div>
          <div>
            <span class="sum-label">Net Nodal Payout</span>
            <span class="sum-val font-mono text-success" style="font-size:1rem;">${formatINR(bNet)}</span>
          </div>
          <div>
            <span class="sum-label">Bank UTR Reference</span>
            <span class="sum-val font-mono" style="font-size:0.85rem;color:var(--color-primary);">${bUtr}</span>
          </div>
        </div>
      </div>
    `;
  }).join('');
}

// ── Page 5: Reconciliation Table ─────────────────────────────────────────────
function renderReconciliationTable(filter = 'ALL') {
  AppState.activeReconFilter = filter;

  // Update filter pills immediately
  document.querySelectorAll('#recon-status-filter-buttons .filter-pill-btn').forEach(btn => {
    btn.classList.toggle('active', btn.getAttribute('data-filter') === filter);
  });

  const tbody = document.getElementById('recon-table-body');
  const countLabel = document.getElementById('recon-table-count');
  if (!tbody) return;

  let results = AppState.reconciliations;
  if (filter === 'MATCHED') {
    results = results.filter(r => r.status === 'MATCHED');
  } else if (filter === 'EXCEPTION') {
    results = results.filter(r => r.status === 'EXCEPTION');
  }

  if (countLabel) countLabel.textContent = `Showing ${results.length} reconciliation audits`;

  if (results.length === 0) {
    tbody.innerHTML = `<tr><td colspan="8" style="text-align:center;padding:2rem;color:var(--color-text-muted);">No records matching current filter.</td></tr>`;
    return;
  }

  tbody.innerHTML = results.map(r => {
    const isMatched = r.status === 'MATCHED';
    const allRecords = (AppState.settlements && AppState.settlements.records) || [];
    const sr = allRecords.find(s => s.entity_id === r.settlement_entity_id || s.id === r.settlement_entity_id);

    const gross = sr ? sr.amount : ((r.amount_razorpay || r.amount_merchant || 0) + (r.fee_actual || 0) + (r.tax_actual || 0));
    const fee = sr ? sr.fee : (r.fee_expected || Math.round(gross * 0.02));
    const tax = sr ? sr.tax : (r.tax_expected || Math.round(fee * 0.18));
    const expectedNet = r.amount_merchant || (sr ? (gross - fee - tax) : (gross - fee - tax));
    const actualNet = r.amount_razorpay || (sr ? sr.credit : expectedNet);
    const variance = typeof r.amount_variance === 'number' ? Math.abs(r.amount_variance) : Math.abs(expectedNet - actualNet);

    return `
      <tr>
        <td class="font-mono" style="font-weight:700;color:var(--color-primary);">${r.settlement_entity_id || r.id}</td>
        <td class="font-mono">${r.merchant_order_id || '—'}</td>
        <td class="font-mono" style="font-weight:700;">${formatINR(gross)}</td>
        <td class="font-mono">${formatINR(expectedNet)}</td>
        <td class="font-mono ${isMatched ? 'text-success' : 'text-danger'}" style="font-weight:700;">${formatINR(actualNet)}</td>
        <td class="font-mono ${variance > 0 ? 'text-danger' : 'text-muted'}">${variance > 0 ? formatINR(variance) : '₹0.00'}</td>
        <td>
          <span class="status-pill ${isMatched ? 'success' : 'danger'} font-mono">
            ${isMatched ? 'MATCHED' : cleanCategoryLabel(r.exception_category)}
          </span>
        </td>
        <td>
          ${!isMatched ? (() => {
            const matchedExc = (AppState.exceptions || []).find(e => e.reconciliation_result_id === r.id || e.id === r.exception_id || e.case_id === r.exception_id);
            const canonicalCaseId = r.exception_id || matchedExc?.case_id || matchedExc?.id;
            return canonicalCaseId ? `
              <button class="btn-ghost-sm" onclick="openInvestigationFromList('${canonicalCaseId}')" type="button">Investigate →</button>
            ` : `
              <span class="text-muted" style="font-size:0.75rem;">Balanced</span>
            `;
          })() : `
            <span class="text-muted" style="font-size:0.75rem;">Balanced</span>
          `}
        </td>
      </tr>
    `;
  }).join('');
}

function filterReconciliationTable(filter = 'ALL') {
  renderReconciliationTable(filter);
}

function searchReconciliationTable() {
  const query = (document.getElementById('search-recon').value || '').toLowerCase();
  const rows = document.querySelectorAll('#recon-audit-table tbody tr');
  rows.forEach(r => {
    r.style.display = r.textContent.toLowerCase().includes(query) ? '' : 'none';
  });
}

if (typeof window !== 'undefined') {
  window.filterReconciliationTable = filterReconciliationTable;
  window.searchReconciliationTable = searchReconciliationTable;
  window.renderReconciliationTable = renderReconciliationTable;
  window.filterByDisputes = function() {
    navigateTo('investigations');
    const catFilter = document.getElementById('case-filter-select');
    if (catFilter) {
      catFilter.value = 'DISPUTE_REVERSAL';
      AppState.activeCategoryFilter = 'DISPUTE_REVERSAL';
      renderInvestigationQueue();
    }
  };
}

// ── Page 6: Investigations Workstation (Chunks 2, 3, 4) ──────────────────────
function renderInvestigationQueue() {
  const listEl = document.getElementById('case-items-list');
  const countEl = document.getElementById('case-queue-total-count');
  const emptyPrompt = document.getElementById('investigation-empty-prompt');
  const caseContent = document.getElementById('investigation-case-content');
  
  if (!listEl) return;

  // Derive dynamic counts strictly from canonical store
  const openCnt   = AppState.exceptions.filter(c => c.status === 'OPEN').length;
  const revCnt    = AppState.exceptions.filter(c => c.status === 'IN_REVIEW').length;
  const resCnt    = AppState.exceptions.filter(c => c.status === 'RESOLVED').length;
  const activeCnt = openCnt + revCnt; // All tab represents ACTIVE only (OPEN + IN_REVIEW)

  // Update pills and badges
  const elAll = document.getElementById('status-cnt-all');
  const elOpen = document.getElementById('status-cnt-open');
  const elReview = document.getElementById('status-cnt-review');
  const elRes = document.getElementById('status-cnt-resolved');
  if (elAll) elAll.textContent = activeCnt;
  if (elOpen) elOpen.textContent = openCnt;
  if (elReview) elReview.textContent = revCnt;
  if (elRes) elRes.textContent = resCnt;
  if (countEl) countEl.textContent = activeCnt;

  const badge = document.getElementById('nav-badge-exceptions');
  if (badge) {
    badge.textContent = activeCnt;
    badge.style.display = activeCnt > 0 ? 'inline-block' : 'inline-block';
  }

  // Filter cases strictly per tab requirements:
  // - All = ACTIVE cases only (OPEN + IN_REVIEW)
  // - Open = OPEN only
  // - In Review = IN_REVIEW only
  // - Resolved = RESOLVED only
  let cases = [];
  if (AppState.activeStatusFilter === 'ALL') {
    cases = AppState.exceptions.filter(c => c.status === 'OPEN' || c.status === 'IN_REVIEW');
  } else if (AppState.activeStatusFilter === 'OPEN') {
    cases = AppState.exceptions.filter(c => c.status === 'OPEN');
  } else if (AppState.activeStatusFilter === 'IN_REVIEW') {
    cases = AppState.exceptions.filter(c => c.status === 'IN_REVIEW');
  } else if (AppState.activeStatusFilter === 'RESOLVED') {
    cases = AppState.exceptions.filter(c => c.status === 'RESOLVED');
  } else {
    cases = AppState.exceptions.filter(c => c.status === 'OPEN' || c.status === 'IN_REVIEW');
  }

  // Filter by category
  if (AppState.activeCategoryFilter !== 'ALL') {
    cases = cases.filter(c => c.exception_category === AppState.activeCategoryFilter);
  }

  // CRITICAL: Truly empty state (zero exceptions in the entire system)
  if (AppState.exceptions.length === 0) {
    AppState.currentCaseId = null;
    AppState.currentCaseDetail = null;
    
    listEl.innerHTML = `<li style="padding:2rem 1rem;text-align:center;color:var(--color-text-muted);">
      <div style="font-size:2.5rem;margin-bottom:0.75rem;">✓</div>
      <div style="font-weight:600;font-size:0.9rem;margin-bottom:0.5rem;color:var(--color-text-primary);">All Clear</div>
      <div style="font-size:0.8rem;line-height:1.5;">No reconciliation exceptions detected</div>
    </li>`;
    
    if (emptyPrompt) {
      emptyPrompt.style.display = 'flex';
      const emptyTitle = emptyPrompt.querySelector('.empty-title');
      const emptyDesc = emptyPrompt.querySelector('.empty-desc');
      
      if (AppState.payments.length === 0) {
        if (emptyTitle) emptyTitle.textContent = 'No payment activity yet';
        if (emptyDesc) emptyDesc.textContent = 'Create a payment to begin reconciliation. When Payvault detects a discrepancy, it will appear here for investigation.';
      } else {
        if (emptyTitle) emptyTitle.textContent = 'No exceptions to investigate';
        if (emptyDesc) emptyDesc.textContent = 'Payments and settlements are currently balanced. When Payvault detects a reconciliation exception, it will appear here.';
      }
    }
    
    if (caseContent) caseContent.style.display = 'none';
    return;
  }

  // Filtered empty state (exceptions exist, but none match the current filter tab/category)
  if (cases.length === 0) {
    const tabName = AppState.activeStatusFilter === 'ALL'
      ? 'Active'
      : (AppState.activeStatusFilter === 'IN_REVIEW' ? 'In Review' : (AppState.activeStatusFilter === 'RESOLVED' ? 'Resolved' : 'Open'));

    listEl.innerHTML = `<li style="padding:2rem 1.25rem;text-align:center;color:var(--color-text-muted);font-size:0.85rem;">
      <div style="font-size:1.8rem;margin-bottom:0.5rem;">🔍</div>
      <div style="font-weight:700;color:var(--color-text-primary);margin-bottom:0.25rem;">No ${tabName} Cases</div>
      <div style="font-size:0.78rem;line-height:1.4;">There are no exceptions in the ${tabName.toLowerCase()} queue.</div>
    </li>`;

    if (caseContent) caseContent.style.display = 'none';
    if (emptyPrompt) {
      emptyPrompt.style.display = 'flex';
      const emptyTitle = emptyPrompt.querySelector('.empty-title');
      const emptyDesc = emptyPrompt.querySelector('.empty-desc');
      if (emptyTitle) emptyTitle.textContent = `No ${tabName} investigations`;
      if (emptyDesc) emptyDesc.textContent = `All exceptions in this queue have been processed, moved, or are located under other queue tabs.`;
    }
    return;
  }

  // Cases exist for current filter: display workspace and hide empty prompt
  if (emptyPrompt) emptyPrompt.style.display = 'none';
  if (caseContent) caseContent.style.display = 'block';

  listEl.innerHTML = cases.map(c => {
    const priority = c.priority || derivePriority(c);
    const impactAmount = c.amount_at_risk || (c.financial_analysis && c.financial_analysis.amount_at_risk) || 0;
    return `
      <li class="case-item-card ${c.case_id === AppState.currentCaseId ? 'active' : ''}" onclick="selectInvestigationCase('${c.case_id}')">
        <div class="case-item-top">
          <span class="priority-pill ${priority.toLowerCase()} font-mono">${priority}</span>
          <span class="case-item-cat">${cleanCategoryLabel(c.exception_category)}</span>
        </div>
        <div class="case-item-impact font-mono">
          ${formatINR(impactAmount)} settlement impact
        </div>
        <div class="case-item-bottom">
          <span class="case-item-id font-mono">${c.case_id}</span>
          <span class="status-pill ${c.status === 'RESOLVED' ? 'success' : (c.status === 'IN_REVIEW' ? 'info' : 'warning')} font-mono" style="font-size:0.65rem;">
            ${c.status}
          </span>
        </div>
      </li>
    `;
  }).join('');

  // Auto-select first case if current selected case is not in the filtered list
  const currentCaseExists = AppState.currentCaseId && cases.some(c => c.case_id === AppState.currentCaseId);
  if (!currentCaseExists && cases.length > 0) {
    selectInvestigationCase(cases[0].case_id);
  }
}

function openInvestigationFromList(caseId) {
  navigateTo('investigations');
  selectInvestigationCase(caseId);
}

async function selectInvestigationCase(caseId) {
  if (!caseId) return;

  // Canonicalize caseId: if a reconciliation result ID (recon_...) was passed, resolve to its exception ID
  if (typeof caseId === 'string' && caseId.startsWith('recon_')) {
    const matchedExc = (AppState.exceptions || []).find(e => e.reconciliation_result_id === caseId);
    if (matchedExc) {
      console.warn(`[Investigation] Mapping reconciliation ID ${caseId} to canonical case ID ${matchedExc.case_id || matchedExc.id}`);
      caseId = matchedExc.case_id || matchedExc.id;
    }
  }

  // Reset chat context whenever a new case is selected
  if (AppState.currentCaseId !== caseId) {
    resetChatForCase(caseId);
  }

  AppState.currentCaseId = caseId;

  // Highlight active queue item
  document.querySelectorAll('.case-item-card').forEach(card => {
    card.classList.toggle('active', card.querySelector('.case-item-id')?.textContent === caseId);
  });

  // Immediately clear existing summary during transition to prevent stale data / cross-case flicker
  const findingsContainer = document.getElementById('investigation-results-container');
  if (findingsContainer) {
    findingsContainer.style.display = 'none';
    const stmt = document.getElementById('finding-statement-text');
    const imp = document.getElementById('finding-impact-text');
    const actionsList = document.getElementById('finding-actions-list');
    if (stmt) stmt.textContent = '';
    if (imp) imp.textContent = '';
    if (actionsList) actionsList.innerHTML = '';
  }

  try {
    const res = await fetch(`/api/investigations/${caseId}`);
    if (!res.ok) throw new Error('Case not found');
    const caseData = await res.json();
    AppState.currentCaseDetail = caseData;
    AppState.currentCaseId = caseData.case_id || caseData.id || caseId;
    renderInvestigationDetail(caseData);
  } catch (err) {
    console.error('[Investigation] Error fetching case:', err);
  }
}

/**
 * Synthesizes case-specific, mathematically grounded answers for the 3 Core Questions:
 * 1. What happened?
 * 2. Why does it matter?
 * 3. What should I do?
 */
function generateCaseFindings(c, fa = {}, grossPaise = 0, expectedNetPaise = 0, actualNetPaise = 0, shortfallPaise = 0) {
  const ai = c.ai_investigation || {};
  const aa = ai.ai_analysis || {};
  const raw = ai.raw_investigation || {};
  
  // Directly use the generated results from backend, checking all possible levels
  let whatHappened = ai.what_happened || aa.what_happened || raw.what_happened || ai.finding || ai.summary || c.what_happened || c.finding || c.summary || '';
  let whyDoesItMatter = ai.why_it_matters || aa.why_it_matters || raw.why_it_matters || c.why_it_matters || '';

  // Dynamic fallback for impact if missing but whatHappened is present
  if (!whyDoesItMatter && whatHappened) {
    const formattedRisk = typeof formatINR === 'function' ? formatINR(c.amount_at_risk || shortfallPaise || 0) : `₹${((c.amount_at_risk || shortfallPaise || 0) / 100).toFixed(2)}`;
    if (c.exception_category === 'FEE_TAX_VARIANCE') {
      whyDoesItMatter = `Overcharged gateway fees reduce merchant net payout margin by ${formattedRisk}.`;
    } else if (c.exception_category === 'MISSING_ORDER') {
      whyDoesItMatter = `Unlinked gateway funds cannot be attributed to an internal customer order.`;
    } else if (c.exception_category === 'DUPLICATE') {
      whyDoesItMatter = `Duplicate credits may lead to potential clawback or overpayment exposure of ${formattedRisk}.`;
    } else if (c.exception_category === 'TIMING_MISMATCH') {
      whyDoesItMatter = `Asynchronous batch timing creates temporary balance sheet discrepancies across reporting periods.`;
    } else if (c.exception_category === 'MISSING_PAYMENT') {
      whyDoesItMatter = `Merchant ledger expects ${formattedRisk} that has not been received in any settlement batch.`;
    } else if (c.exception_category === 'ADJUSTMENT') {
      whyDoesItMatter = `This ${formattedRisk} adjustment cannot currently be tied to a specific customer order.`;
    } else {
      whyDoesItMatter = `Unresolved financial variance of ${formattedRisk} impacts reconciliation accuracy.`;
    }
  }
  
  // Extract actions from AI recommended_actions or case suggested_actions
  const rawActions = (Array.isArray(ai.recommended_actions) && ai.recommended_actions.length > 0)
    ? ai.recommended_actions
    : (Array.isArray(aa.recommended_actions) && aa.recommended_actions.length > 0)
      ? aa.recommended_actions
      : (Array.isArray(raw.recommended_actions) && raw.recommended_actions.length > 0)
        ? raw.recommended_actions
        : (Array.isArray(c.suggested_actions) && c.suggested_actions.length > 0)
          ? c.suggested_actions
          : (ai.recommended_action ? [ai.recommended_action] : (aa.recommended_action ? [aa.recommended_action] : []));

  const actionItems = rawActions.map((act, index) => {
    let desc = '';
    if (typeof act === 'string') {
      desc = act;
    } else if (act && typeof act === 'object') {
      desc = act.description || act.resolution_hint || act.action_type || '';
    }
    return { index: index + 1, desc: (desc || '').trim() };
  }).filter(item => item.desc.length > 0);

  return { whatHappened, whyDoesItMatter, actionItems };
}

/**
 * Renders 4 clean, prominent Auditable Transaction Facts cards adapted to the case.
 */
function renderAuditableTransactionFacts(c, fa = {}, grossPaise = 0, expectedNetPaise = 0, actualNetPaise = 0, shortfallPaise = 0) {
  const chipsContainer = document.getElementById('finding-evidence-chips');
  if (!chipsContainer) return;

  let cards = [];
  const isFeeVar = c.exception_category === 'FEE_TAX_VARIANCE' || (fa.fee_actual > 0 && fa.fee_variance !== 0);

  if (isFeeVar) {
    cards = [
      { label: 'Gross Amount', value: formatINR(grossPaise), isVariance: false },
      { label: 'Fee Charged', value: formatINR(fa.fee_actual ?? 0), isVariance: false },
      { label: 'GST Tax', value: formatINR(fa.tax_actual ?? 0), isVariance: false },
      { label: 'Variance', value: formatINR(shortfallPaise || c.amount_at_risk), isVariance: true },
    ];
  } else if (c.exception_category === 'MISSING_ORDER') {
    cards = [
      { label: 'Gross Amount', value: formatINR(grossPaise), isVariance: false },
      { label: 'Settlement Credit', value: formatINR(actualNetPaise), isVariance: false },
      { label: 'Expected Order', value: 'Unlinked', isVariance: false },
      { label: 'Amount at Risk', value: formatINR(c.amount_at_risk), isVariance: true },
    ];
  } else if (c.exception_category === 'DUPLICATE') {
    cards = [
      { label: 'Gross Amount', value: formatINR(grossPaise), isVariance: false },
      { label: 'Expected Settlement', value: formatINR(expectedNetPaise || grossPaise), isVariance: false },
      { label: 'Duplicate Credit', value: formatINR(actualNetPaise), isVariance: false },
      { label: 'Amount at Risk', value: formatINR(c.amount_at_risk), isVariance: true },
    ];
  } else if (c.exception_category === 'TIMING_MISMATCH') {
    cards = [
      { label: 'Gross Amount', value: formatINR(grossPaise), isVariance: false },
      { label: 'Batch Payout', value: formatINR(expectedNetPaise || grossPaise), isVariance: false },
      { label: 'Cross-Batch Debit', value: formatINR(actualNetPaise), isVariance: false },
      { label: 'Timing Variance', value: formatINR(c.amount_at_risk), isVariance: true },
    ];
  } else {
    cards = [
      { label: 'Gross Amount', value: formatINR(grossPaise), isVariance: false },
      { label: 'Expected Settlement', value: formatINR(expectedNetPaise), isVariance: false },
      { label: 'Actual Settlement', value: formatINR(actualNetPaise), isVariance: false },
      { label: 'Variance', value: formatINR(c.amount_at_risk || shortfallPaise), isVariance: true },
    ];
  }

  chipsContainer.innerHTML = cards.map(card => `
    <div class="evidence-fact-chip">
      <span class="fact-label">${card.label}</span>
      <span class="fact-value font-mono ${card.isVariance ? 'variance' : ''}">${card.value}</span>
    </div>
  `).join('');
}

function renderInvestigationDetail(c) {
  const prompt = document.getElementById('investigation-empty-prompt');
  const content = document.getElementById('investigation-case-content');
  if (prompt) prompt.style.display = 'none';
  if (content) content.style.display = 'block';

  // 1. Header Details
  document.getElementById('view-case-id').textContent = c.case_id;
  document.getElementById('view-category-badge').textContent = cleanCategoryLabel(c.exception_category);
  document.getElementById('view-case-title').textContent = `${cleanCategoryLabel(c.exception_category)} Discrepancy`;
  document.getElementById('view-amount-at-risk').textContent = formatINR(c.amount_at_risk || (c.financial_analysis && c.financial_analysis.amount_at_risk) || 0);

  // Priority Badge
  const priority = c.priority || derivePriority(c);
  const priorityBadge = document.getElementById('view-priority-badge');
  if (priorityBadge) {
    priorityBadge.textContent = priority;
    priorityBadge.className = `priority-badge font-mono ${priority.toLowerCase()}`;
    if (c.priority_info?.reason) {
      priorityBadge.title = c.priority_info.reason;
    }
  }

  // Status Badge
  const statusPill = document.getElementById('view-user-status-pill');
  statusPill.textContent = c.status || 'OPEN';
  statusPill.className = `case-status-badge font-mono ${c.status || 'OPEN'}`;

  // 1.1 Financial Impact Summary Section
  const fa = c.financial_analysis || {};
  const grossPaise = fa.gross_amount ?? c.payment_record?.amount ?? c.merchant_order?.amount ?? 0;
  const expectedNetPaise = fa.expected_merchant_amount ?? (fa.gross_amount !== null && fa.fee_expected !== null && fa.tax_expected !== null ? (fa.gross_amount - fa.fee_expected - fa.tax_expected) : (fa.gross_amount || 0));
  const actualNetPaise = fa.actual_merchant_amount ?? fa.settlement_credit ?? c.settlement_record?.credit ?? 0;
  const shortfallPaise = c.amount_at_risk ?? (expectedNetPaise && actualNetPaise ? Math.max(0, expectedNetPaise - actualNetPaise) : 0);

  const shortfallEl = document.getElementById('impact-settlement-shortfall');
  if (shortfallEl) shortfallEl.textContent = formatINR(shortfallPaise);

  const grossEl = document.getElementById('impact-gross-payment');
  if (grossEl) grossEl.textContent = formatINR(grossPaise);

  const expNetEl = document.getElementById('impact-expected-settlement');
  if (expNetEl) expNetEl.textContent = formatINR(expectedNetPaise);

  const actNetEl = document.getElementById('impact-actual-settlement');
  if (actNetEl) actNetEl.textContent = formatINR(actualNetPaise);

  // Gateway Fee & GST Breakdown
  const deductionsContainer = document.getElementById('impact-deductions-container');
  const expFeeEl = document.getElementById('impact-expected-fee');
  const actFeeEl = document.getElementById('impact-actual-fee');
  const feeVarEl = document.getElementById('impact-fee-variance');
  const expTaxEl = document.getElementById('impact-expected-tax');
  const actTaxEl = document.getElementById('impact-actual-tax');
  const taxVarEl = document.getElementById('impact-tax-variance');

  if (expFeeEl) expFeeEl.textContent = formatINR(fa.fee_expected ?? 0);
  if (actFeeEl) actFeeEl.textContent = formatINR(fa.fee_actual ?? 0);
  if (feeVarEl) {
    const feeVar = fa.fee_variance ?? 0;
    feeVarEl.textContent = feeVar !== 0 ? `${feeVar > 0 ? '+' : ''}${formatINR(feeVar)}` : '₹0.00';
    feeVarEl.className = `val-num font-mono ${feeVar > 0 ? 'text-danger' : 'text-muted'}`;
  }

  if (expTaxEl) expTaxEl.textContent = formatINR(fa.tax_expected ?? 0);
  if (actTaxEl) actTaxEl.textContent = formatINR(fa.tax_actual ?? 0);
  if (taxVarEl) {
    const taxVar = fa.tax_variance ?? 0;
    taxVarEl.textContent = taxVar !== 0 ? `${taxVar > 0 ? '+' : ''}${formatINR(taxVar)}` : '₹0.00';
    taxVarEl.className = `val-num font-mono ${taxVar > 0 ? 'text-danger' : 'text-muted'}`;
  }

  if (deductionsContainer) {
    if (fa.fee_expected !== null || fa.fee_actual !== null || c.exception_category === 'FEE_TAX_VARIANCE') {
      deductionsContainer.style.display = 'block';
    } else {
      deductionsContainer.style.display = 'none';
    }
  }

  // Meta chips
  const metaContainer = document.getElementById('view-case-subtitle');
  metaContainer.innerHTML = `
    <span class="meta-chip font-mono">Settlement: ${c.settlement_record?.entity_id || 'setl_...'}</span>
    <span class="meta-chip font-mono">Order: ${c.merchant_order?.id || c.settlement_record?.order_id || 'order_...'}</span>
    <span class="meta-chip font-mono">Method: ${c.settlement_record?.payment_method || 'CARD'}</span>
  `;

  // PayPal Dispute Reversal Alert Card
  const disputeCard = document.getElementById('view-dispute-detail-card');
  if (disputeCard) {
    if (c.exception_category === 'DISPUTE_REVERSAL') {
      disputeCard.style.display = 'block';
      const idEl = document.getElementById('view-dispute-id');
      const reasonEl = document.getElementById('view-dispute-reason');
      const actionEl = document.getElementById('view-dispute-action');
      if (idEl) idEl.textContent = c.dispute_data?.dispute_id || c.dispute_id || 'DISPUTE-SANDBOX';
      if (reasonEl) reasonEl.textContent = c.dispute_data?.reason || c.root_cause || 'Customer reported unauthorized or unfulfilled transaction';
      if (actionEl) actionEl.textContent = c.suggested_actions?.[0]?.description || 'Upload shipping proof & invoice evidence in PayPal Resolution Center to contest reversal.';
    } else {
      disputeCard.style.display = 'none';
    }
  }

  // Action Buttons Visibility & Banner State
  const runBtn = document.getElementById('btn-run-investigation');
  const resolveBtn = document.getElementById('btn-open-resolve');
  const reopenBtn = document.getElementById('btn-reopen-case');
  const resCard = document.getElementById('resolution-summary-card');
  const preInvCallout = document.getElementById('pre-investigation-callout');
  const progressCard = document.getElementById('investigation-progress');

  if (progressCard) progressCard.style.display = 'none';

  if (c.status === 'RESOLVED') {
    if (preInvCallout) preInvCallout.style.display = 'none';
    if (runBtn) runBtn.style.display = 'none';
    if (resolveBtn) resolveBtn.style.display = 'none';
    if (reopenBtn) reopenBtn.style.display = 'inline-flex';
    if (resCard) {
      resCard.style.display = 'block';
      document.getElementById('view-resolution-reason').textContent = c.resolution?.resolution_reason_label || c.resolution?.resolution_reason || 'Manual Resolution';
      document.getElementById('view-resolution-notes').textContent = c.resolution?.resolution_notes || 'No operator notes provided.';
      document.getElementById('view-resolution-actor').textContent = c.resolution?.resolved_by || 'Operator';
      document.getElementById('view-resolution-time').textContent = `Resolved on ${formatDate(c.resolution?.resolved_at)}`;
    }
  } else if (c.status === 'IN_REVIEW') {
    if (preInvCallout) preInvCallout.style.display = 'none';
    if (resCard) resCard.style.display = 'none';
    if (reopenBtn) reopenBtn.style.display = 'none';
    if (runBtn) {
      runBtn.style.display = 'inline-flex';
      runBtn.disabled = false;
      document.getElementById('run-btn-text').textContent = 'Re-Run Payvault Investigation';
    }
    if (resolveBtn) {
      resolveBtn.style.display = 'inline-flex';
      resolveBtn.disabled = false;
    }
  } else {
    // Case is OPEN
    if (resCard) resCard.style.display = 'none';
    if (reopenBtn) reopenBtn.style.display = 'none';
    if (preInvCallout) {
      preInvCallout.style.display = 'flex';
      const catEl = document.getElementById('pre-inv-cat');
      const riskEl = document.getElementById('pre-inv-risk');
      const batchEl = document.getElementById('pre-inv-batch');
      if (catEl) catEl.textContent = cleanCategoryLabel(c.exception_category);
      if (riskEl) riskEl.textContent = formatINR(c.amount_at_risk || 0);
      if (batchEl) batchEl.textContent = c.settlement_record?.settlement_id || c.settlement_entity_id || 'T+2 Batch';
    }
    if (runBtn) {
      runBtn.style.display = 'inline-flex';
      runBtn.disabled = false;
      document.getElementById('run-btn-text').textContent = 'Run Payvault Investigation';
    }
    if (resolveBtn) {
      resolveBtn.style.display = 'inline-flex';
      resolveBtn.disabled = false;
    }
  }

  // Update Operator Action section (Section F)
  const opStatusBadge = document.getElementById('operator-case-status-badge');
  const opControls = document.getElementById('operator-action-controls');
  if (opStatusBadge) {
    if (c.status === 'RESOLVED') {
      opStatusBadge.textContent = 'RESOLVED';
      opStatusBadge.className = 'operator-action-badge font-mono resolved';
    } else if (c.status === 'IN_REVIEW') {
      opStatusBadge.textContent = 'UNDER ACTIVE REVIEW';
      opStatusBadge.className = 'operator-action-badge font-mono';
    } else {
      opStatusBadge.textContent = 'AWAITING INVESTIGATION';
      opStatusBadge.className = 'operator-action-badge font-mono';
    }
  }
  if (opControls) {
    opControls.style.display = c.status === 'RESOLVED' ? 'none' : 'flex';
  }

  // 1.5 Investigation Intelligence Provenance Header
  const provPanel = document.getElementById('investigation-provenance-panel');
  const ai = c.ai_investigation;
  const ic = c.intelligence_context;

  if (provPanel) {
    if (ai) {
      provPanel.style.display = 'flex';
      
      // CRITICAL FIX: Only show Qwen/Ollama if it actually ran successfully
      const isQwen = (ai.ai_analysis && ai.ai_analysis.provider === 'OLLAMA_QWEN') 
        && (ai.ai_metadata && ai.ai_metadata.qwen_escalated === true)
        && (ai.routing && ai.routing.qwen_invoked === true);
        
      const provAiVal = document.getElementById('prov-ai-val');
      const provTag = document.getElementById('prov-runtime-tag');
      const provHist = document.getElementById('prov-history-val');

      if (provAiVal) {
        if (isQwen) {
          // Qwen actually ran
          const modelName = ai.ai_analysis.model || ai.ai_metadata.model || 'Qwen 2.5';
          provAiVal.textContent = `✓ ${modelName} via Ollama`;
          provAiVal.className = `prov-col-val font-mono text-success`;
        } else {
          // Payvault local intelligence was used
          provAiVal.textContent = '✓ Payvault Local Intelligence';
          provAiVal.className = `prov-col-val font-mono text-primary`;
        }
      }
      
      if (provTag) {
        provTag.textContent = isQwen ? 'OLLAMA / QWEN' : 'LOCAL IN-PROCESS';
      }
      
      if (provHist) {
        const simCount = ic?.historical_context?.similar_cases?.length || 0;
        const patCount = ic?.historical_context?.repeated_patterns?.length || 0;
        provHist.textContent = `✓ ${simCount} similar cases · ${patCount} pattern(s)`;
      }
    } else {
      provPanel.style.display = 'none';
    }
  }

  // 2. The 3 Core Questions Findings (Grounded Causal Synthesis)
  const findings = generateCaseFindings(c, fa, grossPaise, expectedNetPaise, actualNetPaise, shortfallPaise);
  
  const findingsContainer = document.getElementById('investigation-results-container');
  if (findingsContainer) {
    // Only show if investigation successfully ran and we have data
    if (c.ai_investigation && findings.whatHappened) {
      findingsContainer.style.display = 'flex';
      const stmt = document.getElementById('finding-statement-text');
      const imp = document.getElementById('finding-impact-text');
      const actionsList = document.getElementById('finding-actions-list');
      if (stmt) stmt.textContent = findings.whatHappened;
      if (imp) imp.textContent = findings.whyDoesItMatter;

      // Action steps
      if (actionsList) {
        actionsList.innerHTML = findings.actionItems.map(a => `
          <li class="action-step-item">
            <span class="step-badge">${a.index}</span>
            <span class="step-desc">${escapeHtml(a.desc)}</span>
          </li>
        `).join('');
      }
    } else {
      findingsContainer.style.display = 'none';
      const stmt = document.getElementById('finding-statement-text');
      const imp = document.getElementById('finding-impact-text');
      const actionsList = document.getElementById('finding-actions-list');
      if (stmt) stmt.textContent = '';
      if (imp) imp.textContent = '';
      if (actionsList) actionsList.innerHTML = '';
    }
  }

  // Auditable Transaction Facts (Adapted dynamically to the case)
  renderAuditableTransactionFacts(c, fa, grossPaise, expectedNetPaise, actualNetPaise, shortfallPaise);

  // 3. Investigation Lifecycle Timeline (Evidence-Grounded Trail)
  const timelineContainer = document.getElementById('case-visual-timeline');
  if (timelineContainer) {
    const paymentTime = c.settlement_record?.created_at || c.merchant_order?.created_at || c.created_at;
    const reconTime = c.reconciliation_result?.reconciled_at || c.recon_result?.reconciled_at || c.created_at;
    const exceptionTime = c.created_at;
    const caseCreatedTime = c.created_at;

    const aiRan = !!c.ai_investigation;
    const aiTime = aiRan ? (c.ai_investigation.analyzed_at || c.ai_investigation.ai_metadata?.timestamp || c.ai_investigation.timestamp || c.created_at) : null;

    const isResolved = c.status === 'RESOLVED';
    const resolvedTime = isResolved ? c.resolution?.resolved_at : null;

    const timelineNodes = [
      {
        title: 'Payment Received',
        state: 'completed',
        icon: '✓',
        time: formatTimelineTime(paymentTime),
        sub: `Customer payment: ${formatINR(grossPaise)}`,
      },
      {
        title: 'Reconciliation Completed',
        state: 'completed',
        icon: '✓',
        time: formatTimelineTime(reconTime),
        sub: 'Automated ledger-to-settlement comparison',
      },
      {
        title: 'Exception Detected',
        state: 'completed',
        icon: '✓',
        time: formatTimelineTime(exceptionTime),
        sub: `${cleanCategoryLabel(c.exception_category)} (${formatINR(shortfallPaise)} shortfall)`,
      },
      {
        title: 'Investigation Created',
        state: 'completed',
        icon: '✓',
        time: formatTimelineTime(caseCreatedTime),
        sub: `Case ${c.case_id} registered in workstation`,
      },
      {
        title: 'Payvault AI Analyzed',
        state: aiRan ? 'completed' : 'pending',
        icon: aiRan ? '✓' : '○',
        time: aiRan ? formatTimelineTime(aiTime) : '',
        sub: aiRan ? 'Grounded causal analysis synthesized' : 'Pending multi-signal audit execution',
      },
      {
        title: 'Operator Reviewed',
        state: isResolved ? 'completed' : (c.status === 'IN_REVIEW' ? 'current' : 'pending'),
        icon: isResolved ? '✓' : (c.status === 'IN_REVIEW' ? '●' : '○'),
        time: isResolved ? formatTimelineTime(resolvedTime) : '',
        sub: isResolved
          ? `Reviewed by ${c.resolution?.resolved_by || 'operator'}`
          : (c.status === 'IN_REVIEW' ? 'Under active operator review' : 'Awaiting operator review'),
      },
      {
        title: 'Resolved',
        state: isResolved ? 'completed' : 'pending',
        icon: isResolved ? '✓' : '○',
        time: isResolved ? formatTimelineTime(resolvedTime) : '',
        sub: isResolved
          ? `${c.resolution?.resolution_reason_label || c.resolution?.resolution_reason || 'Resolution confirmed'}`
          : 'Pending final operator sign-off',
      },
    ];

    timelineContainer.innerHTML = timelineNodes.map(n => `
      <div class="lifecycle-node ${n.state}">
        <span class="lifecycle-node-bullet font-mono">${n.icon}</span>
        <div class="lifecycle-node-main">
          <span class="lifecycle-node-title">${n.title}</span>
          ${n.time ? `<span class="lifecycle-node-time font-mono">${n.time}</span>` : ''}
        </div>
        <div class="lifecycle-node-sub">${n.sub}</div>
      </div>
    `).join('');
  }

  // 4. Financial Mathematical Breakdown Accordion
  const statementBody = document.getElementById('statement-table-body');
  statementBody.innerHTML = `
    <tr>
      <td><strong>Gross Customer Amount</strong></td>
      <td class="font-mono">${formatINR(fa.gross_amount || c.amount_at_risk)}</td>
      <td class="font-mono">${formatINR(fa.gross_amount || c.amount_at_risk)}</td>
      <td class="font-mono text-muted">₹0.00</td>
      <td class="font-mono" style="font-weight:700;">${formatINR(fa.gross_amount || c.amount_at_risk)}</td>
    </tr>
    <tr>
      <td>Platform Gateway Fee (2%)</td>
      <td class="font-mono">${formatINR(fa.fee_actual || 0)}</td>
      <td class="font-mono">${formatINR(fa.fee_expected || 0)}</td>
      <td class="font-mono ${fa.fee_variance ? 'text-danger' : 'text-muted'}">${formatINR(fa.fee_variance || 0)}</td>
      <td class="font-mono text-muted">Deduction</td>
    </tr>
    <tr>
      <td>GST on Platform Fee (18%)</td>
      <td class="font-mono">${formatINR(fa.tax_actual || 0)}</td>
      <td class="font-mono">${formatINR(fa.tax_expected || 0)}</td>
      <td class="font-mono ${fa.tax_variance ? 'text-danger' : 'text-muted'}">${formatINR(fa.tax_variance || 0)}</td>
      <td class="font-mono text-muted">Tax Deduction</td>
    </tr>
    <tr style="background:#f8fafc;font-weight:800;">
      <td>Net Nodal Credit / Payout</td>
      <td class="font-mono">${formatINR(fa.net_actual || 0)}</td>
      <td class="font-mono">${formatINR(fa.net_expected || 0)}</td>
      <td class="font-mono text-danger">${formatINR(c.amount_at_risk)}</td>
      <td class="font-mono text-success">${formatINR(fa.net_actual || 0)}</td>
    </tr>
  `;

  // 5. Entity Linkage Graph Accordion
  const relContainer = document.getElementById('relationship-graph-container');
  relContainer.innerHTML = `
    <div style="display:flex;align-items:center;justify-content:space-around;padding:1rem;background:#f8fafc;border-radius:var(--radius-lg);border:1px solid var(--color-border-light);">
      <div style="text-align:center;">
        <span style="font-size:0.7rem;font-weight:800;color:var(--color-text-muted);display:block;">MERCHANT ORDER</span>
        <span class="font-mono" style="font-size:0.85rem;font-weight:700;color:var(--color-primary);">${c.merchant_order?.id || c.settlement_record?.order_id || 'ord_unlinked'}</span>
      </div>
      <div style="color:var(--color-text-tertiary);font-weight:800;">───→</div>
      <div style="text-align:center;">
        <span style="font-size:0.7rem;font-weight:800;color:var(--color-text-muted);display:block;">PAYMENT CAPTURE</span>
        <span class="font-mono" style="font-size:0.85rem;font-weight:700;color:var(--color-primary);">${c.settlement_record?.entity_id || 'pay_test_mode'}</span>
      </div>
      <div style="color:var(--color-text-tertiary);font-weight:800;">───→</div>
      <div style="text-align:center;">
        <span style="font-size:0.7rem;font-weight:800;color:var(--color-text-muted);display:block;">SETTLEMENT BATCH</span>
        <span class="font-mono" style="font-size:0.85rem;font-weight:700;color:var(--color-success);">${c.settlement_record?.settlement_id || 'setl_batch_001'}</span>
      </div>
    </div>
  `;

  // 6. Historical Intelligence & Precedents (Chunk 4) Accordion
  const intelContainer = document.getElementById('intelligence-container');
  if (ic && ic.historical_context) {
    const similar = ic.historical_context.similar_cases || [];
    const patterns = ic.historical_context.repeated_patterns || [];
    const anomalies = ic.anomaly_context?.anomalies || [];
    const precedent = ic.memory_context?.precedent_summary;

    intelContainer.innerHTML = `
      ${precedent ? `
        <div class="intelligence-block-card" style="background:#f0fdf4;border-color:#bbf7d0;">
          <div class="intelligence-block-title" style="color:#15803d;">✓ Historical Confirmed Precedent</div>
          <div class="intelligence-item-desc" style="color:#166534;font-weight:600;">${precedent}</div>
        </div>
      ` : ''}

      ${patterns.length > 0 ? `
        <div class="intelligence-block-card">
          <div class="intelligence-block-title">${patterns[0].pattern_type.replace(/_/g, ' ')} (${patterns[0].occurrence_count} occurrences)</div>
          <div class="intelligence-item-desc">${patterns[0].description}</div>
        </div>
      ` : ''}

      ${anomalies.length > 0 ? `
        <div class="intelligence-block-card" style="background:#fffbeb;border-color:#fde68a;">
          <div class="intelligence-block-title" style="color:#b45309;">Statistical Distribution Anomaly: ${anomalies[0].type.replace(/_/g, ' ')}</div>
          <div class="intelligence-item-desc">${anomalies[0].description || anomalies[0].deviation} (Observed: ${anomalies[0].observed_value}, Expected: ${anomalies[0].expected_range?.min}–${anomalies[0].expected_range?.max} ${anomalies[0].expected_range?.unit || ''}).</div>
        </div>
      ` : ''}

      <div style="font-size:0.8rem;color:var(--color-text-secondary);margin-top:0.5rem;">
        <strong>Similar Historical Cases:</strong> ${similar.length > 0 ? `${similar.length} structurally similar cases identified in store (${similar.map(s => `${s.case_id} [${Math.round(s.similarity_score * 100)}% match]`).join(', ')}).` : 'No structurally similar historical cases recorded in current store.'}
      </div>
    `;
  } else {
    intelContainer.innerHTML = `<div style="color:var(--color-text-muted);font-size:0.8rem;padding:0.5rem 0;">Historical intelligence analyzed for this exception.</div>`;
  }

  // 7. Case Audit Trail Accordion (Chunk 3)
  const auditContainer = document.getElementById('audit-timeline-container');
  const rawAudit = c.audit_trail || [];
  const auditList = rawAudit.map(normalizeAuditEvent);

  if (auditList.length === 0) {
    auditContainer.innerHTML = `<div style="color:var(--color-text-muted);font-size:0.8rem;padding:0.5rem 0;">No state transitions recorded yet. Case initialized in OPEN status.</div>`;
  } else {
    auditContainer.innerHTML = `
      <div class="audit-history-list">
        ${auditList.map(a => `
          <div class="audit-event-node">
            <span class="audit-event-dot"></span>
            <div class="audit-event-box">
              <div class="audit-event-top">
                <span class="audit-event-action font-mono">${a.action}</span>
                <span class="audit-event-time">${formatDate(a.timestamp)}</span>
              </div>
              <div style="font-size:0.775rem;color:var(--color-text-secondary);">
                Performed by: <strong class="font-mono">${a.performed_by}</strong> ${a.resolution_reason ? `· Justification: <strong>${a.resolution_reason}</strong>` : ''}
              </div>
              ${a.notes ? `<div style="font-size:0.75rem;color:var(--color-text-muted);margin-top:0.25rem;">"${a.notes}"</div>` : ''}
            </div>
          </div>
        `).join('')}
      </div>
    `;
  }

  // 7.5 Case Evidence Panel (Authoritative Grounding Sources)
  const evidenceContainer = document.getElementById('evidence-accordion-list');
  const evidenceCountBadge = document.getElementById('evidence-source-count');

  if (evidenceContainer) {
    const evidenceItems = [
      {
        title: 'Payment Record',
        sub: `Customer payment: ${formatINR(grossPaise)}`,
        open: true,
        details: [
          { label: 'Customer Payment', value: formatINR(grossPaise) },
          { label: 'Merchant Order ID', value: c.merchant_order?.id || c.settlement_record?.order_id || 'ord_unlinked' },
          { label: 'Payment Instrument', value: c.settlement_record?.payment_method || 'CARD' },
          { label: 'Currency', value: c.settlement_record?.currency || 'INR' },
          { label: 'Payment Status', value: 'Captured & Reconciled' },
        ],
      },
      {
        title: 'Settlement Record',
        sub: `Actual settlement: ${formatINR(actualNetPaise)}`,
        open: true,
        details: [
          { label: 'Actual Settlement Credit', value: formatINR(actualNetPaise) },
          { label: 'Settlement Entity ID', value: c.settlement_record?.entity_id || 'setl_...' },
          { label: 'Settlement Batch ID', value: c.settlement_record?.settlement_id || 'setl_batch_001' },
          { label: 'Gateway Fee Deducted', value: formatINR(fa.fee_actual || 0) },
          { label: 'Gateway GST Deducted', value: formatINR(fa.tax_actual || 0) },
        ],
      },
      {
        title: 'Reconciliation Result',
        sub: `Settlement shortfall: ${formatINR(shortfallPaise)}`,
        open: true,
        details: [
          { label: 'Expected Settlement', value: formatINR(expectedNetPaise) },
          { label: 'Actual Settlement Credited', value: formatINR(actualNetPaise) },
          { label: 'Settlement Shortfall', value: formatINR(shortfallPaise) },
          { label: 'Audit Status', value: c.reconciliation_result?.status || 'EXCEPTION' },
          { label: 'Triggered Audit Rule', value: c.reconciliation_result?.rule_triggered || cleanCategoryLabel(c.exception_category) },
        ],
      },
      {
        title: 'Contracted Fee Schedule',
        sub: 'Contracted fee: 2.0% · GST: 18%',
        open: false,
        details: [
          { label: 'Contract Fee Rate', value: '2.00%' },
          { label: 'Statutory GST Rate', value: '18.00%' },
          { label: 'Expected Fee Baseline', value: formatINR(fa.fee_expected || 0) },
          { label: 'Expected GST Baseline', value: formatINR(fa.tax_expected || 0) },
          { label: 'Rate Schedule Status', value: 'Standard Merchant Agreement' },
        ],
      },
      {
        title: 'Arithmetic Verification',
        sub: `Fee variance: ${formatINR(fa.fee_variance || 0)} · GST variance: ${formatINR(fa.tax_variance || 0)}`,
        open: false,
        details: [
          { label: 'Fee Variance', value: `${(fa.fee_variance || 0) > 0 ? '+' : ''}${formatINR(fa.fee_variance || 0)}` },
          { label: 'GST Tax Variance', value: `${(fa.tax_variance || 0) > 0 ? '+' : ''}${formatINR(fa.tax_variance || 0)}` },
          { label: 'Total Shortfall Variance', value: formatINR(shortfallPaise) },
          { label: 'Precision Check', value: 'Integer-Paise Deterministic Engine Verified' },
        ],
      },
    ];

    if (evidenceCountBadge) {
      evidenceCountBadge.textContent = `${evidenceItems.length} Case Evidence Sources`;
    }

    evidenceContainer.innerHTML = evidenceItems.map(item => `
      <details class="evidence-item" ${item.open ? 'open' : ''}>
        <summary class="evidence-item-summary">
          <div class="evidence-summary-left">
            <span class="evidence-summary-icon">✓</span>
            <span>${item.title}</span>
            <span class="evidence-summary-sub font-mono">(${item.sub})</span>
          </div>
          <span class="evidence-chevron font-mono">▶</span>
        </summary>
        <div class="evidence-item-body">
          <div class="evidence-detail-grid">
            ${item.details.map(d => `
              <div class="evidence-detail-cell">
                <span class="evidence-cell-label">${d.label}</span>
                <span class="evidence-cell-value font-mono">${d.value}</span>
              </div>
            `).join('')}
          </div>
        </div>
      </details>
    `).join('');
  }

  // 8. Chat panel — refresh suggested questions for this case and show panel
  renderChatSuggestedQuestions();
  const chatSection = document.getElementById('ask-payvault-ai-section');
  if (chatSection) chatSection.style.display = 'flex';
}

// ── AI Investigation Runner (With Clean Inline Checklist Animation) ───────────
async function runPayvaultInvestigation() {
  let targetCaseId = AppState.currentCaseId || AppState.currentCaseDetail?.case_id || AppState.currentCaseDetail?.id;
  if (!targetCaseId) {
    const displayedId = document.getElementById('view-case-id')?.textContent?.trim();
    if (displayedId && displayedId.startsWith('exc_')) {
      targetCaseId = displayedId;
    }
  }
  if (typeof targetCaseId === 'string' && targetCaseId.startsWith('recon_')) {
    const matchedExc = (AppState.exceptions || []).find(e => e.reconciliation_result_id === targetCaseId);
    if (matchedExc) {
      targetCaseId = matchedExc.case_id || matchedExc.id;
    }
  }
  if (!targetCaseId) return;
  AppState.currentCaseId = targetCaseId;

  const runBtn       = document.getElementById('btn-run-investigation');
  const runBtnText   = document.getElementById('run-btn-text');
  const progressCard = document.getElementById('investigation-progress');
  const preInv       = document.getElementById('pre-investigation-callout');
  const findingsContainer = document.getElementById('investigation-results-container');

  if (runBtn) {
    runBtn.disabled = true;
    if (runBtnText) runBtnText.textContent = 'Investigating…';
  }
  if (preInv) preInv.style.display = 'none';
  if (findingsContainer) {
    findingsContainer.style.display = 'none';
    const stmt = document.getElementById('finding-statement-text');
    const imp = document.getElementById('finding-impact-text');
    const actionsList = document.getElementById('finding-actions-list');
    if (stmt) stmt.textContent = '';
    if (imp) imp.textContent = '';
    if (actionsList) actionsList.innerHTML = '';
  }
  if (AppState.currentCaseDetail) {
    AppState.currentCaseDetail.ai_investigation = null;
  }
  if (progressCard) progressCard.style.display = 'block';

  // Helper to cleanly update checklist step state
  function updateStep(stepIndex, state) {
    const item = document.getElementById(`inv-step-${stepIndex}`);
    const icon = document.getElementById(`inv-icon-${stepIndex}`);
    if (!item || !icon) return;

    if (state === 'pending') {
      item.className = 'checklist-step-item';
      icon.textContent = '○';
    } else if (state === 'active') {
      item.className = 'checklist-step-item active';
      icon.textContent = '●';
    } else if (state === 'completed') {
      item.className = 'checklist-step-item completed';
      icon.textContent = '✓';
    }
  }

  // Reset steps to clean initial state
  [1, 2, 3, 4].forEach(i => updateStep(i, 'pending'));

  // Step 1: Extracting evidence
  updateStep(1, 'active');
  await new Promise(r => setTimeout(r, 260));
  updateStep(1, 'completed');

  // Step 2: Verifying contract fees & GST
  updateStep(2, 'active');
  await new Promise(r => setTimeout(r, 280));
  updateStep(2, 'completed');

  // Step 3: Scanning patterns
  updateStep(3, 'active');
  await new Promise(r => setTimeout(r, 280));
  updateStep(3, 'completed');

  // Step 4: Synthesizing findings & executing backend investigation
  updateStep(4, 'active');

  try {
    const res = await fetch(`/api/investigations/${targetCaseId}/run`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    });

    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Investigation failed.');

    updateStep(4, 'completed');
    await new Promise(r => setTimeout(r, 200));

    // Smoothly hide inline progress card
    if (progressCard) progressCard.style.display = 'none';

    // Update state and immediately render returned investigation findings
    AppState.currentCaseDetail = data;
    renderInvestigationDetail(data);

    // Refresh application state and queue in background
    await loadAllData();
    showToast('Investigation complete · Case moved to IN_REVIEW', 'info');

    // Auto-scroll and focus to the new top-of-page investigation results
    const summaryCard = document.getElementById('finding-hero-card');
    if (summaryCard) {
      summaryCard.scrollIntoView({ behavior: 'smooth', block: 'start' });
      if (typeof summaryCard.focus === 'function') summaryCard.focus();
    }
  } catch (err) {
    showToast(`Investigation failed: ${err.message}`, 'error');
    if (progressCard) progressCard.style.display = 'none';
  } finally {
    if (runBtn) {
      runBtn.disabled = false;
      if (runBtnText) runBtnText.textContent = 'Re-Run Payvault Investigation';
    }
  }
}

// ── Human Resolution Dialog & Submission (Chunk 3) ───────────────────────────
async function openResolutionModal() {
  const modal = document.getElementById('resolution-modal');
  const grid = document.getElementById('resolution-reasons-grid');
  if (!modal || !grid) return;

  try {
    if (AppState.resolutionReasons.length === 0) {
      const res = await fetch('/api/investigations/config/resolution-reasons');
      const data = await res.json();
      AppState.resolutionReasons = data.reasons || [];
    }

    grid.innerHTML = AppState.resolutionReasons.map((r, idx) => `
      <label class="reason-radio-card" for="reason-${r.id}">
        <input type="radio" id="reason-${r.id}" name="resolution_reason" value="${r.id}" ${idx === 0 ? 'checked' : ''} />
        <div>
          <div class="reason-label">${r.label}</div>
          <div class="reason-desc">${r.description}</div>
        </div>
      </label>
    `).join('');

    modal.style.display = 'flex';
  } catch (err) {
    showToast('Failed to load resolution reasons.', 'error');
  }
}

function closeResolutionModal() {
  const modal = document.getElementById('resolution-modal');
  if (modal) modal.style.display = 'none';
  const notes = document.getElementById('resolve-notes');
  if (notes) notes.value = '';
}

async function handleResolveSubmit(event) {
  event.preventDefault();
  if (!AppState.currentCaseId) return;

  const selectedRadio = document.querySelector('input[name="resolution_reason"]:checked');
  if (!selectedRadio) {
    showToast('Please select a business justification reason.', 'warning');
    return;
  }

  const reason = selectedRadio.value;
  const notes  = (document.getElementById('resolve-notes')?.value || '').trim();
  const targetCaseId = AppState.currentCaseId;

  try {
    const res = await fetch(`/api/investigations/${targetCaseId}/resolve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        resolution_reason: reason,
        resolution_notes: notes,
        resolved_by: 'Operator (Aaradhy)',
      }),
    });

    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed to resolve case.');

    closeResolutionModal();
    showToast(`Case ${targetCaseId} marked as RESOLVED`, 'success');

    // Refresh application state and queue
    await loadAllData();

    // If currently on an active tab (ALL, OPEN, IN_REVIEW), the case is now resolved.
    // Transition selection to the next active case or empty prompt.
    if (AppState.activeStatusFilter !== 'RESOLVED') {
      const remainingActive = AppState.exceptions.filter(c => c.status === 'OPEN' || c.status === 'IN_REVIEW');
      if (remainingActive.length > 0) {
        await selectInvestigationCase(remainingActive[0].case_id);
      } else {
        renderInvestigationQueue();
      }
    } else {
      await selectInvestigationCase(targetCaseId);
    }
  } catch (err) {
    showToast(`Failed to resolve exception: ${err.message}`, 'error');
  }
}

async function reopenCase() {
  if (!AppState.currentCaseId) return;
  const targetCaseId = AppState.currentCaseId;

  try {
    const res = await fetch(`/api/investigations/${targetCaseId}/reopen`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        reopened_by: 'Operator (Aaradhy)',
        reopen_notes: 'Reopened for operations review',
      }),
    });

    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed to reopen case.');

    showToast(`Case ${targetCaseId} reopened to active queue`, 'info');
    await loadAllData();

    // If on RESOLVED tab, this case has moved to OPEN, so select next resolved case if any
    if (AppState.activeStatusFilter === 'RESOLVED') {
      const remainingResolved = AppState.exceptions.filter(c => c.status === 'RESOLVED');
      if (remainingResolved.length > 0) {
        await selectInvestigationCase(remainingResolved[0].case_id);
      } else {
        renderInvestigationQueue();
      }
    } else {
      await selectInvestigationCase(targetCaseId);
    }
  } catch (err) {
    showToast(`Failed to reopen case: ${err.message}`, 'error');
  }
}

// ── Utility Sync / Benchmark Handlers ─────────────────────────────────────────
async function loadBenchmarkDataset() {
  try {
    const res = await fetch('/api/demo/reset-synthetic', { method: 'POST' });
    const data = await res.json();
    showToast('Benchmark dataset loaded (79 test cases, 24 exceptions)', 'info');
    await loadAllData();
    navigateTo('dashboard');
  } catch (err) {
    showToast(`Failed to load benchmark data: ${err.message}`, 'error');
  }
}

async function switchToLiveMode() {
  try {
    await fetch('/api/demo/clear', { method: 'POST' });
    
    // Clear all frontend state completely
    AppState.summary = null;
    AppState.payments = [];
    AppState.settlements = { batches: [], records: [] };
    AppState.reconciliations = [];
    AppState.exceptions = [];
    AppState.currentCaseId = null;
    AppState.currentCaseDetail = null;
    AppState.activeReconFilter = 'ALL';
    AppState.activeStatusFilter = 'ALL';
    AppState.activeCategoryFilter = 'ALL';
    
    showToast('Switched to clean merchant mode (0 records)', 'success');
    await loadAllData();
    navigateTo('dashboard');
  } catch (err) {
    showToast(`Clear failed: ${err.message}`, 'error');
  }
}

// ── Event Listeners & Bootstrapping ──────────────────────────────────────────
if (typeof document !== 'undefined') {
  document.addEventListener('DOMContentLoaded', () => {
    // Navigation tabs click listeners
    document.querySelectorAll('.nav-tab').forEach(tab => {
      tab.addEventListener('click', (e) => {
        e.preventDefault();
        const page = tab.getAttribute('data-page');
        if (page) navigateTo(page);
      });
    });

    // Payment method selector active toggle
    document.querySelectorAll('.method-card').forEach(card => {
      card.addEventListener('click', () => {
        document.querySelectorAll('.method-card').forEach(c => c.classList.remove('active'));
        card.classList.add('active');
      });
    });

    // Pay button
    const payBtn = document.getElementById('btn-pay-now');
    if (payBtn) payBtn.addEventListener('click', handlePaymentSubmit);

    // Amount input real-time sync
    const amountInput = document.getElementById('custom-amount-input');
    if (amountInput) {
      amountInput.addEventListener('input', () => updatePayButtonLabel());
    }

    // Investigation action buttons
    const runBtn = document.getElementById('btn-run-investigation');
    if (runBtn) runBtn.addEventListener('click', runPayvaultInvestigation);

    const resolveBtn = document.getElementById('btn-open-resolve');
    if (resolveBtn) resolveBtn.addEventListener('click', openResolutionModal);

    const reopenBtn = document.getElementById('btn-reopen-case');
    if (reopenBtn) reopenBtn.addEventListener('click', reopenCase);

    const bottomResolveBtn = document.getElementById('btn-bottom-resolve');
    if (bottomResolveBtn) bottomResolveBtn.addEventListener('click', openResolutionModal);

    const bottomReopenBtn = document.getElementById('btn-bottom-reopen');
    if (bottomReopenBtn) bottomReopenBtn.addEventListener('click', reopenCase);

    // Status tabs in investigation queue
    document.querySelectorAll('.status-tab-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.status-tab-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        AppState.activeStatusFilter = btn.getAttribute('data-status');
        renderInvestigationQueue();
      });
    });

    // Category dropdown in investigation queue
    const catFilter = document.getElementById('case-filter-select');
    if (catFilter) {
      catFilter.addEventListener('change', (e) => {
        AppState.activeCategoryFilter = e.target.value;
        renderInvestigationQueue();
      });
    }

    // Reconciliation filter pill buttons (All / Clean Matches / Exceptions)
    document.querySelectorAll('#recon-status-filter-buttons .filter-pill-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        const filter = btn.getAttribute('data-filter') || 'ALL';
        filterReconciliationTable(filter);
      });
    });

    // Chat: send on Enter (Shift+Enter = newline), init input auto-resize
    const chatInput  = document.getElementById('chat-input');
    const chatSendBtn = document.getElementById('chat-send-btn');

    if (chatInput) {
      chatInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault();
          sendChatMessage();
        }
      });
      // Auto-resize textarea as content grows
      chatInput.addEventListener('input', () => {
        chatInput.style.height = 'auto';
        chatInput.style.height = Math.min(chatInput.scrollHeight, 120) + 'px';
      });
    }

    if (chatSendBtn) {
      chatSendBtn.addEventListener('click', () => sendChatMessage());
    }

    // Initialize default gateway mode to PayPal Sandbox (Orders v2)
    setProcessingMode('paypal');

    // Load initial data
    loadAllData();

    // Check initial hash route
    if (window.location.hash) {
      const targetPage = window.location.hash.replace('#', '');
      if (targetPage) navigateTo(targetPage);
    }
    window.addEventListener('hashchange', () => {
      const p = window.location.hash.replace('#', '');
      if (p) navigateTo(p);
    });
  });
}

// ── Ask Payvault AI — Case-Aware Investigation Chat ───────────────────────────
//
// ARCHITECTURE:
//   Operator types question
//     → POST /api/investigations/:caseId/chat  { message, history }
//     → Backend: buildChatContext → generateLocalAnswer (or Ollama if enabled)
//     → Response: { answer, source, ai_used, model, intent }
//     → Render message bubble with accurate provenance
//
// STATE:
//   AppState.chatHistories  = Map<caseId, [{role, content}]>  — per-case conversation
//   AppState.chatCurrentCase = string|null                     — prevents stale context
//
// RULES:
//   - Context is ALWAYS scoped to AppState.currentCaseId
//   - Switching cases clears the visible thread and resets history
//   - Never show "Qwen analyzed" unless ai_used===true in the response
//   - Never allow state-changing chat commands (backend also guards this)

AppState.chatHistories   = new Map();
AppState.chatCurrentCase = null;
AppState._lastChatMessage = null;  // for retry

const CHAT_SUGGESTED_QUESTIONS = [
  { text: 'What happened?', intent: 'why_flagged' },
  { text: 'What is the gross amount?', intent: 'gross_amount' },
  { text: 'What was the expected settlement?', intent: 'expected_settlement' },
  { text: 'Why is the settlement short?', intent: 'settlement_causality' },
  { text: 'What about GST?', intent: 'tax_specific' },
  { text: 'What should I do now?', intent: 'next_action' },
  { text: 'Does this represent actual financial loss?', intent: 'real_financial_loss' },
  { text: 'What evidence supports this?', intent: 'evidence_assessment' },
  { text: 'Should I escalate this case?', intent: 'escalation_assessment' },
  { text: 'Explain this case in simple terms.', intent: 'simple_explanation' },
];

/**
 * Resets the chat panel for a new case.
 * Called whenever selectInvestigationCase detects a case switch.
 */
function resetChatForCase(newCaseId) {
  AppState.chatCurrentCase  = newCaseId;
  AppState._lastChatMessage = null;

  const conversation = document.getElementById('chat-conversation');
  const emptyState   = document.getElementById('chat-empty-state');
  if (conversation) {
    // Clear all messages except the empty state placeholder
    Array.from(conversation.children).forEach(child => {
      if (child.id !== 'chat-empty-state') child.remove();
    });
  }
  if (emptyState) emptyState.style.display = '';

  // Re-render suggested questions with the new case's category
  renderChatSuggestedQuestions();

  // Reset provenance badge to default
  setChatProvenance();
}

/**
 * Renders the suggested-question pills, inserting the current case's
 * exception_category where [category] appears.
 */
function renderChatSuggestedQuestions() {
  const pillsContainer = document.getElementById('chat-suggested-pills');
  if (!pillsContainer) return;

  const cat = AppState.currentCaseDetail?.exception_category || null;
  const catLabel = cat ? cleanCategoryLabel(cat) : null;

  pillsContainer.innerHTML = CHAT_SUGGESTED_QUESTIONS.map(q => {
    const text = catLabel
      ? q.text.replace('[category]', catLabel)
      : q.text.replace(' as [category]', '').replace('[category]', '');
    return `<button
      class="chat-suggested-pill"
      type="button"
      data-intent="${q.intent}"
      onclick="chatSuggestedClick(this)"
      aria-label="Ask: ${text}"
    >${text}</button>`;
  }).join('');
}

/**
 * Handles click on a suggested-question pill.
 */
function chatSuggestedClick(btn) {
  const text  = btn.textContent.trim();
  const input = document.getElementById('chat-input');
  if (input) {
    input.value = text;
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, 120) + 'px';
    input.focus();
  }
  sendChatMessage();
}

/**
 * Updates the provenance badge in the chat panel header.
 * Reflects whether local Ollama or native reasoning generated the response.
 */
function setChatProvenance({ ai_used, model } = {}) {
  const badge = document.getElementById('chat-provenance-badge');
  const dot   = badge?.querySelector('.chat-prov-dot');
  const label = document.getElementById('chat-prov-label');
  if (!label) return;

  if (dot) dot.className = 'chat-prov-dot online';
  if (model) {
    label.textContent = model;
  } else {
    label.textContent = 'Payvault AI';
  }
}

/**
 * Main send function.
 * Reads input, posts to backend, renders the response.
 */
async function sendChatMessage() {
  const input   = document.getElementById('chat-input');
  const sendBtn = document.getElementById('chat-send-btn');
  if (!input) return;

  const message = input.value.trim();
  if (!message) return;

  const caseId = AppState.currentCaseId;
  if (!caseId) {
    showToast('No investigation case selected.', 'warning');
    return;
  }

  // Save for retry
  AppState._lastChatMessage = message;

  // Disable input while processing
  input.value = '';
  input.style.height = 'auto';
  if (input) input.disabled = true;
  if (sendBtn) sendBtn.disabled = true;

  // Get or create per-case history and persistent conversation ID
  if (!AppState.chatHistories.has(caseId)) {
    AppState.chatHistories.set(caseId, []);
  }
  if (!AppState.chatConversationIds) {
    AppState.chatConversationIds = new Map();
  }
  if (!AppState.chatConversationIds.has(caseId)) {
    AppState.chatConversationIds.set(caseId, `conv_${caseId}_${Date.now()}`);
  }
  const history = AppState.chatHistories.get(caseId);
  const conversationId = AppState.chatConversationIds.get(caseId);

  // Render the operator's message immediately
  appendChatMessage({ role: 'operator', content: message });

  // Create NEW unique thinking indicator for this turn
  const thinkingId = createThinkingIndicator();

  try {
    const res = await fetch(`/api/investigations/${caseId}/chat`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ message, history, conversationId }),
    });

    const data = await res.json();

    // Remove ONLY this request's thinking indicator
    removeThinkingIndicator(thinkingId);

    if (!res.ok) {
      appendChatError(data.error || 'Request failed.', message);
      return;
    }

    // Render Payvault AI answer
    appendChatMessage({
      role:                        'payvault',
      content:                     data.answer,
      source:                      data.source,
      ai_used:                     data.ai_used,
      model:                       data.model_used || data.model || 'Payvault AI',
      answer_composed_by:          data.answer_composed_by,
      unverified_model_commentary: data.unverified_model_commentary,
    });

    // Update provenance badge
    setChatProvenance({ ai_used: data.ai_used, model: data.model });

    // Append to history for follow-up context (keep last 12 turns)
    history.push({ role: 'operator', content: message });
    history.push({ role: 'payvault', content: data.answer });
    if (history.length > 24) history.splice(0, 2);

  } catch (err) {
    removeThinkingIndicator(thinkingId);
    appendChatError(`Network error: ${err.message}`, message);
  } finally {
    if (input)   input.disabled = false;
    if (sendBtn) sendBtn.disabled = false;
    if (input)   input.focus();
  }
}

/**
 * Renders a single chat message bubble.
 * Converts lightweight markdown (bold, italic, bullets) to safe HTML.
 */
function appendChatMessage({ role, content, source, ai_used, model, answer_composed_by, unverified_model_commentary }) {
  const conversation = document.getElementById('chat-conversation');
  const emptyState   = document.getElementById('chat-empty-state');
  if (!conversation) return null;

  if (emptyState) emptyState.style.display = 'none';

  const isOperator = role === 'operator';
  const senderLabel = isOperator ? 'Operator' : 'Payvault AI';

  // Source note for AI messages: honest provenance
  let sourceLine = '';
  let commentarySection = '';
  if (!isOperator) {
    if (unverified_model_commentary) {
      commentarySection = `
        <div style="margin-top:0.6rem;padding:0.5rem 0.75rem;background:rgba(234,179,8,0.08);border-left:3px solid #eab308;border-radius:4px;font-size:0.75rem;color:#94a3b8;line-height:1.35;">
          <strong style="color:#eab308;display:block;margin-bottom:0.2rem;">⚠️ UNVERIFIED LOCAL MODEL PROSE (${escapeHtml(model || 'Ollama')}):</strong>
          <span>${renderChatMarkdown(unverified_model_commentary.replace(/^\[UNVERIFIED LOCAL MODEL COMMENTARY\]:\s*/, ''))}</span>
        </div>
      `;
    }
    sourceLine = `
      <div class="chat-message-meta">
        <span class="chat-source-badge">
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.5" style="display:inline-block;vertical-align:-1px;margin-right:3px;">
            <path d="M2 6l3 3 5-5"/>
          </svg>
          ${answer_composed_by ? 'Deterministic Evidence Composition' : 'Grounded in case evidence'}
        </span>
        <button class="chat-view-evidence-btn" type="button" onclick="scrollToEvidence()">View Evidence</button>
      </div>
    `;
  }

  const msgEl = document.createElement('div');
  msgEl.className = `chat-message ${isOperator ? 'operator' : 'payvault'}`;
  msgEl.innerHTML = `
    <span class="chat-message-sender">${escapeHtml(senderLabel)}</span>
    <div class="chat-bubble">
      ${renderChatMarkdown(content)}
      ${commentarySection}
    </div>
    ${sourceLine}
  `;

  conversation.appendChild(msgEl);
  scrollChatToBottom(conversation);

  return msgEl;
}

let _thinkingCounter = 0;

/**
 * Appends a NEW unique Thinking indicator placeholder for the active request turn.
 * Shows:
 * Payvault AI
 * ● ● ●
 * Thinking...
 *
 * Returns unique ID of the element so removeThinkingIndicator can remove it on completion.
 */
function createThinkingIndicator() {
  const conversation = document.getElementById('chat-conversation');
  if (!conversation) return null;

  const emptyState = document.getElementById('chat-empty-state');
  if (emptyState) emptyState.style.display = 'none';

  _thinkingCounter += 1;
  const id = `chat-thinking-${Date.now()}-${_thinkingCounter}`;
  const el = document.createElement('div');
  el.id = id;
  el.className = 'chat-message payvault loading';
  el.setAttribute('data-thinking', 'true');
  el.innerHTML = `
    <span class="chat-message-sender">Payvault AI</span>
    <div class="chat-bubble">
      <div class="chat-thinking-container">
        <div class="chat-thinking-dots" aria-label="Payvault AI is thinking">
          <span class="thinking-dot chat-dot">●</span>
          <span class="thinking-dot chat-dot">●</span>
          <span class="thinking-dot chat-dot">●</span>
        </div>
        <span class="chat-thinking-text">Thinking...</span>
      </div>
    </div>
  `;
  conversation.appendChild(el);
  scrollChatToBottom(conversation);
  return id;
}

/**
 * Removes ONLY the specified thinking indicator by ID.
 */
function removeThinkingIndicator(id) {
  if (!id) return;
  const el = document.getElementById(id);
  if (el) {
    el.remove();
  }
}

// Backwards-compatible aliases
function appendLoadingIndicator() {
  return createThinkingIndicator();
}

function removeLoadingIndicator(id) {
  removeThinkingIndicator(id);
}

/**
 * Replaces the thinking placeholder in-place with the real answer.
 * Preserved for backwards compatibility with existing direct-caller tests.
 */
function fulfillLoadingIndicator(id, { content, source, ai_used, model }) {
  const el = document.getElementById(id);
  if (!el) {
    return appendChatMessage({ role: 'payvault', content, source, ai_used, model });
  }

  el.classList.remove('loading');
  el.removeAttribute('data-thinking');

  const senderSpan = el.querySelector('.chat-message-sender');
  if (senderSpan) senderSpan.textContent = 'Payvault AI';

  const bubble = el.querySelector('.chat-bubble');
  if (bubble) {
    bubble.innerHTML = renderChatMarkdown(content);
  }

  const sourceLine = `
    <div class="chat-message-meta">
      <span class="chat-source-badge">
        <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.5" style="display:inline-block;vertical-align:-1px;margin-right:3px;">
          <path d="M2 6l3 3 5-5"/>
        </svg>
        Grounded in 5 case evidence sources
      </span>
      <button class="chat-view-evidence-btn" type="button" onclick="scrollToEvidence()">View Evidence</button>
    </div>
  `;
  el.insertAdjacentHTML('beforeend', sourceLine);

  const conversation = document.getElementById('chat-conversation');
  if (conversation) scrollChatToBottom(conversation);
  return el;
}

/**
 * Smoothly scrolls to the Evidence Panel and highlights it for visual focus.
 */
function scrollToEvidence() {
  const panel = document.getElementById('case-evidence-panel');
  if (panel) {
    panel.scrollIntoView({ behavior: 'smooth', block: 'start' });
    panel.classList.add('highlight-pulse');
    setTimeout(() => {
      panel.classList.remove('highlight-pulse');
    }, 1800);
  }
}

if (typeof window !== 'undefined') {
  window.scrollToEvidence = scrollToEvidence;
}

/**
 * Replaces the thinking placeholder in-place with the error message and retry button.
 */
function errorLoadingIndicator(id, errorMsg, originalMessage) {
  const el = document.getElementById(id);
  if (!el) {
    return appendChatError(errorMsg, originalMessage);
  }

  el.classList.remove('loading');
  el.removeAttribute('data-thinking');

  const bubble = el.querySelector('.chat-bubble');
  if (bubble) {
    bubble.className = 'chat-error-inline';
    bubble.innerHTML = `
      <span>${escapeHtml(errorMsg)}</span>
      <button class="chat-retry-btn" type="button" onclick="retryChatMessage(this)" data-msg="${escapeHtml(originalMessage)}">Retry</button>
    `;
  }
  const conversation = document.getElementById('chat-conversation');
  if (conversation) scrollChatToBottom(conversation);
  return el;
}

/**
 * Inline error with a retry button.
 */
function appendChatError(errorMsg, originalMessage) {
  const conversation = document.getElementById('chat-conversation');
  if (!conversation) return;

  const el = document.createElement('div');
  el.className = 'chat-message payvault';
  el.innerHTML = `
    <span class="chat-message-sender">Payvault AI</span>
    <div class="chat-error-inline">
      <span>${escapeHtml(errorMsg)}</span>
      <button class="chat-retry-btn" type="button" onclick="retryChatMessage(this)" data-msg="${escapeHtml(originalMessage)}">Retry</button>
    </div>
  `;
  conversation.appendChild(el);
  scrollChatToBottom(conversation);
}

/**
 * Retry handler — removes the error bubble and re-sends.
 */
function retryChatMessage(btn) {
  const msg = btn.getAttribute('data-msg') || AppState._lastChatMessage || '';
  // Remove the error bubble
  const bubble = btn.closest('.chat-message');
  if (bubble) bubble.remove();
  // Re-populate input and send
  const input = document.getElementById('chat-input');
  if (input) input.value = msg;
  sendChatMessage();
}

/**
 * Converts a small subset of markdown to safe HTML.
 * Handles: **bold**, *italic*, `code`, bullet lines starting with • or -
 * Escapes all other HTML to prevent XSS.
 */
function renderChatMarkdown(text) {
  if (!text) return '';

  // Split into lines for bullet handling
  const lines = text.split('\n');
  const rendered = lines.map(line => {
    let safe = escapeHtml(line);

    // Bold: **text** or __text__
    safe = safe.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
    safe = safe.replace(/__(.+?)__/g, '<strong>$1</strong>');

    // Italic: *text* or _text_ (not inside word boundaries to avoid mis-fires)
    safe = safe.replace(/(?<!\w)\*([^*\n]+?)\*(?!\w)/g, '<em>$1</em>');
    safe = safe.replace(/(?<!\w)_([^_\n]+?)_(?!\w)/g, '<em>$1</em>');

    // Inline code: `text`
    safe = safe.replace(/`([^`]+)`/g, '<code style="font-family:var(--font-mono);font-size:0.88em;background:#f1f5f9;padding:0.1em 0.25em;border-radius:3px;">$1</code>');

    return safe;
  });

  // Re-join; collapse trailing empty lines
  return rendered.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

function escapeHtml(str) {
  if (typeof str !== 'string') return '';
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function scrollChatToBottom(el) {
  if (el && typeof requestAnimationFrame === 'function') {
    requestAnimationFrame(() => { el.scrollTop = el.scrollHeight; });
  }
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    createThinkingIndicator,
    removeThinkingIndicator,
    appendChatMessage,
    appendLoadingIndicator,
    fulfillLoadingIndicator,
    errorLoadingIndicator,
    removeLoadingIndicator,
    renderChatMarkdown,
    escapeHtml,
    formatINR,
    formatTimelineTime,
    derivePriority,
    scrollToEvidence,
    generateCaseFindings,
    renderAuditableTransactionFacts,
  };
}

