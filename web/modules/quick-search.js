// Cmd/Ctrl-K quick search modal. Indexes customers, items, deals, visits from
// the in-memory state.cache, plus a handful of "create X" actions. Navigation
// and helpers (`navigateToView`, `openDealCreateModal`, etc., and `asMoney`) are
// injected so this module doesn't need to know about the host app.
import { api } from "./api.js";
import { qs, switchView, setStatus } from "./dom.js";
import { state } from "./state.js";
import { escHtml } from "./utils.js";

const ICONS = {
  dashboard: {
    cls: "qs-item-icon--nav",
    svg: `<svg width="15" height="15" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/></svg>`
  },
  action: {
    cls: "qs-item-icon--action",
    svg: `<svg width="15" height="15" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>`
  },
  customer: {
    cls: "qs-item-icon--customer",
    svg: `<svg width="15" height="15" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/></svg>`
  },
  item: {
    cls: "qs-item-icon--item",
    svg: `<svg width="15" height="15" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/></svg>`
  },
  deal: {
    cls: "qs-item-icon--deal",
    svg: `<svg width="15" height="15" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/></svg>`
  },
  visit: {
    cls: "qs-item-icon--visit",
    svg: `<svg width="15" height="15" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/></svg>`
  },
  quotation: {
    cls: "qs-item-icon--quotation",
    svg: `<svg width="15" height="15" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/><polyline points="10 9 9 9 8 9"/></svg>`
  }
};

