// Customer 360 detail page: header, KPI strip, and tab panes
// (Deals / Visits / Contacts / Addresses / Overview). App-level helpers
// (`asMoney`, `avatarColor`, `c360Initials`, routing + modal openers,
// `renderMasterData`) are injected via `setCustomer360Deps()`.
import { qs, views, switchView, setStatus } from "./dom.js";
import { state } from "./state.js";
import { api } from "./api.js";
import { escHtml } from "./utils.js";
import { icon } from "./icons.js";

let deps = {
  asMoney: (v) => String(v),
  avatarColor: () => "#ccc",
  c360Initials: (n) => (n || "?").slice(0, 2).toUpperCase(),
  navigateToCustomer360: () => {},
  navigateToMasterPage: () => {},
  renderMasterData: () => {},
  openVisitCreateModal: () => {},
  openDealCreateModal: () => {},
  openDeal360: () => {},
  openVisitDetail: () => {}
};

export function setCustomer360Deps(d) {
  deps = { ...deps, ...d };
}

export async function openCustomer360(customerIdOrCode, customerCode) {
  // customerCode is the human-readable code used in the URL
  // customerIdOrCode may be a UUID (from list click) or a code (from URL/popstate)
  const urlCode = customerCode || customerIdOrCode;
  deps.navigateToCustomer360(urlCode);
  switchView("master");
  setStatus("Loading customer…");
  try {
    const { customer, deals, visits, children } = await api(`/customers/${encodeURIComponent(customerIdOrCode)}/360`);
    state.c360 = { customer, deals, visits, children: children || [], activeTab: "deals" };
    setStatus("");
    renderCustomer360();
  } catch (error) {
    setStatus(error.message, true);
  }
}

