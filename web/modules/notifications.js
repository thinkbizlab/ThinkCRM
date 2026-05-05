// Bell-icon notifications. Polls /me/notifications every 60s while the
// tab is visible, renders the panel when the bell is opened, and marks
// items as seen so the badge clears.
//
// Per /Users/bank/.claude/projects/-Users-bank-Claude-ThinkCRM/memory/feedback_frontend_module_organization.md:
// new feature code lives in a module, not app.js. Wired via setNotificationsDeps
// from app.js (host injects api, escHtml, openCheckOutModal callback, etc.).

import { qs } from "./dom.js";

let deps = {
  api: async () => ({ groups: [], totalUnread: 0, lastSeenAt: null }),
  setStatus: () => {},
  escHtml: (s) => String(s ?? ""),
  // Called when the user clicks the inline "Check out" button on a
  // pending_checkout item. Host wires this to the existing checkout modal
  // (web/app.js openCheckOutModal). Receives an onSuccess callback so we
  // can refresh after checkout finishes.
  openCheckOutModal: () => {}
};

export function setNotificationsDeps(d) {
  deps = { ...deps, ...d };
}

let pollTimer = null;
let inFlight = false;
let lastPayload = { groups: [], totalUnread: 0, lastSeenAt: null };
const POLL_INTERVAL_MS = 60_000;

// ── SVG glyphs per group `kind` (server returns `icon: "deal"` etc.) ───────
// Keeping these inline keeps the bell self-contained — no extra HTTP for an
// icon font. SVG strings are static text, no escaping concerns.
const ICON_PATHS = {
  checkout:   '<polyline points="20 6 9 17 4 12"/>',
  deal:       '<line x1="12" y1="1" x2="12" y2="23"/><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/>',
  visit:      '<path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/>',
  prospect:   '<path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/>',
  quotation:  '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/>',
  customer:   '<path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>',
  "sync-error": '<polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/>',
  merge:      '<circle cx="6" cy="18" r="3"/><circle cx="18" cy="18" r="3"/><circle cx="6" cy="6" r="3"/><path d="M6 9v6"/><path d="M6 15a9 9 0 0 0 9 0"/>',
  billing:    '<rect x="1" y="4" width="22" height="16" rx="2" ry="2"/><line x1="1" y1="10" x2="23" y2="10"/>'
};

function iconSvg(kind) {
  const inner = ICON_PATHS[kind] || '<circle cx="12" cy="12" r="10"/>';
  return `<svg width="14" height="14" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${inner}</svg>`;
}

// ── Badge rendering ────────────────────────────────────────────────────────
function renderBadge(totalUnread) {
  const dot = qs("#notif-dot");
  if (!dot) return;
  if (totalUnread > 0) {
    dot.textContent = totalUnread > 9 ? "9+" : String(totalUnread);
    dot.classList.add("notif-dot--has-count");
    dot.hidden = false;
  } else {
    dot.textContent = "";
    dot.classList.remove("notif-dot--has-count");
    dot.hidden = true;
  }
}

