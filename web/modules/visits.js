// Visits view: filter bar + list, create modal, edit modal, and the
// calendar event-detail popover. App-level helpers (`buildVisitListHtml`,
// `attachVisitListListeners`, `stageAccentVar`, `openVisitDetail`) are
// injected via `setVisitsDeps()`. Deal routing uses the deal-360 module
// directly.
import { qs, views } from "./dom.js";
import { state } from "./state.js";
import { api } from "./api.js";
import { escHtml } from "./utils.js";
import { openDeal360 } from "./deal-360.js";
import { icon } from "./icons.js";

let deps = {
  buildVisitListHtml: () => "",
  attachVisitListListeners: () => {},
  stageAccentVar: () => "--stage-0",
  openVisitDetail: () => {},
  attachOnBehalfOfField: async () => null
};

export function setVisitsDeps(d) {
  deps = { ...deps, ...d };
}

export async function loadVisits() {
  const f = state.visitPage;
  const q = new URLSearchParams();
  if (f.status)          q.set("status",   f.status);
  if (f.repIds?.length)  q.set("repIds",   f.repIds.join(","));
  if (f.dateFrom)        q.set("dateFrom", f.dateFrom + "T00:00:00.000Z");
  if (f.dateTo)          q.set("dateTo",   f.dateTo   + "T23:59:59.999Z");
  const data = await api(`/visits${q.toString() ? "?" + q : ""}`);
  state.cache.visits = data;
  renderVisits(data);
}