function renderC360TabContent(c360) {
  const { customer, deals, visits, children, activeTab } = c360;

  if (activeTab === "children") {
    const list = children ?? [];
    if (!list.length) return `<div class="c360-empty"><div class="c360-empty-icon">${icon('building')}</div>No subsidiaries linked to this customer.</div>`;
    return `
      <div style="border:1px solid var(--border);border-radius:var(--r-md);overflow:hidden;margin-top:var(--sp-4)">
        ${list.map((c) => `
          <div class="c360-child-row c360-child-row--clickable" data-child-id="${escHtml(c.id)}" data-child-code="${escHtml(c.customerCode || "")}" role="button" tabindex="0">
            <div class="c360-contact-avatar" style="background:${deps.avatarColor(c.name)}">${deps.c360Initials(c.name)}</div>
            <div class="c360-child-body">
              <div class="c360-child-name">${escHtml(c.name)}</div>
              <div class="c360-child-meta">
                ${c.customerCode ? `<span class="c360-child-code">${escHtml(c.customerCode)}</span>` : ""}
                ${c.branchCode ? `<span class="cust-branch-pill">Br ${escHtml(c.branchCode)}</span>` : ""}
                ${c.status === "DRAFT" ? `<span class="badge badge--open">DRAFT</span>` : ""}
              </div>
            </div>
          </div>`).join("")}
      </div>`;
  }

  if (activeTab === "overview") {
    const cfEntries = customer.customFields && typeof customer.customFields === "object"
      ? Object.entries(customer.customFields)
      : [];
    return `
      <div class="c360-info-grid" style="margin-top:var(--sp-4)">
        <div class="c360-info-section">
          <p class="c360-info-section-title">Customer Info</p>
          <div class="c360-info-row"><span class="c360-info-key">Code</span><span class="c360-info-val">${escHtml(customer.customerCode)}</span></div>
          <div class="c360-info-row"><span class="c360-info-key">Group</span><span class="c360-info-val">${customer.customerGroup ? escHtml(customer.customerGroup.code + " — " + customer.customerGroup.name) : "—"}</span></div>
          <div class="c360-info-row"><span class="c360-info-key">Created</span><span class="c360-info-val">${new Date(customer.createdAt).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" })}</span></div>
          ${customer.siteLat != null && customer.siteLng != null
            ? `<div class="c360-info-row"><span class="c360-info-key">Location</span><span class="c360-info-val"><a class="c360-address-map" href="https://maps.google.com/?q=${customer.siteLat},${customer.siteLng}" target="_blank" rel="noopener">${icon('location')} Open map</a></span></div>`
            : ""}
        </div>
        ${cfEntries.length > 0 ? `
          <div class="c360-info-section">
            <p class="c360-info-section-title">Custom Fields</p>
            ${cfEntries.map(([k, v]) => `
              <div class="c360-info-row">
                <span class="c360-info-key">${escHtml(k)}</span>
                <span class="c360-info-val">${escHtml(String(v))}</span>
              </div>`).join("")}
          </div>` : ""}
      </div>`;
  }

  if (activeTab === "deals") {
    if (!deals.length) return `<div class="c360-empty"><div class="c360-empty-icon">${icon('clipboard')}</div>No deals yet for this customer.</div>`;
    const stageName = (d) => d.stage?.stageName ?? "Unknown";
    return `
      <div style="border:1px solid var(--border);border-radius:var(--r-md);overflow:hidden;margin-top:var(--sp-4)">
        ${deals.map((d, i) => `
          <div class="c360-deal-row c360-deal-row--clickable" data-deal-id="${escHtml(d.id)}" data-deal-no="${escHtml(d.dealNo ?? "")}" role="button" tabindex="0">
            <span class="c360-deal-num">${i + 1}</span>
            <div class="c360-deal-body">
              <div class="c360-deal-name">${escHtml(d.dealName)}</div>
              <div class="c360-deal-meta">
                ${escHtml(stageName(d))} · Follow-up ${d.followUpAt ? new Date(d.followUpAt).toLocaleDateString("en-GB", { day: "numeric", month: "short" }) : "—"}
                ${d.closedAt ? ` · Closed ${new Date(d.closedAt).toLocaleDateString("en-GB", { day: "numeric", month: "short" })}` : ""}
              </div>
            </div>
            <div class="c360-deal-right">
              <span class="badge badge--${(stageName(d).toLowerCase().includes("won") ? "won" : stageName(d).toLowerCase().includes("lost") ? "lost" : "open")}">${escHtml(stageName(d))}</span>
              <span class="c360-deal-value">${deps.asMoney(d.estimatedValue)}</span>
            </div>
          </div>`).join("")}
      </div>`;
  }

  if (activeTab === "visits") {
    if (!visits.length) return `<div class="c360-empty"><div class="c360-empty-icon">${icon('location')}</div>No visits recorded for this customer.</div>`;
    return `
      <div style="border:1px solid var(--border);border-radius:var(--r-md);overflow:hidden;margin-top:var(--sp-4)">
        ${visits.map((v) => {
          const vDate = new Date(v.plannedAt || v.createdAt);
          const notes = v.voiceNoteTranscript || v.notes || "";
          return `
            <div class="c360-visit-row c360-visit-row--clickable" data-visit-id="${escHtml(v.id)}" role="button" tabindex="0">
              <div class="c360-visit-date">
                <strong>${vDate.getDate()}</strong>
                <span>${vDate.toLocaleDateString("en-GB", { month: "short", year: "2-digit" })}</span>
              </div>
              <div class="c360-visit-body">
                <div class="c360-visit-rep">${escHtml(v.rep?.fullName ?? v.repName ?? "—")}</div>
                ${notes ? `<div class="c360-visit-notes">${escHtml(notes)}</div>` : ""}
              </div>
              <span class="badge badge--${v.status === "COMPLETED" ? "won" : v.status === "CANCELLED" ? "lost" : "open"}">${v.status ?? "—"}</span>
            </div>`;
        }).join("")}
      </div>`;
  }

  if (activeTab === "contacts") {
    const contacts = customer.contacts ?? [];
    if (!contacts.length) return `<div class="c360-empty"><div class="c360-empty-icon">${icon('user')}</div>No contacts added yet.</div>`;
    return `
      <div style="border:1px solid var(--border);border-radius:var(--r-md);overflow:hidden;margin-top:var(--sp-4)">
        ${contacts.map((c) => `
          <div class="c360-contact-row">
            <div class="c360-contact-avatar" style="background:${deps.avatarColor(c.name)}">${deps.c360Initials(c.name)}</div>
            <div>
              <div class="c360-contact-name">${escHtml(c.name)}</div>
              <div class="c360-contact-pos">${escHtml(c.position)}</div>
            </div>
          </div>`).join("")}
      </div>`;
  }

  if (activeTab === "addresses") {
    const addresses = customer.addresses ?? [];
    if (!addresses.length) return `<div class="c360-empty"><div class="c360-empty-icon">${icon('building')}</div>No addresses added yet.</div>`;
    return `
      <div class="c360-addresses-grid" style="margin-top:var(--sp-4)">
        ${addresses.map((a) => `
          <div class="c360-address-card">
            <div class="c360-address-labels">
              ${a.isDefaultBilling ? '<span class="c360-address-badge">Billing</span>' : ""}
              ${a.isDefaultShipping ? '<span class="c360-address-badge">Shipping</span>' : ""}
            </div>
            <div class="c360-address-line">
              ${escHtml(a.addressLine1)}${a.city ? ", " + escHtml(a.city) : ""}${a.state ? ", " + escHtml(a.state) : ""}${a.country ? ", " + escHtml(a.country) : ""}${a.postalCode ? " " + escHtml(a.postalCode) : ""}
            </div>
            ${a.latitude != null && a.longitude != null
              ? `<a class="c360-address-map" href="https://maps.google.com/?q=${a.latitude},${a.longitude}" target="_blank" rel="noopener">
                  <svg width="12" height="12" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/></svg>
                  Open in Maps
                </a>`
              : ""}
          </div>`).join("")}
      </div>`;
  }

  return "";
}

