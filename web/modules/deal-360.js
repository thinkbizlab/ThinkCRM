// Deal 360 detail page: header, KPI strip, and tab panes
// (Progress / Customer / Visits / Changelog). App-level helpers
// (`asMoney`, `avatarColor`, `c360Initials`, navigation, toasts) are
// injected via `setDeal360Deps()`.
import { views, switchView, setStatus } from "./dom.js";
import { state } from "./state.js";
import { api } from "./api.js";
import { escHtml, fmtDateTime } from "./utils.js";
import { openCustomer360 } from "./customer-360.js";
import { icon } from "./icons.js";

let deps = {
  asMoney: (v) => String(v),
  avatarColor: () => "#ccc",
  c360Initials: (n) => (n || "?").slice(0, 2).toUpperCase(),
  navigateToView: () => {},
  renderDeals: () => {},
  showToast: () => {},
  openVisitDetail: () => {}
};

export function setDeal360Deps(d) {
  deps = { ...deps, ...d };
}

state.deal360 = null;

export function navigateToDeal360(dealNo) {
  const route = `/deals/${encodeURIComponent(dealNo)}`;
  if (window.location.pathname !== route) {
    window.history.pushState({ dealNo }, "", route);
  }
}

export function syncDeal360FromLocation() {
  const match = window.location.pathname.match(/^\/deals\/([^/]+)$/);
  return match ? decodeURIComponent(match[1]) : null;
}

export async function openDeal360(dealId, dealNo) {
  const urlNo = dealNo || dealId;
  navigateToDeal360(urlNo);
  switchView("deals");
  setStatus("Loading deal…");
  try {
    const [deal, progress, visits] = await Promise.all([
      api(`/deals/${dealId}`),
      api(`/deals/${dealId}/progress-updates`),
      api(`/visits?dealId=${encodeURIComponent(dealId)}`)
    ]);
    let changelog = [];
    const role = state.user?.role;
    const canSeeChangelog = ["ADMIN", "DIRECTOR", "MANAGER"].includes(role);
    if (canSeeChangelog) {
      try {
        changelog = await api(`/changelogs?entityType=DEAL&entityId=${encodeURIComponent(dealId)}&limit=50`);
      } catch { /* role may not be permitted */ }
    }
    state.deal360 = { deal, progress, visits, changelog, activeTab: "progress", canSeeChangelog };
    setStatus("");
    renderDeal360();
  } catch (error) {
    setStatus(error.message, true);
  }
}

