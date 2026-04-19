// Admin onboarding wizard (S11) — shows a checklist of setup steps for trial
// tenants and auto-opens once per session until everything is done. Callers
// pass a `stepNav` map at init time so this module doesn't need to know about
// view switchers, settings pages, or master/deal loaders.
import { qs } from "./dom.js";
import { api } from "./api.js";
import { escHtml } from "./utils.js";
import { state } from "./state.js";

let loadingInFlight = false;
let stepNavHandlers = {};

const STEP_ICONS = {
  teamCreated:      '<svg width="18" height="18" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="5" r="3"/><line x1="12" y1="8" x2="12" y2="14"/><line x1="8" y1="18" x2="12" y2="14"/><line x1="16" y1="18" x2="12" y2="14"/><circle cx="8" cy="19" r="2"/><circle cx="16" cy="19" r="2"/></svg>',
  userInvited:      '<svg width="18" height="18" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><line x1="19" y1="8" x2="19" y2="14"/><line x1="22" y1="11" x2="16" y2="11"/></svg>',
  integrationSetup: '<svg width="18" height="18" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="6" width="6" height="6" rx="1"/><rect x="16" y="6" width="6" height="6" rx="1"/><rect x="9" y="13" width="6" height="6" rx="1"/><path d="M8 9h8M12 6v7"/></svg>',
  customerImported: '<svg width="18" height="18" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V9z"/><polyline points="9 22 9 12 15 12 15 22"/></svg>',
  dealCreated:      '<svg width="18" height="18" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><polyline points="9 12 11 14 15 10"/></svg>',
  domainConfigured: '<svg width="18" height="18" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg>'
};

const STEP_DESCS = {
  teamCreated:      "Organize your sales regions and teams",
  userInvited:      "Add team members to start collaborating",
  integrationSetup: "Connect your tools and data sources",
  customerImported: "Bring in your customer database",
  dealCreated:      "Create your first sales opportunity",
  domainConfigured: "Set up your custom branded domain"
};

function openOnboardingModal() {
  const modal = qs("#onboarding-wizard-modal");
  if (modal) modal.hidden = false;
}

function closeOnboardingModal() {
  const modal = qs("#onboarding-wizard-modal");
  if (modal) modal.hidden = true;
}

export async function loadOnboardingWizard(forceOpen = false) {
  const navBtn = qs("#onboarding-nav-btn");
  const badge  = qs("#onboarding-badge");
  const modal  = qs("#onboarding-wizard-modal");
  if (!modal) return;

  if (state.user?.role !== "ADMIN") { if (navBtn) navBtn.hidden = true; modal.hidden = true; return; }
  const tenantId = state.user?.tenantId;
  if (!tenantId) { if (navBtn) navBtn.hidden = true; modal.hidden = true; return; }

  if (loadingInFlight) return;
  loadingInFlight = true;

  try {
    const data = await api(`/tenants/${tenantId}/onboarding-status`);
    if (!data?.steps) { if (navBtn) navBtn.hidden = true; modal.hidden = true; return; }

    const s = data.steps;
    const steps = [
      { key: "teamCreated",      label: "Set up your team structure", done: !!s.teamCreated },
      { key: "userInvited",      label: "Invite your first sales rep", done: !!s.userInvited },
      { key: "integrationSetup", label: "Configure integrations",      done: !!s.integrationSetup },
      { key: "customerImported", label: "Import your customers",       done: !!s.customerImported },
      { key: "dealCreated",      label: "Create your first deal",      done: !!s.dealCreated },
      { key: "domainConfigured", label: "Custom branded domain",       done: !!s.domainConfigured }
    ];

    const completedCount = steps.filter(st => st.done).length;
    const totalCount = steps.length;
    const allDone = completedCount === totalCount;

    if (allDone) {
      if (navBtn) navBtn.hidden = true;
      modal.hidden = true;
      return;
    }

    if (navBtn) navBtn.hidden = false;
    if (badge) badge.textContent = `${completedCount}/${totalCount}`;

    const list = qs("#onboarding-steps-list");
    if (list) {
      list.innerHTML = steps.map((st) => `
        <li class="ob-step${st.done ? " done" : ""}">
          <div class="ob-step-icon">${STEP_ICONS[st.key] || ""}</div>
          <div class="ob-step-content">
            <span class="ob-step-label">${escHtml(st.label)}</span>
            <span class="ob-step-desc">${escHtml(STEP_DESCS[st.key] || "")}</span>
          </div>
          ${st.done
            ? '<span class="ob-check-done">&#10003;</span>'
            : `<button type="button" class="ob-step-action" data-step-key="${st.key}">Set up</button>`}
        </li>
      `).join("");
    }

    const ringFill = qs("#onboarding-ring-fill");
    const ringText = qs("#onboarding-ring-text");
    const progressLabel = qs("#onboarding-progress-label");
    if (ringFill) {
      const circumference = 2 * Math.PI * 24;
      const offset = circumference - (completedCount / totalCount) * circumference;
      ringFill.style.strokeDasharray = circumference;
      ringFill.style.strokeDashoffset = offset;
    }
    if (ringText) ringText.textContent = `${completedCount}/${totalCount}`;
    if (progressLabel) progressLabel.textContent = `${completedCount} of ${totalCount} steps complete`;

    const sessionKey = `ob_shown_${tenantId}`;
    if (forceOpen) {
      openOnboardingModal();
    } else if (!sessionStorage.getItem(sessionKey)) {
      sessionStorage.setItem(sessionKey, "1");
      openOnboardingModal();
    }
  } catch {
    if (navBtn) navBtn.hidden = true;
    modal.hidden = true;
  } finally {
    loadingInFlight = false;
  }
}

// Wire modal events. `stepNav` is a map of stepKey → handler that navigates the
// host app to wherever that step is completed.
export function initOnboardingWizard({ stepNav } = {}) {
  stepNavHandlers = stepNav || {};
  const navBtn   = qs("#onboarding-nav-btn");
  const closeBtn = qs("#onboarding-close-btn");
  const backdrop = qs("#onboarding-modal-backdrop");
  const laterBtn = qs("#onboarding-later-btn");
  const stepList = qs("#onboarding-steps-list");

  navBtn?.addEventListener("click", () => loadOnboardingWizard(true));

  closeBtn?.addEventListener("click", closeOnboardingModal);
  backdrop?.addEventListener("click", closeOnboardingModal);

  laterBtn?.addEventListener("click", () => {
    closeOnboardingModal();
    const tenantId = state.user?.tenantId;
    if (tenantId) sessionStorage.setItem(`ob_shown_${tenantId}`, "1");
  });

  stepList?.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-step-key]");
    if (!btn) return;
    const key = btn.dataset.stepKey;
    closeOnboardingModal();
    if (stepNavHandlers[key]) stepNavHandlers[key]();
  });
}