export function renderVisits(visits) {
  const { buildVisitListHtml, attachVisitListListeners } = deps;
  const f         = state.visitPage;
  const canFilterReps = state.user?.role !== "REP";
  const allReps   = state.cache.salesReps || [];
  const q         = (f.query || "").toLowerCase();
  const statusLabel = { PLANNED: "Planned", CHECKED_IN: "Active", CHECKED_OUT: "Completed" };

  const total   = visits.length;
  const planned = visits.filter(v => v.status === "PLANNED").length;
  const active  = visits.filter(v => v.status === "CHECKED_IN").length;
  const done    = visits.filter(v => v.status === "CHECKED_OUT").length;

  const chevron = `<svg class="ms-dropdown-chevron" width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true"><path d="M2 4l4 4 4-4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

  const repMsHtml = (canFilterReps && allReps.length > 0) ? (() => {
    const sel = f.repIds || [];
    const allSel = sel.length === 0 || sel.length === allReps.length;
    const btnLabel = allSel ? "All Reps" : sel.length === 1
      ? escHtml(allReps.find(r => r.id === sel[0])?.fullName || "1 rep")
      : `${sel.length} reps`;
    const items = allReps.map(r => `
      <label class="ms-dropdown-item">
        <input type="checkbox" name="repIds" value="${r.id}" ${sel.includes(r.id) ? "checked" : ""}>
        <span class="ms-item-label">${escHtml(r.fullName)}</span>
      </label>`).join("");
    return `<div class="ms-dropdown" id="vp-rep-ms">
      <button type="button" class="ms-dropdown-btn" id="vp-rep-btn">
        <span class="ms-dropdown-label" id="vp-rep-label">${btnLabel}</span>${chevron}
      </button>
      <div class="ms-dropdown-panel" id="vp-rep-panel" hidden>
        <div class="ms-dropdown-header">
          <button type="button" class="ms-select-all" id="vp-rep-select-all">Select all</button>
          <button type="button" class="ms-clear" id="vp-rep-clear">Clear</button>
        </div>
        <div class="ms-dropdown-list">${items}</div>
      </div>
    </div>`;
  })() : "";

  views.visits.innerHTML = `
    <div class="visits-page-header">
      <h3 class="visits-title">${icon('location')} Visits</h3>
      <button type="button" id="add-visit-btn">
        ${icon('location')} Plan Visit
      </button>
    </div>

    <div class="vp-stats-bar">
      <div class="vp-stat"><span class="vp-stat-value">${total}</span><span class="vp-stat-label">${icon('clipboard')} Total</span></div>
      <div class="vp-stat"><span class="vp-stat-value">${planned}</span><span class="vp-stat-label">${icon('calendar')} Planned</span></div>
      <div class="vp-stat vp-stat--active"><span class="vp-stat-value">${active}</span><span class="vp-stat-label">${icon('flame')} Active</span></div>
      <div class="vp-stat vp-stat--done"><span class="vp-stat-value">${done}</span><span class="vp-stat-label">${icon('checkCircle')} Done</span></div>
    </div>

    <div class="vp-filter-bar">
      <div class="vp-search-wrap">
        <svg class="vp-search-icon" width="14" height="14" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
        <input class="vp-search" id="vp-search" placeholder="Search customer, rep, objective…" value="${escHtml(f.query)}" />
      </div>
      <div class="vp-filter-chips">
        ${["PLANNED", "CHECKED_IN", "CHECKED_OUT"].map(s => `
          <button class="vp-chip ${f.status === s ? "vp-chip--active" : ""}" data-vp-status="${s}">
            ${statusLabel[s]}
          </button>
        `).join("")}
      </div>
      ${repMsHtml}
      <div class="vp-date-range">
        <input type="date" class="vp-date-input" id="vp-date-from" value="${f.dateFrom}" title="From" />
        <span class="vp-date-sep">–</span>
        <input type="date" class="vp-date-input" id="vp-date-to" value="${f.dateTo}" title="To" />
      </div>
    </div>

    <div class="visits-outer">
      <div id="vp-list-container">${buildVisitListHtml(visits, q, f.status)}</div>
    </div>
  `;

  attachVisitListListeners(qs("#vp-list-container"));

  views.visits.querySelectorAll("[data-vp-status]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      state.visitPage.status = state.visitPage.status === btn.dataset.vpStatus ? "" : btn.dataset.vpStatus;
      await loadVisits();
    });
  });

  qs("#vp-search")?.addEventListener("input", (e) => {
    state.visitPage.query = e.target.value;
    const container = qs("#vp-list-container");
    if (container) {
      container.innerHTML = buildVisitListHtml(state.cache.visits, e.target.value.toLowerCase(), state.visitPage.status);
      attachVisitListListeners(container);
    }
  });

  qs("#vp-date-from")?.addEventListener("change", async (e) => { state.visitPage.dateFrom = e.target.value; await loadVisits(); });
  qs("#vp-date-to")?.addEventListener("change",   async (e) => { state.visitPage.dateTo   = e.target.value; await loadVisits(); });

  if (canFilterReps && allReps.length > 0) {
    const btn   = qs("#vp-rep-btn");
    const panel = qs("#vp-rep-panel");
    const label = qs("#vp-rep-label");

    const updateRepLabel = () => {
      const sel = state.visitPage.repIds;
      const allSel = sel.length === 0 || sel.length === allReps.length;
      label.textContent = allSel ? "All Reps" : sel.length === 1
        ? (allReps.find(r => r.id === sel[0])?.fullName || "1 rep")
        : `${sel.length} reps`;
    };

    btn?.addEventListener("click", (e) => { e.stopPropagation(); panel.hidden = !panel.hidden; });
    document.addEventListener("click", function closeRepPanel(e) {
      if (!qs("#vp-rep-ms")?.contains(e.target)) { panel.hidden = true; document.removeEventListener("click", closeRepPanel); }
    });

    qs("#vp-rep-select-all")?.addEventListener("click", async () => {
      panel.querySelectorAll("input[type=checkbox]").forEach(cb => cb.checked = true);
      state.visitPage.repIds = [];
      updateRepLabel();
      await loadVisits();
    });

    qs("#vp-rep-clear")?.addEventListener("click", async () => {
      panel.querySelectorAll("input[type=checkbox]").forEach(cb => cb.checked = false);
      state.visitPage.repIds = allReps.map(r => r.id);
      updateRepLabel();
      await loadVisits();
    });

    panel?.querySelectorAll("input[type=checkbox]").forEach(cb => {
      cb.addEventListener("change", async () => {
        const checked = [...panel.querySelectorAll("input[type=checkbox]:checked")].map(c => c.value);
        state.visitPage.repIds = checked.length === allReps.length ? [] : checked;
        updateRepLabel();
        await loadVisits();
      });
    });
  }

  qs("#add-visit-btn")?.addEventListener("click", () => openVisitCreateModal());
}

export function openVisitCreateModal(dateTime) {
  const modal = qs("#visit-create-modal");
  if (!modal) return;
  const inp = modal.querySelector("#visit-customer-input");
  const hid = modal.querySelector("#visit-customer-id");
  const lst = modal.querySelector("#visit-customer-list");
  if (inp) inp.value = "";
  if (hid) hid.value = "";
  if (lst) lst.hidden = true;
  const dealLabel  = modal.querySelector("#visit-deal-label");
  const dealSelect = modal.querySelector("#visit-deal-select");
  if (dealLabel)  dealLabel.hidden = true;
  if (dealSelect) dealSelect.innerHTML = `<option value="">— No deal —</option>`;
  const now = new Date();
  now.setSeconds(0, 0);
  const nowLocal = new Date(now.getTime() - now.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
  const base = dateTime ? new Date(dateTime) : new Date();
  base.setSeconds(0, 0);
  const local = new Date(base.getTime() - base.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
  const plannedAtInput = modal.querySelector("#visit-planned-at");
  plannedAtInput.min   = nowLocal;
  plannedAtInput.value = local < nowLocal ? nowLocal : local;
  const siteLat = modal.querySelector("#visit-site-lat");
  const siteLng = modal.querySelector("#visit-site-lng");
  const locPreview = modal.querySelector("#visit-location-preview");
  const pickBtn = modal.querySelector("#visit-pick-location-btn");
  if (siteLat) siteLat.value = "";
  if (siteLng) siteLng.value = "";
  if (locPreview) locPreview.hidden = true;
  if (pickBtn) pickBtn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/></svg> Pick on Map`;
  const plannedRadio = modal.querySelector('[name="visitType"][value="PLANNED"]');
  if (plannedRadio) plannedRadio.checked = true;
  syncVisitPlannedAtRequired(modal);
  modal.querySelector("#visit-form")?.reset && false;
  modal.hidden = false;
  const form = modal.querySelector("#visit-form");
  const fields = form?.querySelector(".visit-modal-fields");
  if (fields && deps.attachOnBehalfOfField) {
    deps.attachOnBehalfOfField(fields).catch(() => {});
  }
}

