// Visits view: filter bar + list, visit detail drawer, create/edit modals,
// and the calendar event-detail popover. Route-specific helpers stay here so
// the base app shell does not ship visit UI until it is needed.
import { qs, views } from "./dom.js";
import { state } from "./state.js";
import { api } from "./api.js";
import { escHtml, asDate } from "./utils.js";
import { icon } from "./icons.js";

let deps = {
  stageAccentVar: () => "--stage-0",
  avatarColor: () => "var(--surface-soft)",
  repAvatarHtml: (name) => fallbackRepAvatarHtml(name),
  setStatus: () => {},
  openVoiceNoteDialog: async () => {},
  openMapPicker: async () => {},
  openDeal360: async () => {},
  openProspectDetail: () => {},
  loadMyTasks: async () => {},
  attachOnBehalfOfField: async () => null
};

export function setVisitsDeps(d) {
  deps = { ...deps, ...d };
}

function fallbackRepAvatarHtml(name = "") {
  const initials = (name || "?")
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((word) => word[0]?.toUpperCase() || "")
    .join("") || "?";
  return escHtml(initials);
}

function getVisitDetailPanel() {
  return qs("#visit-detail-panel");
}

function getVisitDetailBody() {
  return qs("#visit-detail-body");
}

export async function loadVisits() {
  const f = state.visitPage;
  const q = new URLSearchParams();
  if (f.status) q.set("status", f.status);
  if (f.repIds?.length) q.set("repIds", f.repIds.join(","));
  if (f.dateFrom) q.set("dateFrom", `${f.dateFrom}T00:00:00.000Z`);
  if (f.dateTo) q.set("dateTo", `${f.dateTo}T23:59:59.999Z`);
  const data = await api(`/visits${q.toString() ? `?${q}` : ""}`);
  state.cache.visits = data;
  renderVisits(data);
}

function buildVisitListHtml(visits, q) {
  const { avatarColor, repAvatarHtml } = deps;
  const statusLabel = { PLANNED: "Planned", CHECKED_IN: "Active", CHECKED_OUT: "Completed" };
  const statusCls = { PLANNED: "", CHECKED_IN: "chip-primary", CHECKED_OUT: "chip-success" };
  const statusOrder = { CHECKED_IN: 0, PLANNED: 1, CHECKED_OUT: 2 };
  const filtered = (
    q
      ? visits.filter((visit) =>
        visit.customer?.name?.toLowerCase().includes(q) ||
        visit.rep?.fullName?.toLowerCase().includes(q) ||
        visit.objective?.toLowerCase().includes(q) ||
        visit.result?.toLowerCase().includes(q)
      )
      : visits
  ).slice().sort((a, b) => (statusOrder[a.status] ?? 1) - (statusOrder[b.status] ?? 1));

  if (!filtered.length) {
    return `
      <div class="empty-state">
        <svg class="empty-icon-svg" width="40" height="40" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/></svg>
        <div><strong>${q ? "No visits match your filters" : "No visits yet"}</strong><p>${q ? "Try adjusting the search or status filter." : "Add planned or drop-in visits to get started."}</p></div>
      </div>`;
  }

  return `<div class="vp-list">${filtered.map((visit) => {
    const isOwn = visit.rep?.id === state.user?.id;
    const avatarBg = avatarColor(visit.rep?.fullName || "");
    const avatarMarkup = repAvatarHtml(visit.rep?.fullName || "", visit.rep?.avatarUrl);
    return `
      <div class="vp-card status-${visit.status}" data-visit-id="${visit.id}">
        <div class="vp-card-status-bar"></div>
        <div class="vp-card-body">
          <div class="vp-card-top">
            <div class="vp-card-customer">${
              visit.customer
                ? escHtml(visit.customer.name)
                : visit.prospect
                  ? `<button type="button" class="prospect-badge prospect-badge-btn" data-prospect-id="${escHtml(visit.prospect.id)}" title="Open prospect — link to a customer or archive">Prospect: ${escHtml(visit.prospect.displayName || "(unnamed)")}</button>`
                  : "—"
            }</div>
            <div class="vp-card-chips">
              ${visit.visitNo ? `<span class="chip chip--visitno">${escHtml(visit.visitNo)}</span>` : ""}
              <span class="chip ${statusCls[visit.status]}">${statusLabel[visit.status] || visit.status}</span>
            </div>
          </div>
          <div class="vp-card-meta">
            <div class="vp-card-rep">
              <span class="vp-rep-avatar" style="${visit.rep?.avatarUrl ? "overflow:hidden" : `background:${avatarBg}`}">${avatarMarkup}</span>
              <span class="vp-rep-name">${escHtml(visit.rep?.fullName || "—")}${isOwn ? " (me)" : ""}</span>
            </div>
            <span class="vp-card-date">
              <svg width="12" height="12" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="4" width="18" height="18" rx="2" ry="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>
              ${asDate(visit.plannedAt)}
            </span>
            ${visit.deal ? `<span class="vp-deal-link muted">Deal: ${escHtml(visit.deal.name || visit.deal.id)}</span>` : ""}
          </div>
          ${visit.objective ? `<div class="vp-card-objective">${escHtml(visit.objective)}</div>` : ""}
          ${visit.result ? `<div class="vp-card-result"><svg width="12" height="12" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="20 6 9 17 4 12"/></svg>${escHtml(visit.result)}</div>` : ""}
          <div class="vp-card-actions">
            <button type="button" class="ghost voice-note-btn vp-icon-btn" data-entity-type="VISIT" data-entity-id="${visit.id}" title="Voice note">
              <svg width="14" height="14" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" y1="19" x2="12" y2="23"/><line x1="8" y1="23" x2="16" y2="23"/></svg>
            </button>
            ${isOwn && visit.status !== "CHECKED_OUT" ? `
              <button type="button" class="visit-action ${visit.status === "CHECKED_IN" ? "btn-success" : ""}" data-visit-id="${visit.id}" data-visit-status="${visit.status}">
                ${visit.status === "PLANNED"
                  ? `<svg width="13" height="13" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/></svg> Check In`
                  : `<svg width="13" height="13" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="20 6 9 17 4 12"/></svg> Check Out`
                }
              </button>
            ` : ""}
          </div>
        </div>
      </div>`;
  }).join("")}</div>`;
}

