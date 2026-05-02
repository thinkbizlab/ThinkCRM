// Draft customer flows: compact capture for field prospects and a promote
// dialog that fills in the real customer code + payment term.
import { api } from "./api.js";
import { setStatus } from "./dom.js";
import { escHtml } from "./utils.js";

let deps = null;

export function setDraftCustomerDeps(injected) {
  deps = injected;
}

export function draftBadgeHtml() {
  return `<span class="cust-draft-pill" title="Captured in the field — waiting for ERP sync or manual promotion">DRAFT</span>`;
}

function closeOverlay(overlay) {
  overlay.classList.remove("ncm-open");
  overlay.addEventListener("transitionend", () => overlay.remove(), { once: true });
  setTimeout(() => overlay.remove(), 250);
}

function mountOverlay(overlay) {
  document.body.appendChild(overlay);
  requestAnimationFrame(() => overlay.classList.add("ncm-open"));
}

export function openDraftCustomerModal({ onCreated } = {}) {
  document.querySelector("#draft-cust-modal")?.remove();
  const overlay = document.createElement("div");
  overlay.id = "draft-cust-modal";
  overlay.className = "ncm-overlay";
  overlay.innerHTML = `
    <div class="ncm-panel" role="dialog" aria-modal="true" aria-label="Capture field prospect">
      <div class="ncm-header">
        <div>
          <h2 class="ncm-title">Capture Field Prospect (Draft)</h2>
          <p class="ncm-subtitle muted small">Use this when you meet a customer before ERP sync has their code. Visits and deals can be logged; quotations unlock after ERP promotes this draft.</p>
        </div>
        <button class="ncm-close" type="button" aria-label="Close">
          <svg width="18" height="18" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
        </button>
      </div>
      <form id="draft-cust-form" class="ncm-form" novalidate>
        <div class="ncm-section">
          <div class="ncm-row">
            <div class="ncm-field">
              <label class="ncm-label">Customer Name <span class="ncm-req">*</span></label>
              <input class="ncm-input" name="name" required maxlength="200" placeholder="Company or person name" />
            </div>
          </div>
          <div class="ncm-row ncm-row--2">
            <div class="ncm-field">
              <label class="ncm-label">Tax ID <span class="ncm-hint-label">(optional — auto-links when ERP syncs)</span></label>
              <input class="ncm-input" name="taxId" maxlength="20" placeholder="13-digit Thai Tax ID" />
            </div>
            <div class="ncm-field">
              <label class="ncm-label">Phone <span class="ncm-hint-label">(optional)</span></label>
              <input class="ncm-input" name="phone" maxlength="40" placeholder="e.g. 02-123-4567" />
            </div>
          </div>
          <div class="ncm-row ncm-row--2">
            <div class="ncm-field">
              <label class="ncm-label">Customer Type</label>
              <select class="ncm-input" name="customerType">
                <option value="COMPANY" selected>Company</option>
                <option value="PERSONAL">Personal</option>
              </select>
            </div>
            <div class="ncm-field">
              <label class="ncm-label">Customer Group <span class="ncm-hint-label">(optional)</span></label>
              <select class="ncm-input" name="customerGroupId">
                <option value="">No group</option>
                ${(deps?.getCustomerGroups?.() || []).filter((g) => g.isActive).map((g) => `<option value="${g.id}">${escHtml(g.code)} — ${escHtml(g.name)}</option>`).join("")}
              </select>
            </div>
          </div>
          <div class="ncm-row">
            <div class="ncm-field">
              <label class="ncm-label">Address <span class="ncm-hint-label">(optional)</span></label>
              <input class="ncm-input" name="addressLine1" maxlength="400" placeholder="Street, city, district" />
            </div>
          </div>
        </div>
        <div class="ncm-footer">
          <button type="button" class="ghost" data-act="cancel">Cancel</button>
          <button type="submit" class="draft-cust-submit-btn" data-act="submit">Save Draft</button>
        </div>
      </form>
    </div>
  `;
  mountOverlay(overlay);

  overlay.querySelector(".ncm-close")?.addEventListener("click", () => closeOverlay(overlay));
  overlay.querySelector('[data-act="cancel"]')?.addEventListener("click", () => closeOverlay(overlay));
  overlay.addEventListener("click", (e) => { if (e.target === overlay) closeOverlay(overlay); });

  overlay.querySelector("#draft-cust-form")?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    const name = String(fd.get("name") || "").trim();
    if (!name) {
      setStatus("Customer name is required.", true);
      return;
    }
    const taxId = String(fd.get("taxId") || "").trim();
    const phone = String(fd.get("phone") || "").trim();
    const customerGroupId = String(fd.get("customerGroupId") || "").trim();
    const addressLine1 = String(fd.get("addressLine1") || "").trim();
    const customerType = String(fd.get("customerType") || "COMPANY");

    const body = {
      status: "DRAFT",
      name,
      customerType,
    };
    if (taxId) body.taxId = taxId;
    if (customerGroupId) body.customerGroupId = customerGroupId;
    if (phone) body.contacts = [{ fullName: name, tel: phone, isPrimary: true }];
    if (addressLine1) body.addresses = [{ label: "Office", addressLine1, isDefaultBilling: true, isDefaultShipping: true }];

    const submitBtn = overlay.querySelector('[data-act="submit"]');
    if (submitBtn) { submitBtn.disabled = true; submitBtn.textContent = "Saving…"; }
    try {
      const result = await api("/customers", { method: "POST", body: JSON.stringify(body) });
      if (result?.reusedExisting) {
        setStatus(`This Tax ID is already in the system — reusing existing customer "${result.name}".`);
      } else {
        setStatus("Draft customer saved.");
      }
      closeOverlay(overlay);
      if (typeof onCreated === "function") onCreated(result);
    } catch (err) {
      setStatus(err?.message || "Could not save draft.", true);
      if (submitBtn) { submitBtn.disabled = false; submitBtn.textContent = "Save Draft"; }
    }
  });
}