// ── Panel rendering ────────────────────────────────────────────────────────
function relativeTime(iso) {
  const ts = new Date(iso).getTime();
  if (!Number.isFinite(ts)) return "";
  const diffMin = Math.max(0, Math.round((Date.now() - ts) / 60000));
  if (diffMin < 1) return "just now";
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.round(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  return `${Math.round(diffHr / 24)}d ago`;
}

function renderGroupRow(group) {
  // pending_checkout has its own per-item layout with inline action buttons.
  if (group.kind === "pending_checkout" && Array.isArray(group.items)) {
    return group.items.map((item) => `
      <div class="notif-item unread">
        <div class="notif-icon notif-icon--checkout" title="Pending checkout">${iconSvg("checkout")}</div>
        <div class="notif-body">
          <p class="notif-title">${deps.escHtml(item.customerName)}</p>
          <p class="notif-desc">Checked in ${relativeTime(item.checkInAt)} — don't forget to check out.</p>
        </div>
        <button type="button" class="notif-action-btn" data-act="checkout" data-visit-id="${item.visitId}" data-customer="${deps.escHtml(item.customerName)}">Check out</button>
      </div>
    `).join("");
  }
  // Aggregated row — count + label + click target.
  const isUnread = group.unread > 0;
  const href = group.href || "#";
  return `
    <a class="notif-item ${isUnread ? "unread" : ""}" href="${href}" data-act="navigate" data-href="${href}">
      <div class="notif-icon notif-icon--${group.kind.replace(/_/g, "-")}">${iconSvg(group.icon)}</div>
      <div class="notif-body">
        <p class="notif-title">${deps.escHtml(group.label)}</p>
      </div>
      ${isUnread ? '<span class="notif-unread-dot"></span>' : ""}
    </a>
  `;
}

function renderPanel(payload) {
  const list = qs("#notif-list");
  const countBadge = qs(".notif-count-badge");
  if (!list) return;
  const groups = payload.groups || [];
  if (countBadge) {
    countBadge.textContent = payload.totalUnread > 0
      ? `${payload.totalUnread} unread`
      : "All caught up";
  }
  if (groups.length === 0) {
    list.innerHTML = `<div class="notif-empty">You're all caught up.</div>`;
    return;
  }
  list.innerHTML = groups.map(renderGroupRow).join("");
  wireRowActions(list);
}

function wireRowActions(list) {
  // Checkout buttons → open existing modal, refresh on success.
  list.querySelectorAll('[data-act="checkout"]').forEach((btn) => {
    btn.addEventListener("click", (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      const visitId = btn.dataset.visitId;
      const customer = btn.dataset.customer || "";
      deps.openCheckOutModal(visitId, customer, () => fetchAndRender());
    });
  });
  // Navigation rows — let the browser handle the link, but also close the
  // panel optimistically for a snappier feel.
  list.querySelectorAll('[data-act="navigate"]').forEach((row) => {
    row.addEventListener("click", () => {
      const panel = qs("#notif-panel");
      if (panel) panel.hidden = true;
    });
  });
}

// ── Fetch + poll lifecycle ─────────────────────────────────────────────────
async function fetchAndRender() {
  if (inFlight) return lastPayload;
  inFlight = true;
  try {
    const payload = await deps.api("/me/notifications");
    lastPayload = payload || { groups: [], totalUnread: 0, lastSeenAt: null };
    renderBadge(lastPayload.totalUnread);
    if (qs("#notif-panel") && !qs("#notif-panel").hidden) {
      renderPanel(lastPayload);
    }
    return lastPayload;
  } catch {
    // Silent failure — bell is non-critical, don't pop a toast every minute
    // if the user's session expired or the network blipped. The badge stays
    // at whatever it last successfully showed.
    return lastPayload;
  } finally {
    inFlight = false;
  }
}

function startPolling() {
  if (pollTimer) return;
  fetchAndRender();
  pollTimer = setInterval(fetchAndRender, POLL_INTERVAL_MS);
}

function stopPolling() {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

// Initialize on load: start polling if the tab is visible, react to
// visibility changes so we don't burn requests when the user has the
// browser backgrounded.
export function initNotifications() {
  if (document.visibilityState === "visible") startPolling();
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") {
      startPolling();
    } else {
      stopPolling();
    }
  });
}

// Called when the user opens the bell panel: re-fetch fresh data, render,
// and tell the server we've seen everything (so the badge clears on the
// next poll).
export async function onBellOpen() {
  await fetchAndRender();
  renderPanel(lastPayload);
  // Optimistic badge clear — the next poll confirms.
  renderBadge(0);
  try {
    await deps.api("/me/notifications/seen", { method: "POST" });
  } catch {
    // If the seen-write fails, the badge will reappear on next poll.
    // Acceptable since the user did see the items.
  }
}
