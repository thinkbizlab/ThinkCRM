import {
  escHtml,
  base64urlToBuffer, bufferToBase64url,
  normalizeHex, darkenHex, lightenHex, tintHex,
  prettyLabel,
  asDate, asDateInput, asPercent,
  shiftAnchorDate,
  fmtDateTime
} from "./modules/utils.js";
import { state, THEME_OVERRIDE_KEY } from "./modules/state.js";
import { api } from "./modules/api.js";
import {
  qs,
  authScreen, appScreen, statusBar, pageTitle,
  views, pageTitleMap,
  switchView, showApp, showAppLoading, hideAppLoading, showAuth, showTrialBanner,
  setStatus
} from "./modules/dom.js";
import { openVoiceNoteModal, bindVoiceNoteModal, setVoiceNoteOnClose } from "./modules/voice-note.js";
import { passkeyLogin, openAdminPasskeyModal, initPasskeySection } from "./modules/passkey.js";
import { loadOAuthProviderButtons, wireOAuthProviderButtons, consumeOAuthCallback } from "./modules/oauth.js";
import { loadDelegations, renderDelegationsSection, wireDelegationsListeners, setDelegationsDeps, loadMyPrincipals, attachOnBehalfOfField, readOnBehalfOfValue, canActOnBehalf } from "./modules/delegations.js";
import { loadOnboardingWizard, initOnboardingWizard } from "./modules/onboarding-wizard.js";
import { loadDemoDataStatus, renderDemoDataBanner, initDemoDataModals } from "./modules/demo-data.js";
import { initQuickSearch } from "./modules/quick-search.js";
import { loadCalendar, renderCalendar, setCalendarDeps } from "./modules/calendar.js";
import { openCustomer360, renderCustomer360, setCustomer360Deps } from "./modules/customer-360.js";
import { openDeal360, renderDeal360, navigateToDeal360, syncDeal360FromLocation, setDeal360Deps } from "./modules/deal-360.js";
import { loadDashboard, renderDashboard, setDashboardDeps } from "./modules/dashboard.js";
import {
  loadVisits, renderVisits,
  openVisitCreateModal, closeVisitCreateModal,
  openVisitEditModal, closeVisitEditModal,
  syncVisitPlannedAtRequired,
  showEventDetail,
  setVisitsDeps
} from "./modules/visits.js";
import { openMapPicker, closeMapPicker, initMapPicker, setMapPickerDeps } from "./modules/map-picker.js";
import { renderCronPicker, initCronPicker } from "./modules/cron-picker.js";
import { icon } from "./modules/icons.js";
import { DEFAULT_TOKENS, SHADOW_PRESETS, PRESETS, findPresetBySlug, detectPresetSlug } from "./modules/theme-presets.js";
import {
  getCustomFieldDefinitions,
  collectCustomFieldPayload,
  renderCustomFieldInputs,
  renderCustomFieldsSummary,
  renderCustomFieldFilters,
  collectCustomFieldFilters,
  matchesCustomFieldFilters
} from "./modules/custom-fields.js";

const loginForm = qs("#login-form");
const authMessage = qs("#auth-message");

// Apply branding (app name + colors) to the login page before authentication.
function applyLoginBranding(b) {
  const appName = b.appName || "ThinkCRM";
  document.title = appName;
  const nameEl = qs("#login-app-name");
  if (nameEl) {
    nameEl.textContent = appName;
    nameEl.classList.remove("branding-pending");
  }

  const primary   = b.primaryColor   || "#2563eb";
  const secondary = b.secondaryColor || "#0f172a";
  const loginShell = qs(".login-shell");
  if (loginShell) {
    loginShell.style.setProperty("--login-accent", primary);
    loginShell.style.setProperty("--accent", primary);
  }
  // Also prime the global CSS vars so the form button/inputs pick up the color.
  document.documentElement.style.setProperty("--accent", primary);
  document.documentElement.style.setProperty("--accent-dim", primary);
  document.documentElement.style.setProperty("--secondary", secondary);

  if (b.faviconUrl) applyFavicon(b.faviconUrl);

  applyLoginCustomization(b);
}

// Apply login-screen-specific customizations (tagline, welcome, footer, hero image, button visibility).
function applyLoginCustomization(b) {
  const headlineEl = qs("#login-tagline-headline");
  if (headlineEl) headlineEl.textContent = b.loginTaglineHeadline || "Sales intelligence.";
  const subtextEl = qs("#login-tagline-subtext");
  if (subtextEl) subtextEl.textContent = b.loginTaglineSubtext || "Field-first.";

  const welcomeEl = qs("#login-welcome");
  if (welcomeEl) {
    const msg = (b.loginWelcomeMessage || "").trim();
    welcomeEl.textContent = msg;
    welcomeEl.hidden = msg.length === 0;
  }

  const brandEl = qs(".login-brand");
  if (brandEl) {
    if (b.loginHeroImageUrl) {
      document.documentElement.style.setProperty("--login-hero-image", `url(${JSON.stringify(b.loginHeroImageUrl)})`);
      brandEl.classList.add("has-hero-image");
    } else {
      document.documentElement.style.removeProperty("--login-hero-image");
      brandEl.classList.remove("has-hero-image");
    }
  }

  const footerEl = qs("#login-footer");
  if (footerEl) {
    const text = (b.loginFooterText || "").trim();
    const links = [];
    const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
    if (b.loginTermsUrl)     links.push(`<a href="${esc(b.loginTermsUrl)}" target="_blank" rel="noopener">Terms</a>`);
    if (b.loginPrivacyUrl)   links.push(`<a href="${esc(b.loginPrivacyUrl)}" target="_blank" rel="noopener">Privacy</a>`);
    if (b.loginSupportEmail) links.push(`<a href="mailto:${esc(b.loginSupportEmail)}">Support</a>`);
    if (text || links.length) {
      footerEl.innerHTML =
        (text ? `<p class="login-footer-text">${esc(text)}</p>` : "") +
        (links.length ? `<div class="login-footer-links">${links.join(" · ")}</div>` : "");
      footerEl.hidden = false;
    } else {
      footerEl.innerHTML = "";
      footerEl.hidden = true;
    }
  }

  const flags = {
    signup:    b.loginShowSignup    !== false,
    google:    b.loginShowGoogle    !== false,
    microsoft: b.loginShowMicrosoft !== false,
    passkey:   b.loginShowPasskey   !== false
  };
  Object.entries(flags).forEach(([key, visible]) => {
    document.querySelectorAll(`[data-login-button="${key}"]`).forEach((el) => {
      el.dataset.loginHiddenByAdmin = visible ? "" : "true";
      if (!visible) el.setAttribute("hidden", "");
    });
  });
}

async function fetchLoginBranding(slug) {
  if (!slug) return;
  try {
    const res = await fetch(`/api/v1/auth/branding/public?slug=${encodeURIComponent(slug)}`);
    if (!res.ok) return;
    applyLoginBranding(await res.json());
  } catch { /* ignore — branding is cosmetic */ }
}

// Reveal the login wordmark with whatever text it currently has (used when no
// tenant-specific branding will arrive, so we don't leave it hidden forever).
function revealLoginBrandingDefault() {
  qs("#login-app-name")?.classList.remove("branding-pending");
}

// Auto-resolve workspace from custom domain on login page
(async () => {
  const getSlug = () => loginForm.querySelector('[name="tenantSlug"]')?.value?.trim();
  const hostname = window.location.hostname;
  if (hostname === "localhost" || hostname === "127.0.0.1") {
    const slugInput = loginForm.querySelector('[name="tenantSlug"]');
    if (slugInput?.value) await fetchLoginBranding(slugInput.value);
    revealLoginBrandingDefault();
    loadOAuthProviderButtons({ getTenantSlug: getSlug });
    return;
  }
  try {
    const response = await fetch(`/api/v1/auth/resolve-domain?host=${encodeURIComponent(hostname)}`);
    if (response.ok) {
      const data = await response.json();
      if (data.tenantSlug) {
        const slugInput = loginForm.querySelector('[name="tenantSlug"]');
        slugInput.value = data.tenantSlug;
        slugInput.readOnly = true;
        const workspaceRow = qs("#login-workspace-row");
        if (workspaceRow) workspaceRow.hidden = true;
        await fetchLoginBranding(data.tenantSlug);
      }
    }
  } catch {
    // Shared domain — fall through to the default (no prefill).
  }
  // Make sure the wordmark is visible even if branding didn't load.
  revealLoginBrandingDefault();
  // Always load OAuth buttons after resolve-domain settles — whether or not
  // we matched a tenant. Passing getSlug so the API can resolve tenant-level
  // creds once a slug is known, and fall back to platform env otherwise.
  loadOAuthProviderButtons({ getTenantSlug: getSlug });
})();

// Re-apply login branding whenever the workspace slug changes (debounced).
(function () {
  const slugInput = loginForm.querySelector('[name="tenantSlug"]');
  if (!slugInput) return;
  let debounceTimer;
  slugInput.addEventListener("input", () => {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      const slug = slugInput.value.trim();
      fetchLoginBranding(slug);
      loadOAuthProviderButtons({
      getTenantSlug: () => loginForm.querySelector('[name="tenantSlug"]')?.value?.trim()
    });
    }, 500);
  });
})();

wireOAuthProviderButtons({
  getTenantSlug: () => loginForm.querySelector('[name="tenantSlug"]')?.value?.trim(),
  onMissingSlug: (msg) => { authMessage.textContent = msg; }
});

// Login screen "Sign in with passkey" — runs the WebAuthn dance via the passkey
// module, then funnels the result into the same post-login flow as password login.
async function loginWithPasskey() {
  const slug = loginForm.querySelector('[name="tenantSlug"]')?.value?.trim();
  const email = loginForm.querySelector('[name="email"]')?.value?.trim();
  if (!slug) { authMessage.textContent = "Please enter your workspace first."; return; }
  if (!email) { authMessage.textContent = "Please enter your email first."; return; }

  authMessage.textContent = "";
  const passkeyBtn = qs("#oauth-passkey-btn");
  if (passkeyBtn) { passkeyBtn.disabled = true; passkeyBtn.textContent = "Verifying..."; }

  try {
    const result = await passkeyLogin({ tenantSlug: slug, email });

    if (result.needsEmailVerification) {
      const loginPanel = qs(".login-form");
      if (loginPanel) loginPanel.hidden = true;
      const pendingPanel = qs("#verify-pending-panel");
      const pendingEmail = qs("#verify-pending-email");
      if (pendingPanel) { pendingPanel.hidden = false; pendingPanel._tenantSlug = slug; pendingPanel._email = email; }
      if (pendingEmail) pendingEmail.textContent = email;
      return;
    }

    state.token = result.accessToken;
    state.user = result.user;
    state.calendarFilters.ownerIds = [result.user.id];
    localStorage.setItem("thinkcrm_token", state.token);
    showApp();
    showTrialBanner(result.user.subscription);
    if (window._checkSuperAdmin) window._checkSuperAdmin();
    updateUserMeta();
    const onMasterRoute = syncMasterPageFromLocation();
    const onSimpleViewRoute = !onMasterRoute && syncSimpleViewFromLocation();
    await loadAllViews();
    applyBrandingTheme(state.cache.branding);
    if (onMasterRoute) {
      switchView("master");
    } else if (onSimpleViewRoute) {
      switchView(onSimpleViewRoute);
      if (onSimpleViewRoute === "repHub") paintRepHubFull();
      if (onSimpleViewRoute === "superAdmin" && window._loadSuperAdmin) window._loadSuperAdmin();
    } else {
      window.history.replaceState({ view: "repHub" }, "", "/task");
      switchView("repHub");
      paintRepHubFull();
    }
    hideAppLoading();
    await loadDemoDataStatus();
    renderDemoDataBanner();
    loadOnboardingWizard();
  } catch (err) {
    if (err.name === "NotAllowedError") {
      authMessage.textContent = "Passkey sign-in was cancelled.";
    } else {
      authMessage.textContent = err.message || "Passkey sign-in failed.";
    }
  } finally {
    if (passkeyBtn) { passkeyBtn.disabled = false; passkeyBtn.innerHTML = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 18v3c0 .6.4 1 1 1h4v-3h3v-3h2l1.4-1.4a6.5 6.5 0 1 0-4-4Z"/><circle cx="16.5" cy="7.5" r=".5" fill="currentColor"/></svg> Passkey'; }
  }
}

qs("#oauth-passkey-btn")?.addEventListener("click", loginWithPasskey);

// On page load, complete any in-flight OAuth login (?oauth_code=…). The token
// arrives via a one-time exchange code, never the URL hash (C5 fix).
(async () => {
  const result = await consumeOAuthCallback({
    onError: (msg) => { authMessage.textContent = msg; }
  });
  if (!result) return;
  const { token, user } = result;
  state.token = token;
  state.user  = user;
  state.calendarFilters.ownerIds = [user.id];
  localStorage.setItem("thinkcrm_token", token);
  showApp();
  showTrialBanner(user.subscription);
  updateUserMeta();
  await loadAllViews();
  applyBrandingTheme(state.cache.branding);
  window.history.replaceState({ view: "repHub" }, "", "/task");
  switchView("repHub");
  paintRepHubFull();
  hideAppLoading();
  await loadDemoDataStatus();
  renderDemoDataBanner();
})();
// Handle platform Connect redirect-backs (?xxx_connected=1 or ?xxx_error=…)
// Stash params before app loads; act on them once the shell is ready.
const _lineConnectParams = (() => {
  const params = new URLSearchParams(window.location.search);
  const connected = params.get("line_connected");
  const lineError  = params.get("line_error");
  if (!connected && !lineError) return null;
  window.history.replaceState({}, "", window.location.pathname);
  return { connected: !!connected, lineError: lineError || null };
})();
const _msTeamsConnectParams = (() => {
  const params = new URLSearchParams(window.location.search);
  const connected = params.get("ms_teams_connected");
  const error = params.get("ms_teams_error");
  if (!connected && !error) return null;
  window.history.replaceState({}, "", window.location.pathname);
  return { connected: !!connected, error: error || null };
})();
const _slackConnectParams = (() => {
  const params = new URLSearchParams(window.location.search);
  const connected = params.get("slack_connected");
  const error = params.get("slack_error");
  if (!connected && !error) return null;
  window.history.replaceState({}, "", window.location.pathname);
  return { connected: !!connected, error: error || null };
})();

const userMeta = qs("#user-meta");
const brandMark = qs("#brand-mark");
const brandTitle = qs("#brand-title");
const themeToggleBtn = qs("#theme-toggle-btn");

// Delegated listener for integration setup guide buttons (survives renderSettings() re-renders)
views.settings?.addEventListener("click", (e) => {
  const btn = e.target.closest(".intg-info-btn");
  if (!btn) return;
  e.stopPropagation();
  openIntegrationGuide(btn.dataset.label, btn.dataset.guide);
});

const CURRENCIES = [
  { code: "THB", label: "THB — Thai Baht (฿)" },
  { code: "USD", label: "USD — US Dollar ($)" },
  { code: "EUR", label: "EUR — Euro (€)" },
  { code: "GBP", label: "GBP — British Pound (£)" },
  { code: "JPY", label: "JPY — Japanese Yen (¥)" },
  { code: "SGD", label: "SGD — Singapore Dollar (S$)" },
  { code: "MYR", label: "MYR — Malaysian Ringgit (RM)" },
  { code: "IDR", label: "IDR — Indonesian Rupiah (Rp)" },
  { code: "VND", label: "VND — Vietnamese Dong (₫)" },
  { code: "CNY", label: "CNY — Chinese Yuan (¥)" },
  { code: "AUD", label: "AUD — Australian Dollar (A$)" },
  { code: "HKD", label: "HKD — Hong Kong Dollar (HK$)" },
];

const CURRENCY_STORAGE_KEY = "thinkcrm_currency";

function getActiveCurrency() {
  return state.cache.branding?.currency
    || localStorage.getItem(CURRENCY_STORAGE_KEY)
    || "THB";
}

const masterPageRouteMap = {
  "payment-terms": "/master/payment-terms",
  customers: "/master/customers",
  items: "/master/items"
};

function asMoney(value) {
  if (value == null || Number.isNaN(Number(value))) return "-";
  const num = Number(value);
  const code = getActiveCurrency();
  const compact = Math.abs(num) > 99999;
  try {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: code,
      currencyDisplay: "narrowSymbol",
      ...(compact
        ? { notation: "compact", maximumSignificantDigits: 3 }
        : { minimumFractionDigits: 0, maximumFractionDigits: 2 })
    }).format(num);
  } catch {
    // Fallback: extract symbol via a zero-value format, strip the digit
    try {
      const sym = new Intl.NumberFormat("en-US", { style: "currency", currency: code, currencyDisplay: "symbol", minimumFractionDigits: 0, maximumFractionDigits: 0 })
        .format(0).replace(/[\d,.\s]/g, "");
      if (compact) {
        const abs = Math.abs(num);
        const fmt = abs >= 1e6 ? `${+(num / 1e6).toFixed(1)}M` : `${+(num / 1e3).toFixed(1)}K`;
        return `${sym}${fmt}`;
      }
      return `${sym}${num.toLocaleString("en-US", { maximumFractionDigits: 2 })}`;
    } catch {
      return `${code} ${num.toLocaleString("en-US", { maximumFractionDigits: 2 })}`;
    }
  }
}


function updateThemeToggleLabel() {
  if (!themeToggleBtn) return;
  const text =
    state.themeOverride === "AUTO"
      ? "Theme: Auto"
      : state.themeOverride === "DARK"
        ? "Theme: Dark"
        : "Theme: Light";
  themeToggleBtn.textContent = text;
}

function resolveThemeMode(tenantThemeMode = "LIGHT") {
  if (state.themeOverride === "LIGHT" || state.themeOverride === "DARK") {
    return state.themeOverride;
  }
  return tenantThemeMode === "DARK" ? "DARK" : "LIGHT";
}

function applyThemeMode(tenantThemeMode = "LIGHT") {
  const mode = resolveThemeMode(tenantThemeMode);
  state.tenantThemeMode = tenantThemeMode;
  document.documentElement.dataset.theme = mode === "DARK" ? "dark" : "light";
  updateThemeToggleLabel();
  updateUserMeta();
}

function applyBrandingTheme(branding) {
  const b = branding || {};
  // Persist currency locally so asMoney() works immediately on next load
  if (b.currency) {
    localStorage.setItem(CURRENCY_STORAGE_KEY, b.currency);
  }
  const primary = normalizeHex(b.primaryColor, "#2563eb");
  const secondary = normalizeHex(b.secondaryColor, "#0f172a");
  const strong = darkenHex(primary, 28);

  document.documentElement.style.setProperty("--primary", primary);
  document.documentElement.style.setProperty("--primary-strong", strong);
  document.documentElement.style.setProperty("--secondary", secondary);

  // Drive the --accent family that the CSS actually uses everywhere
  document.documentElement.style.setProperty("--accent", primary);
  document.documentElement.style.setProperty("--accent-dim", darkenHex(primary, 18));
  document.documentElement.style.setProperty("--accent-bright", lightenHex(primary, 15));
  document.documentElement.style.setProperty("--accent-subtle", tintHex(primary, 0.88));
  document.documentElement.style.setProperty("--accent-text", "#fefefe");

  // Full custom theme tokens — only apply keys the tenant explicitly set so
  // the existing light/dark :root fallbacks in styles.css stay intact for
  // everything they didn't customise.
  const tokens = b.themeTokens || {};
  const root = document.documentElement.style;
  const setIf = (cssVar, val) => { if (val) root.setProperty(cssVar, val); };
  setIf("--bg",            tokens.background);
  setIf("--surface",       tokens.card);
  setIf("--surface-soft",  tokens.muted);
  setIf("--text",          tokens.text);
  setIf("--text-2",        tokens.text);
  setIf("--muted-color",   tokens.muted);
  setIf("--border",        tokens.border);
  setIf("--border-strong", tokens.border);
  setIf("--danger",        tokens.destructive);
  if (tokens.accent) root.setProperty("--accent-bright", tokens.accent);
  if (tokens.radius !== undefined && tokens.radius !== null) {
    const r = Math.max(0, Math.min(32, Number(tokens.radius) || 12));
    root.setProperty("--r",     `${Math.max(2, Math.round(r * 0.67))}px`);
    root.setProperty("--r-md",  `${r}px`);
    root.setProperty("--r-lg",  `${Math.round(r * 1.5)}px`);
    root.setProperty("--r-xl",  `${Math.round(r * 2)}px`);
    root.setProperty("--radius", `${r}px`);
  }
  if (tokens.shadow) {
    const shadowKey = String(tokens.shadow).toUpperCase();
    const shadowValue = SHADOW_PRESETS[shadowKey] || SHADOW_PRESETS.MD;
    root.setProperty("--shadow",    shadowValue);
    root.setProperty("--shadow-sm", SHADOW_PRESETS.SM);
    root.setProperty("--shadow-lg", SHADOW_PRESETS[shadowKey === "NONE" ? "MD" : (shadowKey === "XL" ? "XL" : "LG")]);
  }

  const gradientEnabled = b.accentGradientEnabled === true || b.accentGradientEnabled === "true";
  if (gradientEnabled) {
    const gradColor = normalizeHex(b.accentGradientColor, "#ec4899");
    const gradAngle = Number.isFinite(Number(b.accentGradientAngle)) ? Number(b.accentGradientAngle) : 135;
    const gradient = `linear-gradient(${gradAngle}deg, ${primary}, ${gradColor})`;
    document.documentElement.style.setProperty("--accent-gradient", gradient);
    document.documentElement.style.setProperty("--accent-gradient-color", gradColor);
    document.documentElement.classList.add("accent-gradient-on");
  } else {
    document.documentElement.style.setProperty("--accent-gradient", primary);
    document.documentElement.style.removeProperty("--accent-gradient-color");
    document.documentElement.classList.remove("accent-gradient-on");
  }

  const themeMeta = document.querySelector('meta[name="theme-color"]');
  if (themeMeta) {
    themeMeta.setAttribute("content", primary);
  }

  // Only override title/favicon when branding actually provides values, so the
  // server-rendered shell (already populated per host) isn't reset to "ThinkCRM"
  // whenever this runs before branding has loaded.
  if (b.appName) {
    document.title = b.appName;
    if (brandTitle) brandTitle.textContent = b.appName;
  }
  brandTitle?.classList.remove("branding-pending");
  if (brandMark) {
    const logoSrc = b.logoUrl || "/default-brand.svg";
    brandMark.innerHTML = `<img src="${escHtml(logoSrc)}" alt="logo" />`;
  }

  applyThemeMode(b.themeMode || "LIGHT");
  if (b.faviconUrl) applyFavicon(b.faviconUrl);
}

function applyFavicon(url) {
  let link = document.querySelector("link[rel~='icon']");
  if (!link) {
    link = document.createElement("link");
    link.rel = "icon";
    document.head.appendChild(link);
  }
  const src = url || "/default-brand.svg";
  link.href = src;
  const lower = src.split("?")[0].toLowerCase();
  if (lower.endsWith(".svg")) link.type = "image/svg+xml";
  else if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) link.type = "image/jpeg";
  else if (lower.endsWith(".ico")) link.type = "image/x-icon";
  else if (lower.endsWith(".webp")) link.type = "image/webp";
  else link.type = "image/png";
}

function renderThemeDebugChip() {
  return `<span class="chip theme-debug-chip">Tenant: ${state.tenantThemeMode} | User: ${state.themeOverride}</span>`;
}

function renderThemeRow(label, name, value, { required } = {}) {
  const hex = value || "#ffffff";
  const req = required ? " required" : "";
  return `
    <div class="theme-group-row">
      <span class="theme-group-row-label">${escHtml(label)}</span>
      <div class="color-input-row theme-group-row-control">
        <input type="color" name="${name}Picker" value="${escHtml(hex)}" class="color-swatch" />
        <input class="form-input theme-hex-input" name="${name}" value="${escHtml(hex)}" placeholder="${escHtml(hex)}"${req} />
      </div>
    </div>`;
}

function updateUserMeta() {
  if (!state.user) return;
  const initials = (state.user.fullName || "?")
    .split(" ")
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0].toUpperCase())
    .join("") || "?";
  if (userMeta) userMeta.textContent = state.user.fullName;
  function renderAvatar(el, size) {
    if (!el) return;
    if (state.user.avatarUrl) {
      el.innerHTML = `<img src="${escHtml(state.user.avatarUrl)}" alt="${escHtml(state.user.fullName || "")}" style="width:${size}px;height:${size}px;border-radius:50%;object-fit:cover;display:block">`;
    } else {
      el.textContent = initials;
    }
  }
  renderAvatar(qs("#user-avatar"), 32);
  renderAvatar(qs("#user-avatar-dd"), 40);
  const ddName = qs("#user-dd-name");
  if (ddName) ddName.textContent = state.user.fullName || "—";
  const ddRole = qs("#user-dd-role");
  if (ddRole) ddRole.textContent = state.user.email
    ? `${state.user.role ?? ""} · ${state.user.email}`.replace(/^·\s*/, "")
    : (state.user.role ?? "—");
}

function showNotifWarnings(warnings) {
  if (!warnings?.length) return;
  const labels = { LINE: "LINE", MS_TEAMS: "MS Teams", EMAIL: "Email" };
  const failed = warnings.filter(w => labels[w]).map(w => labels[w]);
  if (!failed.length) return;
  const channels = failed.join(", ");
  setTimeout(() => setStatus(
    `${channels} notification failed. Check that the integration is enabled and configured correctly in Settings → Integrations.`,
    true
  ), 100);
}

// ── Integration Setup Guide Modal ─────────────────────────────────────────────
function openIntegrationGuide(label, guideHtml) {
  qs("#intg-guide-modal")?.remove();

  // Parse <li> items from the guide HTML and render as styled step cards
  const tmp = document.createElement("div");
  tmp.innerHTML = guideHtml;
  const liItems = [...tmp.querySelectorAll("li")];
  const stepsHtml = liItems.map((li, i) => `
    <div class="intg-guide-step">
      <div class="intg-guide-step-num">${i + 1}</div>
      <div class="intg-guide-step-text">${li.innerHTML}</div>
    </div>
  `).join("");

  const overlay = document.createElement("div");
  overlay.id = "intg-guide-modal";
  overlay.className = "ncm-overlay";
  overlay.innerHTML = `
    <div class="ncm-panel" style="max-width:500px">
      <div class="ncm-header">
        <span class="ncm-title">${icon('plug')} Setup Guide</span>
        <button type="button" class="ncm-close" id="intg-guide-close">${icon('x', 14)}</button>
      </div>
      <div class="intg-guide-body">
        <div class="intg-guide-banner">
          <div class="intg-guide-banner-icon">${icon('clipboard')}</div>
          <div class="intg-guide-banner-text">Follow these steps to configure <strong>${escHtml(label)}</strong>. After saving credentials, run <em>Test Connection</em> to verify.</div>
        </div>
        <div class="intg-guide-steps">${stepsHtml}</div>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);
  requestAnimationFrame(() => overlay.classList.add("ncm-open"));
  overlay.addEventListener("click", (e) => { if (e.target === overlay) overlay.remove(); });
  qs("#intg-guide-close").addEventListener("click", () => overlay.remove());
}

// ── Lost Reason Modal ─────────────────────────────────────────────────────────
// Returns a Promise<string> with the typed note, or rejects if the user cancels.
function requestLostReason(dealName) {
  return new Promise((resolve, reject) => {
    const modal    = qs("#lost-reason-modal");
    const textarea = qs("#lr-textarea");
    const confirmBtn = qs("#lr-confirm-btn");
    const cancelBtn  = qs("#lr-cancel-btn");
    const charCount  = qs("#lr-chars");
    const dealLabel  = qs("#lr-deal-name");
    if (!modal || !textarea || !confirmBtn || !cancelBtn) {
      reject(new Error("Lost reason modal not found"));
      return;
    }

    // Reset state
    textarea.value = "";
    if (charCount) charCount.textContent = "0";
    if (dealLabel) dealLabel.textContent = dealName || "";
    confirmBtn.disabled = true;
    modal.hidden = false;
    textarea.focus();

    function updateBtn() {
      const len = textarea.value.trim().length;
      if (charCount) charCount.textContent = textarea.value.length;
      confirmBtn.disabled = len < 10;
    }

    function cleanup() {
      modal.hidden = true;
      textarea.removeEventListener("input", updateBtn);
      confirmBtn.removeEventListener("click", onConfirm);
      cancelBtn.removeEventListener("click", onCancel);
      document.removeEventListener("keydown", onKey);
    }

    function onConfirm() {
      const note = textarea.value.trim();
      if (note.length < 10) return;
      cleanup();
      resolve(note);
    }

    function onCancel() {
      cleanup();
      reject(new Error("cancelled"));
    }

    function onKey(e) {
      if (e.key === "Escape") onCancel();
    }

    textarea.addEventListener("input", updateBtn);
    confirmBtn.addEventListener("click", onConfirm);
    cancelBtn.addEventListener("click", onCancel);
    document.addEventListener("keydown", onKey);
    qs("#lr-backdrop")?.addEventListener("click", onCancel, { once: true });
  });
}

// ── Leaderboard info modal ────────────────────────────────────────────────────
(function bindLeaderboardInfoModal() {
  const modal   = qs("#leaderboard-info-modal");
  const backdrop = qs("#lb-info-backdrop");
  const closeBtn = qs("#lb-info-close");
  if (!modal) return;

  function open()  { modal.hidden = false; }
  function close() { modal.hidden = true; }

  document.addEventListener("click", (e) => {
    if (e.target?.closest?.("#leaderboard-info-btn")) open();
  });
  backdrop?.addEventListener("click", close);
  closeBtn?.addEventListener("click", close);
  modal.addEventListener("keydown", (e) => { if (e.key === "Escape") close(); });
})();

function syncMasterPageFromLocation() {
  const path = window.location.pathname;
  if (!path.startsWith("/master/")) return false;
  const page = path.replace("/master/", "");
  if (page in masterPageRouteMap) {
    state.masterPage = page;
    switchView("master");
    return true;
  }
  return false;
}

function navigateToMasterPage(page) {
  state.masterPage = page;
  const route = masterPageRouteMap[page] || "/master/payment-terms";
  if (window.location.pathname !== route) {
    window.history.pushState({ page }, "", route);
  }
}

const settingsPageRouteMap = {
  "my-profile":     "/settings/my-profile",
  "notifications":  "/settings/notifications",
  "company":        "/settings/company",
  "branding":       "/settings/branding",
  "team-structure": "/settings/team-structure",
  "roles":          "/settings/roles",
  "kpi-targets":    "/settings/kpi-targets",
  "integrations":   "/settings/integrations",
  "cron-jobs":      "/settings/scheduled-jobs",
  "custom-domain":  "/settings/custom-domain",
  "custom-fields":  "/settings/custom-fields"
};

// notifPrefs — loaded from API, cached in memory for the session
let _notifPrefsCache = null;
async function loadNotifPrefs() {
  if (_notifPrefsCache) return _notifPrefsCache;
  try {
    _notifPrefsCache = await api("/users/me/notif-prefs");
  } catch {
    _notifPrefsCache = {};
  }
  return _notifPrefsCache;
}
async function putNotifPrefs(prefs) {
  _notifPrefsCache = await api("/users/me/notif-prefs", { method: "PUT", body: prefs });
  return _notifPrefsCache;
}

// myIntegrations — the current user's connected notification channels
async function loadMyIntegrations() {
  const userId = state.user?.id;
  if (!userId) return [];
  try {
    return await api(`/users/${userId}/integrations`);
  } catch {
    return [];
  }
}
async function refreshMyIntegrations() {
  state.cache.myIntegrations = await loadMyIntegrations();
}

function syncSettingsPageFromLocation() {
  const path = window.location.pathname;
  if (!path.startsWith("/settings/")) return false;
  // Reverse-lookup: find which page key maps to this URL path
  const entry = Object.entries(settingsPageRouteMap).find(([, route]) => route === path);
  if (entry) {
    state.settingsPage = entry[0];
    switchView("settings");
    return true;
  }
  return false;
}

function navigateToSettingsPage(page) {
  state.settingsPage = page;
  const route = settingsPageRouteMap[page] || "/settings/my-profile";
  if (window.location.pathname !== route) {
    window.history.pushState({ page }, "", route);
  }
}

const simpleViewRouteMap = {
  repHub: "/task",
  dashboard: "/dashboard",
  deals: "/deals",
  visits: "/visits",
  calendar: "/calendar",
  integrations: "/integrations",
  superAdmin: "/super-admin"
};

function navigateToView(view) {
  const route = simpleViewRouteMap[view] ?? "/";
  if (window.location.pathname !== route) {
    window.history.pushState({ view }, "", route);
  }
}

function syncSimpleViewFromLocation() {
  const path = window.location.pathname;
  for (const [view, route] of Object.entries(simpleViewRouteMap)) {
    if (path === route) return view;
  }
  return null;
}

function navigateToCustomer360(customerCode) {
  const route = `/customers/${encodeURIComponent(customerCode)}`;
  if (window.location.pathname !== route) {
    window.history.pushState({ customerCode }, "", route);
  }
}

function syncC360FromLocation() {
  const match = window.location.pathname.match(/^\/customers\/([^/]+)$/);
  return match ? decodeURIComponent(match[1]) : null;
}

function navigateToUserEdit(userId) {
  const route = `/settings/users/${userId}`;
  if (window.location.pathname !== route) {
    window.history.pushState({ userId }, "", route);
  }
}

function syncUserEditFromLocation() {
  const match = window.location.pathname.match(/^\/settings\/users\/([^/]+)$/);
  return match ? match[1] : null;
}


// ── Import History / Import Modal / Template download (module-level helpers) ──

async function openImportHistoryModal(type, title) {
  const overlay = document.createElement("div");
  overlay.className = "popup-overlay";
  overlay.innerHTML = `
    <div class="popup-box popup-box--wide" role="dialog" aria-modal="true">
      <div class="popup-header">
        <p class="popup-title">${escHtml(title)}</p>
        <button class="popup-close-btn" aria-label="Close">${icon('x', 14)}</button>
      </div>
      <div style="padding:var(--sp-3) 0;display:flex;flex-direction:column;gap:var(--sp-2)">
        <p class="muted small">Showing the 50 most recent imports for this workspace.</p>
        <div class="history-body"><div class="muted small">Loading…</div></div>
      </div>
    </div>`;
  document.body.appendChild(overlay);
  requestAnimationFrame(() => overlay.classList.add("popup-visible"));
  const close = () => {
    overlay.classList.remove("popup-visible");
    overlay.addEventListener("transitionend", () => overlay.remove(), { once: true });
  };
  overlay.querySelector(".popup-close-btn").addEventListener("click", close);
  overlay.addEventListener("click", (e) => { if (e.target === overlay) close(); });

  const body = overlay.querySelector(".history-body");
  try {
    const rows = await api(`/import-logs?type=${encodeURIComponent(type)}`);
    if (!rows.length) {
      body.innerHTML = `<div class="empty-state compact"><div><strong>No imports yet</strong><p>Import results will appear here.</p></div></div>`;
      return;
    }
    body.innerHTML = `
      <div class="list" style="max-height:60vh;overflow:auto">
        ${rows.map((r) => {
          const d = r.detail || {};
          const success = type === "users" ? d.created ?? 0 : d.imported ?? 0;
          const successLabel = type === "users" ? "created" : "imported";
          const errorCount = d.errors ?? 0;
          const total = d.total ?? (success + errorCount);
          const actorLabel = r.actor?.fullName || r.actor?.email || "—";
          const errSample = Array.isArray(d.errorSample) ? d.errorSample : [];
          const errHtml = errSample.length
            ? `<details style="margin-top:var(--sp-1)"><summary class="small muted" style="cursor:pointer">Sample errors (${errorCount})</summary>
                 <div class="small" style="margin-top:var(--sp-1);color:var(--clr-danger)">
                   ${errSample.map((e) => `Row ${e.row}${e.email ? ` (${escHtml(e.email)})` : ""}: ${escHtml(e.error || "")}`).join("<br>")}
                 </div>
               </details>`
            : "";
          return `
            <div class="row">
              <div style="display:flex;justify-content:space-between;gap:var(--sp-2);flex-wrap:wrap">
                <div>
                  <strong>${asDate(r.createdAt)}</strong>
                  <div class="muted small">by ${escHtml(actorLabel)}</div>
                </div>
                <div style="text-align:right">
                  <span class="chip ${errorCount ? "chip-warning" : "chip-success"}">${success} ${successLabel}</span>
                  ${errorCount ? `<span class="chip chip-danger">${errorCount} error${errorCount === 1 ? "" : "s"}</span>` : ""}
                  <div class="muted small">${total} total row(s)</div>
                </div>
              </div>
              ${errHtml}
            </div>`;
        }).join("")}
      </div>`;
  } catch (err) {
    body.innerHTML = `<div class="small" style="color:var(--clr-danger)">${escHtml(err.message || "Failed to load history.")}</div>`;
  }
}

const MASTER_DATA_IMPORT_SPECS = {
  "payment-terms": {
    label: "Payment Terms",
    endpoint: "/payment-terms/import",
    columns: ["code", "name", "dueDays"],
    sample: [
      { code: "NET30",  name: "Net 30 days",  dueDays: 30 },
      { code: "NET60",  name: "Net 60 days",  dueDays: 60 },
      { code: "COD",    name: "Cash on delivery", dueDays: 0 }
    ],
    sourceRows: () => (state.cache.paymentTerms || []).map((p) => ({
      code: p.code, name: p.name, dueDays: p.dueDays
    })),
    fileBase: "payment-terms"
  },
  "items": {
    label: "Items",
    endpoint: "/items/import",
    columns: ["itemCode", "name", "unitPrice", "externalRef"],
    sample: [
      { itemCode: "SKU-001", name: "Example Product A", unitPrice: 500,  externalRef: "" },
      { itemCode: "SKU-002", name: "Example Product B", unitPrice: 1250, externalRef: "LEGACY-42" }
    ],
    sourceRows: () => (state.cache.items || []).map((it) => ({
      itemCode: it.itemCode, name: it.name, unitPrice: it.unitPrice, externalRef: it.externalRef || ""
    })),
    fileBase: "items"
  },
  "customers": {
    label: "Customers",
    endpoint: "/customers/import",
    columns: ["customerCode", "name", "paymentTermCode", "customerType", "taxId", "externalRef", "siteLat", "siteLng"],
    sample: [
      { customerCode: "CUST-0001", name: "Acme Co., Ltd.", paymentTermCode: "NET30", customerType: "COMPANY", taxId: "0105555123456", externalRef: "", siteLat: 13.7563, siteLng: 100.5018 },
      { customerCode: "CUST-0002", name: "Jane Individual",  paymentTermCode: "COD",   customerType: "INDIVIDUAL", taxId: "", externalRef: "", siteLat: "", siteLng: "" }
    ],
    sourceRows: () => {
      const terms = state.cache.paymentTerms || [];
      const codeById = new Map(terms.map((t) => [t.id, t.code]));
      return (state.cache.customers || []).map((c) => ({
        customerCode: c.customerCode,
        name: c.name,
        paymentTermCode: c.paymentTerm?.code || codeById.get(c.defaultTermId) || "",
        customerType: c.customerType || "COMPANY",
        taxId: c.taxId || "",
        externalRef: c.externalRef || "",
        siteLat: c.siteLat ?? "",
        siteLng: c.siteLng ?? ""
      }));
    },
    fileBase: "customers"
  }
};

function getActiveCustomFieldColumns(entity) {
  const defs = state.cache.customFieldDefinitions?.[entity] || [];
  return defs.filter((d) => d.isActive).map((d) => d.fieldKey);
}

function downloadMasterDataTemplate(entity) {
  const spec = MASTER_DATA_IMPORT_SPECS[entity];
  if (!spec) return;
  const cfCols = getActiveCustomFieldColumns(entity);
  const allColumns = [...spec.columns, ...cfCols];
  const historyRows = spec.sourceRows();
  const rows = (historyRows.length ? historyRows : spec.sample).map((r) => {
    const out = { ...r };
    for (const k of cfCols) if (!(k in out)) out[k] = "";
    return out;
  });
  const ws = XLSX.utils.json_to_sheet(rows, { header: allColumns });
  ws["!cols"] = allColumns.map(() => ({ wch: 20 }));
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, spec.label.slice(0, 31));
  XLSX.writeFile(wb, `${spec.fileBase}-template.xlsx`);
}

function openMasterDataImportModal(entity) {
  const spec = MASTER_DATA_IMPORT_SPECS[entity];
  if (!spec) return;
  const overlay = document.createElement("div");
  overlay.className = "popup-overlay";
  overlay.innerHTML = `
    <div class="popup-box popup-box--wide" role="dialog" aria-modal="true">
      <div class="popup-header">
        <p class="popup-title">Import ${escHtml(spec.label)}</p>
        <button class="popup-close-btn" aria-label="Close">${icon('x', 14)}</button>
      </div>
      <div style="padding:var(--sp-3) 0;display:flex;flex-direction:column;gap:var(--sp-3)">
        <p class="muted small">Upload an Excel (.xlsx) file. Required columns: ${spec.columns.map(c => `<code>${c}</code>`).join(", ")}. Existing rows (matched by natural key) are overwritten.${(() => {
          const cfCols = getActiveCustomFieldColumns(entity);
          return cfCols.length ? ` Optional custom field columns: ${cfCols.map(c => `<code>${c}</code>`).join(", ")}.` : "";
        })()}</p>
        <input type="file" class="md-import-file" accept=".xlsx,.xls" style="font-size:0.85rem" />
        <p class="md-import-msg muted small" style="min-height:1.2em"></p>
        <div class="md-import-results" hidden></div>
        <div class="popup-actions">
          <button class="popup-cancel-btn">Cancel</button>
          <button class="md-import-submit-btn" disabled>Import</button>
        </div>
      </div>
    </div>`;
  document.body.appendChild(overlay);
  requestAnimationFrame(() => overlay.classList.add("popup-visible"));
  const close = () => {
    overlay.classList.remove("popup-visible");
    overlay.addEventListener("transitionend", () => overlay.remove(), { once: true });
  };
  overlay.querySelector(".popup-close-btn").addEventListener("click", close);
  overlay.querySelector(".popup-cancel-btn").addEventListener("click", close);
  overlay.addEventListener("click", (e) => { if (e.target === overlay) close(); });

  const fileInput = overlay.querySelector(".md-import-file");
  const submitBtn = overlay.querySelector(".md-import-submit-btn");
  const msg = overlay.querySelector(".md-import-msg");
  const resultsDiv = overlay.querySelector(".md-import-results");
  let parsedRows = null;

  fileInput.addEventListener("change", async () => {
    const file = fileInput.files[0];
    if (!file) { submitBtn.disabled = true; parsedRows = null; return; }
    try {
      const buf = await file.arrayBuffer();
      const wb = XLSX.read(buf, { type: "array" });
      const sheetName = wb.SheetNames[0];
      if (!sheetName) throw new Error("Excel file has no sheets.");
      const rows = XLSX.utils.sheet_to_json(wb.Sheets[sheetName], { defval: "", raw: false });
      const normalized = rows
        .map((r) => {
          const out = {};
          for (const k of Object.keys(r)) {
            const v = r[k];
            if (v === "" || v == null) continue;
            out[String(k).trim()] = typeof v === "string" ? v.trim() : v;
          }
          return out;
        })
        .filter((r) => Object.keys(r).length > 0);
      if (!normalized.length) throw new Error("No data rows found.");
      parsedRows = normalized;
      msg.textContent = `${normalized.length} row(s) found in file.`;
      msg.style.color = "";
      submitBtn.disabled = false;
    } catch (err) {
      msg.textContent = err.message || "Could not read Excel file.";
      msg.style.color = "var(--clr-danger)";
      submitBtn.disabled = true;
      parsedRows = null;
    }
  });

  submitBtn.addEventListener("click", async () => {
    if (!parsedRows) return;
    submitBtn.disabled = true;
    msg.textContent = "Importing…";
    msg.style.color = "";
    try {
      const res = await api(spec.endpoint, { method: "POST", body: { rows: parsedRows } });
      msg.textContent = `Done — ${res.imported} imported, ${res.errors} error(s).`;
      msg.style.color = res.errors ? "var(--clr-warning)" : "var(--clr-success)";
      if (res.errorDetails?.length) {
        resultsDiv.hidden = false;
        resultsDiv.innerHTML = `<div class="small" style="max-height:200px;overflow:auto;background:var(--clr-surface);padding:var(--sp-2);border-radius:6px">`
          + res.errorDetails.map((e) => {
              const hint = e.customerCode || e.itemCode || e.code;
              return `<div style="color:var(--clr-danger)">Row ${e.row}${hint ? ` (${escHtml(hint)})` : ""}: ${escHtml(e.error)}</div>`;
            }).join("")
          + `</div>`;
      }
      if (res.imported > 0) setTimeout(() => { loadMaster(); }, 800);
    } catch (err) {
      msg.textContent = err.message || "Import failed.";
      msg.style.color = "var(--clr-danger)";
      submitBtn.disabled = false;
    }
  });
}

function renderMasterData(paymentTerms) {
  const termOptions = paymentTerms
    .map((term) => `<option value="${term.id}">${escHtml(term.code)} - ${escHtml(term.name)}</option>`)
    .join("");
  const paymentTermFieldDefinitions = getCustomFieldDefinitions("payment-terms");
  const itemFieldDefinitions = getCustomFieldDefinitions("items");
  const isAdmin = state.user?.role === "ADMIN";
  const canManageMaster = isAdmin || state.user?.role === "DIRECTOR" || state.user?.role === "MANAGER";
  const exportBtn = (id) => isAdmin ? `
    <div style="margin-left:auto;display:inline-flex">
      <button class="ghost export-btn" data-export="${id}" data-format="xlsx" style="font-size:0.8rem;border-right:none;border-radius:var(--r) 0 0 var(--r);padding-right:var(--sp-2)">↓ Excel</button>
      <button class="ghost export-chevron" data-export="${id}" style="font-size:0.8rem;border-radius:0 var(--r) var(--r) 0;padding:0 var(--sp-2)" aria-label="More export formats">▾</button>
    </div>` : "";
  const importBtns = (id) => canManageMaster ? `
    <div style="display:inline-flex;gap:var(--sp-1);margin-left:var(--sp-2)">
      <button class="ghost small md-template-btn" data-entity="${id}" style="font-size:0.8rem">⬇ Template</button>
      <button class="ghost small md-import-btn"   data-entity="${id}" style="font-size:0.8rem">Import</button>
      <button class="ghost small md-history-btn"  data-entity="${id}" style="font-size:0.8rem">History</button>
    </div>` : "";

  views.master.innerHTML = `
    <div class="master-outer">
    <div class="master-tabs">
      <button class="master-page-btn ${state.masterPage === "customers" ? "active-master-btn" : ""}" data-page="customers">${icon('building')} Customers</button>
      <button class="master-page-btn ${state.masterPage === "items" ? "active-master-btn" : ""}" data-page="items">${icon('box')} Items</button>
      <button class="master-page-btn ${state.masterPage === "payment-terms" ? "active-master-btn" : ""}" data-page="payment-terms">${icon('card')} Payment Terms</button>
    </div>

    <section class="card" ${state.masterPage !== "payment-terms" ? 'style="display:none"' : ""}>
      <div style="display:flex;align-items:center;margin-bottom:var(--sp-4)">
        <h3 class="section-title" style="margin:0">Payment Terms</h3>
        ${importBtns("payment-terms")}
        ${exportBtn("payment-terms")}
      </div>
      <form id="payment-term-form" class="mini-form">
        <input name="code" placeholder="Code (e.g. NET45)" required />
        <input name="name" placeholder="Name" required />
        <input name="dueDays" type="number" min="0" placeholder="Due days" required />
        ${isAdmin ? renderCustomFieldInputs(paymentTermFieldDefinitions) : ""}
        <button type="submit">Create Payment Term</button>
      </form>
      ${isAdmin ? `
      <p class="muted small" style="margin-top:var(--sp-3)">
        ${paymentTermFieldDefinitions.filter((d) => d.isActive).length} active custom field(s) · <a href="/settings/custom-fields" data-settings-link="custom-fields">Manage custom fields</a>
      </p>
      ` : ""}
      <div class="list">
        ${paymentTerms
          .map(
            (p) => `
          <div class="row">
            <h4>${escHtml(p.name)} (${escHtml(p.code)})</h4>
            <div class="muted">Due ${p.dueDays} days</div>
            <div class="chip ${p.isActive ? "chip-success" : "chip-danger"}">${p.isActive ? "Active" : "Inactive"}</div>
            ${isAdmin ? renderCustomFieldsSummary(p.customFields) : ""}
            <div class="inline-actions wrap">
              <button class="payment-term-toggle" data-id="${p.id}" data-active="${p.isActive}">
                ${p.isActive ? "Deactivate" : "Activate"}
              </button>
              <button class="payment-term-delete ghost" data-id="${p.id}">Delete</button>
            </div>
          </div>`
          )
          .join("")}
      </div>
    </section>
    <section class="card" ${state.masterPage !== "customers" ? 'style="display:none"' : ""} id="customers-section">
      <div style="display:flex;align-items:center;margin-bottom:var(--sp-4)">
        <h3 class="section-title" style="margin:0">Customers</h3>
        ${importBtns("customers")}
        ${exportBtn("customers")}
      </div>
      <div id="cust-list-mount"></div>
    </section>
    <section class="card" ${state.masterPage !== "items" ? 'style="display:none"' : ""}>
      <div style="display:flex;align-items:center;margin-bottom:var(--sp-4)">
        <h3 class="section-title" style="margin:0">Items</h3>
        ${importBtns("items")}
        ${exportBtn("items")}
      </div>
      <form id="item-form" class="mini-form">
        <input name="itemCode" placeholder="Item code" required />
        <input name="name" placeholder="Item name" required />
        <input name="unitPrice" type="number" min="0" step="0.01" placeholder="Unit price" required />
        <input name="externalRef" placeholder="External ref (legacy system ID)" maxlength="100" />
        ${renderCustomFieldInputs(itemFieldDefinitions)}
        <button type="submit">Create Item</button>
      </form>
      ${isAdmin ? `
      <p class="muted small" style="margin-top:var(--sp-3)">
        ${itemFieldDefinitions.filter((d) => d.isActive).length} active custom field(s) · <a href="/settings/custom-fields" data-settings-link="custom-fields">Manage custom fields</a>
      </p>
      ` : ""}
      ${itemFieldDefinitions.filter((d) => d.isActive).length > 0 ? `
        <div style="margin:var(--sp-3) 0">
          <button type="button" class="ghost small" id="item-filter-toggle">${state.masterFiltersOpen ? "Hide" : "Show"} filters${Object.values(state.itemCustomFieldFilters || {}).filter((v) => v !== "" && v != null).length ? ` (${Object.values(state.itemCustomFieldFilters || {}).filter((v) => v !== "" && v != null).length})` : ""}</button>
          ${state.masterFiltersOpen ? `
            <form id="item-cf-filter-form" class="cf-filter-panel" style="padding:var(--sp-3);background:var(--surface-soft);border:1px solid var(--border);border-radius:var(--r-md);margin-top:var(--sp-2)">
              ${renderCustomFieldFilters(itemFieldDefinitions, state.itemCustomFieldFilters)}
              <div class="inline-actions wrap" style="margin-top:var(--sp-2)">
                <button type="submit">Apply filters</button>
                <button type="button" class="ghost" id="item-cf-filter-clear">Clear</button>
              </div>
            </form>
          ` : ""}
        </div>
      ` : ""}
      <div class="list" id="item-list"></div>
    </section>
    </div>
  `;

  const custMount = views.master.querySelector("#cust-list-mount");
  if (custMount) renderCustomerListSection(custMount, termOptions);

  const itemList = qs("#item-list");
  const itemDefsActive = itemFieldDefinitions.filter((d) => d.isActive);
  const filteredItems = state.cache.items.filter((it) => matchesCustomFieldFilters(it, itemDefsActive, state.itemCustomFieldFilters));
  itemList.innerHTML = filteredItems
    .map(
      (item) => `
    <div class="row">
      <h4>${escHtml(item.name)} (${escHtml(item.itemCode)})</h4>
      <div class="muted">Unit price ${asMoney(item.unitPrice)}${item.externalRef ? ` · Ref: ${escHtml(item.externalRef)}` : ""}</div>
      ${renderCustomFieldsSummary(item.customFields)}
      <div class="inline-actions wrap">
        <button class="item-price" data-id="${item.id}" data-price="${item.unitPrice}">Update Price</button>
        <button class="item-delete ghost" data-id="${item.id}">Delete</button>
      </div>
    </div>`
    )
    .join("");

  views.master.querySelectorAll(".master-page-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      navigateToMasterPage(btn.dataset.page);
      renderMasterData(state.cache.paymentTerms);
    });
  });

  qs("#item-filter-toggle")?.addEventListener("click", () => {
    state.masterFiltersOpen = !state.masterFiltersOpen;
    renderMasterData(state.cache.paymentTerms);
  });
  qs("#item-cf-filter-form")?.addEventListener("submit", (e) => {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    state.itemCustomFieldFilters = collectCustomFieldFilters(fd, getCustomFieldDefinitions("items"));
    renderMasterData(state.cache.paymentTerms);
  });
  qs("#item-cf-filter-clear")?.addEventListener("click", () => {
    state.itemCustomFieldFilters = {};
    renderMasterData(state.cache.paymentTerms);
  });

  const doExport = (type, fmt) => {
    if (type === "payment-terms") {
      const rows = (state.cache.paymentTerms || []).map((p) => ({
        code: p.code, name: p.name, dueDays: p.dueDays, isActive: p.isActive,
        createdAt: p.createdAt ? new Date(p.createdAt).toISOString().slice(0, 10) : ""
      }));
      exportRows("payment-terms", rows, fmt);
    } else if (type === "items") {
      const rows = (state.cache.items || []).map((i) => ({
        itemCode: i.itemCode, name: i.name, unitPrice: i.unitPrice,
        externalRef: i.externalRef || "",
        createdAt: i.createdAt ? new Date(i.createdAt).toISOString().slice(0, 10) : ""
      }));
      exportRows("items", rows, fmt);
    } else if (type === "customers") {
      const rows = (state.cache.customers || []).map((c) => ({
        customerCode: c.customerCode, name: c.name, customerType: c.customerType || "",
        taxId: c.taxId || "", externalRef: c.externalRef || "",
        paymentTermCode: c.paymentTerm?.code || "", paymentTermName: c.paymentTerm?.name || "",
        createdAt: c.createdAt ? new Date(c.createdAt).toISOString().slice(0, 10) : ""
      }));
      exportRows("customers", rows, fmt);
    }
  };

  views.master.querySelectorAll(".export-btn").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const dd = btn.closest(".export-split")?.querySelector(".export-dropdown");
      if (dd && !dd.hidden) dd.hidden = true;
      doExport(btn.dataset.export, btn.dataset.format || "xlsx");
    });
  });

  views.master.querySelectorAll(".export-chevron").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      document.querySelectorAll(".export-portal").forEach((el) => el.remove());
      const rect = btn.getBoundingClientRect();
      const portal = document.createElement("div");
      portal.className = "export-portal";
      portal.style.cssText = `position:fixed;top:${rect.bottom + 4}px;right:${window.innerWidth - rect.right}px;background:var(--surface);border:1px solid var(--border);border-radius:var(--r);box-shadow:var(--shadow);z-index:9000;min-width:120px`;
      portal.innerHTML = `<button style="display:block;width:100%;text-align:left;padding:8px 14px;font-size:0.83rem;background:none;border:none;cursor:pointer;color:var(--text);white-space:nowrap">↓ Export as CSV</button>`;
      document.body.appendChild(portal);
      portal.querySelector("button").addEventListener("click", (e2) => {
        e2.stopPropagation();
        portal.remove();
        doExport(btn.dataset.export, "csv");
      });
      document.addEventListener("click", () => portal.remove(), { once: true });
    });
  });

  qs("#payment-term-form").addEventListener("submit", async (event) => {
    if (state.masterPage !== "payment-terms") return;
    event.preventDefault();
    const formData = new FormData(event.currentTarget);
    const payload = {
      code: String(formData.get("code") || ""),
      name: String(formData.get("name") || ""),
      dueDays: Number(formData.get("dueDays") || 0)
    };
    const customFields = collectCustomFieldPayload(formData, paymentTermFieldDefinitions);
    if (Object.keys(customFields).length) payload.customFields = customFields;
    try {
      await api("/payment-terms", {
        method: "POST",
        body: payload
      });
      setStatus("Payment term created.");
      await loadMaster();
    } catch (error) {
      setStatus(error.message, true);
    }
  });

  views.master.querySelectorAll(".md-template-btn").forEach((btn) => {
    btn.addEventListener("click", () => downloadMasterDataTemplate(btn.dataset.entity));
  });
  views.master.querySelectorAll(".md-import-btn").forEach((btn) => {
    btn.addEventListener("click", () => openMasterDataImportModal(btn.dataset.entity));
  });
  views.master.querySelectorAll(".md-history-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      const entity = btn.dataset.entity;
      const title = entity === "customers" ? "Customer Import History"
        : entity === "items" ? "Item Import History"
        : "Payment Term Import History";
      openImportHistoryModal(entity, title);
    });
  });

  views.master.querySelectorAll(".payment-term-toggle").forEach((btn) => {
    btn.addEventListener("click", async () => {
      try {
        await api(`/payment-terms/${btn.dataset.id}`, {
          method: "PATCH",
          body: { isActive: btn.dataset.active !== "true" }
        });
        setStatus("Payment term updated.");
        await loadMaster();
      } catch (error) {
        setStatus(error.message, true);
      }
    });
  });

  views.master.querySelectorAll(".payment-term-delete").forEach((btn) => {
    btn.addEventListener("click", async () => {
      if (!confirm("Delete this payment term?")) return;
      try {
        await api(`/payment-terms/${btn.dataset.id}`, { method: "DELETE" });
        setStatus("Payment term deleted.");
        await loadMaster();
      } catch (error) {
        setStatus(error.message, true);
      }
    });
  });

  qs("#item-form").addEventListener("submit", async (event) => {
    if (state.masterPage !== "items") return;
    event.preventDefault();
    const formData = new FormData(event.currentTarget);
    const externalRef = String(formData.get("externalRef") || "").trim();
    const payload = {
      itemCode: String(formData.get("itemCode") || ""),
      name: String(formData.get("name") || ""),
      unitPrice: Number(formData.get("unitPrice") || 0),
      ...(externalRef && { externalRef })
    };
    const customFields = collectCustomFieldPayload(formData, itemFieldDefinitions);
    if (Object.keys(customFields).length) payload.customFields = customFields;
    try {
      await api("/items", {
        method: "POST",
        body: payload
      });
      setStatus("Item created.");
      await loadMaster();
    } catch (error) {
      setStatus(error.message, true);
    }
  });

  views.master.querySelectorAll(".item-price").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const unitPrice = prompt("New unit price", btn.dataset.price || "0");
      if (!unitPrice) return;
      try {
        await api(`/items/${btn.dataset.id}`, {
          method: "PATCH",
          body: { unitPrice: Number(unitPrice) }
        });
        setStatus("Item updated.");
        await loadMaster();
      } catch (error) {
        setStatus(error.message, true);
      }
    });
  });

  views.master.querySelectorAll(".item-delete").forEach((btn) => {
    btn.addEventListener("click", async () => {
      if (!confirm("Delete this item?")) return;
      try {
        await api(`/items/${btn.dataset.id}`, { method: "DELETE" });
        setStatus("Item deleted.");
        await loadMaster();
      } catch (error) {
        setStatus(error.message, true);
      }
    });
  });

  views.master.querySelectorAll('[data-settings-link]').forEach((link) => {
    link.addEventListener("click", (e) => {
      e.preventDefault();
      navigateToSettingsPage(link.dataset.settingsLink);
    });
  });
}

// Stage accent resolved by name so Won=green, Lost=red regardless of position
const NON_TERMINAL_ACCENTS = ["--stage-0", "--stage-1", "--stage-2"];

function stageAccentVar(stageName, nonTerminalIndex) {
  const n = (stageName || "").toLowerCase();
  if (n.includes("won"))  return "--stage-3"; // green
  if (n.includes("lost")) return "--stage-4"; // red
  return NON_TERMINAL_ACCENTS[nonTerminalIndex % NON_TERMINAL_ACCENTS.length];
}

// ── Shared multiselect dropdown builder ──────────────────────────────────────
const _msChevron = `<svg class="ms-dropdown-chevron" width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true"><path d="M2 4l4 4 4-4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

function msDropdown({ id, fieldName, options, selected, allLabel, singularUnit }) {
  const total = options.length;
  const selCount = selected.length;
  const allSel = selCount === 0 || selCount === total;
  const btnLabel = allSel
    ? allLabel
    : selCount === 1
      ? (options.find(o => o.value === selected[0])?.label || `1 ${singularUnit || "item"}`)
      : `${selCount} selected`;
  const items = options.map(({ value, label }) => {
    const checked = selCount === 0 || selected.includes(value);
    return `<label class="ms-dropdown-item">
      <input type="checkbox" name="${fieldName}" value="${value}" ${checked ? "checked" : ""}>
      <span class="ms-item-label" title="${label}">${label}</span>
    </label>`;
  }).join("");
  return `<div class="ms-dropdown" id="${id}-ms">
    <button type="button" class="ms-dropdown-btn" id="${id}-btn">
      <span class="ms-dropdown-label" id="${id}-label">${btnLabel}</span>
      ${_msChevron}
    </button>
    <div class="ms-dropdown-panel" id="${id}-panel" hidden>
      <div class="ms-dropdown-header">
        <button type="button" class="ms-select-all" id="${id}-select-all">Select all</button>
        <button type="button" class="ms-clear" id="${id}-clear">Clear</button>
      </div>
      <div class="ms-dropdown-list" id="${id}-list">${items}</div>
    </div>
  </div>`;
}

function initMsDropdown(id, allLabel, onChange) {
  const btn    = qs(`#${id}-btn`);
  const panel  = qs(`#${id}-panel`);
  const label  = qs(`#${id}-label`);
  const list   = qs(`#${id}-list`);
  const selAll = qs(`#${id}-select-all`);
  const clear  = qs(`#${id}-clear`);
  if (!btn || !panel || !list) return;

  function updateLabel() {
    const all     = [...list.querySelectorAll('input[type="checkbox"]')];
    const checked = all.filter(c => c.checked);
    if (checked.length === 0 || checked.length === all.length) {
      label.textContent = allLabel;
    } else if (checked.length === 1) {
      label.textContent = checked[0].closest(".ms-dropdown-item")
        ?.querySelector(".ms-item-label")?.textContent?.trim() || "1 selected";
    } else {
      label.textContent = `${checked.length} selected`;
    }
  }

  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    const isOpen = !panel.hidden;
    document.querySelectorAll(".ms-dropdown-panel").forEach(p => p.hidden = true);
    document.querySelectorAll(".ms-dropdown-btn").forEach(b => b.classList.remove("open"));
    panel.hidden = isOpen;
    btn.classList.toggle("open", !isOpen);
  });

  selAll?.addEventListener("click", () => {
    list.querySelectorAll('input[type="checkbox"]').forEach(c => c.checked = true);
    updateLabel();
    onChange?.();
  });

  clear?.addEventListener("click", () => {
    list.querySelectorAll('input[type="checkbox"]').forEach(c => c.checked = false);
    updateLabel();
    onChange?.();
  });

  list.addEventListener("change", () => { updateLabel(); onChange?.(); });
}

// Deals filter state (client-side, no extra API call)
state.dealsFilter = { query: "", suspicious: false, repIds: [], followUpFrom: "", followUpTo: "", closedFrom: "", closedTo: "" };

function renderDealCard(deal, kanban) {
  const now = new Date();
  const followUp = deal.followUpAt ? new Date(deal.followUpAt) : null;
  const isClosed = deal.status === "WON" || deal.status === "LOST";
  const isOverdue = !isClosed && followUp && followUp < now;

  // urgency emoji
  const today = new Date(now); today.setHours(0, 0, 0, 0);
  const tomorrow = new Date(today); tomorrow.setDate(tomorrow.getDate() + 1);
  const urgencyIcon = isOverdue
    ? `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 14.5C8 18 10 20 12 20c2 0 4-2 4-5.5 0-2-1.5-3.5-2-5-1 2-4 3-4 5z"/><path d="M12 20c-4 0-7-3-7-7 0-5 5-7 7-11 2 3 3 5 3 7 1-1 2-2 2-4 3 4 4 8 4 11 0 4-3 7-7 7"/></svg>`
    : (followUp && followUp >= today && followUp < tomorrow)
    ? `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M13 2 4 14h7l-1 8 9-12h-7l1-8z"/></svg>`
    : `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18"/><path d="M8 3v4"/><path d="M16 3v4"/></svg>`;
  const followUpText = followUp
    ? followUp.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" })
    : "—";

  // value tier badge
  const v = deal.estimatedValue || 0;
  const tierBadge = v >= 100000
    ? `<span class="deal-tier deal-tier--diamond" title="Big deal"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 3h12l3 6-9 12L3 9z"/><path d="M3 9h18"/><path d="m9 3-3 6 6 12"/><path d="m15 3 3 6-6 12"/></svg></span>`
    : v >= 10000
    ? `<span class="deal-tier deal-tier--star" title="Mid deal"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m12 3 2.8 5.7 6.2.9-4.5 4.4 1.1 6.2L12 17.3 6.4 20.2l1.1-6.2L3 9.6l6.2-.9z"/></svg></span>`
    : "";

  // stage progress bar (skip for closed)
  const openStages = kanban.stages.filter(s => !s.isClosedWon && !s.isClosedLost);
  const openIdx = openStages.findIndex(s => s.id === deal.stageId);
  const stageProgressPct = !isClosed && openStages.length > 1
    ? Math.round((openIdx / (openStages.length - 1)) * 100)
    : null;

  // won/lost banner
  const closedBanner = deal.status === "WON"
    ? `<div class="deal-closed-banner deal-closed-banner--won"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 21h8"/><path d="M12 17v4"/><path d="M7 4h10v5a5 5 0 0 1-10 0V4z"/><path d="M17 5h3a2 2 0 0 1 0 4h-3"/><path d="M7 5H4a2 2 0 0 0 0 4h3"/></svg>Deal Won!</div>`
    : deal.status === "LOST"
    ? `<div class="deal-closed-banner deal-closed-banner--lost"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/><path d="m9.5 11 2 2-1 3 1.5-1.5L14 16l-1-3 2-2"/></svg>Deal Lost</div>`
    : "";

  const customerInitial = (deal.customer?.name || "?")[0].toUpperCase();
  const stageOptions = kanban.stages
    .map((s) => `<option value="${s.id}" ${s.id === deal.stageId ? "selected" : ""}>${escHtml(s.stageName)}</option>`)
    .join("");

  return `
    <div class="deal-card${isOverdue ? " deal-card--overdue" : ""}${deal.status === "WON" ? " deal-card--won" : ""}${deal.status === "LOST" ? " deal-card--lost" : ""}" data-id="${deal.id}" draggable="true">
      ${closedBanner}
      <div class="deal-card-head">
        <span class="deal-no">${deal.dealNo}</span>
        <button class="deal-menu-btn deal-value" data-id="${deal.id}" data-value="${deal.estimatedValue}" title="Edit value">···</button>
      </div>
      <div class="deal-name">${escHtml(deal.dealName)}</div>
      <div class="deal-info">
        <div class="deal-info-row">
          <span class="deal-customer-icon">${customerInitial}</span>
          <span>${escHtml(deal.customer?.name || "—")}</span>
        </div>
        <div class="deal-value-row">
          ${tierBadge}${asMoney(deal.estimatedValue)}
        </div>
        ${!isClosed ? `<div class="deal-info-row${isOverdue ? " overdue" : ""}">
          <span class="deal-urgency-icon">${urgencyIcon}</span>
          ${isOverdue ? "Overdue · " : "Follow-up · "}${followUpText}
        </div>` : ""}
      </div>
      <div class="deal-card-footer">
        <span class="deal-assignee"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>${escHtml(deal.owner?.fullName || "Unassigned")}</span>
        <button class="deal-detail-btn" data-id="${deal.id}" data-no="${escHtml(deal.dealNo)}" title="Open deal detail">
          <svg width="11" height="11" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>
        </button>
      </div>
      <div class="deal-card-actions">
        <select class="deal-stage-select" data-id="${deal.id}">${stageOptions}</select>
        <button class="deal-stage-save" data-id="${deal.id}">Move</button>
        <button type="button" class="voice-note-btn ghost" data-entity-type="DEAL" data-entity-id="${deal.id}" title="Voice note">${icon('mic')}</button>
      </div>
      ${stageProgressPct !== null ? `<div class="deal-stage-progress"><span style="width:${stageProgressPct}%"></span></div>` : ""}
    </div>
  `;
}

function openDealCreateModal(kanban) {
  const modal = qs("#deal-create-modal");
  if (!modal) return;
  const stageOptions = kanban.stages
    .map((s) => `<option value="${s.id}">${escHtml(s.stageName)}</option>`).join("");
  const form = modal.querySelector("#deal-form");
  form.querySelector('[name="stageId"]').innerHTML = stageOptions;
  form.reset();
  // Reset customer autocomplete
  const inp = modal.querySelector("#deal-customer-input");
  const hid = modal.querySelector("#deal-customer-id");
  const lst = modal.querySelector("#deal-customer-list");
  if (inp) inp.value = "";
  if (hid) hid.value = "";
  if (lst) lst.hidden = true;
  modal.hidden = false;
  // Inject "Acting on behalf of" picker for delegate roles.
  attachOnBehalfOfField(form).catch(() => {});
}

function closeDealCreateModal() {
  const modal = qs("#deal-create-modal");
  if (modal) modal.hidden = true;
}

function applyDealsFilter(kanban) {
  const { query, suspicious, repIds, followUpFrom, followUpTo, closedFrom, closedTo } = state.dealsFilter;
  const now = new Date();
  const q = query.trim().toLowerCase();
  const filterByRep = repIds && repIds.length > 0;
  const fuFrom = followUpFrom ? new Date(followUpFrom + "T00:00:00") : null;
  const fuTo   = followUpTo   ? new Date(followUpTo   + "T23:59:59") : null;
  const clFrom = closedFrom   ? new Date(closedFrom   + "T00:00:00") : null;
  const clTo   = closedTo     ? new Date(closedTo     + "T23:59:59") : null;
  return kanban.stages.map((stage) => ({
    ...stage,
    deals: stage.deals.filter((deal) => {
      if (q) {
        const haystack = [deal.dealNo, deal.dealName, deal.customer?.name].join(" ").toLowerCase();
        if (!haystack.includes(q)) return false;
      }
      if (suspicious) {
        const isClosed = deal.status === "WON" || deal.status === "LOST";
        if (isClosed) return false;
        const followUp = deal.followUpAt ? new Date(deal.followUpAt) : null;
        if (!followUp || followUp >= now) return false;
      }
      if (filterByRep && !repIds.includes(deal.owner?.id)) return false;
      if (fuFrom || fuTo) {
        const fu = deal.followUpAt ? new Date(deal.followUpAt) : null;
        if (!fu) return false;
        if (fuFrom && fu < fuFrom) return false;
        if (fuTo   && fu > fuTo)   return false;
      }
      if (clFrom || clTo) {
        const cl = deal.closedAt ? new Date(deal.closedAt) : null;
        if (!cl) return false;
        if (clFrom && cl < clFrom) return false;
        if (clTo   && cl > clTo)   return false;
      }
      return true;
    })
  }));
}

function renderDeals(kanban, dealsRoot = views.deals, options = {}) {
  const compact = !!options.compact;
  const rdeals = (k) => renderDeals(k, dealsRoot, { compact });

  const filteredStages = applyDealsFilter(kanban);
  const totalDeals = filteredStages.reduce((s, st) => s + st.deals.length, 0);
  const { query, suspicious, repIds, followUpFrom, followUpTo, closedFrom, closedTo } = state.dealsFilter;
  const isRep = state.user?.role === "REP";
  const hasFilter = query || suspicious || repIds?.length || followUpFrom || followUpTo || closedFrom || closedTo;

  const repMap = new Map();
  kanban.stages.forEach((stage) => {
    stage.deals.forEach((deal) => {
      if (deal.owner?.id) repMap.set(deal.owner.id, deal.owner.fullName || deal.owner.id);
    });
  });
  const repOptions = [...repMap.entries()].map(([id, name]) => ({ value: id, label: name }));

  let nonTerminalIdx = 0;

  const boardHtml = `
      <div class="kanban-board">
        ${filteredStages.map((stage) => {
          const accentVar = stageAccentVar(stage.stageName, nonTerminalIdx);
          const isTerminal = accentVar === "--stage-3" || accentVar === "--stage-4";
          if (!isTerminal) nonTerminalIdx++;
          const colValue = stage.deals.reduce((s, d) => s + (Number(d.estimatedValue) || 0), 0);
          return `
            <div class="kanban-col" data-stage-id="${stage.id}" style="--col-accent: var(${accentVar})">
              <div class="kanban-col-header">
                <div class="kanban-col-header-top">
                  <h3>${escHtml(stage.stageName)}</h3>
                  <span class="kanban-col-count">${stage.deals.length}</span>
                </div>
                <div class="kanban-col-value">${asMoney(colValue)}</div>
              </div>
              <div class="kanban-cards">
                ${
                  stage.deals.length
                    ? stage.deals.map((deal) => renderDealCard(deal, kanban)).join("")
                    : `<div class="empty-state compact"><div class="empty-icon">${icon('archive')}</div><div><strong>${hasFilter ? "No matches" : "No deals"}</strong></div></div>`
                }
              </div>
            </div>
          `;
        }).join("")}
      </div>`;

  if (compact) {
    dealsRoot.innerHTML = `<div class="deals-outer deals-outer--embed">${boardHtml}</div>`;
  } else {
    dealsRoot.innerHTML = `
    <div class="deals-outer">
      <div class="deals-page-header">
        <h2 class="deals-title"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="7" width="18" height="13" rx="2"/><path d="M8 7V5a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><path d="M3 13h18"/></svg>Deal Pipeline</h2>
        <button class="deals-create-btn" id="deals-create-btn">
          ${icon('sparkles')} New Deal
        </button>
      </div>

      <div class="deals-filter-bar">
        <div class="deals-search-wrap">
          <svg class="deals-search-icon" width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true"><circle cx="6" cy="6" r="4.5" stroke="currentColor" stroke-width="1.5"/><path d="M10 10l2.5 2.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>
          <input class="deals-search-input" id="deals-search" type="text" placeholder="Search deal, customer…" value="${query}" />
        </div>
        ${!isRep && repOptions.length > 0 ? msDropdown({
          id: "deals-rep",
          fieldName: "repIds",
          options: repOptions,
          selected: repIds || [],
          allLabel: "All Reps",
          singularUnit: "rep"
        }) : ""}
        <div class="deals-date-range" id="deals-followup-range">
          <span class="deals-date-label">Follow-up</span>
          <input class="deals-date-input" type="date" id="deals-followup-from" value="${followUpFrom}" title="Follow-up from" />
          <span class="deals-date-sep">–</span>
          <input class="deals-date-input" type="date" id="deals-followup-to" value="${followUpTo}" title="Follow-up to" />
        </div>
        <div class="deals-date-range" id="deals-closed-range">
          <span class="deals-date-label">Closed</span>
          <input class="deals-date-input" type="date" id="deals-closed-from" value="${closedFrom}" title="Closed from" />
          <span class="deals-date-sep">–</span>
          <input class="deals-date-input" type="date" id="deals-closed-to" value="${closedTo}" title="Closed to" />
        </div>
        <button class="deals-filter-btn${suspicious ? " active" : ""}" id="deals-suspicious-btn" title="Deals with a follow-up date in the past">
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true"><path d="M7 2a5 5 0 100 10A5 5 0 007 2zm0 3v2.5l1.5 1.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>
          Overdue follow-ups${suspicious ? ` ${icon('check', 12)}` : ""}
        </button>
        ${hasFilter ? `<span class="deals-filter-result">${totalDeals} deal${totalDeals !== 1 ? "s" : ""}</span>` : ""}
      </div>

      ${boardHtml}
    </div>
  `;
  }

  if (!compact) {
    dealsRoot.querySelector("#deals-create-btn")?.addEventListener("click", () => openDealCreateModal(kanban));

    dealsRoot.querySelector("#deals-search")?.addEventListener("input", (e) => {
      state.dealsFilter.query = e.target.value;
      rdeals(kanban);
    });

    dealsRoot.querySelector("#deals-suspicious-btn")?.addEventListener("click", () => {
      state.dealsFilter.suspicious = !state.dealsFilter.suspicious;
      rdeals(kanban);
    });

    if (!isRep && repOptions.length > 0) {
      initMsDropdown("deals-rep", "All Reps", () => {
        const list = dealsRoot.querySelector("#deals-rep-list");
        if (!list) return;
        const checked = [...list.querySelectorAll('input[type="checkbox"]:checked')];
        const all = [...list.querySelectorAll('input[type="checkbox"]')];
        state.dealsFilter.repIds = (checked.length === all.length) ? [] : checked.map(c => c.value);
        rdeals(kanban);
      });
    }

    dealsRoot.querySelector("#deals-followup-from")?.addEventListener("change", (e) => { state.dealsFilter.followUpFrom = e.target.value; rdeals(kanban); });
    dealsRoot.querySelector("#deals-followup-to")?.addEventListener("change",   (e) => { state.dealsFilter.followUpTo   = e.target.value; rdeals(kanban); });
    dealsRoot.querySelector("#deals-closed-from")?.addEventListener("change",   (e) => { state.dealsFilter.closedFrom   = e.target.value; rdeals(kanban); });
    dealsRoot.querySelector("#deals-closed-to")?.addEventListener("change",     (e) => { state.dealsFilter.closedTo     = e.target.value; rdeals(kanban); });
  }

  const board = dealsRoot.querySelector(".kanban-board");
  if (board) {
    board.addEventListener("dragstart", (e) => {
      const card = e.target.closest(".deal-card");
      if (!card) return;
      e.dataTransfer.setData("text/plain", card.dataset.id);
      e.dataTransfer.effectAllowed = "move";
      requestAnimationFrame(() => card.classList.add("deal-card--dragging"));
    });

    board.addEventListener("dragend", (e) => {
      const card = e.target.closest(".deal-card");
      if (card) card.classList.remove("deal-card--dragging");
      board.querySelectorAll(".kanban-col").forEach((c) => c.classList.remove("kanban-col--drag-over"));
    });

    board.addEventListener("dragover", (e) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      const col = e.target.closest(".kanban-col");
      board.querySelectorAll(".kanban-col").forEach((c) => c.classList.remove("kanban-col--drag-over"));
      if (col) col.classList.add("kanban-col--drag-over");
    });

    board.addEventListener("dragleave", (e) => {
      const col = e.target.closest(".kanban-col");
      if (col && !col.contains(e.relatedTarget)) col.classList.remove("kanban-col--drag-over");
    });

    board.addEventListener("drop", async (e) => {
      e.preventDefault();
      const dealId = e.dataTransfer.getData("text/plain");
      const col = e.target.closest(".kanban-col");
      board.querySelectorAll(".kanban-col").forEach((c) => c.classList.remove("kanban-col--drag-over"));
      if (!dealId || !col) return;
      const stageId = col.dataset.stageId;
      if (!stageId) return;

      const targetStage = kanban.stages.find((s) => s.id === stageId);
      const sourceStage = kanban.stages.find((s) => s.deals.some((d) => d.id === dealId));
      if (!targetStage || !sourceStage || sourceStage.id === targetStage.id) return;

      const deal = sourceStage.deals.find((d) => d.id === dealId);
      const sourceIdx = kanban.stages.indexOf(sourceStage);
      const targetIdx = kanban.stages.indexOf(targetStage);

      if (targetIdx < sourceIdx) {
        const confirmed = confirm(
          `Moving "${deal?.dealName || "this deal"}" backwards\n\n` +
          `From: ${sourceStage.stageName}  →  To: ${targetStage.stageName}\n\n` +
          `This reverses pipeline progress. Confirm?`
        );
        if (!confirmed) return;
      }

      let lostNote;
      if (targetStage.isClosedLost) {
        try {
          lostNote = await requestLostReason(deal?.dealName || "");
        } catch {
          return;
        }
      }

      sourceStage.deals = sourceStage.deals.filter((d) => d.id !== dealId);
      targetStage.deals = [...targetStage.deals, { ...deal, stageId }];
      rdeals(kanban);
      try {
        await api(`/deals/${dealId}/stage`, { method: "PATCH", body: { stageId, ...(lostNote ? { lostNote } : {}) } });
        setStatus(`Deal moved to ${targetStage.stageName}.`);
        await loadDeals();
      } catch (error) {
        setStatus(error.message, true);
        await loadDeals();
      }
    });
  }

  dealsRoot.querySelectorAll(".deal-stage-save").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const nextStageId = dealsRoot.querySelector(
        `.deal-stage-select[data-id="${btn.dataset.id}"]`
      )?.value;
      if (!nextStageId) return;

      const targetStage = kanban.stages.find((s) => s.id === nextStageId);
      let lostNote;
      if (targetStage?.isClosedLost) {
        const deal = kanban.stages.flatMap((s) => s.deals).find((d) => d.id === btn.dataset.id);
        try {
          lostNote = await requestLostReason(deal?.dealName || "");
        } catch {
          return;
        }
      }

      try {
        await api(`/deals/${btn.dataset.id}/stage`, {
          method: "PATCH",
          body: { stageId: nextStageId, ...(lostNote ? { lostNote } : {}) }
        });
        setStatus("Deal stage moved.");
        await loadDeals();
      } catch (error) {
        setStatus(error.message, true);
      }
    });
  });

  dealsRoot.querySelectorAll(".deal-value").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const estimatedValue = prompt("New estimated value", btn.dataset.value || "0");
      if (!estimatedValue) return;
      try {
        await api(`/deals/${btn.dataset.id}`, {
          method: "PATCH",
          body: { estimatedValue: Number(estimatedValue) }
        });
        setStatus("Deal updated.");
        await loadDeals();
        await loadDashboard();
      } catch (error) {
        setStatus(error.message, true);
      }
    });
  });

  dealsRoot.querySelectorAll(".voice-note-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      const card = btn.closest(".deal-card");
      const label = card?.querySelector(".deal-name")?.textContent?.trim() || "";
      void openVoiceNoteModal(btn.dataset.entityType, btn.dataset.entityId, label);
    });
  });

  dealsRoot.querySelectorAll(".deal-detail-btn").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      openDeal360(btn.dataset.id, btn.dataset.no);
    });
  });
}

function visitMonthFromRange() {
  const from = state.visitPage.dateFrom || "";
  return from.length >= 7 ? from.slice(0, 7) : new Date().toISOString().slice(0, 7);
}

function applyMonthToVisitRange(ym) {
  const [y, m] = ym.split("-").map(Number);
  if (!y || !m) return;
  const pad = (n) => String(n).padStart(2, "0");
  const lastDay = new Date(y, m, 0).getDate();
  state.visitPage.dateFrom = `${y}-${pad(m)}-01`;
  state.visitPage.dateTo = `${y}-${pad(m)}-${pad(lastDay)}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// MY TASKS PAGE
// ─────────────────────────────────────────────────────────────────────────────

async function loadMyTasks() {
  const data = await api("/todo/events");
  state.cache.myTasks = data;
  renderMyTasks(data);
}

function renderMyTasks(data) {
  if (!views.repHub) return;
  const now = new Date();

  // ── helpers ──────────────────────────────────────────────────────────────

  function elapsed(from) {
    const ms = now - new Date(from);
    const m = Math.floor(ms / 60000);
    if (m < 60) return `${m}m`;
    return `${Math.floor(m / 60)}h ${m % 60}m`;
  }

  function fmtTime(iso) {
    return new Date(iso).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
  }

  function fmtDate(iso) {
    return new Date(iso).toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" });
  }

  function isSameDay(a, b) {
    const da = new Date(a), db = new Date(b);
    return da.getFullYear() === db.getFullYear() && da.getMonth() === db.getMonth() && da.getDate() === db.getDate();
  }

  const hasActiveCheckIn = (data.pinned?.checkedInWaitingCheckout || []).length > 0;

  // ── visit card ─────────────────────────────────────────────────────────────

  function visitCard(ev, opts = {}) {
    const isCheckedIn = ev.status === "CHECKED_IN";
    const isOverdue = opts.overdue;
    const stripe = isCheckedIn ? "mt-card--red" : isOverdue ? "mt-card--red" : "mt-card--blue";
    const checkInBtn = (ev.status === "PLANNED") ? (
      hasActiveCheckIn
        ? `<button class="mt-action mt-action--checkin" disabled title="Complete your current check-out first" style="opacity:0.45;cursor:not-allowed">
            <svg width="13" height="13" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/></svg>
            Check In
          </button>`
        : `<button class="mt-action mt-action--checkin" data-visit-id="${ev.entityId}" data-visit-customer="${escHtml(ev.customer.name)}">
            <svg width="13" height="13" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/></svg>
            Check In
          </button>`)
    : isCheckedIn ? `
      <button class="mt-action mt-action--checkout" data-visit-id="${ev.entityId}" data-visit-customer="${escHtml(ev.customer.name)}">
        <svg width="13" height="13" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
        Check Out
      </button>` : "";

    return `
      <div class="mt-card ${stripe}" data-visit-id="${ev.entityId}">
        <div class="mt-card-type mt-type--visit">${icon('location')} Visit</div>
        <div class="mt-card-main">
          <div class="mt-card-customer">${escHtml(ev.customer.name)}</div>
          ${ev.visitNo ? `<div class="mt-card-visitno">${escHtml(ev.visitNo)}</div>` : ""}
          <div class="mt-card-meta">
            <span class="mt-meta-time">
              <svg width="11" height="11" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/></svg>
              ${isCheckedIn ? `Checked in ${elapsed(ev.at)} ago` : fmtTime(ev.at)}
            </span>
            ${ev.owner ? `<span class="mt-meta-rep">${escHtml(ev.owner.name)}</span>` : ""}
          </div>
          ${ev.objective ? `<div class="mt-card-detail">${escHtml(ev.objective)}</div>` : ""}
        </div>
        <div class="mt-card-actions">
          ${checkInBtn}
          ${ev.status === "PLANNED" ? `
          <button class="mt-action mt-action--edit-visit" data-visit-id="${ev.entityId}" title="Edit visit">
            <svg width="13" height="13" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
            Edit
          </button>` : ""}
        </div>
      </div>`;
  }

  // ── deal card ──────────────────────────────────────────────────────────────

  function dealCard(ev, opts = {}) {
    const isOverdue = opts.overdue;
    const closeToday = ev.closedAt && isSameDay(ev.at, ev.closedAt);
    const stripe = isOverdue ? "mt-card--red" : closeToday ? "mt-card--green" : "mt-card--purple";
    const stageAccent = (() => {
      const stages = state.cache.dealStages || [];
      let ntIdx = 0;
      for (const s of stages) {
        const v = stageAccentVar(s.stageName, ntIdx);
        if (s.id === ev.stage?.id) return v;
        if (v !== "--stage-3" && v !== "--stage-4") ntIdx++;
      }
      return ev.stage ? stageAccentVar(ev.stage.name, 0) : "--stage-0";
    })();

    return `
      <div class="mt-card ${stripe}${closeToday ? " mt-card--close-today" : ""}">
        <div class="mt-card-type mt-type--deal">${icon('briefcase')} Deal</div>
        <div class="mt-card-main">
          <div class="mt-card-customer">${escHtml(ev.customer.name)}</div>
          <div class="mt-card-dealname">${escHtml(ev.dealName || ev.title)}</div>
          <div class="mt-card-meta">
            <span class="mt-meta-time">
              <svg width="11" height="11" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/></svg>
              Follow-up ${isOverdue ? fmtDate(ev.at) : fmtTime(ev.at)}
            </span>
            ${ev.stage ? `<span class="mt-stage-badge" style="--sa:var(${stageAccent})">${escHtml(ev.stage.name)}</span>` : ""}
            ${ev.estimatedValue ? `<span class="mt-meta-value">${asMoney(ev.estimatedValue)}</span>` : ""}
          </div>
          ${closeToday ? `<div class="mt-close-today-hint">${icon('target')} Target close today</div>` : ""}
        </div>
        <div class="mt-card-actions">
          <button class="mt-action mt-action--deal" data-deal-id="${ev.entityId}" data-deal-no="${escHtml(ev.dealNo || ev.entityId)}">
            <svg width="13" height="13" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg>
            Update Progress
          </button>
          <button class="mt-action mt-action--edit-deal" data-deal-id="${ev.entityId}">
            <svg width="13" height="13" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
            Edit Deal
          </button>
        </div>
      </div>`;
  }

  // ── section ────────────────────────────────────────────────────────────────

  function section(title, events, cls, opts = {}) {
    if (!events.length) return "";
    const cards = events.map(ev =>
      ev.type === "visit" ? visitCard(ev, opts) : dealCard(ev, opts)
    ).join("");
    return `
      <section class="mt-section ${cls}">
        <div class="mt-section-head">
          <h3 class="mt-section-title">${title}</h3>
          <span class="mt-section-count">${events.length}</span>
        </div>
        <div class="mt-cards">${cards}</div>
      </section>`;
  }

  const inProgress = data.pinned?.checkedInWaitingCheckout || [];
  const overdue = data.buckets?.overdue || [];
  const today = data.buckets?.today || [];
  const tomorrow = data.buckets?.tomorrow || [];
  const nextWeek = data.buckets?.next_week || [];
  const nextMonth = data.buckets?.next_month || [];
  const total = (data.counts?.total || 0) + inProgress.length;

  const hour = now.getHours();
  const greeting = hour < 12 ? "Good morning" : hour < 17 ? "Good afternoon" : hour < 21 ? "Good evening" : "Burning the midnight oil";
  const todayLabel = now.toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long" });

  views.repHub.innerHTML = `
    <div class="mt-page">
      <div class="mt-page-head">
        <div>
          <div class="mt-page-title-row">
            <h2 class="mt-page-title"><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 3h6a1 1 0 0 1 1 1v2H8V4a1 1 0 0 1 1-1z"/><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/><path d="m9 14 2 2 4-4"/></svg>My Tasks</h2>
            ${total ? `<span class="mt-total-badge">${total}</span>` : ""}
          </div>
          <div class="mt-page-greeting">${greeting} — ${todayLabel}</div>
        </div>
        <div class="mt-page-actions">
          <button class="ghost topnav-icon-btn" id="mt-refresh" title="Refresh">
            <svg width="15" height="15" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M23 4v6h-6"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg>
          </button>
          <button class="primary" id="mt-new-visit">${icon('location')} Plan Visit</button>
          <button class="ghost" id="mt-new-deal">${icon('briefcase')} Add Deal</button>
        </div>
      </div>

      ${!total && !inProgress.length ? `
        <div class="empty-state" style="margin-top:var(--sp-8)">
          <div style="font-size:3rem;line-height:1;margin-bottom:var(--sp-2)">${icon('party')}</div>
          <div><strong>All clear — you're crushing it!</strong><p>No tasks due today or coming up.</p></div>
        </div>` : `

        ${section(`${icon('location')} Meeting In-Progress`, inProgress, "mt-section--inprogress")}
        ${section(`${icon('warning')} Need Follow-Up`, overdue, "mt-section--overdue", { overdue: true })}
        ${section(`${icon('sun')} Today`, today, "mt-section--today")}
        ${section(`${icon('sunrise')} Tomorrow`, tomorrow, "mt-section--tomorrow")}
        ${section(`${icon('calendar')} Next 7 Days`, nextWeek, "mt-section--nextweek")}
        ${section(`${icon('calendar')} Next 30 Days`, nextMonth, "mt-section--nextmonth")}
      `}
    </div>`;

  // ── wire actions ────────────────────────────────────────────────────────────

  qs("#mt-refresh")?.addEventListener("click", async () => {
    try { await loadMyTasks(); } catch (e) { setStatus(e.message, true); }
  });
  qs("#mt-new-visit")?.addEventListener("click", () => openVisitCreateModal());
  qs("#mt-new-deal")?.addEventListener("click", () => {
    if (state.cache.kanban) openDealCreateModal(state.cache.kanban);
  });

  views.repHub.querySelectorAll(".mt-action--checkin").forEach(btn => {
    btn.addEventListener("click", () => {
      if (btn.disabled) return;
      const active = views.repHub.querySelectorAll(".mt-action--checkout");
      if (active.length > 0) {
        setStatus("Please complete your current check-out before starting a new check-in.", true);
        return;
      }
      openCheckInModal(btn.dataset.visitId, btn.dataset.visitCustomer);
    });
  });

  views.repHub.querySelectorAll(".mt-action--checkout").forEach(btn => {
    btn.addEventListener("click", () =>
      openCheckOutModal(btn.dataset.visitId, btn.dataset.visitCustomer)
    );
  });

  views.repHub.querySelectorAll(".mt-action--deal").forEach(btn => {
    btn.addEventListener("click", () =>
      openDeal360(btn.dataset.dealId, btn.dataset.dealNo)
    );
  });

  views.repHub.querySelectorAll(".mt-action--edit-deal").forEach(btn => {
    btn.addEventListener("click", async () => {
      const id = btn.dataset.dealId;
      if (!id) return;
      try {
        const deal = await api(`/deals/${id}`);
        openDealEditModal(deal);
      } catch (err) {
        setStatus(err.message, true);
      }
    });
  });

  views.repHub.querySelectorAll(".mt-action--edit-visit").forEach(btn => {
    btn.addEventListener("click", async () => {
      const id = btn.dataset.visitId;
      if (!id) return;
      try {
        const visit = await api(`/visits/${id}`);
        openVisitEditModal(visit);
      } catch (err) {
        setStatus(err.message, true);
      }
    });
  });

  views.repHub.querySelectorAll(".mt-card[data-visit-id]").forEach(card => {
    card.addEventListener("click", e => {
      if (e.target.closest("button")) return;
      openVisitDetail(card.dataset.visitId);
    });
  });
}

// ── Check-In Modal ─────────────────────────────────────────────────────────────

function openCheckInModal(visitId, customerName) {
  qs("#mt-checkin-modal")?.remove();

  document.body.insertAdjacentHTML("beforeend", `
    <div id="mt-checkin-modal" class="mt-checkin-backdrop">
      <div class="mt-checkin-dialog" role="dialog" aria-modal="true" aria-label="Check In">
        <div class="mt-checkin-header">
          <div class="mt-checkin-title">Check In</div>
          <div class="mt-checkin-customer">${escHtml(customerName || "")}</div>
          <button class="ced-close" id="mt-checkin-close" aria-label="Close">${icon('x', 14)}</button>
        </div>

        <div class="mt-checkin-body">
          <div class="mt-checkin-section">
            <div class="mt-checkin-section-label">
              <svg width="13" height="13" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/></svg>
              Location
            </div>
            <div id="mt-checkin-location-status" class="mt-checkin-status">Detecting location…</div>
          </div>

          <div class="mt-checkin-section">
            <div class="mt-checkin-section-label">
              <svg width="13" height="13" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"/><path d="M20.94 11A8.994 8.994 0 0 0 12 3a8.994 8.994 0 0 0-8.94 8"/><path d="M20.94 13A8.994 8.994 0 0 1 12 21a8.994 8.994 0 0 1-8.94-8"/></svg>
              Selfie
            </div>
            <div class="mt-checkin-camera-wrap">
              <video id="mt-checkin-video" class="mt-checkin-video" autoplay playsinline muted></video>
              <canvas id="mt-checkin-canvas" class="mt-checkin-canvas" hidden></canvas>
              <img id="mt-checkin-preview" class="mt-checkin-preview" hidden alt="Selfie preview" />
            </div>
            <div class="mt-checkin-camera-actions">
              <button class="ghost" id="mt-checkin-capture">Take Photo</button>
              <button class="ghost" id="mt-checkin-retake" hidden>Retake</button>
            </div>
          </div>
        </div>

        <div class="mt-checkin-footer">
          <button class="ghost" id="mt-checkin-cancel">Cancel</button>
          <button class="primary" id="mt-checkin-confirm" disabled>Confirm Check-In</button>
        </div>
      </div>
    </div>`);

  const modal    = qs("#mt-checkin-modal");
  const video    = qs("#mt-checkin-video");
  const canvas   = qs("#mt-checkin-canvas");
  const preview  = qs("#mt-checkin-preview");
  const locEl    = qs("#mt-checkin-location-status");
  const confirmBtn = qs("#mt-checkin-confirm");
  const captureBtn = qs("#mt-checkin-capture");
  const retakeBtn  = qs("#mt-checkin-retake");

  let coords = null;
  let selfieDataUrl = null;
  let stream = null;

  function checkReady() {
    confirmBtn.disabled = !(coords && selfieDataUrl);
  }

  // Get location
  if (navigator.geolocation) {
    navigator.geolocation.getCurrentPosition(
      pos => {
        coords = { lat: pos.coords.latitude, lng: pos.coords.longitude };
        locEl.textContent = `${coords.lat.toFixed(5)}, ${coords.lng.toFixed(5)}`;
        locEl.className = "mt-checkin-status mt-checkin-status--ok";
        checkReady();
      },
      () => {
        locEl.textContent = "Location unavailable — using approximate.";
        locEl.className = "mt-checkin-status mt-checkin-status--warn";
        coords = { lat: 0, lng: 0 };
        checkReady();
      }
    );
  } else {
    locEl.textContent = "Geolocation not supported.";
    coords = { lat: 0, lng: 0 };
  }

  // Start camera
  navigator.mediaDevices?.getUserMedia({ video: { facingMode: "user" }, audio: false })
    .then(s => {
      stream = s;
      video.srcObject = s;
    })
    .catch(() => {
      qs("#mt-checkin-camera-wrap").innerHTML =
        `<div class="mt-checkin-status mt-checkin-status--warn">Camera unavailable — check-in will proceed without selfie.</div>`;
      selfieDataUrl = "no-selfie";
      checkReady();
    });

  captureBtn.addEventListener("click", () => {
    canvas.width = 320; canvas.height = 240;
    canvas.getContext("2d").drawImage(video, 0, 0, 320, 240);
    selfieDataUrl = canvas.toDataURL("image/jpeg", 0.7);
    preview.src = selfieDataUrl;
    preview.hidden = false;
    video.hidden = true;
    captureBtn.hidden = true;
    retakeBtn.hidden = false;
    checkReady();
  });

  retakeBtn.addEventListener("click", () => {
    selfieDataUrl = null;
    preview.hidden = true;
    video.hidden = false;
    captureBtn.hidden = false;
    retakeBtn.hidden = true;
    confirmBtn.disabled = true;
  });

  function closeModal() {
    stream?.getTracks().forEach(t => t.stop());
    modal.remove();
  }

  qs("#mt-checkin-close").addEventListener("click", closeModal);
  qs("#mt-checkin-cancel").addEventListener("click", closeModal);
  modal.addEventListener("click", e => { if (e.target === modal) closeModal(); });

  confirmBtn.addEventListener("click", async () => {
    confirmBtn.disabled = true;
    confirmBtn.textContent = "Checking in…";
    try {
      const checkinRes = await api(`/visits/${visitId}/checkin`, {
        method: "POST",
        body: { lat: coords.lat, lng: coords.lng, selfieUrl: selfieDataUrl || "no-selfie" }
      });
      setStatus("Checked in successfully.");
      showNotifWarnings(checkinRes?.notifWarnings);
      closeModal();
      await loadMyTasks();
    } catch (e) {
      setStatus(e.message, true);
      confirmBtn.disabled = false;
      confirmBtn.textContent = "Confirm Check-In";
    }
  });
}

// ── Check-Out Modal ─────────────────────────────────────────────────────────────

function openCheckOutModal(visitId, customerName) {
  qs("#mt-checkout-modal")?.remove();

  const nowIso = (() => {
    const d = new Date();
    d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
    return d.toISOString().slice(0, 16);
  })();

  document.body.insertAdjacentHTML("beforeend", `
    <div id="mt-checkout-modal" class="mt-checkin-backdrop">
      <div class="mt-checkout-dialog" role="dialog" aria-modal="true" aria-label="Check Out">
        <div class="mt-checkin-header">
          <div>
            <div class="mt-checkin-title">Check Out</div>
            <div class="mt-checkin-customer">${escHtml(customerName || "")}</div>
          </div>
          <button class="ced-close" id="mt-checkout-close" aria-label="Close">${icon('x', 14)}</button>
        </div>

        <div class="mt-checkout-body">

          <!-- Location -->
          <div class="mt-checkout-field">
            <div class="mt-checkout-field-label">Location</div>
            <div id="mt-checkout-location" class="mt-checkin-status mt-checkin-status--pending">Detecting location…</div>
          </div>

          <!-- Result -->
          <div class="mt-checkout-field">
            <label class="form-label" for="mt-checkout-result">
              <span class="form-label-text">Visit Result <span class="req-star">*</span></span>
            </label>
            <textarea id="mt-checkout-result" class="mt-checkout-textarea" rows="4"
              placeholder="What was discussed? What was agreed? Any action items?"></textarea>
          </div>

          <!-- Voice Note -->
          <div class="mt-checkout-field">
            <div class="mt-checkout-field-label">Voice Note (optional)</div>
            <button type="button" class="ghost mt-checkout-voice-btn" id="mt-checkout-voice-btn">
              <svg width="14" height="14" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" y1="19" x2="12" y2="23"/><line x1="8" y1="23" x2="16" y2="23"/></svg>
              Add Voice Note
            </button>
            <div id="mt-checkout-voice-status" class="mt-checkout-voice-status" hidden></div>
          </div>

          <!-- Next Appointment -->
          <div class="mt-checkout-field">
            <div class="mt-checkout-field-label">Next Appointment</div>
            <label class="mt-checkout-toggle-row">
              <input type="checkbox" id="mt-checkout-has-next" />
              <span>Schedule a follow-up visit now</span>
            </label>
            <div id="mt-checkout-next-form" class="mt-checkout-next-form" hidden>
              <div class="mt-checkout-next-row">
                <label class="mt-checkout-next-label" for="mt-checkout-next-date">Date &amp; Time</label>
                <input type="datetime-local" id="mt-checkout-next-date" class="mt-checkout-next-input" value="${nowIso}" />
              </div>
              <div class="mt-checkout-next-row">
                <label class="mt-checkout-next-label" for="mt-checkout-next-objective">Objective</label>
                <textarea id="mt-checkout-next-objective" class="mt-checkout-textarea" rows="3"
                  placeholder="Purpose of next visit…"></textarea>
              </div>
            </div>
          </div>

        </div>

        <div class="mt-checkin-footer">
          <button type="button" class="ghost" id="mt-checkout-cancel">Cancel</button>
          <button type="button" class="primary" id="mt-checkout-confirm">Confirm Check-Out</button>
        </div>
      </div>
    </div>`);

  const modal      = qs("#mt-checkout-modal");
  const resultEl   = qs("#mt-checkout-result");
  const confirmBtn = qs("#mt-checkout-confirm");
  const hasNextChk = qs("#mt-checkout-has-next");
  const nextForm   = qs("#mt-checkout-next-form");
  const voiceBtn   = qs("#mt-checkout-voice-btn");
  const locEl      = qs("#mt-checkout-location");

  let checkoutCoords = null;

  // Capture GPS at modal open
  if (navigator.geolocation) {
    navigator.geolocation.getCurrentPosition(
      pos => {
        checkoutCoords = { lat: pos.coords.latitude, lng: pos.coords.longitude };
        locEl.textContent = `${checkoutCoords.lat.toFixed(5)}, ${checkoutCoords.lng.toFixed(5)}`;
        locEl.className = "mt-checkin-status mt-checkin-status--ok";
      },
      () => {
        locEl.textContent = "Location unavailable";
        locEl.className = "mt-checkin-status mt-checkin-status--warn";
      },
      { enableHighAccuracy: true, timeout: 10000 }
    );
  } else {
    locEl.textContent = "Geolocation not supported";
    locEl.className = "mt-checkin-status mt-checkin-status--warn";
  }

  function closeModal() { modal.remove(); }

  qs("#mt-checkout-close").addEventListener("click", closeModal);
  qs("#mt-checkout-cancel").addEventListener("click", closeModal);
  modal.addEventListener("click", e => { if (e.target === modal) closeModal(); });

  // Toggle next-appointment form
  hasNextChk.addEventListener("change", () => {
    nextForm.hidden = !hasNextChk.checked;
  });

  // Voice note — open the existing voice note modal targeting this visit.
  // Hide (not remove) the checkout modal so it's restored when voice note closes.
  voiceBtn.addEventListener("click", () => {
    modal.style.display = "none";
    setVoiceNoteOnClose(() => { modal.style.display = ""; });
    void openVoiceNoteModal("VISIT", visitId, `Check-out · ${customerName || ""}`);
  });

  // Submit
  confirmBtn.addEventListener("click", async () => {
    const result = (resultEl.value || "").trim();
    if (!result) {
      resultEl.focus();
      resultEl.style.outline = "2px solid var(--danger)";
      return;
    }
    confirmBtn.disabled = true;
    confirmBtn.textContent = "Saving…";
    try {
      const checkoutRes = await api(`/visits/${visitId}/checkout`, {
        method: "POST",
        body: { lat: checkoutCoords?.lat ?? 0, lng: checkoutCoords?.lng ?? 0, result }
      });

      showNotifWarnings(checkoutRes?.notifWarnings);

      // Create follow-up visit if requested
      if (hasNextChk.checked) {
        const nextDate = (qs("#mt-checkout-next-date")?.value || "").trim();
        const nextObj  = (qs("#mt-checkout-next-objective")?.value || "").trim();
        if (nextDate) {
          const existing = state.cache.visits?.find(v => v.id === visitId);
          const custId = existing?.customerId || null;
          const dealId = existing?.dealId     || null;
          await api("/visits/planned", {
            method: "POST",
            body: {
              customerId: custId,
              dealId,
              plannedAt: new Date(nextDate).toISOString(),
              objective: nextObj || "Follow-up visit"
            }
          });
        }
      }

      setStatus("Visit checked out successfully.");
      closeModal();
      await loadMyTasks();
    } catch (e) {
      setStatus(e.message, true);
      confirmBtn.disabled = false;
      confirmBtn.textContent = "Confirm Check-Out";
    }
  });
}

// ── legacy stubs (kept so repHub nav wiring still calls something) ─────────────
function paintRepHubFull() { loadMyTasks().catch(e => setStatus(e.message, true)); }

function visitActionLabel(v) {
  if (v.status === "CHECKED_IN") return "Check-out";
  if (v.status === "PLANNED") return "Check-in";
  return "Done";
}

function buildVisitListHtml(visits, q, status) {
  const statusLabel  = { PLANNED: "Planned", CHECKED_IN: "Active", CHECKED_OUT: "Completed" };
  const visitTypeLabel = { PLANNED: "Scheduled", UNPLANNED: "Drop-in" };
  const statusCls   = { PLANNED: "", CHECKED_IN: "chip-primary", CHECKED_OUT: "chip-success" };
  const statusOrder = { CHECKED_IN: 0, PLANNED: 1, CHECKED_OUT: 2 };
  const filtered = (q
    ? visits.filter(v =>
        v.customer?.name?.toLowerCase().includes(q) ||
        v.rep?.fullName?.toLowerCase().includes(q) ||
        v.objective?.toLowerCase().includes(q) ||
        v.result?.toLowerCase().includes(q)
      )
    : visits
  ).slice().sort((a, b) => (statusOrder[a.status] ?? 1) - (statusOrder[b.status] ?? 1));

  if (!filtered.length) return `
    <div class="empty-state">
      <svg class="empty-icon-svg" width="40" height="40" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/></svg>
      <div><strong>${q || status ? "No visits match your filters" : "No visits yet"}</strong><p>${q || status ? "Try adjusting the search or status filter." : "Add planned or drop-in visits to get started."}</p></div>
    </div>`;

  return `<div class="vp-list">${filtered.map(v => {
    const isOwn = v.rep?.id === state.user?.id;
    return `
    <div class="vp-card status-${v.status}" data-visit-id="${v.id}">
      <div class="vp-card-status-bar"></div>
      <div class="vp-card-body">
        <div class="vp-card-top">
          <div class="vp-card-customer">${escHtml(v.customer?.name || "—")}</div>
          <div class="vp-card-chips">
            ${v.visitNo ? `<span class="chip chip--visitno">${escHtml(v.visitNo)}</span>` : ""}
            <span class="chip ${statusCls[v.status]}">${statusLabel[v.status] || v.status}</span>
          </div>
        </div>
        <div class="vp-card-meta">
          <div class="vp-card-rep">
            <span class="vp-rep-avatar" style="${v.rep?.avatarUrl ? "overflow:hidden" : "background:" + avatarColor(v.rep?.fullName || "")}">${repAvatarHtml(v.rep?.fullName || "", v.rep?.avatarUrl)}</span>
            <span class="vp-rep-name">${escHtml(v.rep?.fullName || "—")}${isOwn ? " (me)" : ""}</span>
          </div>
          <span class="vp-card-date">
            <svg width="12" height="12" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="4" width="18" height="18" rx="2" ry="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>
            ${asDate(v.plannedAt)}
          </span>
          ${v.deal ? `<span class="vp-deal-link muted">Deal: ${escHtml(v.deal.name || v.deal.id)}</span>` : ""}
        </div>
        ${v.objective ? `<div class="vp-card-objective">${escHtml(v.objective)}</div>` : ""}
        ${v.result ? `<div class="vp-card-result"><svg width="12" height="12" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="20 6 9 17 4 12"/></svg>${escHtml(v.result)}</div>` : ""}
        <div class="vp-card-actions">
          <button type="button" class="ghost voice-note-btn vp-icon-btn" data-entity-type="VISIT" data-entity-id="${v.id}" title="Voice note">
            <svg width="14" height="14" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" y1="19" x2="12" y2="23"/><line x1="8" y1="23" x2="16" y2="23"/></svg>
          </button>
          ${isOwn && v.status !== "CHECKED_OUT" ? `
            <button type="button" class="visit-action ${v.status === "CHECKED_IN" ? "btn-success" : ""}" data-visit-id="${v.id}" data-visit-status="${v.status}">
              ${v.status === "PLANNED"
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
  // Click on card body (not on buttons) → open detail panel
  container.querySelectorAll(".vp-card").forEach((card) => {
    card.addEventListener("click", (e) => {
      if (e.target.closest("button")) return;
      const id = card.dataset.visitId;
      if (id) openVisitDetail(id);
    });
  });

  container.querySelectorAll(".voice-note-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      const card = btn.closest(".vp-card");
      const label = card?.querySelector(".vp-card-customer")?.textContent?.trim() || "";
      void openVoiceNoteModal(btn.dataset.entityType, btn.dataset.entityId, label);
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

// ── Visit Detail Panel ────────────────────────────────────────────────────────

const visitDetailPanel = qs("#visit-detail-panel");
const visitDetailBody  = qs("#visit-detail-body");

qs("#visit-detail-close")?.addEventListener("click", closeVisitDetailPanel);

function openVisitDetailPanel() {
  // Close other panels first (notif, settings)
  if (notifPanel && !notifPanel.hidden)    { notifPanel.hidden = true; notifPanel.classList.remove("open"); }
  if (settingsPanel && !settingsPanel.hidden) { settingsPanel.hidden = true; settingsPanel.classList.remove("open"); }
  if (!visitDetailPanel) return;
  visitDetailPanel.hidden = false;
  requestAnimationFrame(() => visitDetailPanel.classList.add("open"));
  if (panelBackdrop) {
    panelBackdrop.hidden = false;
    requestAnimationFrame(() => panelBackdrop.classList.add("open"));
  }
}

function closeVisitDetailPanel() {
  if (!visitDetailPanel) return;
  visitDetailPanel.classList.remove("open");
  visitDetailPanel.addEventListener("transitionend", () => { visitDetailPanel.hidden = true; }, { once: true });
  if (panelBackdrop) {
    panelBackdrop.classList.remove("open");
    panelBackdrop.addEventListener("transitionend", () => { panelBackdrop.hidden = true; }, { once: true });
  }
}

async function openVisitDetail(visitId) {
  if (!visitDetailBody) return;
  visitDetailBody.innerHTML = `<div class="vd-loading">Loading…</div>`;
  openVisitDetailPanel();

  try {
    const [visit, changelogs] = await Promise.all([
      api(`/visits/${visitId}`),
      api(`/changelogs?entityType=VISIT&entityId=${visitId}&limit=50`).catch(() => null)
    ]);
    renderVisitDetailContent(visit, changelogs);
  } catch (err) {
    visitDetailBody.innerHTML = `<div class="vd-loading" style="color:var(--danger-text,red)">${escHtml(err.message)}</div>`;
  }
}

function fmtDuration(ms) {
  if (ms == null || isNaN(ms)) return "—";
  const totalSec = Math.floor(Math.abs(ms) / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  const pad = n => String(n).padStart(2, "0");
  return `${pad(h)}:${pad(m)}:${pad(s)}`;
}

function fmtDiffLabel(ms) {
  if (ms == null || isNaN(ms)) return null;
  const totalSec = Math.floor(Math.abs(ms) / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const parts = [];
  if (h > 0) parts.push(`${h}h`);
  if (m > 0 || h === 0) parts.push(`${m}m`);
  const label = parts.join(" ");
  if (Math.abs(ms) < 60000) return { cls: "ontime", text: "On time" };
  return ms < 0
    ? { cls: "early", text: `${label} early` }
    : { cls: "late",  text: `${label} late` };
}

function renderVisitDetailContent(visit, changelogs) {
  if (!visitDetailBody) return;

  const statusLabelMap = { PLANNED: "Planned", CHECKED_IN: "Active", CHECKED_OUT: "Completed" };
  const statusClsMap   = { PLANNED: "planned", CHECKED_IN: "active", CHECKED_OUT: "done" };
  const visitTypeLabelMap = { PLANNED: "Scheduled", UNPLANNED: "Drop-in" };

  const plannedAt  = visit.plannedAt  ? new Date(visit.plannedAt)  : null;
  const checkInAt  = visit.checkInAt  ? new Date(visit.checkInAt)  : null;
  const checkOutAt = visit.checkOutAt ? new Date(visit.checkOutAt) : null;

  const plannedVsActualMs = (plannedAt && checkInAt) ? (checkInAt - plannedAt) : null;
  const durationMs        = (checkInAt && checkOutAt) ? (checkOutAt - checkInAt) : null;
  const diffInfo = fmtDiffLabel(plannedVsActualMs);

  // ── Hero ────────────────────────────────────────────────────────────────────
  const isOwnVisit = visit.rep?.id === state.user?.id;
  const canEdit = isOwnVisit && visit.status === "PLANNED";
  const heroHtml = `
    <div class="vd-hero">
      <div class="vd-hero-top">
        <div class="vd-hero-customer">${escHtml(visit.customer?.name || "—")}</div>
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
          <span class="vd-hero-rep-avatar" style="${visit.rep?.avatarUrl ? "overflow:hidden" : "background:" + avatarColor(visit.rep?.fullName || "")}">${repAvatarHtml(visit.rep?.fullName || "", visit.rep?.avatarUrl)}</span>
          ${escHtml(visit.rep?.fullName || "—")}
        </span>
      </div>
    </div>`;

  // ── Customer Detail ──────────────────────────────────────────────────────────
  const c = visit.customer || {};
  const addr = c.addresses?.[0];
  const addrLine = addr
    ? [addr.addressLine1, addr.district, addr.province, addr.country].filter(Boolean).join(", ")
    : null;
  const customerHtml = `
    <div class="vd-section">
      <p class="vd-section-title">${icon('building')} Customer</p>
      <div class="vd-detail-rows">
        <div class="vd-detail-row"><span class="vd-detail-row-label">Code</span><span class="vd-detail-row-value">${escHtml(c.customerCode || "—")}</span></div>
        <div class="vd-detail-row"><span class="vd-detail-row-label">Type</span><span class="vd-detail-row-value">${escHtml(c.customerType || "—")}</span></div>
        ${addrLine ? `<div class="vd-detail-row"><span class="vd-detail-row-label">Address</span><span class="vd-detail-row-value">${escHtml(addrLine)}</span></div>` : ""}
        ${c.taxId ? `<div class="vd-detail-row"><span class="vd-detail-row-label">Tax ID</span><span class="vd-detail-row-value">${escHtml(c.taxId)}</span></div>` : ""}
      </div>
    </div>`;

  // ── Deal ────────────────────────────────────────────────────────────────────
  const dealHtml = visit.deal ? `
    <div class="vd-section">
      <p class="vd-section-title">${icon('handshake')} Related Deal</p>
      <div class="vd-deal-card">
        <div class="vd-deal-no">${escHtml(visit.deal.dealNo)}</div>
        <div class="vd-deal-name">${escHtml(visit.deal.dealName)}</div>
        ${visit.deal.stage ? `<div class="vd-deal-stage">${escHtml(visit.deal.stage.stageName)}</div>` : ""}
      </div>
    </div>` : "";

  // ── Timing ──────────────────────────────────────────────────────────────────
  const timingHtml = `
    <div class="vd-section">
      <p class="vd-section-title">${icon('bell')} Timing</p>
      <div class="vd-timing-grid">
        <div class="vd-timing-card">
          <div class="vd-timing-card-label">Planned</div>
          <div class="vd-timing-card-value ${plannedAt ? "" : "muted"}">${plannedAt ? asDate(plannedAt) : "—"}</div>
        </div>
        <div class="vd-timing-card ${checkInAt ? "" : ""}">
          <div class="vd-timing-card-label">Check-in</div>
          <div class="vd-timing-card-value ${checkInAt ? "" : "muted"}">${checkInAt ? asDate(checkInAt) : "—"}</div>
        </div>
        <div class="vd-timing-card ${checkOutAt ? "" : ""}">
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

  // ── Expected Result ──────────────────────────────────────────────────────────
  const objectiveHtml = `
    <div class="vd-section">
      <p class="vd-section-title">${icon('target')} Expected Result</p>
      <div class="vd-result-block ${visit.objective ? "" : "empty"}">${visit.objective ? escHtml(visit.objective) : "No objective recorded."}</div>
    </div>`;

  // ── Actual Result ────────────────────────────────────────────────────────────
  const resultHtml = `
    <div class="vd-section">
      <p class="vd-section-title">${icon('checkCircle')} Actual Result</p>
      <div class="vd-result-block ${visit.result ? "" : "empty"}">${visit.result ? escHtml(visit.result) : "No result recorded yet."}</div>
    </div>`;

  // ── Location ─────────────────────────────────────────────────────────────────
  // Prefer check-in coords → planned coords → customer coords → customer address text
  const lat = visit.checkInLat ?? visit.siteLat ?? visit.customer?.siteLat ?? null;
  const lng = visit.checkInLng ?? visit.siteLng ?? visit.customer?.siteLng ?? null;
  const custAddr = visit.customer?.addresses?.[0];
  const addrText = custAddr
    ? [custAddr.addressLine1, custAddr.district, custAddr.province, custAddr.country].filter(Boolean).join(", ")
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
  } else if (addrText) {
    const dirUrl = `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(addrText)}`;
    locationHtml = `
      <div class="vd-section">
        <p class="vd-section-title">${icon('location')} Location</p>
        <div class="vd-map-fallback">${icon('location')} ${escHtml(addrText)}</div>
        <a class="vd-directions-btn" href="${dirUrl}" target="_blank" rel="noopener">
          Get Directions
        </a>
      </div>`;
  }

  // ── Changelog ───────────────────────────────────────────────────────────────
  let changelogHtml;
  if (changelogs === null) {
    changelogHtml = `<div class="vd-section"><p class="vd-section-title">Change History</p><div class="vd-cl-restricted">Not available for your role.</div></div>`;
  } else {
    const actionLabelMap = { CREATE: "Visit Created", UPDATE: "Visit Updated" };
    const dotClsMap = { CREATE: "create" };
    const workflowDotMap = { CHECK_IN: "checkin", CHECK_OUT: "checkout" };
    const workflowLabelMap = { CHECK_IN: "Checked In", CHECK_OUT: "Checked Out" };

    const clItems = (changelogs || []).map((cl) => {
      const workflow = cl.contextJson?.workflow;
      const dotCls = workflowDotMap[workflow] || dotClsMap[cl.action] || "";
      const actionLabel = workflowLabelMap[workflow] || actionLabelMap[cl.action] || cl.action;
      const when = cl.createdAt ? asDate(cl.createdAt) : "—";
      const who = cl.changedBy?.fullName || "System";

      // Build a diff table for UPDATE actions
      let diffRows = "";
      if (cl.action === "UPDATE" && cl.beforeJson && cl.afterJson) {
        const before = cl.beforeJson;
        const after  = cl.afterJson;
        const tracked = ["status", "result", "objective", "checkInAt", "checkOutAt"];
        const changed = tracked.filter((k) => String(before[k] ?? "") !== String(after[k] ?? ""));
        if (changed.length) {
          const fmtVal = (k, v) => {
            if (v == null || v === "") return "(empty)";
            if (k.endsWith("At")) return asDate(v);
            return String(v);
          };
          diffRows = `<div class="vd-cl-changes">${changed.map((k) => `
            <div class="vd-cl-change-row">
              <span class="vd-cl-field">${escHtml(k)}</span>
              <span class="vd-cl-from">${escHtml(fmtVal(k, before[k]))}</span>
              <span class="vd-cl-arrow">→</span>
              <span class="vd-cl-to">${escHtml(fmtVal(k, after[k]))}</span>
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

  // ── Voice Notes ─────────────────────────────────────────────────────────────
  let voiceNotesHtml = "";
  if (visit.voiceNotes?.length) {
    const items = visit.voiceNotes.map((vn) => {
      const when = vn.transcript?.confirmedAt ? asDate(new Date(vn.transcript.confirmedAt)) : "—";
      const summary = vn.transcript?.summaryText ? escHtml(vn.transcript.summaryText) : "";
      return `
        <div class="vd-vn-item" data-job-id="${escHtml(vn.id)}">
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

  // Wire edit button
  visitDetailBody.querySelector(".vd-edit-btn")?.addEventListener("click", () => openVisitEditModal(visit));

  // Load audio URLs for each voice note after rendering
  if (visit.voiceNotes?.length) {
    visitDetailBody.querySelectorAll(".vd-vn-item").forEach(async (item) => {
      const jobId = item.dataset.jobId;
      const audioEl = item.querySelector(".vd-vn-audio");
      const loadingEl = item.querySelector(".vd-vn-loading");
      try {
        const { url } = await api(`/voice-notes/${jobId}/audio-url`);
        if (url) {
          audioEl.src = url;
          loadingEl.hidden = true;
        } else {
          loadingEl.textContent = "Audio not available in dev mode.";
        }
      } catch {
        loadingEl.textContent = "Could not load audio.";
      }
    });
  }
}



(function initVisitEditModal() {
  const modal = qs("#visit-edit-modal");
  if (!modal) return;
  modal.querySelectorAll("[data-visit-edit-close]").forEach(el => {
    el.addEventListener("click", closeVisitEditModal);
  });
  qs("#visit-edit-pick-location-btn")?.addEventListener("click", () => {
    const lat = parseFloat(qs("#visit-edit-site-lat")?.value) || null;
    const lng = parseFloat(qs("#visit-edit-site-lng")?.value) || null;
    openMapPicker(lat, lng, (pickedLat, pickedLng) => {
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

  qs("#visit-edit-form")?.addEventListener("submit", async (e) => {
    e.preventDefault();
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
      // Explicitly clear location if both were emptied
      body.siteLat = null;
      body.siteLng = null;
    }
    if (!Object.keys(body).length) { closeVisitEditModal(); return; }
    const submitBtn = qs("#visit-edit-submit");
    submitBtn.disabled = true;
    submitBtn.textContent = "Saving…";
    try {
      await api(`/visits/${id}`, { method: "PATCH", body });
      closeVisitEditModal();
      setStatus("Visit updated.");
      const reloadId = id;
      await Promise.all([loadVisits(), loadMyTasks().catch(() => {})]);
      if (visitDetailBody && !visitDetailPanel?.hidden) openVisitDetail(reloadId);
    } catch (err) {
      setStatus(err.message, true);
    } finally {
      submitBtn.disabled = false;
      submitBtn.textContent = "Save Changes";
    }
  });
})();

// ── Deal Edit Modal ───────────────────────────────────────────────────────────

function openDealEditModal(deal) {
  const modal = qs("#deal-edit-modal");
  if (!modal) return;
  qs("#deal-edit-id").value = deal.id;
  qs("#deal-edit-modal-subtitle").textContent = deal.dealName || deal.dealNo || "";
  qs("#deal-edit-value").value = deal.estimatedValue ?? "";
  // followUpAt
  if (deal.followUpAt) {
    const d = new Date(deal.followUpAt);
    qs("#deal-edit-followup").value = new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
  } else {
    qs("#deal-edit-followup").value = "";
  }
  // closedAt (date only)
  if (deal.closedAt) {
    const d = new Date(deal.closedAt);
    qs("#deal-edit-close").value = new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
  } else {
    qs("#deal-edit-close").value = "";
  }
  modal.hidden = false;
}

function closeDealEditModal() {
  const modal = qs("#deal-edit-modal");
  if (modal) modal.hidden = true;
}

(function initDealEditModal() {
  const modal = qs("#deal-edit-modal");
  if (!modal) return;
  modal.querySelectorAll("[data-deal-edit-close]").forEach(el => {
    el.addEventListener("click", closeDealEditModal);
  });
  qs("#deal-edit-form")?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const id = qs("#deal-edit-id").value;
    const estimatedValue = qs("#deal-edit-value").value;
    const followUpAt = qs("#deal-edit-followup").value;
    const closedAtRaw = qs("#deal-edit-close").value;
    const body = {};
    if (estimatedValue !== "") body.estimatedValue = parseFloat(estimatedValue);
    if (followUpAt) body.followUpAt = new Date(followUpAt).toISOString();
    if (closedAtRaw) body.closedAt = new Date(closedAtRaw + "T23:59:59").toISOString();
    if (!Object.keys(body).length) { closeDealEditModal(); return; }
    const submitBtn = qs("#deal-edit-submit");
    submitBtn.disabled = true;
    submitBtn.textContent = "Saving…";
    try {
      await api(`/deals/${id}`, { method: "PATCH", body });
      closeDealEditModal();
      setStatus("Deal updated.");
      await loadDeals();
      if (state.deal360) renderDeal360(state.deal360);
    } catch (err) {
      setStatus(err.message, true);
    } finally {
      submitBtn.disabled = false;
      submitBtn.textContent = "Save Changes";
    }
  });
})();



// Visit create modal events (wired once at module level below)

function renderIntegrationLogs(logs) {
  views.integrations.innerHTML = `
    <div class="logs-outer">
      <h3 class="section-title">${icon('plug')} Integration Logs</h3>
      <div class="list">
        ${
          logs.length
            ? logs.map((log) => `
                <div class="log-item">
                  <div class="log-status-dot ${log.status}"></div>
                  <div>
                    <div class="log-title">${log.platform} · ${log.operationType}</div>
                    <div class="log-detail">${log.responseSummary || log.errorMessage || "—"}</div>
                  </div>
                  <div class="log-time">${asDate(log.startedAt)}<br><span class="chip ${log.status === "SUCCESS" ? "chip-success" : "chip-danger"}">${log.status}</span></div>
                </div>
              `).join("")
            : `<div class="empty-state"><div class="empty-icon">${icon('plug', 24)}</div><div><strong>No integration logs yet</strong><p>Run a connection test in Settings to generate the first log.</p></div></div>`
        }
      </div>
    </div>
  `;
}

function renderSettings() {
  const tenantId = state.user?.tenantId;
  if (!tenantId) {
    views.settings.innerHTML = `<section class="card"><div class="muted">No tenant context.</div></section>`;
    return;
  }

  const page = state.settingsPage || "company";

  // Lazy-load notification prefs the first time the page is visited
  if (page === "notifications" && state.cache.notifPrefs === undefined) {
    state.cache.notifPrefs = null; // mark loading
    loadNotifPrefs().then(prefs => { state.cache.notifPrefs = prefs; renderSettings(); });
  }
  // Lazy-load profile integrations on notifications page (first visit)
  if (page === "notifications" && state.cache.myIntegrations === null) {
    state.cache.myIntegrations = undefined; // mark loading
    refreshMyIntegrations().then(() => renderSettings());
  }
  // Lazy-load cron jobs on first visit
  if (page === "cron-jobs" && state.cache.cronJobs === undefined) {
    state.cache.cronJobs = null; // loading
    api("/cron-jobs").then(data => { state.cache.cronJobs = data; renderSettings(); }).catch(() => { state.cache.cronJobs = []; renderSettings(); });
  }
  // Lazy-load custom field definitions for all entity types on first visit
  if (page === "custom-fields" && state.cache.customFieldSettings === undefined) {
    state.cache.customFieldSettings = null;
    Promise.all([
      api("/custom-fields/payment-term"),
      api("/custom-fields/customer"),
      api("/custom-fields/item")
    ]).then(([pt, cu, it]) => {
      state.cache.customFieldSettings = { "payment-term": pt, customer: cu, item: it };
      renderSettings();
    }).catch(() => {
      state.cache.customFieldSettings = { "payment-term": [], customer: [], item: [] };
      renderSettings();
    });
  }
  const isAdmin = state.user?.role === "ADMIN";
  const isManager = state.user?.role === "MANAGER";
  const branding = state.cache.branding || {};
  const brandingTokens = { ...DEFAULT_TOKENS, ...(branding.themeTokens || {}) };
  const activePresetSlug = detectPresetSlug({ ...brandingTokens, primaryColor: branding.primaryColor, secondaryColor: branding.secondaryColor });
  const tax = state.cache.taxConfig || { vatEnabled: true, vatRatePercent: 7 };
  const visitCfg = state.cache.visitConfig || { checkInMaxDistanceM: 1000, minVisitDurationMinutes: 15 };
  const tenantThemeMode = branding.themeMode || "LIGHT";
  const integrationCredentials = state.cache.integrationCredentials || [];
  const teams = state.cache.teams || [];
  const allUsers = state.cache.allUsers || [];
  const tenantInfo = state.cache.tenantInfo || {};
  const salesRepOptions = state.cache.salesReps
    .map((rep) => {
      const teamSuffix = rep.team?.teamName ? ` · ${escHtml(rep.team.teamName)}` : "";
      return `<option value="${rep.id}">${escHtml(rep.fullName)}${teamSuffix}</option>`;
    })
    .join("");
  const defaultRepId = state.cache.salesReps[0]?.id || "";

  const role = state.user?.role || "REP";
  const roleRank = { ADMIN: 5, DIRECTOR: 4, MANAGER: 3, SUPERVISOR: 2, REP: 1 };
  const hasRole = (...allowed) => allowed.includes(role);

  const personalNavItems = [
    { page: "my-profile",    label: "My Profile",               ic: "user" },
    { page: "notifications", label: "Notifications",            ic: "bell" }
  ];

  const allNavItems = [
    { page: "company",        label: "Company Settings",      ic: "building", roles: ["ADMIN"] },
    { page: "branding",       label: "Branding & Theme",      ic: "palette", roles: ["ADMIN"] },
    { page: "team-structure", label: "Team Structure",         ic: "users", roles: ["ADMIN", "DIRECTOR", "MANAGER", "SUPERVISOR", "REP"] },
    { page: "roles",          label: "Roles & Permissions",   ic: "lockKey", roles: ["ADMIN"] },
    { page: "kpi-targets",    label: "KPI Targets",            ic: "target", roles: ["ADMIN", "DIRECTOR", "MANAGER", "SUPERVISOR", "REP"] },
    { page: "integrations",   label: "Integrations",          ic: "plug", roles: ["ADMIN"] },
    { page: "custom-domain",  label: "Custom Domain",          ic: "globe", roles: ["ADMIN"] },
    { page: "data-sync",      label: "Data Sync",              ic: "refresh", roles: ["ADMIN"] },
    { page: "custom-fields",  label: "Custom Fields",         ic: "clipboard", roles: ["ADMIN"] },
    { page: "cron-jobs",      label: "Scheduled Jobs",         ic: "clock", roles: ["ADMIN"] },
    { page: "logs",           label: "Logs",                   ic: "activity", roles: ["ADMIN"], view: "integrations" }
  ];
  const navItems = allNavItems.filter(item => item.roles.includes(role));

  // Redirect to my-profile if current page is not accessible.
  // "logs" is a cross-link item (switches to the Integrations view), not a real settings page,
  // so exclude it from the allowed-pages set.
  const allAllowedPages = [...personalNavItems.map(i => i.page), ...navItems.filter(i => !i.view).map(i => i.page)];
  if (!allAllowedPages.includes(page)) {
    state.settingsPage = "my-profile";
    return renderSettings();
  }

  // ── Page content ─────────────────────────────────────────────
  let pageHtml = "";

  if (page === "my-profile") {
    const me = state.user;
    const roleLabels = { ADMIN: "Admin", DIRECTOR: "Sales Director", MANAGER: "Sales Manager", SUPERVISOR: "Supervisor", REP: "Sales Rep" };
    const roleCls    = { ADMIN: "rp-badge--admin", DIRECTOR: "rp-badge--director", MANAGER: "rp-badge--manager", SUPERVISOR: "rp-badge--supervisor", REP: "rp-badge--rep" };
    const teamName   = state.cache.teams?.find(t => t.id === me?.teamId)?.teamName || "—";
    const managerName = state.cache.allUsers?.find(u => u.id === me?.managerUserId)?.fullName || "—";
    pageHtml = `
      <section class="card profile-hero-card">
        <div class="profile-hero">
          <div class="profile-avatar-wrap">
            <button type="button" class="profile-avatar-btn" id="profile-avatar-btn" title="Change profile photo">
              <span class="profile-hero-avatar" style="${me?.avatarUrl ? "overflow:hidden" : "background:" + avatarColor(me?.fullName || "")}">${repAvatarHtml(me?.fullName || "", me?.avatarUrl)}</span>
              <span class="profile-avatar-overlay" aria-hidden="true">
                <svg width="18" height="18" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/><circle cx="12" cy="13" r="4"/></svg>
              </span>
            </button>
            <input type="file" id="profile-avatar-file" accept="image/jpeg,image/png,image/webp" style="display:none">
            ${me?.avatarUrl ? `<button type="button" class="ghost small" id="profile-avatar-remove">Remove photo</button>` : ""}
          </div>
          <div class="profile-hero-info">
            <div class="profile-hero-name">${escHtml(me?.fullName || "—")}</div>
            <div class="profile-hero-email">${escHtml(me?.email || "")}</div>
            <span class="rp-badge ${roleCls[me?.role] || ""}">${roleLabels[me?.role] || me?.role || ""}</span>
          </div>
        </div>
      </section>

      <section class="card">
        <h3 class="section-title">${icon('user')} Personal Information</h3>
        <form id="profile-info-form" class="settings-form">
          <div class="settings-field-row">
            <label class="form-label">Full Name
              <input class="form-input" name="fullName" value="${escHtml(me?.fullName || "")}" required maxlength="120" />
            </label>
            <label class="form-label">Email Address
              <input class="form-input" name="email" type="email" value="${escHtml(me?.email || "")}" required />
            </label>
          </div>
          <div class="settings-field-row">
            <label class="form-label">Role
              <input class="form-input" value="${roleLabels[me?.role] || me?.role || ""}" disabled />
              <span class="form-hint">Role is managed by your administrator.</span>
            </label>
            <label class="form-label">Team
              <input class="form-input" value="${escHtml(teamName)}" disabled />
            </label>
            <label class="form-label">Reports To
              <input class="form-input" value="${escHtml(managerName)}" disabled />
            </label>
          </div>
          <div><button type="submit" class="btn-primary">Save Changes</button></div>
        </form>
      </section>

      <section class="card">
        <h3 class="section-title">${icon('lock')} Change Password</h3>
        <form id="change-password-form" class="settings-form">
          <div class="settings-field-row">
            <label class="form-label">Current Password
              <input class="form-input" name="currentPassword" type="password" autocomplete="current-password" required />
            </label>
          </div>
          <div class="settings-field-row">
            <label class="form-label">New Password
              <input class="form-input" name="newPassword" type="password" autocomplete="new-password" minlength="8" required />
              <span class="form-hint">Minimum 8 characters.</span>
            </label>
            <label class="form-label">Confirm New Password
              <input class="form-input" name="confirmPassword" type="password" autocomplete="new-password" required />
            </label>
          </div>
          <div id="pw-change-msg"></div>
          <div><button type="submit" class="btn-primary">Change Password</button></div>
        </form>
      </section>

      ${window.PublicKeyCredential ? `
      <section class="card">
        <h3 class="section-title">${icon('key')} Passkeys</h3>
        <p class="form-hint" style="margin-bottom:var(--sp-4)">Sign in securely using your fingerprint, face, or device PIN. Passkeys are phishing-resistant and work across your devices.</p>
        <div id="passkey-list" class="passkey-list"><div class="muted">Loading passkeys…</div></div>
        <div style="margin-top:var(--sp-4)">
          <button type="button" class="btn-primary passkey-register-btn" id="passkey-register-btn">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-2px;margin-right:4px"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
            Add passkey
          </button>
        </div>
        <div id="passkey-msg" style="margin-top:var(--sp-2)"></div>
      </section>
      ` : ""}

    `;
  } else if (page === "notifications") {
    if (state.cache.notifPrefs === null) {
      pageHtml = `<section class="card"><div class="muted">Loading preferences…</div></section>`;
    } else {
    const prefs = state.cache.notifPrefs || {};
    const def = (key, fallback = true) => prefs[key] === undefined ? fallback : prefs[key];
    const toggle = (key, label, hint = "", defaultVal = true) => `
      <div class="notif-toggle-row">
        <div class="notif-toggle-info">
          <span class="notif-toggle-label">${label}</span>
          ${hint ? `<span class="notif-toggle-hint">${hint}</span>` : ""}
        </div>
        <label class="notif-switch">
          <input type="checkbox" class="notif-pref-check" data-pref="${key}" ${def(key, defaultVal) ? "checked" : ""} />
          <span class="notif-switch-track"><span class="notif-switch-thumb"></span></span>
        </label>
      </div>
    `;

    // ── Notification Channels section (moved from My Profile) ──────────────
    const integrations = state.cache.myIntegrations;
    const lineLoginAvailable    = (integrations || []).find(i => i.provider === "LINE")?.lineLoginEnabled === true;
    const msTeamsConnectEnabled = (integrations || []).find(i => i.provider === "MS_TEAMS")?.msTeamsConnectEnabled === true;
    const slackConnectEnabled   = (integrations || []).find(i => i.provider === "SLACK")?.slackConnectEnabled === true;
    const channelProviders = [
      {
        provider: "LINE", label: "LINE", ic: "chat",
        hint: "Enter your LINE User ID (get it from your admin or by messaging the LINE OA)",
        placeholder: "e.g. U1a2b3c4d5e6f7890",
        helpHtml: `
          <p class="notif-help-steps" style="list-style:none;padding:0;margin:0 0 var(--sp-2)">
            ${icon('warning')} <strong>หมายเหตุ:</strong> LINE User ID นี้ <em>ไม่ใช่</em> LINE ID (ชื่อผู้ใช้) ที่เห็นในแอป<br>
            คือ Internal User ID ของ LINE Messaging API ขึ้นต้นด้วย <code>U</code> ตามด้วย 32 ตัวอักษร
          </p>
          <p style="font-size:0.83rem;font-weight:600;margin:0 0 4px">วิธีรับ User ID:</p>
          <ol class="notif-help-steps">
            <li>เพิ่ม <strong>LINE Official Account</strong> ของบริษัทเป็นเพื่อน (ขอ QR Code จาก Admin)</li>
            <li>ส่งข้อความใดก็ได้ไปที่ OA นั้น (เช่น พิมพ์ <code>id</code>)</li>
            <li>แจ้ง Admin เพื่อให้ Admin ดึง User ID ของคุณจาก LINE OA Manager แล้วนำมากรอกที่นี่</li>
          </ol>
          <p class="notif-help-example">ตัวอย่าง: <code>U1a2b3c4d5e6f7890abcd1234567890ab</code></p>`
      },
      {
        provider: "MS_TEAMS", label: "Microsoft Teams", ic: "square",
        hint: "Enter your Microsoft Teams user ID (Azure AD Object ID)",
        placeholder: "e.g. 8:orgid:xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx",
        helpHtml: `
          <ol class="notif-help-steps">
            <li>Open <strong>Microsoft Teams</strong> (desktop or web)</li>
            <li>Click on your <strong>profile picture</strong> in the top-right corner</li>
            <li>Select <strong>Settings → General</strong> and note your email</li>
            <li>Ask your <strong>IT administrator</strong> to look up your Azure AD <strong>Object ID</strong> for that email in the <a href="https://entra.microsoft.com" target="_blank" rel="noopener">Entra admin portal</a></li>
            <li>The ID will be in the format <code>xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx</code></li>
          </ol>
          <p class="notif-help-example">Example: <code>8:orgid:3f5a8b12-1c2d-4e5f-a6b7-89cdef012345</code></p>`
      },
      {
        provider: "SLACK", label: "Slack", ic: "briefcase",
        hint: "Enter your Slack member ID",
        placeholder: "e.g. U012AB3CD",
        helpHtml: `
          <ol class="notif-help-steps">
            <li>Open <strong>Slack</strong> in your browser or desktop app</li>
            <li>Click on your <strong>name or profile picture</strong> in any channel or conversation</li>
            <li>Select <strong>View full profile</strong></li>
            <li>Click the <strong>three-dot menu ⋮</strong> on the right side of your profile card</li>
            <li>Select <strong>Copy member ID</strong></li>
          </ol>
          <p class="notif-help-example">Example: <code>U012AB3CD</code></p>`
      }
    ];
    const integrationsByProvider = Object.fromEntries((integrations || []).map(i => [i.provider, i]));
    const channelsSection = integrations === undefined
      ? `<section class="card"><div class="muted" style="padding:var(--sp-2)">Loading notification channels…</div></section>`
      : `<section class="card">
          <h3 class="section-title">${icon('bell')} Notification Channels</h3>
          <p class="muted" style="margin-bottom:var(--sp-4);font-size:0.88rem">Connect a messaging app so the system can send you deal follow-up reminders and visit check-in alerts.</p>
          <div class="notif-channels-list">
            ${channelProviders.map(ch => {
              const info = integrationsByProvider[ch.provider];
              const connected = info?.status === "CONNECTED";
              return `
              <div class="notif-channel-card" data-provider="${ch.provider}">
                <div class="notif-channel-main">
                  <span class="notif-channel-icon">${icon(ch.ic, 18)}</span>
                  <div class="notif-channel-info">
                    <span class="notif-channel-name">
                      ${ch.label}
                      <button class="notif-channel-help-btn" data-provider="${ch.provider}" title="How to find your ${ch.label} ID">!</button>
                    </span>
                    ${connected
                      ? `<span class="notif-channel-id">${escHtml(info.externalUserId || "")}</span>`
                      : `<span class="notif-channel-status muted">Not connected</span>`}
                  </div>
                  <div class="notif-channel-actions">
                    ${connected
                      ? `<span class="chip chip-success" style="font-size:0.75rem">Connected</span>
                         ${ch.provider === "MS_TEAMS" ? `<button class="ghost small notif-teams-dm-test-btn" data-user-id="${state.user?.id}">Test DM</button>` : ""}
                         <button class="ghost small notif-channel-disconnect-btn" data-provider="${ch.provider}">Disconnect</button>`
                      : `<button class="ghost small notif-channel-connect-btn" data-provider="${ch.provider}">Connect</button>`}
                  </div>
                </div>
                <div class="notif-channel-help-panel" id="notif-help-${ch.provider}" hidden>
                  <p class="notif-help-title">วิธีหา ${ch.label} ID ของคุณ</p>
                  ${ch.helpHtml}
                </div>
                <div class="notif-channel-connect-form" id="notif-connect-form-${ch.provider}" style="display:none">
                  ${ch.provider === "LINE" && lineLoginAvailable ? `
                  <p class="muted" style="font-size:0.8rem;margin-bottom:var(--sp-2)">เข้าสู่ระบบด้วย LINE เพื่อให้ระบบดึง User ID ของคุณโดยอัตโนมัติ</p>
                  <a class="line-login-btn" href="/api/v1/auth/oauth/line-connect?token=${encodeURIComponent(state.token)}">
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M19.365 9.89c.50 0 .866.37.866.87s-.366.87-.866.87H17.24v1.11h2.124c.50 0 .866.37.866.87s-.366.87-.866.87h-2.99c-.50 0-.866-.37-.866-.87V8.76c0-.50.366-.87.866-.87h2.99c.50 0 .866.37.866.87s-.366.87-.866.87H17.24v1.13h2.124zm-5.24 3.72c0 .38-.22.73-.56.89a.87.87 0 0 1-.96-.17l-2.56-3.5v2.78c0 .50-.37.87-.87.87s-.87-.37-.87-.87V8.76c0-.38.22-.73.56-.89.34-.16.73-.09.96.17l2.56 3.5V8.76c0-.50.37-.87.87-.87s.87.37.87.87v4.85zm-6.27.87c-.50 0-.87-.37-.87-.87V8.76c0-.50.37-.87.87-.87s.87.37.87.87v4.85c0 .50-.37.87-.87.87zm-2.13 0H3.73c-.50 0-.87-.37-.87-.87V8.76c0-.50.37-.87.87-.87s.87.37.87.87v3.98h1.12c.50 0 .87.37.87.87s-.37.87-.87.87zM12 2C6.48 2 2 6.03 2 11c0 3.53 2.18 6.59 5.41 8.29-.19.69-.72 2.51-.82 2.9-.13.47.17.46.36.34.15-.09 2.39-1.59 3.36-2.24.54.08 1.1.11 1.69.11 5.52 0 10-4.03 10-9S17.52 2 12 2z"/></svg>
                    Login with LINE
                  </a>
                  <button class="ghost small notif-channel-cancel-btn" data-provider="${ch.provider}" style="margin-top:var(--sp-1)">Cancel</button>
                  ` : ch.provider === "MS_TEAMS" && msTeamsConnectEnabled ? `
                  <p class="muted" style="font-size:0.8rem;margin-bottom:var(--sp-2)">Sign in with Microsoft to automatically fill in your Teams User ID.</p>
                  <a class="ms-connect-btn" href="/api/v1/auth/oauth/ms-teams-connect?token=${encodeURIComponent(state.token)}">
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M11.5 2a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5zM21 6.5a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3zM8 9a3 3 0 0 0-3 3v5h2v-5a1 1 0 0 1 1-1h7a1 1 0 0 1 1 1v5h2v-5a3 3 0 0 0-3-3H8zm11.5 1.5v1.75a4 4 0 0 1 1.5-.25V10.5h-1.5zM4 17v2h14v-2H4z"/></svg>
                    Connect with Microsoft Teams
                  </a>
                  <button class="ghost small notif-channel-cancel-btn" data-provider="${ch.provider}" style="margin-top:var(--sp-1)">Cancel</button>
                  ` : ch.provider === "SLACK" && slackConnectEnabled ? `
                  <p class="muted" style="font-size:0.8rem;margin-bottom:var(--sp-2)">Sign in with Slack to automatically fill in your member ID.</p>
                  <a class="slack-connect-btn" href="/api/v1/auth/oauth/slack-connect?token=${encodeURIComponent(state.token)}">
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M6 15a2 2 0 0 1-2 2 2 2 0 0 1-2-2 2 2 0 0 1 2-2h2v2zm1 0a2 2 0 0 1 2-2 2 2 0 0 1 2 2v5a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-5zM9 6a2 2 0 0 1-2-2 2 2 0 0 1 2-2 2 2 0 0 1 2 2v2H9zm0 1a2 2 0 0 1 2 2 2 2 0 0 1-2 2H4a2 2 0 0 1-2-2 2 2 0 0 1 2-2h5zm9 2a2 2 0 0 1 2-2 2 2 0 0 1 2 2 2 2 0 0 1-2 2h-2V9zm-1 0a2 2 0 0 1-2 2 2 2 0 0 1-2-2V4a2 2 0 0 1 2-2 2 2 0 0 1 2 2v5zm-2 9a2 2 0 0 1 2 2 2 2 0 0 1-2 2 2 2 0 0 1-2-2v-2h2zm0-1a2 2 0 0 1-2-2 2 2 0 0 1 2-2h5a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-5z"/></svg>
                    Connect with Slack
                  </a>
                  <button class="ghost small notif-channel-cancel-btn" data-provider="${ch.provider}" style="margin-top:var(--sp-1)">Cancel</button>
                  ` : `
                  <p class="muted" style="font-size:0.8rem;margin-bottom:var(--sp-2)">${ch.hint}</p>
                  <div style="display:flex;gap:var(--sp-2);align-items:flex-end">
                    <label class="form-label" style="flex:1;margin:0">
                      User ID
                      <input class="form-input notif-channel-id-input" style="margin-top:4px" placeholder="${ch.placeholder}" data-provider="${ch.provider}" />
                    </label>
                    <button class="btn-primary small notif-channel-save-btn" data-provider="${ch.provider}" data-alias="${ch.provider.toLowerCase().replace('_', '')}">Save</button>
                    <button class="ghost small notif-channel-cancel-btn" data-provider="${ch.provider}">Cancel</button>
                  </div>`}
                </div>
              </div>`;
            }).join("")}
          </div>
        </section>`;

    const hasChannel = (integrations || []).some(i => i.status === "CONNECTED");
    const channelWarning = !hasChannel && integrations !== undefined ? `
      <div class="notif-channel-warning">
        <span>${icon('warning')} No notification channel connected. Connect one below to receive alerts.</span>
      </div>` : "";
    const isGroupRole = ["ADMIN", "DIRECTOR", "MANAGER", "SUPERVISOR"].includes(state.user?.role);
    pageHtml = `
      ${channelsSection}
      ${channelWarning}
      <section class="card">
        <h3 class="section-title">${icon('user')} Personal Notifications</h3>
        <p class="muted" style="font-size:0.85rem;margin-bottom:var(--sp-3)">Sent directly to you via your connected channel.</p>
        <div class="notif-group">
          ${toggle("dealFollowUp", "Follow-up deal reminder",   "Remind me before a deal follow-up date is due")}
          ${toggle("visitRemind",  "Check-in reminder",         "Remind me when I have a visit scheduled for check-in")}
          ${toggle("kpiAlert",     `${icon('target')} KPI Alert`,             "แจ้งเตือนประจำวัน 5 วันสุดท้ายของเดือน หากคืบหน้าต่ำกว่า 85% (ส่งส่วนตัว หรือกลุ่มหากไม่มีช่องส่วนตัว)")}
          ${toggle("weeklyDigest", `${icon('chart')} Weekly Digest`,          "สรุปผลงานทุกวันจันทร์ 06:00 น. ส่งเข้าช่องกลุ่มของทีม")}
        </div>
      </section>

      ${isGroupRole ? `
      <section class="card">
        <h3 class="section-title">${icon('users')} Group Notifications</h3>
        <p class="muted" style="font-size:0.85rem;margin-bottom:var(--sp-3)">Sent to you when members of your team perform these actions.</p>
        <div class="notif-group">
          ${toggle("repCheckin",  "Rep checked in",   "When a sales rep checks in at a customer site")}
          ${toggle("repCheckout", "Rep checked out",  "When a sales rep completes a visit")}
          ${toggle("repDealWon",  "Deal moved to WIN","When a sales rep marks a deal as won")}
          ${toggle("repDealLost", "Deal moved to LOST","When a sales rep marks a deal as lost")}
        </div>
      </section>` : ""}

      <div class="notif-save-bar">
        <span id="notif-save-status" class="notif-save-status"></span>
        <button id="notif-save-btn" class="btn-primary">Save Preferences</button>
      </div>
    `;
    } // end else (prefs loaded)
  } else if (page === "company") {
    const csec = (title, body) => `
      <section class="card settings-collapsible" data-collapsed="true">
        <button type="button" class="settings-section-toggle">
          <span class="section-title">${title}</span>
          <svg class="settings-collapse-icon" width="16" height="16" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="6 9 12 15 18 9"/></svg>
        </button>
        <div class="settings-section-body">${body}</div>
      </section>`;

    pageHtml = `
      ${csec("Company Information", `
        <form id="company-form" class="settings-form">
          <div class="settings-field-row">
            <label class="form-label">Company Name
              <input class="form-input" name="name" value="${tenantInfo.name || ""}" placeholder="Company name" required />
            </label>
            <label class="form-label">Workspace Slug
              <input class="form-input" value="${tenantInfo.slug || ""}" disabled />
              <span class="form-hint">Slug cannot be changed after setup.</span>
            </label>
          </div>
          ${isAdmin ? `<button type="submit">Save Company Info</button>` : `<div class="muted">Admin access required to edit.</div>`}
        </form>
      `)}

      ${csec("Regional Settings", `
        <form id="currency-form" class="settings-form">
          <label class="form-label" style="max-width:300px">Currency
            <select class="form-input" name="currency" style="text-transform:none;letter-spacing:0;font-weight:400">
              ${CURRENCIES.map((c) => `<option value="${c.code}" ${getActiveCurrency() === c.code ? "selected" : ""}>${c.label}</option>`).join("")}
            </select>
          </label>
          <button type="submit">Save Currency</button>
        </form>
        <p class="muted" style="margin:var(--sp-2) 0 0;font-size:0.8rem">Affects all money fields across Deals, Dashboard, KPI, and Visits.</p>
        ${isAdmin ? `
        <form id="timezone-form" class="settings-form" style="margin-top:var(--sp-4)">
          <label class="form-label" style="max-width:340px">Tenant Timezone
            <select class="form-input" name="timezone" style="text-transform:none;letter-spacing:0;font-weight:400">
              ${[
                ["Pacific/Midway","-11:00 Midway Island"],["Pacific/Honolulu","-10:00 Hawaii"],["America/Anchorage","-09:00 Alaska"],
                ["America/Los_Angeles","-08:00 Pacific Time (US)"],["America/Denver","-07:00 Mountain Time (US)"],
                ["America/Chicago","-06:00 Central Time (US)"],["America/New_York","-05:00 Eastern Time (US)"],
                ["America/Bogota","-05:00 Bogota, Lima"],["America/Caracas","-04:30 Caracas"],
                ["America/Halifax","-04:00 Atlantic Time (Canada)"],["America/Sao_Paulo","-03:00 Brasilia"],
                ["Atlantic/Azores","-01:00 Azores"],["UTC","±00:00 UTC"],["Europe/London","+00:00 London, Dublin"],
                ["Europe/Paris","+01:00 Paris, Madrid, Rome"],["Europe/Helsinki","+02:00 Helsinki, Kiev"],
                ["Europe/Moscow","+03:00 Moscow"],["Asia/Tehran","+03:30 Tehran"],
                ["Asia/Dubai","+04:00 Dubai, Abu Dhabi"],["Asia/Kabul","+04:30 Kabul"],
                ["Asia/Karachi","+05:00 Karachi, Islamabad"],["Asia/Kolkata","+05:30 Mumbai, Kolkata"],
                ["Asia/Kathmandu","+05:45 Kathmandu"],["Asia/Dhaka","+06:00 Dhaka"],
                ["Asia/Rangoon","+06:30 Yangon"],["Asia/Bangkok","+07:00 Bangkok, Hanoi, Jakarta"],
                ["Asia/Ho_Chi_Minh","+07:00 Ho Chi Minh City"],["Asia/Singapore","+08:00 Singapore, Kuala Lumpur"],
                ["Asia/Shanghai","+08:00 Beijing, Shanghai"],["Asia/Taipei","+08:00 Taipei"],
                ["Asia/Manila","+08:00 Manila"],["Asia/Seoul","+09:00 Seoul"],
                ["Asia/Tokyo","+09:00 Tokyo, Osaka"],["Australia/Adelaide","+09:30 Adelaide"],
                ["Australia/Sydney","+10:00 Sydney, Melbourne"],["Pacific/Noumea","+11:00 New Caledonia"],
                ["Pacific/Auckland","+12:00 Auckland"]
              ].map(([tz, label]) => `<option value="${tz}" ${(tenantInfo.timezone || "Asia/Bangkok") === tz ? "selected" : ""}>${label}</option>`).join("")}
            </select>
            <span class="form-hint">Applied to all date/time calculations across the tenant.</span>
          </label>
          <button type="submit">Save Timezone</button>
        </form>
        ` : `<p class="muted" style="margin-top:var(--sp-4)">Timezone: <strong>${tenantInfo.timezone || "Asia/Bangkok"}</strong></p>`}
      `)}

      ${csec("Tax Configuration", isAdmin ? `
        <form id="tax-form" class="settings-form">
          <label class="settings-checkbox-label">
            <input name="vatEnabled" type="checkbox" ${tax.vatEnabled ? "checked" : ""} />
            VAT Enabled
          </label>
          <label class="form-label" style="max-width:200px">VAT Rate (%)
            <input class="form-input" name="vatRatePercent" type="number" min="0" step="0.01" value="${tax.vatRatePercent}" required />
          </label>
          <button type="submit">Save Tax Config</button>
        </form>
      ` : `<div class="muted">Admin access required.</div>`)}

      ${csec("Visit Check-in Settings", isAdmin ? `
        <form id="visit-config-form" class="settings-form">
          <label class="form-label" style="max-width:260px">Max check-in distance (metres)
            <input class="form-input" name="checkInMaxDistanceM" type="number" min="100" max="100000" step="100"
              value="${visitCfg.checkInMaxDistanceM}" required />
            <span class="form-hint">How close the rep must be to the visit location to check in. Default: 1000 m.</span>
          </label>
          <label class="form-label" style="max-width:260px">Minimum visit duration (minutes)
            <input class="form-input" name="minVisitDurationMinutes" type="number" min="1" max="480" step="1"
              value="${visitCfg.minVisitDurationMinutes ?? 15}" required />
            <span class="form-hint">Visits shorter than this are highlighted in red on the visit detail. Default: 15 min.</span>
          </label>
          <button type="submit">Save Visit Settings</button>
        </form>
      ` : `<div class="muted">Admin access required.</div>`)}

      ${(function() {
        const sub = state.user?.subscription;
        if (!sub || !isAdmin) return "";
        const isTrialing = sub.status === "TRIALING";
        const daysLeft = sub.trialEndsAt
          ? Math.max(0, Math.ceil((new Date(sub.trialEndsAt) - Date.now()) / 86400000))
          : null;
        const trialEndDate = sub.trialEndsAt
          ? new Date(sub.trialEndsAt).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" })
          : "—";
        const statusBadge = {
          TRIALING:  `<span class="badge badge--warning">Trial</span>`,
          ACTIVE:    `<span class="badge badge--success">Active</span>`,
          PAST_DUE:  `<span class="badge badge--danger">Past Due</span>`,
          CANCELED:  `<span class="badge badge--danger">Canceled</span>`,
        }[sub.status] ?? `<span class="badge">${escHtml(sub.status)}</span>`;

        return csec("Subscription & Trial", `
          <div class="settings-form">
            <div class="settings-field-row" style="gap:var(--sp-6);flex-wrap:wrap">
              <div><span class="form-label" style="margin:0">Status</span><div style="margin-top:var(--sp-1)">${statusBadge}</div></div>
              <div><span class="form-label" style="margin:0">Seats</span><div style="margin-top:var(--sp-1);font-weight:600">${sub.seatCount}</div></div>
              ${isTrialing ? `<div><span class="form-label" style="margin:0">Trial ends</span><div style="margin-top:var(--sp-1);font-weight:600">${escHtml(trialEndDate)} ${daysLeft !== null ? `<span class="muted">(${daysLeft}d left)</span>` : ""}</div></div>` : ""}
            </div>
            ${isTrialing ? `
            <div style="margin-top:var(--sp-5);border-top:1px solid var(--border);padding-top:var(--sp-4)">
              <p class="form-label" style="margin:0 0 var(--sp-2)">Extend trial</p>
              <p style="font-size:0.83rem;color:var(--muted-color);margin:0 0 var(--sp-3)">Add days to the trial period (e.g. for ongoing negotiations). Max 90 days per extension, 180 days from today total.</p>
              <form id="extend-trial-form" style="display:flex;align-items:center;gap:var(--sp-3);flex-wrap:wrap">
                <input class="form-input" id="extend-trial-days" name="days" type="number" min="1" max="90" step="1" value="14" style="width:100px" required />
                <button type="submit">Extend trial</button>
              </form>
              <p id="extend-trial-msg" style="margin:var(--sp-2) 0 0;font-size:0.83rem;min-height:1.2em"></p>
            </div>
            ` : ""}
            ${!isTrialing && sub.status !== "ACTIVE" ? `
            <p style="margin-top:var(--sp-3);font-size:0.83rem;color:var(--muted-color)">To reactivate, please contact support or complete a new subscription checkout.</p>
            ` : ""}
          </div>
        `);
      })()}
    `;
  } else if (page === "branding") {
    pageHtml = `
      <section class="card">
        <h3 class="section-title">${icon('palette')} Logo &amp; Colors</h3>
        ${isAdmin ? `
        <form id="branding-form" class="settings-form">
          <div class="brand-assets-row">
            <div class="brand-asset-col">
              <p class="form-label" style="margin-bottom:var(--sp-2)">Company Logo</p>
              <div class="logo-upload-area" id="logo-upload-area">
                <img src="${branding.logoUrl || "/default-brand.svg"}" class="logo-upload-preview" id="logo-preview" alt="Current logo" />
                <span class="logo-upload-change-hint">${branding.logoUrl ? "Click to change" : "Default · click to upload"}</span>
                <input type="file" name="logoFile" id="logo-file-input" accept="image/*" class="logo-file-input" />
              </div>
            </div>
            <div class="brand-asset-col brand-asset-col--favicon">
              <p class="form-label" style="margin-bottom:var(--sp-2)">Favicon</p>
              <div class="logo-upload-area favicon-upload-area" id="favicon-upload-area">
                <img src="${branding.faviconUrl || "/default-brand.svg"}" class="favicon-upload-preview" id="favicon-preview" alt="Current favicon" />
                <span class="logo-upload-change-hint">${branding.faviconUrl ? "Click to change" : "Default · click to upload"}</span>
                <input type="file" name="faviconFile" id="favicon-file-input" accept="image/png,image/x-icon,image/svg+xml,image/jpeg" class="logo-file-input" />
              </div>
            </div>
          </div>
          <div class="settings-field-row">
            <label class="form-label" style="flex:1">App Name
              <input class="form-input" name="appName" placeholder="ThinkCRM" value="${branding.appName || ""}" maxlength="64" style="margin-top:var(--sp-1)" />
              <span class="muted" style="font-size:0.78rem">Displayed next to the logo in the sidebar. Leave blank to use the default.</span>
            </label>
          </div>
          <div class="theme-editor">
            <div class="theme-preset-picker">
              <label class="theme-editor-label">Theme</label>
              <div class="theme-preset-trigger" data-role="preset-trigger">
                <span class="theme-preset-swatches" data-role="preset-swatches">
                  ${(findPresetBySlug(activePresetSlug)?.swatches || [brandingTokens.background, branding.secondaryColor || "#0f172a", branding.primaryColor || "#7c3aed"])
                    .map((c) => `<span style="background:${escHtml(c)}"></span>`).join("")}
                </span>
                <span class="theme-preset-name" data-role="preset-name">${escHtml(findPresetBySlug(activePresetSlug)?.name || "Custom Theme")}</span>
                ${icon("chevronDown", 14, "theme-preset-chevron")}
                <select class="theme-preset-select" name="themePreset" aria-label="Theme preset">
                  <option value="custom"${activePresetSlug === "custom" ? " selected" : ""}>Custom Theme</option>
                  ${PRESETS.map((p) => `<option value="${p.slug}"${activePresetSlug === p.slug ? " selected" : ""}>${escHtml(p.name)}</option>`).join("")}
                </select>
              </div>
            </div>

            <div class="theme-editor-label">Colors</div>

            <details class="theme-group" open>
              <summary class="theme-group-summary">
                <span class="theme-group-swatches">
                  <span style="background:${escHtml(brandingTokens.background)}"></span>
                  <span style="background:${escHtml(brandingTokens.text)}"></span>
                  <span style="background:${escHtml(branding.primaryColor || "#7c3aed")}"></span>
                </span>
                <span class="theme-group-title">Primary</span>
                ${icon("chevronDown", 14, "theme-group-chevron")}
              </summary>
              ${renderThemeRow("Background", "tokenBackground", brandingTokens.background)}
              ${renderThemeRow("Text", "tokenText", brandingTokens.text)}
              ${renderThemeRow("Primary", "primaryColor", branding.primaryColor || "#7c3aed", { required: true })}
            </details>

            <details class="theme-group" open>
              <summary class="theme-group-summary">
                <span class="theme-group-swatches">
                  <span style="background:${escHtml(branding.secondaryColor || "#0f172a")}"></span>
                  <span style="background:${escHtml(brandingTokens.accent)}"></span>
                </span>
                <span class="theme-group-title">Secondary</span>
                ${icon("chevronDown", 14, "theme-group-chevron")}
              </summary>
              ${renderThemeRow("Secondary", "secondaryColor", branding.secondaryColor || "#0f172a", { required: true })}
              ${renderThemeRow("Accent", "tokenAccent", brandingTokens.accent)}
            </details>

            <details class="theme-group">
              <summary class="theme-group-summary">
                <span class="theme-group-swatches">
                  <span style="background:${escHtml(brandingTokens.card)}"></span>
                  <span style="background:${escHtml(brandingTokens.border)}"></span>
                </span>
                <span class="theme-group-title">Advanced</span>
                ${icon("chevronDown", 14, "theme-group-chevron")}
              </summary>
              ${renderThemeRow("Card", "tokenCard", brandingTokens.card)}
              ${renderThemeRow("Muted", "tokenMuted", brandingTokens.muted)}
              ${renderThemeRow("Border", "tokenBorder", brandingTokens.border)}
              ${renderThemeRow("Destructive", "tokenDestructive", brandingTokens.destructive)}
            </details>

            <div class="theme-radius">
              <label class="theme-editor-label">Radius</label>
              <div class="theme-radius-controls">
                <input type="range" name="tokenRadiusRange" min="0" max="24" step="1" value="${brandingTokens.radius}" />
                <input type="number" name="tokenRadius" min="0" max="32" step="1" value="${brandingTokens.radius}" class="form-input theme-radius-number" />
                <span class="muted">px</span>
              </div>
            </div>

            <div class="theme-shadow">
              <label class="theme-editor-label">Shadow</label>
              <select class="form-input theme-shadow-select" name="tokenShadow">
                <option value="NONE"${brandingTokens.shadow === "NONE" ? " selected" : ""}>None</option>
                <option value="SM"${brandingTokens.shadow === "SM" ? " selected" : ""}>Small</option>
                <option value="MD"${brandingTokens.shadow === "MD" ? " selected" : ""}>Medium</option>
                <option value="LG"${brandingTokens.shadow === "LG" ? " selected" : ""}>Large</option>
                <option value="XL"${brandingTokens.shadow === "XL" ? " selected" : ""}>Extra Large</option>
              </select>
            </div>
          </div>
          <div class="gradient-section">
            <div class="accent-mode-row">
              <label class="theme-editor-label">Accent Style</label>
              <div class="segmented" role="tablist" aria-label="Accent style">
                <button type="button" class="segmented-item" role="tab" data-value="false" aria-selected="${!branding.accentGradientEnabled}">Solid</button>
                <button type="button" class="segmented-item" role="tab" data-value="true" aria-selected="${!!branding.accentGradientEnabled}">Gradient</button>
              </div>
              <input type="hidden" name="accentGradientEnabled" value="${branding.accentGradientEnabled ? "true" : "false"}" />
              <span class="muted" style="font-size:0.78rem">Gradient blends primary into a second color on buttons, login hero, and KPI highlights.</span>
            </div>
            <div class="gradient-controls" ${branding.accentGradientEnabled ? "" : 'style="display:none"'}>
              <div class="settings-field-row">
                <label class="form-label">Gradient End Color
                  <div class="color-input-row">
                    <input type="color" name="accentGradientColorPicker" value="${branding.accentGradientColor || "#ec4899"}" class="color-swatch" />
                    <input class="form-input" name="accentGradientColor" placeholder="#ec4899" value="${branding.accentGradientColor || "#ec4899"}" style="flex:1" />
                  </div>
                </label>
                <label class="form-label">Angle
                  <div class="color-input-row">
                    <input type="range" name="accentGradientAngleRange" min="0" max="360" step="5" value="${branding.accentGradientAngle ?? 135}" style="flex:1" />
                    <input type="number" name="accentGradientAngle" min="0" max="360" step="5" value="${branding.accentGradientAngle ?? 135}" class="form-input" style="width:70px" />
                    <span class="muted" style="font-size:0.78rem">°</span>
                  </div>
                </label>
              </div>
              <div class="gradient-preview" aria-label="Gradient preview">
                <div class="gradient-preview-swatch" id="gradient-preview-swatch"
                     style="background:linear-gradient(${branding.accentGradientAngle ?? 135}deg, ${branding.primaryColor || "#7c3aed"}, ${branding.accentGradientColor || "#ec4899"})">
                  <span>Preview</span>
                </div>
              </div>
            </div>
          </div>
          <div class="settings-field-row">
            <label class="form-label">Default Theme
              <select class="form-input" name="themeMode" style="margin-top:var(--sp-1)">
                <option value="LIGHT"${(branding.themeMode || "LIGHT") === "LIGHT" ? ' selected' : ''}>Light</option>
                <option value="DARK"${branding.themeMode === "DARK" ? ' selected' : ''}>Dark</option>
              </select>
              <span class="muted" style="font-size:0.78rem">Tenant-wide default. Users can override with the theme toggle.</span>
            </label>
          </div>
          <details class="theme-group" style="margin-top:var(--sp-4)">
            <summary class="theme-editor-label" style="cursor:pointer">Login Screen</summary>
            <p class="muted" style="font-size:0.82rem;margin:var(--sp-2) 0 var(--sp-3)">Customize what users see at your sign-in page.</p>
            <div class="brand-asset-col" style="max-width:280px;margin-bottom:var(--sp-4)">
              <p class="form-label" style="margin-bottom:var(--sp-2)">Login Hero Image</p>
              <div class="logo-upload-area" id="login-hero-upload-area">
                <img src="${branding.loginHeroImageUrl || "/default-brand.svg"}" class="logo-upload-preview" id="login-hero-preview" alt="Login hero preview" />
                <span class="logo-upload-change-hint">${branding.loginHeroImageUrl ? "Click to change" : "Optional · click to upload"}</span>
                <input type="file" name="loginHeroFile" id="login-hero-file-input" accept="image/*" class="logo-file-input" />
              </div>
              <span class="muted" style="font-size:0.78rem">Used as the background on the left hero panel. A dark overlay is applied for readability.</span>
            </div>
            <div class="settings-field-row">
              <label class="form-label" style="flex:1">Tagline Headline
                <input class="form-input" name="loginTaglineHeadline" maxlength="120" placeholder="Sales intelligence." value="${escHtml(branding.loginTaglineHeadline || "")}" style="margin-top:var(--sp-1)" />
              </label>
              <label class="form-label" style="flex:1">Tagline Subtext
                <input class="form-input" name="loginTaglineSubtext" maxlength="160" placeholder="Field-first." value="${escHtml(branding.loginTaglineSubtext || "")}" style="margin-top:var(--sp-1)" />
              </label>
            </div>
            <div class="settings-field-row">
              <label class="form-label" style="flex:1">Welcome Message (above the form)
                <input class="form-input" name="loginWelcomeMessage" maxlength="200" placeholder="Welcome to your portal" value="${escHtml(branding.loginWelcomeMessage || "")}" style="margin-top:var(--sp-1)" />
              </label>
            </div>
            <div class="settings-field-row">
              <label class="form-label" style="flex:1">Footer Text
                <input class="form-input" name="loginFooterText" maxlength="200" placeholder="© 2026 Acme Co. All rights reserved." value="${escHtml(branding.loginFooterText || "")}" style="margin-top:var(--sp-1)" />
              </label>
            </div>
            <div class="settings-field-row">
              <label class="form-label" style="flex:1">Terms URL
                <input class="form-input" name="loginTermsUrl" type="url" maxlength="300" placeholder="https://acme.com/terms" value="${escHtml(branding.loginTermsUrl || "")}" style="margin-top:var(--sp-1)" />
              </label>
              <label class="form-label" style="flex:1">Privacy URL
                <input class="form-input" name="loginPrivacyUrl" type="url" maxlength="300" placeholder="https://acme.com/privacy" value="${escHtml(branding.loginPrivacyUrl || "")}" style="margin-top:var(--sp-1)" />
              </label>
              <label class="form-label" style="flex:1">Support Email
                <input class="form-input" name="loginSupportEmail" type="email" maxlength="200" placeholder="support@acme.com" value="${escHtml(branding.loginSupportEmail || "")}" style="margin-top:var(--sp-1)" />
              </label>
            </div>
            <div class="settings-field-row" style="flex-direction:column;gap:var(--sp-2);align-items:flex-start">
              <span class="form-label">Visible Sign-in Options</span>
              <label class="form-label" style="flex-direction:row;align-items:center;gap:var(--sp-2)"><input type="checkbox" name="loginShowSignup" ${branding.loginShowSignup !== false ? "checked" : ""} /> Show "Create a new workspace" link</label>
              <label class="form-label" style="flex-direction:row;align-items:center;gap:var(--sp-2)"><input type="checkbox" name="loginShowGoogle" ${branding.loginShowGoogle !== false ? "checked" : ""} /> Show Google sign-in</label>
              <label class="form-label" style="flex-direction:row;align-items:center;gap:var(--sp-2)"><input type="checkbox" name="loginShowMicrosoft" ${branding.loginShowMicrosoft !== false ? "checked" : ""} /> Show Microsoft 365 sign-in</label>
              <label class="form-label" style="flex-direction:row;align-items:center;gap:var(--sp-2)"><input type="checkbox" name="loginShowPasskey" ${branding.loginShowPasskey !== false ? "checked" : ""} /> Show Passkey sign-in</label>
            </div>
          </details>
          <div style="display:flex;gap:var(--sp-2);align-items:center;flex-wrap:wrap">
            <button type="submit">Save Branding</button>
            <button type="button" id="branding-restore-default" class="ghost">Restore to Default</button>
          </div>
        </form>
        ` : `<div class="muted">Admin access required.</div>`}
      </section>

    `;
  } else if (page === "team-structure") {
    const roleColorCls = { DIRECTOR: "org-role--director", MANAGER: "org-role--manager", SUPERVISOR: "org-role--supervisor", REP: "org-role--rep" };

    function orgNode(m) {
      const hasPhoto = !!m.avatarUrl;
      return `<div class="org-node">
        <div class="org-avatar" style="${hasPhoto ? "overflow:hidden" : "background:" + avatarColor(m.fullName || "")}">${repAvatarHtml(m.fullName, m.avatarUrl)}</div>
        <div class="org-node-name">${escHtml(m.fullName || "—")}</div>
        <span class="org-node-role ${roleColorCls[m.role] || ""}">${m.role === "DIRECTOR" ? "Sales Director" : m.role}</span>
      </div>`;
    }

    function fanLevel(nodes) {
      if (nodes.length === 1) {
        return `<div class="org-connector-v"></div><div class="org-level">${orgNode(nodes[0])}</div>`;
      }
      return `
        <div class="org-connector-v"></div>
        <div class="org-reps-wrap">
          <div class="org-connector-h"></div>
          <div class="org-level org-level--reps">
            ${nodes.map(m => `<div class="org-rep-branch"><div class="org-connector-v org-connector-v--short"></div>${orgNode(m)}</div>`).join("")}
          </div>
        </div>`;
    }

    const channelTypeLabel = { LINE: "LINE", SLACK: "Slack", EMAIL: "Email", MS_TEAMS: "MS Teams" };
    const channelTypeIcon  = { LINE: icon('chat'), SLACK: icon('hash'), EMAIL: icon('mail'), MS_TEAMS: icon('square') };

    function buildTeamCol(team) {
      // Exclude ADMIN from org chart
      const members = (team.members || []).filter(m => m.role !== "ADMIN");
      const managers    = members.filter(m => m.role === "MANAGER");
      const supervisors = members.filter(m => m.role === "SUPERVISOR");
      const reps        = members.filter(m => m.role === "REP");

      const canManageNotif = isAdmin || isManager;
      const channels = team.channels || [];
      const channelsJson = encodeURIComponent(JSON.stringify(channels));

      const channelChips = channels.map(ch => `
        <div class="team-ch-chip${ch.isEnabled === false ? " team-ch-chip--disabled" : ""}">
          <span class="team-ch-chip-icon">${channelTypeIcon[ch.channelType] || "•"}</span>
          <span class="team-ch-chip-label">${channelTypeLabel[ch.channelType] || ch.channelType}</span>
          <span class="team-ch-chip-target">${escHtml(ch.channelTarget)}</span>
          ${canManageNotif ? `
            <button class="team-ch-toggle-btn" data-team-id="${team.id}" data-channel-type="${ch.channelType}" data-channel-target="${escHtml(ch.channelTarget)}" data-is-enabled="${ch.isEnabled !== false}" title="${ch.isEnabled !== false ? "Disable" : "Enable"} this channel">
              <span class="team-ch-toggle${ch.isEnabled !== false ? " team-ch-toggle--on" : ""}"></span>
            </button>
            <button class="team-ch-remove-btn" data-team-id="${team.id}" data-channel-type="${ch.channelType}" data-channel-target="${escHtml(ch.channelTarget)}" title="Remove">×</button>
          ` : ""}
        </div>`).join("");

      const notifSection = `
        <div class="team-notif-section" data-team-id="${team.id}" data-channels="${channelsJson}">
          <div class="team-notif-header">
            <span class="team-notif-title">Group Notifications</span>
            <div class="team-notif-actions">
              ${channels.length && canManageNotif ? `<button class="ghost small team-ch-test-btn" data-team-id="${team.id}">Test Connection</button>` : ""}
              ${canManageNotif ? `<button class="ghost small team-ch-add-btn" data-team-id="${team.id}">+ Add Channel</button>` : ""}
            </div>
          </div>
          <div class="team-ch-list">
            ${channels.length ? channelChips : `<span class="team-ch-empty">No channels configured</span>`}
          </div>
          <div class="team-ch-test-result" hidden></div>
          <div class="team-ch-form" hidden>
            <select class="team-ch-type-select form-input" style="font-size:0.78rem;padding:3px 6px">
              <option value="LINE">LINE Group</option>
              <option value="SLACK">Slack Channel</option>
              <option value="MS_TEAMS">Microsoft Teams</option>
              <option value="EMAIL">Email</option>
            </select>
            <input class="team-ch-target-input form-input" type="text" placeholder="Group ID / Webhook URL" style="font-size:0.78rem;padding:3px 6px" />
            <button class="ghost small team-ch-save-btn" data-team-id="${team.id}">Save</button>
            <button class="ghost small team-ch-cancel-btn">Cancel</button>
          </div>
        </div>`;

      return `<div class="org-team-col">
        <div class="org-team-header">
          <div class="org-team-title">
            <span class="org-team-name">${escHtml(team.teamName)}</span>
            <span class="chip ${team.isActive ? "chip-success" : ""}" style="font-size:0.7rem;padding:1px 6px">${team.isActive ? "Active" : "Inactive"}</span>
          </div>
          ${isAdmin ? `<div class="org-team-actions">
            <button class="ghost small team-rename-btn" data-team-id="${team.id}" data-team-name="${escHtml(team.teamName)}">Rename</button>
            <button class="ghost small team-toggle-btn" data-team-id="${team.id}" data-is-active="${team.isActive}">${team.isActive ? "Deactivate" : "Activate"}</button>
          </div>` : ""}
        </div>
        <div class="org-tree">
          ${!members.length ? `<div class="org-empty">No members yet</div>` : ""}
          ${managers.length    ? fanLevel(managers)    : ""}
          ${supervisors.length ? fanLevel(supervisors) : ""}
          ${reps.length        ? fanLevel(reps)        : ""}
        </div>
        ${notifSection}
      </div>`;
    }

    // Group teams by director
    const directorMap = new Map(); // directorId -> { director, teams[] }
    const noDirectorTeams = [];
    for (const team of teams) {
      if (team.director) {
        const key = team.director.id;
        if (!directorMap.has(key)) directorMap.set(key, { director: team.director, teams: [] });
        directorMap.get(key).teams.push(team);
      } else {
        noDirectorTeams.push(team);
      }
    }

    function buildDirectorGroup(director, dirTeams) {
      const teamsHtml = dirTeams.map(buildTeamCol).join("");
      const teamCount = dirTeams.length;
      const dirHasPhoto = !!director.avatarUrl;
      return `
        <div class="org-director-group">
          <div class="org-director-node">
            <div class="org-avatar org-avatar--director" style="${dirHasPhoto ? "overflow:hidden" : ""}">${repAvatarHtml(director.fullName, director.avatarUrl)}</div>
            <div class="org-node-name">${escHtml(director.fullName)}</div>
            <span class="org-node-role org-role--director">Sales Director</span>
          </div>
          <div class="org-connector-v"></div>
          ${teamCount > 1
            ? `<div class="org-reps-wrap" style="width:100%">
                <div class="org-connector-h"></div>
                <div class="org-director-teams">
                  ${dirTeams.map(t => `<div class="org-rep-branch"><div class="org-connector-v org-connector-v--short"></div>${buildTeamCol(t)}</div>`).join("")}
                </div>
              </div>`
            : `<div class="org-director-teams">${teamsHtml}</div>`}
        </div>`;
    }

    const directorGroupsHtml = [...directorMap.values()].map(({ director, teams: dt }) => buildDirectorGroup(director, dt)).join("");
    const noDirectorHtml = noDirectorTeams.map(buildTeamCol).join("");

    pageHtml = `
      <div class="section-head" style="margin-bottom:var(--sp-5)">
        <h3 class="section-title" style="margin:0">Organization Chart</h3>
        ${isAdmin ? `<button id="team-create-btn">+ Create Team</button>` : ""}
      </div>
      ${teams.length
        ? `<div class="org-chart-scroll"><div class="org-chart">${directorGroupsHtml}${noDirectorHtml}</div></div>`
        : `<div class="empty-state compact"><div class="empty-icon">${icon('users')}</div><div><strong>No teams yet</strong>${isAdmin ? `<p>Click "+ Create Team" to get started.</p>` : ""}</div></div>`}
    `;
  } else if (page === "roles") {
    const me = state.user;
    const roleLabel = { ADMIN: "Admin", DIRECTOR: "Sales Director", MANAGER: "Sales Manager", ASSISTANT_MANAGER: "Assistant Manager", SUPERVISOR: "Supervisor", SALES_ADMIN: "Sales Admin", REP: "Sales Rep" };
    const roleCls   = { ADMIN: "rp-badge--admin", DIRECTOR: "rp-badge--director", MANAGER: "rp-badge--manager", ASSISTANT_MANAGER: "rp-badge--manager", SUPERVISOR: "rp-badge--supervisor", SALES_ADMIN: "rp-badge--supervisor", REP: "rp-badge--rep" };
    const roleCounts = { ADMIN: 0, DIRECTOR: 0, MANAGER: 0, ASSISTANT_MANAGER: 0, SUPERVISOR: 0, SALES_ADMIN: 0, REP: 0 };
    for (const u of allUsers) if (u.role in roleCounts) roleCounts[u.role]++;

    // Build manager options for each role (Reports To).
    // Sales Rep can report to a Supervisor, or a Sales Manager if their team has no Supervisor.
    // Supervisor can report to a Sales Manager, or a Sales Director if their team has no Manager.
    // Sales Manager can report to a Sales Director.
    const directors   = allUsers.filter(u => u.role === "DIRECTOR");
    const managers    = allUsers.filter(u => u.role === "MANAGER");
    const supervisors = allUsers.filter(u => u.role === "SUPERVISOR");

    function reportsToPool(u) {
      if (u.role === "REP")               return [...supervisors, ...managers];
      if (u.role === "SALES_ADMIN")       return [...supervisors, ...managers];
      if (u.role === "SUPERVISOR")        return [...managers, ...directors];
      if (u.role === "ASSISTANT_MANAGER") return [...managers, ...directors];
      if (u.role === "MANAGER")           return directors;
      return [];
    }

    function reportsToOptions(u) {
      if (u.role === "ADMIN" || u.role === "DIRECTOR") return '<span class="rp-dash">—</span>';
      const pool = reportsToPool(u);
      if (!pool.length) return '<span class="rp-dash">—</span>';
      const cur = u.managerUserId || "";
      const opts = pool.map(m =>
        `<option value="${m.id}" ${m.id === cur ? "selected" : ""}>${escHtml(m.fullName)} · ${escHtml(roleLabel[m.role] || m.role)}</option>`
      ).join("");
      return `<select class="rp-select rp-reports-select" data-uid="${u.id}" ${!isAdmin ? "disabled" : ""}>
        <option value="">— unassigned —</option>
        ${opts}
      </select>`;
    }

    function roleOptions(u) {
      const isSelf = u.id === me?.id;
      if (isSelf) return `<span class="rp-locked">${roleLabel[u.role]}</span><span class="rp-locked-label">(locked)</span>`;
      return `<select class="rp-select rp-role-select" data-uid="${u.id}" data-current-role="${u.role}">
        ${Object.entries(roleLabel).map(([k, v]) =>
          `<option value="${k}" ${u.role === k ? "selected" : ""}>${v}</option>`
        ).join("")}
      </select>`;
    }

    pageHtml = `
      <!-- Collapsible top section -->
      <div class="rp-info-section ${state.roleInfoExpanded ? 'rp-info-expanded' : ''}">
        <button class="rp-info-toggle" id="rp-info-toggle" aria-expanded="${state.roleInfoExpanded ? 'true' : 'false'}">
          <svg class="rp-toggle-icon" width="14" height="14" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2.5"><polyline points="6 9 12 15 18 9"/></svg>
          <span>Role Hierarchy &amp; Permissions</span>
          <span class="rp-toggle-hint">${state.roleInfoExpanded ? 'Click to collapse' : 'Click to expand'}</span>
        </button>
        <div class="rp-info-body"><div class="rp-info-body-inner">
          <div class="rp-hierarchy-card">
            <div class="rp-hierarchy-head">
              <svg width="16" height="16" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><polyline points="23 6 13.5 15.5 8.5 10.5 1 18"/><polyline points="17 6 23 6 23 12"/></svg>
              <span class="rp-hierarchy-title">Role Hierarchy</span>
            </div>
            <div class="rp-hierarchy-flow">
              <span class="rp-badge rp-badge--admin">${icon('crown')} Admin</span>
              <span class="rp-arrow">→</span>
              <span class="rp-badge rp-badge--director">${icon('medal')} Sales Director</span>
              <span class="rp-arrow">→ (multiple)</span>
              <span class="rp-badge rp-badge--manager">${icon('building')} Sales Manager</span>
              <span class="rp-arrow">→ (multiple)</span>
              <span class="rp-badge rp-badge--supervisor">${icon('user')} Supervisor</span>
              <span class="rp-arrow">→ (multiple)</span>
              <span class="rp-badge rp-badge--rep">${icon('users')} Sales Rep</span>
            </div>
            <p class="rp-hierarchy-note">Use the <strong>Reports To</strong> column to chain each level. When a level is empty (e.g. Supervisor resigned), a Sales Rep may report directly to a Sales Manager, and a Supervisor may report directly to a Sales Director.</p>
          </div>
          <div class="rp-cards">
            <div class="rp-card">
              <div class="rp-card-head"><span class="rp-card-icon">${icon('crown')}</span><span class="rp-card-label">Admin</span><span class="rp-card-count">${roleCounts.ADMIN}</span></div>
              <p class="rp-card-desc">Full access: manage users, all data, reports</p>
            </div>
            <div class="rp-card">
              <div class="rp-card-head"><span class="rp-card-icon">${icon('medal')}</span><span class="rp-card-label">Sales Director</span><span class="rp-card-count">${roleCounts.DIRECTOR}</span></div>
              <p class="rp-card-desc">Oversees multiple Sales Managers</p>
            </div>
            <div class="rp-card">
              <div class="rp-card-head"><span class="rp-card-icon">${icon('building')}</span><span class="rp-card-label">Sales Manager</span><span class="rp-card-count">${roleCounts.MANAGER}</span></div>
              <p class="rp-card-desc">View all their Supervisors' and Reps' data</p>
            </div>
            <div class="rp-card">
              <div class="rp-card-head"><span class="rp-card-icon">${icon('user')}</span><span class="rp-card-label">Supervisor</span><span class="rp-card-count">${roleCounts.SUPERVISOR}</span></div>
              <p class="rp-card-desc">View their team data, reports, calendar</p>
            </div>
            <div class="rp-card">
              <div class="rp-card-head"><span class="rp-card-icon">${icon('users')}</span><span class="rp-card-label">Sales Rep</span><span class="rp-card-count">${roleCounts.REP}</span></div>
              <p class="rp-card-desc">Own visits and check-ins only</p>
            </div>
          </div>
        </div></div>
      </div>

      <!-- Search + count -->
      <div class="rp-search-bar">
        <div class="rp-search-wrap">
          <svg width="16" height="16" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
          <input id="rp-search" class="rp-search-input" type="text" placeholder="Search by name or email…" value="${escHtml(state.rolePageQuery || '')}">
        </div>
        <select id="rp-team-filter" class="rp-select rp-team-filter-select">
          <option value="">All Teams</option>
          ${(state.cache.teams || []).map(t => `<option value="${t.id}" ${state.rolePageTeam === t.id ? "selected" : ""}>${escHtml(t.teamName)}</option>`).join("")}
        </select>
        <button class="rp-refresh-btn" id="rp-refresh-btn">${icon('refresh')} Refresh</button>
        ${isAdmin ? `<button class="ghost small" id="rp-invite-btn">+ Invite User</button>
        <button class="ghost small" id="rp-import-btn">Import Users</button>
        <button class="ghost small" id="rp-import-history-btn">Import History</button>` : ""}
        <span class="rp-user-count">${allUsers.length} users</span>
      </div>

      <!-- Users table -->
      <div class="rp-table-card">
        <div class="rp-table-header">
          <svg width="16" height="16" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>
          <span class="rp-table-title">All Users</span>
        </div>
        <p class="rp-table-note muted small">Changes take effect immediately. Use the <strong>Reports To</strong> column to assign Sales Reps to a Supervisor, and Supervisors to a Sales Manager.</p>
        <div class="rp-table-scroll"><div class="rp-table">
          <div class="rp-thead">
            <span>User</span>
            <span>Team</span>
            <span>Current Role</span>
            <span>Reports To</span>
            <span>Change Role</span>
          </div>
          <div class="rp-tbody" id="rp-tbody">
            ${allUsers.filter(u => {
              const q = (state.rolePageQuery || "").toLowerCase();
              const matchesText = !q || u.fullName?.toLowerCase().includes(q) || u.email?.toLowerCase().includes(q);
              const matchesTeam = !state.rolePageTeam || String(u.teamId) === String(state.rolePageTeam);
              return matchesText && matchesTeam;
            }).map(u => {
              const isSelf = u.id === me?.id;
              const initials = (u.fullName || "?").split(" ").filter(Boolean).slice(0, 2).map(w => w[0].toUpperCase()).join("");
              const teamName = state.cache.teams?.find(t => t.id === u.teamId)?.teamName || "";
              const teamOpts = (state.cache.teams || [])
                .map(t => `<option value="${t.id}" ${t.id === u.teamId ? "selected" : ""}>${escHtml(t.teamName)}</option>`)
                .join("");
              const teamCell = isAdmin
                ? `<select class="rp-select rp-team-select" data-uid="${u.id}" data-current-team="${u.teamId || ""}">
                     <option value="">— no team —</option>
                     ${teamOpts}
                   </select>`
                : (teamName ? escHtml(teamName) : '<span class="rp-dash">—</span>');
              return `
              <div class="rp-row" data-uid="${u.id}">
                <div class="rp-user-cell">
                  <div class="rp-avatar" style="background:${avatarColor(u.fullName)}">${escHtml(initials)}</div>
                  <div class="rp-user-info">
                    <span class="rp-user-name">${escHtml(u.fullName || "—")}${isSelf ? '<span class="rp-you-badge">You</span>' : ""}</span>
                    <span class="rp-user-email">${escHtml(u.email)}</span>
                  </div>
                </div>
                <span class="rp-team-cell">${teamCell}</span>
                <span><span class="rp-badge ${roleCls[u.role] || ""}">${roleLabel[u.role] || u.role}</span></span>
                <span>${reportsToOptions(u)}</span>
                <span class="rp-role-change-cell">
                  ${roleOptions(u)}
                  ${isAdmin ? `<button type="button" class="passkey-admin-btn ghost small" data-uid="${u.id}" data-name="${escHtml(u.fullName)}" title="Manage passkeys">${icon('key')}</button>` : ""}
                </span>
              </div>`;
            }).join("")}
          </div>
        </div></div>
      </div>

      <div class="rp-role-guide">
        <h4 class="rp-role-guide-title">How roles work</h4>
        <ul class="rp-role-guide-list">
          <li><span class="rp-badge rp-badge--rep">Sales Rep</span> Default role. Can only view and manage their own visits, check-ins, and calendar. Reports to a Supervisor (or directly to a Sales Manager when no Supervisor is assigned).</li>
          <li><span class="rp-badge rp-badge--supervisor">Sales Admin</span> Junior support staff. Prepares paperwork and answers phone calls on behalf of Sales Rep / Supervisor / Manager / Director. Acts through delegation (see below); cannot approve.</li>
          <li><span class="rp-badge rp-badge--supervisor">Supervisor</span> Can view all their team's (assigned Sales Reps') data, filter calendar, and access reports. Reports to a Sales Manager (or directly to a Sales Director when no Manager is assigned).</li>
          <li><span class="rp-badge rp-badge--manager">Assistant Manager</span> A Sales Manager's secretary. Acts on behalf of one or more Managers and Directors through delegation; cannot approve.</li>
          <li><span class="rp-badge rp-badge--manager">Sales Manager</span> Can view data for all Supervisors assigned to them and all Sales Reps under those Supervisors. Reports to a Sales Director.</li>
          <li><span class="rp-badge rp-badge--director">Sales Director</span> Oversees multiple Sales Managers and all their downstream teams. Full visibility across their organisation branch.</li>
          <li><span class="rp-badge rp-badge--admin">Admin</span> Full access including this User Access Management page. Cannot remove their own Admin role.</li>
        </ul>
      </div>
      ${isAdmin ? renderDelegationsSection() : ""}
    `;
  } else if (page === "kpi-targets") {
    const canEditKpi = hasRole("ADMIN", "DIRECTOR", "MANAGER");
    pageHtml = `
      <section class="card">
        <h3 class="section-title">${icon('target')} Set KPI Target</h3>
        <p class="muted" style="margin-bottom:var(--sp-3)">Targets are set <strong>per person, per month</strong>. Each rep can have different targets each month.</p>
        ${canEditKpi ? `
          ${state.cache.salesReps.length ? `
          <form id="kpi-form" class="settings-form">
            <div class="settings-field-row">
              <label class="form-label">Sales Rep
                <select class="form-input" name="userId" required>${salesRepOptions}</select>
              </label>
              <label class="form-label">Month
                <input class="form-input" name="targetMonth" type="month" value="${new Date().toISOString().slice(0, 7)}" required />
              </label>
            </div>
            <div class="settings-field-row">
              <label class="form-label">Visit Target
                <input class="form-input" name="visitTargetCount" type="number" min="0" placeholder="0" required />
              </label>
              <label class="form-label">New Deal Value Target (${getActiveCurrency()})
                <input class="form-input" name="newDealValueTarget" type="number" min="0" placeholder="0" required />
              </label>
              <label class="form-label">Revenue Target (${getActiveCurrency()})
                <input class="form-input" name="revenueTarget" type="number" min="0" placeholder="0" required />
              </label>
            </div>
            <button type="submit">Save KPI Target</button>
          </form>
          ` : `<div class="empty-state compact"><div><strong>No active sales reps</strong><p>Create sales rep users first.</p></div></div>`}
        ` : `<div class="muted small" style="padding:var(--sp-2) 0">View only — Director or Manager access required to set targets.</div>`}
      </section>

      <section class="card">
        <div class="inline-actions wrap" style="justify-content:space-between;align-items:center;margin-bottom:var(--sp-3)">
          <h3 class="section-title" style="margin:0">${icon('chart')} KPI Targets</h3>
          ${canEditKpi ? `
            <div class="inline-actions">
              <button class="ghost small" id="kpi-template-btn" type="button">⬇ Download Template</button>
              <button class="ghost small" id="kpi-import-btn" type="button">Import KPI Targets</button>
              <button class="ghost small" id="kpi-import-history-btn" type="button">Import History</button>
            </div>
          ` : ""}
        </div>
        ${canEditKpi && state.cache.kpiTargets.length ? `
          <div id="kpi-bulk-toolbar" class="inline-actions wrap" hidden
            style="padding:var(--sp-2) var(--sp-3);margin-bottom:var(--sp-2);background:var(--bg-subtle);border-radius:var(--r);align-items:center;gap:var(--sp-2)">
            <span id="kpi-selected-count" class="muted small">0 selected</span>
            <div style="margin-left:auto;display:inline-flex;gap:var(--sp-2)">
              <button type="button" class="ghost small" id="kpi-bulk-copy-btn">${icon('clipboard')} Copy to Next Month</button>
              <button type="button" class="ghost small kpi-bulk-delete-btn" id="kpi-bulk-delete-btn"
                style="color:var(--danger,#dc2626)">${icon('trash')} Delete</button>
            </div>
          </div>
        ` : ""}
        ${state.cache.kpiTargets.length ? `
          <div class="roles-table kpi-table ${canEditKpi ? "kpi-table--selectable" : ""}">
            <div class="roles-table-head">
              ${canEditKpi ? `<span><input type="checkbox" id="kpi-select-all" aria-label="Select all KPI targets" /></span>` : ""}
              <span>Rep</span>
              <span>Month</span>
              <span>Visit Target</span>
              <span>New Deal Value</span>
              <span>Revenue</span>
              ${canEditKpi ? `<span></span>` : ""}
            </div>
            ${state.cache.kpiTargets.map((k) => {
              const repLabel = k.rep?.fullName || k.userId;
              const teamLabel = k.rep?.team?.teamName ? ` <span class="muted small">· ${k.rep.team.teamName}</span>` : "";
              return `<div class="roles-table-row">
                ${canEditKpi ? `<span><input type="checkbox" class="kpi-row-select" value="${k.id}" aria-label="Select KPI target" /></span>` : ""}
                <div class="roles-user-cell">
                  <div class="team-member-avatar" style="${k.rep?.avatarUrl ? "overflow:hidden" : "background:" + avatarColor(repLabel)}">${repAvatarHtml(repLabel, k.rep?.avatarUrl)}</div>
                  <span>${repLabel}${teamLabel}</span>
                </div>
                <span>${k.targetMonth}</span>
                <span>${k.visitTargetCount}</span>
                <span>${asMoney(k.newDealValueTarget)}</span>
                <span>${asMoney(k.revenueTarget)}</span>
                ${canEditKpi ? `<span><button class="ghost small kpi-edit" data-id="${k.id}" data-user-id="${k.userId}" data-target-month="${k.targetMonth}" data-visit-target="${k.visitTargetCount}" data-new-deal-target="${k.newDealValueTarget}" data-revenue-target="${k.revenueTarget}">Edit</button></span>` : ""}
              </div>`;
            }).join("")}
          </div>
        ` : `<div class="empty-state compact"><div><strong>No KPI targets yet</strong>${canEditKpi ? `<p>Use the form above to set per-person targets.</p>` : ""}</div></div>`}
      </section>
    `;
  } else if (page === "integrations") {
    // Group credentials by section
    const credByPlatform = Object.fromEntries(
      (integrationCredentials || []).map((c) => [c.platform, c])
    );

    function integrationSection(sectionTitle, sectionDesc, platforms) {
      const sectionKey = sectionTitle.toLowerCase().replace(/\s+/g, "-");
      const isCollapsed = !state.openIntgSections.has(sectionKey);

      return `
        <section class="card intg-section ${isCollapsed ? "intg-section--collapsed" : ""}">
          <button type="button" class="intg-section-toggle" data-intg-section="${sectionKey}" aria-expanded="${!isCollapsed}">
            <span class="intg-section-title">${sectionTitle}</span>
            <svg class="intg-chevron" width="16" height="16" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <polyline points="6 9 12 15 18 9"/>
            </svg>
          </button>
          <div class="intg-section-body"><div class="intg-section-inner">
            <p class="intg-section-desc muted">${sectionDesc}</p>
            <div class="intg-cards">
              ${platforms.map(({ platform, label, desc, fields, setupGuide }) => {
                const cred = credByPlatform[platform];
                const stored = cred ? Object.entries(cred.credentialsMasked || {}).filter(([, v]) => v) : [];
                const isConfigured = stored.length > 0;
                const isEnabled = cred?.isEnabled ?? false;
                return `
                  <div class="intg-card ${isConfigured ? "intg-card--configured" : ""}">
                    <div class="intg-card-header">
                      <div class="intg-card-info">
                        <span class="intg-card-name">${label}${setupGuide ? ` <button type="button" class="intg-info-btn" data-label="${escHtml(label)}" data-guide="${escHtml(setupGuide)}" title="Setup guide">ⓘ</button>` : ""}</span>
                        <span class="intg-card-desc">${desc}</span>
                      </div>
                      <div class="intg-card-badges">
                        ${isConfigured ? `<span class="chip chip-success">Configured</span>` : `<span class="chip">Not set</span>`}
                        ${cred ? `<span class="chip ${isEnabled ? "chip-success" : "chip-danger"}">${isEnabled ? "Enabled" : "Disabled"}</span>` : ""}
                      </div>
                    </div>
                    ${stored.length ? `<p class="intg-stored-hint">${stored.map(([k, v]) => `<span>${prettyLabel(k)}: <code>${v}</code></span>`).join(" &nbsp;·&nbsp; ")}</p>` : ""}
                    <form class="intg-form integration-credential-form" data-platform="${platform}">
                      ${fields.map((f) => `
                        <label class="form-label intg-form-field">
                          ${f.label}
                          <input class="form-input" name="${f.name}" type="${f.type || "text"}" placeholder="${f.placeholder}" autocomplete="off" />
                        </label>
                      `).join("")}
                      <div class="intg-form-actions">
                        <button type="submit" class="primary small">Save</button>
                        ${cred ? `
                          <button type="button" class="ghost small integration-test-btn" data-platform="${platform}">Test Connection</button>
                          <button type="button" class="ghost small integration-toggle-btn" data-platform="${platform}" data-enabled="${isEnabled}">
                            ${isEnabled ? "Disable" : "Enable"}
                          </button>
                          ${platform === "MS_TEAMS" ? `<button type="button" class="ghost small teams-app-pkg-btn" data-tenant-id="${tenantId}">⬇ Download Teams App</button>
                            <button type="button" class="ghost small teams-push-all-btn" data-tenant-id="${tenantId}" title="Requires User.Read.All, AppCatalog.Read.All, TeamsAppInstallation.ReadWriteForUser.All permissions with admin consent">${icon('rocket')} Push to All Users</button>` : ""}
                        ` : ""}
                      </div>
                      ${cred?.lastTestStatus ? `<p class="intg-test-result small intg-test-result--${cred.lastTestStatus === "SUCCESS" ? "pass" : "fail"}">Last test: ${cred.lastTestResult ? escHtml(cred.lastTestResult) : cred.lastTestStatus} · ${asDate(cred.lastTestedAt)}</p>` : ""}
                    </form>
                  </div>
                `;
              }).join("")}
            </div>
          </div></div>
        </section>
      `;
    }

    const aiPlatforms = ["ANTHROPIC", "GEMINI", "OPENAI"];
    const activeAiPlatform = aiPlatforms.find(p => credByPlatform[p]?.isEnabled);

    const aiSectionKey = "ai-services";
    const aiCollapsed = !state.openIntgSections.has(aiSectionKey);

    pageHtml = `
      <section class="card intg-section ${aiCollapsed ? "intg-section--collapsed" : ""}">
        <button type="button" class="intg-section-toggle" data-intg-section="${aiSectionKey}" aria-expanded="${!aiCollapsed}">
          <span class="intg-section-title">AI Services</span>
          <svg class="intg-chevron" width="16" height="16" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <polyline points="6 9 12 15 18 9"/>
          </svg>
        </button>
        <div class="intg-section-body"><div class="intg-section-inner">
          <p class="intg-section-desc muted">API keys for AI-powered features. <strong>Only one provider can be active at a time.</strong></p>
          ${activeAiPlatform ? `<p class="intg-ai-active-hint">Active provider: <span class="chip chip-success" style="vertical-align:middle">${activeAiPlatform === "OPENAI" ? "ChatGPT (OpenAI)" : activeAiPlatform === "GEMINI" ? "Gemini (Google)" : "Claude (Anthropic)"}</span></p>` : `<p class="intg-ai-active-hint muted small">No AI provider enabled. Configure and enable one below.</p>`}
          <div class="intg-cards">
          ${[
            {
              platform: "ANTHROPIC",
              label: "Anthropic — Claude",
              desc: "Powers lost deal analysis and AI insights using Claude Haiku.",
              fields: [{ name: "apiKey", label: "API Key", placeholder: "sk-ant-…", type: "password" }],
              setupGuide: `<ol><li>Go to <strong>console.anthropic.com</strong> and sign in.</li><li>Click <strong>API Keys</strong> in the left menu.</li><li>Click <strong>Create Key</strong>, give it a name, then copy the key (starts with <code>sk-ant-</code>).</li><li>Paste it into the <strong>API Key</strong> field and click <strong>Save Key</strong>.</li><li>Click <strong>Test Connection</strong> to verify, then <strong>Enable</strong>.</li></ol>`
            },
            {
              platform: "GEMINI",
              label: "Google — Gemini",
              desc: "Uses Gemini 1.5 Flash for fast AI analysis.",
              fields: [{ name: "apiKey", label: "API Key", placeholder: "AIza…", type: "password" }],
              setupGuide: `<ol><li>Go to <strong>aistudio.google.com</strong> and sign in with your Google account.</li><li>Click <strong>Get API Key</strong> → <strong>Create API key in new project</strong>.</li><li>Copy the generated key (starts with <code>AIza</code>).</li><li>Paste it into the <strong>API Key</strong> field and click <strong>Save Key</strong>.</li><li>Click <strong>Test Connection</strong> to verify, then <strong>Enable</strong>.</li></ol>`
            },
            {
              platform: "OPENAI",
              label: "OpenAI — ChatGPT",
              desc: "Uses GPT-4o Mini for cost-effective AI analysis.",
              fields: [{ name: "apiKey", label: "API Key", placeholder: "sk-…", type: "password" }],
              setupGuide: `<ol><li>Go to <strong>platform.openai.com</strong> and sign in.</li><li>Click your profile → <strong>API Keys</strong>.</li><li>Click <strong>Create new secret key</strong>, name it, then copy it (starts with <code>sk-</code>).</li><li>Paste it into the <strong>API Key</strong> field and click <strong>Save Key</strong>.</li><li>Click <strong>Test Connection</strong> to verify, then <strong>Enable</strong>.</li></ol>`
            }
          ].map(({ platform, label, desc, fields, setupGuide }) => {
            const cred = credByPlatform[platform];
            const stored = cred ? Object.entries(cred.credentialsMasked || {}).filter(([, v]) => v) : [];
            const isConfigured = stored.length > 0;
            const isEnabled = cred?.isEnabled ?? false;
            const isActiveAi = isEnabled;
            return `
              <div class="intg-card ${isConfigured ? "intg-card--configured" : ""} ${isActiveAi ? "intg-card--ai-active" : ""}">
                <div class="intg-card-header">
                  <div class="intg-card-info">
                    <span class="intg-card-name">${label}${isActiveAi ? ' <span class="intg-active-badge">Active</span>' : ""}${setupGuide ? ` <button type="button" class="intg-info-btn" data-label="${escHtml(label)}" data-guide="${escHtml(setupGuide)}" title="Setup guide">ⓘ</button>` : ""}</span>
                    <span class="intg-card-desc">${desc}</span>
                  </div>
                  <div class="intg-card-badges">
                    ${isConfigured ? `<span class="chip chip-success">Configured</span>` : `<span class="chip">Not set</span>`}
                  </div>
                </div>
                ${stored.length ? `<p class="intg-stored-hint">${stored.map(([k, v]) => `<span>${prettyLabel(k)}: <code>${v}</code></span>`).join(" &nbsp;·&nbsp; ")}</p>` : ""}
                <form class="intg-form integration-credential-form" data-platform="${platform}">
                  ${fields.map((f) => `
                    <label class="form-label intg-form-field">
                      ${f.label}
                      <input class="form-input" name="${f.name}" type="${f.type || "text"}" placeholder="${f.placeholder}" autocomplete="off" />
                    </label>
                  `).join("")}
                  <div class="intg-form-actions">
                    <button type="submit" class="primary small">Save Key</button>
                    ${cred ? `
                      <button type="button" class="ghost small integration-test-btn" data-platform="${platform}">Test Connection</button>
                      <button type="button" class="ghost small integration-toggle-btn ${isEnabled ? "danger-ghost" : ""}" data-platform="${platform}" data-enabled="${isEnabled}">
                        ${isEnabled ? "Disable" : "Enable"}
                      </button>
                    ` : ""}
                  </div>
                  ${cred?.lastTestStatus ? `<p class="intg-test-result muted small">Last test: ${cred.lastTestStatus} · ${asDate(cred.lastTestedAt)}${cred.lastTestResult ? " · " + escHtml(cred.lastTestResult) : ""}</p>` : ""}
                </form>
              </div>
            `;
          }).join("")}
          </div>
        </div></div>
      </section>

      ${integrationSection(
        "Communication Platforms",
        "Connect messaging and email channels for customer outreach and notifications.",
        [
          {
            platform: "MS_TEAMS",
            label: "Microsoft Teams",
            desc: "Azure AD app credentials for Teams notifications. The App ID and Secret are used for both group webhooks and personal DMs (Bot Framework). Add per-team Incoming Webhook URLs in Settings → Team Structure → Group Notifications.",
            fields: [
              { name: "clientId", label: "Bot ID (App Client ID)", placeholder: "e.g. 64860447-8d51-46af-bc06-f451fc750cde" },
              { name: "clientSecret", label: "Client Secret Value", placeholder: "Paste the Value (not the Secret ID) from Azure AD → Certificates & secrets" },
              { name: "webhookToken", label: "Azure AD Tenant ID", placeholder: "e.g. xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx  (Azure AD → Overview)" }
            ],
            setupGuide: `<ol><li>In <strong>Azure Portal</strong>, go to Azure AD → App registrations → New registration (or use your existing Azure Bot registration).</li><li>Copy the <strong>Application (client) ID</strong> — this is the Bot ID.</li><li>Under <strong>Certificates &amp; Secrets</strong>, create a new client secret and copy the <strong>Value</strong> (not the Secret ID).</li><li>Copy the <strong>Directory (tenant) ID</strong> from the app's Overview page.</li><li>Paste all three values here, click <strong>Save</strong>, then <strong>Test Connection</strong>.</li><li><strong>Install the bot in Teams:</strong> Click <strong>⬇ Download Teams App</strong> to get the app package ZIP. Then go to <strong>Teams Admin Center → Teams apps → Manage apps → Upload new app</strong> and upload the ZIP. After approval, deploy it to all users under <strong>Setup policies → Global → Add apps</strong>.</li><li>For each team's channel, go to <strong>Settings → Team Structure → Group Notifications → Add Channel → Microsoft Teams</strong> and paste the Incoming Webhook URL.</li><li><em>Optional — for "Connect with Microsoft Teams" button on the Notifications page:</em> Ensure the MS365 integration is also enabled and has the redirect URI <code>${window.location.origin}/api/v1/auth/oauth/ms-teams-connect/callback</code> added in Azure Portal → Authentication → Redirect URIs.</li></ol>`
          },
          {
            platform: "SLACK",
            label: "Slack",
            desc: "Send deal and visit notifications to Slack channels. Optionally enable OAuth so users can connect their Slack account automatically.",
            fields: [
              { name: "apiKey", label: "Bot Token", placeholder: "xoxb-…", type: "password" },
              { name: "webhookToken", label: "Webhook URL", placeholder: "https://hooks.slack.com/…" },
              { name: "clientId", label: "OAuth Client ID", placeholder: "Slack app client ID (for user connect)" },
              { name: "clientSecret", label: "OAuth Client Secret", placeholder: "Slack app client secret", type: "password" }
            ],
            setupGuide: `<ol><li>Go to <strong>api.slack.com/apps</strong> and create a new app (From scratch).</li><li>Under <strong>OAuth &amp; Permissions</strong>, add scopes: <code>chat:write</code>, <code>chat:write.public</code>. Install to workspace and copy the <strong>Bot User OAuth Token</strong> (starts with <code>xoxb-</code>).</li><li>Under <strong>Incoming Webhooks</strong>, activate and add a new webhook. Copy the URL.</li><li>Paste both values and click <strong>Save</strong>, then <strong>Test Connection</strong>.</li><li><em>Optional — for "Connect with Slack" button on the Notifications page:</em> Under <strong>OAuth &amp; Permissions</strong>, add redirect URL: <code>${window.location.origin}/api/v1/auth/oauth/slack-connect/callback</code>. Under <strong>OpenID Connect</strong>, enable Sign in with Slack. Copy the <strong>Client ID</strong> and <strong>Client Secret</strong> from Basic Information and save them here.</li></ol>`
          },
          {
            platform: "LINE",
            label: "LINE Messaging",
            desc: "Customer communication via LINE messaging platform.",
            fields: [
              { name: "clientId", label: "Channel ID", placeholder: "LINE channel ID" },
              { name: "clientSecret", label: "Channel Secret", placeholder: "LINE channel secret", type: "password" },
              { name: "apiKey", label: "Access Token", placeholder: "Channel access token", type: "password" }
            ],
            setupGuide: `<ol><li>Go to <strong>developers.line.biz</strong> and sign in with your LINE Business account.</li><li>Create a new provider and channel: choose <strong>Messaging API</strong>.</li><li>In the channel settings, copy the <strong>Channel ID</strong> and <strong>Channel Secret</strong>.</li><li>Under the <strong>Messaging API</strong> tab, issue a <strong>Channel Access Token</strong> (long-lived) and copy it.</li><li>Add the bot to your LINE group chat. Go to <strong>Settings → Team Structure → Group Notifications</strong> to add the Group ID.</li><li>Paste all values here, click <strong>Save</strong>, then <strong>Test Connection</strong>.</li></ol>`
          },
          {
            platform: "LINE_LOGIN",
            label: "LINE Login",
            desc: "Lets users connect their LINE account via OAuth so their User ID is filled in automatically. Must be under the same LINE Provider as LINE Messaging.",
            fields: [
              { name: "clientId", label: "Channel ID", placeholder: "LINE Login channel ID" },
              { name: "clientSecret", label: "Channel Secret", placeholder: "LINE Login channel secret", type: "password" }
            ],
            setupGuide: `<ol><li>Go to <strong>developers.line.biz</strong> and open your existing <strong>Provider</strong> (must be the same Provider as LINE Messaging).</li><li>Click <strong>Create a new channel</strong> → choose <strong>LINE Login</strong>.</li><li>Under <strong>LINE Login</strong> tab → <strong>Callback URL</strong>, add: <code>${window.location.origin}/api/v1/auth/oauth/line-connect/callback</code></li><li>Copy the <strong>Channel ID</strong> and <strong>Channel Secret</strong> and paste them here.</li><li>Click <strong>Save</strong>. Users on the Notifications page will now see a "Login with LINE" button.</li><li><em>Optional but recommended</em>: In the LINE Messaging API channel settings → <strong>LINE Login</strong> tab, link this Login channel to enable auto-friend-add during the OAuth flow.</li></ol>`
          },
          {
            platform: "EMAIL",
            label: "Email (SMTP)",
            desc: "Outbound email for visit and deal notifications.",
            fields: [
              { name: "clientId",     label: "SMTP Host",       placeholder: "smtp.gmail.com" },
              { name: "clientSecret", label: "SMTP Port",        placeholder: "587" },
              { name: "webhookToken", label: "From Address",     placeholder: "noreply@yourcompany.com" },
              { name: "apiKey",       label: "Password / API Key", placeholder: "App password or SMTP password", type: "password" }
            ],
            setupGuide: `<ol><li>Choose your email provider and obtain SMTP credentials (see common providers below).</li><li><strong>Microsoft 365</strong>: Host <code>smtp.office365.com</code>, Port <code>587</code>, From Address = your M365 mailbox. If MFA is on, create an App Password at <strong>myaccount.microsoft.com → Security info → App password</strong>. If authentication fails, ask IT to run: <code>Set-CASMailbox -Identity "you@company.com" -SmtpClientAuthenticationDisabled $false</code></li><li><strong>Gmail</strong>: Host <code>smtp.gmail.com</code>, Port <code>587</code>. Enable 2FA, then go to Google Account → Security → <strong>App Passwords</strong> and create a password for "Mail".</li><li><strong>SendGrid</strong>: Host <code>smtp.sendgrid.net</code>, Port <code>587</code>, From Address = your verified sender. Go to Settings → API Keys → Create Key with <em>Mail Send</em> permission and use it as the password.</li><li>Enter all values, click <strong>Save</strong>, then <strong>Test Connection</strong> — a test email will be sent to the From Address to verify delivery.</li></ol>`
          }
        ]
      )}

      ${integrationSection(
        "Cloud & Productivity",
        "Calendar sync and cloud productivity integrations.",
        [
          {
            platform: "MS365",
            label: "Microsoft 365",
            desc: "Calendar sync, Outlook integration, and Azure AD authentication.",
            fields: [
              { name: "clientId", label: "Client ID", placeholder: "Azure app (client) ID" },
              { name: "clientSecret", label: "Client Secret", placeholder: "Azure client secret", type: "password" },
              { name: "webhookToken", label: "Tenant ID", placeholder: "Azure AD tenant ID (xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx)" }
            ],
            setupGuide: `<ol><li>In <strong>Azure Portal</strong>, go to Azure Active Directory → App registrations → New registration.</li><li>Set redirect URI to your app URL + <code>/auth/callback</code>.</li><li>Copy the <strong>Application (client) ID</strong>.</li><li>Go to Certificates &amp; Secrets → New client secret. Copy the secret <strong>Value</strong> (not the ID).</li><li>Under API permissions, add: <code>Calendars.ReadWrite</code>, <code>Mail.Send</code>, <code>User.Read</code>. Grant admin consent.</li><li>Paste the Client ID and Secret here, then click <strong>Save</strong> and <strong>Test Connection</strong>.</li></ol>`
          },
          {
            platform: "GOOGLE",
            label: "Google Workspace",
            desc: "Google Calendar sync and Gmail integration.",
            fields: [
              { name: "clientId", label: "Client ID", placeholder: "Google OAuth client ID" },
              { name: "clientSecret", label: "Client Secret", placeholder: "Google OAuth client secret", type: "password" }
            ],
            setupGuide: `<ol><li>Go to <strong>console.cloud.google.com</strong> and create or select a project.</li><li>Enable the <strong>Google Calendar API</strong> and <strong>Gmail API</strong> under APIs &amp; Services → Library.</li><li>Go to APIs &amp; Services → Credentials → Create Credentials → OAuth 2.0 Client ID.</li><li>Set application type to <strong>Web application</strong> and add your app URL as an authorised redirect URI.</li><li>Copy the <strong>Client ID</strong> and <strong>Client Secret</strong>.</li><li>Paste both values here, click <strong>Save</strong>, then <strong>Test Connection</strong>.</li></ol>`
          }
        ]
      )}
    `;
  } else if (page === "custom-domain") {
    // Load custom domain data if not cached
    if (!state.cache.customDomain) {
      state.cache.customDomain = { loading: true };
      api(`/tenants/${state.user?.tenantId}/custom-domain`).then(data => {
        state.cache.customDomain = data || { empty: true };
        renderSettings();
      }).catch(() => {
        state.cache.customDomain = { empty: true };
        renderSettings();
      });
    }
    const cd = state.cache.customDomain;
    const tenantSlug = state.user?.tenantSlug || localStorage.getItem("tenantSlug") || "";

    const subdomainUrl = tenantSlug ? `https://${tenantSlug}.${window.__BASE_DOMAIN || "thinkbizcrm.com"}` : null;

    const statusChip = cd?.status === "VERIFIED"
      ? `<span class="chip chip-success">Verified</span>`
      : cd?.status === "PENDING"
        ? `<span class="chip chip-warning">Pending Verification</span>`
        : cd?.status === "FAILED"
          ? `<span class="chip chip-danger">Verification Failed</span>`
          : "";

    pageHtml = `
      <section class="card">
        <h3 class="section-title">Tenant Subdomain</h3>
        <p class="muted small" style="margin-bottom:var(--sp-3)">Your workspace is automatically available at a subdomain based on your workspace slug. No configuration needed.</p>
        <div class="settings-field-row" style="align-items:center">
          <div>
            <strong>${subdomainUrl || "Not available"}</strong>
            ${subdomainUrl ? `<p class="muted small" style="margin-top:var(--sp-1)">This URL is always active and requires no DNS setup.</p>` : `<p class="muted small" style="margin-top:var(--sp-1)">Set a workspace slug in Company Settings to enable subdomain access.</p>`}
          </div>
        </div>
      </section>

      <section class="card" style="margin-top:var(--sp-4)">
        <h3 class="section-title">Custom Domain (Enterprise)</h3>
        <p class="muted small" style="margin-bottom:var(--sp-3)">Point your own domain to ThinkCRM. Users will access the app at your custom domain with full white-label branding.</p>

        ${cd?.loading ? `<div class="muted">Loading…</div>` : cd?.empty || !cd?.domain ? `
          <form id="cd-add-form" class="settings-form" style="max-width:500px">
            <label class="form-label">Domain
              <input class="form-input" name="domain" type="text" placeholder="crm.yourcompany.com" required pattern="^(?:[a-z0-9](?:[a-z0-9\\-]{0,61}[a-z0-9])?\\.)+[a-z]{2,}$" />
            </label>
            <p class="muted small">Enter a subdomain of your company domain (e.g. <code>crm.yourcompany.com</code>). You will need to add an A record and a TXT verification record.</p>
            <button type="submit">Add Domain</button>
            <p id="cd-msg" class="small" style="min-height:1.2em;margin-top:var(--sp-2)"></p>
          </form>
        ` : `
          <div class="cd-domain-info" style="display:flex;flex-direction:column;gap:var(--sp-3)">
            <div style="display:flex;align-items:center;gap:var(--sp-2)">
              <strong style="font-size:1.1rem">${escHtml(cd.domain)}</strong>
              ${statusChip}
            </div>

            ${cd.status !== "VERIFIED" ? `
              <div class="cd-dns-instructions" style="background:var(--clr-surface);padding:var(--sp-3);border-radius:8px">
                <p style="margin-bottom:var(--sp-2)"><strong>Step 1:</strong> Add these DNS records at your domain registrar:</p>
                <div class="cd-dns-table" style="display:grid;grid-template-columns:auto auto 1fr;gap:var(--sp-1) var(--sp-3);font-family:var(--font-mono);font-size:0.82rem;margin-bottom:var(--sp-2)">
                  <span class="muted">Type</span><span class="muted">Name</span><span class="muted">Value</span>
                  <span>CNAME</span><span>${escHtml(cd.domain)}</span><span>cname.vercel-dns.com</span>
                  <span>TXT</span><span>_thinkcrm-verify.${escHtml(cd.domain)}</span><span>${escHtml(cd.verificationToken)}</span>
                </div>
                <p class="muted small">DNS changes can take up to 48 hours to propagate.</p>
                <p style="margin-top:var(--sp-2)"><strong>Step 2:</strong> Click "Verify" once your DNS records are in place.</p>
                <div style="display:flex;gap:var(--sp-2);margin-top:var(--sp-2)">
                  <button id="cd-verify-btn">Verify Domain</button>
                  <button class="ghost danger small" id="cd-remove-btn">Remove</button>
                </div>
                <p id="cd-msg" class="small" style="min-height:1.2em;margin-top:var(--sp-2)"></p>
              </div>
            ` : `
              <div style="background:var(--clr-surface);padding:var(--sp-3);border-radius:8px">
                <p>Your custom domain is <strong>verified and active</strong>. Users can access the app at:</p>
                <p style="font-size:1.1rem;margin:var(--sp-2) 0"><strong>https://${escHtml(cd.domain)}</strong></p>
                <p class="muted small">Verified on ${cd.verifiedAt ? new Date(cd.verifiedAt).toLocaleDateString() : "—"}</p>
                <div style="margin-top:var(--sp-3)">
                  <button class="ghost danger small" id="cd-remove-btn">Remove Domain</button>
                </div>
                <p id="cd-msg" class="small" style="min-height:1.2em;margin-top:var(--sp-2)"></p>
              </div>
            `}
          </div>
        `}
      </section>
    `;
  } else if (page === "data-sync") {
    // ── Data Sync Settings ─────────────────────────────────────────
    const syncApiKeys = state.cache.syncApiKeys ?? [];
    const syncSources = state.cache.syncSources ?? [];
    const syncJobs = state.cache.syncJobs ?? [];
    pageHtml = `
      <section class="card" style="margin-bottom:var(--sp-4)">
        <h3 class="section-title">${icon('refresh')} Data Sync</h3>
        <p class="muted" style="font-size:0.85rem">Sync Customers, Items, and Payment Terms from external ERP systems. Supports API push, REST pull, and file import.</p>
      </section>

      <!-- API Keys -->
      <section class="card" style="margin-bottom:var(--sp-4)">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:var(--sp-3)">
          <h4 style="margin:0">${icon('key')} API Keys</h4>
          <button class="btn-primary small" id="sync-create-key-btn">+ Create API Key</button>
        </div>
        <p class="muted" style="font-size:0.82rem;margin-bottom:var(--sp-3)">
          Give this key to the ERP team. They send data to <code>POST /api/v1/sync/inbound</code> with header <code>X-Api-Key: &lt;key&gt;</code>.
        </p>
        ${syncApiKeys.length === 0 ? '<p class="muted">No API keys yet.</p>' : `
          <table class="data-table">
            <thead><tr><th>Label</th><th>Prefix</th><th>Scopes</th><th>Status</th><th>Last Used</th><th>Expires</th><th></th></tr></thead>
            <tbody>
              ${syncApiKeys.map(k => `<tr>
                <td>${escHtml(k.label)}</td>
                <td><code>${escHtml(k.keyPrefix)}…</code></td>
                <td>${k.scopes.map(s => `<span class="badge badge--muted">${escHtml(s)}</span>`).join(" ")}</td>
                <td>${k.isActive ? '<span class="badge badge--ok">Active</span>' : '<span class="badge badge--err">Revoked</span>'}</td>
                <td>${k.lastUsedAt ? new Date(k.lastUsedAt).toLocaleDateString() : "Never"}</td>
                <td>${k.expiresAt ? new Date(k.expiresAt).toLocaleDateString() : "Never"}</td>
                <td>${k.isActive ? `<button class="ghost small sync-revoke-key-btn" data-key-id="${k.id}">Revoke</button>` : ""}</td>
              </tr>`).join("")}
            </tbody>
          </table>
        `}
        <div id="sync-new-key-form" style="display:none;margin-top:var(--sp-3);padding:var(--sp-3);border:1px solid var(--clr-border);border-radius:var(--radius)">
          <form id="sync-key-form">
            <div class="form-row">
              <label class="form-label">Label <input type="text" name="label" required placeholder="e.g. SAP Production" class="form-control"></label>
            </div>
            <div class="form-row">
              <label class="form-label">Scopes
                <select name="scopes" multiple class="form-control" style="min-height:80px">
                  <option value="*" selected>* (All entities)</option>
                  <option value="CUSTOMER">CUSTOMER</option>
                  <option value="ITEM">ITEM</option>
                  <option value="PAYMENT_TERM">PAYMENT_TERM</option>
                </select>
              </label>
            </div>
            <div class="form-row">
              <label class="form-label">Expires in (days, leave empty for no expiry) <input type="number" name="expiresInDays" min="1" max="3650" placeholder="365" class="form-control"></label>
            </div>
            <div class="form-actions">
              <button type="submit" class="btn-primary small">Generate Key</button>
              <button type="button" class="ghost small" id="sync-key-cancel">Cancel</button>
            </div>
          </form>
        </div>
        <div id="sync-key-reveal" style="display:none;margin-top:var(--sp-3);padding:var(--sp-3);background:var(--clr-surface-hover);border-radius:var(--radius)">
          <p style="font-weight:600;margin-bottom:var(--sp-2)">Copy this key now — it won't be shown again:</p>
          <code id="sync-key-value" style="display:block;padding:var(--sp-2);background:var(--clr-bg);border-radius:var(--radius);word-break:break-all;font-size:0.9rem"></code>
        </div>
      </section>

      <!-- Data Sources & Field Mappings -->
      <section class="card" style="margin-bottom:var(--sp-4)">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:var(--sp-3)">
          <h4 style="margin:0">${icon('antenna')} Data Sources & Field Mappings</h4>
          <button class="btn-primary small" id="sync-create-source-btn">+ Create Source</button>
        </div>
        <p class="muted" style="font-size:0.82rem;margin-bottom:var(--sp-3)">
          Each source represents an external system (ERP, spreadsheet, etc.). Configure field mappings to map ERP fields to CRM fields.
        </p>
        ${syncSources.length === 0 ? '<p class="muted">No data sources configured.</p>' : syncSources.map(src => `
          <div class="sync-source-card" style="border:1px solid var(--clr-border);border-radius:var(--radius);padding:var(--sp-3);margin-bottom:var(--sp-3)">
            <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:var(--sp-2)">
              <div>
                <strong>${escHtml(src.sourceName)}</strong>
                <span class="badge badge--muted" style="margin-left:var(--sp-2)">${escHtml(src.sourceType)}</span>
                <span class="badge ${src.status === "ENABLED" ? "badge--ok" : "badge--err"}" style="margin-left:var(--sp-1)">${src.status}</span>
              </div>
              <div>
                <button class="ghost small sync-toggle-source-btn" data-source-id="${src.id}" data-current-status="${src.status}">${src.status === "ENABLED" ? "Disable" : "Enable"}</button>
                <button class="ghost small sync-edit-mappings-btn" data-source-id="${src.id}" data-source-name="${escHtml(src.sourceName)}">Edit Mappings</button>
              </div>
            </div>
            ${src.mappings && src.mappings.length > 0 ? `
              <table class="data-table" style="font-size:0.82rem">
                <thead><tr><th>Entity</th><th>Source Field</th><th>→</th><th>CRM Field</th><th>Transform</th><th>Required</th></tr></thead>
                <tbody>
                  ${src.mappings.map(m => `<tr>
                    <td><span class="badge badge--muted">${escHtml(m.entityType)}</span></td>
                    <td><code>${escHtml(m.sourceField)}</code></td>
                    <td>→</td>
                    <td><code>${escHtml(m.targetField)}</code></td>
                    <td>${m.transformRule ? `<code>${escHtml(m.transformRule)}</code>` : "—"}</td>
                    <td>${m.isRequired ? "Yes" : ""}</td>
                  </tr>`).join("")}
                </tbody>
              </table>
            ` : '<p class="muted" style="font-size:0.82rem">No field mappings configured yet.</p>'}
            ${src.lastSyncAt ? `<p class="muted" style="font-size:0.78rem;margin-top:var(--sp-2)">Last sync: ${new Date(src.lastSyncAt).toLocaleString()}</p>` : ""}
          </div>
        `).join("")}
        <div id="sync-source-form-wrap" style="display:none;margin-top:var(--sp-3);padding:var(--sp-3);border:1px solid var(--clr-border);border-radius:var(--radius)">
          <form id="sync-source-form">
            <div class="form-row">
              <label class="form-label">Source Name <input type="text" name="sourceName" required placeholder="e.g. SAP Business One" class="form-control"></label>
            </div>
            <div class="form-row">
              <label class="form-label">Source Type
                <select name="sourceType" class="form-control">
                  <option value="WEBHOOK">Webhook (ERP pushes data)</option>
                  <option value="REST">REST API (CRM pulls data)</option>
                  <option value="EXCEL">File Upload (CSV/Excel)</option>
                </select>
              </label>
            </div>
            <div class="form-actions">
              <button type="submit" class="btn-primary small">Create Source</button>
              <button type="button" class="ghost small" id="sync-source-cancel">Cancel</button>
            </div>
          </form>
        </div>
      </section>

      <!-- Mapping Editor Modal -->
      <div id="sync-mapping-editor" style="display:none;margin-bottom:var(--sp-4)">
        <section class="card">
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:var(--sp-3)">
            <h4 style="margin:0">${icon('pen')} Edit Field Mappings — <span id="sync-mapping-source-name"></span></h4>
            <button class="ghost small" id="sync-mapping-close">Close</button>
          </div>
          <form id="sync-mapping-form">
            <input type="hidden" name="sourceId" id="sync-mapping-source-id">
            <div id="sync-mapping-rows"></div>
            <div style="margin-top:var(--sp-2)">
              <button type="button" class="ghost small" id="sync-mapping-add-row">+ Add Mapping</button>
            </div>
            <div class="form-actions" style="margin-top:var(--sp-3)">
              <button type="submit" class="btn-primary small">Save Mappings</button>
            </div>
          </form>
        </section>
      </div>

      <!-- Recent Sync Jobs -->
      <section class="card">
        <h4 style="margin-bottom:var(--sp-3)">${icon('clipboard')} Recent Sync Jobs</h4>
        ${syncJobs.length === 0 ? '<p class="muted">No sync jobs yet.</p>' : `
          <table class="data-table">
            <thead><tr><th>Time</th><th>Source</th><th>Type</th><th>Status</th><th>Records</th><th></th></tr></thead>
            <tbody>
              ${syncJobs.map(j => {
                const s = j.summaryJson || {};
                return `<tr>
                  <td>${new Date(j.startedAt).toLocaleString()}</td>
                  <td>${escHtml(j.source?.sourceName ?? "—")}</td>
                  <td><span class="badge badge--muted">${escHtml(j.runType)}</span></td>
                  <td><span class="badge ${j.status === "SUCCESS" ? "badge--ok" : j.status === "FAILED" ? "badge--err" : "badge--muted"}">${j.status}</span></td>
                  <td>${s.success_count ?? "—"} / ${s.processed_count ?? "—"}</td>
                  <td><button class="ghost small sync-view-job-btn" data-job-id="${j.id}">Details</button></td>
                </tr>`;
              }).join("")}
            </tbody>
          </table>
        `}
      </section>
    `;
  } else if (page === "custom-fields") {
    const cfData = state.cache.customFieldSettings;
    if (cfData === null || cfData === undefined) {
      pageHtml = `<section class="card"><div class="muted">Loading custom fields…</div></section>`;
    } else {
      const entityTab = state.customFieldsEntityTab || "customer";
      const entityLabels = { "payment-term": "Payment Terms", customer: "Customers", item: "Items" };
      const defs = cfData[entityTab] || [];
      const typeLabels = {
        TEXT: "Text",
        TEXTAREA: "Long text",
        NUMBER: "Number",
        CURRENCY: "Currency",
        BOOLEAN: "Boolean",
        DATE: "Date",
        SELECT: "Select (single)",
        MULTISELECT: "Select (multiple)",
        EMAIL: "Email",
        URL: "URL",
        PHONE: "Phone"
      };
      const dataTypeOptions = Object.entries(typeLabels)
        .map(([v, l]) => `<option value="${v}">${l}</option>`)
        .join("");
      pageHtml = `
        <section class="card" style="margin-bottom:var(--sp-4)">
          <h3 class="section-title">${icon('clipboard')} Custom Fields</h3>
          <p class="muted" style="font-size:0.85rem">Define tenant-specific fields to attach to Customers, Items, and Payment Terms. Supports text, number, currency, date, boolean, single/multi-select, email, URL, and phone.</p>
        </section>

        <section class="card">
          <div class="cf-tabs" style="display:flex;gap:var(--sp-2);margin-bottom:var(--sp-4);border-bottom:1px solid var(--border)">
            ${["customer", "item", "payment-term"].map((et) => `
              <button class="cf-tab ghost ${et === entityTab ? "cf-tab--active" : ""}" data-cf-tab="${et}" style="border-bottom:2px solid ${et === entityTab ? "var(--primary)" : "transparent"};border-radius:0;margin-bottom:-1px">
                ${escHtml(entityLabels[et])}
                <span class="muted small">(${(cfData[et] || []).length})</span>
              </button>
            `).join("")}
          </div>

          <form class="mini-form" id="cf-create-form" data-entity="${entityTab}">
            <h4 style="margin-top:0">Add field</h4>
            <div class="cf-form-grid" style="display:grid;grid-template-columns:1fr 1fr;gap:var(--sp-2)">
              <label>Key (snake_case)
                <input name="fieldKey" placeholder="e.g. collection_method" pattern="^[a-zA-Z][a-zA-Z0-9_]*$" required />
              </label>
              <label>Label
                <input name="label" placeholder="Display label" required />
              </label>
              <label>Data type
                <select name="dataType" id="cf-create-type" required>${dataTypeOptions}</select>
              </label>
              <label>Display order
                <input name="displayOrder" type="number" min="0" value="0" />
              </label>
              <label class="cf-options-wrap" style="grid-column:1 / -1;display:none">Options (comma separated — required for SELECT / MULTISELECT)
                <input name="options" placeholder="Option A, Option B, Option C" />
              </label>
              <label style="grid-column:1 / -1">Placeholder / help text
                <input name="placeholder" maxlength="120" />
              </label>
              <label class="checkbox-inline" style="grid-column:1 / -1">
                <input name="isRequired" type="checkbox" />
                Required field
              </label>
            </div>
            <button type="submit">Add custom field</button>
          </form>
        </section>

        <section class="card" style="margin-top:var(--sp-4)">
          <h4 style="margin-top:0">${escHtml(entityLabels[entityTab])} fields</h4>
          ${defs.length === 0 ? `
            <div class="empty-state compact"><div><strong>No custom fields yet</strong><p>Use the form above to add your first field.</p></div></div>
          ` : `
            <table class="data-table">
              <thead><tr>
                <th>Label</th>
                <th>Key</th>
                <th>Type</th>
                <th>Required</th>
                <th>Order</th>
                <th>Options</th>
                <th>Status</th>
                <th></th>
              </tr></thead>
              <tbody>
                ${defs.map((d) => {
                  const options = Array.isArray(d.optionsJson) ? d.optionsJson.join(", ") : "—";
                  return `
                    <tr data-cf-row="${d.id}">
                      <td><strong>${escHtml(d.label)}</strong>${d.placeholder ? `<div class="muted small">${escHtml(d.placeholder)}</div>` : ""}</td>
                      <td><code>${escHtml(d.fieldKey)}</code></td>
                      <td>${escHtml(typeLabels[d.dataType] || d.dataType)}</td>
                      <td>${d.isRequired ? "Yes" : "No"}</td>
                      <td>${d.displayOrder}</td>
                      <td class="muted small">${escHtml(options)}</td>
                      <td><span class="chip ${d.isActive ? "chip-success" : "chip-danger"}">${d.isActive ? "Active" : "Inactive"}</span></td>
                      <td class="inline-actions wrap" style="gap:var(--sp-1)">
                        <button class="ghost small cf-edit-btn" data-id="${d.id}" data-entity="${entityTab}">Edit</button>
                        <button class="ghost small cf-toggle-btn" data-id="${d.id}" data-entity="${entityTab}" data-active="${d.isActive}">${d.isActive ? "Deactivate" : "Activate"}</button>
                        <button class="ghost small danger cf-delete-btn" data-id="${d.id}" data-entity="${entityTab}" data-label="${escHtml(d.label)}">Delete</button>
                      </td>
                    </tr>
                  `;
                }).join("")}
              </tbody>
            </table>
          `}
        </section>
      `;
    }
  } else if (page === "cron-jobs") {
    const cronData = state.cache.cronJobs;
    if (cronData === null) {
      pageHtml = `<section class="card"><div class="muted">กำลังโหลด…</div></section>`;
    } else {
      const jobs = cronData || [];
      pageHtml = `
        <section class="card" style="margin-bottom:var(--sp-4)">
          <h3 class="section-title">${icon('clock')} Scheduled Jobs</h3>
          <p class="muted" style="font-size:0.85rem">กำหนดตารางเวลา และดูประวัติการทำงานของแต่ละงาน Admin เท่านั้น</p>
        </section>
        ${jobs.map(job => {
          const cfg = job.config;
          const lastRun = job.runs?.[0];
          const statusBadge = (status) => {
            if (status === "SUCCESS")  return `<span class="cron-badge cron-badge--success">${icon('checkCircle')} Success</span>`;
            if (status === "FAILURE")  return `<span class="cron-badge cron-badge--failure">${icon('xCircle')} Failed</span>`;
            if (status === "RUNNING")  return `<span class="cron-badge cron-badge--running">${icon('clock')} Running</span>`;
            return `<span class="cron-badge">—</span>`;
          };
          const triggerBadge = (t) => t === "MANUAL"
            ? `<span class="cron-trigger-badge cron-trigger-badge--manual">Manual</span>`
            : `<span class="cron-trigger-badge">Scheduled</span>`;
          const runsHtml = (job.runs || []).map(r => `
            <tr class="cron-run-row">
              <td class="cron-run-time">${new Date(r.startedAt).toLocaleString("th-TH", { dateStyle:"short", timeStyle:"short", timeZone:"Asia/Bangkok" })}</td>
              <td>${statusBadge(r.status)}</td>
              <td>${triggerBadge(r.triggeredBy)}</td>
              <td class="cron-run-summary muted">${escHtml(r.summary || "—")}</td>
              <td class="cron-run-dur muted">${r.completedAt ? Math.round((new Date(r.completedAt)-new Date(r.startedAt))/1000)+"s" : "—"}</td>
            </tr>`).join("");
          return `
          <section class="card cron-job-card" data-job-key="${job.jobKey}">
            <div class="cron-job-header">
              <div class="cron-job-info">
                <div class="cron-job-title-row">
                  <span class="cron-job-name">${escHtml(job.label)}</span>
                  ${lastRun ? statusBadge(lastRun.status) : ""}
                </div>
                <p class="cron-job-desc muted">${escHtml(job.description)}</p>
              </div>
              <div class="cron-job-actions">
                <button class="btn btn-secondary cron-run-now-btn" data-job-key="${job.jobKey}">▶ Run Now</button>
              </div>
            </div>

            <div class="cron-job-config">
              <div class="cron-config-inputs">
                <div class="cron-config-field">
                  <label class="cron-config-label">Schedule</label>
                  ${renderCronPicker({ jobKey: job.jobKey, cronExpr: cfg.cronExpr, defaultCronExpr: job.defaultCronExpr })}
                  <div class="cron-expr-preview" id="cron-preview-${job.jobKey}">${describeCron(cfg.cronExpr, cfg.timezone)}</div>
                </div>
              </div>
              <div class="cron-config-controls">
                <div class="cron-config-field cron-enabled-field">
                  <label class="cron-config-label">Enabled</label>
                  <label class="notif-switch" style="margin-top:4px">
                    <input type="checkbox" class="cron-enabled-check" data-job-key="${job.jobKey}" ${cfg.isEnabled ? "checked" : ""} />
                    <span class="notif-slider"></span>
                  </label>
                </div>
                <div class="cron-config-field" style="align-self:flex-end">
                  <button class="btn btn-primary cron-save-btn" data-job-key="${job.jobKey}">Save</button>
                  <span class="cron-save-status" id="cron-save-${job.jobKey}"></span>
                </div>
                <p class="muted cron-default-hint">Default: <code>${escHtml(job.defaultCronExpr)}</code> &nbsp;·&nbsp; Updated: ${cfg.updatedAt ? new Date(cfg.updatedAt).toLocaleString("th-TH",{dateStyle:"short",timeStyle:"short",timeZone: cfg.timezone || "Asia/Bangkok"}) : "—"}</p>
              </div>
            </div>

            <div class="cron-history-section">
              <div class="cron-history-toggle" data-job-key="${job.jobKey}">
                <span>ประวัติการทำงาน (${(job.runs||[]).length} รายการล่าสุด)</span>
                <span class="cron-history-arrow ${state.openCronHistories?.has(job.jobKey) ? "open" : ""}">▾</span>
              </div>
              ${state.openCronHistories?.has(job.jobKey) ? `
              <div class="cron-history-body">
                ${runsHtml ? `
                <table class="cron-runs-table">
                  <thead><tr>
                    <th>เวลา</th><th>สถานะ</th><th>ประเภท</th><th>สรุป</th><th>ใช้เวลา</th>
                  </tr></thead>
                  <tbody>${runsHtml}</tbody>
                </table>` : `<p class="muted" style="padding:var(--sp-3)">ยังไม่มีประวัติ</p>`}
                <button class="ghost small cron-load-more-btn" data-job-key="${job.jobKey}" style="margin:var(--sp-2) var(--sp-3)">Load more…</button>
              </div>` : ""}
            </div>
          </section>`;
        }).join("")}
      `;
    }
  }

  // ── Shell ─────────────────────────────────────────────────────
  const navCollapsed = state.settingsNavCollapsed;
  views.settings.innerHTML = `
    <div class="settings-layout ${navCollapsed ? "settings-nav-collapsed" : ""}">
      <nav class="settings-sidenav">
        <button class="settings-sidenav-collapser" id="settings-nav-toggle" title="${navCollapsed ? "Expand menu" : "Collapse menu"}">
          <svg class="collapser-icon" width="16" height="16" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            ${navCollapsed
              ? '<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M9 3v18"/><path d="M14 9l3 3-3 3"/>'
              : '<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M9 3v18"/><path d="M14 15l-3-3 3-3"/>'}
          </svg>
          <span class="collapser-label">${navCollapsed ? "Expand" : "Collapse"}</span>
        </button>
        <p class="settings-sidenav-label">PERSONAL</p>
        ${personalNavItems.map((item) => `
          <button class="settings-nav-item ${page === item.page ? "active" : ""}" data-settings-nav="${item.page}" title="${navCollapsed ? item.label : ""}">
            <span class="settings-nav-emoji" aria-hidden="true">${icon(item.ic, 16)}</span>
            <span class="settings-nav-label">${item.label}</span>
          </button>
        `).join("")}
        <p class="settings-sidenav-label" style="margin-top:var(--sp-3)">ORGANIZATION</p>
        ${navItems.map((item) => `
          <button class="settings-nav-item ${page === item.page ? "active" : ""}" data-settings-nav="${item.page}"${item.view ? ` data-view-target="${item.view}"` : ""} title="${navCollapsed ? item.label : ""}">
            <span class="settings-nav-emoji" aria-hidden="true">${icon(item.ic, 16)}</span>
            <span class="settings-nav-label">${item.label}</span>
          </button>
        `).join("")}
      </nav>
      <div class="settings-content">
        ${pageHtml}
      </div>
    </div>
  `;

  // ── My Profile page listeners ─────────────────────────────────
  qs("#profile-info-form")?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    try {
      const updated = await api("/auth/profile", {
        method: "PATCH",
        body: { fullName: fd.get("fullName"), email: fd.get("email") }
      });
      state.user = { ...state.user, ...updated };
      updateUserMeta();
      setStatus("Profile saved.");
      renderSettings();
    } catch (err) {
      setStatus(err.message, true);
    }
  });

  qs("#change-password-form")?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    const msgEl = qs("#pw-change-msg");
    if (fd.get("newPassword") !== fd.get("confirmPassword")) {
      if (msgEl) msgEl.innerHTML = `<span class="form-hint" style="color:var(--danger)">Passwords do not match.</span>`;
      return;
    }
    try {
      await api("/auth/change-password", {
        method: "POST",
        body: { currentPassword: fd.get("currentPassword"), newPassword: fd.get("newPassword") }
      });
      if (msgEl) msgEl.innerHTML = `<span class="form-hint" style="color:var(--success,oklch(50% 0.15 155))">Password changed successfully.</span>`;
      e.currentTarget.reset();
    } catch (err) {
      if (msgEl) msgEl.innerHTML = `<span class="form-hint" style="color:var(--danger)">${escHtml(err.message)}</span>`;
    }
  });

  // ── Avatar upload / remove ────────────────────────────────────
  qs("#profile-avatar-btn")?.addEventListener("click", () => qs("#profile-avatar-file")?.click());

  qs("#profile-avatar-file")?.addEventListener("change", async (e) => {
    const file = e.currentTarget.files?.[0];
    if (!file) return;
    const btn = qs("#profile-avatar-btn");
    if (btn) btn.style.opacity = "0.5";
    try {
      const fd = new FormData();
      fd.append("file", file);
      const res = await api("/auth/me/avatar", { method: "POST", body: fd });
      state.user = { ...state.user, avatarUrl: res.avatarUrl };
      updateUserMeta();
      renderSettings();
    } catch (err) {
      setStatus(err.message, true);
      if (btn) btn.style.opacity = "";
    }
  });

  qs("#profile-avatar-remove")?.addEventListener("click", async () => {
    try {
      await api("/auth/me/avatar", { method: "DELETE" });
      state.user = { ...state.user, avatarUrl: null };
      updateUserMeta();
      renderSettings();
    } catch (err) {
      setStatus(err.message, true);
    }
  });

  initPasskeySection();

  // ── Notification channel help panel toggle ───────────────────
  views.settings.querySelectorAll(".notif-channel-help-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      const panel = qs(`#notif-help-${btn.dataset.provider}`);
      if (panel) panel.hidden = !panel.hidden;
    });
  });

  // ── Notification channel connect/disconnect listeners ────────
  views.settings.querySelectorAll(".notif-channel-connect-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      const provider = btn.dataset.provider;
      const form = qs(`#notif-connect-form-${provider}`);
      if (form) form.style.display = form.style.display === "none" ? "block" : "none";
    });
  });

  views.settings.querySelectorAll(".notif-channel-cancel-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      const form = qs(`#notif-connect-form-${btn.dataset.provider}`);
      if (form) form.style.display = "none";
    });
  });

  views.settings.querySelectorAll(".notif-channel-save-btn").forEach(btn => {
    btn.addEventListener("click", async () => {
      const provider = btn.dataset.provider;
      const alias = btn.dataset.alias;
      const input = views.settings.querySelector(`.notif-channel-id-input[data-provider="${provider}"]`);
      const externalUserId = input?.value?.trim();
      if (!externalUserId) { setStatus("Please enter a User ID.", true); return; }
      const userId = state.user?.id;
      try {
        btn.disabled = true;
        await api(`/users/${userId}/integrations/${alias}/connect`, {
          method: "POST",
          body: { externalUserId }
        });
        await refreshMyIntegrations();
        renderSettings();
        setStatus("Channel connected.");
      } catch (err) {
        setStatus(err.message, true);
        btn.disabled = false;
      }
    });
  });

  views.settings.querySelectorAll(".notif-channel-disconnect-btn").forEach(btn => {
    btn.addEventListener("click", async () => {
      const provider = btn.dataset.provider;
      const alias = provider.toLowerCase().replace("_", "");
      const userId = state.user?.id;
      try {
        btn.disabled = true;
        await api(`/users/${userId}/integrations/${alias}`, { method: "DELETE" });
        await refreshMyIntegrations();
        renderSettings();
        setStatus("Channel disconnected.");
      } catch (err) {
        setStatus(err.message, true);
        btn.disabled = false;
      }
    });
  });

  views.settings.querySelectorAll(".notif-teams-dm-test-btn").forEach(btn => {
    btn.addEventListener("click", async () => {
      const userId = btn.dataset.userId;
      if (!userId) return;
      btn.disabled = true;
      btn.textContent = "Sending…";
      try {
        const res = await api(`/users/${userId}/test-teams-dm`, { method: "POST" });
        if (res.ok) {
          setStatus(res.message);
        } else {
          setStatus(res.message, true);
        }
      } catch (err) {
        setStatus(err.message, true);
      } finally {
        btn.disabled = false;
        btn.textContent = "Test DM";
      }
    });
  });

  // "go to profile" link in the notifications warning banner
  // ── Notification Preferences listeners ───────────────────────
  qs("#notif-save-btn")?.addEventListener("click", async () => {
    const btn = qs("#notif-save-btn");
    const st = qs("#notif-save-status");
    const prefs = {};
    views.settings.querySelectorAll(".notif-pref-check").forEach(cb => {
      prefs[cb.dataset.pref] = cb.checked;
    });
    if (btn) btn.disabled = true;
    try {
      await putNotifPrefs(prefs);
      if (st) { st.textContent = "Saved."; setTimeout(() => { st.textContent = ""; }, 2000); }
    } catch {
      if (st) { st.style.color = "var(--danger)"; st.textContent = "Failed to save."; setTimeout(() => { st.textContent = ""; st.style.color = ""; }, 3000); }
    } finally {
      if (btn) btn.disabled = false;
    }
  });

  // ── Integration section collapse toggles ─────────────────────
  views.settings.querySelectorAll("[data-intg-section]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const key = btn.dataset.intgSection;
      if (state.openIntgSections.has(key)) {
        state.openIntgSections.delete(key);
      } else {
        state.openIntgSections.add(key);
      }
      renderSettings();
    });
  });

  // ── Cron Jobs listeners ───────────────────────────────────────
  if (state.settingsPage === "cron-jobs") {
    // Friendly schedule picker + live preview
    (state.cache.cronJobs || []).forEach(job => {
      initCronPicker(views.settings, {
        jobKey: job.jobKey,
        onChange: (expr) => {
          const preview = qs(`#cron-preview-${job.jobKey}`);
          if (preview) preview.textContent = describeCron(expr, job.config?.timezone || "");
        },
      });
    });

    // Save button
    views.settings.querySelectorAll(".cron-save-btn").forEach(btn => {
      btn.addEventListener("click", async () => {
        const jobKey = btn.dataset.jobKey;
        const input = views.settings.querySelector(`.cron-expr-input[data-job-key="${jobKey}"]`);
        const check = views.settings.querySelector(`.cron-enabled-check[data-job-key="${jobKey}"]`);
        const statusEl = qs(`#cron-save-${jobKey}`);
        if (!input || !check) return;
        btn.disabled = true;
        if (statusEl) { statusEl.textContent = "Saving…"; statusEl.className = "cron-save-status"; }
        try {
          await api(`/cron-jobs/${jobKey}`, { method: "PUT", body: { cronExpr: input.value.trim(), isEnabled: check.checked } });
          // Refresh data
          state.cache.cronJobs = await api("/cron-jobs");
          if (statusEl) { statusEl.textContent = "Saved"; statusEl.className = "cron-save-status cron-save-ok"; }
          renderSettings();
        } catch (e) {
          if (statusEl) { statusEl.textContent = e.message || "Error"; statusEl.className = "cron-save-status cron-save-err"; }
        } finally {
          btn.disabled = false;
          setTimeout(() => { if (statusEl) statusEl.textContent = ""; }, 3000);
        }
      });
    });

    // Run Now button
    views.settings.querySelectorAll(".cron-run-now-btn").forEach(btn => {
      btn.addEventListener("click", async () => {
        const jobKey = btn.dataset.jobKey;
        btn.disabled = true;
        btn.textContent = "Running…";
        try {
          await api(`/cron-jobs/${jobKey}/trigger`, { method: "POST" });
          // Ensure history for this job is visible
          if (!state.openCronHistories) state.openCronHistories = new Set();
          state.openCronHistories.add(jobKey);

          // Poll until the run finishes (or 3-minute timeout)
          const deadline = Date.now() + 3 * 60 * 1000;
          const poll = async () => {
            state.cache.cronJobs = await api("/cron-jobs").catch(() => state.cache.cronJobs);
            renderSettings();
            const job = (state.cache.cronJobs || []).find(j => j.jobKey === jobKey);
            const lastRun = job?.runs?.[0];
            if (lastRun?.status === "RUNNING" && Date.now() < deadline) {
              setTimeout(poll, 2500);
            }
          };
          setTimeout(poll, 1500);
        } catch (e) {
          alert("Trigger failed: " + (e.message || "Unknown error"));
          btn.disabled = false;
          btn.textContent = "▶ Run Now";
        }
      });
    });

    // History toggle
    views.settings.querySelectorAll(".cron-history-toggle").forEach(toggle => {
      toggle.addEventListener("click", () => {
        const jobKey = toggle.dataset.jobKey;
        if (!state.openCronHistories) state.openCronHistories = new Set();
        if (state.openCronHistories.has(jobKey)) {
          state.openCronHistories.delete(jobKey);
        } else {
          state.openCronHistories.add(jobKey);
        }
        renderSettings();
      });
    });

    // Load more runs
    views.settings.querySelectorAll(".cron-load-more-btn").forEach(btn => {
      btn.addEventListener("click", async () => {
        const jobKey = btn.dataset.jobKey;
        const currentJob = (state.cache.cronJobs || []).find(j => j.jobKey === jobKey);
        const offset = currentJob?.runs?.length || 0;
        btn.disabled = true;
        btn.textContent = "Loading…";
        try {
          const more = await api(`/cron-jobs/${jobKey}/runs?limit=20&offset=${offset}`);
          if (currentJob && more.runs?.length) {
            currentJob.runs = [...(currentJob.runs || []), ...more.runs];
          }
          renderSettings();
        } catch { btn.disabled = false; btn.textContent = "Load more…"; }
      });
    });
  }

  // ── Custom Fields listeners ──────────────────────────────────
  if (state.settingsPage === "custom-fields") {
    const cfRefresh = async () => {
      try {
        const [pt, cu, it] = await Promise.all([
          api("/custom-fields/payment-term"),
          api("/custom-fields/customer"),
          api("/custom-fields/item")
        ]);
        state.cache.customFieldSettings = { "payment-term": pt, customer: cu, item: it };
        // Also invalidate master-data cache so list pages pick up changes
        state.cache.customFieldDefinitions = {
          "payment-terms": pt,
          customers: cu,
          items: it
        };
      } catch (err) {
        setStatus(err.message, true);
      }
      renderSettings();
    };

    views.settings.querySelectorAll(".cf-tab").forEach((btn) => {
      btn.addEventListener("click", () => {
        state.customFieldsEntityTab = btn.dataset.cfTab;
        renderSettings();
      });
    });

    const typeSelect = qs("#cf-create-type");
    const optionsWrap = views.settings.querySelector(".cf-options-wrap");
    const syncOptionsVisibility = () => {
      if (!typeSelect || !optionsWrap) return;
      const v = typeSelect.value;
      optionsWrap.style.display = v === "SELECT" || v === "MULTISELECT" ? "" : "none";
    };
    typeSelect?.addEventListener("change", syncOptionsVisibility);
    syncOptionsVisibility();

    qs("#cf-create-form")?.addEventListener("submit", async (e) => {
      e.preventDefault();
      const form = e.currentTarget;
      const fd = new FormData(form);
      const dataType = String(fd.get("dataType") || "TEXT");
      const options = String(fd.get("options") || "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      const payload = {
        fieldKey: String(fd.get("fieldKey") || "").trim(),
        label: String(fd.get("label") || "").trim(),
        dataType,
        isRequired: fd.get("isRequired") === "on",
        displayOrder: Number(fd.get("displayOrder") || 0),
        placeholder: String(fd.get("placeholder") || "").trim() || undefined
      };
      if (dataType === "SELECT" || dataType === "MULTISELECT") {
        payload.options = options;
      }
      const entity = form.dataset.entity;
      try {
        await api(`/custom-fields/${entity}`, { method: "POST", body: payload });
        setStatus("Custom field added.");
        await cfRefresh();
      } catch (err) {
        setStatus(err.message, true);
      }
    });

    views.settings.querySelectorAll(".cf-toggle-btn").forEach((btn) => {
      btn.addEventListener("click", async () => {
        try {
          await api(`/custom-fields/${btn.dataset.entity}/${btn.dataset.id}`, {
            method: "PATCH",
            body: { isActive: btn.dataset.active !== "true" }
          });
          await cfRefresh();
        } catch (err) {
          setStatus(err.message, true);
        }
      });
    });

    views.settings.querySelectorAll(".cf-delete-btn").forEach((btn) => {
      btn.addEventListener("click", async () => {
        if (!confirm(`Delete custom field "${btn.dataset.label}"? Existing records keep their values but the field is removed from forms.`)) return;
        try {
          await api(`/custom-fields/${btn.dataset.entity}/${btn.dataset.id}`, { method: "DELETE" });
          setStatus("Custom field deleted.");
          await cfRefresh();
        } catch (err) {
          setStatus(err.message, true);
        }
      });
    });

    views.settings.querySelectorAll(".cf-edit-btn").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const id = btn.dataset.id;
        const entity = btn.dataset.entity;
        const tabKey = entity;
        const def = (state.cache.customFieldSettings?.[tabKey] || []).find((d) => d.id === id);
        if (!def) return;
        const label = prompt("Label:", def.label);
        if (label === null) return;
        const order = prompt("Display order:", String(def.displayOrder ?? 0));
        if (order === null) return;
        const required = confirm("Required field? (OK = Yes, Cancel = No)");
        const placeholder = prompt("Placeholder / help text:", def.placeholder || "");
        if (placeholder === null) return;
        const body = {
          label: label.trim(),
          displayOrder: Number(order) || 0,
          isRequired: required,
          placeholder: placeholder.trim() || null
        };
        if (def.dataType === "SELECT" || def.dataType === "MULTISELECT") {
          const current = Array.isArray(def.optionsJson) ? def.optionsJson.join(", ") : "";
          const optInput = prompt("Options (comma separated):", current);
          if (optInput === null) return;
          body.options = optInput.split(",").map((s) => s.trim()).filter(Boolean);
          if (!body.options.length) {
            setStatus("SELECT/MULTISELECT fields require at least one option.", true);
            return;
          }
        }
        try {
          await api(`/custom-fields/${entity}/${id}`, { method: "PATCH", body });
          setStatus("Custom field updated.");
          await cfRefresh();
        } catch (err) {
          setStatus(err.message, true);
        }
      });
    });
  }

  // ── Custom Domain listeners ──────────────────────────────────
  qs("#cd-add-form")?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const msg = qs("#cd-msg");
    const btn = e.target.querySelector('button[type="submit"]');
    const domain = new FormData(e.target).get("domain")?.toString().trim().toLowerCase();
    if (!domain) return;
    btn.disabled = true;
    msg.textContent = "Saving…";
    msg.style.color = "";
    try {
      await api(`/tenants/${state.user.tenantId}/custom-domain`, { method: "PUT", body: { domain } });
      state.cache.customDomain = null; // force reload
      msg.textContent = "Domain added — follow the DNS instructions to verify.";
      msg.style.color = "var(--clr-success)";
      setTimeout(() => renderSettings(), 800);
    } catch (err) {
      msg.textContent = err.message || "Failed to add domain.";
      msg.style.color = "var(--clr-danger)";
      btn.disabled = false;
    }
  });

  qs("#cd-verify-btn")?.addEventListener("click", async () => {
    const msg = qs("#cd-msg");
    const btn = qs("#cd-verify-btn");
    btn.disabled = true;
    btn.textContent = "Verifying…";
    msg.textContent = "";
    try {
      const res = await api(`/tenants/${state.user.tenantId}/custom-domain/verify`, { method: "POST" });
      if (res.verified) {
        msg.textContent = "Domain verified successfully!";
        msg.style.color = "var(--clr-success)";
        state.cache.customDomain = null;
        setTimeout(() => renderSettings(), 800);
      } else {
        msg.textContent = "Verification failed — DNS records not found yet. This can take up to 48 hours.";
        msg.style.color = "var(--clr-warning)";
        state.cache.customDomain = null;
        setTimeout(() => renderSettings(), 1500);
      }
    } catch (err) {
      msg.textContent = err.message || "Verification failed.";
      msg.style.color = "var(--clr-danger)";
      btn.disabled = false;
      btn.textContent = "Verify Domain";
    }
  });

  qs("#cd-remove-btn")?.addEventListener("click", async () => {
    if (!confirm("Remove this custom domain? Users will no longer be able to access the app at this domain.")) return;
    const msg = qs("#cd-msg");
    try {
      await api(`/tenants/${state.user.tenantId}/custom-domain`, { method: "DELETE" });
      state.cache.customDomain = null;
      renderSettings();
      setStatus("Custom domain removed.");
    } catch (err) {
      if (msg) { msg.textContent = err.message || "Failed to remove."; msg.style.color = "var(--clr-danger)"; }
    }
  });

  // ── Sidebar nav ───────────────────────────────────────────────
  qs("#settings-nav-toggle")?.addEventListener("click", () => {
    state.settingsNavCollapsed = !state.settingsNavCollapsed;
    renderSettings();
  });

  views.settings.querySelectorAll("[data-settings-nav]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const nav = btn.dataset.settingsNav;
      const viewTarget = btn.dataset.viewTarget;
      // Cross-link items (e.g. Logs → Integration Logs view) jump out of Settings.
      if (viewTarget) {
        navigateToView(viewTarget);
        switchView(viewTarget);
        try {
          if (viewTarget === "integrations") await loadIntegrations();
        } catch (error) { setStatus(error.message, true); }
        return;
      }
      navigateToSettingsPage(nav);
      if (nav === "data-sync") await loadSyncData();
      if (nav === "team-structure") {
        try { state.cache.teams = await api("/teams"); } catch (_) { /* best-effort */ }
      }
      renderSettings();
    });
  });

  // ── Data Sync page listeners ────────────────────────────────────
  qs("#sync-create-key-btn")?.addEventListener("click", () => {
    const f = qs("#sync-new-key-form");
    if (f) f.style.display = f.style.display === "none" ? "block" : "none";
  });
  qs("#sync-key-cancel")?.addEventListener("click", () => {
    qs("#sync-new-key-form").style.display = "none";
  });
  qs("#sync-key-form")?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    const scopes = Array.from(fd.getAll("scopes"));
    const expiresInDays = fd.get("expiresInDays") ? Number(fd.get("expiresInDays")) : undefined;
    try {
      const result = await api("/sync/api-keys", {
        method: "POST",
        body: { label: fd.get("label"), scopes, expiresInDays }
      });
      qs("#sync-new-key-form").style.display = "none";
      qs("#sync-key-reveal").style.display = "block";
      qs("#sync-key-value").textContent = result.rawKey;
      await loadSyncData();
      renderSettings();
    } catch (err) { setStatus(err.message || "Failed to create key."); }
  });
  views.settings.querySelectorAll(".sync-revoke-key-btn").forEach(btn => {
    btn.addEventListener("click", async () => {
      if (!confirm("Revoke this API key? Any ERP using it will stop working.")) return;
      try {
        await api(`/sync/api-keys/${btn.dataset.keyId}/revoke`, { method: "PATCH" });
        await loadSyncData();
        renderSettings();
        setStatus("API key revoked.");
      } catch (err) { setStatus(err.message); }
    });
  });

  // Source CRUD
  qs("#sync-create-source-btn")?.addEventListener("click", () => {
    const f = qs("#sync-source-form-wrap");
    if (f) f.style.display = f.style.display === "none" ? "block" : "none";
  });
  qs("#sync-source-cancel")?.addEventListener("click", () => {
    qs("#sync-source-form-wrap").style.display = "none";
  });
  qs("#sync-source-form")?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    try {
      await api("/integrations/master-data/sources", {
        method: "POST",
        body: { sourceName: fd.get("sourceName"), sourceType: fd.get("sourceType"), configJson: {} }
      });
      qs("#sync-source-form-wrap").style.display = "none";
      await loadSyncData();
      renderSettings();
      setStatus("Source created.");
    } catch (err) { setStatus(err.message || "Failed to create source."); }
  });
  views.settings.querySelectorAll(".sync-toggle-source-btn").forEach(btn => {
    btn.addEventListener("click", async () => {
      const newStatus = btn.dataset.currentStatus === "ENABLED" ? "DISABLED" : "ENABLED";
      try {
        await api(`/integrations/master-data/sources/${btn.dataset.sourceId}`, {
          method: "PATCH",
          body: { status: newStatus }
        });
        await loadSyncData();
        renderSettings();
      } catch (err) { setStatus(err.message); }
    });
  });

  // Mapping editor
  views.settings.querySelectorAll(".sync-edit-mappings-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      const sourceId = btn.dataset.sourceId;
      const source = (state.cache.syncSources || []).find(s => s.id === sourceId);
      qs("#sync-mapping-editor").style.display = "block";
      qs("#sync-mapping-source-name").textContent = btn.dataset.sourceName;
      qs("#sync-mapping-source-id").value = sourceId;
      const rows = (source?.mappings || []).map((m, i) => syncMappingRowHtml(i, m)).join("");
      qs("#sync-mapping-rows").innerHTML = rows || syncMappingRowHtml(0);
    });
  });
  qs("#sync-mapping-close")?.addEventListener("click", () => {
    qs("#sync-mapping-editor").style.display = "none";
  });
  qs("#sync-mapping-add-row")?.addEventListener("click", () => {
    const container = qs("#sync-mapping-rows");
    const idx = container.querySelectorAll(".sync-mapping-row").length;
    container.insertAdjacentHTML("beforeend", syncMappingRowHtml(idx));
  });
  qs("#sync-mapping-form")?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const sourceId = qs("#sync-mapping-source-id").value;
    const rowEls = e.currentTarget.querySelectorAll(".sync-mapping-row");
    const mappings = [];
    rowEls.forEach(row => {
      const et = row.querySelector("[name=entityType]")?.value;
      const sf = row.querySelector("[name=sourceField]")?.value?.trim();
      const tf = row.querySelector("[name=targetField]")?.value?.trim();
      const tr = row.querySelector("[name=transformRule]")?.value?.trim() || undefined;
      const req = row.querySelector("[name=isRequired]")?.checked || false;
      if (et && sf && tf) mappings.push({ entityType: et, sourceField: sf, targetField: tf, transformRule: tr, isRequired: req });
    });
    try {
      await api(`/integrations/master-data/sources/${sourceId}/mappings`, {
        method: "PUT",
        body: { mappings }
      });
      qs("#sync-mapping-editor").style.display = "none";
      await loadSyncData();
      renderSettings();
      setStatus("Mappings saved.");
    } catch (err) { setStatus(err.message || "Failed to save mappings."); }
  });

  // Sync job detail
  views.settings.querySelectorAll(".sync-view-job-btn").forEach(btn => {
    btn.addEventListener("click", async () => {
      try {
        const job = await api(`/sync/jobs/${btn.dataset.jobId}`);
        const errHtml = (job.errors || []).map(e =>
          `<tr><td>${escHtml(e.rowRef)}</td><td><code>${escHtml(e.errorCode)}</code></td><td>${escHtml(e.errorMessage)}</td></tr>`
        ).join("");
        const overlay = document.createElement("div");
        overlay.className = "popup-overlay";
        overlay.innerHTML = `
          <div class="popup-box popup-box--wide" role="dialog" aria-modal="true">
            <div class="popup-header">
              <p class="popup-title">Sync Job Detail</p>
              <button class="popup-close-btn" aria-label="Close">${icon('x', 14)}</button>
            </div>
            <div style="padding:var(--sp-3)">
              <p><strong>Status:</strong> ${escHtml(job.status)} &nbsp; <strong>Source:</strong> ${escHtml(job.source?.sourceName ?? "—")} &nbsp; <strong>Type:</strong> ${escHtml(job.runType)}</p>
              <p><strong>Started:</strong> ${new Date(job.startedAt).toLocaleString()} ${job.finishedAt ? " — <strong>Finished:</strong> " + new Date(job.finishedAt).toLocaleString() : ""}</p>
              ${errHtml ? `
                <h5 style="margin-top:var(--sp-3)">Errors</h5>
                <table class="data-table" style="font-size:0.82rem">
                  <thead><tr><th>Row</th><th>Code</th><th>Message</th></tr></thead>
                  <tbody>${errHtml}</tbody>
                </table>
              ` : '<p class="muted" style="margin-top:var(--sp-3)">No errors.</p>'}
            </div>
          </div>`;
        document.body.appendChild(overlay);
        overlay.querySelector(".popup-close-btn").addEventListener("click", () => overlay.remove());
        overlay.addEventListener("click", (ev) => { if (ev.target === overlay) overlay.remove(); });
      } catch (err) { setStatus(err.message); }
    });
  });

  // ── Roles page listeners ──────────────────────────────────────
  qs("#rp-info-toggle")?.addEventListener("click", () => {
    state.roleInfoExpanded = !state.roleInfoExpanded;
    renderSettings();
  });

  wireDelegationsListeners(views.settings);

  qs("#rp-search")?.addEventListener("input", (e) => {
    state.rolePageQuery = e.target.value;
    renderSettings();
  });

  qs("#rp-team-filter")?.addEventListener("change", (e) => {
    state.rolePageTeam = e.target.value;
    renderSettings();
  });

  qs("#rp-refresh-btn")?.addEventListener("click", async () => {
    setStatus("Refreshing…");
    await loadSettings();
    setStatus("");
  });

  // ── Invite User (S4) ───────────────────────────────────────────
  qs("#rp-invite-btn")?.addEventListener("click", () => {
    const teamOpts = (state.cache.teams || []).map(t =>
      `<option value="${t.id}">${escHtml(t.teamName)}</option>`
    ).join("");

    const overlay = document.createElement("div");
    overlay.className = "popup-overlay";
    overlay.innerHTML = `
      <div class="popup-box popup-box--wide" role="dialog" aria-modal="true">
        <div class="popup-header">
          <p class="popup-title">Invite User</p>
          <button class="popup-close-btn" aria-label="Close">${icon('x', 14)}</button>
        </div>
        <form id="invite-user-form" style="display:flex;flex-direction:column;gap:var(--sp-3);padding:var(--sp-3) 0">
          <label class="form-label">Full name <input class="form-input" name="fullName" type="text" required placeholder="Jane Smith" autocomplete="name" minlength="2" maxlength="120" /></label>
          <label class="form-label">Email <input class="form-input" name="email" type="email" required placeholder="colleague@company.com" /></label>
          <label class="form-label">Role
            <select class="form-input" name="role">
              <option value="REP">Sales Rep</option>
              <option value="SALES_ADMIN">Sales Admin</option>
              <option value="SUPERVISOR">Supervisor</option>
              <option value="ASSISTANT_MANAGER">Assistant Manager</option>
              <option value="MANAGER">Sales Manager</option>
              <option value="DIRECTOR">Sales Director</option>
              <option value="ADMIN">Admin</option>
            </select>
          </label>
          <label class="form-label">Team name (optional)
            <select class="form-input" name="teamId">
              <option value="">— No team —</option>
              ${teamOpts}
            </select>
            ${(state.cache.teams || []).length === 0 ? '<span class="muted small" style="margin-top:4px">No teams yet — create them in Team Structure first.</span>' : ""}
          </label>
          <p class="invite-form-msg muted small" style="min-height:1.2em"></p>
          <div class="popup-actions">
            <button type="button" class="popup-cancel-btn">Cancel</button>
            <button type="submit">Send Invite</button>
          </div>
        </form>
      </div>`;
    document.body.appendChild(overlay);
    requestAnimationFrame(() => overlay.classList.add("popup-visible"));

    const close = () => {
      overlay.classList.remove("popup-visible");
      overlay.addEventListener("transitionend", () => overlay.remove(), { once: true });
    };
    overlay.querySelector(".popup-close-btn").addEventListener("click", close);
    overlay.querySelector(".popup-cancel-btn").addEventListener("click", close);
    overlay.addEventListener("click", (e) => { if (e.target === overlay) close(); });

    overlay.querySelector("#invite-user-form").addEventListener("submit", async (e) => {
      e.preventDefault();
      const form = e.target;
      const msg = overlay.querySelector(".invite-form-msg");
      const btn = form.querySelector('button[type="submit"]');
      const email = form.email.value.trim();
      const fullName = form.fullName.value.trim();
      const role = form.role.value;
      const teamId = form.teamId.value || undefined;
      btn.disabled = true;
      msg.textContent = "Sending…";
      msg.className = "invite-form-msg muted small";
      try {
        const res = await api("/users/invite", { method: "POST", body: { email, fullName, role, teamId } });
        msg.textContent = res.emailSent
          ? `Invite sent to ${email}.`
          : `Invite created (email delivery not configured). Share this link: ${res.acceptUrl || ""}`;
        msg.style.color = "var(--clr-success)";
        btn.textContent = "Done";
        btn.disabled = true;
        setTimeout(() => { close(); loadSettings(); }, 1500);
      } catch (err) {
        msg.textContent = err.message || "Failed to send invite.";
        msg.style.color = "var(--clr-danger)";
        btn.disabled = false;
      }
    });
  });

  qs("#rp-import-history-btn")?.addEventListener("click", () => openImportHistoryModal("users", "User Import History"));
  qs("#kpi-import-history-btn")?.addEventListener("click", () => openImportHistoryModal("kpi", "KPI Target Import History"));

  // ── Import Users (S12) ──────────────────────────────────────────
  qs("#rp-import-btn")?.addEventListener("click", () => {
    const overlay = document.createElement("div");
    overlay.className = "popup-overlay";
    overlay.innerHTML = `
      <div class="popup-box popup-box--wide" role="dialog" aria-modal="true">
        <div class="popup-header">
          <p class="popup-title">Import Users</p>
          <button class="popup-close-btn" aria-label="Close">${icon('x', 14)}</button>
        </div>
        <div style="padding:var(--sp-3) 0;display:flex;flex-direction:column;gap:var(--sp-3)">
          <p class="muted small">Upload an Excel (.xlsx) file. Required columns: <code>email</code>, <code>fullName</code>, <code>role</code> (REP, SALES_ADMIN, SUPERVISOR, ASSISTANT_MANAGER, MANAGER, DIRECTOR, ADMIN). Optional: <code>teamName</code>.</p>
          <div class="inline-actions">
            <button class="ghost small import-template-btn" type="button">⬇ Download Template</button>
          </div>
          <input type="file" id="import-file-input" accept=".xlsx,.xls" style="font-size:0.85rem" />
          <p class="import-form-msg muted small" style="min-height:1.2em"></p>
          <div class="import-results" hidden></div>
          <div class="popup-actions">
            <button class="popup-cancel-btn">Cancel</button>
            <button class="import-submit-btn" disabled>Import</button>
          </div>
        </div>
      </div>`;
    document.body.appendChild(overlay);
    requestAnimationFrame(() => overlay.classList.add("popup-visible"));

    const close = () => {
      overlay.classList.remove("popup-visible");
      overlay.addEventListener("transitionend", () => overlay.remove(), { once: true });
    };
    overlay.querySelector(".popup-close-btn").addEventListener("click", close);
    overlay.querySelector(".popup-cancel-btn").addEventListener("click", close);
    overlay.addEventListener("click", (e) => { if (e.target === overlay) close(); });

    let parsedUsers = null;
    const fileInput = overlay.querySelector("#import-file-input");
    const submitBtn = overlay.querySelector(".import-submit-btn");
    const msg = overlay.querySelector(".import-form-msg");
    const resultsDiv = overlay.querySelector(".import-results");
    const templateBtn = overlay.querySelector(".import-template-btn");

    templateBtn?.addEventListener("click", () => {
      const sample = [
        { email: "rep@example.com",        fullName: "John Doe",   role: "REP",        teamName: "Bangkok North" },
        { email: "supervisor@example.com", fullName: "Alice Sup",  role: "SUPERVISOR", teamName: "Bangkok North" },
        { email: "manager@example.com",    fullName: "Jane Mgr",   role: "MANAGER",    teamName: "" },
        { email: "director@example.com",   fullName: "Bob Dir",    role: "DIRECTOR",   teamName: "" }
      ];
      const ws = XLSX.utils.json_to_sheet(sample, { header: ["email", "fullName", "role", "teamName"] });
      ws["!cols"] = [{ wch: 28 }, { wch: 22 }, { wch: 12 }, { wch: 22 }];
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, "Users");
      XLSX.writeFile(wb, "user-import-template.xlsx");
    });

    fileInput.addEventListener("change", async () => {
      const file = fileInput.files[0];
      if (!file) { submitBtn.disabled = true; parsedUsers = null; return; }
      try {
        const buf = await file.arrayBuffer();
        const wb = XLSX.read(buf, { type: "array" });
        const sheetName = wb.SheetNames[0];
        if (!sheetName) throw new Error("Excel file has no sheets.");
        const rows = XLSX.utils.sheet_to_json(wb.Sheets[sheetName], { defval: "", raw: false });
        const normalized = rows
          .map((r) => {
            const out = {};
            for (const k of Object.keys(r)) {
              const v = r[k];
              if (v === "" || v == null) continue;
              out[String(k).trim()] = typeof v === "string" ? v.trim() : v;
            }
            if (out.role) out.role = String(out.role).toUpperCase();
            return out;
          })
          .filter((r) => r.email);
        if (!normalized.length) throw new Error("No rows with an email column found.");
        parsedUsers = normalized;
        msg.textContent = `${normalized.length} user(s) found in file.`;
        msg.style.color = "";
        submitBtn.disabled = false;
      } catch (err) {
        msg.textContent = err.message || "Could not read Excel file.";
        msg.style.color = "var(--clr-danger)";
        submitBtn.disabled = true;
        parsedUsers = null;
      }
    });

    submitBtn.addEventListener("click", async () => {
      if (!parsedUsers) return;
      submitBtn.disabled = true;
      msg.textContent = "Importing…";
      msg.style.color = "";
      try {
        const res = await api("/users/import", { method: "POST", body: { users: parsedUsers } });
        msg.textContent = `Done — ${res.created} created, ${res.errors} error(s).`;
        msg.style.color = res.errors ? "var(--clr-warning)" : "var(--clr-success)";
        if (res.errorDetails?.length) {
          resultsDiv.hidden = false;
          resultsDiv.innerHTML = `<div class="small" style="max-height:200px;overflow:auto;background:var(--clr-surface);padding:var(--sp-2);border-radius:6px">`
            + res.errorDetails.map(e => `<div style="color:var(--clr-danger)">Row ${e.row}: ${escHtml(e.error)}</div>`).join("")
            + `</div>`;
        }
        if (res.created > 0) {
          setTimeout(() => loadSettings(), 1000);
        }
      } catch (err) {
        msg.textContent = err.message || "Import failed.";
        msg.style.color = "var(--clr-danger)";
        submitBtn.disabled = false;
      }
    });
  });

  // Keep the Team Structure view in sync after inline role/team/manager edits
  // in the Roles page — otherwise users have to F5 to see the change reflected.
  const refreshTeamsCache = async () => {
    try { state.cache.teams = await api("/teams"); } catch (_) { /* best-effort */ }
  };

  views.settings.querySelectorAll(".rp-role-select").forEach((sel) => {
    sel.addEventListener("change", async () => {
      const uid = sel.dataset.uid;
      const newRole = sel.value;
      const prevRole = sel.dataset.currentRole;
      try {
        const user = state.cache.allUsers.find(u => u.id === uid);
        await api(`/users/${uid}`, {
          method: "PATCH",
          body: { fullName: user.fullName, email: user.email, role: newRole, managerUserId: user.managerUserId ?? null }
        });
        setStatus(`Role updated to ${newRole}.`);
        await refreshTeamsCache();
        // If role changed away from/to REP/SUPERVISOR, refresh so Reports To column updates
        if (prevRole !== newRole && (prevRole === "REP" || prevRole === "SUPERVISOR" || newRole === "REP" || newRole === "SUPERVISOR")) {
          await loadSettings();
        } else {
          const u = state.cache.allUsers.find(u => u.id === uid);
          if (u) u.role = newRole;
          renderSettings();
        }
      } catch (error) {
        setStatus(error.message, true);
        sel.value = prevRole; // revert
      }
    });
  });

  views.settings.querySelectorAll(".rp-reports-select").forEach((sel) => {
    sel.addEventListener("change", async () => {
      const uid = sel.dataset.uid;
      const managerId = sel.value || null;
      try {
        await api(`/users/${uid}/manager`, { method: "PUT", body: { managerUserId: managerId } });
        setStatus("Reports To updated.");
        const u = state.cache.allUsers.find(u => u.id === uid);
        if (u) u.managerUserId = managerId;
        await refreshTeamsCache();
      } catch (error) {
        setStatus(error.message, true);
        await loadSettings();
      }
    });
  });

  views.settings.querySelectorAll(".rp-team-select").forEach((sel) => {
    sel.addEventListener("change", async () => {
      const uid = sel.dataset.uid;
      const prev = sel.dataset.currentTeam || "";
      const newTeamId = sel.value || null;
      const user = state.cache.allUsers.find(u => u.id === uid);
      if (!user) return;
      try {
        await api(`/users/${uid}`, {
          method: "PATCH",
          body: {
            fullName: user.fullName,
            email: user.email,
            role: user.role,
            managerUserId: user.managerUserId ?? null,
            teamId: newTeamId
          }
        });
        user.teamId = newTeamId;
        sel.dataset.currentTeam = newTeamId || "";
        setStatus(newTeamId ? "Team updated." : "Team cleared.");
        await refreshTeamsCache();
      } catch (error) {
        setStatus(error.message, true);
        sel.value = prev;
      }
    });
  });

  // ── Admin passkey management ─────────────────────────────────
  views.settings.querySelectorAll(".passkey-admin-btn").forEach(btn => {
    btn.addEventListener("click", () => openAdminPasskeyModal(btn.dataset.uid, btn.dataset.name));
  });

  // ── Company listeners ─────────────────────────────────────────
  // Collapsible section toggles (company page)
  qs(".settings-content")?.querySelectorAll(".settings-section-toggle").forEach((btn) => {
    btn.addEventListener("click", () => {
      const section = btn.closest(".settings-collapsible");
      if (!section) return;
      if (section.hasAttribute("data-collapsed")) {
        section.removeAttribute("data-collapsed");
      } else {
        section.setAttribute("data-collapsed", "true");
      }
    });
  });

  qs("#company-form")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const name = new FormData(event.currentTarget).get("name");
    try {
      await api(`/tenants/${tenantId}`, { method: "PATCH", body: { name } });
      setStatus("Company name updated.");
      await loadSettings();
    } catch (error) {
      setStatus(error.message, true);
    }
  });

  qs("#currency-form")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const code = new FormData(event.currentTarget).get("currency");
    if (!code) return;
    localStorage.setItem(CURRENCY_STORAGE_KEY, code);
    try {
      const updatedBranding = { ...state.cache.branding, currency: code };
      await api(`/tenants/${tenantId}/branding`, { method: "PUT", body: updatedBranding });
      state.cache.branding = updatedBranding;
      setStatus(`Currency set to ${code}.`);
      if (state.cache.kanban) renderDeals(state.cache.kanban);
      if (state.cache.dashboard) renderDashboard(state.cache.dashboard);
    } catch {
      setStatus(`Currency set to ${code} (saved locally).`);
      if (state.cache.kanban) renderDeals(state.cache.kanban);
    }
  });

  qs("#timezone-form")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const timezone = new FormData(event.currentTarget).get("timezone");
    if (!timezone) return;
    try {
      const name = state.cache.tenantInfo?.name;
      await api(`/tenants/${tenantId}`, { method: "PATCH", body: { name, timezone } });
      if (state.cache.tenantInfo) state.cache.tenantInfo.timezone = timezone;
      setStatus(`Timezone set to ${timezone}.`);
    } catch (error) {
      setStatus(error.message, true);
    }
  });

  qs("#tax-form")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const fd = new FormData(event.currentTarget);
    try {
      await api(`/tenants/${tenantId}/tax-config`, {
        method: "PUT",
        body: { vatEnabled: fd.get("vatEnabled") === "on", vatRatePercent: Number(fd.get("vatRatePercent")) }
      });
      setStatus("Tax config saved.");
      await loadSettings();
    } catch (error) {
      setStatus(error.message, true);
    }
  });

  qs("#extend-trial-form")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const msgEl = qs("#extend-trial-msg");
    const btn   = event.currentTarget.querySelector("button[type='submit']");
    const days  = parseInt(qs("#extend-trial-days")?.value || "0", 10);
    if (!days || days < 1 || days > 90) {
      msgEl.textContent = "Enter a number between 1 and 90.";
      msgEl.style.color = "var(--danger)";
      return;
    }
    btn.disabled = true;
    try {
      const res = await api(`/tenants/${tenantId}/extend-trial`, { method: "PATCH", body: { days } });
      msgEl.textContent = res.message;
      msgEl.style.color = "var(--success)";
      // Update in-memory subscription so the banner refreshes
      if (state.user?.subscription) {
        state.user.subscription.trialEndsAt = res.trialEndsAt;
        showTrialBanner(state.user.subscription);
      }
      await loadSettings();
    } catch (error) {
      msgEl.textContent = error.message;
      msgEl.style.color = "var(--danger)";
    } finally {
      btn.disabled = false;
    }
  });

  qs("#visit-config-form")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const fd = new FormData(event.currentTarget);
    try {
      await api(`/tenants/${tenantId}/visit-config`, {
        method: "PUT",
        body: {
          checkInMaxDistanceM: Number(fd.get("checkInMaxDistanceM")),
          minVisitDurationMinutes: Number(fd.get("minVisitDurationMinutes"))
        }
      });
      setStatus("Visit settings saved.");
      await loadSettings();
    } catch (error) {
      setStatus(error.message, true);
    }
  });

  const kpiForm = qs("#kpi-form");
  if (kpiForm) {
    const repSelect = kpiForm.querySelector('select[name="userId"]');
    if (repSelect && defaultRepId) repSelect.value = defaultRepId;
    kpiForm.addEventListener("submit", async (event) => {
      event.preventDefault();
      const payload = Object.fromEntries(new FormData(event.currentTarget).entries());
      try {
        await api("/kpi-targets", {
          method: "POST",
          body: { ...payload, visitTargetCount: Number(payload.visitTargetCount), newDealValueTarget: Number(payload.newDealValueTarget), revenueTarget: Number(payload.revenueTarget) }
        });
        setStatus("KPI target created.");
        await loadSettings();
        await loadDashboard();
      } catch (error) {
        setStatus(error.message, true);
      }
    });
  }

  qs("#kpi-template-btn")?.addEventListener("click", () => {
    const reps = Array.isArray(state.cache.salesReps) ? state.cache.salesReps : [];
    const targets = Array.isArray(state.cache.kpiTargets) ? state.cache.kpiTargets : [];
    const currentMonth = new Date().toISOString().slice(0, 7);
    const rows = [];
    for (const t of targets) {
      if (!t.rep?.email) continue;
      rows.push({
        email: t.rep.email,
        fullName: t.rep.fullName || "",
        targetMonth: t.targetMonth,
        visitTargetCount: t.visitTargetCount,
        newDealValueTarget: t.newDealValueTarget,
        revenueTarget: t.revenueTarget
      });
    }
    const repsWithHistory = new Set(rows.map((r) => r.email.toLowerCase()));
    for (const rep of reps) {
      if (!rep.email || repsWithHistory.has(rep.email.toLowerCase())) continue;
      rows.push({
        email: rep.email,
        fullName: rep.fullName || "",
        targetMonth: currentMonth,
        visitTargetCount: 0,
        newDealValueTarget: 0,
        revenueTarget: 0
      });
    }
    rows.sort((a, b) => (a.email.localeCompare(b.email) || b.targetMonth.localeCompare(a.targetMonth)));
    if (!rows.length) {
      rows.push({ email: "rep@example.com", fullName: "Example Rep", targetMonth: currentMonth, visitTargetCount: 20, newDealValueTarget: 500000, revenueTarget: 300000 });
    }
    const header = ["email", "fullName", "targetMonth", "visitTargetCount", "newDealValueTarget", "revenueTarget"];
    const ws = XLSX.utils.json_to_sheet(rows, { header });
    ws["!cols"] = [{ wch: 28 }, { wch: 22 }, { wch: 12 }, { wch: 14 }, { wch: 20 }, { wch: 16 }];
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "KPI Targets");
    XLSX.writeFile(wb, `kpi-target-template-${currentMonth}.xlsx`);
  });

  qs("#kpi-import-btn")?.addEventListener("click", () => {
    const overlay = document.createElement("div");
    overlay.className = "popup-overlay";
    overlay.innerHTML = `
      <div class="popup-box popup-box--wide" role="dialog" aria-modal="true">
        <div class="popup-header">
          <p class="popup-title">Import KPI Targets</p>
          <button class="popup-close-btn" aria-label="Close">${icon('x', 14)}</button>
        </div>
        <div style="padding:var(--sp-3) 0;display:flex;flex-direction:column;gap:var(--sp-3)">
          <p class="muted small">Upload an Excel (.xlsx) file. Required columns: <code>email</code>, <code>targetMonth</code> (YYYY-MM), <code>visitTargetCount</code>, <code>newDealValueTarget</code>, <code>revenueTarget</code>. Existing rows for the same rep + month are overwritten.</p>
          <input type="file" id="kpi-import-file" accept=".xlsx,.xls" style="font-size:0.85rem" />
          <p class="kpi-import-msg muted small" style="min-height:1.2em"></p>
          <div class="kpi-import-results" hidden></div>
          <div class="popup-actions">
            <button class="popup-cancel-btn">Cancel</button>
            <button class="kpi-import-submit-btn" disabled>Import</button>
          </div>
        </div>
      </div>`;
    document.body.appendChild(overlay);
    requestAnimationFrame(() => overlay.classList.add("popup-visible"));
    const close = () => {
      overlay.classList.remove("popup-visible");
      overlay.addEventListener("transitionend", () => overlay.remove(), { once: true });
    };
    overlay.querySelector(".popup-close-btn").addEventListener("click", close);
    overlay.querySelector(".popup-cancel-btn").addEventListener("click", close);
    overlay.addEventListener("click", (e) => { if (e.target === overlay) close(); });

    const fileInput = overlay.querySelector("#kpi-import-file");
    const submitBtn = overlay.querySelector(".kpi-import-submit-btn");
    const msg = overlay.querySelector(".kpi-import-msg");
    const resultsDiv = overlay.querySelector(".kpi-import-results");
    let parsedRows = null;

    fileInput.addEventListener("change", async () => {
      const file = fileInput.files[0];
      if (!file) { submitBtn.disabled = true; parsedRows = null; return; }
      try {
        const buf = await file.arrayBuffer();
        const wb = XLSX.read(buf, { type: "array" });
        const sheetName = wb.SheetNames[0];
        if (!sheetName) throw new Error("Excel file has no sheets.");
        const rows = XLSX.utils.sheet_to_json(wb.Sheets[sheetName], { defval: "", raw: false });
        const normalized = rows
          .map((r) => {
            const out = {};
            for (const k of Object.keys(r)) {
              const v = r[k];
              if (v === "" || v == null) continue;
              out[String(k).trim()] = typeof v === "string" ? v.trim() : v;
            }
            return out;
          })
          .filter((r) => r.email && r.targetMonth)
          .map((r) => ({
            email: String(r.email).toLowerCase(),
            targetMonth: String(r.targetMonth).slice(0, 7),
            visitTargetCount: Number(r.visitTargetCount ?? 0),
            newDealValueTarget: Number(r.newDealValueTarget ?? 0),
            revenueTarget: Number(r.revenueTarget ?? 0)
          }));
        if (!normalized.length) throw new Error("No rows with email + targetMonth found.");
        parsedRows = normalized;
        msg.textContent = `${normalized.length} row(s) found in file.`;
        msg.style.color = "";
        submitBtn.disabled = false;
      } catch (err) {
        msg.textContent = err.message || "Could not read Excel file.";
        msg.style.color = "var(--clr-danger)";
        submitBtn.disabled = true;
        parsedRows = null;
      }
    });

    submitBtn.addEventListener("click", async () => {
      if (!parsedRows) return;
      submitBtn.disabled = true;
      msg.textContent = "Importing…";
      msg.style.color = "";
      try {
        const res = await api("/kpi-targets/import", { method: "POST", body: { targets: parsedRows } });
        msg.textContent = `Done — ${res.imported} imported, ${res.errors} error(s).`;
        msg.style.color = res.errors ? "var(--clr-warning)" : "var(--clr-success)";
        if (res.errorDetails?.length) {
          resultsDiv.hidden = false;
          resultsDiv.innerHTML = `<div class="small" style="max-height:200px;overflow:auto;background:var(--clr-surface);padding:var(--sp-2);border-radius:6px">`
            + res.errorDetails.map((e) => `<div style="color:var(--clr-danger)">Row ${e.row}${e.email ? ` (${escHtml(e.email)})` : ""}: ${escHtml(e.error)}</div>`).join("")
            + `</div>`;
        }
        if (res.imported > 0) {
          setTimeout(() => { loadSettings(); loadDashboard(); }, 800);
        }
      } catch (err) {
        msg.textContent = err.message || "Import failed.";
        msg.style.color = "var(--clr-danger)";
        submitBtn.disabled = false;
      }
    });
  });

  // ── KPI bulk-select toolbar (Delete / Copy to Next Month) ────────────
  (function initKpiBulkToolbar() {
    const toolbar      = views.settings.querySelector("#kpi-bulk-toolbar");
    const countEl      = views.settings.querySelector("#kpi-selected-count");
    const selectAll    = views.settings.querySelector("#kpi-select-all");
    const rowChecks    = views.settings.querySelectorAll(".kpi-row-select");
    const deleteBtn    = views.settings.querySelector("#kpi-bulk-delete-btn");
    const copyNextBtn  = views.settings.querySelector("#kpi-bulk-copy-btn");
    if (!toolbar || !rowChecks.length) return;

    function selectedIds() {
      return Array.from(rowChecks).filter((cb) => cb.checked).map((cb) => cb.value);
    }
    function refreshToolbar() {
      const ids = selectedIds();
      toolbar.hidden = ids.length === 0;
      if (countEl) countEl.textContent = `${ids.length} selected`;
      if (selectAll) {
        selectAll.checked = ids.length > 0 && ids.length === rowChecks.length;
        selectAll.indeterminate = ids.length > 0 && ids.length < rowChecks.length;
      }
    }

    selectAll?.addEventListener("change", () => {
      rowChecks.forEach((cb) => { cb.checked = selectAll.checked; });
      refreshToolbar();
    });
    rowChecks.forEach((cb) => cb.addEventListener("change", refreshToolbar));

    deleteBtn?.addEventListener("click", async () => {
      const ids = selectedIds();
      if (!ids.length) return;
      if (!confirm(`Delete ${ids.length} KPI target${ids.length === 1 ? "" : "s"}? This cannot be undone.`)) return;
      try {
        await api("/kpi-targets/bulk-delete", { method: "POST", body: { ids } });
        setStatus(`Deleted ${ids.length} KPI target${ids.length === 1 ? "" : "s"}.`);
        await loadSettings();
      } catch (error) {
        setStatus(error.message, true);
      }
    });

    copyNextBtn?.addEventListener("click", async () => {
      const ids = selectedIds();
      if (!ids.length) return;
      try {
        const res = await api("/kpi-targets/copy-to-next-month", { method: "POST", body: { ids } });
        const parts = [`Copied ${res.copied}`];
        if (res.skipped) parts.push(`skipped ${res.skipped} (already exists)`);
        setStatus(parts.join(", ") + ".");
        await loadSettings();
      } catch (error) {
        setStatus(error.message, true);
      }
    });
  })();

  views.settings.querySelectorAll(".kpi-edit").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const targetMonth = prompt("Target month (YYYY-MM)", btn.dataset.targetMonth || "");
      if (!targetMonth) return;
      const visitTargetCount = prompt("Visit target", btn.dataset.visitTarget || "0");
      if (visitTargetCount == null) return;
      const newDealValueTarget = prompt("New deal value target", btn.dataset.newDealTarget || "0");
      if (newDealValueTarget == null) return;
      const revenueTarget = prompt("Revenue target", btn.dataset.revenueTarget || "0");
      if (revenueTarget == null) return;
      try {
        await api(`/kpi-targets/${btn.dataset.id}`, {
          method: "PATCH",
          body: { userId: btn.dataset.userId, targetMonth: targetMonth.trim(), visitTargetCount: Number(visitTargetCount), newDealValueTarget: Number(newDealValueTarget), revenueTarget: Number(revenueTarget) }
        });
        setStatus("KPI target updated.");
        await loadSettings();
        await loadDashboard();
      } catch (error) {
        setStatus(error.message, true);
      }
    });
  });

  // ── Branding listeners ────────────────────────────────────────
  ["primary", "secondary"].forEach((key) => {
    const picker = views.settings.querySelector(`[name="${key}ColorPicker"]`);
    const text   = views.settings.querySelector(`[name="${key}Color"]`);
    if (picker && text) {
      picker.addEventListener("input", () => { text.value = picker.value; });
      text.addEventListener("input", () => { if (/^#[0-9a-fA-F]{6}$/.test(text.value)) picker.value = text.value; });
    }
  });

  // ── Logo upload area interactions ────────────────────────────
  const logoArea = qs("#logo-upload-area");
  const logoFileInput = qs("#logo-file-input");
  if (logoArea && logoFileInput) {
    logoArea.addEventListener("click", () => logoFileInput.click());
    logoArea.addEventListener("dragover", (e) => { e.preventDefault(); logoArea.classList.add("drag-over"); });
    logoArea.addEventListener("dragleave", () => logoArea.classList.remove("drag-over"));
    logoArea.addEventListener("drop", (e) => {
      e.preventDefault();
      logoArea.classList.remove("drag-over");
      const file = e.dataTransfer?.files?.[0];
      if (file) {
        const dt = new DataTransfer();
        dt.items.add(file);
        logoFileInput.files = dt.files;
        logoFileInput.dispatchEvent(new Event("change"));
      }
    });
    logoFileInput.addEventListener("change", () => {
      const file = logoFileInput.files?.[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = (e) => {
        const preview = qs("#logo-preview");
        if (preview) preview.src = e.target.result;
        const hint = logoArea.querySelector(".logo-upload-change-hint");
        if (hint) hint.textContent = "Click to change";
      };
      reader.readAsDataURL(file);
    });
  }

  // ── Favicon upload area interactions ─────────────────────────
  const faviconArea = qs("#favicon-upload-area");
  const faviconFileInput = qs("#favicon-file-input");
  if (faviconArea && faviconFileInput) {
    faviconArea.addEventListener("click", () => faviconFileInput.click());
    faviconArea.addEventListener("dragover", (e) => { e.preventDefault(); faviconArea.classList.add("drag-over"); });
    faviconArea.addEventListener("dragleave", () => faviconArea.classList.remove("drag-over"));
    faviconArea.addEventListener("drop", (e) => {
      e.preventDefault();
      faviconArea.classList.remove("drag-over");
      const file = e.dataTransfer?.files?.[0];
      if (file) {
        const dt = new DataTransfer();
        dt.items.add(file);
        faviconFileInput.files = dt.files;
        faviconFileInput.dispatchEvent(new Event("change"));
      }
    });
    faviconFileInput.addEventListener("change", () => {
      const file = faviconFileInput.files?.[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = (e) => {
        const preview = qs("#favicon-preview");
        if (preview) preview.src = e.target.result;
        const hint = faviconArea.querySelector(".logo-upload-change-hint");
        if (hint) hint.textContent = "Click to change";
      };
      reader.readAsDataURL(file);
    });
  }

  // ── Login hero upload area interactions ──────────────────────
  const heroArea = qs("#login-hero-upload-area");
  const heroFileInput = qs("#login-hero-file-input");
  if (heroArea && heroFileInput) {
    heroArea.addEventListener("click", () => heroFileInput.click());
    heroArea.addEventListener("dragover", (e) => { e.preventDefault(); heroArea.classList.add("drag-over"); });
    heroArea.addEventListener("dragleave", () => heroArea.classList.remove("drag-over"));
    heroArea.addEventListener("drop", (e) => {
      e.preventDefault();
      heroArea.classList.remove("drag-over");
      const file = e.dataTransfer?.files?.[0];
      if (file) {
        const dt = new DataTransfer();
        dt.items.add(file);
        heroFileInput.files = dt.files;
        heroFileInput.dispatchEvent(new Event("change"));
      }
    });
    heroFileInput.addEventListener("change", () => {
      const file = heroFileInput.files?.[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = (e) => {
        const preview = qs("#login-hero-preview");
        if (preview) preview.src = e.target.result;
        const hint = heroArea.querySelector(".logo-upload-change-hint");
        if (hint) hint.textContent = "Click to change";
      };
      reader.readAsDataURL(file);
    });
  }

  qs('[name="primaryColorPicker"]')?.addEventListener("input", (e) => {
    const hex = qs('[name="primaryColor"]');
    if (hex) hex.value = e.target.value;
  });
  qs('[name="primaryColor"]')?.addEventListener("input", (e) => {
    const picker = qs('[name="primaryColorPicker"]');
    if (picker && /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(e.target.value)) picker.value = e.target.value;
  });
  qs('[name="secondaryColorPicker"]')?.addEventListener("input", (e) => {
    const hex = qs('[name="secondaryColor"]');
    if (hex) hex.value = e.target.value;
  });
  qs('[name="secondaryColor"]')?.addEventListener("input", (e) => {
    const picker = qs('[name="secondaryColorPicker"]');
    if (picker && /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(e.target.value)) picker.value = e.target.value;
  });

  // Gradient controls: segmented Solid/Gradient pill, sync picker↔text, live preview
  const gradientHidden = qs('[name="accentGradientEnabled"]');
  const gradientControls = document.querySelector(".gradient-controls");
  const refreshGradientPreview = () => {
    const swatch = qs("#gradient-preview-swatch");
    if (!swatch) return;
    const p = qs('[name="primaryColor"]')?.value || "#7c3aed";
    const g = qs('[name="accentGradientColor"]')?.value || "#ec4899";
    const a = qs('[name="accentGradientAngle"]')?.value || 135;
    swatch.style.background = `linear-gradient(${a}deg, ${p}, ${g})`;
  };
  const segmentedItems = document.querySelectorAll(".accent-mode-row .segmented-item");
  segmentedItems.forEach((btn) => {
    btn.addEventListener("click", () => {
      const enabled = btn.dataset.value === "true";
      segmentedItems.forEach((b) => b.setAttribute("aria-selected", String(b === btn)));
      if (gradientHidden) gradientHidden.value = enabled ? "true" : "false";
      if (gradientControls) gradientControls.style.display = enabled ? "" : "none";
      if (typeof livePreview === "function") livePreview();
    });
  });
  qs('[name="accentGradientColorPicker"]')?.addEventListener("input", (e) => {
    const hex = qs('[name="accentGradientColor"]');
    if (hex) hex.value = e.target.value;
    refreshGradientPreview();
  });
  qs('[name="accentGradientColor"]')?.addEventListener("input", (e) => {
    const picker = qs('[name="accentGradientColorPicker"]');
    if (picker && /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(e.target.value)) picker.value = e.target.value;
    refreshGradientPreview();
  });
  qs('[name="accentGradientAngleRange"]')?.addEventListener("input", (e) => {
    const num = qs('[name="accentGradientAngle"]');
    if (num) num.value = e.target.value;
    refreshGradientPreview();
  });
  qs('[name="accentGradientAngle"]')?.addEventListener("input", (e) => {
    const range = qs('[name="accentGradientAngleRange"]');
    if (range) range.value = e.target.value;
    refreshGradientPreview();
  });
  qs('[name="primaryColor"]')?.addEventListener("input", refreshGradientPreview);
  qs('[name="primaryColorPicker"]')?.addEventListener("input", refreshGradientPreview);

  // Full custom theme editor — wire picker/hex sync for all token rows, the
  // radius range↔number pair, the shadow select, the preset selector, and a
  // live preview that runs applyBrandingTheme() on every change so the whole
  // app repaints as the admin tweaks values.
  const THEME_TOKEN_INPUTS = [
    "tokenBackground", "tokenText", "tokenAccent",
    "tokenCard", "tokenMuted", "tokenBorder", "tokenDestructive"
  ];
  const BRAND_COLOR_INPUTS = ["primaryColor", "secondaryColor"];
  const collectThemeDraft = () => {
    const read = (n) => qs(`[name="${n}"]`)?.value || "";
    return {
      primaryColor:   read("primaryColor")   || "#7c3aed",
      secondaryColor: read("secondaryColor") || "#0f172a",
      themeTokens: {
        background:  read("tokenBackground"),
        text:        read("tokenText"),
        accent:      read("tokenAccent"),
        card:        read("tokenCard"),
        muted:       read("tokenMuted"),
        border:      read("tokenBorder"),
        destructive: read("tokenDestructive"),
        radius:      Number(read("tokenRadius")) || 12,
        shadow:      read("tokenShadow") || "MD"
      },
      accentGradientEnabled: qs('[name="accentGradientEnabled"]')?.value === "true",
      accentGradientColor:   read("accentGradientColor"),
      accentGradientAngle:   Number(read("accentGradientAngle")) || 135,
      themeMode:             read("themeMode") || "LIGHT",
      appName:               branding.appName,
      logoUrl:               branding.logoUrl,
      faviconUrl:            branding.faviconUrl
    };
  };
  const refreshPresetChrome = (slug) => {
    const preset = findPresetBySlug(slug);
    const nameEl = document.querySelector('[data-role="preset-name"]');
    const swEl = document.querySelector('[data-role="preset-swatches"]');
    if (nameEl) nameEl.textContent = preset?.name || "Custom Theme";
    if (swEl) {
      const swatches = preset?.swatches || (() => {
        const d = collectThemeDraft();
        return [d.themeTokens.background, d.secondaryColor, d.primaryColor];
      })();
      swEl.innerHTML = swatches.map((c) => `<span style="background:${escHtml(c)}"></span>`).join("");
    }
  };
  const livePreview = () => {
    applyBrandingTheme(collectThemeDraft());
  };
  const setPresetSelect = (slug) => {
    const sel = qs('[name="themePreset"]');
    if (sel && sel.value !== slug) sel.value = slug;
    refreshPresetChrome(slug);
  };
  const markCustom = () => setPresetSelect("custom");

  // Picker ↔ hex sync + live preview for every token row
  [...THEME_TOKEN_INPUTS, ...BRAND_COLOR_INPUTS].forEach((n) => {
    const picker = qs(`[name="${n}Picker"]`);
    const hex = qs(`[name="${n}"]`);
    picker?.addEventListener("input", (e) => {
      if (hex) hex.value = e.target.value;
      markCustom();
      livePreview();
    });
    hex?.addEventListener("input", (e) => {
      if (picker && /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(e.target.value)) picker.value = e.target.value;
      markCustom();
      livePreview();
    });
  });

  // Radius range ↔ number
  qs('[name="tokenRadiusRange"]')?.addEventListener("input", (e) => {
    const num = qs('[name="tokenRadius"]');
    if (num) num.value = e.target.value;
    markCustom();
    livePreview();
  });
  qs('[name="tokenRadius"]')?.addEventListener("input", (e) => {
    const range = qs('[name="tokenRadiusRange"]');
    if (range) range.value = e.target.value;
    markCustom();
    livePreview();
  });
  qs('[name="tokenShadow"]')?.addEventListener("change", () => {
    markCustom();
    livePreview();
  });

  // Preset selector — fill every input, then re-run the live preview
  qs('[name="themePreset"]')?.addEventListener("change", (e) => {
    const slug = e.target.value;
    if (slug === "custom") { refreshPresetChrome("custom"); return; }
    const preset = findPresetBySlug(slug);
    if (!preset) return;
    const set = (name, val) => {
      const el = qs(`[name="${name}"]`);
      if (el) el.value = val;
      const picker = qs(`[name="${name}Picker"]`);
      if (picker && typeof val === "string" && /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(val)) picker.value = val;
    };
    const t = preset.tokens;
    set("primaryColor",   t.primaryColor);
    set("secondaryColor", t.secondaryColor);
    set("tokenBackground", t.background);
    set("tokenText",       t.text);
    set("tokenAccent",     t.accent);
    set("tokenCard",       t.card);
    set("tokenMuted",      t.muted);
    set("tokenBorder",     t.border);
    set("tokenDestructive", t.destructive);
    const rN = qs('[name="tokenRadius"]'); if (rN) rN.value = t.radius;
    const rR = qs('[name="tokenRadiusRange"]'); if (rR) rR.value = t.radius;
    const sS = qs('[name="tokenShadow"]'); if (sS) sS.value = t.shadow;
    refreshPresetChrome(slug);
    livePreview();
  });

  qs("#branding-form")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const submitBtn = form.querySelector('button[type="submit"]');
    const originalBtnText = submitBtn?.textContent;
    if (submitBtn) {
      submitBtn.disabled = true;
      submitBtn.textContent = "Saving…";
    }
    try {
      const fd = new FormData(form);
      const logoFile = fd.get("logoFile");
      if (logoFile instanceof File && logoFile.size > 0) {
        const uploadFd = new FormData();
        uploadFd.append("file", logoFile, logoFile.name);
        try {
          const uploadResult = await api(`/tenants/${tenantId}/branding/logo`, { method: "POST", body: uploadFd });
          if (uploadResult?.logoUrl) fd.set("logoUrl", uploadResult.logoUrl);
          const previewSrc = uploadResult?.logoDownloadUrl || uploadResult?.logoUrl;
          if (previewSrc) { const p = qs("#logo-preview"); if (p) p.src = previewSrc; }
        } catch (error) {
          setStatus(`Logo upload failed: ${error.message}`, true);
          return;
        }
      }
      const faviconFile = fd.get("faviconFile");
      if (faviconFile instanceof File && faviconFile.size > 0) {
        const uploadFd = new FormData();
        uploadFd.append("file", faviconFile, faviconFile.name);
        try {
          const uploadResult = await api(`/tenants/${tenantId}/branding/favicon`, { method: "POST", body: uploadFd });
          if (uploadResult?.faviconUrl) fd.set("faviconUrl", uploadResult.faviconUrl);
          const previewSrc = uploadResult?.faviconDownloadUrl || uploadResult?.faviconUrl;
          if (previewSrc) { const p = qs("#favicon-preview"); if (p) p.src = previewSrc; }
        } catch (error) {
          setStatus(`Favicon upload failed: ${error.message}`, true);
          return;
        }
      }
      const loginHeroFile = fd.get("loginHeroFile");
      if (loginHeroFile instanceof File && loginHeroFile.size > 0) {
        const uploadFd = new FormData();
        uploadFd.append("file", loginHeroFile, loginHeroFile.name);
        try {
          const uploadResult = await api(`/tenants/${tenantId}/branding/login-hero`, { method: "POST", body: uploadFd });
          if (uploadResult?.loginHeroImageUrl) fd.set("loginHeroImageUrl", uploadResult.loginHeroImageUrl);
          const previewSrc = uploadResult?.loginHeroDownloadUrl || uploadResult?.loginHeroImageUrl;
          if (previewSrc) { const p = qs("#login-hero-preview"); if (p) p.src = previewSrc; }
        } catch (error) {
          setStatus(`Login hero upload failed: ${error.message}`, true);
          return;
        }
      }
      const payload = Object.fromEntries(fd.entries());
      if (!payload.logoUrl) delete payload.logoUrl;
      if (!payload.faviconUrl) delete payload.faviconUrl;
      if (!payload.loginHeroImageUrl) delete payload.loginHeroImageUrl;
      delete payload.logoFile;
      delete payload.faviconFile;
      delete payload.loginHeroFile;
      delete payload.primaryColorPicker;
      delete payload.secondaryColorPicker;
      delete payload.accentGradientColorPicker;
      delete payload.accentGradientAngleRange;
      payload.accentGradientEnabled = fd.get("accentGradientEnabled") === "true" ? "true" : "false";
      payload.loginShowSignup    = fd.get("loginShowSignup")    === "on" ? "true" : "false";
      payload.loginShowGoogle    = fd.get("loginShowGoogle")    === "on" ? "true" : "false";
      payload.loginShowMicrosoft = fd.get("loginShowMicrosoft") === "on" ? "true" : "false";
      payload.loginShowPasskey   = fd.get("loginShowPasskey")   === "on" ? "true" : "false";

      // Assemble themeTokens from the grouped editor fields, then strip the
      // per-field entries and helper Picker/Range inputs from the payload.
      payload.themeTokens = {
        background:  fd.get("tokenBackground")  || undefined,
        text:        fd.get("tokenText")        || undefined,
        accent:      fd.get("tokenAccent")      || undefined,
        card:        fd.get("tokenCard")        || undefined,
        muted:       fd.get("tokenMuted")       || undefined,
        border:      fd.get("tokenBorder")      || undefined,
        destructive: fd.get("tokenDestructive") || undefined,
        radius:      Number(fd.get("tokenRadius")) || 12,
        shadow:      fd.get("tokenShadow")      || "MD"
      };
      [
        "themePreset",
        "tokenBackground", "tokenBackgroundPicker",
        "tokenText",       "tokenTextPicker",
        "tokenAccent",     "tokenAccentPicker",
        "tokenCard",       "tokenCardPicker",
        "tokenMuted",      "tokenMutedPicker",
        "tokenBorder",     "tokenBorderPicker",
        "tokenDestructive","tokenDestructivePicker",
        "tokenRadius", "tokenRadiusRange", "tokenShadow"
      ].forEach((k) => delete payload[k]);
      try {
        await api(`/tenants/${tenantId}/branding`, { method: "PUT", body: payload });
        setStatus("Branding saved.");
        await loadSettings();
      } catch (error) {
        setStatus(error.message, true);
      }
    } finally {
      if (submitBtn) {
        submitBtn.disabled = false;
        submitBtn.textContent = originalBtnText || "Save Branding";
      }
    }
  });

  qs("#branding-restore-default")?.addEventListener("click", async (event) => {
    const btn = event.currentTarget;
    if (!confirm("Restore branding to defaults? App name, colors, gradient, theme mode, and login-screen customizations will be reset. Logo, favicon, and hero image will be kept.")) return;
    btn.disabled = true;
    const original = btn.textContent;
    btn.textContent = "Restoring…";
    try {
      await api(`/tenants/${tenantId}/branding`, {
        method: "PUT",
        body: {
          appName: "",
          primaryColor: "#7c3aed",
          secondaryColor: "#0f172a",
          accentGradientEnabled: "false",
          accentGradientColor: "#ec4899",
          accentGradientAngle: 135,
          themeMode: "LIGHT",
          loginTaglineHeadline: "",
          loginTaglineSubtext: "",
          loginWelcomeMessage: "",
          loginFooterText: "",
          loginTermsUrl: "",
          loginPrivacyUrl: "",
          loginSupportEmail: "",
          loginShowSignup: "true",
          loginShowGoogle: "true",
          loginShowMicrosoft: "true",
          loginShowPasskey: "true"
        }
      });
      setStatus("Branding restored to defaults.");
      await loadSettings();
    } catch (error) {
      setStatus(error.message, true);
      btn.disabled = false;
      btn.textContent = original;
    }
  });

  qs("#theme-override-auto")?.addEventListener("click", () => {
    state.themeOverride = "AUTO";
    localStorage.setItem(THEME_OVERRIDE_KEY, state.themeOverride);
    applyThemeMode(tenantThemeMode);
    setStatus("Theme set to tenant default.");
    renderSettings();
  });
  qs("#theme-override-light")?.addEventListener("click", () => {
    state.themeOverride = "LIGHT";
    localStorage.setItem(THEME_OVERRIDE_KEY, state.themeOverride);
    applyThemeMode(tenantThemeMode);
    setStatus("Theme set to light.");
    renderSettings();
  });
  qs("#theme-override-dark")?.addEventListener("click", () => {
    state.themeOverride = "DARK";
    localStorage.setItem(THEME_OVERRIDE_KEY, state.themeOverride);
    applyThemeMode(tenantThemeMode);
    setStatus("Theme set to dark.");
    renderSettings();
  });

  views.settings.querySelectorAll(".integration-credential-form").forEach((form) => {
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      const platform = form.dataset.platform;
      if (!platform) return;
      const formData = new FormData(event.currentTarget);
      const payload = {
        clientId: String(formData.get("clientId") || "").trim(),
        clientSecret: String(formData.get("clientSecret") || "").trim(),
        apiKey: String(formData.get("apiKey") || "").trim(),
        webhookToken: String(formData.get("webhookToken") || "").trim()
      };
      if (!payload.clientId) delete payload.clientId;
      if (!payload.clientSecret) delete payload.clientSecret;
      if (!payload.apiKey) delete payload.apiKey;
      if (!payload.webhookToken) delete payload.webhookToken;
      if (!Object.keys(payload).length) { setStatus("Provide at least one credential value before saving.", true); return; }
      try {
        await api(`/tenants/${tenantId}/integrations/credentials/${platform}`, { method: "PUT", body: payload });
        setStatus(`${platform} credentials saved. Run Test Connection next.`);
        await loadSettings();
      } catch (error) {
        setStatus(error.message, true);
      }
    });
  });

  views.settings.querySelectorAll(".integration-test-btn").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const platform = btn.dataset.platform;
      if (!platform) return;
      const form = btn.closest("form");
      let resultEl = form?.querySelector(".intg-test-result");
      if (!resultEl) {
        resultEl = document.createElement("p");
        resultEl.className = "intg-test-result small";
        form?.appendChild(resultEl);
      }
      btn.disabled = true;
      btn.textContent = "Testing…";
      resultEl.className = "intg-test-result small";
      resultEl.textContent = "";
      try {
        const result = await api(`/tenants/${tenantId}/integrations/credentials/${platform}/test`, { method: "POST" });
        const passed = result.ok === true || result.status === "SUCCESS" || result.lastTestStatus === "SUCCESS";
        resultEl.className = `intg-test-result small intg-test-result--${passed ? "pass" : "fail"}`;
        resultEl.textContent = passed ? "Test passed" : `Test failed${result.message ? ": " + result.message : ""}`;
      } catch (error) {
        resultEl.className = "intg-test-result small intg-test-result--fail";
        resultEl.textContent = error.message;
      } finally {
        btn.disabled = false;
        btn.textContent = "Test Connection";
      }
    });
  });

  views.settings.querySelectorAll(".integration-toggle-btn").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const platform = btn.dataset.platform;
      if (!platform) return;
      const enabled = btn.dataset.enabled === "true";
      try {
        await api(`/tenants/${tenantId}/integrations/credentials/${platform}/enable`, { method: "PATCH", body: { enabled: !enabled } });
        setStatus(`${platform} ${enabled ? "disabled" : "enabled"}.`);
        await Promise.all([loadSettings(), loadIntegrations()]);
      } catch (error) {
        setStatus(error.message, true);
      }
    });
  });

  // ── Teams App Package download ────────────────────────────────
  views.settings.querySelectorAll(".teams-app-pkg-btn").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const tid = btn.dataset.tenantId;
      if (!tid) return;
      btn.disabled = true;
      btn.textContent = "Downloading…";
      try {
        const res = await fetch(`/api/v1/tenants/${tid}/integrations/ms-teams-app-package`, {
          headers: { Authorization: `Bearer ${state.token}` }
        });
        if (!res.ok) {
          const err = await res.json().catch(() => ({ message: "Download failed" }));
          throw new Error(err.message || `HTTP ${res.status}`);
        }
        const blob = await res.blob();
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        const cd = res.headers.get("Content-Disposition") || "";
        const match = cd.match(/filename="([^"]+)"/);
        a.download = match ? match[1] : "teams-app.zip";
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
      } catch (e) {
        setStatus(e.message, true);
      } finally {
        btn.disabled = false;
        btn.textContent = "⬇ Download Teams App";
      }
    });
  });

  views.settings.querySelectorAll(".teams-push-all-btn").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const tid = btn.dataset.tenantId;
      if (!tid) return;
      if (!confirm("This will install the Teams bot for all CRM users in your Microsoft 365 org.\n\nRequired permissions (must be granted in Azure Portal first):\n• User.Read.All\n• AppCatalog.Read.All\n• TeamsAppInstallation.ReadWriteForUser.All\n\nContinue?")) return;
      btn.disabled = true;
      btn.textContent = "Pushing…";
      try {
        const res = await api(`/tenants/${tid}/integrations/ms-teams-push-all`, { method: "POST" });
        const detail = `Azure AD users found: ${res.orgUsersFound ?? "?"}, CRM users: ${res.crmUsersFound ?? "?"}, matched: ${res.matched ?? "?"}`;
        if (res.ok) {
          setStatus(`${res.message} (${detail})${res.errors?.length ? " Errors: " + res.errors.join("; ") : ""}`);
        } else {
          setStatus(`${res.message} — ${detail}${res.sampleAadEmails?.length ? ` | Sample AAD emails: ${res.sampleAadEmails.join(", ")}` : ""}`, true);
        }
      } catch (e) {
        setStatus(e.message, true);
      } finally {
        btn.disabled = false;
        btn.innerHTML = `${icon('rocket')} Push to All Users`;
      }
    });
  });

  // ── Team Structure listeners ──────────────────────────────────
  qs("#team-create-btn")?.addEventListener("click", () => {
    const modal = qs("#team-create-modal");
    if (!modal) return;
    modal.querySelector("input[name='teamName']").value = "";
    modal.removeAttribute("hidden");
  });


  views.settings.querySelectorAll(".team-rename-btn").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const newName = prompt("New team name", btn.dataset.teamName || "");
      if (!newName?.trim()) return;
      try {
        await api(`/teams/${btn.dataset.teamId}`, { method: "PATCH", body: { teamName: newName.trim() } });
        setStatus("Team renamed.");
        await loadSettings();
      } catch (error) {
        setStatus(error.message, true);
      }
    });
  });

  views.settings.querySelectorAll(".team-toggle-btn").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const isActive = btn.dataset.isActive === "true";
      try {
        await api(`/teams/${btn.dataset.teamId}`, { method: "PATCH", body: { isActive: !isActive } });
        setStatus(`Team ${isActive ? "deactivated" : "activated"}.`);
        await loadSettings();
      } catch (error) {
        setStatus(error.message, true);
      }
    });
  });

  // ── Team notification channel listeners ──────────────────────────────────
  views.settings.querySelectorAll(".team-ch-test-btn").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const section = btn.closest(".team-notif-section");
      const teamId = btn.dataset.teamId;
      const resultBox = section.querySelector(".team-ch-test-result");
      btn.disabled = true;
      btn.textContent = "Testing…";
      resultBox.removeAttribute("hidden");
      resultBox.innerHTML = "";
      try {
        const res = await api(`/teams/${teamId}/notification-channels/test`, { method: "POST" });
        resultBox.innerHTML = (res.results || []).map(r => {
          const ok = r.status === "OK";
          const cls = ok ? "team-ch-test-ok" : "team-ch-test-warn";
          return `<div class="${cls}"><strong>${r.channelType}</strong> ${escHtml(r.channelTarget)}: ${escHtml(r.message)}</div>`;
        }).join("");
      } catch (e) {
        resultBox.innerHTML = `<div class="team-ch-test-warn">${escHtml(e.message)}</div>`;
      } finally {
        btn.disabled = false;
        btn.textContent = "Test Connection";
      }
    });
  });

  const chTypePlaceholder = {
    LINE: "LINE Group ID",
    SLACK: "Slack Channel ID (e.g. C01234ABCDE)",
    MS_TEAMS: "Incoming Webhook URL (https://…webhook.office.com/…)",
    EMAIL: "Email address"
  };

  views.settings.querySelectorAll(".team-ch-type-select").forEach((sel) => {
    sel.addEventListener("change", () => {
      const input = sel.closest(".team-ch-form").querySelector(".team-ch-target-input");
      input.placeholder = chTypePlaceholder[sel.value] || "Channel target";
    });
  });

  views.settings.querySelectorAll(".team-ch-add-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      const section = btn.closest(".team-notif-section");
      section.querySelector(".team-ch-form").removeAttribute("hidden");
      btn.setAttribute("hidden", "");
      section.querySelector(".team-ch-target-input").focus();
    });
  });

  views.settings.querySelectorAll(".team-ch-cancel-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      const section = btn.closest(".team-notif-section");
      section.querySelector(".team-ch-form").setAttribute("hidden", "");
      section.querySelector(".team-ch-add-btn")?.removeAttribute("hidden");
    });
  });

  views.settings.querySelectorAll(".team-ch-save-btn").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const section = btn.closest(".team-notif-section");
      const teamId = btn.dataset.teamId;
      const channelType = section.querySelector(".team-ch-type-select").value;
      const channelTarget = section.querySelector(".team-ch-target-input").value.trim();
      if (!channelTarget) { setStatus("Please enter a channel ID.", true); return; }
      try {
        let existing = [];
        try { existing = JSON.parse(decodeURIComponent(section.dataset.channels || "[]")); } catch {}
        const channels = [...existing, { channelType, channelTarget, isEnabled: true }];
        await api(`/teams/${teamId}/notification-channels`, { method: "PUT", body: { channels } });
        setStatus("Notification channel added.");
        await loadSettings();
      } catch (error) {
        setStatus(error.message, true);
      }
    });
  });

  views.settings.querySelectorAll(".team-ch-toggle-btn").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const section = btn.closest(".team-notif-section");
      const teamId = btn.dataset.teamId;
      const toggleType = btn.dataset.channelType;
      const toggleTarget = btn.dataset.channelTarget;
      const newEnabled = btn.dataset.isEnabled !== "true";
      try {
        let existing = [];
        try { existing = JSON.parse(decodeURIComponent(section.dataset.channels || "[]")); } catch {}
        const channels = existing.map(ch =>
          ch.channelType === toggleType && ch.channelTarget === toggleTarget
            ? { ...ch, isEnabled: newEnabled }
            : ch
        );
        await api(`/teams/${teamId}/notification-channels`, { method: "PUT", body: { channels } });
        await loadSettings();
      } catch (error) {
        setStatus(error.message, true);
      }
    });
  });

  views.settings.querySelectorAll(".team-ch-remove-btn").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const section = btn.closest(".team-notif-section");
      const teamId = btn.dataset.teamId;
      const removeType = btn.dataset.channelType;
      const removeTarget = btn.dataset.channelTarget;
      try {
        let existing = [];
        try { existing = JSON.parse(decodeURIComponent(section.dataset.channels || "[]")); } catch {}
        const channels = existing.filter(ch => !(ch.channelType === removeType && ch.channelTarget === removeTarget));
        await api(`/teams/${teamId}/notification-channels`, { method: "PUT", body: { channels } });
        setStatus("Channel removed.");
        await loadSettings();
      } catch (error) {
        setStatus(error.message, true);
      }
    });
  });
}


// ── Customer List helpers ───────────────────────────────────────────────────

const CUST_PAGE_SIZE = 20;

function filteredCustomers() {
  const q = (state.customerListQuery || "").toLowerCase().trim();
  const defs = getCustomFieldDefinitions("customers");
  const cfFilters = state.customerCustomFieldFilters || {};
  return state.cache.customers.filter((c) => {
    if (q) {
      const matches =
        c.customerCode?.toLowerCase().includes(q) ||
        c.name?.toLowerCase().includes(q) ||
        c.taxId?.toLowerCase().includes(q);
      if (!matches) return false;
    }
    return matchesCustomFieldFilters(c, defs, cfFilters);
  });
}

function dealsForCustomer(customerId) {
  if (!state.cache.kanban?.stages) return [];
  return state.cache.kanban.stages.flatMap((s) =>
    s.deals.filter((d) => d.customer?.id === customerId || d.customerId === customerId)
  );
}

function c360Initials(name) {
  const initials = (name || "?")
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0].toUpperCase())
    .join("");
  return escHtml(initials);
}

// Deterministic avatar background from name — always dark enough for white text
const AVATAR_PALETTE = [
  "oklch(40% 0.15 260)",  // indigo
  "oklch(38% 0.14 155)",  // teal
  "oklch(40% 0.16 25)",   // red-orange
  "oklch(38% 0.14 305)",  // purple
  "oklch(40% 0.15 195)",  // cyan
  "oklch(38% 0.15 50)",   // amber-brown
  "oklch(38% 0.14 330)",  // pink
  "oklch(40% 0.13 130)",  // green
];
function avatarColor(name) {
  let h = 0;
  for (let i = 0; i < (name || "").length; i++) h = (h * 31 + (name || "").charCodeAt(i)) >>> 0;
  return AVATAR_PALETTE[h % AVATAR_PALETTE.length];
}

/**
 * Returns inner HTML for a fixed-size avatar container.
 * If avatarUrl is set, renders a photo <img> that fills the circle.
 * Otherwise returns initials text (for the existing colored-circle style).
 */
function repAvatarHtml(name, avatarUrl) {
  if (avatarUrl) {
    return `<img src="${escHtml(avatarUrl)}" alt="${escHtml(name || "")}" style="width:100%;height:100%;object-fit:cover;display:block">`;
  }
  // Escape initials — a name starting with '<' would otherwise inject raw HTML.
  const initials = (name || "?").split(" ").filter(Boolean).slice(0, 2).map(w => w[0].toUpperCase()).join("");
  return escHtml(initials);
}

// ── Shared popup helpers ───────────────────────────────────────────────────

function openConfirmPopup({ title, message, confirmLabel = "Confirm", danger = false }) {
  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    overlay.className = "popup-overlay";
    overlay.innerHTML = `
      <div class="popup-box" role="alertdialog" aria-modal="true">
        <p class="popup-title">${title}</p>
        <p class="popup-msg">${message}</p>
        <div class="popup-actions">
          <button class="popup-cancel-btn">Cancel</button>
          <button class="popup-confirm-btn ${danger ? "danger" : ""}">${escHtml(confirmLabel)}</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);
    requestAnimationFrame(() => overlay.classList.add("popup-visible"));

    const close = (result) => {
      overlay.classList.remove("popup-visible");
      overlay.addEventListener("transitionend", () => overlay.remove(), { once: true });
      resolve(result);
    };

    overlay.querySelector(".popup-cancel-btn").addEventListener("click", () => close(false));
    overlay.querySelector(".popup-confirm-btn").addEventListener("click", () => close(true));
    overlay.addEventListener("click", (e) => { if (e.target === overlay) close(false); });
    overlay.addEventListener("keydown", (e) => { if (e.key === "Escape") close(false); });
    overlay.querySelector(".popup-confirm-btn").focus();
  });
}

function openContactsPopup(contacts) {
  const overlay = document.createElement("div");
  overlay.className = "popup-overlay";

  const rows = contacts.map((c) => `
    <div class="cpop-contact-row">
      <div class="cpop-avatar" style="background:${avatarColor(c.name)}">${c360Initials(c.name)}</div>
      <div class="cpop-info">
        <div class="cpop-name">${escHtml(c.name)}</div>
        <div class="cpop-pos muted small">${escHtml(c.position || "")}</div>
        <div class="cpop-channels">
          ${c.tel      ? `<span class="cpop-channel"><svg width="12" height="12" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07A19.5 19.5 0 0 1 4.69 12 19.79 19.79 0 0 1 1.62 3.48 2 2 0 0 1 3.62 1.27h3a2 2 0 0 1 2 1.72c.127.96.361 1.903.7 2.81a2 2 0 0 1-.45 2.11L7.91 8.91a16 16 0 0 0 6.18 6.18l.97-.97a2 2 0 0 1 2.11-.45c.907.339 1.85.573 2.81.7A2 2 0 0 1 22 16.92z"/></svg>${escHtml(c.tel)}</span>` : ""}
          ${c.email    ? `<span class="cpop-channel"><svg width="12" height="12" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"/><polyline points="22,6 12,13 2,6"/></svg>${escHtml(c.email)}</span>` : ""}
          ${c.lineId   ? `<span class="cpop-channel"><svg width="12" height="12" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>LINE: ${escHtml(c.lineId)}</span>` : ""}
          ${c.whatsapp ? `<span class="cpop-channel"><svg width="12" height="12" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/></svg>WA: ${escHtml(c.whatsapp)}</span>` : ""}
        </div>
      </div>
    </div>`).join("");

  overlay.innerHTML = `
    <div class="popup-box popup-box--wide" role="dialog" aria-modal="true">
      <div class="popup-header">
        <p class="popup-title">Contacts <span class="muted small">(${contacts.length})</span></p>
        <button class="popup-close-btn" aria-label="Close">${icon('x', 14)}</button>
      </div>
      <div class="cpop-list">${rows}</div>
    </div>`;

  document.body.appendChild(overlay);
  requestAnimationFrame(() => overlay.classList.add("popup-visible"));

  const close = () => {
    overlay.classList.remove("popup-visible");
    overlay.addEventListener("transitionend", () => overlay.remove(), { once: true });
  };
  overlay.querySelector(".popup-close-btn").addEventListener("click", close);
  overlay.addEventListener("click", (e) => { if (e.target === overlay) close(); });
  overlay.addEventListener("keydown", (e) => { if (e.key === "Escape") close(); });
}

function buildCustBodyHtml(all, page, totalPages, start, slice, isAdmin) {
  const tableHtml = all.length === 0 && state.customerListQuery
    ? `<div class="cust-empty">No customers match "<strong>${escHtml(state.customerListQuery)}</strong>"</div>`
    : all.length === 0
    ? `<div class="cust-empty">No customers yet. Click <strong>New Customer</strong> to add one.</div>`
    : `<table class="cust-table">
        <thead>
          <tr>
            <th>#</th>
            <th>Code</th>
            <th>Name</th>
            <th>Contacts</th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody>
          ${slice.map((c, i) => `
            <tr class="cust-row" data-id="${c.id}">
              <td>${start + i + 1}</td>
              <td><button class="cust-code-btn" data-id="${c.id}" data-code="${escHtml(c.customerCode)}">${escHtml(c.customerCode)}</button></td>
              <td><button class="cust-name-btn" data-id="${c.id}" data-code="${escHtml(c.customerCode)}">${escHtml(c.name)}</button></td>
              <td>${c.contacts?.length
                ? `<button class="cust-badge-contact cust-contacts-btn" data-id="${c.id}" data-contacts='${escHtml(JSON.stringify(c.contacts))}' title="View contacts"><svg width="11" height="11" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/></svg>${c.contacts.length}</button>`
                : '<span class="muted small">—</span>'}</td>
              <td><div class="cust-actions-cell">
                <button class="cust-action-btn cust-360-btn" data-id="${c.id}" data-code="${escHtml(c.customerCode)}">360°</button>
                <button class="cust-action-btn cust-edit-btn" data-id="${c.id}" data-customer='${escHtml(JSON.stringify({ id: c.id, customerCode: c.customerCode, name: c.name, customerType: c.customerType, taxId: c.taxId || "", defaultTermId: c.paymentTerm?.id || "", externalRef: c.externalRef || "" }))}'>Edit</button>
                ${isAdmin ? `<button class="cust-action-btn cust-delete-btn danger" data-id="${c.id}" data-name="${escHtml(c.name)}">Delete</button>` : ""}
              </div></td>
            </tr>`).join("")}
        </tbody>
      </table>`;

  const paginationHtml = all.length > CUST_PAGE_SIZE
    ? `<div class="cust-pagination">
        <span class="cust-page-info">Page ${page} of ${totalPages} · ${all.length} customers</span>
        <div class="cust-page-btns">
          <button class="cust-page-btn" id="cust-prev" ${page <= 1 ? "disabled" : ""}>← Prev</button>
          <button class="cust-page-btn" id="cust-next" ${page >= totalPages ? "disabled" : ""}>Next →</button>
        </div>
      </div>`
    : `<div class="cust-page-info" style="font-size:0.8rem;color:var(--muted-color);padding-top:var(--sp-2)">${all.length} customer${all.length !== 1 ? "s" : ""}</div>`;

  return `<div class="cust-table-wrap">${tableHtml}</div>${paginationHtml}`;
}

function attachCustBodyListeners(container, totalPages, termOptions) {
  // Contacts popup
  container.querySelectorAll(".cust-contacts-btn").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      let contacts = [];
      try { contacts = JSON.parse(btn.dataset.contacts || "[]"); } catch (_) {}
      openContactsPopup(contacts);
    });
  });

  // Edit customer
  container.querySelectorAll(".cust-edit-btn").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      let cust = {};
      try { cust = JSON.parse(btn.dataset.customer || "{}"); } catch (_) {}
      openEditCustomerModal(cust, termOptions);
    });
  });

  // Delete (ADMIN only)
  container.querySelectorAll(".cust-delete-btn").forEach((btn) => {
    btn.addEventListener("click", async (e) => {
      e.stopPropagation();
      const confirmed = await openConfirmPopup({
        title: "Delete Customer",
        message: `Delete <strong>${escHtml(btn.dataset.name || "this customer")}</strong>? This cannot be undone and will remove all associated addresses, contacts, and history.`,
        confirmLabel: "Delete",
        danger: true,
      });
      if (!confirmed) return;
      try {
        await api(`/customers/${btn.dataset.id}`, { method: "DELETE" });
        setStatus("Customer deleted.");
        await loadMaster();
      } catch (error) {
        setStatus(error.message, true);
      }
    });
  });

  // Open 360
  container.querySelectorAll(".cust-code-btn, .cust-name-btn, .cust-360-btn").forEach((btn) => {
    btn.addEventListener("click", () => openCustomer360(btn.dataset.id, btn.dataset.code));
  });

  // Pagination
  const bodyEl = container.querySelector("#cust-body");
  container.querySelector("#cust-prev")?.addEventListener("click", () => {
    state.customerListPage = Math.max(1, state.customerListPage - 1);
    refreshCustBody(bodyEl, termOptions);
  });
  container.querySelector("#cust-next")?.addEventListener("click", () => {
    state.customerListPage = Math.min(totalPages, state.customerListPage + 1);
    refreshCustBody(bodyEl, termOptions);
  });
}

function refreshCustBody(bodyEl, termOptions) {
  const all = filteredCustomers();
  const totalPages = Math.max(1, Math.ceil(all.length / CUST_PAGE_SIZE));
  state.customerListPage = Math.min(state.customerListPage, totalPages);
  const page = state.customerListPage;
  const start = (page - 1) * CUST_PAGE_SIZE;
  const slice = all.slice(start, start + CUST_PAGE_SIZE);
  const isAdmin = (state.user?.role ?? "REP") === "ADMIN";
  bodyEl.innerHTML = buildCustBodyHtml(all, page, totalPages, start, slice, isAdmin);
  attachCustBodyListeners(bodyEl.closest(".cust-list-wrap")?.parentElement ?? bodyEl, totalPages, termOptions);
}

function renderCustomerListSection(container, termOptions) {
  const all = filteredCustomers();
  const totalPages = Math.max(1, Math.ceil(all.length / CUST_PAGE_SIZE));
  state.customerListPage = Math.min(state.customerListPage, totalPages);
  const page = state.customerListPage;
  const start = (page - 1) * CUST_PAGE_SIZE;
  const slice = all.slice(start, start + CUST_PAGE_SIZE);
  const role = state.user?.role ?? "REP";
  const isAdmin = role === "ADMIN";
  const canSeeTeam = ["MANAGER", "SUPERVISOR"].includes(role);
  const canSeeAll  = ["ADMIN", "DIRECTOR"].includes(role);

  const customerDefs = getCustomFieldDefinitions("customers").filter((d) => d.isActive);
  const activeCfFilterCount = Object.values(state.customerCustomFieldFilters || {}).filter((v) => v !== "" && v != null).length;
  const showCfFilters = customerDefs.length > 0;
  container.innerHTML = `
    <div class="cust-list-wrap">
      <div class="cust-list-toolbar">
        <div class="cust-search-wrap">
          <svg width="15" height="15" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
          <input class="cust-search" id="cust-search-input" placeholder="Search by code, name or tax ID…" value="${escHtml(state.customerListQuery)}" />
        </div>
        ${(canSeeTeam || canSeeAll) ? `
          <div class="cust-scope-pills">
            <button class="cust-scope-pill ${state.customerScope === "mine" ? "active" : ""}" data-scope="mine">My Customers</button>
            ${canSeeTeam || canSeeAll ? `<button class="cust-scope-pill ${state.customerScope === "team" ? "active" : ""}" data-scope="team">My Team</button>` : ""}
            ${canSeeAll ? `<button class="cust-scope-pill ${state.customerScope === "all" ? "active" : ""}" data-scope="all">All</button>` : ""}
          </div>` : ""}
        ${showCfFilters ? `
          <button class="ghost small" id="cust-filter-toggle">${state.masterFiltersOpen ? "Hide" : "Show"} filters${activeCfFilterCount ? ` (${activeCfFilterCount})` : ""}</button>
        ` : ""}
        <button class="cust-create-btn" id="cust-open-modal">
          <svg width="14" height="14" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
          New Customer
        </button>
      </div>
      ${showCfFilters && state.masterFiltersOpen ? `
        <form id="cust-cf-filter-form" class="cf-filter-panel" style="padding:var(--sp-3);background:var(--surface-soft);border:1px solid var(--border);border-radius:var(--r-md);margin-bottom:var(--sp-3)">
          ${renderCustomFieldFilters(customerDefs, state.customerCustomFieldFilters)}
          <div class="inline-actions wrap" style="margin-top:var(--sp-2)">
            <button type="submit">Apply filters</button>
            <button type="button" class="ghost" id="cust-cf-filter-clear">Clear</button>
          </div>
        </form>
      ` : ""}
      <div id="cust-body">${buildCustBodyHtml(all, page, totalPages, start, slice, isAdmin)}</div>
    </div>
  `;

  // Search — only refreshes the body, keeps input alive
  container.querySelector("#cust-search-input")?.addEventListener("input", (e) => {
    state.customerListQuery = e.target.value;
    state.customerListPage = 1;
    const bodyEl = container.querySelector("#cust-body");
    refreshCustBody(bodyEl, termOptions);
  });

  // Scope pills
  container.querySelectorAll(".cust-scope-pill").forEach((btn) => {
    btn.addEventListener("click", async () => {
      state.customerScope = btn.dataset.scope;
      state.customerListPage = 1;
      setStatus("Loading…");
      await loadMaster();
      setStatus("");
    });
  });

  // New Customer modal
  container.querySelector("#cust-open-modal")?.addEventListener("click", () => {
    openNewCustomerModal(termOptions);
  });

  // Custom field filter toggle + form
  container.querySelector("#cust-filter-toggle")?.addEventListener("click", () => {
    state.masterFiltersOpen = !state.masterFiltersOpen;
    renderCustomerListSection(container, termOptions);
  });
  container.querySelector("#cust-cf-filter-form")?.addEventListener("submit", (e) => {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    state.customerCustomFieldFilters = collectCustomFieldFilters(fd, getCustomFieldDefinitions("customers"));
    state.customerListPage = 1;
    renderCustomerListSection(container, termOptions);
  });
  container.querySelector("#cust-cf-filter-clear")?.addEventListener("click", () => {
    state.customerCustomFieldFilters = {};
    state.customerListPage = 1;
    renderCustomerListSection(container, termOptions);
  });

  attachCustBodyListeners(container, totalPages, termOptions);
}

// ── New Customer Modal ─────────────────────────────────────────────────────

// In-memory Thai geo dataset (loaded once)
let thaiGeoData = null;

async function loadThaiGeo() {
  if (thaiGeoData) return thaiGeoData;
  try {
    // Try our backend first (avoids CORS, has caching)
    const data = await api("/geo/th/search?q=ก"); // seed call
    if (Array.isArray(data) && data.length) {
      thaiGeoData = data; // partial dataset — will re-query as needed
      return thaiGeoData;
    }
  } catch { /* fallback */ }
  return null;
}

async function searchThaiGeo(q) {
  if (q.length < 2) return [];
  try {
    return await api(`/geo/th/search?q=${encodeURIComponent(q)}`);
  } catch {
    return [];
  }
}

function openNewCustomerModal(termOptions) {
  // Remove any existing modal
  qs("#new-cust-modal")?.remove();

  const role = state.user?.role ?? "REP";
  const canAssignOwner = ["ADMIN", "MANAGER"].includes(role);
  const ownerOptions = canAssignOwner && state.cache.allUsers?.length
    ? state.cache.allUsers.map((u) => `<option value="${u.id}" ${u.id === state.user?.id ? "selected" : ""}>${escHtml(u.fullName)}</option>`).join("")
    : `<option value="${state.user?.id ?? ""}">${escHtml(state.user?.fullName ?? "Me")}</option>`;

  const overlay = document.createElement("div");
  overlay.id = "new-cust-modal";
  overlay.className = "ncm-overlay";
  overlay.innerHTML = `
    <div class="ncm-panel" role="dialog" aria-modal="true" aria-label="New Customer">
      <div class="ncm-header">
        <div>
          <h2 class="ncm-title">New Customer</h2>
          <p class="ncm-subtitle muted small">Fill in the sections below. Addresses and contacts can be added after creation too.</p>
        </div>
        <button class="ncm-close" id="ncm-close" aria-label="Close">
          <svg width="18" height="18" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
        </button>
      </div>

      <form id="ncm-form" class="ncm-form" novalidate>
        <!-- ── Section 1: Core info ── -->
        <div class="ncm-section">
          <h3 class="ncm-section-title">
            <span class="ncm-section-num">1</span>
            Customer Info
          </h3>

          <div class="ncm-row ncm-row--2">
            <div class="ncm-field">
              <label class="ncm-label">Customer Type <span class="ncm-req">*</span></label>
              <div class="ncm-type-pills">
                <label class="ncm-type-pill">
                  <input type="radio" name="customerType" value="COMPANY" checked>
                  <span>${icon('building')} Company</span>
                </label>
                <label class="ncm-type-pill">
                  <input type="radio" name="customerType" value="PERSONAL">
                  <span>${icon('user')} Personal</span>
                </label>
              </div>
            </div>
            <div class="ncm-field">
              <label class="ncm-label" for="ncm-code">Customer Code <span class="ncm-req">*</span></label>
              <input class="ncm-input" id="ncm-code" name="customerCode" placeholder="Auto-generated" readonly aria-readonly="true" tabindex="-1" required />
              <small class="muted">Auto-generated by the system.</small>
            </div>
          </div>

          <div class="ncm-row">
            <div class="ncm-field">
              <label class="ncm-label" for="ncm-name">Customer Name <span class="ncm-req">*</span></label>
              <input class="ncm-input" id="ncm-name" name="name" placeholder="Full company or person name" required />
            </div>
          </div>

          <div class="ncm-row ncm-row--tax">
            <div class="ncm-field" style="flex:1">
              <label class="ncm-label" for="ncm-taxid">Tax ID / Juristic No.</label>
              <div style="display:flex;gap:8px">
                <input class="ncm-input" id="ncm-taxid" name="taxId" placeholder="13-digit Thai Tax ID" maxlength="20" style="flex:1" />
                <button type="button" class="ncm-dbd-btn" id="ncm-dbd-lookup" title="Lookup from DBD Datawarehouse">
                  <svg width="14" height="14" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
                  DBD Lookup
                </button>
              </div>
              <span class="ncm-dbd-status" id="ncm-dbd-status"></span>
            </div>
          </div>

          <div class="ncm-row">
            <div class="ncm-field">
              <label class="ncm-label" for="ncm-extref">External Ref <span class="ncm-hint-label">(legacy system ID)</span></label>
              <input class="ncm-input" id="ncm-extref" name="externalRef" placeholder="e.g. ERP-00123" maxlength="100" />
            </div>
          </div>

          <div class="ncm-row ncm-row--2">
            <div class="ncm-field">
              <label class="ncm-label" for="ncm-term">Payment Term <span class="ncm-req">*</span></label>
              <select class="ncm-input" id="ncm-term" name="defaultTermId" required>
                ${termOptions}
              </select>
            </div>
            ${canAssignOwner ? `
            <div class="ncm-field">
              <label class="ncm-label" for="ncm-owner">Owner</label>
              <select class="ncm-input" id="ncm-owner" name="ownerId">
                ${ownerOptions}
              </select>
            </div>` : ""}
          </div>
        </div>

        <!-- ── Section 2: Addresses ── -->
        <div class="ncm-section">
          <div class="ncm-section-header">
            <h3 class="ncm-section-title">
              <span class="ncm-section-num">2</span>
              Addresses
            </h3>
            <button type="button" class="ncm-add-link" id="ncm-add-addr">+ Add address</button>
          </div>
          <div id="ncm-addresses"></div>
        </div>

        <!-- ── Section 3: Contacts ── -->
        <div class="ncm-section">
          <div class="ncm-section-header">
            <h3 class="ncm-section-title">
              <span class="ncm-section-num">3</span>
              Contact Persons
              <span style="font-size:0.75rem;font-weight:400;color:var(--muted-color)">(at least 1 required)</span>
            </h3>
            <button type="button" class="ncm-add-link" id="ncm-add-contact">+ Add contact</button>
          </div>
          <div id="ncm-contacts"></div>
          <p class="ncm-contacts-hint muted small" id="ncm-contacts-hint">Each contact must have at least one of: Tel, Email, LINE ID, WhatsApp.</p>
        </div>

        <div class="ncm-footer">
          <button type="button" class="ghost ncm-cancel-btn" id="ncm-cancel">Cancel</button>
          <button type="submit" class="ncm-submit-btn" id="ncm-submit">
            <svg width="14" height="14" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
            Create Customer
          </button>
        </div>
      </form>
    </div>
  `;

  document.body.appendChild(overlay);

  // Animate in
  requestAnimationFrame(() => overlay.classList.add("ncm-open"));

  function closeModal() {
    overlay.classList.remove("ncm-open");
    overlay.addEventListener("transitionend", () => overlay.remove(), { once: true });
  }

  overlay.querySelector("#ncm-close")?.addEventListener("click", closeModal);
  overlay.querySelector("#ncm-cancel")?.addEventListener("click", closeModal);
  overlay.addEventListener("click", (e) => { if (e.target === overlay) closeModal(); });

  // ── Address blocks ──
  let addrCount = 0;
  function addAddressBlock(prefill = {}) {
    const idx = addrCount++;
    const block = document.createElement("div");
    block.className = "ncm-addr-block";
    block.dataset.idx = idx;
    block.innerHTML = `
      <div class="ncm-block-header">
        <span class="ncm-block-label">Address ${idx + 1}${idx === 0 ? " <span class='ncm-default-tag'>Default Billing &amp; Shipping</span>" : ""}</span>
        <button type="button" class="ncm-remove-btn" data-idx="${idx}">Remove</button>
      </div>
      <div class="ncm-row">
        <div class="ncm-field">
          <label class="ncm-label">Street Address <span class="ncm-req">*</span></label>
          <input class="ncm-input" name="addr_${idx}_addressLine1" placeholder="House no., road, moo" value="${escHtml(prefill.addressLine1 ?? "")}" required />
        </div>
      </div>
      <div class="ncm-row ncm-row--2">
        <div class="ncm-field ncm-geo-wrap">
          <label class="ncm-label">Sub-district (ตำบล)</label>
          <input class="ncm-input ncm-geo-input" name="addr_${idx}_subDistrict" placeholder="Type to search…" autocomplete="off" value="${escHtml(prefill.subDistrict ?? "")}" />
          <div class="ncm-geo-dropdown" hidden></div>
        </div>
        <div class="ncm-field ncm-geo-wrap">
          <label class="ncm-label">District (อำเภอ)</label>
          <input class="ncm-input ncm-geo-input" name="addr_${idx}_district" placeholder="Type to search…" autocomplete="off" value="${escHtml(prefill.district ?? "")}" />
          <div class="ncm-geo-dropdown" hidden></div>
        </div>
      </div>
      <div class="ncm-row ncm-row--2">
        <div class="ncm-field">
          <label class="ncm-label">Province (จังหวัด)</label>
          <input class="ncm-input" name="addr_${idx}_province" placeholder="e.g. Bangkok" value="${escHtml(prefill.province ?? "")}" />
        </div>
        <div class="ncm-field">
          <label class="ncm-label">Postal Code</label>
          <input class="ncm-input" name="addr_${idx}_postalCode" placeholder="e.g. 10110" maxlength="10" value="${escHtml(prefill.postalCode ?? "")}" />
        </div>
      </div>
      <div class="ncm-row">
        <div class="ncm-field">
          <label class="ncm-label">Country</label>
          <input class="ncm-input" name="addr_${idx}_country" placeholder="Thailand" value="${escHtml(prefill.country ?? "Thailand")}" />
        </div>
      </div>
    `;
    overlay.querySelector("#ncm-addresses").appendChild(block);

    // Remove
    block.querySelector(".ncm-remove-btn")?.addEventListener("click", () => {
      block.remove();
      // Re-label "Default" on remaining first block
      const remaining = overlay.querySelectorAll(".ncm-addr-block");
      remaining.forEach((b, i) => {
        const lbl = b.querySelector(".ncm-block-label");
        if (lbl) lbl.innerHTML = `Address ${i + 1}${i === 0 ? " <span class='ncm-default-tag'>Default Billing &amp; Shipping</span>" : ""}`;
      });
    });

    // Thai geo autocomplete
    block.querySelectorAll(".ncm-geo-input").forEach((input) => {
      const dropdown = input.nextElementSibling;
      let debounce;
      input.addEventListener("input", () => {
        clearTimeout(debounce);
        debounce = setTimeout(async () => {
          const q = input.value.trim();
          if (q.length < 2) { dropdown.hidden = true; return; }
          const results = await searchThaiGeo(q);
          if (!results.length) { dropdown.hidden = true; return; }
          dropdown.innerHTML = results.map((r) =>
            `<div class="ncm-geo-item" data-sub="${escHtml(r.sub_district)}" data-district="${escHtml(r.district)}" data-province="${escHtml(r.province)}" data-zip="${r.zipcode}">
              ${escHtml(r.sub_district)} · ${escHtml(r.district)} · ${escHtml(r.province)}
              <span class="ncm-geo-zip">${r.zipcode}</span>
            </div>`
          ).join("");
          dropdown.hidden = false;

          dropdown.querySelectorAll(".ncm-geo-item").forEach((item) => {
            item.addEventListener("click", () => {
              // Fill all four fields from the selection
              const f = block.querySelector(`[name="addr_${idx}_subDistrict"]`);
              const d = block.querySelector(`[name="addr_${idx}_district"]`);
              const p = block.querySelector(`[name="addr_${idx}_province"]`);
              const z = block.querySelector(`[name="addr_${idx}_postalCode"]`);
              if (f) f.value = item.dataset.sub;
              if (d) d.value = item.dataset.district;
              if (p) p.value = item.dataset.province;
              if (z) z.value = item.dataset.zip;
              dropdown.hidden = true;
            });
          });
        }, 280);
      });
      document.addEventListener("click", (e) => {
        if (!block.contains(e.target)) dropdown.hidden = true;
      });
    });
  }

  // ── Contact blocks ──
  let contactCount = 0;
  function addContactBlock() {
    const idx = contactCount++;
    const block = document.createElement("div");
    block.className = "ncm-contact-block";
    block.dataset.idx = idx;
    block.innerHTML = `
      <div class="ncm-block-header">
        <span class="ncm-block-label">Contact ${idx + 1}</span>
        <button type="button" class="ncm-remove-btn" data-idx="${idx}">Remove</button>
      </div>
      <div class="ncm-row ncm-row--2">
        <div class="ncm-field">
          <label class="ncm-label">Name <span class="ncm-req">*</span></label>
          <input class="ncm-input" name="contact_${idx}_name" placeholder="Full name" required />
        </div>
        <div class="ncm-field">
          <label class="ncm-label">Position <span class="ncm-req">*</span></label>
          <input class="ncm-input" name="contact_${idx}_position" placeholder="e.g. Purchasing Manager" required />
        </div>
      </div>
      <div class="ncm-row ncm-row--2">
        <div class="ncm-field">
          <label class="ncm-label">Tel.</label>
          <input class="ncm-input" name="contact_${idx}_tel" placeholder="+66 81 234 5678" type="tel" />
        </div>
        <div class="ncm-field">
          <label class="ncm-label">Email</label>
          <input class="ncm-input" name="contact_${idx}_email" placeholder="name@company.com" type="email" />
        </div>
      </div>
      <div class="ncm-row ncm-row--2">
        <div class="ncm-field">
          <label class="ncm-label">LINE ID</label>
          <input class="ncm-input" name="contact_${idx}_lineId" placeholder="@lineid" />
        </div>
        <div class="ncm-field">
          <label class="ncm-label">WhatsApp</label>
          <input class="ncm-input" name="contact_${idx}_whatsapp" placeholder="+66 81 234 5678" />
        </div>
      </div>
    `;
    overlay.querySelector("#ncm-contacts").appendChild(block);
    block.querySelector(".ncm-remove-btn")?.addEventListener("click", () => {
      block.remove();
      overlay.querySelectorAll(".ncm-contact-block").forEach((b, i) => {
        const lbl = b.querySelector(".ncm-block-label");
        if (lbl) lbl.textContent = `Contact ${i + 1}`;
      });
    });
  }

  overlay.querySelector("#ncm-add-addr")?.addEventListener("click", () => addAddressBlock());
  overlay.querySelector("#ncm-add-contact")?.addEventListener("click", () => addContactBlock());
  // Start with one address and one contact by default
  addAddressBlock();
  addContactBlock();

  // Auto-suggest next customer code (CUST-NNNNNN)
  const codeInput = overlay.querySelector("#ncm-code");
  if (codeInput) {
    const codes = (state.cache.customers || []).map((c) => c.customerCode);
    let maxNum = 0;
    for (const code of codes) {
      const m = code.match(/^CUST-(\d+)$/i);
      if (m) maxNum = Math.max(maxNum, parseInt(m[1], 10));
    }
    codeInput.value = `CUST-${String(maxNum + 1).padStart(6, "0")}`;
  }

  // ── DBD Lookup ──
  overlay.querySelector("#ncm-dbd-lookup")?.addEventListener("click", async () => {
    const taxInput = overlay.querySelector("#ncm-taxid");
    const statusEl = overlay.querySelector("#ncm-dbd-status");
    const taxId = taxInput?.value?.trim() ?? "";
    if (!taxId) { if (statusEl) statusEl.textContent = "Enter a Tax ID first."; return; }
    if (statusEl) { statusEl.textContent = "Looking up…"; statusEl.className = "ncm-dbd-status"; }
    try {
      const data = await api(`/dbd/company/${encodeURIComponent(taxId)}`);
      if (data.name) {
        const nameInput = overlay.querySelector("#ncm-name");
        if (nameInput) nameInput.value = data.name;
        // Pre-fill first address if DBD returned address
        if (data.addressLine1 || data.province || data.postalCode) {
          const firstAddr = overlay.querySelector(".ncm-addr-block");
          if (firstAddr) {
            const addrIdx = firstAddr.dataset.idx;
            if (data.addressLine1) {
              const f = firstAddr.querySelector(`[name="addr_${addrIdx}_addressLine1"]`);
              if (f) f.value = data.addressLine1;
            }
            if (data.province) {
              const f = firstAddr.querySelector(`[name="addr_${addrIdx}_province"]`);
              if (f) f.value = data.province;
            }
            if (data.postalCode) {
              const f = firstAddr.querySelector(`[name="addr_${addrIdx}_postalCode"]`);
              if (f) f.value = data.postalCode;
            }
          }
        }
        if (statusEl) { statusEl.textContent = `Found: ${data.name}${data.status ? " (" + data.status + ")" : ""}`; statusEl.className = "ncm-dbd-status ncm-dbd-ok"; }
      } else {
        if (statusEl) { statusEl.textContent = "Company found but no name returned."; statusEl.className = "ncm-dbd-status"; }
      }
    } catch (err) {
      if (statusEl) { statusEl.textContent = err.message ?? "Lookup failed."; statusEl.className = "ncm-dbd-status ncm-dbd-err"; }
    }
  });

  // Tax ID: numbers only, max 13 digits
  const ncmTaxInput = overlay.querySelector("#ncm-taxid");
  if (ncmTaxInput) {
    ncmTaxInput.setAttribute("inputmode", "numeric");
    ncmTaxInput.setAttribute("maxlength", "13");
    ncmTaxInput.addEventListener("input", () => {
      ncmTaxInput.value = ncmTaxInput.value.replace(/\D/g, "").slice(0, 13);
    });
  }

  // ── Form submit ──
  overlay.querySelector("#ncm-form")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const formData = new FormData(event.currentTarget);
    const submitBtn = overlay.querySelector("#ncm-submit");

    // Collect address blocks
    const addrBlocks = [...overlay.querySelectorAll(".ncm-addr-block")];
    const addresses = addrBlocks.map((b) => {
      const idx = b.dataset.idx;
      return {
        addressLine1: String(formData.get(`addr_${idx}_addressLine1`) ?? "").trim(),
        subDistrict:  String(formData.get(`addr_${idx}_subDistrict`) ?? "").trim() || undefined,
        district:     String(formData.get(`addr_${idx}_district`) ?? "").trim() || undefined,
        province:     String(formData.get(`addr_${idx}_province`) ?? "").trim() || undefined,
        postalCode:   String(formData.get(`addr_${idx}_postalCode`) ?? "").trim() || undefined,
        country:      String(formData.get(`addr_${idx}_country`) ?? "").trim() || undefined,
      };
    }).filter((a) => a.addressLine1);

    // Collect contact blocks
    const contactBlocks = [...overlay.querySelectorAll(".ncm-contact-block")];
    const contacts = contactBlocks.map((b) => {
      const idx = b.dataset.idx;
      return {
        name:     String(formData.get(`contact_${idx}_name`) ?? "").trim(),
        position: String(formData.get(`contact_${idx}_position`) ?? "").trim(),
        tel:      String(formData.get(`contact_${idx}_tel`) ?? "").trim() || undefined,
        email:    String(formData.get(`contact_${idx}_email`) ?? "").trim() || undefined,
        lineId:   String(formData.get(`contact_${idx}_lineId`) ?? "").trim() || undefined,
        whatsapp: String(formData.get(`contact_${idx}_whatsapp`) ?? "").trim() || undefined,
      };
    }).filter((c) => c.name && c.position);

    // Validate at least one contact has a channel
    if (contacts.length === 0) {
      setStatus("Add at least one contact person.", true);
      return;
    }
    for (const c of contacts) {
      if (!c.tel && !c.email && !c.lineId && !c.whatsapp) {
        setStatus(`Contact "${c.name}" needs at least one of: Tel, Email, LINE ID, WhatsApp.`, true);
        return;
      }
    }

    const taxIdRaw = String(formData.get("taxId") ?? "").trim();
    if (taxIdRaw && !/^\d{13}$/.test(taxIdRaw)) {
      setStatus("Tax ID must be exactly 13 digits.", true);
      return;
    }

    const externalRefRaw = String(formData.get("externalRef") ?? "").trim();
    const payload = {
      customerCode: String(formData.get("customerCode") ?? "").trim(),
      name:         String(formData.get("name") ?? "").trim(),
      customerType: String(formData.get("customerType") ?? "COMPANY"),
      taxId:        taxIdRaw || undefined,
      defaultTermId: String(formData.get("defaultTermId") ?? ""),
      ownerId:      String(formData.get("ownerId") ?? state.user?.id ?? ""),
      externalRef:  externalRefRaw || undefined,
    };

    if (submitBtn) { submitBtn.disabled = true; submitBtn.textContent = "Creating…"; }
    try {
      const created = await api("/customers", { method: "POST", body: payload });
      // Post addresses sequentially
      for (const addr of addresses) {
        await api(`/customers/${created.id}/addresses`, { method: "POST", body: addr });
      }
      // Post contacts sequentially
      for (const contact of contacts) {
        await api(`/customers/${created.id}/contacts`, { method: "POST", body: contact });
      }
      setStatus("Customer created successfully.");
      closeModal();
      await loadMaster();
    } catch (err) {
      setStatus(err.message ?? "Failed to create customer.", true);
      if (submitBtn) { submitBtn.disabled = false; submitBtn.textContent = "Create Customer"; }
    }
  });
}

// ── Edit Customer Modal ───────────────────────────────────────────────────────

function openEditCustomerModal(cust, termOptions) {
  qs("#edit-cust-modal")?.remove();
  const overlay = document.createElement("div");
  overlay.id = "edit-cust-modal";
  overlay.className = "modal-overlay";

  const termOpts = (termOptions || []).map(
    (t) => `<option value="${t.id}" ${t.id === cust.defaultTermId ? "selected" : ""}>${escHtml(t.code)} — ${escHtml(t.name)}</option>`
  ).join("");

  overlay.innerHTML = `
    <div class="ncm-card" style="max-width:480px">
      <div class="ncm-header">
        <span class="ncm-title">Edit Customer</span>
        <button type="button" class="ncm-close" id="ecm-close">${icon('x', 14)}</button>
      </div>
      <form id="edit-cust-form" class="ncm-body" novalidate>
        <div class="ncm-row">
          <label class="ncm-label" for="ecm-code">Customer Code</label>
          <input class="ncm-input" id="ecm-code" name="customerCode" value="${escHtml(cust.customerCode || "")}" readonly aria-readonly="true" tabindex="-1" required />
          <small class="muted">System-generated. Not editable.</small>
        </div>
        <div class="ncm-row">
          <label class="ncm-label" for="ecm-name">Name</label>
          <input class="ncm-input" id="ecm-name" name="name" value="${escHtml(cust.name || "")}" required />
        </div>
        <div class="ncm-row">
          <label class="ncm-label" for="ecm-type">Type</label>
          <select class="ncm-input" id="ecm-type" name="customerType">
            <option value="COMPANY" ${cust.customerType === "COMPANY" ? "selected" : ""}>Company</option>
            <option value="PERSONAL" ${cust.customerType === "PERSONAL" ? "selected" : ""}>Personal</option>
          </select>
        </div>
        <div class="ncm-row">
          <label class="ncm-label" for="ecm-taxid">Tax ID / Juristic No.</label>
          <input class="ncm-input" id="ecm-taxid" name="taxId" value="${escHtml(cust.taxId || "")}" placeholder="13-digit Thai Tax ID" maxlength="13" inputmode="numeric" pattern="\\d{13}" />
          <span class="ncm-hint" id="ecm-taxid-hint" style="color:var(--danger);font-size:0.78rem;display:none">Must be exactly 13 digits.</span>
        </div>
        <div class="ncm-row">
          <label class="ncm-label" for="ecm-extref">External Ref <span style="font-weight:400;color:var(--muted-color)">(legacy system ID)</span></label>
          <input class="ncm-input" id="ecm-extref" name="externalRef" value="${escHtml(cust.externalRef || "")}" placeholder="e.g. ERP-00123" maxlength="100" />
        </div>
        <div class="ncm-row">
          <label class="ncm-label" for="ecm-term">Payment Term</label>
          <select class="ncm-input" id="ecm-term" name="defaultTermId">
            <option value="">— None —</option>
            ${termOpts}
          </select>
        </div>
        <div class="ncm-footer">
          <button type="button" class="ncm-cancel-btn" id="ecm-cancel">Cancel</button>
          <button type="submit" class="ncm-submit-btn" id="ecm-submit">Save Changes</button>
        </div>
      </form>
    </div>`;

  document.body.appendChild(overlay);

  const closeModal = () => overlay.remove();
  overlay.querySelector("#ecm-close").addEventListener("click", closeModal);
  overlay.querySelector("#ecm-cancel").addEventListener("click", closeModal);
  overlay.addEventListener("click", (e) => { if (e.target === overlay) closeModal(); });

  // Tax ID: numbers only, live filter
  const taxInput = overlay.querySelector("#ecm-taxid");
  const taxHint  = overlay.querySelector("#ecm-taxid-hint");
  taxInput.addEventListener("input", () => {
    taxInput.value = taxInput.value.replace(/\D/g, "").slice(0, 13);
    taxHint.style.display = (taxInput.value && taxInput.value.length !== 13) ? "" : "none";
  });

  const form = overlay.querySelector("#edit-cust-form");
  const submitBtn = overlay.querySelector("#ecm-submit");
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const formData = new FormData(form);
    const taxId = String(formData.get("taxId") ?? "").trim();
    if (taxId && !/^\d{13}$/.test(taxId)) {
      setStatus("Tax ID must be exactly 13 digits.", true);
      taxHint.style.display = "";
      return;
    }
    const externalRefEdit = String(formData.get("externalRef") ?? "").trim();
    const payload = {
      customerCode:  String(formData.get("customerCode") ?? "").trim(),
      name:          String(formData.get("name") ?? "").trim(),
      customerType:  String(formData.get("customerType") ?? "COMPANY"),
      taxId:         taxId || undefined,
      defaultTermId: String(formData.get("defaultTermId") ?? "") || undefined,
      externalRef:   externalRefEdit || undefined,
    };
    if (submitBtn) { submitBtn.disabled = true; submitBtn.textContent = "Saving…"; }
    try {
      await api(`/customers/${cust.id}`, { method: "PATCH", body: payload });
      setStatus("Customer updated.");
      closeModal();
      await loadMaster();
    } catch (err) {
      setStatus(err.message ?? "Failed to update customer.", true);
      if (submitBtn) { submitBtn.disabled = false; submitBtn.textContent = "Save Changes"; }
    }
  });
}

// ── Customer 360 ─────────────────────────────────────────────────────────────


/** Render a single field mapping editor row. */
function syncMappingRowHtml(idx, m) {
  const d = m || {};
  return `
    <div class="sync-mapping-row" style="display:flex;gap:var(--sp-2);align-items:center;margin-bottom:var(--sp-2);flex-wrap:wrap">
      <select name="entityType" class="form-control" style="width:120px">
        <option value="CUSTOMER" ${d.entityType === "CUSTOMER" ? "selected" : ""}>Customer</option>
        <option value="ITEM" ${d.entityType === "ITEM" ? "selected" : ""}>Item</option>
        <option value="PAYMENT_TERM" ${d.entityType === "PAYMENT_TERM" ? "selected" : ""}>Payment Term</option>
      </select>
      <input type="text" name="sourceField" placeholder="ERP field (e.g. cust_code)" value="${escHtml(d.sourceField || "")}" class="form-control" style="width:150px">
      <span>→</span>
      <input type="text" name="targetField" placeholder="CRM field (e.g. customerCode)" value="${escHtml(d.targetField || "")}" class="form-control" style="width:150px">
      <input type="text" name="transformRule" placeholder="Transform (trim/upper/lower/number)" value="${escHtml(d.transformRule || "")}" class="form-control" style="width:140px">
      <label style="display:flex;align-items:center;gap:4px;font-size:0.82rem"><input type="checkbox" name="isRequired" ${d.isRequired ? "checked" : ""}> Required</label>
      <button type="button" class="ghost small" onclick="this.closest('.sync-mapping-row').remove()">${icon('x', 12)}</button>
    </div>`;
}

/** Translate a cron expression into a human-readable string showing the timezone. */
function describeCron(expr, tz) {
  if (!expr) return "";
  const tzLabel = tz || "UTC";
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) return `Expression: ${expr}`;
  const [min, hour, dom, month, dow] = parts;
  const DAYS_EN = ["Sunday","Monday","Tuesday","Wednesday","Thursday","Friday","Saturday"];
  const MONTHS_EN = ["","January","February","March","April","May","June","July","August","September","October","November","December"];
  const toNum = v => parseInt(v, 10);
  if (dom === "*" && month === "*") {
    const dayPart = dow === "*" ? "every day" : (dow.split(",").map(d => DAYS_EN[toNum(d)] || d).join(", "));
    const timePart = `${String(toNum(hour)).padStart(2,"0")}:${String(toNum(min)).padStart(2,"0")}`;
    return `${dayPart} at ${timePart} (${tzLabel})`;
  }
  if (dom !== "*") {
    const monthPart = month === "*" ? "every month" : `${MONTHS_EN[toNum(month)] || month}`;
    return `Day ${dom} of ${monthPart} at ${String(toNum(hour)).padStart(2,"0")}:${String(toNum(min)).padStart(2,"0")} (${tzLabel})`;
  }
  return `${expr} (${tzLabel})`;
}

function exportRows(baseName, rows, format) {
  if (!rows.length) { setStatus("Nothing to export.", true); return; }
  if (format === "csv") {
    const headers = Object.keys(rows[0]);
    const esc = (v) => { const s = v == null ? "" : String(v); return s.includes(",") || s.includes('"') || s.includes("\n") ? `"${s.replace(/"/g, '""')}"` : s; };
    const csv = [headers.join(","), ...rows.map(r => headers.map(h => esc(r[h])).join(","))].join("\r\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a"); a.href = url; a.download = `${baseName}.csv`; a.style.display = "none";
    document.body.appendChild(a); a.click();
    setTimeout(() => { document.body.removeChild(a); URL.revokeObjectURL(url); }, 200);
  } else {
    const ws = XLSX.utils.json_to_sheet(rows);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, baseName.slice(0, 31));
    XLSX.writeFile(wb, `${baseName}.xlsx`);
  }
}


async function loadMaster() {
  const scopeParam = state.customerScope !== "mine"
    ? `?scope=${encodeURIComponent(state.customerScope)}`
    : "";
  const [paymentTerms, customers, items, paymentTermCustomFields, customerCustomFields, itemCustomFields] = await Promise.all([
    api("/payment-terms"),
    api(`/customers${scopeParam}`),
    api("/items"),
    api("/custom-fields/payment-term"),
    api("/custom-fields/customer"),
    api("/custom-fields/item")
  ]);
  state.cache.paymentTerms = paymentTerms;
  state.cache.customers = customers;
  state.cache.items = items;
  state.cache.customFieldDefinitions = {
    "payment-terms": paymentTermCustomFields,
    customers: customerCustomFields,
    items: itemCustomFields
  };
  renderMasterData(paymentTerms);
}

async function loadDeals() {
  const data = await api("/deals/kanban");
  state.cache.kanban = data;
  state.cache.dealStages = Array.isArray(data?.stages) ? data.stages : [];
  if (state.deal360) {
    renderDeal360();
    return;
  }
  renderDeals(data, views.deals, { compact: false });
}


async function loadIntegrations() {
  const isAtLeastManager = state.user?.role === "ADMIN" || state.user?.role === "DIRECTOR" || state.user?.role === "MANAGER";
  if (!isAtLeastManager) return;
  const data = await api("/integrations/logs");
  state.cache.logs = data;
  renderIntegrationLogs(data);
}

async function loadSyncData() {
  try {
    const [apiKeys, sources, jobs] = await Promise.all([
      api("/sync/api-keys"),
      api("/integrations/master-data/sources"),
      api("/sync/jobs?limit=20")
    ]);
    state.cache.syncApiKeys = apiKeys;
    state.cache.syncSources = sources;
    state.cache.syncJobs = jobs;
  } catch {
    // Sync endpoints may not exist yet in older deployments
  }
}

async function loadSettings() {
  const tenantId = state.user?.tenantId;
  if (!tenantId) return;
  const isAdmin   = state.user?.role === "ADMIN";
  const isManager = state.user?.role === "ADMIN" || state.user?.role === "DIRECTOR" || state.user?.role === "MANAGER";
  // branding, taxConfig, visitConfig, and integrationCredentials require MANAGER+
  // — skip them for REP/SUPERVISOR so the Promise.all doesn't fail with 403
  const isAtLeastManager = isManager;
  const [branding, taxConfig, visitConfig, kpiTargets, salesReps, integrationCredentials, teams, tenantSummary] = await Promise.all([
    api(`/tenants/${tenantId}/branding`),
    isAtLeastManager ? api(`/tenants/${tenantId}/tax-config`) : Promise.resolve(state.cache.taxConfig),
    isAtLeastManager ? api(`/tenants/${tenantId}/visit-config`) : Promise.resolve(state.cache.visitConfig),
    api("/kpi-targets"),
    state.user?.role !== "REP" ? api("/users/visible-reps") : Promise.resolve([]),
    isAtLeastManager ? api(`/tenants/${tenantId}/integrations/credentials`) : Promise.resolve(state.cache.integrationCredentials ?? []),
    api("/teams"),
    isAdmin ? api(`/tenants/${tenantId}/summary`) : Promise.resolve(null)
  ]);
  state.cache.branding = branding;
  state.cache.taxConfig = taxConfig;
  state.cache.visitConfig = visitConfig;
  state.cache.kpiTargets = kpiTargets;
  state.cache.salesReps = salesReps;
  state.cache.integrationCredentials = integrationCredentials;
  state.cache.teams = teams;
  state.cache.allUsers = tenantSummary?.users || [];
  state.cache.tenantInfo = tenantSummary ? { id: tenantSummary.id, name: tenantSummary.name, slug: tenantSummary.slug, timezone: tenantSummary.timezone ?? "Asia/Bangkok" } : null;
  if (isAdmin) await loadDelegations();
  if (branding) applyBrandingTheme(branding);
  // Load sync data only for admins on the data-sync page
  if (isAdmin && state.settingsPage === "data-sync") {
    await loadSyncData();
  }
  renderSettings();
}

async function loadAllViews() {
  await Promise.all([
    loadDashboard(),
    loadMaster(),
    loadDeals(),
    loadVisits(),
    loadCalendar(),
    loadIntegrations(),
    loadSettings(),
    canActOnBehalf() ? loadMyPrincipals() : Promise.resolve()
  ]);
}

loginForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  authMessage.textContent = "";

  const formData = new FormData(loginForm);
  const payload = Object.fromEntries(formData.entries());
  try {
    const result = await api("/auth/login", { method: "POST", body: payload, headers: {} });
    if (result.needsEmailVerification) {
      // Show the "check your email" panel
      const loginPanel = qs(".login-form");
      if (loginPanel) loginPanel.hidden = true;
      const pendingPanel = qs("#verify-pending-panel");
      const pendingEmail = qs("#verify-pending-email");
      if (pendingPanel) {
        pendingPanel.hidden = false;
        pendingPanel._tenantSlug = result.tenantSlug || payload.tenantSlug;
        pendingPanel._email = result.email || payload.email;
      }
      if (pendingEmail) pendingEmail.textContent = result.email || payload.email;
      return;
    }
    state.token = result.accessToken;
    state.user = result.user;
    state.calendarFilters.ownerIds = [result.user.id];
    localStorage.setItem("thinkcrm_token", state.token);
    showApp();
    showTrialBanner(result.user.subscription);
    if (window._checkSuperAdmin) window._checkSuperAdmin();
    updateUserMeta();
    const onMasterRoute = syncMasterPageFromLocation();
    const onSimpleViewRoute = !onMasterRoute && syncSimpleViewFromLocation();
    await loadAllViews();
    applyBrandingTheme(state.cache.branding);
    if (onMasterRoute) {
      switchView("master");
    } else if (onSimpleViewRoute) {
      switchView(onSimpleViewRoute);
      if (onSimpleViewRoute === "repHub") paintRepHubFull();
      if (onSimpleViewRoute === "dashboard") await loadOnboardingWizard();
      if (onSimpleViewRoute === "superAdmin" && window._loadSuperAdmin) window._loadSuperAdmin();
    } else {
      window.history.replaceState({ view: "repHub" }, "", "/task");
      switchView("repHub");
      paintRepHubFull();
    }
    hideAppLoading();
    await loadDemoDataStatus();
    renderDemoDataBanner();
  } catch (error) {
    hideAppLoading();
    authMessage.textContent = error.message;
  }
});

// ── Forgot / Reset password (H10) ────────────────────────────────────────────
(function initPasswordReset() {
  const loginPanel = qs(".login-form");
  const forgotPanel = qs("#forgot-password-panel");
  const resetPanel = qs("#reset-password-panel");
  const forgotLink = qs("#forgot-password-link");
  const backLink = qs("#back-to-login-link");
  const forgotForm = qs("#forgot-password-form");
  const resetForm = qs("#reset-password-form");
  const forgotMsg = qs("#forgot-message");
  const resetMsg = qs("#reset-message");

  if (!forgotPanel || !resetPanel) return;

  // If the URL has ?token=, show the reset-password panel instead of login.
  const urlParams = new URLSearchParams(window.location.search);
  const resetToken = urlParams.get("token");
  if (resetToken && window.location.pathname === "/reset-password") {
    loginPanel.hidden = true;
    resetPanel.hidden = false;
    qs("#reset-token-input").value = resetToken;
  }

  forgotLink?.addEventListener("click", (e) => {
    e.preventDefault();
    loginPanel.hidden = true;
    forgotPanel.hidden = false;
    // Pre-fill workspace from login form
    const slug = loginForm.querySelector('[name="tenantSlug"]')?.value;
    if (slug) forgotPanel.querySelector('[name="tenantSlug"]').value = slug;
    forgotMsg.textContent = "";
  });

  backLink?.addEventListener("click", (e) => {
    e.preventDefault();
    forgotPanel.hidden = true;
    loginPanel.hidden = false;
  });

  forgotForm?.addEventListener("submit", async (e) => {
    e.preventDefault();
    forgotMsg.textContent = "";
    forgotMsg.className = "login-error";
    const btn = forgotForm.querySelector('button[type="submit"]');
    btn.disabled = true;
    btn.textContent = "Sending…";
    try {
      const fd = new FormData(forgotForm);
      await fetch("/api/v1/auth/forgot-password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(Object.fromEntries(fd.entries()))
      });
      // Always show success regardless of server response to prevent enumeration.
      forgotMsg.className = "login-error login-success";
      forgotMsg.textContent = "If that account exists, a reset link has been sent to your email.";
      forgotForm.reset();
    } catch {
      forgotMsg.textContent = "Something went wrong. Please try again.";
    } finally {
      btn.disabled = false;
      btn.textContent = "Send reset link";
    }
  });

  resetForm?.addEventListener("submit", async (e) => {
    e.preventDefault();
    resetMsg.textContent = "";
    resetMsg.className = "login-error";
    const fd = new FormData(resetForm);
    const newPw = fd.get("newPassword");
    const confirmPw = fd.get("confirmPassword");
    if (newPw !== confirmPw) {
      resetMsg.textContent = "Passwords do not match.";
      return;
    }
    if (String(newPw).length < 12) {
      resetMsg.textContent = "Password must be at least 12 characters.";
      return;
    }
    const btn = resetForm.querySelector('button[type="submit"]');
    btn.disabled = true;
    btn.textContent = "Resetting…";
    try {
      const res = await fetch("/api/v1/auth/reset-password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: fd.get("token"), newPassword: newPw })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.message || "Reset failed.");
      resetMsg.className = "login-error login-success";
      resetMsg.textContent = "Password reset successfully. Redirecting to login…";
      resetForm.reset();
      setTimeout(() => { window.location.href = "/"; }, 2000);
    } catch (err) {
      resetMsg.textContent = err.message || "Invalid or expired reset link.";
    } finally {
      btn.disabled = false;
      btn.textContent = "Reset password";
    }
  });
})();

// ── Self-service signup (S3) ──────────────────────────────────────────────────
(function initSignup() {
  const loginPanel       = qs(".login-form");
  const signupPanel      = qs("#signup-panel");
  const createLink       = qs("#create-workspace-link");
  const backLink         = qs("#back-to-login-from-signup");
  const signupForm       = qs("#signup-form");
  const signupMsg        = qs("#signup-message");
  const slugInput        = signupForm?.querySelector('[name="slug"]');
  const slugStatus       = qs("#slug-status");
  const slugHint         = qs("#slug-hint");
  const companyInput     = signupForm?.querySelector('[name="companyName"]');

  if (!signupPanel) return;

  // Show signup panel if URL is /signup
  if (window.location.pathname === "/signup") {
    loginPanel.hidden = true;
    signupPanel.hidden = false;
  }

  createLink?.addEventListener("click", (e) => {
    e.preventDefault();
    loginPanel.hidden = true;
    signupPanel.hidden = false;
    signupMsg.textContent = "";
    history.replaceState(null, "", "/signup");
  });

  backLink?.addEventListener("click", (e) => {
    e.preventDefault();
    signupPanel.hidden = true;
    loginPanel.hidden = false;
    history.replaceState(null, "", "/");
  });

  // Auto-generate slug from company name
  companyInput?.addEventListener("input", () => {
    if (!slugInput || slugInput.dataset.edited === "true") return;
    const raw = companyInput.value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
    slugInput.value = raw.slice(0, 60);
    if (raw) checkSlug(raw);
  });

  // Mark as manually edited once the user types in slug directly
  slugInput?.addEventListener("input", () => {
    slugInput.dataset.edited = "true";
    const slug = slugInput.value.trim();
    if (slug.length >= 2) checkSlug(slug);
    else { slugStatus.textContent = ""; slugStatus.className = "signup-slug-status"; slugHint.textContent = ""; }
  });

  let slugTimer = null;
  function checkSlug(slug) {
    if (!slugStatus) return;
    clearTimeout(slugTimer);
    slugStatus.textContent = "…";
    slugStatus.className = "signup-slug-status checking";
    slugHint.textContent = "";
    slugTimer = setTimeout(async () => {
      try {
        const res = await fetch(`/api/v1/tenants/check-slug?slug=${encodeURIComponent(slug)}`);
        const data = await res.json();
        if (data.available) {
          slugStatus.textContent = "Available";
          slugStatus.className = "signup-slug-status available";
          slugHint.textContent = `Your workspace URL: ${location.hostname}/${slug}`;
        } else {
          slugStatus.textContent = "Taken";
          slugStatus.className = "signup-slug-status taken";
          slugHint.textContent = "Try adding your company initials or a number.";
        }
      } catch {
        slugStatus.textContent = "";
        slugStatus.className = "signup-slug-status";
      }
    }, 400);
  }

  signupForm?.addEventListener("submit", async (e) => {
    e.preventDefault();
    signupMsg.textContent = "";
    const btn = signupForm.querySelector('button[type="submit"]');
    btn.disabled = true;
    btn.textContent = "Creating…";
    try {
      const fd = new FormData(signupForm);
      const body = {
        companyName:   fd.get("companyName"),
        slug:          fd.get("slug"),
        adminFullName: fd.get("adminFullName"),
        adminEmail:    fd.get("adminEmail"),
        adminPassword: fd.get("adminPassword")
      };
      const res  = await fetch("/api/v1/tenants/signup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body)
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.message || "Signup failed.");

      if (data.needsEmailVerification) {
        // Show "check your email" panel
        signupPanel.hidden = true;
        const pendingPanel = qs("#verify-pending-panel");
        const pendingEmail = qs("#verify-pending-email");
        if (pendingPanel) pendingPanel.hidden = false;
        if (pendingEmail) pendingEmail.textContent = data.email || body.adminEmail;
        // Store context for resend button
        pendingPanel._tenantSlug = data.tenantSlug || body.slug;
        pendingPanel._email = data.email || body.adminEmail;
      } else if (data.token) {
        // Fallback: auto-login if server returns a token (shouldn't happen with email verify)
        localStorage.setItem("jwt", data.token);
        localStorage.setItem("tenantSlug", data.tenantSlug);
        window.location.href = "/dashboard";
      }
    } catch (err) {
      signupMsg.textContent = err.message || "Something went wrong. Please try again.";
      btn.disabled = false;
      btn.textContent = "Create workspace";
    }
  });
})();

// ── Email verification ─────────────────────────────────────────────────────────
(function initEmailVerification() {
  const loginPanel      = qs(".login-form");
  const pendingPanel    = qs("#verify-pending-panel");
  const verifyPanel     = qs("#verify-email-panel");
  const resendBtn       = qs("#resend-verify-btn");
  const pendingMsg      = qs("#verify-pending-message");

  // Resend verification email button
  resendBtn?.addEventListener("click", async () => {
    const slug  = pendingPanel?._tenantSlug;
    const email = pendingPanel?._email;
    if (!slug || !email) return;
    resendBtn.disabled = true;
    resendBtn.textContent = "Sending…";
    pendingMsg.textContent = "";
    try {
      await fetch("/api/v1/auth/resend-verification", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tenantSlug: slug, email })
      });
      pendingMsg.style.color = "#16a34a";
      pendingMsg.textContent = "Verification email sent! Check your inbox.";
    } catch {
      pendingMsg.style.color = "";
      pendingMsg.textContent = "Failed to resend. Please try again.";
    }
    resendBtn.disabled = false;
    resendBtn.textContent = "Resend verification email";
  });

  // Handle /verify-email?token= route
  if (window.location.pathname === "/verify-email") {
    const token = new URLSearchParams(window.location.search).get("token");
    if (!token) return;

    // Hide login form, show verify panel
    if (loginPanel) loginPanel.hidden = true;
    document.querySelectorAll(".login-form").forEach(p => p.hidden = true);
    if (verifyPanel) verifyPanel.hidden = false;

    const heading  = qs("#verify-email-heading");
    const subtitle = qs("#verify-email-subtitle");
    const msg      = qs("#verify-email-message");
    const link     = qs("#verify-email-signin-link");

    (async () => {
      try {
        const res = await fetch(`/api/v1/auth/verify-email?token=${encodeURIComponent(token)}`);
        const data = await res.json();
        if (!res.ok) throw new Error(data.message || "Verification failed.");
        heading.textContent = "Email verified!";
        subtitle.textContent = data.message || "Your email has been verified. You can now sign in.";
        if (link) {
          link.hidden = false;
          link.href = data.tenantSlug ? `/?workspace=${data.tenantSlug}` : "/";
        }
      } catch (err) {
        heading.textContent = "Verification failed";
        subtitle.textContent = "";
        msg.textContent = err.message || "Invalid or expired verification link.";
        if (link) { link.hidden = false; link.textContent = "\u2190 Back to sign in"; link.href = "/"; }
      }
    })();
  }
})();

// ── Accept invite (S4) ──────────────────────────────────────────────────────────
(function initAcceptInvite() {
  const loginPanel   = qs(".login-form");
  const invitePanel  = qs("#accept-invite-panel");
  const inviteForm   = qs("#accept-invite-form");
  const inviteMsg    = qs("#invite-message");

  if (!invitePanel) return;

  const urlParams   = new URLSearchParams(window.location.search);
  const inviteToken = urlParams.get("token");
  if (inviteToken && window.location.pathname === "/accept-invite") {
    loginPanel.hidden  = true;
    invitePanel.hidden = false;
    qs("#invite-token-input").value = inviteToken;
  }

  inviteForm?.addEventListener("submit", async (e) => {
    e.preventDefault();
    inviteMsg.textContent = "";
    inviteMsg.className   = "login-error";
    const fd        = new FormData(inviteForm);
    const pw        = fd.get("password");
    const confirmPw = fd.get("confirmPassword");
    if (pw !== confirmPw) { inviteMsg.textContent = "Passwords do not match."; return; }
    if (String(pw).length < 12) { inviteMsg.textContent = "Password must be at least 12 characters."; return; }

    const btn = inviteForm.querySelector('button[type="submit"]');
    btn.disabled    = true;
    btn.textContent = "Creating account…";
    try {
      const res = await fetch("/api/v1/auth/accept-invite", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: fd.get("token"), fullName: fd.get("fullName"), password: pw })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.message || "Could not accept invite.");

      // Auto-login: store token and redirect to dashboard.
      localStorage.setItem("jwt", data.token);
      localStorage.setItem("tenantSlug", data.user.tenantSlug);
      window.location.href = "/dashboard";
    } catch (err) {
      inviteMsg.textContent = err.message || "Invalid or expired invite link.";
      btn.disabled    = false;
      btn.textContent = "Create account";
    }
  });
})();

setCalendarDeps({
  openVisitCreateModal,
  showEventDetail,
  msDropdown,
  initMsDropdown
});

setCustomer360Deps({
  asMoney,
  avatarColor,
  c360Initials,
  navigateToCustomer360,
  navigateToMasterPage,
  renderMasterData,
  openVisitCreateModal,
  openDealCreateModal
});

const showToast = (message, type) => setStatus(message, type === "error");

setDeal360Deps({
  asMoney,
  avatarColor,
  c360Initials,
  navigateToView,
  renderDeals,
  showToast
});

setDashboardDeps({
  asMoney,
  avatarColor,
  repAvatarHtml,
  navigateToSettingsPage
});

setVisitsDeps({
  buildVisitListHtml,
  attachVisitListListeners,
  stageAccentVar,
  openVisitDetail,
  attachOnBehalfOfField
});

setDelegationsDeps({
  setStatus,
  escHtml,
  renderSettings
});

// ── Onboarding wizard (S11) ───────────────────────────────────────────────────
initOnboardingWizard({
  stepNav: {
    teamCreated:      () => { navigateToSettingsPage("teams");         switchView("settings"); },
    userInvited:      () => { navigateToSettingsPage("users");         switchView("settings"); },
    integrationSetup: () => { navigateToSettingsPage("integrations");  switchView("settings"); },
    customerImported: () => { navigateToMasterPage("customers");        switchView("master"); },
    dealCreated:      () => { navigateToView("deals");                 switchView("deals"); },
    domainConfigured: () => { navigateToSettingsPage("branding");      switchView("settings"); }
  }
});

initDemoDataModals({
  refreshHost: async () => {
    await Promise.all([loadMaster(), loadDeals(), loadVisits(), loadDashboard()]);
  },
  gotoIntegrations: () => { navigateToSettingsPage("integrations"); switchView("settings"); }
});

// ── Customer autocomplete for modal forms ─────────────────────────────────────
function initCustomerAutocomplete(inputEl, listEl, hiddenEl, onSelect) {
  if (!inputEl || !listEl || !hiddenEl) return;

  let outsideHandler = null;

  function openList() {
    const rect = inputEl.getBoundingClientRect();
    listEl.style.position = "fixed";
    listEl.style.top      = `${rect.bottom + 4}px`;
    listEl.style.left     = `${rect.left}px`;
    listEl.style.width    = `${rect.width}px`;
    listEl.style.zIndex   = "9999";
    listEl.hidden = false;
    if (!outsideHandler) {
      outsideHandler = (e) => {
        if (!listEl.contains(e.target) && e.target !== inputEl) closeList();
      };
      document.addEventListener("mousedown", outsideHandler);
    }
  }

  function closeList() {
    listEl.hidden = true;
    if (outsideHandler) {
      document.removeEventListener("mousedown", outsideHandler);
      outsideHandler = null;
    }
  }

  inputEl.addEventListener("input", () => {
    const q = inputEl.value.trim().toLowerCase();
    hiddenEl.value = "";
    if (!q) { closeList(); return; }
    const matches = (state.cache.customers || []).filter(
      (c) => c.name.toLowerCase().includes(q) || (c.customerCode || "").toLowerCase().includes(q)
    ).slice(0, 8);
    if (!matches.length) { closeList(); return; }
    listEl.innerHTML = matches.map((c) =>
      `<button type="button" class="ac-item" data-id="${c.id}" data-name="${escHtml(c.name)}">
         <span class="ac-item-name">${escHtml(c.name)}</span>
         ${c.customerCode ? `<span class="ac-item-code">${escHtml(c.customerCode)}</span>` : ""}
       </button>`
    ).join("");
    openList();
  });

  // Prevent input blur when clicking inside the list
  listEl.addEventListener("mousedown", (e) => { e.preventDefault(); });

  listEl.addEventListener("click", (e) => {
    const item = e.target.closest(".ac-item");
    if (!item) return;
    inputEl.value = item.dataset.name;
    hiddenEl.value = item.dataset.id;
    closeList();
    onSelect?.(item.dataset.id, item.dataset.name);
  });

  inputEl.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closeList();
  });
}

initCustomerAutocomplete(
  qs("#deal-customer-input"), qs("#deal-customer-list"), qs("#deal-customer-id")
);
initCustomerAutocomplete(
  qs("#visit-customer-input"), qs("#visit-customer-list"), qs("#visit-customer-id"),
  async (customerId) => {
    const dealLabel  = qs("#visit-deal-label");
    const dealSelect = qs("#visit-deal-select");
    if (!dealLabel || !dealSelect) return;
    dealSelect.innerHTML = `<option value="">Loading…</option>`;
    dealLabel.hidden = false;
    try {
      const deals = await api(`/deals?customerId=${encodeURIComponent(customerId)}`);
      const active = deals.filter((d) => d.status !== "WON" && d.status !== "LOST");
      if (!active.length) {
        dealSelect.innerHTML = `<option value="">— No open deals —</option>`;
      } else {
        dealSelect.innerHTML = `<option value="">— No deal —</option>` +
          active.map((d) => `<option value="${d.id}">${escHtml(d.dealName)}${d.stage?.stageName ? " · " + escHtml(d.stage.stageName) : ""}</option>`).join("");
      }
    } catch {
      dealSelect.innerHTML = `<option value="">— Could not load deals —</option>`;
    }
  }
);

// Hide deal field when customer is cleared by typing
qs("#visit-customer-input")?.addEventListener("input", () => {
  if (!qs("#visit-customer-id")?.value) {
    const dealLabel  = qs("#visit-deal-label");
    const dealSelect = qs("#visit-deal-select");
    if (dealLabel)  dealLabel.hidden = true;
    if (dealSelect) dealSelect.innerHTML = `<option value="">— No deal —</option>`;
  }
});

// Deal create modal
qs("#deal-create-modal")?.addEventListener("click", (e) => {
  if (e.target.matches("[data-deal-modal-close]") || e.target.closest("[data-deal-modal-close]")) {
    closeDealCreateModal();
  }
});

qs("#deal-form")?.addEventListener("submit", async (e) => {
  e.preventDefault();
  const form = e.currentTarget;
  const payload = Object.fromEntries(new FormData(form).entries());
  if (!payload.customerId) {
    setStatus("Please select a customer from the list.", true);
    qs("#deal-customer-input")?.focus();
    return;
  }
  const followUpAt = new Date(payload.followUpAt).toISOString();
  const btn = form.querySelector('[type="submit"]');
  if (btn) btn.disabled = true;
  const onBehalfOfUserId = readOnBehalfOfValue(form);
  const body = { ...payload, estimatedValue: Number(payload.estimatedValue), followUpAt };
  // onBehalfOfUserId may appear in payload already since the select name is
  // "onBehalfOfUserId" — strip the sentinel so we never send "__self__".
  if (body.onBehalfOfUserId === "__self__" || !onBehalfOfUserId) delete body.onBehalfOfUserId;
  else body.onBehalfOfUserId = onBehalfOfUserId;
  try {
    await api("/deals", {
      method: "POST",
      body
    });
    setStatus("Deal created.");
    closeDealCreateModal();
    await loadDeals();
    await loadDashboard();
  } catch (error) {
    setStatus(error.message, true);
  } finally {
    if (btn) btn.disabled = false;
  }
});

// Visit create modal
qs("#visit-create-modal")?.addEventListener("click", (e) => {
  if (e.target.matches("[data-visit-modal-close]") || e.target.closest("[data-visit-modal-close]")) {
    closeVisitCreateModal();
  }
});

qs("#visit-create-modal")?.addEventListener("change", (e) => {
  if (e.target.matches('[name="visitType"]')) {
    syncVisitPlannedAtRequired(qs("#visit-create-modal"));
  }
});

// ── Google Maps Picker ─────────────────────────────────────────────────────────
setMapPickerDeps({ setStatus });
initMapPicker();

// Wire up "Pick on Map" button in visit form
qs("#visit-pick-location-btn")?.addEventListener("click", () => {
  const lat = parseFloat(qs("#visit-site-lat")?.value) || null;
  const lng = parseFloat(qs("#visit-site-lng")?.value) || null;
  openMapPicker(lat, lng, (pickedLat, pickedLng) => {
    qs("#visit-site-lat").value = pickedLat;
    qs("#visit-site-lng").value = pickedLng;
    const preview = qs("#visit-location-preview");
    const text = qs("#visit-location-text");
    if (preview) preview.hidden = false;
    if (text) text.textContent = `${pickedLat.toFixed(6)}, ${pickedLng.toFixed(6)}`;
    qs("#visit-pick-location-btn").textContent = "";
    const btn = qs("#visit-pick-location-btn");
    btn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/></svg> Change Location`;
  });
});

qs("#visit-location-clear")?.addEventListener("click", () => {
  qs("#visit-site-lat").value = "";
  qs("#visit-site-lng").value = "";
  const preview = qs("#visit-location-preview");
  if (preview) preview.hidden = true;
  const btn = qs("#visit-pick-location-btn");
  if (btn) btn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/></svg> Pick on Map`;
});

qs("#visit-form")?.addEventListener("submit", async (e) => {
  e.preventDefault();
  const modal = qs("#visit-create-modal");
  const form = e.currentTarget;
  const data = Object.fromEntries(new FormData(form).entries());
  if (!data.customerId) {
    setStatus("Please select a customer from the list.", true);
    qs("#visit-customer-input")?.focus();
    return;
  }
  const visitType = data.visitType;
  const endpoint = visitType === "PLANNED" ? "/visits/planned" : "/visits/unplanned";
  const body = { customerId: data.customerId };
  const onBehalfOfUserId = readOnBehalfOfValue(form);
  if (onBehalfOfUserId) body.onBehalfOfUserId = onBehalfOfUserId;
  if (data.dealId)         body.dealId    = data.dealId;
  if (data.objective?.trim()) body.objective = data.objective.trim();
  if (data.siteLat && data.siteLng) {
    body.siteLat = parseFloat(data.siteLat);
    body.siteLng = parseFloat(data.siteLng);
  }
  if (data.plannedAt) {
    const planned = new Date(data.plannedAt);
    if (planned < new Date()) {
      setStatus("Date & time cannot be in the past.", true);
      modal.querySelector("#visit-planned-at")?.focus();
      if (btn) btn.disabled = false;
      return;
    }
    body.plannedAt = planned.toISOString();
  }
  const btn = modal.querySelector("#visit-form-submit");
  if (btn) btn.disabled = true;
  try {
    await api(endpoint, { method: "POST", body });
    setStatus("Visit added.");
    closeVisitCreateModal();
    await loadVisits();
  } catch (error) {
    setStatus(error.message, true);
  } finally {
    if (btn) btn.disabled = false;
  }
});

// ── User dropdown ──────────────────────────────────────────────────────────────
const userMenuBtn = qs("#user-menu-btn");
const userDropdown = qs("#user-dropdown");

function openUserDropdown() {
  if (!userDropdown) return;
  userDropdown.hidden = false;
  requestAnimationFrame(() => userDropdown.classList.add("open"));
  if (userMenuBtn) userMenuBtn.setAttribute("aria-expanded", "true");
}

function closeUserDropdown() {
  if (!userDropdown) return;
  userDropdown.classList.remove("open");
  userDropdown.addEventListener("transitionend", () => { userDropdown.hidden = true; }, { once: true });
  if (userMenuBtn) userMenuBtn.setAttribute("aria-expanded", "false");
}

userMenuBtn?.addEventListener("click", (e) => {
  e.stopPropagation();
  const isOpen = userDropdown && !userDropdown.hidden;
  isOpen ? closeUserDropdown() : openUserDropdown();
});

// Global click-outside: close all ms-dropdown panels
document.addEventListener("click", (e) => {
  document.querySelectorAll(".ms-dropdown").forEach((wrap) => {
    if (!wrap.contains(e.target)) {
      const panel = wrap.querySelector(".ms-dropdown-panel");
      const btn   = wrap.querySelector(".ms-dropdown-btn");
      if (panel) panel.hidden = true;
      if (btn)   btn.classList.remove("open");
    }
  });
}, { capture: true });

document.addEventListener("click", (e) => {
  if (userDropdown && !userDropdown.hidden && !userMenuBtn?.contains(e.target)) {
    closeUserDropdown();
  }
});

// Close user dropdown when other panels open
document.addEventListener("click", (e) => {
  if (e.target?.closest?.("#notif-btn")) {
    closeUserDropdown();
  }
});

qs("#logout-btn").addEventListener("click", () => {
  closeUserDropdown();
  state.token = "";
  state.user = null;
  state.cache.notifPrefs = undefined;
  state.cache.cronJobs = undefined;
  _notifPrefsCache = null;
  localStorage.removeItem("thinkcrm_token");
  showAuth();
  authMessage.textContent = "";
});

// User-dropdown nav items (My Profile / Notification Preferences) — route explicitly
// in the capture phase so we beat the global .nav-btn handler, then halt further
// dispatch so only one navigation fires.
userDropdown?.querySelectorAll("[data-settings-page]").forEach((item) => {
  item.addEventListener("click", async (e) => {
    e.stopImmediatePropagation();
    closeUserDropdown();
    const settingsPage = item.dataset.settingsPage;
    navigateToSettingsPage(settingsPage);
    switchView("settings");
    try { await loadSettings(); } catch (error) { setStatus(error.message, true); }
  }, { capture: true });
});

themeToggleBtn?.addEventListener("click", () => {
  state.themeOverride =
    state.themeOverride === "AUTO"
      ? "LIGHT"
      : state.themeOverride === "LIGHT"
        ? "DARK"
        : "AUTO";
  localStorage.setItem(THEME_OVERRIDE_KEY, state.themeOverride);
  applyThemeMode(state.cache.branding?.themeMode || "LIGHT");
  setStatus(`Theme switched: ${state.themeOverride}`);
  if (views.settings.classList.contains("active")) {
    renderSettings();
  }
});

// ── Master Data dropdown ───────────────────────────────────────────────────────
const masterDropdown = qs("#master-dropdown");
const masterNavBtn  = qs("#master-nav-btn");
const masterMenu    = qs("#master-dropdown-menu");

function closeMasterDropdown() {
  if (!masterMenu) return;
  masterMenu.hidden = true;
  masterNavBtn?.setAttribute("aria-expanded", "false");
}

function updateMasterDropdownActive() {
  const isMasterActive = views.master.classList.contains("active");
  masterMenu?.querySelectorAll(".nav-dropdown-item").forEach((item) => {
    item.classList.toggle("active", isMasterActive && item.dataset.masterPage === state.masterPage);
  });
  // Keep the parent nav-btn highlighted only when master view is active
  masterNavBtn?.classList.toggle("active", isMasterActive);
}

masterNavBtn?.addEventListener("click", (e) => {
  e.stopPropagation();
  const isOpen = !masterMenu.hidden;
  if (isOpen) {
    closeMasterDropdown();
  } else {
    const rect = masterNavBtn.getBoundingClientRect();
    masterMenu.style.top  = `${rect.bottom + 6}px`;
    masterMenu.style.left = `${rect.left}px`;
    masterMenu.hidden = false;
    masterNavBtn.setAttribute("aria-expanded", "true");
    updateMasterDropdownActive();
  }
});

masterMenu?.querySelectorAll(".nav-dropdown-item").forEach((item) => {
  item.addEventListener("click", async () => {
    const page = item.dataset.masterPage;
    closeMasterDropdown();
    navigateToMasterPage(page);
    switchView("master");
    renderMasterData(state.cache.paymentTerms);
    updateMasterDropdownActive();
    try {
      await loadMaster();
    } catch (error) {
      setStatus(error.message, true);
    }
  });
});

// Close dropdown when clicking outside
document.addEventListener("click", (e) => {
  if (masterDropdown && !masterDropdown.contains(e.target)) {
    closeMasterDropdown();
  }
});

document.querySelectorAll(".nav-btn").forEach((btn) => {
  // Master nav btn is handled above via the dropdown
  if (btn.id === "master-nav-btn") return;
  btn.addEventListener("click", async () => {
    const target = btn.dataset.view;
    if (!target) return;
    if (btn.dataset.settingsPage) {
      navigateToSettingsPage(btn.dataset.settingsPage);
    } else if (target === "settings" && !window.location.pathname.startsWith("/settings/")) {
      navigateToSettingsPage(state.settingsPage || "company");
    } else if (target !== "master" && target !== "settings") {
      navigateToView(target);
    }
    closeMasterDropdown();
    switchView(target);
    try {
      if (target === "repHub") {
        await loadVisits();
        await loadDeals();
        paintRepHubFull();
      }
      if (target === "dashboard") { await loadDashboard(); await loadOnboardingWizard(); }
      if (target === "deals") await loadDeals();
      if (target === "visits") await loadVisits();
      if (target === "calendar") await loadCalendar();
      if (target === "integrations") await loadIntegrations();
      if (target === "settings") await loadSettings();
    } catch (error) {
      setStatus(error.message, true);
    }
  });
});

// ── Team Create Modal ──────────────────────────────────────────────────────────
(function initTeamCreateModal() {
  const modal = qs("#team-create-modal");
  const form  = qs("#team-create-form");
  if (!modal || !form) return;

  function closeModal() { modal.hidden = true; form.reset(); }

  qs("#team-modal-close")?.addEventListener("click", closeModal);
  qs("#team-modal-cancel")?.addEventListener("click", closeModal);
  qs("#team-modal-backdrop")?.addEventListener("click", closeModal);

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const teamName = new FormData(form).get("teamName")?.toString().trim();
    if (!teamName) return;
    try {
      await api("/teams", { method: "POST", body: { teamName } });
      closeModal();
      setStatus("Team created.");
      await loadSettings();
    } catch (error) {
      setStatus(error.message, true);
    }
  });
})();

// ── Slide panels ──────────────────────────────────────────────────────────────
const panelBackdrop = qs("#panel-backdrop");
const notifPanel = qs("#notif-panel");
const settingsPanel = qs("#settings-panel");

function openPanel(panel) {
  [notifPanel, settingsPanel, visitDetailPanel].forEach((p) => {
    if (p && p !== panel) {
      p.hidden = true;
      p.classList.remove("open");
    }
  });
  if (!panel) return;
  panel.hidden = false;
  requestAnimationFrame(() => panel.classList.add("open"));
  if (panelBackdrop) {
    panelBackdrop.hidden = false;
    requestAnimationFrame(() => panelBackdrop.classList.add("open"));
  }
}

function closeAllPanels() {
  [notifPanel, settingsPanel, visitDetailPanel].forEach((p) => {
    if (p && p.classList.contains("open")) {
      p.classList.remove("open");
      p.addEventListener("transitionend", () => { p.hidden = true; }, { once: true });
    } else if (p && !p.hidden) {
      p.hidden = true;
    }
  });
  if (panelBackdrop) {
    panelBackdrop.classList.remove("open");
    panelBackdrop.addEventListener("transitionend", () => { panelBackdrop.hidden = true; }, { once: true });
  }
}

qs("#notif-btn")?.addEventListener("click", () => {
  const isOpen = notifPanel && !notifPanel.hidden;
  isOpen ? closeAllPanels() : openPanel(notifPanel);
});

// ── Gear dropdown (Settings + Logs) ───────────────────────────────────────────
const gearDropdown     = qs("#gear-dropdown");
const gearGearBtn      = qs("#settings-gear-btn");
const gearDropdownMenu = qs("#gear-dropdown-menu");

function closeGearDropdown() {
  if (!gearDropdownMenu) return;
  gearDropdownMenu.hidden = true;
  gearGearBtn?.setAttribute("aria-expanded", "false");
}

gearGearBtn?.addEventListener("click", (e) => {
  e.stopPropagation();
  if (!gearDropdownMenu) return;
  const isOpen = !gearDropdownMenu.hidden;
  if (isOpen) {
    closeGearDropdown();
  } else {
    closeUserDropdown();
    const rect = gearGearBtn.getBoundingClientRect();
    gearDropdownMenu.style.top  = `${rect.bottom + 6}px`;
    gearDropdownMenu.style.right = `${document.documentElement.clientWidth - rect.right}px`;
    gearDropdownMenu.style.left = "auto";
    gearDropdownMenu.hidden = false;
    gearGearBtn.setAttribute("aria-expanded", "true");
  }
});

qs("#gear-settings-item")?.addEventListener("click", () => {
  closeGearDropdown();
  const isOpen = settingsPanel && !settingsPanel.hidden;
  isOpen ? closeAllPanels() : openPanel(settingsPanel);
});

document.addEventListener("click", (e) => {
  if (gearDropdown && !gearDropdown.contains(e.target)) {
    closeGearDropdown();
  }
});

qs("#notif-close")?.addEventListener("click", closeAllPanels);
qs("#settings-panel-close")?.addEventListener("click", closeAllPanels);
panelBackdrop?.addEventListener("click", closeAllPanels);

// Settings panel nav items — close panel then switch view
document.querySelectorAll(".spi[data-view]").forEach((item) => {
  item.addEventListener("click", async () => {
    const target = item.dataset.view;
    const settingsPage = item.dataset.settingsPage;
    closeAllPanels();
    if (!target) return;
    if (target === "settings" && settingsPage) {
      navigateToSettingsPage(settingsPage);
    }
    switchView(target);
    try {
      if (target === "settings") await loadSettings();
    } catch (error) {
      setStatus(error.message, true);
    }
  });
});

window.addEventListener("popstate", async () => {
  const userEditId = syncUserEditFromLocation();
  if (userEditId) {
    await openUserEditPage(userEditId);
    return;
  }
  const c360Id = syncC360FromLocation();
  if (c360Id) {
    await openCustomer360(c360Id);
    return;
  }
  const deal360No = syncDeal360FromLocation();
  if (deal360No) {
    // Find the deal in cache by dealNo to get its id
    const allDeals = state.cache.kanban?.stages?.flatMap((s) => s.deals) ?? [];
    const deal = allDeals.find((d) => d.dealNo === deal360No);
    if (deal) {
      await openDeal360(deal.id, deal360No);
    } else {
      switchView("deals");
      if (state.cache.kanban) renderDeals(state.cache.kanban);
    }
    return;
  }
  const isMasterRoute = syncMasterPageFromLocation();
  if (isMasterRoute) {
    state.c360 = null;
    await loadMaster();
    return;
  }
  const isSettingsRoute = syncSettingsPageFromLocation();
  if (isSettingsRoute) {
    await loadSettings();
    return;
  }
  const simpleView = syncSimpleViewFromLocation();
  if (simpleView) {
    state.c360 = null;
    state.deal360 = null;
    switchView(simpleView);
    try {
      if (simpleView === "repHub") {
        await loadVisits();
        await loadDeals();
        paintRepHubFull();
      }
      if (simpleView === "dashboard") { await loadDashboard(); await loadOnboardingWizard(); }
      if (simpleView === "deals") await loadDeals();
      if (simpleView === "visits") await loadVisits();
      if (simpleView === "calendar") await loadCalendar();
      if (simpleView === "integrations") await loadIntegrations();
    } catch (e) { setStatus(e.message, true); }
  }
});

async function bootstrap() {
  if (!state.token) return;
  try {
    fetch("/api/v1/config/public").then(r => r.ok ? r.json() : {}).then(cfg => {
      state.googleMapsApiKey = cfg.googleMapsApiKey ?? null;
      if (cfg.baseDomain) window.__BASE_DOMAIN = cfg.baseDomain;
    }).catch(() => {});
    const me = await api("/auth/me");
    state.user = me;
    updateUserMeta();
    showApp();
    showTrialBanner(me.subscription);
    if (window._checkSuperAdmin) window._checkSuperAdmin();
    const userEditId = syncUserEditFromLocation();
    const c360Id = !userEditId && syncC360FromLocation();
    const deal360No = !userEditId && !c360Id && syncDeal360FromLocation();
    const onMasterRoute = !userEditId && !c360Id && !deal360No && syncMasterPageFromLocation();
    const onSettingsRoute = !userEditId && !c360Id && !deal360No && !onMasterRoute && syncSettingsPageFromLocation();
    const onSimpleViewRoute = !userEditId && !c360Id && !deal360No && !onMasterRoute && !onSettingsRoute && syncSimpleViewFromLocation();
    await loadAllViews();
    applyBrandingTheme(state.cache.branding);

    // Handle platform Connect redirect-backs (LINE / MS Teams / Slack)
    if (_lineConnectParams || _msTeamsConnectParams || _slackConnectParams) {
      state.cache.myIntegrations = null;
      state.settingsPage = "notifications";
      navigateToSettingsPage("notifications");
      switchView("settings");
      renderSettings();
      if (_lineConnectParams?.lineError)        setStatus("LINE connect failed: " + _lineConnectParams.lineError, true);
      else if (_lineConnectParams)              setStatus("LINE account connected successfully.");
      else if (_msTeamsConnectParams?.error)    setStatus("Microsoft Teams connect failed: " + _msTeamsConnectParams.error, true);
      else if (_msTeamsConnectParams)           setStatus("Microsoft Teams account connected successfully.");
      else if (_slackConnectParams?.error)      setStatus("Slack connect failed: " + _slackConnectParams.error, true);
      else                                      setStatus("Slack account connected successfully.");
    } else if (userEditId) {
      await openUserEditPage(userEditId);
    } else if (c360Id) {
      await openCustomer360(c360Id);
    } else if (deal360No) {
      const allDeals = state.cache.kanban?.stages?.flatMap((s) => s.deals) ?? [];
      const deal = allDeals.find((d) => d.dealNo === deal360No);
      if (deal) await openDeal360(deal.id, deal360No);
    } else if (onMasterRoute) {
      switchView("master");
    } else if (onSettingsRoute) {
      switchView("settings");
    } else if (onSimpleViewRoute) {
      switchView(onSimpleViewRoute);
      if (onSimpleViewRoute === "repHub") paintRepHubFull();
      if (onSimpleViewRoute === "dashboard") await loadOnboardingWizard();
      if (onSimpleViewRoute === "superAdmin" && window._loadSuperAdmin) window._loadSuperAdmin();
    } else {
      window.history.replaceState({ view: "repHub" }, "", "/task");
      switchView("repHub");
      paintRepHubFull();
    }
    hideAppLoading();
    await loadDemoDataStatus();
    renderDemoDataBanner();
  } catch {
    localStorage.removeItem("thinkcrm_token");
    state.token = "";
    hideAppLoading();
  }
}

// ── QUICK SEARCH ──────────────────────────────────────────────────────────────

initQuickSearch({
  navigateToView,
  navigateToMasterPage,
  openDealCreateModal,
  openVisitCreateModal,
  asMoney
});

// ── Form label decorator ──────────────────────────────────────────────────────
// Injects a red * after the label text of any .form-label that contains a
// required input/select/textarea. Removes "(optional)" hint spans.
function decorateFormLabels(root) {
  (root || document).querySelectorAll(".form-label:not([data-fl])").forEach((label) => {
    label.setAttribute("data-fl", "1");

    // Remove any "(optional)" hint spans
    label.querySelectorAll(".muted, .muted.small").forEach((el) => {
      if (/\(optional[^)]*\)/i.test(el.textContent)) el.remove();
    });

    // Always wrap the first text node so .form-label-text is available for
    // dynamic required toggling (e.g. Date & time in visit modal).
    if (!label.querySelector(".form-label-text")) {
      for (const node of Array.from(label.childNodes)) {
        if (node.nodeType === Node.TEXT_NODE && node.textContent.trim()) {
          const span = document.createElement("span");
          span.className = "form-label-text";
          span.textContent = node.textContent;
          node.replaceWith(span);
          break;
        }
      }
    }

    const hasRequired = !!label.querySelector(
      "input[required], select[required], textarea[required]"
    );
    if (!hasRequired) return;

    const textSpan = label.querySelector(".form-label-text");
    if (textSpan && !textSpan.querySelector(".req-star")) {
      const star = document.createElement("span");
      star.className = "req-star";
      star.textContent = " *";
      textSpan.appendChild(star);
    }
  });
}

// Re-run whenever new DOM is added (e.g., after renderSettings, renderDeals, etc.)
new MutationObserver(() => decorateFormLabels(document)).observe(document.body, {
  childList: true,
  subtree: true,
});

bindVoiceNoteModal({
  async onConfirmed({ entityType, entityId, summary }) {
    if (entityType === "DEAL") {
      await loadDeals();
      await loadDashboard();
    } else if (entityType === "VISIT") {
      if (summary) {
        const checkoutResultEl = qs("#mt-checkout-result");
        if (checkoutResultEl && !checkoutResultEl.value.trim()) {
          checkoutResultEl.value = summary;
        }
      }
      await loadVisits();
      if (entityId && visitDetailBody && !visitDetailBody.closest("[hidden]")) {
        openVisitDetail(entityId);
      }
    }
  }
});
applyThemeMode("LIGHT");

// ── Super Admin ────────────────────────────────────────────────────────────────
(function initSuperAdmin() {
  const navBtn = qs("#super-admin-nav-btn");
  const panel  = views.superAdmin;
  if (!panel) return;

  let loaded = false;

  // Check super admin status after login
  window._checkSuperAdmin = async function () {
    try {
      const res = await api("/auth/me/super-admin");
      if (res.isSuperAdmin) {
        if (navBtn) navBtn.hidden = false;
        state._isSuperAdmin = true;
      }
    } catch { /* not super admin */ }
  };

  // Nav button click
  navBtn?.addEventListener("click", () => {
    switchView("superAdmin");
    window.history.pushState({ view: "superAdmin" }, "", "/super-admin");
    if (!loaded) { loaded = true; loadSuperAdminDashboard(); }
  });

  // Expose loader so bootstrap can trigger it on direct URL navigation
  window._loadSuperAdmin = function () {
    if (!loaded) { loaded = true; loadSuperAdminDashboard(); }
  };

  async function loadSuperAdminDashboard() {
    panel.innerHTML = '<div style="padding:24px;color:#64748b">Loading...</div>';
    try {
      const [stats, tenants] = await Promise.all([
        api("/super-admin/stats"),
        api("/super-admin/tenants"),
      ]);
      renderSuperAdmin(stats, tenants);
    } catch (err) {
      panel.innerHTML = `<div style="padding:24px;color:#ef4444">Failed to load: ${escHtml(err.message)}</div>`;
    }
  }

  function renderSuperAdmin(stats, tenants) {
    panel.innerHTML = `
      <div class="sa-wrap">
        <div class="sa-stats">
          <div class="sa-stat"><div class="sa-stat-val">${stats.tenantCount}</div><div class="sa-stat-lbl">Workspaces</div></div>
          <div class="sa-stat"><div class="sa-stat-val">${stats.activeCount}</div><div class="sa-stat-lbl">Active</div></div>
          <div class="sa-stat"><div class="sa-stat-val">${stats.trialCount}</div><div class="sa-stat-lbl">Trial</div></div>
          <div class="sa-stat"><div class="sa-stat-val">${stats.userCount}</div><div class="sa-stat-lbl">Total Users</div></div>
          <div class="sa-stat"><div class="sa-stat-val">${stats.dealCount}</div><div class="sa-stat-lbl">Total Deals</div></div>
          <div class="sa-stat" id="sa-storage-stat"><div class="sa-stat-val">-</div><div class="sa-stat-lbl">R2 Storage</div></div>
        </div>
        <div class="sa-toolbar">
          <input class="sa-search" id="sa-search" type="text" placeholder="Search workspaces..." />
          <select class="sa-filter" id="sa-status-filter">
            <option value="">All</option>
            <option value="active">Active</option>
            <option value="inactive">Inactive</option>
          </select>
          <button class="sa-btn sa-btn--refresh" id="sa-refresh">Refresh</button>
          <button class="sa-btn sa-btn--primary" id="sa-load-storage">Load R2 Storage</button>
        </div>
        <div class="sa-table-wrap">
          <table class="sa-table">
            <thead>
              <tr>
                <th>Workspace</th>
                <th>Slug</th>
                <th>Status</th>
                <th>Subscription</th>
                <th>Users</th>
                <th>Deals</th>
                <th>Customers</th>
                <th>R2 Storage</th>
                <th>Created</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody id="sa-tenants-body"></tbody>
          </table>
        </div>
        <div id="sa-detail-modal" class="sa-modal" hidden>
          <div class="sa-modal-backdrop"></div>
          <div class="sa-modal-content"></div>
        </div>
      </div>`;

    renderTenantRows(tenants);
    qs("#sa-refresh")?.addEventListener("click", () => { loaded = false; loadSuperAdminDashboard(); });
    qs("#sa-search")?.addEventListener("input", (e) => filterTenants(e.target.value, qs("#sa-status-filter")?.value));
    qs("#sa-status-filter")?.addEventListener("change", (e) => filterTenants(qs("#sa-search")?.value, e.target.value));
    qs("#sa-detail-modal .sa-modal-backdrop")?.addEventListener("click", closeSAModal);
    qs("#sa-load-storage")?.addEventListener("click", loadR2Storage);
    panel._tenants = tenants;
  }

  function formatBytes(bytes) {
    if (bytes < 0) return "Error";
    if (bytes === 0) return "0 B";
    const units = ["B", "KB", "MB", "GB", "TB"];
    const i = Math.floor(Math.log(bytes) / Math.log(1024));
    return (bytes / Math.pow(1024, i)).toFixed(i > 0 ? 1 : 0) + " " + units[i];
  }

  async function loadR2Storage() {
    const btn = qs("#sa-load-storage");
    if (btn) { btn.disabled = true; btn.textContent = "Loading..."; }
    try {
      const data = await api("/super-admin/storage");
      if (!data.configured) {
        if (btn) { btn.textContent = "R2 not configured"; }
        return;
      }
      // Update total stat
      const statEl = qs("#sa-storage-stat");
      if (statEl) statEl.querySelector(".sa-stat-val").textContent = formatBytes(data.totalUsedBytes);
      // Update per-tenant cells
      for (const t of data.tenants) {
        const cell = panel.querySelector(`.sa-storage-cell[data-tenant-slug="${t.slug}"]`);
        if (!cell) continue;
        const pct = t.quotaBytes > 0 ? Math.round((t.usedBytes / t.quotaBytes) * 100) : 0;
        const color = pct > 90 ? "sa-badge--red" : pct > 70 ? "sa-badge--yellow" : "sa-badge--green";
        cell.innerHTML = t.usedBytes < 0
          ? '<span class="sa-badge sa-badge--red">Error</span>'
          : `<span class="sa-badge ${color}">${formatBytes(t.usedBytes)}</span><br><span style="font-size:10px;color:#94a3b8">${t.objectCount} files / ${formatBytes(t.quotaBytes)} quota</span>`;
      }
      if (btn) { btn.textContent = "Refresh Storage"; btn.disabled = false; }
    } catch (err) {
      if (btn) { btn.textContent = "Load R2 Storage"; btn.disabled = false; }
      alert("Failed to load storage: " + err.message);
    }
  }

  function filterTenants(search, status) {
    const tenants = panel._tenants || [];
    const s = (search || "").toLowerCase();
    const filtered = tenants.filter(t => {
      const matchSearch = !s || t.name.toLowerCase().includes(s) || t.slug.toLowerCase().includes(s);
      const matchStatus = !status || (status === "active" ? t.isActive : !t.isActive);
      return matchSearch && matchStatus;
    });
    renderTenantRows(filtered);
  }

  function renderTenantRows(tenants) {
    const tbody = qs("#sa-tenants-body");
    if (!tbody) return;
    if (!tenants.length) {
      tbody.innerHTML = '<tr><td colspan="10" style="text-align:center;color:#94a3b8;padding:24px">No workspaces found</td></tr>';
      return;
    }
    tbody.innerHTML = tenants.map(t => {
      const sub = t.subscription;
      const subLabel = sub ? sub.status : "None";
      const subClass = sub?.status === "ACTIVE" ? "sa-badge--green" : sub?.status === "TRIALING" ? "sa-badge--yellow" : "sa-badge--gray";
      const statusClass = t.isActive ? "sa-badge--green" : "sa-badge--red";
      const created = new Date(t.createdAt).toLocaleDateString();
      return `<tr data-tenant-id="${escHtml(t.id)}">
        <td class="sa-cell-name">${escHtml(t.name)}</td>
        <td><code>${escHtml(t.slug)}</code></td>
        <td><span class="sa-badge ${statusClass}">${t.isActive ? "Active" : "Inactive"}</span></td>
        <td><span class="sa-badge ${subClass}">${escHtml(subLabel)}</span></td>
        <td>${t.userCount}</td>
        <td>${t.dealCount}</td>
        <td>${t.customerCount}</td>
        <td class="sa-storage-cell" data-tenant-slug="${escHtml(t.slug)}"><span class="sa-badge sa-badge--gray">-</span></td>
        <td>${created}</td>
        <td class="sa-actions">
          <button class="sa-btn sa-btn--sm" data-sa-action="detail" data-sa-id="${escHtml(t.id)}">View</button>
          <button class="sa-btn sa-btn--sm sa-btn--warn" data-sa-action="toggle" data-sa-id="${escHtml(t.id)}" data-sa-active="${t.isActive}">${t.isActive ? "Deactivate" : "Activate"}</button>
          <button class="sa-btn sa-btn--sm sa-btn--primary" data-sa-action="impersonate" data-sa-id="${escHtml(t.id)}">Login as</button>
          <button class="sa-btn sa-btn--sm sa-btn--danger" data-sa-action="delete" data-sa-id="${escHtml(t.id)}" data-sa-name="${escHtml(t.name)}">Delete</button>
        </td>
      </tr>`;
    }).join("");

    // Delegate action clicks
    tbody.onclick = async (e) => {
      const btn = e.target.closest("[data-sa-action]");
      if (!btn) return;
      const action = btn.dataset.saAction;
      const id = btn.dataset.saId;
      if (action === "detail") await showTenantDetail(id);
      if (action === "toggle") await toggleTenant(id, btn.dataset.saActive === "true");
      if (action === "impersonate") await impersonateTenant(id);
      if (action === "delete") await deleteTenant(id, btn.dataset.saName);
    };
  }

  async function showTenantDetail(tenantId) {
    const modal = qs("#sa-detail-modal");
    const content = modal?.querySelector(".sa-modal-content");
    if (!modal || !content) return;
    content.innerHTML = '<div style="padding:24px;color:#64748b">Loading...</div>';
    modal.hidden = false;
    try {
      const t = await api(`/super-admin/tenants/${tenantId}`);
      const sub = t.subscriptions?.[0];
      const domain = t.customDomain;
      content.innerHTML = `
        <div class="sa-detail">
          <div class="sa-detail-header">
            <h3>${escHtml(t.name)}</h3>
            <button class="sa-btn sa-btn--sm sa-modal-close">&times;</button>
          </div>
          <div class="sa-detail-grid">
            <div class="sa-detail-item"><span class="sa-detail-label">ID</span><code>${escHtml(t.id)}</code></div>
            <div class="sa-detail-item"><span class="sa-detail-label">Slug</span><code>${escHtml(t.slug)}</code></div>
            <div class="sa-detail-item"><span class="sa-detail-label">Status</span><span class="sa-badge ${t.isActive ? "sa-badge--green" : "sa-badge--red"}">${t.isActive ? "Active" : "Inactive"}</span></div>
            <div class="sa-detail-item"><span class="sa-detail-label">Timezone</span>${escHtml(t.timezone)}</div>
            <div class="sa-detail-item"><span class="sa-detail-label">Created</span>${new Date(t.createdAt).toLocaleString()}</div>
            <div class="sa-detail-item"><span class="sa-detail-label">Subscription</span>${sub ? `${sub.status} / ${sub.seatCount} seats / ${sub.billingCycle}` : "None"}</div>
            <div class="sa-detail-item"><span class="sa-detail-label">Custom Domain</span>${domain ? `${escHtml(domain.domain)} (${domain.status})` : "None"}</div>
            <div class="sa-detail-item"><span class="sa-detail-label">Deals</span>${t._count.deals}</div>
            <div class="sa-detail-item"><span class="sa-detail-label">Customers</span>${t._count.customers}</div>
            <div class="sa-detail-item"><span class="sa-detail-label">Visits</span>${t._count.visits}</div>
            <div class="sa-detail-item"><span class="sa-detail-label">Quotations</span>${t._count.quotations}</div>
          </div>
          <h4 style="margin:16px 0 8px">Users (${t.users.length})</h4>
          <table class="sa-table sa-table--compact">
            <thead><tr><th>Name</th><th>Email</th><th>Role</th><th>Verified</th><th>Active</th></tr></thead>
            <tbody>${t.users.map(u => `<tr>
              <td>${escHtml(u.fullName)}</td>
              <td>${escHtml(u.email)}</td>
              <td><span class="sa-badge sa-badge--gray">${u.role}</span></td>
              <td>${u.emailVerified ? "Yes" : '<span style="color:#ef4444">No</span>'}</td>
              <td>${u.isActive ? "Yes" : '<span style="color:#ef4444">No</span>'}</td>
            </tr>`).join("")}</tbody>
          </table>
          <div class="sa-detail-footer">
            <button class="sa-btn sa-btn--primary" data-sa-action="impersonate" data-sa-id="${escHtml(t.id)}">Login as Admin</button>
            <button class="sa-btn sa-modal-close">Close</button>
          </div>
        </div>`;
      content.querySelectorAll(".sa-modal-close").forEach(b => b.addEventListener("click", closeSAModal));
      content.querySelector("[data-sa-action=impersonate]")?.addEventListener("click", () => { closeSAModal(); impersonateTenant(tenantId); });
    } catch (err) {
      content.innerHTML = `<div style="padding:24px;color:#ef4444">${escHtml(err.message)}</div>`;
    }
  }

  function closeSAModal() {
    const modal = qs("#sa-detail-modal");
    if (modal) modal.hidden = true;
  }

  async function toggleTenant(tenantId, currentlyActive) {
    const action = currentlyActive ? "deactivate" : "activate";
    if (!confirm(`Are you sure you want to ${action} this workspace?`)) return;
    try {
      await api(`/super-admin/tenants/${tenantId}`, {
        method: "PATCH",
        body: { isActive: !currentlyActive }
      });
      loaded = false;
      loadSuperAdminDashboard();
    } catch (err) { alert("Failed: " + err.message); }
  }

  async function impersonateTenant(tenantId) {
    try {
      const res = await api(`/super-admin/tenants/${tenantId}/impersonate`, { method: "POST" });
      // Open in a new tab with the impersonated token
      const url = new URL(window.location.origin);
      url.searchParams.set("impersonate_token", res.token);
      url.searchParams.set("impersonate_slug", res.tenantSlug);
      window.open(url.toString(), "_blank");
    } catch (err) { alert("Failed: " + err.message); }
  }

  async function deleteTenant(tenantId, name) {
    const confirmed = prompt(`Type "${name}" to confirm deletion:`);
    if (confirmed !== name) return;
    try {
      await api(`/super-admin/tenants/${tenantId}`, { method: "DELETE" });
      loaded = false;
      loadSuperAdminDashboard();
    } catch (err) { alert("Failed: " + err.message); }
  }
})();

// Handle impersonation token from URL (opened from super admin "Login as" button)
(function handleImpersonation() {
  const params = new URLSearchParams(window.location.search);
  const token = params.get("impersonate_token");
  const slug = params.get("impersonate_slug");
  if (token && slug) {
    localStorage.setItem("thinkcrm_token", token);
    localStorage.setItem("tenantSlug", slug);
    state.token = token;
    // Clean the URL
    window.history.replaceState({}, "", "/dashboard");
  }
})();

bootstrap();