export function initQuickSearch({
  navigateToView,
  navigateToMasterPage,
  openDealCreateModal,
  openVisitCreateModal,
  asMoney,
  attachGlobalTriggers = true
} = {}) {
  const modal    = qs("#quick-search-modal");
  const backdrop = qs("#qs-backdrop");
  const input    = qs("#qs-input");
  const results  = qs("#qs-results");

  if (!modal || !input || !results) return;

  let activeIdx = -1;
  let renderRequestId = 0;

  function openSearch() {
    modal.hidden = false;
    activeIdx = -1;
    input.value = "";
    void renderResults("");
    requestAnimationFrame(() => input.focus());
  }

  function closeSearch() {
    modal.hidden = true;
  }

  quickSearchControls = {
    open: openSearch,
    close: closeSearch,
    toggle: () => {
      modal.hidden ? openSearch() : closeSearch();
    }
  };

  function dealStageOf(dealId) {
    return (state.cache.dealStages || []).find((s) =>
      (s.deals || []).some((x) => x.id === dealId)
    )?.stageName || "";
  }

  function matchesAny(q, ...terms) {
    return terms.filter(Boolean).some((t) => String(t).toLowerCase().includes(q));
  }

  async function resolveCustomerMatches(query) {
    const q = query.trim().toLowerCase();
    if (!q) return [];

    const cachedCustomers = state.cache.customers || [];
    if (cachedCustomers.length) {
      return cachedCustomers.filter((c) =>
        matchesAny(q, c.name, c.code, c.customerCode, c.email, c.phone)
      );
    }

    if (q.length < 2) return [];

    try {
      const params = new URLSearchParams({
        q,
        limit: "6"
      });
      if (state.customerScope) params.set("scope", state.customerScope);
      const rows = await api(`/customers/search?${params.toString()}`);
      return rows.map((customer) => ({
        ...customer,
        code: customer.customerCode
      }));
    } catch {
      return [];
    }
  }

  function buildIndex(query, customerMatches = null) {
    const q = query.trim().toLowerCase();
    const groups = [];

    const ACTION_DEFS = [
      {
        name: "Create Deal",
        meta: "Add a new deal to the pipeline",
        keywords: ["deal", "create", "new", "pipeline", "opportunity"],
        action() {
          closeSearch();
          navigateToView?.("deals");
          switchView("deals");
          requestAnimationFrame(() => openDealCreateModal?.(state.cache.kanban));
        }
      },
      {
        name: "Create Visit",
        meta: "Schedule or log a customer visit",
        keywords: ["visit", "create", "new", "schedule", "checkin", "check"],
        action() {
          closeSearch();
          navigateToView?.("visits");
          switchView("visits");
          requestAnimationFrame(() => openVisitCreateModal?.());
        }
      },
      {
        name: "Create Quotation",
        meta: "Open Deals to prepare a new quotation",
        keywords: ["quotation", "quote", "quot", "create", "new", "qt"],
        action() {
          closeSearch();
          navigateToView?.("deals");
          switchView("deals");
          setStatus("Select a deal to create a quotation.");
        }
      }
    ];

    const matchingActions = !q
      ? ACTION_DEFS
      : ACTION_DEFS.filter((a) => a.keywords.some((k) => k.includes(q) || q.includes(k)));

    if (matchingActions.length) {
      groups.push({
        label: "Actions",
        items: matchingActions.map((a) => ({
          type: "action",
          name: a.name,
          meta: a.meta,
          action: a.action
        }))
      });
    }

    if (!q || matchesAny(q, "dashboard", "report", "kpi", "performance")) {
      groups.push({
        label: "Navigation",
        items: [{
          type: "dashboard",
          name: "Dashboard",
          meta: "KPIs, pipeline, team performance",
          action() { closeSearch(); navigateToView?.("dashboard"); switchView("dashboard"); }
        }]
      });
    }

    if (q) {
      const allDeals = (state.cache.dealStages || []).flatMap((s) => s.deals || []);
      const allVisits = state.cache.visits || [];
      const matchedCustomers = customerMatches ?? (state.cache.customers || []).filter((c) =>
        matchesAny(q, c.name, c.code, c.customerCode, c.email, c.phone)
      );

      matchedCustomers.slice(0, 2).forEach((customer) => {
        const custDeals = allDeals.filter(
          (d) => d.customer?.id === customer.id || d.customerId === customer.id
        );
        const custVisits = allVisits.filter(
          (v) => v.customer?.id === customer.id || v.customerId === customer.id
        );

        const items = [];

        items.push({
          type: "customer",
          name: customer.name,
          meta: [customer.code, customer.email].filter(Boolean).join(" · ") || "Customer",
          action() { closeSearch(); navigateToMasterPage?.("customers"); switchView("master"); }
        });

        custDeals.slice(0, 4).forEach((d) => {
          items.push({
            type: "deal",
            name: d.dealName,
            meta: [d.dealNo, dealStageOf(d.id)].filter(Boolean).join(" · "),
            badge: d.estimatedValue ? asMoney?.(d.estimatedValue) : null,
            action() { closeSearch(); navigateToView?.("deals"); switchView("deals"); }
          });
        });

        custVisits.slice(0, 3).forEach((v) => {
          const dateStr = v.plannedAt ? new Date(v.plannedAt).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" }) : "";
          items.push({
            type: "visit",
            name: `Visit${dateStr ? " · " + dateStr : ""}`,
            meta: [v.visitType, v.status?.replace(/_/g, " "), v.objective].filter(Boolean).join(" · "),
            action() { closeSearch(); navigateToView?.("visits"); switchView("visits"); }
          });
        });

        if (custDeals.length) {
          items.push({
            type: "quotation",
            name: "View Quotations",
            meta: `${custDeals.length} deal${custDeals.length > 1 ? "s" : ""} — open Deals to manage quotations`,
            action() { closeSearch(); switchView("deals"); }
          });
        }

        groups.push({ label: `Records for ${customer.name}`, items });
      });

      if (matchedCustomers.length > 0) {
        const itemMatches = (state.cache.items || []).filter((i) =>
          matchesAny(q, i.name, i.code, i.sku)
        );
        if (itemMatches.length) {
          groups.push({
            label: "Items",
            items: itemMatches.slice(0, 5).map((i) => ({
              type: "item",
              name: i.name,
              meta: [i.code, i.sku, i.unit].filter(Boolean).join(" · ") || "Item",
              action() { closeSearch(); navigateToMasterPage?.("items"); switchView("master"); }
            }))
          });
        }
        return groups;
      }
    }

    const customers = q
      ? (customerMatches ?? (state.cache.customers || []).filter((c) =>
          matchesAny(q, c.name, c.code, c.customerCode, c.email, c.phone)
        ))
      : (state.cache.customers || []);
    if (customers.length) {
      groups.push({
        label: "Customers",
        items: customers.slice(0, 6).map((c) => ({
          type: "customer",
          name: c.name,
          meta: [c.code, c.email, c.phone].filter(Boolean).join(" · ") || "Customer",
          action() { closeSearch(); navigateToMasterPage?.("customers"); switchView("master"); }
        }))
      });
    }

    const items = (state.cache.items || []).filter((i) =>
      !q || matchesAny(q, i.name, i.code, i.sku)
    );
    if (items.length) {
      groups.push({
        label: "Items",
        items: items.slice(0, 6).map((i) => ({
          type: "item",
          name: i.name,
          meta: [i.code, i.sku, i.unit].filter(Boolean).join(" · ") || "Item",
          action() { closeSearch(); navigateToMasterPage?.("items"); switchView("master"); }
        }))
      });
    }

    const allDeals = (state.cache.dealStages || []).flatMap((s) => s.deals || []);
    const deals = allDeals.filter((d) =>
      !q || matchesAny(q, d.dealNo, d.dealName, d.customer?.name)
    );
    if (deals.length) {
      groups.push({
        label: "Deals",
        items: deals.slice(0, 6).map((d) => ({
          type: "deal",
          name: d.dealName,
          meta: [d.dealNo, d.customer?.name, dealStageOf(d.id)].filter(Boolean).join(" · "),
          badge: d.estimatedValue ? asMoney?.(d.estimatedValue) : null,
          action() { closeSearch(); switchView("deals"); }
        }))
      });
    }

    const visits = (state.cache.visits || []).filter((v) =>
      !q || matchesAny(q, v.customer?.name, v.objective, v.status)
    );
    if (visits.length) {
      groups.push({
        label: "Visits",
        items: visits.slice(0, 6).map((v) => ({
          type: "visit",
          name: v.customer?.name || "Visit",
          meta: [v.visitType, v.status?.replace(/_/g, " "), v.objective].filter(Boolean).join(" · "),
          action() { closeSearch(); switchView("visits"); }
        }))
      });
    }

    return groups;
  }

  function iconHTML(type) {
    const ic = ICONS[type] || ICONS.dashboard;
    return `<div class="qs-item-icon ${ic.cls}">${ic.svg}</div>`;
  }

  async function renderResults(query) {
    const requestId = ++renderRequestId;
    const customerMatches = await resolveCustomerMatches(query);
    if (requestId !== renderRequestId) return;

    const groups = buildIndex(query, customerMatches);
    activeIdx = -1;

    if (!groups.length) {
      results.innerHTML = query.trim()
        ? `<div class="qs-empty"><strong>No results found</strong>Try a customer name, deal number, or action like "create deal"</div>`
        : `<div class="qs-empty"><strong>Start typing to search</strong>Type a customer code to see all their records</div>`;
      return;
    }

    results.innerHTML = groups.map((group) => `
      <div class="qs-group-label">${escHtml(group.label)}</div>
      ${group.items.map((item) => `
        <button class="qs-item qs-item--${item.type}" type="button" role="option">
          ${iconHTML(item.type)}
          <div class="qs-item-body">
            <div class="qs-item-name">${escHtml(item.name)}</div>
            ${item.meta ? `<div class="qs-item-meta">${escHtml(item.meta)}</div>` : ""}
          </div>
          ${item.badge ? `<span class="qs-item-badge">${escHtml(item.badge)}</span>` : ""}
        </button>
      `).join("")}
    `).join("");

    const flatItems = groups.flatMap((g) => g.items);
    results.querySelectorAll(".qs-item").forEach((btn, idx) => {
      btn.addEventListener("click", () => flatItems[idx]?.action());
    });
  }

  function getItems() {
    return Array.from(results.querySelectorAll(".qs-item"));
  }

  function setActive(idx) {
    const items = getItems();
    items.forEach((el, i) => el.classList.toggle("qs-active", i === idx));
    if (items[idx]) items[idx].scrollIntoView({ block: "nearest" });
    activeIdx = idx;
  }

  input.addEventListener("input", () => { void renderResults(input.value); });

  input.addEventListener("keydown", (e) => {
    const items = getItems();
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive(Math.min(activeIdx + 1, items.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive(Math.max(activeIdx - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (activeIdx >= 0 && items[activeIdx]) items[activeIdx].click();
    } else if (e.key === "Escape") {
      closeSearch();
    }
  });

  backdrop?.addEventListener("click", closeSearch);
  if (attachGlobalTriggers) {
    qs("#search-btn")?.addEventListener("click", openSearch);
    document.addEventListener("keydown", (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault();
        modal.hidden ? openSearch() : closeSearch();
      }
      if (e.key === "Escape" && !modal.hidden) closeSearch();
    });
  }
}

let quickSearchControls = {
  open: null,
  close: null,
  toggle: null
};

export function openQuickSearch() {
  quickSearchControls.open?.();
}

export function closeQuickSearch() {
  quickSearchControls.close?.();
}

export function toggleQuickSearch() {
  quickSearchControls.toggle?.();
}
