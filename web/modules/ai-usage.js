// Per-tenant AI Usage dashboard. Pulls /tenants/:id/ai-usage and renders KPI
// tiles + breakdowns + daily timeseries. Admin-only — the backend enforces.

let deps = null;
export function setAiUsageDeps(d) { deps = d; }

const RANGES = [
  { id: "7d",     label: "7 days",     days: 7 },
  { id: "30d",    label: "30 days",    days: 30 },
  { id: "this",   label: "This month", days: null },
];

function fmtUsd(n) {
  if (!Number.isFinite(n)) return "$0.00";
  if (n < 0.01 && n > 0) return "<$0.01";
  return "$" + n.toFixed(n >= 100 ? 0 : n >= 1 ? 2 : 4);
}

function rangeBounds(rangeId) {
  const now = new Date();
  if (rangeId === "this") {
    const from = new Date(now.getFullYear(), now.getMonth(), 1);
    return { from: from.toISOString(), to: now.toISOString() };
  }
  const days = (RANGES.find((r) => r.id === rangeId) || RANGES[1]).days || 30;
  const from = new Date(now); from.setDate(from.getDate() - days);
  return { from: from.toISOString(), to: now.toISOString() };
}

const FEATURE_LABELS = {
  DEDUP_INLINE: "Inline duplicate check",
  DEDUP_SCAN: "Scheduled duplicate scan",
  VOICE_TRANSCRIBE: "Voice transcription",
  VOICE_SUMMARIZE: "Voice summarization",
  VISIT_RECOMMENDATIONS: "Visit recommendations",
  ANALYSIS: "AI analysis",
  LOST_DEALS: "Lost-deals analysis",
};