export function renderCustomer360() {
  const c360 = state.c360;
  if (!c360) return;
  const { customer, deals, visits, children } = c360;
  const childrenList = children ?? [];

  const activeDealCount = deals.filter(
    (d) => !["won","lost"].some((w) => (d.stage?.stageName ?? "").toLowerCase().includes(w))
  ).length;
  const pipelineValue = deals
    .filter((d) => !["won","lost"].some((w) => (d.stage?.stageName ?? "").toLowerCase().includes(w)))
    .reduce((sum, d) => sum + (d.estimatedValue ?? 0), 0);
  const wonValue = deals
    .filter((d) => (d.stage?.stageName ?? "").toLowerCase().includes("won"))
    .reduce((sum, d) => sum + (d.estimatedValue ?? 0), 0);

  const tabs = [
    { key: "deals", label: "Deals", count: deals.length },
    { key: "visits", label: "Visits", count: visits.length },
    { key: "contacts", label: "Contacts", count: customer.contacts?.length ?? 0 },
    { key: "addresses", label: "Addresses", count: customer.addresses?.length ?? 0 },
    ...(childrenList.length > 0 ? [{ key: "children", label: "Subsidiaries", count: childrenList.length }] : []),
    { key: "overview", label: "Overview", count: null }
  ];

  const federationStatus = customer.federationStatus;
  const federationBanner = federationStatus === "stale"
    ? `<div class="federation-banner federation-banner--stale" role="status">
         <svg width="14" height="14" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
         <span>Showing <strong>cached</strong> customer data — the upstream MySQL is not responding right now. Some attributes may be out of date.</span>
       </div>`
    : "";

  views.master.innerHTML = `
    <div class="master-outer">
      <div class="c360-wrap">
        ${federationBanner}
        <div class="c360-breadcrumb">
          <button class="c360-back-btn" id="c360-back">
            <svg width="14" height="14" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"/></svg>
            Customers
          </button>
          <span class="c360-breadcrumb-sep">›</span>
          <span>${escHtml(customer.customerCode)} — ${escHtml(customer.name)}</span>
        </div>

        <div class="c360-header">
          <div class="c360-header-left">
            <div class="c360-avatar" style="background:${deps.avatarColor(customer.name)}">${deps.c360Initials(customer.name)}</div>
            <div class="c360-header-info">
              ${customer.parentCustomer ? `
                <div class="c360-parent-link" data-parent-id="${escHtml(customer.parentCustomer.id)}" data-parent-code="${escHtml(customer.parentCustomer.customerCode || "")}" role="button" tabindex="0" title="Open parent customer">
                  <svg width="11" height="11" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg>
                  Subsidiary of <strong>${escHtml(customer.parentCustomer.name)}</strong>${customer.parentCustomer.customerCode ? ` <span class="c360-parent-code">(${escHtml(customer.parentCustomer.customerCode)})</span>` : ""}
                </div>` : ""}
              <h2 class="c360-name">${escHtml(customer.name)}${customer.branchCode && customer.branchCode !== "00000" ? ` <span class="cust-branch-pill" style="font-size:0.7em;vertical-align:middle">Br ${escHtml(customer.branchCode)}</span>` : ""}</h2>
              <div class="c360-meta">
                <span class="c360-code">${escHtml(customer.customerCode)}</span>
                ${visits.length > 0 ? `
                  <span class="c360-meta-sep">·</span>
                  <span class="c360-meta-item">Last visit ${new Date(visits[0].plannedAt || visits[0].createdAt).toLocaleDateString("en-GB", { day: "numeric", month: "short" })}</span>` : ""}
              </div>
            </div>
          </div>
          <div class="c360-header-actions">
            <button class="c360-action ghost" id="c360-schedule-visit">
              <svg width="14" height="14" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="18" rx="2" ry="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>
              Schedule Visit
            </button>
            <button class="c360-action" id="c360-create-deal">
              <svg width="14" height="14" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
              New Deal
            </button>
          </div>
        </div>

        <div class="c360-kpi-strip">
          <div class="c360-kpi">
            <p class="c360-kpi-label">Total Deals</p>
            <p class="c360-kpi-value">${deals.length}</p>
          </div>
          <div class="c360-kpi">
            <p class="c360-kpi-label">Active Deals</p>
            <p class="c360-kpi-value">${activeDealCount}</p>
          </div>
          <div class="c360-kpi">
            <p class="c360-kpi-label">Pipeline Value</p>
            <p class="c360-kpi-value" style="font-size:1.1rem">${deps.asMoney(pipelineValue)}</p>
          </div>
          <div class="c360-kpi">
            <p class="c360-kpi-label">Won Value</p>
            <p class="c360-kpi-value" style="color:oklch(55% 0.18 145);font-size:1.1rem">${deps.asMoney(wonValue)}</p>
          </div>
          <div class="c360-kpi">
            <p class="c360-kpi-label">Visits</p>
            <p class="c360-kpi-value">${visits.length}</p>
          </div>
        </div>

        <div class="c360-tab-bar">
          ${tabs.map((t) => `
            <button class="c360-tab-btn ${c360.activeTab === t.key ? "active" : ""}" data-tab="${t.key}">
              ${t.label}
              ${t.count !== null ? `<span class="c360-tab-count">${t.count}</span>` : ""}
            </button>`).join("")}
        </div>

        <div class="c360-tab-content" id="c360-tab-content">
          ${renderC360TabContent(c360)}
        </div>
      </div>
    </div>
  `;

  views.master.querySelector("#c360-back")?.addEventListener("click", () => {
    state.c360 = null;
    deps.navigateToMasterPage("customers");
    switchView("master");
    deps.renderMasterData(state.cache.paymentTerms || []);
  });

  views.master.querySelectorAll(".c360-tab-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      state.c360.activeTab = btn.dataset.tab;
      views.master.querySelectorAll(".c360-tab-btn").forEach((b) => b.classList.toggle("active", b.dataset.tab === btn.dataset.tab));
      const content = views.master.querySelector("#c360-tab-content");
      if (content) content.innerHTML = renderC360TabContent(state.c360);
    });
  });

  const tabContent = views.master.querySelector("#c360-tab-content");
  if (tabContent) {
    const handleRowActivate = (target) => {
      const dealRow = target.closest(".c360-deal-row--clickable");
      if (dealRow) {
        const id = dealRow.dataset.dealId;
        const no = dealRow.dataset.dealNo;
        if (id) deps.openDeal360(id, no || id);
        return;
      }
      const visitRow = target.closest(".c360-visit-row--clickable");
      if (visitRow) {
        const id = visitRow.dataset.visitId;
        if (id) deps.openVisitDetail(id);
        return;
      }
      const childRow = target.closest(".c360-child-row--clickable");
      if (childRow) {
        const id = childRow.dataset.childId;
        const code = childRow.dataset.childCode;
        if (id) openCustomer360(id, code || id);
      }
    };
    tabContent.addEventListener("click", (e) => handleRowActivate(e.target));
    tabContent.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        const row = e.target.closest(".c360-deal-row--clickable, .c360-visit-row--clickable, .c360-child-row--clickable");
        if (row) {
          e.preventDefault();
          handleRowActivate(e.target);
        }
      }
    });
  }

  const parentLink = views.master.querySelector(".c360-parent-link");
  if (parentLink) {
    const goParent = () => {
      const id = parentLink.dataset.parentId;
      const code = parentLink.dataset.parentCode;
      if (id) openCustomer360(id, code || id);
    };
    parentLink.addEventListener("click", goParent);
    parentLink.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        goParent();
      }
    });
  }

  views.master.querySelector("#c360-schedule-visit")?.addEventListener("click", async () => {
    deps.openVisitCreateModal();
    const modal = qs("#visit-create-modal");
    if (!modal) return;
    const hid = modal.querySelector("#visit-customer-id");
    const inp = modal.querySelector("#visit-customer-input");
    if (hid) hid.value = customer.id;
    if (inp) inp.value = customer.name;
    const dealLabel  = modal.querySelector("#visit-deal-label");
    const dealSelect = modal.querySelector("#visit-deal-select");
    if (dealLabel && dealSelect) {
      dealSelect.innerHTML = `<option value="">Loading…</option>`;
      dealLabel.hidden = false;
      try {
        const deals = await api(`/deals?customerId=${encodeURIComponent(customer.id)}`);
        const active = deals.filter((d) => d.status !== "WON" && d.status !== "LOST");
        dealSelect.innerHTML = active.length
          ? `<option value="">— No deal —</option>` + active.map((d) => `<option value="${d.id}">${escHtml(d.dealName)}${d.stage?.stageName ? " · " + escHtml(d.stage.stageName) : ""}</option>`).join("")
          : `<option value="">— No open deals —</option>`;
      } catch {
        dealSelect.innerHTML = `<option value="">— Could not load deals —</option>`;
      }
    }
  });

  views.master.querySelector("#c360-create-deal")?.addEventListener("click", () => {
    deps.openDealCreateModal(state.cache.kanban);
    const modal = qs("#deal-create-modal");
    if (!modal) return;
    const hid = modal.querySelector("#deal-customer-id");
    const inp = modal.querySelector("#deal-customer-input");
    if (hid) hid.value = customer.id;
    if (inp) inp.value = customer.name;
  });
}