function attachVisitListListeners(container) {
  const { setStatus, openVoiceNoteDialog } = deps;
  container.querySelectorAll(".vp-card").forEach((card) => {
    card.addEventListener("click", (event) => {
      if (event.target.closest("button")) return;
      const id = card.dataset.visitId;
      if (id) void openVisitDetail(id);
    });
  });

  container.querySelectorAll(".voice-note-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      const card = btn.closest(".vp-card");
      const label = card?.querySelector(".vp-card-customer")?.textContent?.trim() || "";
      void openVoiceNoteDialog(btn.dataset.entityType, btn.dataset.entityId, label);
    });
  });

  container.querySelectorAll(".prospect-badge-btn").forEach((btn) => {
    btn.addEventListener("click", (event) => {
      event.stopPropagation();
      const id = btn.dataset.prospectId;
      if (id) void deps.openProspectDetail?.(id);
    });
  });

  container.querySelectorAll(".visit-action").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const id = btn.dataset.visitId;
      const status = btn.dataset.visitStatus;
      try {
        if (status === "PLANNED") {
          await api(`/visits/${id}/checkin`, {
            method: "POST",
            body: { lat: 13.7563, lng: 100.5018, selfieUrl: "r2://demo/selfie.jpg" }
          });
          setStatus("Checked in.");
        } else if (status === "CHECKED_IN") {
          const result = window.prompt("Visit outcome / result:", "");
          if (result === null) return;
          await api(`/visits/${id}/checkout`, {
            method: "POST",
            body: { lat: 13.7564, lng: 100.5019, result: result || "Completed." }
          });
          setStatus("Visit completed.");
        }
        await loadVisits();
      } catch (error) {
        setStatus(error.message, true);
      }
    });
  });
}