export async function loadAiUsage(rangeId) {
  if (!deps) throw new Error("ai-usage module deps not set");
  const { state, api, escHtml } = deps;
  const tenantId = state.user?.tenantId;
  const mount = document.querySelector("#ai-usage-mount");
  if (!tenantId || !mount) return;

  const range = rangeId || "30d";
  mount.innerHTML = `<section class="card"><div class="muted">Loading…</div></section>`;

  let data;
  try {
    const { from, to } = rangeBounds(range);
    data = await api(`/tenants/${tenantId}/ai-usage?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`);
  } catch (err) {
    mount.innerHTML = `<section class="card"><div class="muted" style="color:var(--danger)">${escHtml(err.message || "Failed to load AI usage.")}</div></section>`;
    return;
  }

  const rangeBtns = RANGES.map((r) => `
    <button type="button" class="ghost small ai-usage-range-btn ${r.id === range ? "is-active" : ""}" data-range="${r.id}" style="${r.id === range ? "background:var(--accent);color:#fff" : ""}">${escHtml(r.label)}</button>
  `).join("");

  // Empty + onboarding banner: zero rows total AND no provider enabled.
  const totallyEmpty = data.totals.events === 0 && !data.anyProviderEnabled;
  const onboardingBanner = totallyEmpty
    ? `<section class="card" style="border:2px dashed var(--accent);background:var(--bg-subtle);margin-bottom:var(--sp-3)">
        <h4 style="margin:0 0 var(--sp-1) 0">No AI provider enabled yet</h4>
        <p class="muted" style="margin:0 0 var(--sp-2) 0">Enable an AI provider in Settings → Integrations to use AI features (duplicate detection, voice notes, lost-deals analysis) and start tracking usage here.</p>
        <a class="ncm-submit-btn" href="#" id="ai-usage-go-integrations" style="display:inline-block">Go to Integrations</a>
      </section>`
    : "";

  const featureRows = data.byFeature.map((r) => `
    <tr>
      <td>${escHtml(FEATURE_LABELS[r.feature] || r.feature)}</td>
      <td class="num">${r.events}</td>
      <td class="num">${fmtUsd(r.costUsd)}</td>
    </tr>
  `).join("") || `<tr><td colspan="3" class="muted">No events in this period.</td></tr>`;

  const providerRows = data.byProvider.map((r) => `
    <tr>
      <td>${escHtml(r.provider)}</td>
      <td class="num">${r.events}</td>
      <td class="num">${fmtUsd(r.costUsd)}</td>
    </tr>
  `).join("") || `<tr><td colspan="3" class="muted">—</td></tr>`;

  const userRows = data.byUser.slice(0, 20).map((r) => `
    <tr>
      <td>${escHtml(r.fullName || r.userId || "—")}</td>
      <td class="num">${r.events}</td>
      <td class="num">${fmtUsd(r.costUsd)}</td>
    </tr>
  `).join("") || `<tr><td colspan="3" class="muted">—</td></tr>`;

  // Daily timeseries — simple svg sparkline of cost.
  const ts = data.dailyTimeseries;
  const maxCost = ts.reduce((m, d) => Math.max(m, d.costUsd), 0) || 1;
  const sparklineW = 600, sparklineH = 80, pad = 4;
  const sparkBars = ts.map((d, i) => {
    const x = pad + (i * (sparklineW - pad * 2)) / Math.max(1, ts.length);
    const w = Math.max(2, (sparklineW - pad * 2) / Math.max(1, ts.length) - 1);
    const h = (d.costUsd / maxCost) * (sparklineH - pad * 2);
    const y = sparklineH - pad - h;
    return `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="var(--accent)" opacity="0.85"><title>${d.date}: ${fmtUsd(d.costUsd)} (${d.events} events)</title></rect>`;
  }).join("");

  mount.innerHTML = `
    ${onboardingBanner}
    <section class="card" style="margin-bottom:var(--sp-3)">
      <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:var(--sp-2)">
        <h3 class="section-title" style="margin:0">AI Usage</h3>
        <div class="inline-actions" id="ai-usage-range-bar">${rangeBtns}</div>
      </div>
      <p class="muted small">Token-priced calls only. Transcription minutes use a duration heuristic; refine pricing in <code>src/lib/ai-usage.ts</code>.</p>
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:var(--sp-3);margin-top:var(--sp-3)">
        <div style="border:1px solid var(--border-color);border-radius:8px;padding:var(--sp-3)">
          <div class="muted small">Events</div>
          <div style="font-size:1.6rem;font-weight:700">${data.totals.events.toLocaleString()}</div>
        </div>
        <div style="border:1px solid var(--border-color);border-radius:8px;padding:var(--sp-3)">
          <div class="muted small">Cost (USD)</div>
          <div style="font-size:1.6rem;font-weight:700">${fmtUsd(data.totals.costUsd)}</div>
        </div>
      </div>
    </section>

    <section class="card" style="margin-bottom:var(--sp-3)">
      <h4 class="section-title" style="margin-top:0">Daily cost</h4>
      ${ts.length === 0
        ? `<div class="muted">No events in this period.</div>`
        : `<svg width="100%" height="${sparklineH}" viewBox="0 0 ${sparklineW} ${sparklineH}" preserveAspectRatio="none" style="display:block">${sparkBars}</svg>`}
    </section>

    <div style="display:grid;grid-template-columns:1fr 1fr;gap:var(--sp-3)">
      <section class="card">
        <h4 class="section-title" style="margin-top:0">By feature</h4>
        <table class="data-table"><thead><tr><th>Feature</th><th class="num">Events</th><th class="num">Cost</th></tr></thead><tbody>${featureRows}</tbody></table>
      </section>
      <section class="card">
        <h4 class="section-title" style="margin-top:0">By provider</h4>
        <table class="data-table"><thead><tr><th>Provider</th><th class="num">Events</th><th class="num">Cost</th></tr></thead><tbody>${providerRows}</tbody></table>
      </section>
    </div>

    <section class="card" style="margin-top:var(--sp-3)">
      <h4 class="section-title" style="margin-top:0">By user</h4>
      <table class="data-table"><thead><tr><th>User</th><th class="num">Events</th><th class="num">Cost</th></tr></thead><tbody>${userRows}</tbody></table>
    </section>
  `;

  mount.querySelectorAll(".ai-usage-range-btn").forEach((btn) => {
    btn.addEventListener("click", () => loadAiUsage(btn.dataset.range));
  });
  mount.querySelector("#ai-usage-go-integrations")?.addEventListener("click", (e) => {
    e.preventDefault();
    if (deps.navigateToSettingsPage) deps.navigateToSettingsPage("integrations");
  });
}