export function closeVisitCreateModal() {
  const modal = qs("#visit-create-modal");
  if (modal) modal.hidden = true;
}

export function openVisitEditModal(visit) {
  const modal = qs("#visit-edit-modal");
  if (!modal) return;
  qs("#visit-edit-id").value = visit.id;
  if (visit.plannedAt) {
    const d = new Date(visit.plannedAt);
    const local = new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
    qs("#visit-edit-planned-at").value = local;
  } else {
    qs("#visit-edit-planned-at").value = "";
  }
  qs("#visit-edit-objective").value = visit.objective || "";
  const latEl = qs("#visit-edit-site-lat");
  const lngEl = qs("#visit-edit-site-lng");
  const preview = qs("#visit-edit-location-preview");
  const locText = qs("#visit-edit-location-text");
  const pickBtn = qs("#visit-edit-pick-location-btn");
  if (visit.siteLat != null && visit.siteLng != null) {
    latEl.value = visit.siteLat;
    lngEl.value = visit.siteLng;
    preview.hidden = false;
    locText.textContent = `${Number(visit.siteLat).toFixed(6)}, ${Number(visit.siteLng).toFixed(6)}`;
    pickBtn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/></svg> Change Location`;
  } else {
    latEl.value = "";
    lngEl.value = "";
    preview.hidden = true;
    pickBtn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/></svg> Pick on Map`;
  }
  modal.hidden = false;
}

export function closeVisitEditModal() {
  const modal = qs("#visit-edit-modal");
  if (modal) modal.hidden = true;
}

export function syncVisitPlannedAtRequired(modal) {
  const visitType = modal.querySelector('[name="visitType"]:checked')?.value;
  const plannedAtInput = modal.querySelector("#visit-planned-at");
  const label = modal.querySelector("#visit-planned-at-label");
  if (visitType === "PLANNED") {
    plannedAtInput.required = true;
    if (!label.querySelector(".req-star")) {
      const star = document.createElement("span");
      star.className = "req-star";
      star.textContent = " *";
      const textSpan = label.querySelector(".form-label-text");
      (textSpan || label).appendChild(star);
    }
  } else {
    plannedAtInput.required = false;
    label.querySelector(".req-star")?.remove();
  }
}