export function renderVisits(visits) {
  const f = state.visitPage;
  const canFilterReps = state.user?.role !== "REP";
  const allReps = state.cache.salesReps || [];
  const q = (f.query || "").toLowerCase();
  const statusLabel = { PLANNED: "Planned", CHECKED_IN: "Active", CHECKED_OUT: "Completed" };

  const total = visits.length;
  const planned = visits.filter((visit) => visit.status === "PLANNED").length;
  const active = visits.filter((visit) => visit.status === "CHECKED_IN").length;
  const done = visits.filter((visit) => visit.status === "CHECKED_OUT").length;

  const chevron = `<svg class="ms-dropdown-chevron" width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true"><path d="M2 4l4 4 4-4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

  const repMsHtml = (canFilterReps && allReps.length > 0) ? (() => {
    const selectedRepIds = f.repIds || [];
    const allSelected = selectedRepIds.length === 0 || selectedRepIds.length === allReps.length;
    const btnLabel = allSelected
      ? "All Reps"
      : selectedRepIds.length === 1
        ? escHtml(allReps.find((rep) => rep.id === selectedRepIds[0])?.fullName || "1 rep")
        : `${selectedRepIds.length} reps`;
    const items = allReps.map((rep) => `
      <label class="ms-dropdown-item">
        <input type="checkbox" name="repIds" value="${rep.id}" ${selectedRepIds.includes(rep.id) ? "checked" : ""}>
        <span class="ms-item-label">${escHtml(rep.fullName)}</span>
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
        ${["PLANNED", "CHECKED_IN", "CHECKED_OUT"].map((status) => `
          <button class="vp-chip ${f.status === status ? "vp-chip--active" : ""}" data-vp-status="${status}">
            ${statusLabel[status]}
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
      <div id="vp-list-container">${buildVisitListHtml(visits, q)}</div>
    </div>
  `;

  attachVisitListListeners(qs("#vp-list-container"));

  views.visits.querySelectorAll("[data-vp-status]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      state.visitPage.status = state.visitPage.status === btn.dataset.vpStatus ? "" : btn.dataset.vpStatus;
      await loadVisits();
    });
  });

  qs("#vp-search")?.addEventListener("input", (event) => {
    state.visitPage.query = event.target.value;
    const container = qs("#vp-list-container");
    if (container) {
      container.innerHTML = buildVisitListHtml(state.cache.visits, event.target.value.toLowerCase());
      attachVisitListListeners(container);
    }
  });

  qs("#vp-date-from")?.addEventListener("change", async (event) => {
    state.visitPage.dateFrom = event.target.value;
    await loadVisits();
  });
  qs("#vp-date-to")?.addEventListener("change", async (event) => {
    state.visitPage.dateTo = event.target.value;
    await loadVisits();
  });

  if (canFilterReps && allReps.length > 0) {
    const btn = qs("#vp-rep-btn");
    const panel = qs("#vp-rep-panel");
    const label = qs("#vp-rep-label");

    const updateRepLabel = () => {
      const selectedRepIds = state.visitPage.repIds;
      const allSelected = selectedRepIds.length === 0 || selectedRepIds.length === allReps.length;
      label.textContent = allSelected
        ? "All Reps"
        : selectedRepIds.length === 1
          ? (allReps.find((rep) => rep.id === selectedRepIds[0])?.fullName || "1 rep")
          : `${selectedRepIds.length} reps`;
    };

    btn?.addEventListener("click", (event) => {
      event.stopPropagation();
      panel.hidden = !panel.hidden;
    });

    document.addEventListener("click", function closeRepPanel(event) {
      if (!qs("#vp-rep-ms")?.contains(event.target)) {
        panel.hidden = true;
        document.removeEventListener("click", closeRepPanel);
      }
    });

    qs("#vp-rep-select-all")?.addEventListener("click", async () => {
      panel.querySelectorAll("input[type=checkbox]").forEach((cb) => { cb.checked = true; });
      state.visitPage.repIds = [];
      updateRepLabel();
      await loadVisits();
    });

    qs("#vp-rep-clear")?.addEventListener("click", async () => {
      panel.querySelectorAll("input[type=checkbox]").forEach((cb) => { cb.checked = false; });
      state.visitPage.repIds = allReps.map((rep) => rep.id);
      updateRepLabel();
      await loadVisits();
    });

    panel?.querySelectorAll("input[type=checkbox]").forEach((cb) => {
      cb.addEventListener("change", async () => {
        const checked = [...panel.querySelectorAll("input[type=checkbox]:checked")].map((input) => input.value);
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
  const input = modal.querySelector("#visit-customer-input");
  const hiddenId = modal.querySelector("#visit-customer-id");
  const list = modal.querySelector("#visit-customer-list");
  if (input) input.value = "";
  if (hiddenId) hiddenId.value = "";
  if (list) list.hidden = true;
  const subjectCustomer = modal.querySelector('[name="visitSubject"][value="CUSTOMER"]');
  if (subjectCustomer) subjectCustomer.checked = true;
  const prospectNameField = modal.querySelector("#visit-prospect-name");
  if (prospectNameField) prospectNameField.value = "";
  applyVisitSubjectMode(modal, "CUSTOMER");
  const dealLabel = modal.querySelector("#visit-deal-label");
  const dealSelect = modal.querySelector("#visit-deal-select");
  if (dealLabel) dealLabel.hidden = true;
  if (dealSelect) dealSelect.innerHTML = `<option value="">— No deal —</option>`;
  const now = new Date();
  now.setSeconds(0, 0);
  const nowLocal = new Date(now.getTime() - now.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
  const base = dateTime ? new Date(dateTime) : new Date();
  base.setSeconds(0, 0);
  const local = new Date(base.getTime() - base.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
  const plannedAtInput = modal.querySelector("#visit-planned-at");
  plannedAtInput.min = nowLocal;
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
    const date = new Date(visit.plannedAt);
    const local = new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
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

// "Unidentified site" mode forces UNPLANNED + hides the customer picker so a rep
// who just parked outside an unknown construction site can capture the visit
// without first guessing the customer name.
export function applyVisitSubjectMode(modal, mode) {
  const customerLabel = modal.querySelector("#visit-customer-label");
  const customerHidden = modal.querySelector("#visit-customer-id");
  const customerInput = modal.querySelector("#visit-customer-input");
  const prospectFields = modal.querySelector("#visit-prospect-fields");
  const dealLabel = modal.querySelector("#visit-deal-label");
  const visitTypeLabel = modal.querySelector("#visit-type-label");
  const visitTypePlanned = modal.querySelector('[name="visitType"][value="PLANNED"]');
  const visitTypeUnplanned = modal.querySelector('[name="visitType"][value="UNPLANNED"]');

  if (mode === "UNIDENTIFIED") {
    if (customerLabel) customerLabel.hidden = true;
    if (customerHidden) {
      customerHidden.value = "";
      customerHidden.required = false;
    }
    if (customerInput) customerInput.required = false;
    if (prospectFields) prospectFields.hidden = false;
    if (dealLabel) dealLabel.hidden = true; // can't attach a deal w/o a customer
    // Force UNPLANNED — an unidentified site can't have been pre-planned.
    if (visitTypeUnplanned) visitTypeUnplanned.checked = true;
    if (visitTypePlanned) visitTypePlanned.disabled = true;
    if (visitTypeLabel) visitTypeLabel.hidden = true;
  } else {
    if (customerLabel) customerLabel.hidden = false;
    if (customerHidden) customerHidden.required = true;
    if (prospectFields) prospectFields.hidden = true;
    if (visitTypePlanned) visitTypePlanned.disabled = false;
    if (visitTypeLabel) visitTypeLabel.hidden = false;
  }
  syncVisitPlannedAtRequired(modal);
}

function openVisitDetailPanel() {
  const notifPanel = qs("#notif-panel");
  const settingsPanel = qs("#settings-panel");
  const panelBackdrop = qs("#panel-backdrop");
  const visitDetailPanel = getVisitDetailPanel();
  if (notifPanel && !notifPanel.hidden) {
    notifPanel.hidden = true;
    notifPanel.classList.remove("open");
  }
  if (settingsPanel && !settingsPanel.hidden) {
    settingsPanel.hidden = true;
    settingsPanel.classList.remove("open");
  }
  if (!visitDetailPanel) return;
  visitDetailPanel.hidden = false;
  requestAnimationFrame(() => visitDetailPanel.classList.add("open"));
  if (panelBackdrop) {
    panelBackdrop.hidden = false;
    requestAnimationFrame(() => panelBackdrop.classList.add("open"));
  }
}

export function closeVisitDetailPanel() {
  const panelBackdrop = qs("#panel-backdrop");
  const visitDetailPanel = getVisitDetailPanel();
  if (!visitDetailPanel) return;
  visitDetailPanel.classList.remove("open");
  visitDetailPanel.addEventListener("transitionend", () => { visitDetailPanel.hidden = true; }, { once: true });
  if (panelBackdrop) {
    panelBackdrop.classList.remove("open");
    panelBackdrop.addEventListener("transitionend", () => { panelBackdrop.hidden = true; }, { once: true });
  }
}

export async function openVisitDetail(visitId) {
  const visitDetailBody = getVisitDetailBody();
  if (!visitDetailBody) return;
  visitDetailBody.innerHTML = `<div class="vd-loading">Loading…</div>`;
  openVisitDetailPanel();

  try {
    const [visit, changelogs] = await Promise.all([
      api(`/visits/${visitId}`),
      api(`/changelogs?entityType=VISIT&entityId=${visitId}&limit=50`).catch(() => null)
    ]);
    renderVisitDetailContent(visit, changelogs);
  } catch (error) {
    visitDetailBody.innerHTML = `<div class="vd-loading" style="color:var(--danger-text,red)">${escHtml(error.message)}</div>`;
  }
}

function fmtDuration(ms) {
  if (ms == null || Number.isNaN(ms)) return "—";
  const totalSeconds = Math.floor(Math.abs(ms) / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const pad = (num) => String(num).padStart(2, "0");
  return `${pad(hours)}:${pad(minutes)}:${pad(seconds)}`;
}

function fmtDiffLabel(ms) {
  if (ms == null || Number.isNaN(ms)) return null;
  const totalSeconds = Math.floor(Math.abs(ms) / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const parts = [];
  if (hours > 0) parts.push(`${hours}h`);
  if (minutes > 0 || hours === 0) parts.push(`${minutes}m`);
  const label = parts.join(" ");
  if (Math.abs(ms) < 60000) return { cls: "ontime", text: "On time" };
  return ms < 0
    ? { cls: "early", text: `${label} early` }
    : { cls: "late", text: `${label} late` };
}

function renderVisitDetailContent(visit, changelogs) {
  const { avatarColor, repAvatarHtml } = deps;
  const visitDetailBody = getVisitDetailBody();
  if (!visitDetailBody) return;

  const statusLabelMap = { PLANNED: "Planned", CHECKED_IN: "Active", CHECKED_OUT: "Completed" };
  const statusClsMap = { PLANNED: "planned", CHECKED_IN: "active", CHECKED_OUT: "done" };
  const visitTypeLabelMap = { PLANNED: "Scheduled", UNPLANNED: "Drop-in" };

  const plannedAt = visit.plannedAt ? new Date(visit.plannedAt) : null;
  const checkInAt = visit.checkInAt ? new Date(visit.checkInAt) : null;
  const checkOutAt = visit.checkOutAt ? new Date(visit.checkOutAt) : null;

  const plannedVsActualMs = (plannedAt && checkInAt) ? (checkInAt - plannedAt) : null;
  const durationMs = (checkInAt && checkOutAt) ? (checkOutAt - checkInAt) : null;
  const diffInfo = fmtDiffLabel(plannedVsActualMs);
  const isOwnVisit = visit.rep?.id === state.user?.id;
  const canEdit = isOwnVisit && visit.status === "PLANNED";
  const heroHtml = `
    <div class="vd-hero">
      <div class="vd-hero-top">
        <div class="vd-hero-customer">${
          visit.customer
            ? escHtml(visit.customer.name)
            : visit.prospect
              ? `<span class="prospect-badge">Prospect: ${escHtml(visit.prospect.displayName || "(unnamed)")}</span>`
              : "—"
        }</div>
        ${canEdit ? `<button type="button" class="ghost small vd-edit-btn" data-visit-id="${visit.id}" title="Edit visit">
          <svg width="13" height="13" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
          Edit
        </button>` : ""}
      </div>
      <div class="vd-hero-meta">
        ${visit.visitNo ? `<span class="vd-hero-visitno">${escHtml(visit.visitNo)}</span>` : ""}
        <span class="vd-status-badge ${statusClsMap[visit.status] || "planned"}">${statusLabelMap[visit.status] || visit.status}</span>
        <span class="vd-hero-badge">${visitTypeLabelMap[visit.visitType] || visit.visitType}</span>
        <span class="vd-hero-rep">
          <span class="vd-hero-rep-avatar" style="${visit.rep?.avatarUrl ? "overflow:hidden" : `background:${avatarColor(visit.rep?.fullName || "")}`}">${repAvatarHtml(visit.rep?.fullName || "", visit.rep?.avatarUrl)}</span>
          ${escHtml(visit.rep?.fullName || "—")}
        </span>
      </div>
    </div>`;

  const customer = visit.customer || {};
  const address = customer.addresses?.[0];
  const addressLine = address
    ? [address.addressLine1, address.district, address.province, address.country].filter(Boolean).join(", ")
    : null;
  const customerHtml = `
    <div class="vd-section">
      <p class="vd-section-title">${icon('building')} Customer</p>
      <div class="vd-detail-rows">
        <div class="vd-detail-row"><span class="vd-detail-row-label">Code</span><span class="vd-detail-row-value">${escHtml(customer.customerCode || "—")}</span></div>
        <div class="vd-detail-row"><span class="vd-detail-row-label">Type</span><span class="vd-detail-row-value">${escHtml(customer.customerType || "—")}</span></div>
        ${addressLine ? `<div class="vd-detail-row"><span class="vd-detail-row-label">Address</span><span class="vd-detail-row-value">${escHtml(addressLine)}</span></div>` : ""}
        ${customer.taxId ? `<div class="vd-detail-row"><span class="vd-detail-row-label">Tax ID</span><span class="vd-detail-row-value">${escHtml(customer.taxId)}</span></div>` : ""}
      </div>
    </div>`;

  const dealHtml = visit.deal ? `
    <div class="vd-section">
      <p class="vd-section-title">${icon('handshake')} Related Deal</p>
      <div class="vd-deal-card">
        <div class="vd-deal-no">${escHtml(visit.deal.dealNo)}</div>
        <div class="vd-deal-name">${escHtml(visit.deal.dealName)}</div>
        ${visit.deal.stage ? `<div class="vd-deal-stage">${escHtml(visit.deal.stage.stageName)}</div>` : ""}
      </div>
    </div>` : "";

  const timingHtml = `
    <div class="vd-section">
      <p class="vd-section-title">${icon('bell')} Timing</p>
      <div class="vd-timing-grid">
        <div class="vd-timing-card">
          <div class="vd-timing-card-label">Planned</div>
          <div class="vd-timing-card-value ${plannedAt ? "" : "muted"}">${plannedAt ? asDate(plannedAt) : "—"}</div>
        </div>
        <div class="vd-timing-card">
          <div class="vd-timing-card-label">Check-in</div>
          <div class="vd-timing-card-value ${checkInAt ? "" : "muted"}">${checkInAt ? asDate(checkInAt) : "—"}</div>
        </div>
        <div class="vd-timing-card">
          <div class="vd-timing-card-label">Check-out</div>
          <div class="vd-timing-card-value ${checkOutAt ? "" : "muted"}">${checkOutAt ? asDate(checkOutAt) : "—"}</div>
        </div>
        <div class="vd-timing-card ${durationMs == null ? "" : durationMs < (state.cache.visitConfig?.minVisitDurationMinutes ?? 15) * 60 * 1000 ? "vd-timing-card--danger" : "vd-timing-card--success"}">
          <div class="vd-timing-card-label">Meeting Duration</div>
          <div class="vd-timing-card-value ${durationMs != null ? "" : "muted"}">${durationMs != null ? fmtDuration(durationMs) : "—"}</div>
        </div>
      </div>
      ${diffInfo ? `
        <div class="vd-detail-rows" style="margin-top:var(--sp-1)">
          <div class="vd-detail-row">
            <span class="vd-detail-row-label">Planned vs Actual</span>
            <span class="vd-detail-row-value">
              <span class="vd-diff-pill ${diffInfo.cls}">${escHtml(diffInfo.text)}</span>
              ${plannedVsActualMs != null ? `<span style="font-size:0.75rem;color:var(--muted-color);margin-left:6px">(${fmtDuration(plannedVsActualMs)} ${plannedVsActualMs < 0 ? "before" : "after"} plan)</span>` : ""}
            </span>
          </div>
        </div>` : ""}
    </div>`;

  const objectiveHtml = `
    <div class="vd-section">
      <p class="vd-section-title">${icon('target')} Expected Result</p>
      <div class="vd-result-block ${visit.objective ? "" : "empty"}">${visit.objective ? escHtml(visit.objective) : "No objective recorded."}</div>
    </div>`;

  const resultHtml = `
    <div class="vd-section">
      <p class="vd-section-title">${icon('checkCircle')} Actual Result</p>
      <div class="vd-result-block ${visit.result ? "" : "empty"}">${visit.result ? escHtml(visit.result) : "No result recorded yet."}</div>
    </div>`;

  const lat = visit.checkInLat ?? visit.siteLat ?? visit.customer?.siteLat ?? null;
  const lng = visit.checkInLng ?? visit.siteLng ?? visit.customer?.siteLng ?? null;
  const customerAddress = visit.customer?.addresses?.[0];
  const addressText = customerAddress
    ? [customerAddress.addressLine1, customerAddress.district, customerAddress.province, customerAddress.country].filter(Boolean).join(", ")
    : null;

  let locationHtml = "";
  if (lat != null && lng != null) {
    const apiKey = state.googleMapsApiKey;
    const dirUrl = `https://www.google.com/maps/dir/?api=1&destination=${lat},${lng}`;
    const mapHtml = apiKey
      ? `<img class="vd-map-img" loading="lazy"
            src="https://maps.googleapis.com/maps/api/staticmap?center=${lat},${lng}&zoom=15&size=600x240&scale=2&markers=color:red%7C${lat},${lng}&key=${encodeURIComponent(apiKey)}"
            alt="Visit location map" />`
      : `<div class="vd-map-fallback">${icon('location')} ${lat.toFixed(5)}, ${lng.toFixed(5)}</div>`;
    locationHtml = `
      <div class="vd-section">
        <p class="vd-section-title">${icon('location')} Location</p>
        ${mapHtml}
        <a class="vd-directions-btn" href="${dirUrl}" target="_blank" rel="noopener">
          Get Directions
        </a>
      </div>`;
  } else if (addressText) {
    const dirUrl = `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(addressText)}`;
    locationHtml = `
      <div class="vd-section">
        <p class="vd-section-title">${icon('location')} Location</p>
        <div class="vd-map-fallback">${icon('location')} ${escHtml(addressText)}</div>
        <a class="vd-directions-btn" href="${dirUrl}" target="_blank" rel="noopener">
          Get Directions
        </a>
      </div>`;
  }

  let changelogHtml;
  if (changelogs === null) {
    changelogHtml = `<div class="vd-section"><p class="vd-section-title">Change History</p><div class="vd-cl-restricted">Not available for your role.</div></div>`;
  } else {
    const actionLabelMap = { CREATE: "Visit Created", UPDATE: "Visit Updated" };
    const dotClsMap = { CREATE: "create" };
    const workflowDotMap = { CHECK_IN: "checkin", CHECK_OUT: "checkout" };
    const workflowLabelMap = { CHECK_IN: "Checked In", CHECK_OUT: "Checked Out" };

    const clItems = (changelogs || []).map((changelog) => {
      const workflow = changelog.contextJson?.workflow;
      const dotCls = workflowDotMap[workflow] || dotClsMap[changelog.action] || "";
      const actionLabel = workflowLabelMap[workflow] || actionLabelMap[changelog.action] || changelog.action;
      const when = changelog.createdAt ? asDate(changelog.createdAt) : "—";
      const who = changelog.changedBy?.fullName || "System";

      let diffRows = "";
      if (changelog.action === "UPDATE" && changelog.beforeJson && changelog.afterJson) {
        const before = changelog.beforeJson;
        const after = changelog.afterJson;
        const tracked = ["status", "result", "objective", "checkInAt", "checkOutAt"];
        const changed = tracked.filter((key) => String(before[key] ?? "") !== String(after[key] ?? ""));
        if (changed.length) {
          const fmtVal = (key, value) => {
            if (value == null || value === "") return "(empty)";
            if (key.endsWith("At")) return asDate(value);
            return String(value);
          };
          diffRows = `<div class="vd-cl-changes">${changed.map((key) => `
            <div class="vd-cl-change-row">
              <span class="vd-cl-field">${escHtml(key)}</span>
              <span class="vd-cl-from">${escHtml(fmtVal(key, before[key]))}</span>
              <span class="vd-cl-arrow">→</span>
              <span class="vd-cl-to">${escHtml(fmtVal(key, after[key]))}</span>
            </div>`).join("")}</div>`;
        }
      }

      return `
        <div class="vd-cl-item">
          <div class="vd-cl-dot ${dotCls}"></div>
          <div class="vd-cl-content">
            <div class="vd-cl-action">${escHtml(actionLabel)}</div>
            <div class="vd-cl-meta">${escHtml(when)} &middot; ${escHtml(who)}</div>
            ${diffRows}
          </div>
        </div>`;
    }).join("");

    changelogHtml = `
      <div class="vd-section">
        <p class="vd-section-title">${icon('pen')} Change History</p>
        ${clItems ? `<div class="vd-changelog-list">${clItems}</div>` : `<div class="vd-cl-empty">No changes recorded.</div>`}
      </div>`;
  }

  let voiceNotesHtml = "";
  if (visit.voiceNotes?.length) {
    const items = visit.voiceNotes.map((voiceNote) => {
      const when = voiceNote.transcript?.confirmedAt ? asDate(new Date(voiceNote.transcript.confirmedAt)) : "—";
      const summary = voiceNote.transcript?.summaryText ? escHtml(voiceNote.transcript.summaryText) : "";
      return `
        <div class="vd-vn-item" data-job-id="${escHtml(voiceNote.id)}">
          <div class="vd-vn-meta">${when}</div>
          ${summary ? `<div class="vd-vn-summary">${summary}</div>` : ""}
          <div class="vd-vn-player">
            <audio class="vd-vn-audio" controls preload="none" style="width:100%">
              Your browser does not support audio playback.
            </audio>
            <span class="vd-vn-loading muted small">Loading audio…</span>
          </div>
        </div>`;
    }).join("");
    voiceNotesHtml = `
      <div class="vd-section">
        <p class="vd-section-title">${icon('mic')} Voice Notes</p>
        <div class="vd-vn-list">${items}</div>
      </div>`;
  }

  visitDetailBody.innerHTML = heroHtml + customerHtml + dealHtml + timingHtml + objectiveHtml + resultHtml + locationHtml + voiceNotesHtml + changelogHtml;

  visitDetailBody.querySelector(".vd-edit-btn")?.addEventListener("click", () => openVisitEditModal(visit));

  if (visit.voiceNotes?.length) {
    visitDetailBody.querySelectorAll(".vd-vn-item").forEach(async (item) => {
      const jobId = item.dataset.jobId;
      const audioEl = item.querySelector(".vd-vn-audio");
      const loadingEl = item.querySelector(".vd-vn-loading");
      try {
        const { url, reason } = await api(`/voice-notes/${jobId}/audio-url`);
        if (url) {
          audioEl.src = url;
          audioEl.load();
          loadingEl.hidden = true;
        } else {
          loadingEl.textContent = reason || "Audio not available.";
        }
      } catch (err) {
        loadingEl.textContent = err?.message || "Could not load audio.";
      }
    });
  }
}

export function showEventDetail(ev, anchorEl) {
  const { stageAccentVar } = deps;
  qs("#cal-event-popover")?.remove();

  const at = new Date(ev.at);
  const dateStr = at.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", year: "numeric" });
  const timeStr = at.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
  const typeLabel = ev.type === "visit" ? "Visit" : "Deal";
  const titleCore = ev.title.replace(/^(Visit|Deal): /, "");

  const statusLabel = ev.status
    ? { PLANNED: "Planned", CHECKED_IN: "Checked-in", CHECKED_OUT: "Checked-out", OPEN: "Open", WON: "Won", LOST: "Lost" }[ev.status] ?? ev.status.replace(/_/g, " ")
    : "";
  const statusColor = ev.type === "deal"
    ? ev.status === "WON" ? "green" : ev.status === "LOST" ? "red" : ev.color
    : ev.color;

  const stageAccent = (() => {
    if (!ev.stage) return null;
    const stages = state.cache.dealStages || [];
    let nonTerminalIndex = 0;
    for (const stage of stages) {
      const accent = stageAccentVar(stage.stageName, nonTerminalIndex);
      if (stage.id === ev.stage.id) return accent;
      if (accent !== "--stage-3" && accent !== "--stage-4") nonTerminalIndex += 1;
    }
    return stageAccentVar(ev.stage.name, 0);
  })();

  const rows = [
    `<div class="ced-row"><span class="ced-label">Date</span><span class="ced-value">${dateStr}</span></div>`,
    `<div class="ced-row"><span class="ced-label">Time</span><span class="ced-value">${timeStr}</span></div>`,
    ev.customer ? `<div class="ced-row"><span class="ced-label">Customer</span><span class="ced-value">${escHtml(ev.customer.name)}</span></div>` : "",
    ev.owner ? `<div class="ced-row"><span class="ced-label">${ev.type === "deal" ? "Owner" : "Sales Rep"}</span><span class="ced-value">${escHtml(ev.owner.name)}</span></div>` : "",
    ev.stage && stageAccent ? `<div class="ced-row"><span class="ced-label">Stage</span><span class="ced-value"><span class="ced-stage-badge" style="--sa:var(${stageAccent})">${escHtml(ev.stage.name)}</span></span></div>` : "",
    statusLabel ? `<div class="ced-row"><span class="ced-label">Status</span><span class="ced-value"><span class="ced-status ced-status--${statusColor}">${statusLabel}</span></span></div>` : ""
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
  const popoverWidth = 272;
  const popoverHeight = 220;
  const viewportWidth = window.innerWidth;
  const viewportHeight = window.innerHeight;
  let left = rect.left;
  let top = rect.bottom + 6 + window.scrollY;
  if (left + popoverWidth > viewportWidth - 8) left = viewportWidth - popoverWidth - 8;
  if (rect.bottom + 6 + popoverHeight > viewportHeight) top = rect.top - popoverHeight - 6 + window.scrollY;
  if (left < 8) left = 8;
  popover.style.left = `${left}px`;
  popover.style.top = `${top}px`;

  const dismiss = () => popover.remove();

  qs("#ced-close-btn")?.addEventListener("click", (event) => {
    event.stopPropagation();
    dismiss();
  });

  popover.querySelector(".ced-action")?.addEventListener("click", () => {
    dismiss();
    if (ev.type === "visit") {
      qs('.nav-btn[data-view="visits"]')?.click();
      void openVisitDetail(ev.entityId);
    } else {
      void deps.openDeal360(ev.entityId);
    }
  });

  setTimeout(() => {
    document.addEventListener("click", function outsideHandler(event) {
      if (!popover.contains(event.target)) {
        dismiss();
        document.removeEventListener("click", outsideHandler);
      }
    });
  }, 0);

  document.addEventListener("keydown", function escHandler(event) {
    if (event.key === "Escape") {
      dismiss();
      document.removeEventListener("keydown", escHandler);
    }
  }, { once: true });
}

qs("#visit-detail-close")?.addEventListener("click", () => closeVisitDetailPanel());

(function initVisitEditModal() {
  const modal = qs("#visit-edit-modal");
  if (!modal) return;
  modal.querySelectorAll("[data-visit-edit-close]").forEach((el) => {
    el.addEventListener("click", closeVisitEditModal);
  });
  qs("#visit-edit-pick-location-btn")?.addEventListener("click", () => {
    const lat = parseFloat(qs("#visit-edit-site-lat")?.value) || null;
    const lng = parseFloat(qs("#visit-edit-site-lng")?.value) || null;
    void deps.openMapPicker(lat, lng, (pickedLat, pickedLng) => {
      qs("#visit-edit-site-lat").value = pickedLat;
      qs("#visit-edit-site-lng").value = pickedLng;
      const preview = qs("#visit-edit-location-preview");
      const text = qs("#visit-edit-location-text");
      if (preview) preview.hidden = false;
      if (text) text.textContent = `${pickedLat.toFixed(6)}, ${pickedLng.toFixed(6)}`;
      const pickBtn = qs("#visit-edit-pick-location-btn");
      if (pickBtn) pickBtn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/></svg> Change Location`;
    });
  });

  qs("#visit-edit-location-clear")?.addEventListener("click", () => {
    qs("#visit-edit-site-lat").value = "";
    qs("#visit-edit-site-lng").value = "";
    qs("#visit-edit-location-preview").hidden = true;
    const pickBtn = qs("#visit-edit-pick-location-btn");
    if (pickBtn) pickBtn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/></svg> Pick on Map`;
  });

  qs("#visit-edit-form")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const { setStatus, loadMyTasks } = deps;
    const id = qs("#visit-edit-id").value;
    const plannedAt = qs("#visit-edit-planned-at").value;
    const objective = qs("#visit-edit-objective").value.trim();
    const latRaw = qs("#visit-edit-site-lat").value;
    const lngRaw = qs("#visit-edit-site-lng").value;
    const body = {};
    if (plannedAt) body.plannedAt = new Date(plannedAt).toISOString();
    if (objective) body.objective = objective;
    if (latRaw && lngRaw) {
      body.siteLat = parseFloat(latRaw);
      body.siteLng = parseFloat(lngRaw);
    } else if (latRaw === "" && lngRaw === "") {
      body.siteLat = null;
      body.siteLng = null;
    }
    if (!Object.keys(body).length) {
      closeVisitEditModal();
      return;
    }
    const submitBtn = qs("#visit-edit-submit");
    submitBtn.disabled = true;
    submitBtn.textContent = "Saving…";
    try {
      await api(`/visits/${id}`, { method: "PATCH", body });
      closeVisitEditModal();
      setStatus("Visit updated.");
      const reloadId = id;
      await Promise.all([loadVisits(), Promise.resolve(loadMyTasks()).catch(() => {})]);
      const visitDetailPanel = getVisitDetailPanel();
      if (visitDetailPanel && !visitDetailPanel.hidden) {
        await openVisitDetail(reloadId);
      }
    } catch (error) {
      setStatus(error.message, true);
    } finally {
      submitBtn.disabled = false;
      submitBtn.textContent = "Save Changes";
    }
  });
})();