function renderDeal360TabContent(d360) {
  const { deal, progress, visits, changelog, activeTab } = d360;
  const { avatarColor, c360Initials } = deps;

  // ── Progress Updates ────────────────────────────────────────────────────────
  if (activeTab === "progress") {
    const attachmentSvg = `<svg width="13" height="13" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"/></svg>`;
    const renderAttachments = (urls) => {
      const list = Array.isArray(urls) ? urls : (urls ? [urls] : []);
      if (!list.length) return "";
      return list.map((url) => {
        const isR2 = url.startsWith("r2://");
        const fileName = url.split("/").pop() || "Attachment";
        const displayName = fileName.replace(/^\d+_/, "");
        if (isR2) {
          return `<button class="d360-tl-attachment d360-tl-attachment--btn" data-r2ref="${escHtml(url)}" title="Download attachment">
            ${attachmentSvg} ${escHtml(displayName)}
          </button>`;
        }
        return `<a class="d360-tl-attachment" href="${escHtml(url)}" target="_blank" rel="noopener">
          ${attachmentSvg} ${escHtml(displayName)}
        </a>`;
      }).join("");
    };

    const timelineHtml = progress.length
      ? `<div class="d360-timeline">
          ${progress.map((u) => {
            const dt = new Date(u.createdAt);
            return `
              <div class="d360-tl-item">
                <div class="d360-tl-avatar" style="background:${avatarColor(u.createdBy?.fullName || '?')}">${c360Initials(u.createdBy?.fullName || '?')}</div>
                <div class="d360-tl-body">
                  <div class="d360-tl-meta">
                    <span class="d360-tl-author">${escHtml(u.createdBy?.fullName || '—')}</span>
                    <span class="d360-tl-date">${fmtDateTime(dt)}</span>
                  </div>
                  <div class="d360-tl-note">${escHtml(u.note)}</div>
                  ${renderAttachments(u.attachmentUrls)}
                </div>
              </div>`;
          }).join("")}
        </div>`
      : `<div class="c360-empty" style="padding:var(--sp-6) 0"><div class="c360-empty-icon">${icon('pen')}</div>No progress updates yet.</div>`;

    return `
      <div class="d360-progress-wrap">
        <form class="d360-update-form" id="d360-update-form" data-deal-id="${escHtml(deal.id)}">
          <div class="d360-update-form-inner">
            <div class="d360-update-form-avatar" style="background:${avatarColor(state.user?.fullName || '?')}">${c360Initials(state.user?.fullName || '?')}</div>
            <div class="d360-update-form-body">
              <textarea
                class="d360-update-textarea"
                id="d360-update-note"
                placeholder="Write a progress update…"
                rows="3"
                required
              ></textarea>
              <div class="d360-update-file-row" id="d360-file-row">
                <label class="d360-file-pick-btn" id="d360-file-pick-label" title="Attach up to 5 files">
                  <svg width="14" height="14" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"/></svg>
                  Attach files
                  <input type="file" id="d360-file-input" class="d360-file-input-hidden" multiple />
                </label>
                <div class="d360-file-chips" id="d360-file-chips"></div>
              </div>
              <div class="d360-update-form-actions">
                <button type="submit" class="d360-update-submit btn-primary" id="d360-update-submit">
                  <svg width="14" height="14" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>
                  Post update
                </button>
              </div>
            </div>
          </div>
        </form>
        ${timelineHtml}
      </div>`;
  }

  // ── Customer Info ───────────────────────────────────────────────────────────
  if (activeTab === "customer") {
    const c = deal.customer;
    if (!c) return `<div class="c360-empty"><div class="c360-empty-icon">${icon('user')}</div>No customer linked.</div>`;
    const contacts = c.contacts ?? [];
    const addresses = c.addresses ?? [];
    return `
      <div class="d360-customer-wrap">
        <div class="d360-cust-header">
          <div class="c360-avatar" style="background:${avatarColor(c.name)}">${c360Initials(c.name)}</div>
          <div class="d360-cust-info">
            <div class="d360-cust-name">${escHtml(c.name)}</div>
            <div class="d360-cust-meta">
              <span class="c360-code">${escHtml(c.customerCode)}</span>
              ${c.taxId ? `<span class="c360-meta-sep">·</span><span class="c360-meta-item">Tax: ${escHtml(c.taxId)}</span>` : ""}
              ${c.paymentTerm ? `<span class="c360-meta-sep">·</span><span class="c360-meta-item">${escHtml(c.paymentTerm.code)} · ${c.paymentTerm.dueDays}d</span>` : ""}
            </div>
          </div>
          <button class="d360-open-cust ghost" data-id="${c.id}" data-code="${escHtml(c.customerCode)}">
            <svg width="12" height="12" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>
            View full profile
          </button>
        </div>

        ${contacts.length > 0 ? `
          <div class="d360-section-label">Contacts</div>
          <div style="border:1px solid var(--border);border-radius:var(--r-md);overflow:hidden">
            ${contacts.map((ct) => `
              <div class="c360-contact-row">
                <div class="c360-contact-avatar" style="background:${avatarColor(ct.name)}">${c360Initials(ct.name)}</div>
                <div>
                  <div class="c360-contact-name">${escHtml(ct.name)}</div>
                  <div class="c360-contact-pos">${escHtml(ct.position || "")}</div>
                  <div class="cpop-channels">
                    ${ct.tel      ? `<span class="cpop-channel"><svg width="11" height="11" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07A19.5 19.5 0 0 1 4.69 12 19.79 19.79 0 0 1 1.62 3.48 2 2 0 0 1 3.62 1.27h3a2 2 0 0 1 2 1.72c.127.96.361 1.903.7 2.81a2 2 0 0 1-.45 2.11L7.91 8.91a16 16 0 0 0 6.18 6.18l.97-.97a2 2 0 0 1 2.11-.45c.907.339 1.85.573 2.81.7A2 2 0 0 1 22 16.92z"/></svg>${escHtml(ct.tel)}</span>` : ""}
                    ${ct.email    ? `<span class="cpop-channel"><svg width="11" height="11" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"/><polyline points="22,6 12,13 2,6"/></svg>${escHtml(ct.email)}</span>` : ""}
                    ${ct.lineId   ? `<span class="cpop-channel">LINE: ${escHtml(ct.lineId)}</span>` : ""}
                  </div>
                </div>
              </div>`).join("")}
          </div>` : ""}

        ${addresses.length > 0 ? `
          <div class="d360-section-label">Addresses</div>
          <div class="c360-addresses-grid">
            ${addresses.map((a) => `
              <div class="c360-address-card">
                <div class="c360-address-labels">
                  ${a.isDefaultBilling  ? '<span class="c360-address-badge">Billing</span>'  : ""}
                  ${a.isDefaultShipping ? '<span class="c360-address-badge">Shipping</span>' : ""}
                </div>
                <div class="c360-address-line">
                  ${escHtml(a.addressLine1)}${a.city ? ", " + escHtml(a.city) : ""}${a.province ? ", " + escHtml(a.province) : ""}${a.country ? ", " + escHtml(a.country) : ""}${a.postalCode ? " " + escHtml(a.postalCode) : ""}
                </div>
                ${a.latitude != null && a.longitude != null
                  ? `<a class="c360-address-map" href="https://maps.google.com/?q=${a.latitude},${a.longitude}" target="_blank" rel="noopener">
                      <svg width="12" height="12" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/></svg>
                      Open in Maps
                    </a>`
                  : ""}
              </div>`).join("")}
          </div>` : ""}
      </div>`;
  }

  // ── Visits ──────────────────────────────────────────────────────────────────
  if (activeTab === "visits") {
    if (!visits.length) {
      return `<div class="c360-empty"><div class="c360-empty-icon">${icon('location')}</div>No visits linked to this deal yet.</div>`;
    }
    return `
      <div style="border:1px solid var(--border);border-radius:var(--r-md);overflow:hidden;margin-top:var(--sp-4)">
        ${visits.map((v) => {
          const vDate = new Date(v.plannedAt || v.createdAt);
          const statusColor = v.status === "CHECKED_OUT" ? "won" : v.status === "CHECKED_IN" ? "open" : "muted";
          return `
            <div class="c360-visit-row c360-visit-row--clickable" data-visit-id="${escHtml(v.id)}" role="button" tabindex="0">
              <div class="c360-visit-date">
                <strong>${vDate.getDate()}</strong>
                <span>${vDate.toLocaleDateString("en-GB", { month: "short", year: "2-digit" })}</span>
              </div>
              <div class="c360-visit-body">
                <div class="c360-visit-rep">${escHtml(v.rep?.fullName ?? "—")}</div>
                ${v.objective ? `<div class="c360-visit-notes">${escHtml(v.objective)}</div>` : ""}
                ${v.result ? `<div class="c360-visit-notes" style="color:var(--text-muted)">${escHtml(v.result)}</div>` : ""}
              </div>
              <div style="display:flex;flex-direction:column;align-items:flex-end;gap:var(--sp-1)">
                <span class="badge badge--${statusColor}">${v.status}</span>
                <span class="muted small">${v.visitType}</span>
              </div>
            </div>`;
        }).join("")}
      </div>`;
  }

  // ── Changelog ───────────────────────────────────────────────────────────────
  if (activeTab === "changelog") {
    if (!changelog.length) {
      return `<div class="c360-empty"><div class="c360-empty-icon">${icon('clipboard')}</div>No changelog entries found.</div>`;
    }
    const actionIcon = (action) => {
      if (action === "CREATE") return `<span class="d360-cl-action d360-cl-action--create">Created</span>`;
      if (action === "DELETE") return `<span class="d360-cl-action d360-cl-action--delete">Deleted</span>`;
      return `<span class="d360-cl-action d360-cl-action--update">Updated</span>`;
    };
    const diffFields = (before, after) => {
      if (!before || !after) return [];
      const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
      const changes = [];
      for (const k of keys) {
        const bv = before[k]; const av = after[k];
        if (JSON.stringify(bv) !== JSON.stringify(av)) {
          changes.push({ key: k, before: bv, after: av });
        }
      }
      return changes;
    };
    return `
      <div class="d360-timeline">
        ${changelog.map((entry) => {
          const dt = new Date(entry.createdAt);
          const diffs = diffFields(entry.beforeJson, entry.afterJson);
          return `
            <div class="d360-tl-item">
              <div class="d360-tl-avatar d360-tl-avatar--sys" style="background:${avatarColor(entry.changedBy?.fullName || 'System')}">${c360Initials(entry.changedBy?.fullName || 'SYS')}</div>
              <div class="d360-tl-body">
                <div class="d360-tl-meta">
                  <span class="d360-tl-author">${escHtml(entry.changedBy?.fullName || 'System')}</span>
                  ${actionIcon(entry.action)}
                  <span class="d360-tl-date">${fmtDateTime(dt)}</span>
                </div>
                ${diffs.length > 0 ? `
                  <div class="d360-cl-diffs">
                    ${diffs.map(({ key, before: bv, after: av }) => `
                      <div class="d360-cl-diff-row">
                        <span class="d360-cl-field">${escHtml(key)}</span>
                        <span class="d360-cl-before">${escHtml(String(bv ?? "—"))}</span>
                        <svg width="10" height="10" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="5" y1="12" x2="19" y2="12"/><polyline points="12 5 19 12 12 19"/></svg>
                        <span class="d360-cl-after">${escHtml(String(av ?? "—"))}</span>
                      </div>`).join("")}
                  </div>` : ""}
              </div>
            </div>`;
        }).join("")}
      </div>`;
  }

  return "";
}

export function renderDeal360() {
  const d360 = state.deal360;
  if (!d360) return;
  const { asMoney, avatarColor, c360Initials, navigateToView, renderDeals } = deps;
  const { deal, progress, visits, changelog, canSeeChangelog } = d360;
  const c = deal.customer;

  const statusBadgeClass = deal.status === "WON" ? "won" : deal.status === "LOST" ? "lost" : "open";
  const isClosed = deal.status === "WON" || deal.status === "LOST";

  const tabs = [
    { key: "progress", label: "Progress",  count: progress.length },
    { key: "customer", label: "Customer",  count: null },
    { key: "visits",   label: "Visits",    count: visits.length },
    ...(canSeeChangelog ? [{ key: "changelog", label: "Changelog", count: changelog.length }] : [])
  ];

  views.deals.innerHTML = `
    <div class="master-outer">
      <div class="c360-wrap">

        <div class="c360-breadcrumb">
          <button class="c360-back-btn" id="d360-back">
            <svg width="14" height="14" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"/></svg>
            Deals
          </button>
          <span class="c360-breadcrumb-sep">›</span>
          <span>${escHtml(deal.dealNo)} — ${escHtml(deal.dealName)}</span>
        </div>

        <div class="c360-header">
          <div class="c360-header-left">
            <div class="d360-deal-icon">
              <svg width="22" height="22" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/></svg>
            </div>
            <div class="c360-header-info">
              <h2 class="c360-name">${escHtml(deal.dealName)}</h2>
              <div class="c360-meta">
                <span class="c360-code">${escHtml(deal.dealNo)}</span>
                <span class="c360-meta-sep">·</span>
                <span class="badge badge--${statusBadgeClass}">${deal.status}</span>
                <span class="c360-meta-sep">·</span>
                <span class="c360-meta-item">${escHtml(deal.stage?.stageName || "—")}</span>
                <span class="c360-meta-sep">·</span>
                <span class="c360-meta-item">${escHtml(deal.owner?.fullName || "Unassigned")}</span>
              </div>
            </div>
          </div>
        </div>

        <div class="c360-kpi-strip">
          <div class="c360-kpi">
            <p class="c360-kpi-label">Value</p>
            <p class="c360-kpi-value" style="font-size:1.1rem">${asMoney(deal.estimatedValue)}</p>
          </div>
          <div class="c360-kpi">
            <p class="c360-kpi-label">Stage</p>
            <p class="c360-kpi-value" style="font-size:0.95rem;font-weight:600">${escHtml(deal.stage?.stageName || "—")}</p>
          </div>
          <div class="c360-kpi">
            <p class="c360-kpi-label">Follow-up</p>
            <p class="c360-kpi-value" style="font-size:0.9rem${!isClosed && deal.is_overdue_followup ? ";color:var(--danger)" : ""}">
              ${deal.followUpAt ? new Date(deal.followUpAt).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" }) : "—"}
            </p>
          </div>
          ${isClosed ? `
            <div class="c360-kpi">
              <p class="c360-kpi-label">Closed</p>
              <p class="c360-kpi-value" style="font-size:0.9rem">${deal.closedAt ? new Date(deal.closedAt).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" }) : "—"}</p>
            </div>` : ""}
          <div class="c360-kpi">
            <p class="c360-kpi-label">Customer</p>
            <p class="c360-kpi-value" style="font-size:0.85rem;font-weight:600">${escHtml(c?.name || "—")}</p>
          </div>
          <div class="c360-kpi">
            <p class="c360-kpi-label">Visits</p>
            <p class="c360-kpi-value">${visits.length}</p>
          </div>
          <div class="c360-kpi">
            <p class="c360-kpi-label">Updates</p>
            <p class="c360-kpi-value">${progress.length}</p>
          </div>
        </div>

        ${deal.lostNote ? `
          <div class="d360-lost-note">
            <svg width="14" height="14" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
            <span>Lost reason: ${escHtml(deal.lostNote)}</span>
          </div>` : ""}

        <div class="c360-tab-bar">
          ${tabs.map((t) => `
            <button class="c360-tab-btn ${d360.activeTab === t.key ? "active" : ""}" data-tab="${t.key}">
              ${t.label}
              ${t.count !== null ? `<span class="c360-tab-count">${t.count}</span>` : ""}
            </button>`).join("")}
        </div>

        <div class="c360-tab-content" id="d360-tab-content">
          ${renderDeal360TabContent(d360)}
        </div>
      </div>
    </div>
  `;

  views.deals.querySelector("#d360-back")?.addEventListener("click", () => {
    state.deal360 = null;
    navigateToView("deals");
    switchView("deals");
    if (state.cache.kanban) renderDeals(state.cache.kanban);
  });

  views.deals.querySelectorAll(".c360-tab-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      state.deal360.activeTab = btn.dataset.tab;
      views.deals.querySelectorAll(".c360-tab-btn").forEach((b) => b.classList.toggle("active", b.dataset.tab === btn.dataset.tab));
      const content = views.deals.querySelector("#d360-tab-content");
      if (content) content.innerHTML = renderDeal360TabContent(state.deal360);
      bindDeal360TabListeners();
    });
  });

  bindDeal360TabListeners();
}

function bindDeal360TabListeners() {
  const { showToast } = deps;

  // Customer tab — open c360
  views.deals.querySelectorAll(".d360-open-cust").forEach((btn) => {
    btn.addEventListener("click", () => openCustomer360(btn.dataset.id, btn.dataset.code));
  });

  // Visits tab — open visit-detail drawer
  views.deals.querySelectorAll(".c360-visit-row--clickable").forEach((row) => {
    const open = () => {
      const id = row.dataset.visitId;
      if (id) deps.openVisitDetail(id);
    };
    row.addEventListener("click", open);
    row.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); open(); }
    });
  });

  // r2:// attachment download buttons — fetch presigned URL on demand
  views.deals.querySelectorAll(".d360-tl-attachment--btn").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const ref = btn.dataset.r2ref;
      if (!ref) return;
      btn.disabled = true;
      const origHtml = btn.innerHTML;
      btn.textContent = "Fetching…";
      try {
        const result = await api(`/storage/r2/presign-download?objectKey=${encodeURIComponent(ref)}`);
        window.open(result.downloadUrl, "_blank", "noopener");
      } catch (err) {
        showToast(err.message || "Could not fetch download URL", "error");
      } finally {
        btn.innerHTML = origHtml;
        btn.disabled = false;
      }
    });
  });

  // Progress update form
  const form = views.deals.querySelector("#d360-update-form");
  if (!form) return;

  const fileInput  = form.querySelector("#d360-file-input");
  const fileChips  = form.querySelector("#d360-file-chips");
  const submitBtn  = form.querySelector("#d360-update-submit");

  const MAX_FILES = 5;

  const renderFileChips = () => {
    if (!fileChips) return;
    const files = Array.from(fileInput?.files ?? []);
    fileChips.innerHTML = files.map((f, i) => `
      <div class="d360-file-chip">
        <svg width="12" height="12" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"/></svg>
        <span class="d360-file-name">${escHtml(f.name)}</span>
        <button type="button" class="d360-file-remove" data-idx="${i}" aria-label="Remove file">
          <svg width="11" height="11" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
        </button>
      </div>`).join("");
    fileChips.querySelectorAll(".d360-file-remove").forEach((btn) => {
      btn.addEventListener("click", () => {
        const idx = parseInt(btn.dataset.idx, 10);
        const dt = new DataTransfer();
        Array.from(fileInput.files).forEach((f, i) => { if (i !== idx) dt.items.add(f); });
        fileInput.files = dt.files;
        renderFileChips();
      });
    });
  };

  fileInput?.addEventListener("change", () => {
    if (fileInput.files.length > MAX_FILES) {
      showToast(`You can attach up to ${MAX_FILES} files at a time.`, "error");
      fileInput.value = "";
      renderFileChips();
      return;
    }
    renderFileChips();
  });

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const dealId   = form.dataset.dealId;
    const noteEl   = form.querySelector("#d360-update-note");
    const noteText = noteEl?.value?.trim();
    if (!noteText) { noteEl?.focus(); return; }

    submitBtn.disabled = true;
    const origLabel = submitBtn.innerHTML;
    submitBtn.innerHTML = `<svg width="14" height="14" class="spin" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-6.219-8.56"/></svg> Posting…`;

    try {
      const files = Array.from(fileInput?.files ?? []);
      const attachmentUrls = [];

      for (const file of files) {
        const presign = await api("/storage/r2/presign-upload", {
          method: "POST",
          body: {
            entityType: "DEAL",
            entityId: dealId,
            filename: file.name,
            contentType: file.type || "application/octet-stream"
          }
        });

        const uploadResp = await fetch(presign.uploadUrl, {
          method: "PUT",
          headers: { "content-type": file.type || "application/octet-stream" },
          body: file
        });
        if (!uploadResp.ok) throw new Error(`File upload failed (HTTP ${uploadResp.status})`);

        attachmentUrls.push(presign.objectRef);
      }

      await api(`/deals/${dealId}/progress-updates`, {
        method: "POST",
        body: { note: noteText, ...(attachmentUrls.length ? { attachmentUrls } : {}) }
      });

      const updated = await api(`/deals/${dealId}/progress-updates`);
      state.deal360.progress = updated;
      state.deal360.activeTab = "progress";

      noteEl.value = "";
      if (fileInput) fileInput.value = "";
      renderFileChips();

      const content = views.deals.querySelector("#d360-tab-content");
      if (content) content.innerHTML = renderDeal360TabContent(state.deal360);
      bindDeal360TabListeners();

      showToast("Progress update posted.", "success");
    } catch (err) {
      showToast(err.message || "Failed to post update", "error");
    } finally {
      submitBtn.disabled = false;
      submitBtn.innerHTML = origLabel;
    }
  });
}
