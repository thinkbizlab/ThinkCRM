// Super Admin → Analytics / Infrastructure / Subscriptions tabs.
// Polls /super-admin/realtime (+ /infra, /subscriptions) every 20s while
// the tab is visible and renders into a caller-supplied container.

import { api } from "./api.js";
import { escHtml } from "./utils.js";

const POLL_MS = 20_000;
const THREE_MIN_MS = 3 * 60 * 1000;

// ── Thresholds ────────────────────────────────────────────────────────────────
// Tune here. "amber" = consider scaling soon; "red" = scale now.
const THRESHOLDS = {
  dbConn: { amber: 0.60, red: 0.85 },  // fraction of max_connections
  dbSize: { amberGb: 5, redGb: 20 },
  heap:   { amber: 0.70, red: 0.90 },  // heapUsed / heapTotal
};

// ── Helpers ───────────────────────────────────────────────────────────────────
function fmtBytes(n) {
  if (n == null || n < 0) return "—";
  if (n === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(n) / Math.log(1024));
  return (n / Math.pow(1024, i)).toFixed(i > 0 ? 1 : 0) + " " + units[i];
}

function fmtUptime(sec) {
  if (!sec) return "—";
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

function fmtCents(cents, currency) {
  const n = (cents ?? 0) / 100;
  return `${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${currency || ""}`.trim();
}

function fmtAgo(iso) {
  if (!iso) return "";
  const ms = Date.now() - new Date(iso).getTime();
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  return `${m}m ago`;
}

function fmtDate(d) {
  if (!d) return "—";
  try { return new Date(d).toLocaleDateString(); } catch { return "—"; }
}

function statusClassFor(ratio, { amber, red }) {
  if (ratio >= red) return "sa-status--red";
  if (ratio >= amber) return "sa-status--amber";
  return "sa-status--green";
}

function sparklineSvg(points, { width = 120, height = 30 } = {}) {
  if (!points || points.length === 0) return "";
  const max = Math.max(1, ...points);
  const step = width / Math.max(1, points.length - 1);
  const d = points
    .map((v, i) => `${(i * step).toFixed(1)},${(height - (v / max) * (height - 2) - 1).toFixed(1)}`)
    .join(" ");
  return `<svg class="sa-spark" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" aria-hidden="true">
    <polyline points="${d}" fill="none" stroke="var(--primary)" stroke-width="1.5" stroke-linejoin="round"/>
  </svg>`;
}

// ── Analytics ─────────────────────────────────────────────────────────────────
export function renderAnalytics(container, data) {
  if (!container) return;
  const t = data.totals || {};
  const header = `
    <div class="sa-kpi-strip">
      <div class="sa-kpi-card">
        <div class="sa-kpi-val">
          <span class="sa-online-dot sa-online-dot--pulse"></span>${t.onlineUsers ?? 0}
        </div>
        <div class="sa-kpi-lbl">Online now</div>
      </div>
      <div class="sa-kpi-card">
        <div class="sa-kpi-val">${t.activeTenants ?? 0}<span class="sa-kpi-sub"> / ${t.totalTenants ?? 0}</span></div>
        <div class="sa-kpi-lbl">Active tenants</div>
      </div>
      <div class="sa-kpi-card">
        <div class="sa-kpi-val">${t.loginsToday ?? 0}</div>
        <div class="sa-kpi-lbl">Logins today</div>
      </div>
      <div class="sa-kpi-card">
        <div class="sa-kpi-val">${t.dealsCreatedToday ?? 0}</div>
        <div class="sa-kpi-lbl">Deals today</div>
      </div>
    </div>`;

  const cards = (data.tenants || []).map((tn) => {
    const dotClass = tn.onlineUsers > 0 ? "sa-online-dot" : "sa-offline-dot";
    return `<div class="sa-tenant-card">
      <div class="sa-tc-head">
        <span class="${dotClass}"></span>
        <span class="sa-tc-name" title="${escHtml(tn.slug)}">${escHtml(tn.name)}</span>
        ${tn.isActive ? "" : '<span class="sa-badge sa-badge--red sa-tc-badge">Inactive</span>'}
      </div>
      <div class="sa-tc-online">${tn.onlineUsers}</div>
      <div class="sa-tc-online-lbl">users online</div>
      <div class="sa-tc-metrics">
        <div><span class="sa-tc-n">${tn.loginsToday}</span><span class="sa-tc-m">Logins</span></div>
        <div><span class="sa-tc-n">${tn.dealsCreatedToday}</span><span class="sa-tc-m">Deals</span></div>
        <div><span class="sa-tc-n">${tn.visitsCreatedToday}</span><span class="sa-tc-m">Visits</span></div>
      </div>
      <div class="sa-tc-spark">${sparklineSvg(tn.spark || [])}</div>
    </div>`;
  }).join("");

  const empty = (data.tenants || []).length === 0
    ? '<div class="sa-empty">No tenants yet.</div>' : "";

  container.innerHTML = `
    ${header}
    <div class="sa-analytics-foot">
      <span class="sa-updated">Updated ${fmtAgo(data.generatedAt)}</span>
    </div>
    <div class="sa-tenant-grid">${cards}</div>
    ${empty}
  `;
}

// ── Infrastructure ────────────────────────────────────────────────────────────
export function renderInfra(container, data) {
  if (!container) return;
  const si = data.sampleInstance || {};
  const db = data.database || {};
  const audit = data.audit || {};
  const ext = data.external || {};

  const heapRatio = si.heapTotalBytes > 0 ? si.heapUsedBytes / si.heapTotalBytes : 0;
  const heapClass = statusClassFor(heapRatio, THRESHOLDS.heap);

  const connRatio = db.maxConnections > 0 ? db.activeConnections / db.maxConnections : 0;
  const connClass = statusClassFor(connRatio, THRESHOLDS.dbConn);

  const dbGb = (db.dbSizeBytes || 0) / (1024 ** 3);
  const dbSizeClass = dbGb >= THRESHOLDS.dbSize.redGb ? "sa-status--red"
    : dbGb >= THRESHOLDS.dbSize.amberGb ? "sa-status--amber" : "sa-status--green";

  container.innerHTML = `
    <div class="sa-infra-grid">
      <div class="sa-infra-card">
        <div class="sa-infra-title">Sample instance <span class="sa-muted">(current Vercel function)</span></div>
        <div class="sa-infra-rows">
          <div><span>Region</span><strong>${escHtml(si.region || "—")}</strong></div>
          <div><span>Node</span><strong>${escHtml(si.nodeVersion || "—")}</strong></div>
          <div><span>Uptime</span><strong>${fmtUptime(si.uptimeSec)}</strong></div>
          <div><span>Heap used</span><strong class="${heapClass}">${fmtBytes(si.heapUsedBytes)} / ${fmtBytes(si.heapTotalBytes)}</strong></div>
          <div><span>RSS</span><strong>${fmtBytes(si.rssBytes)}</strong></div>
        </div>
      </div>
      <div class="sa-infra-card">
        <div class="sa-infra-title">Database</div>
        <div class="sa-infra-rows">
          <div><span>Active conns</span><strong class="${connClass}">${db.activeConnections ?? 0} / ${db.maxConnections ?? "—"}</strong></div>
          <div><span>Idle conns</span><strong>${db.idleConnections ?? 0}</strong></div>
          <div><span>DB size</span><strong class="${dbSizeClass}">${fmtBytes(db.dbSizeBytes)}</strong></div>
        </div>
      </div>
      <div class="sa-infra-card">
        <div class="sa-infra-title">Traffic</div>
        <div class="sa-infra-rows">
          <div><span>Audit events / hr</span><strong>${audit.auditEventsLastHour ?? 0}</strong></div>
        </div>
      </div>
      <div class="sa-infra-card">
        <div class="sa-infra-title">External dashboards</div>
        <div class="sa-infra-links">
          ${ext.vercelDashboardUrl ? `<a href="${escHtml(ext.vercelDashboardUrl)}" target="_blank" rel="noopener">Vercel</a>` : ""}
          ${ext.neonDashboardUrl ? `<a href="${escHtml(ext.neonDashboardUrl)}" target="_blank" rel="noopener">Neon</a>` : ""}
          ${ext.sentryDashboardUrl ? `<a href="${escHtml(ext.sentryDashboardUrl)}" target="_blank" rel="noopener">Sentry</a>` : ""}
        </div>
      </div>
    </div>
    <div class="sa-infra-hint">
      <strong>When to scale:</strong>
      Connections red → bump Neon compute size.
      Heap red → raise Vercel function memory.
      Storage red (see Storage tab) → R2 cost-only.
    </div>
  `;
}

// ── Subscriptions ─────────────────────────────────────────────────────────────
export function renderSubscriptions(container, data, { onSend } = {}) {
  if (!container) return;
  const totals = data.totals || {};
  const rows = data.subscriptions || [];

  const status = (s) => {
    const cls = s === "ACTIVE" ? "sa-badge--green"
      : s === "TRIALING" ? "sa-badge--yellow"
      : s === "PAST_DUE" ? "sa-badge--red"
      : "sa-badge--gray";
    return `<span class="sa-badge ${cls}">${escHtml(s)}</span>`;
  };

  const strip = `
    <div class="sa-kpi-strip">
      <div class="sa-kpi-card"><div class="sa-kpi-val">${fmtCents(totals.mrrCents)}</div><div class="sa-kpi-lbl">MRR</div></div>
      <div class="sa-kpi-card"><div class="sa-kpi-val">${fmtCents(totals.arrCents)}</div><div class="sa-kpi-lbl">ARR</div></div>
      <div class="sa-kpi-card"><div class="sa-kpi-val">${totals.byStatus?.TRIALING ?? 0}</div><div class="sa-kpi-lbl">Trialing</div></div>
      <div class="sa-kpi-card"><div class="sa-kpi-val">${totals.byStatus?.PAST_DUE ?? 0}</div><div class="sa-kpi-lbl">Past due</div></div>
    </div>`;

  const tbody = rows.length === 0
    ? '<tr><td colspan="8" class="sa-empty">No subscriptions yet.</td></tr>'
    : rows.map((r) => `
        <tr data-tenant-id="${escHtml(r.tenantId)}">
          <td><strong>${escHtml(r.tenantName)}</strong><br><code class="sa-muted">${escHtml(r.tenantSlug)}</code></td>
          <td>${status(r.status)}</td>
          <td>${escHtml(r.billingCycle)}</td>
          <td>${r.seatCount} × ${fmtCents(r.seatPriceCents, r.currency)}</td>
          <td><strong>${fmtCents(r.mrrCents, r.currency)}</strong></td>
          <td>${fmtDate(r.billingPeriodEnd)}<br><span class="sa-muted">${r.daysUntilRenewal != null ? r.daysUntilRenewal + "d" : "—"}</span></td>
          <td>${r.stripeCustomerId ? `<a href="https://dashboard.stripe.com/customers/${encodeURIComponent(r.stripeCustomerId)}" target="_blank" rel="noopener">Stripe ↗</a>` : '<span class="sa-muted">—</span>'}</td>
          <td><button class="sa-btn sa-btn--sm sa-btn--primary" data-sa-subs-action="invoices" data-tenant-id="${escHtml(r.tenantId)}" data-tenant-name="${escHtml(r.tenantName)}">Invoices</button></td>
        </tr>`).join("");

  container.innerHTML = `
    ${strip}
    <div class="sa-table-wrap">
      <table class="sa-table sa-subs-table">
        <thead><tr>
          <th>Tenant</th><th>Status</th><th>Cycle</th><th>Seats × Price</th><th>MRR</th>
          <th>Renews</th><th>Stripe</th><th></th>
        </tr></thead>
        <tbody>${tbody}</tbody>
      </table>
    </div>
  `;

  container.querySelectorAll('[data-sa-subs-action="invoices"]').forEach((btn) => {
    btn.addEventListener("click", () => {
      if (typeof onSend === "function") onSend(btn.dataset.tenantId, btn.dataset.tenantName);
    });
  });
}

// ── Invoices modal (per tenant) ───────────────────────────────────────────────
export async function openInvoicesModal(tenantId, tenantName, { modalEl, onClose } = {}) {
  if (!modalEl) return;
  const content = modalEl.querySelector(".sa-modal-content");
  if (!content) return;

  content.innerHTML = '<div style="padding:24px;color:#64748b">Loading...</div>';
  modalEl.hidden = false;

  const render = async () => {
    try {
      const invoices = await api(`/super-admin/tenants/${encodeURIComponent(tenantId)}/invoices`);
      const rows = invoices.length === 0
        ? '<tr><td colspan="6" class="sa-empty">No invoices yet.</td></tr>'
        : invoices.map((i) => {
            const statusCls = i.status === "FINALIZED" ? "sa-badge--green" : "sa-badge--gray";
            return `<tr>
              <td><code>${escHtml(i.invoiceMonth)}</code></td>
              <td>${escHtml(i.periodStart)} → ${escHtml(i.periodEnd)}</td>
              <td>${fmtCents(i.totalDueCents, i.currency)}</td>
              <td><span class="sa-badge ${statusCls}">${escHtml(i.status)}</span></td>
              <td>${i.sentAt ? new Date(i.sentAt).toLocaleString() : '<span class="sa-muted">Not sent</span>'}</td>
              <td><button class="sa-btn sa-btn--sm sa-btn--primary" data-invoice-send="${escHtml(i.id)}">${i.sentAt ? "Resend" : "Send"}</button></td>
            </tr>`;
          }).join("");

      content.innerHTML = `
        <div class="sa-detail">
          <div class="sa-detail-header">
            <h3>Invoices — ${escHtml(tenantName)}</h3>
            <button class="sa-btn sa-btn--sm sa-modal-close">&times;</button>
          </div>
          <table class="sa-table sa-table--compact">
            <thead><tr><th>Month</th><th>Period</th><th>Total</th><th>Status</th><th>Last sent</th><th></th></tr></thead>
            <tbody>${rows}</tbody>
          </table>
          <div class="sa-detail-footer">
            <button class="sa-btn sa-modal-close">Close</button>
          </div>
        </div>`;

      content.querySelectorAll(".sa-modal-close").forEach((b) =>
        b.addEventListener("click", () => {
          modalEl.hidden = true;
          if (typeof onClose === "function") onClose();
        })
      );
      content.querySelectorAll("[data-invoice-send]").forEach((b) =>
        b.addEventListener("click", async () => {
          const invoiceId = b.dataset.invoiceSend;
          b.disabled = true;
          b.textContent = "Sending...";
          try {
            const result = await api(`/super-admin/tenants/${encodeURIComponent(tenantId)}/invoices/${encodeURIComponent(invoiceId)}/send`, { method: "POST" });
            if (result.ok) {
              alert(`Invoice sent to ${result.sentTo}`);
              await render();
            } else {
              alert(`Failed: ${result.reason || "unknown error"}`);
              b.disabled = false;
              b.textContent = "Send";
            }
          } catch (err) {
            alert(`Failed: ${err.message}`);
            b.disabled = false;
            b.textContent = "Send";
          }
        })
      );
    } catch (err) {
      content.innerHTML = `<div style="padding:24px;color:#ef4444">${escHtml(err.message)}</div>`;
    }
  };

  await render();
}

// ── Polling lifecycle ─────────────────────────────────────────────────────────
// Caller passes a `tick()` that fetches + renders its current tab.
// We pause while the tab is hidden.
export function createPoller({ tick, intervalMs = POLL_MS } = {}) {
  let timer = null;
  let stopped = false;

  const run = async () => {
    if (stopped) return;
    if (document.hidden) return;
    try { await tick(); } catch (err) { console.warn("[sa-analytics] tick error:", err); }
  };

  return {
    start() {
      stopped = false;
      run();
      clearInterval(timer);
      timer = setInterval(run, intervalMs);
    },
    stop() {
      stopped = true;
      clearInterval(timer);
      timer = null;
    },
    tickNow: run,
  };
}

export { sparklineSvg, THREE_MIN_MS };