export function showEventDetail(ev, anchorEl) {
  const { stageAccentVar, openVisitDetail } = deps;
  qs("#cal-event-popover")?.remove();

  const at = new Date(ev.at);
  const dateStr = at.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", year: "numeric" });
  const timeStr = at.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
  const typeLabel = ev.type === "visit" ? "Visit" : "Deal";
  const titleCore = ev.title.replace(/^(Visit|Deal): /, "");

  const statusLabel = ev.status
    ? { PLANNED: "Planned", CHECKED_IN: "Checked-in", CHECKED_OUT: "Checked-out",
        OPEN: "Open", WON: "Won", LOST: "Lost" }[ev.status] ?? ev.status.replace(/_/g, " ")
    : "";
  const statusColor = ev.type === "deal"
    ? ev.status === "WON" ? "green" : ev.status === "LOST" ? "red" : ev.color
    : ev.color;

  const stageAccent = (() => {
    if (!ev.stage) return null;
    const stages = state.cache.dealStages || [];
    let ntIdx = 0;
    for (const s of stages) {
      const v = stageAccentVar(s.stageName, ntIdx);
      if (s.id === ev.stage.id) return v;
      if (v !== "--stage-3" && v !== "--stage-4") ntIdx++;
    }
    return stageAccentVar(ev.stage.name, 0);
  })();

  const rows = [
    `<div class="ced-row"><span class="ced-label">Date</span><span class="ced-value">${dateStr}</span></div>`,
    `<div class="ced-row"><span class="ced-label">Time</span><span class="ced-value">${timeStr}</span></div>`,
    ev.customer ? `<div class="ced-row"><span class="ced-label">Customer</span><span class="ced-value">${escHtml(ev.customer.name)}</span></div>` : "",
    ev.owner    ? `<div class="ced-row"><span class="ced-label">${ev.type === "deal" ? "Owner" : "Sales Rep"}</span><span class="ced-value">${escHtml(ev.owner.name)}</span></div>` : "",
    ev.stage && stageAccent ? `<div class="ced-row"><span class="ced-label">Stage</span><span class="ced-value"><span class="ced-stage-badge" style="--sa:var(${stageAccent})">${escHtml(ev.stage.name)}</span></span></div>` : "",
    statusLabel ? `<div class="ced-row"><span class="ced-label">Status</span><span class="ced-value"><span class="ced-status ced-status--${statusColor}">${statusLabel}</span></span></div>` : "",
  ].filter(Boolean).join("");

  document.body.insertAdjacentHTML("beforeend", `
    <div id="cal-event-popover" class="cal-event-popover">
      <div class="ced-header">
        <span class="ced-type-badge ced-type--${ev.type}">${typeLabel}</span>
        <span class="ced-title">${escHtml(titleCore)}</span>
        <button class="ced-close" id="ced-close-btn" aria-label="Close">${icon('x', 14)}</button>
      </div>
      <div class="ced-body">${rows}</div>
      <div class="ced-footer">
        <button class="ced-action" data-goto="${ev.type === "visit" ? "visits" : "deals"}">
          View ${typeLabel} →
        </button>
      </div>
    </div>
  `);

  const popover = qs("#cal-event-popover");
  const rect = anchorEl.getBoundingClientRect();
  const pw = 272;
  const ph = 220;
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  let left = rect.left;
  let top  = rect.bottom + 6 + window.scrollY;
  if (left + pw > vw - 8) left = vw - pw - 8;
  if (rect.bottom + 6 + ph > vh) top = rect.top - ph - 6 + window.scrollY;
  if (left < 8) left = 8;
  popover.style.left = `${left}px`;
  popover.style.top  = `${top}px`;

  const dismiss = () => popover.remove();

  qs("#ced-close-btn")?.addEventListener("click", (e) => { e.stopPropagation(); dismiss(); });

  popover.querySelector(".ced-action")?.addEventListener("click", () => {
    dismiss();
    if (ev.type === "visit") {
      qs(`.nav-btn[data-view="visits"]`)?.click();
      openVisitDetail(ev.entityId);
    } else {
      openDeal360(ev.entityId);
    }
  });

  setTimeout(() => {
    document.addEventListener("click", function outsideHandler(e) {
      if (!popover.contains(e.target)) {
        dismiss();
        document.removeEventListener("click", outsideHandler);
      }
    });
  }, 0);

  document.addEventListener("keydown", function escHandler(e) {
    if (e.key === "Escape") { dismiss(); document.removeEventListener("keydown", escHandler); }
  }, { once: true });
}
