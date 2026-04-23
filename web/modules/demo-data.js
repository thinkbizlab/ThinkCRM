// Trial-tenant demo data feature: a banner that lets admins generate or delete
// AI-seeded sample data, plus the supporting generate/delete modals.
// Host code injects `refreshHost()` (re-runs view loaders + onboarding) and
// `gotoIntegrations()` (navigation to the integrations settings page).
import { qs } from "./dom.js";
import { api } from "./api.js";
import { state } from "./state.js";

let demoDataStatus = null;
let refreshHostFn = async () => {};
let gotoIntegrationsFn = () => {};
let refreshOnboardingFn = async () => {};

export async function loadDemoDataStatus() {
  const tenantId = state.user?.tenantId;
  const sub = state.user?.subscription;
  if (!tenantId || !sub || sub.status !== "TRIALING") {
    demoDataStatus = null;
    return;
  }
  if (state.user?.role !== "ADMIN") {
    demoDataStatus = null;
    return;
  }
  try {
    demoDataStatus = await api(`/tenants/${tenantId}/demo-data/status`);
  } catch {
    demoDataStatus = null;
  }
}

export function renderDemoDataBanner() {
  const container = qs("#demo-data-banner");
  if (!container) return;
  const sub = state.user?.subscription;
  if (!sub || sub.status !== "TRIALING" || state.user?.role !== "ADMIN") {
    container.hidden = true;
    return;
  }
  container.hidden = false;

  if (demoDataStatus?.hasDemo) {
    container.innerHTML = `
      <div class="demo-banner demo-banner--active">
        <div class="demo-banner-icon">
          <svg width="24" height="24" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M20.24 12.24a6 6 0 0 0-8.49-8.49L5 10.5V19h8.5z"/><line x1="16" y1="8" x2="2" y2="22"/><line x1="17.5" y1="15" x2="9" y2="15"/></svg>
        </div>
        <div class="demo-banner-body">
          <strong>Demo data is active</strong>
          <span class="muted">${demoDataStatus.counts.customers} customers, ${demoDataStatus.counts.deals} deals, ${demoDataStatus.counts.visits} visits</span>
        </div>
        <button type="button" class="btn-danger-outline demo-delete-btn" id="demo-data-delete-btn">Delete Demo Data</button>
      </div>`;
  } else {
    const remaining = demoDataStatus?.globalKeyRemaining ?? 0;
    const hasOwnKey = demoDataStatus?.hasOwnKey ?? false;
    const limitReached = !hasOwnKey && remaining <= 0 && (demoDataStatus?.globalKeyUsage ?? 0) > 0;

    if (limitReached) {
      container.innerHTML = `
        <div class="demo-banner demo-banner--limit">
          <div class="demo-banner-icon">
            <svg width="24" height="24" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
          </div>
          <div class="demo-banner-body">
            <strong>Free demo generations used up</strong>
            <span class="muted">Add your own Anthropic API key in Integrations to continue generating demo data.</span>
          </div>
          <button type="button" class="demo-generate-btn" id="demo-data-goto-integrations">Go to Integrations</button>
        </div>`;
    } else {
      const usageHint = !hasOwnKey && remaining > 0
        ? `<span class="muted demo-usage-hint">${remaining} free generation${remaining !== 1 ? "s" : ""} remaining</span>`
        : "";
      container.innerHTML = `
        <div class="demo-banner demo-banner--empty">
          <div class="demo-banner-icon">
            <svg width="24" height="24" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>
          </div>
          <div class="demo-banner-body">
            <strong>Want to see the CRM in action?</strong>
            <span class="muted">Generate realistic sample data to explore all features instantly.</span>
            ${usageHint}
          </div>
          <button type="button" class="demo-generate-btn" id="demo-data-generate-btn">Generate Demo Data</button>
        </div>`;
    }
  }

  qs("#demo-data-generate-btn")?.addEventListener("click", () => {
    qs("#demo-data-modal").hidden = false;
  });

  qs("#demo-data-goto-integrations")?.addEventListener("click", () => {
    gotoIntegrationsFn();
  });

  qs("#demo-data-delete-btn")?.addEventListener("click", async () => {
    const countsEl = qs("#demo-delete-counts");
    if (countsEl && demoDataStatus?.counts) {
      const c = demoDataStatus.counts;
      countsEl.innerHTML = `
        <li>${c.customers} customer${c.customers !== 1 ? "s" : ""}</li>
        <li>${c.deals} deal${c.deals !== 1 ? "s" : ""}</li>
        <li>${c.visits} visit${c.visits !== 1 ? "s" : ""}</li>
        <li>${c.teams} team${c.teams !== 1 ? "s" : ""}</li>
        <li>${c.users} user${c.users !== 1 ? "s" : ""}</li>`;
    }
    qs("#demo-delete-modal").hidden = false;
  });
}