export function openPromoteDraftModal({ customer, onPromoted } = {}) {
  if (!customer) return;
  document.querySelector("#promote-draft-modal")?.remove();
  const overlay = document.createElement("div");
  overlay.id = "promote-draft-modal";
  overlay.className = "ncm-overlay";
  overlay.innerHTML = `
    <div class="ncm-panel" role="dialog" aria-modal="true" aria-label="Promote draft">
      <div class="ncm-header">
        <div>
          <h2 class="ncm-title">Promote Draft → Active</h2>
          <p class="ncm-subtitle muted small">${escHtml(customer.name || "")} — assign an ERP customer code. After this, quotations can be created against this customer.</p>
        </div>
        <button class="ncm-close" type="button" aria-label="Close">
          <svg width="18" height="18" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
        </button>
      </div>
      <form id="promote-draft-form" class="ncm-form" novalidate>
        <div class="ncm-section">
          <div class="ncm-row">
            <div class="ncm-field">
              <label class="ncm-label">Customer Code <span class="ncm-req">*</span></label>
              <input class="ncm-input" name="customerCode" required maxlength="40" placeholder="ERP code (must be unique)" />
            </div>
          </div>
        </div>
        <div class="ncm-footer">
          <button type="button" class="ghost" data-act="cancel">Cancel</button>
          <button type="submit" class="draft-cust-submit-btn" data-act="submit">Promote</button>
        </div>
      </form>
    </div>
  `;
  mountOverlay(overlay);

  overlay.querySelector(".ncm-close")?.addEventListener("click", () => closeOverlay(overlay));
  overlay.querySelector('[data-act="cancel"]')?.addEventListener("click", () => closeOverlay(overlay));
  overlay.addEventListener("click", (e) => { if (e.target === overlay) closeOverlay(overlay); });

  overlay.querySelector("#promote-draft-form")?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    const customerCode = String(fd.get("customerCode") || "").trim();
    if (!customerCode) {
      setStatus("Customer code is required.", true);
      return;
    }
    const submitBtn = overlay.querySelector('[data-act="submit"]');
    if (submitBtn) { submitBtn.disabled = true; submitBtn.textContent = "Promoting…"; }
    try {
      const result = await api(`/customers/${customer.id}/promote`, {
        method: "POST",
        body: JSON.stringify({ customerCode }),
      });
      setStatus("Draft promoted.");
      closeOverlay(overlay);
      if (typeof onPromoted === "function") onPromoted(result);
    } catch (err) {
      setStatus(err?.message || "Could not promote draft.", true);
      if (submitBtn) { submitBtn.disabled = false; submitBtn.textContent = "Promote"; }
    }
  });
}
