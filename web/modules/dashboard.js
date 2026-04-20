// Dashboard view: KPI strip, target achievement, leaderboard, team
// performance, and AI Lost Deals insights. App-level helpers
// (`asMoney`, `avatarColor`, `repAvatarHtml`, `navigateToSettingsPage`)
// are injected via `setDashboardDeps()`.
import { qs, views, switchView } from "./dom.js";
import { state } from "./state.js";
import { api } from "./api.js";
import { escHtml, asPercent } from "./utils.js";
import { renderDemoDataBanner } from "./demo-data.js";
import { icon } from "./icons.js";

let deps = {
  asMoney: (v) => String(v),
  avatarColor: () => "#ccc",
  repAvatarHtml: () => "",
  navigateToSettingsPage: () => {}
};

export function setDashboardDeps(d) {
  deps = { ...deps, ...d };
}

export function renderDashboard(data) {
  const { asMoney, avatarColor, repAvatarHtml, navigateToSettingsPage } = deps;
  const completion = Number(data.kpis.visitCompletionRate || 0);
  const periodMonth = data?.period?.month || state.dashboardMonth;
  state.dashboardMonth = periodMonth;
  const topGamers = Array.isArray(data.gamification) ? data.gamification.slice(0, 5) : [];
  const teams = Array.isArray(data.teamPerformance) ? data.teamPerformance : [];
  const role = state.user?.role ?? "REP";
  const canFilterReps = role !== "REP";
  const allReps = state.cache.salesReps || [];
  const allTeams = state.cache.teams || [];

  const visibleReps = state.dashboardTeamId
    ? allReps.filter(r => r.teamId === state.dashboardTeamId)
    : allReps;

  const teamSelectHtml = (canFilterReps && allTeams.length > 0) ? `
    <label class="dashboard-filter-label">Team
      <select id="dashboard-team-select" class="dashboard-rep-select">
        <option value="">All Teams</option>
        ${allTeams.map(t => `<option value="${t.id}" ${state.dashboardTeamId === t.id ? "selected" : ""}>${escHtml(t.teamName)}</option>`).join("")}
      </select>
    </label>` : "";

  const repSelectHtml = (canFilterReps && visibleReps.length > 0) ? `
    <label class="dashboard-filter-label">Sales Rep
      <select id="dashboard-rep-select" class="dashboard-rep-select">
        <option value="">All Reps</option>
        ${visibleReps.map(r => `<option value="${r.id}" ${state.dashboardRepId === r.id ? "selected" : ""}>${escHtml(r.fullName)}</option>`).join("")}
      </select>
    </label>` : "";

  views.dashboard.innerHTML = `
    <div id="demo-data-banner" hidden></div>
    <div class="dash-view">
      <div class="dash-filter-bar">
        <form id="dashboard-month-form" class="inline-actions dashboard-filter-form">
          <label class="dashboard-filter-label">
            <input type="month" name="month" value="${periodMonth}" required />
          </label>
          ${teamSelectHtml}
          ${repSelectHtml}
          <button type="submit">Apply</button>
        </form>
        <div class="inline-actions wrap dashboard-chip-row">
          <span class="chip">${icon('users')} ${data.kpis.usersInScope} reps</span>
          <span class="chip">${icon('sparkles')} ${data.kpis.dealsCreatedInPeriod} new deals</span>
          <span class="chip">${icon('calendar')} ${data.kpis.visitsPlannedInPeriod} visits planned</span>
        </div>
      </div>

      <div class="kpi-strip">
        <article class="kpi">
          <div class="kpi-icon">${icon('chart')}</div>
          <h4>Active Deals</h4>
          <strong>${data.kpis.activeDeals}</strong>
          <div class="muted">Open in pipeline</div>
        </article>
        <article class="kpi kpi--pipeline">
          <div class="kpi-icon">${icon('money')}</div>
          <h4>Pipeline</h4>
          <strong>${asMoney(data.kpis.pipelineValue)}</strong>
          <div class="muted">Potential revenue</div>
        </article>
        <article class="kpi kpi--won">
          <div class="kpi-icon">${icon('trophy')}</div>
          <h4>Won</h4>
          <strong>${asMoney(data.kpis.wonValue)}</strong>
          <div class="muted">Closed &amp; collected ${icon('party')}</div>
        </article>
        <article class="kpi kpi--lost">
          <div class="kpi-icon">${icon('chartDown')}</div>
          <h4>Lost</h4>
          <strong>${asMoney(data.kpis.lostValue)}</strong>
          <div class="muted">Learn &amp; bounce back ${icon('muscle')}</div>
        </article>
        <article class="kpi kpi--visits">
          <div class="kpi-icon">${icon('rocket')}</div>
          <h4>Visit Rate</h4>
          <strong>${completion}%</strong>
          <div class="progress kpi-progress"><span style="width:${Math.min(completion, 100)}%"></span></div>
          <div class="muted">Completed visits</div>
        </article>
      </div>

      <div class="dash-grid">
        <div class="dash-section">
          <h3 class="section-title">${icon('target')} Target Achievement</h3>
          ${
            data.targetVsActual.length
              ? data.targetVsActual.map((t) => {
                  const pv = Number(t.progress.visits || 0);
                  const pd = Number(t.progress.newDealValue || 0);
                  const pr = Number(t.progress.revenue || 0);
                  const barCls = (p) => p >= 100 ? "progress-bar--great" : p >= 70 ? "progress-bar--good" : p >= 40 ? "progress-bar--warn" : "progress-bar--low";
                  const valCls = (p) => p >= 100 ? "metric-val--great" : p >= 70 ? "metric-val--good" : "";
                  return `
                <div class="target-rep">
                  <div class="target-rep-head">
                    <h4>${escHtml(t.userName)}</h4>
                    <span class="chip">${escHtml(t.teamName)}</span>
                    <span class="muted">${t.month}</span>
                  </div>
                  <div class="target-metric">
                    <span class="target-metric-label">${icon('running')} Visits</span>
                    <div class="progress"><span class="${barCls(pv)}" style="width:${Math.min(pv, 100)}%"></span></div>
                    <span class="target-metric-val ${valCls(pv)}">${t.actual.visits}/${t.target.visits}</span>
                  </div>
                  <div class="target-metric">
                    <span class="target-metric-label">${icon('briefcase')} New Deal</span>
                    <div class="progress"><span class="${barCls(pd)}" style="width:${Math.min(pd, 100)}%"></span></div>
                    <span class="target-metric-val ${valCls(pd)}">${asPercent(t.progress.newDealValue)}%</span>
                  </div>
                  <div class="target-metric">
                    <span class="target-metric-label">${icon('money')} Revenue</span>
                    <div class="progress"><span class="${barCls(pr)}" style="width:${Math.min(pr, 100)}%"></span></div>
                    <span class="target-metric-val ${valCls(pr)}">${asPercent(t.progress.revenue)}%</span>
                  </div>
                </div>`;
                }).join("")
              : `<div class="empty-state compact"><div class="empty-icon">${icon('target', 24)}</div><div><strong>No KPI targets yet</strong><p>Set monthly targets in Settings.</p></div></div>`
          }
        </div>

        <div class="dash-section">
          <div class="section-title-row">
            <h3 class="section-title" style="margin:0">${icon('medal')} Leaderboard</h3>
            <button type="button" class="section-info-btn" id="leaderboard-info-btn" aria-label="How scoring works">
              <svg width="15" height="15" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="8"/><polyline points="11 12 12 12 12 16"/></svg>
            </button>
          </div>
          ${
            topGamers.length
              ? (() => {
                  const isRep = (state.user?.role ?? "") === "REP";
                  const myUserId = state.user?.id ?? "";
                  return topGamers.map((g) => {
                    const rankLabel = g.rank <= 3 ? icon('medal') : `#${g.rank}`;
                    const badgeEmoji = g.badge === "Legend" ? icon('starFilled') : icon('medal');
                    const momentumHtml = g.momentum === "up"
                      ? `<span class="lb-momentum lb-momentum--up"><svg width="11" height="11" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="18 15 12 9 6 15"/></svg>UP</span>`
                      : g.momentum === "steady"
                      ? `<span class="lb-momentum lb-momentum--steady"><svg width="11" height="11" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="5 12 19 12"/><polyline points="14 7 19 12 14 17"/></svg>STEADY</span>`
                      : `<span class="lb-momentum lb-momentum--down"><svg width="11" height="11" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="6 9 12 15 18 9"/></svg>DOWN</span>`;

                    const isMe = g.userId === myUserId;
                    const masked = isRep && !isMe;

                    if (masked) {
                      return `
                      <div class="leaderboard-item leaderboard-item--masked${g.rank <= 3 ? " leaderboard-item--top" : ""}">
                        <div class="lb-rank">${rankLabel}</div>
                        <div class="leaderboard-info">
                          <h4 class="lb-masked-name">Competitor</h4>
                          <div class="lb-sub"><span class="lb-masked-badge">———</span></div>
                        </div>
                        <div class="leaderboard-score">
                          <strong>${asPercent(g.score)}</strong>
                          ${momentumHtml}
                        </div>
                      </div>`;
                    }

                    return `
                    <div class="leaderboard-item${g.rank <= 3 ? " leaderboard-item--top" : ""}${isMe ? " leaderboard-item--me" : ""}">
                      <div class="lb-rank">${rankLabel}</div>
                      <div class="lb-avatar" style="${g.avatarUrl ? "overflow:hidden" : "background:" + avatarColor(g.userName)}">${repAvatarHtml(g.userName, g.avatarUrl)}</div>
                      <div class="leaderboard-info">
                        <h4>${escHtml(g.userName)}${isMe ? ' <span class="lb-you-badge">You</span>' : ""}</h4>
                        <div class="lb-sub">
                          <span class="lb-badge-pill lb-badge--${g.badge.toLowerCase()}">${badgeEmoji} ${g.badge}</span>
                          <span class="lb-streak">${icon('flame')} ${g.streakDays}d</span>
                          <span class="lb-team muted">${escHtml(g.teamName)}</span>
                        </div>
                      </div>
                      <div class="leaderboard-score">
                        <strong>${asPercent(g.score)}</strong>
                        ${momentumHtml}
                      </div>
                    </div>`;
                  }).join("");
                })()
              : `<div class="empty-state compact"><div class="empty-icon">${icon('trophy', 24)}</div><div><strong>No leaderboard data</strong><p>Create KPI targets to generate rankings.</p></div></div>`
          }
        </div>
      </div>

      ${teams.length ? `
        <div class="dash-section" style="margin-top: var(--sp-4)">
          <h3 class="section-title">${icon('users')} Team Performance</h3>
          ${teams.map((team) => {
            const tvr = Number(team.visitCompletionRate || 0);
            const barCls = tvr >= 100 ? "progress-bar--great" : tvr >= 70 ? "progress-bar--good" : tvr >= 40 ? "progress-bar--warn" : "progress-bar--low";
            return `
            <div class="team-row">
              <div class="target-rep-head">
                <h4>${icon('building')} ${escHtml(team.teamName)}</h4>
                <span class="chip">${icon('user')} ${team.memberCount} member${team.memberCount === 1 ? "" : "s"}</span>
              </div>
              <div class="inline-actions wrap dashboard-chip-row" style="margin-top: var(--sp-1)">
                <span class="chip">${icon('folder')} ${team.activeDeals} deals</span>
                <span class="chip">${icon('money')} ${asMoney(team.pipelineValue)}</span>
                <span class="chip chip-success">${icon('trophy')} ${asMoney(team.wonValue)}</span>
                <span class="chip chip-danger">${icon('chartDown')} ${asMoney(team.lostValue)}</span>
              </div>
              <div class="target-metric" style="margin-top: var(--sp-2)">
                <span class="target-metric-label">${icon('location')} Visits</span>
                <div class="progress"><span class="${barCls}" style="width:${Math.min(tvr, 100)}%"></span></div>
                <span class="target-metric-val">${team.checkedOutVisits}/${team.plannedVisits}</span>
              </div>
            </div>`;
          }).join("")}
        </div>
      ` : ""}

      <!-- ── AI Lost Deals Insights ─────────────────────────── -->
      <div class="dash-section ai-insights-section" style="margin-top: var(--sp-4)">
        <div class="ai-insights-header">
          <div class="ai-insights-title-row">
            <span class="ai-insights-icon">
              <svg width="16" height="16" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 2a10 10 0 1 0 10 10"/><path d="M12 6v6l4 2"/><circle cx="19" cy="5" r="3" fill="currentColor" stroke="none"/></svg>
            </span>
            <h3 class="section-title" style="margin:0">AI Lost Deals Insights</h3>
            <span class="chip">Beta</span>
          </div>
          <div class="ai-insights-controls">
            <input type="month" id="ai-date-from" class="ai-date-input" title="From" />
            <span class="muted small">to</span>
            <input type="month" id="ai-date-to"   class="ai-date-input" title="To" />
            <button type="button" class="ai-run-btn" id="ai-run-btn">
              <svg width="13" height="13" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polygon points="5 3 19 12 5 21 5 3"/></svg>
              Analyze
            </button>
          </div>
        </div>
        <div id="ai-insights-body" class="ai-insights-body">
          <p class="ai-insights-placeholder">
            <svg width="32" height="32" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.5" opacity=".35" aria-hidden="true"><path d="M9.663 17h4.673M12 3v1m6.364 1.636-.707.707M21 12h-1M4 12H3m3.343-5.657-.707-.707m2.828 9.9a5 5 0 1 1 7.072 0l-.548.547A3.374 3.374 0 0 0 14 18.469V19a2 2 0 1 1-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z"/></svg>
            Select a date range and click <strong>Analyze</strong> to get AI insights from your lost deal notes.
          </p>
        </div>
      </div>
    </div>
  `;

  renderDemoDataBanner();

  qs("#dashboard-month-form")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const fd = new FormData(event.currentTarget);
    const month = String(fd.get("month") || "");
    if (!month) return;
    state.dashboardRepId = String(fd.get("repId") || "");
    await loadDashboard(month);
  });

  qs("#dashboard-team-select")?.addEventListener("change", async (e) => {
    state.dashboardTeamId = e.target.value;
    state.dashboardRepId = "";
    await loadDashboard();
  });

  qs("#dashboard-rep-select")?.addEventListener("change", async (e) => {
    state.dashboardRepId = e.target.value;
    await loadDashboard();
  });

  const now = new Date();
  const toMonth   = now.toISOString().slice(0, 7);
  const fromMonth = new Date(now.getFullYear(), now.getMonth() - 2, 1).toISOString().slice(0, 7);
  const aiFromEl = qs("#ai-date-from");
  const aiToEl   = qs("#ai-date-to");
  if (aiFromEl) aiFromEl.value = fromMonth;
  if (aiToEl)   aiToEl.value   = toMonth;

  qs("#ai-run-btn")?.addEventListener("click", async () => {
    const body = qs("#ai-insights-body");
    const runBtn = qs("#ai-run-btn");
    if (!body || !runBtn) return;

    const dateFrom = aiFromEl?.value ? `${aiFromEl.value}-01T00:00:00.000Z` : undefined;
    const dateTo   = aiToEl?.value   ? `${aiToEl.value}-31T23:59:59.999Z`   : undefined;
    const params   = new URLSearchParams();
    if (dateFrom) params.set("dateFrom", dateFrom);
    if (dateTo)   params.set("dateTo",   dateTo);

    runBtn.disabled = true;
    runBtn.textContent = "Analyzing…";
    body.innerHTML = `<div class="ai-insights-loading"><span class="ai-spinner"></span> Reading lost deal notes and finding patterns…</div>`;

    try {
      const result = await api(`/ai/lost-deals-analysis?${params}`);

      if (result.configured === false) {
        body.innerHTML = `
          <div class="ai-not-configured">
            <div class="ai-not-configured-icon">
              <svg width="28" height="28" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>
              </svg>
            </div>
            <div class="ai-not-configured-body">
              <strong>Anthropic API key not configured</strong>
              <p>To use AI-powered insights, add your Anthropic API key in Organization Settings.</p>
              <button class="primary small" id="ai-goto-settings-btn">Go to Settings → Integrations</button>
            </div>
          </div>`;
        qs("#ai-goto-settings-btn")?.addEventListener("click", () => {
          state.settingsPage = "integrations";
          navigateToSettingsPage("integrations");
          switchView("settings");
        });
        return;
      }

      if (!result.analysis || result.dealCount === 0) {
        body.innerHTML = `<p class="ai-insights-placeholder">No lost deals with notes found for this period. Move deals to your Lost stage and add notes to start building insights.</p>`;
        return;
      }

      const { analysis, dealCount } = result;
      const priColor = (p) => p === "high" ? "var(--danger)" : p === "medium" ? "var(--warning)" : "var(--success)";
      const priBg    = (p) => p === "high" ? "var(--danger-bg)" : p === "medium" ? "var(--warning-bg)" : "var(--success-bg)";

      body.innerHTML = `
        <div class="ai-insights-result">
          <div class="ai-summary-box">
            <p class="ai-summary-text">${escHtml(analysis.summary || "")}</p>
            <span class="ai-summary-meta">${dealCount} lost deal${dealCount !== 1 ? "s" : ""} analyzed</span>
          </div>

          ${analysis.themes?.length ? `
          <div class="ai-block">
            <h4 class="ai-block-title">Key Themes</h4>
            <div class="ai-themes">
              ${analysis.themes.map((t) => `
                <div class="ai-theme-row">
                  <div class="ai-theme-bar-wrap">
                    <div class="ai-theme-bar" style="width:${Math.min(t.percentage || 0, 100)}%"></div>
                  </div>
                  <div class="ai-theme-body">
                    <div class="ai-theme-head">
                      <strong>${escHtml(t.name)}</strong>
                      <span class="ai-theme-pct">${t.count} deal${t.count !== 1 ? "s" : ""} · ${t.percentage || 0}%</span>
                    </div>
                    <p class="ai-theme-desc">${escHtml(t.description || "")}</p>
                    ${t.examples?.length ? `<div class="ai-theme-quotes">${t.examples.slice(0, 2).map((q) => `<span class="ai-quote">"${escHtml(q)}"</span>`).join("")}</div>` : ""}
                  </div>
                </div>
              `).join("")}
            </div>
          </div>` : ""}

          ${analysis.trends?.length ? `
          <div class="ai-block">
            <h4 class="ai-block-title">Trends</h4>
            <ul class="ai-trend-list">
              ${analysis.trends.map((t) => `<li>${escHtml(t)}</li>`).join("")}
            </ul>
          </div>` : ""}

          ${analysis.recommendations?.length ? `
          <div class="ai-block">
            <h4 class="ai-block-title">Recommendations</h4>
            <div class="ai-recs">
              ${analysis.recommendations.map((r) => `
                <div class="ai-rec-row">
                  <span class="ai-rec-badge" style="color:${priColor(r.priority)};background:${priBg(r.priority)}">${r.priority}</span>
                  <div class="ai-rec-body">
                    <strong>${escHtml(r.title)}</strong>
                    <p>${escHtml(r.detail)}</p>
                  </div>
                </div>
              `).join("")}
            </div>
          </div>` : ""}
        </div>`;
    } catch (err) {
      body.innerHTML = `<p class="ai-insights-placeholder" style="color:var(--danger)">${escHtml(err.message || "Analysis failed. Check that ANTHROPIC_API_KEY is set on the server.")}</p>`;
    } finally {
      runBtn.disabled = false;
      runBtn.innerHTML = `<svg width="13" height="13" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polygon points="5 3 19 12 5 21 5 3"/></svg> Analyze`;
    }
  });
}

export async function loadDashboard(month = state.dashboardMonth) {
  const params = new URLSearchParams();
  if (month) params.set("month", month);
  if (state.dashboardTeamId) params.set("teamId", state.dashboardTeamId);
  if (state.dashboardRepId) params.set("repId", state.dashboardRepId);
  const query = params.size ? `?${params}` : "";
  const data = await api(`/dashboard/overview${query}`);
  renderDashboard(data);
}