export function initDemoDataModals({ refreshHost, gotoIntegrations, refreshOnboarding } = {}) {
  refreshHostFn = refreshHost || (async () => {});
  gotoIntegrationsFn = gotoIntegrations || (() => {});
  refreshOnboardingFn = refreshOnboarding || (async () => {});

  // Generate modal
  const genModal = qs("#demo-data-modal");
  const genForm  = qs("#demo-data-form");
  const genClose = qs("#demo-data-close");
  const genBackdrop = qs("#demo-data-backdrop");
  const genCancel = qs("#demo-data-cancel");
  const closeGen = () => { if (genModal) genModal.hidden = true; };

  genClose?.addEventListener("click", closeGen);
  genBackdrop?.addEventListener("click", closeGen);
  genCancel?.addEventListener("click", closeGen);

  genForm?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const tenantId = state.user?.tenantId;
    if (!tenantId) return;
    const fd = new FormData(e.currentTarget);
    const submitBtn = qs("#demo-data-submit-btn");
    if (submitBtn) { submitBtn.disabled = true; submitBtn.textContent = "Generating…"; }

    try {
      await api(`/tenants/${tenantId}/demo-data/generate`, {
        method: "POST",
        body: JSON.stringify({
          industry: fd.get("industry"),
          teamCount: Number(fd.get("teamCount")),
          repCount: Number(fd.get("repCount"))
        })
      });
      closeGen();
      genForm.reset();
      await loadDemoDataStatus();
      await refreshHostFn();
      await refreshOnboardingFn();
    } catch (err) {
      const msg = err.message || "Failed to generate demo data";
      if (msg.includes("API key") || msg.includes("free demo data")) {
        closeGen();
        await loadDemoDataStatus();
        renderDemoDataBanner();
      }
      alert(msg);
    } finally {
      if (submitBtn) { submitBtn.disabled = false; submitBtn.textContent = "Generate Demo Data"; }
    }
  });

  // Delete modal
  const delModal = qs("#demo-delete-modal");
  const delClose = qs("#demo-delete-close");
  const delBackdrop = qs("#demo-delete-backdrop");
  const delCancel = qs("#demo-delete-cancel");
  const delConfirm = qs("#demo-delete-confirm");
  const closeDel = () => { if (delModal) delModal.hidden = true; };

  delClose?.addEventListener("click", closeDel);
  delBackdrop?.addEventListener("click", closeDel);
  delCancel?.addEventListener("click", closeDel);

  delConfirm?.addEventListener("click", async () => {
    const tenantId = state.user?.tenantId;
    if (!tenantId) return;
    delConfirm.disabled = true;
    delConfirm.textContent = "Deleting…";

    try {
      await api(`/tenants/${tenantId}/demo-data`, { method: "DELETE" });
      closeDel();
      await loadDemoDataStatus();
      await refreshHostFn();
      await refreshOnboardingFn();
    } catch (err) {
      alert(err.message || "Failed to delete demo data");
    } finally {
      delConfirm.disabled = false;
      delConfirm.textContent = "Delete All Demo Data";
    }
  });
}
