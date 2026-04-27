// Cross-cutting DOM helpers, screen-level refs, view registry, and toast plumbing.
import { escHtml } from "./utils.js";
import { icon } from "./icons.js";

export const qs = (selector) => document.querySelector(selector);

export const authScreen = qs("#auth-screen");
export const appScreen  = qs("#app-screen");
export const statusBar  = qs("#status-bar");
export const pageTitle  = qs("#page-title");

export const views = {
  repHub:       qs("#view-rep-hub"),
  dashboard:    qs("#view-dashboard"),
  master:       qs("#view-master"),
  deals:        qs("#view-deals"),
  visits:       qs("#view-visits"),
  calendar:     qs("#view-calendar"),
  integrations: qs("#view-integrations"),
  settings:     qs("#view-settings"),
  superAdmin:   qs("#view-superAdmin")
};

export const pageTitleMap = {
  repHub:       "My Tasks",
  dashboard:    "Dashboard",
  master:       "Master Data",
  deals:        "Deals Pipeline",
  visits:       "Visit Execution",
  calendar:     "Sales Calendar",
  integrations: "Integration Logs",
  settings:     "Admin Settings",
  superAdmin:   "Super Admin"
};

export function switchView(target) {
  Object.entries(views).forEach(([key, el]) => {
    const isActive = key === target;
    el.classList.toggle("active", isActive);
    if (isActive) {
      el.classList.remove("view-enter");
      requestAnimationFrame(() => el.classList.add("view-enter"));
    }
  });
  document.querySelectorAll(".nav-btn").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.view === target);
  });
  if (pageTitle) pageTitle.textContent = pageTitleMap[target] || "ThinkCRM";
}

export function showApp() {
  authScreen.classList.remove("active");
  appScreen.classList.add("active");
  showAppLoading();
}

export function showAppLoading() {
  const el = qs("#app-loading");
  if (el) el.hidden = false;
}

export function hideAppLoading() {
  const el = qs("#app-loading");
  if (el) el.hidden = true;
}

// Reference-counted blocking overlay used during long async loads
// (Customer 360, Deal 360) so users can't click other UI mid-fetch.
let pageLoadingDepth = 0;
export function showPageLoading(text) {
  pageLoadingDepth++;
  const el = qs("#page-loading");
  if (!el) return;
  const label = qs("#page-loading-text");
  if (label && text) label.textContent = text;
  el.hidden = false;
}
export function hidePageLoading() {
  pageLoadingDepth = Math.max(0, pageLoadingDepth - 1);
  if (pageLoadingDepth > 0) return;
  const el = qs("#page-loading");
  if (el) el.hidden = true;
}

export function showAuth() {
  document.documentElement.classList.remove("has-token");
  appScreen.classList.remove("active");
  authScreen.classList.add("active");
  window.history.replaceState(null, "", "/");
}

// Trial banner — shown in the status-bar when subscription is TRIALING.
export function showTrialBanner(subscription) {
  if (!statusBar || !subscription) return;
  if (subscription.status !== "TRIALING" || !subscription.trialEndsAt) {
    statusBar.style.display = "none";
    statusBar.removeAttribute("aria-hidden");
    return;
  }
  const daysLeft = Math.max(0, Math.ceil((new Date(subscription.trialEndsAt) - Date.now()) / 86400000));
  const urgency  = daysLeft <= 3 ? "danger" : daysLeft <= 7 ? "warning" : "info";
  statusBar.className = `trial-bar trial-banner--${escHtml(urgency)}`;
  statusBar.innerHTML = `${icon('clock')} Trial: <strong>${daysLeft} day${daysLeft === 1 ? "" : "s"} left</strong> — upgrade to keep access after your trial ends.`;
  statusBar.style.display = "";
  statusBar.removeAttribute("aria-hidden");
}

export function setStatus(text, isError = false, isWarning = false) {
  if (!text) return;
  const container = qs("#toast-container") || (() => {
    const el = document.createElement("div");
    el.id = "toast-container";
    document.body.appendChild(el);
    return el;
  })();

  const type = isError ? "error" : isWarning ? "warn" : "success";
  const toast = document.createElement("div");
  toast.className = `toast toast--${type}`;
  toast.setAttribute("role", "alert");

  const icon = type === "error"
    ? `<svg width="16" height="16" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>`
    : type === "warn"
    ? `<svg width="16" height="16" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>`
    : `<svg width="16" height="16" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>`;

  toast.innerHTML = `
    <span class="toast-icon">${icon}</span>
    <span class="toast-msg">${escHtml(text)}</span>
    <button class="toast-close" aria-label="Dismiss">
      <svg width="13" height="13" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
    </button>`;

  container.appendChild(toast);
  requestAnimationFrame(() => toast.classList.add("toast--visible"));

  const dismiss = () => {
    toast.classList.remove("toast--visible");
    toast.addEventListener("transitionend", () => toast.remove(), { once: true });
  };

  toast.querySelector(".toast-close").addEventListener("click", dismiss);
  const timer = setTimeout(dismiss, type === "error" ? 6000 : 4000);
  toast.addEventListener("mouseenter", () => clearTimeout(timer));
  toast.addEventListener("mouseleave", () => setTimeout(dismiss, 2000));
}
