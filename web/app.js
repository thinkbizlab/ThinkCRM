const state = {
  token: localStorage.getItem("thinkcrm_token") || "",
  user: null,
  googleMapsApiKey: null,
  cache: {
    paymentTerms: [],
    customers: [],
    items: [],
    customFieldDefinitions: {
      "payment-terms": [],
      customers: [],
      items: []
    },
    kanban: null,
    dealStages: [],
    visits: [],
    notifPrefs: undefined,
    cronJobs: undefined,
    myIntegrations: null,
    calendar: null,
    logs: [],
    kpiTargets: [],
    salesReps: [],
    taxConfig: null,
    visitConfig: null,
    branding: null,
    integrationCredentials: [],
    teams: [],
    allUsers: [],
    tenantInfo: null
  },
  masterPage: "payment-terms",
  customerListQuery: "",
  customerListPage: 1,
  customerScope: "mine",   // "mine" | "team" | "all"
  customerCreateOpen: false,
  c360: null,
  settingsPage: "my-profile",
  openIntgSections: new Set(),
  openCronHistories: new Set(),
  rolePageQuery: "",
  rolePageTeam: "",
  roleInfoExpanded: false,
  settingsNavCollapsed: false,
  calendarFilters: {
    view: "month",
    eventTypes: ["visit", "deal"],
    anchorDate: new Date().toISOString(),
    query: "",
    ownerIds: [],
    customerId: "",
    customerName: "",
    visitStatuses: ["PLANNED", "CHECKED_IN", "CHECKED_OUT"],
    dealStageIds: [],
    dealStatuses: ["OPEN"]
  },
  dashboardMonth: new Date().toISOString().slice(0, 7),
  dashboardTeamId: "",
  dashboardRepId: "",
  visitPage: (() => {
    const now = new Date();
    const y = now.getFullYear(), m = now.getMonth();
    const pad = n => String(n).padStart(2, "0");
    const lastDay = new Date(y, m + 1, 0).getDate();
    return {
      query: "",
      status: "",
      repIds: [],
      dateFrom: `${y}-${pad(m + 1)}-01`,
      dateTo:   `${y}-${pad(m + 1)}-${pad(lastDay)}`
    };
  })(),
  repHubTab: "visits"
};

const THEME_OVERRIDE_KEY = "thinkcrm_theme_override";
state.themeOverride = localStorage.getItem(THEME_OVERRIDE_KEY) || "AUTO";
state.tenantThemeMode = "LIGHT";

const qs = (selector) => document.querySelector(selector);

const authScreen = qs("#auth-screen");
const appScreen = qs("#app-screen");
const loginForm = qs("#login-form");
const authMessage = qs("#auth-message");

// Apply branding (app name + colors) to the login page before authentication.
function applyLoginBranding(b) {
  const appName = b.appName || "ThinkCRM";
  document.title = appName;
  const nameEl = qs("#login-app-name");
  if (nameEl) nameEl.textContent = appName;

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
}

async function fetchLoginBranding(slug) {
  if (!slug) return;
  try {
    const res = await fetch(`/api/v1/auth/branding/public?slug=${encodeURIComponent(slug)}`);
    if (!res.ok) return;
    applyLoginBranding(await res.json());
  } catch { /* ignore — branding is cosmetic */ }
}

// Auto-resolve workspace from custom domain on login page
(async () => {
  const hostname = window.location.hostname;
  if (hostname === "localhost" || hostname === "127.0.0.1") {
    // Still try to apply branding from the prefilled workspace slug
    const slugInput = loginForm.querySelector('[name="tenantSlug"]');
    if (slugInput?.value) fetchLoginBranding(slugInput.value);
    loadOAuthProviderButtons();
    return;
  }
  try {
    const response = await fetch(`/api/v1/auth/resolve-domain?host=${encodeURIComponent(hostname)}`);
    if (!response.ok) return;
    const data = await response.json();
    if (data.tenantSlug) {
      loginForm.querySelector('[name="tenantSlug"]').value = data.tenantSlug;
      const workspaceRow = qs("#login-workspace-row");
      if (workspaceRow) workspaceRow.hidden = true;
      fetchLoginBranding(data.tenantSlug);
    }
  } catch {
    // Not a custom domain — show workspace field as normal
  }
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
      loadOAuthProviderButtons();
    }, 500);
  });
})();

// Load and show OAuth provider buttons for the current workspace
async function loadOAuthProviderButtons() {
  const panel = qs("#oauth-providers");
  const ms365Btn  = qs("#oauth-ms365-btn");
  const googleBtn = qs("#oauth-google-btn");
  if (!panel || !ms365Btn || !googleBtn) return;
  try {
    const res = await fetch("/api/v1/auth/oauth/providers");
    if (!res.ok) return;
    const { ms365, google } = await res.json();
    ms365Btn.hidden  = !ms365;
    googleBtn.hidden = !google;
    panel.hidden     = !ms365 && !google;
  } catch { /* ignore — OAuth buttons are optional */ }
}

// Wire OAuth provider buttons
(function () {
  qs("#oauth-ms365-btn")?.addEventListener("click", () => {
    const slug = loginForm.querySelector('[name="tenantSlug"]')?.value?.trim();
    if (!slug) { authMessage.textContent = "Please enter your workspace first."; return; }
    window.location.href = `/api/v1/auth/oauth/ms365?tenantSlug=${encodeURIComponent(slug)}`;
  });
  qs("#oauth-google-btn")?.addEventListener("click", () => {
    const slug = loginForm.querySelector('[name="tenantSlug"]')?.value?.trim();
    if (!slug) { authMessage.textContent = "Please enter your workspace first."; return; }
    window.location.href = `/api/v1/auth/oauth/google?tenantSlug=${encodeURIComponent(slug)}`;
  });
})();

// Handle OAuth redirect-back: ?oauth_token=xxx or ?oauth_error=xxx
(async function handleOAuthReturn() {
  const params = new URLSearchParams(window.location.search);
  const oauthToken = params.get("oauth_token");
  const oauthError = params.get("oauth_error");
  if (!oauthToken && !oauthError) return;
  // Clean URL immediately
  window.history.replaceState({}, "", window.location.pathname);
  if (oauthError) {
    authMessage.textContent = oauthError;
    return;
  }
  try {
    // Fetch user info using the OAuth-issued JWT
    const meRes = await fetch("/api/v1/auth/me", {
      headers: { Authorization: `Bearer ${oauthToken}` }
    });
    if (!meRes.ok) throw new Error("Login succeeded but could not load your profile. Please try again.");
    const user = await meRes.json();
    state.token = oauthToken;
    state.user  = user;
    state.calendarFilters.ownerIds = [user.id];
    localStorage.setItem("thinkcrm_token", oauthToken);
    showApp();
    updateUserMeta();
    await loadAllViews();
    applyBrandingTheme(state.cache.branding);
    window.history.replaceState({ view: "repHub" }, "", "/task");
    switchView("repHub");
    paintRepHubFull();
  } catch (e) {
    authMessage.textContent = e.message;
  }
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

const statusBar = qs("#status-bar");
const userMeta = qs("#user-meta");
const pageTitle = qs("#page-title");
const brandMark = qs("#brand-mark");
const brandTitle = qs("#brand-title");
const themeToggleBtn = qs("#theme-toggle-btn");

const views = {
  repHub: qs("#view-rep-hub"),
  dashboard: qs("#view-dashboard"),
  master: qs("#view-master"),
  deals: qs("#view-deals"),
  visits: qs("#view-visits"),
  calendar: qs("#view-calendar"),
  integrations: qs("#view-integrations"),
  settings: qs("#view-settings")
};

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

const dateTime = new Intl.DateTimeFormat("en-GB", {
  year: "numeric",
  month: "short",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit"
});

const masterPageRouteMap = {
  "payment-terms": "/master/payment-terms",
  customers: "/master/customers",
  items: "/master/items"
};

const pageTitleMap = {
  repHub: "My Tasks",
  dashboard: "Dashboard",
  master: "Master Data",
  deals: "Deals Pipeline",
  visits: "Visit Execution",
  calendar: "Sales Calendar",
  integrations: "Integration Logs",
  settings: "Admin Settings"
};

const customFieldEntityApiMap = {
  "payment-terms": "payment-term",
  customers: "customer",
  items: "item"
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

function asDate(value) {
  if (!value) return "-";
  return dateTime.format(new Date(value));
}

function asDateInput(value) {
  if (!value) return "";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "";
  return d.toISOString().slice(0, 10);
}

function asPercent(value) {
  if (value == null || Number.isNaN(Number(value))) return "0.00";
  return Number(value).toFixed(2);
}

function shiftAnchorDate(anchorDate, view, direction) {
  const d = new Date(anchorDate || new Date().toISOString());
  const amount = direction === "next" ? 1 : -1;
  if (view === "year") d.setUTCFullYear(d.getUTCFullYear() + amount);
  if (view === "month") d.setUTCMonth(d.getUTCMonth() + amount);
  if (view === "day") d.setUTCDate(d.getUTCDate() + amount);
  return d.toISOString();
}

function prettyLabel(value) {
  return String(value)
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function getCustomFieldDefinitions(pageKey) {
  return state.cache.customFieldDefinitions[pageKey] || [];
}

function collectCustomFieldPayload(formData, definitions) {
  const customFields = {};
  definitions
    .filter((definition) => definition.isActive)
    .forEach((definition) => {
      const key = `cf__${definition.fieldKey}`;
      if (definition.dataType === "BOOLEAN") {
        customFields[definition.fieldKey] = formData.has(key);
        return;
      }
      const rawValue = formData.get(key);
      if (rawValue == null) return;
      const value = String(rawValue).trim();
      if (!value.length) return;
      if (definition.dataType === "NUMBER") {
        customFields[definition.fieldKey] = Number(value);
        return;
      }
      customFields[definition.fieldKey] = value;
    });
  return customFields;
}

function renderCustomFieldInputs(definitions) {
  const activeDefinitions = definitions.filter((definition) => definition.isActive);
  if (!activeDefinitions.length) return "";
  return `
    <div class="list">
      ${activeDefinitions
        .map((definition) => {
          const key = `cf__${definition.fieldKey}`;
          const required = definition.isRequired ? "required" : "";
          if (definition.dataType === "SELECT") {
            const options = Array.isArray(definition.optionsJson) ? definition.optionsJson : [];
            return `
              <label>${definition.label}
                <select name="${key}" ${required}>
                  <option value="">Select...</option>
                  ${options.map((option) => `<option value="${option}">${option}</option>`).join("")}
                </select>
              </label>
            `;
          }
          if (definition.dataType === "BOOLEAN") {
            return `
              <label>
                <input type="checkbox" name="${key}" />
                ${definition.label}
              </label>
            `;
          }
          const inputType = definition.dataType === "NUMBER" ? "number" : definition.dataType === "DATE" ? "date" : "text";
          return `
            <label>${definition.label}
              <input name="${key}" type="${inputType}" ${required} placeholder="${definition.placeholder || ""}" />
            </label>
          `;
        })
        .join("")}
    </div>
  `;
}

function renderCustomFieldDefinitionRows(pageKey) {
  const definitions = getCustomFieldDefinitions(pageKey);
  if (!definitions.length) {
    return '<div class="empty-state compact"><div><strong>No custom fields</strong><p>Add fields to configure tenant-specific metadata.</p></div></div>';
  }
  return definitions
    .map(
      (definition) => `
      <div class="row">
        <h4>${definition.label}</h4>
        <div class="muted">${definition.fieldKey} · ${definition.dataType}</div>
        <div class="muted">Required: ${definition.isRequired ? "Yes" : "No"} · Order: ${definition.displayOrder}</div>
        <div class="inline-actions wrap">
          <button
            class="custom-field-toggle ghost"
            data-id="${definition.id}"
            data-entity="${customFieldEntityApiMap[pageKey]}"
            data-active="${definition.isActive}"
          >
            ${definition.isActive ? "Deactivate" : "Activate"}
          </button>
        </div>
      </div>
    `
    )
    .join("");
}

function renderCustomFieldsSummary(values) {
  if (!values || typeof values !== "object" || Array.isArray(values)) return "";
  const entries = Object.entries(values);
  if (!entries.length) return "";
  return `
    <div class="inline-actions wrap">
      ${entries
        .map(
          ([key, value]) =>
            `<span class="chip">${prettyLabel(key)}: ${typeof value === "boolean" ? (value ? "Yes" : "No") : value}</span>`
        )
        .join("")}
    </div>
  `;
}

function normalizeHex(value, fallback) {
  if (typeof value !== "string") return fallback;
  const trimmed = value.trim();
  if (/^#[0-9a-fA-F]{6}$/.test(trimmed)) return trimmed;
  if (/^#[0-9a-fA-F]{3}$/.test(trimmed)) {
    return `#${trimmed[1]}${trimmed[1]}${trimmed[2]}${trimmed[2]}${trimmed[3]}${trimmed[3]}`;
  }
  return fallback;
}

function darkenHex(hex, amount = 26) {
  const parsed = normalizeHex(hex, "#2563eb").slice(1);
  const r = Math.max(0, parseInt(parsed.slice(0, 2), 16) - amount);
  const g = Math.max(0, parseInt(parsed.slice(2, 4), 16) - amount);
  const b = Math.max(0, parseInt(parsed.slice(4, 6), 16) - amount);
  return `#${r.toString(16).padStart(2, "0")}${g.toString(16).padStart(2, "0")}${b.toString(16).padStart(2, "0")}`;
}

function lightenHex(hex, amount = 26) {
  const parsed = normalizeHex(hex, "#2563eb").slice(1);
  const r = Math.min(255, parseInt(parsed.slice(0, 2), 16) + amount);
  const g = Math.min(255, parseInt(parsed.slice(2, 4), 16) + amount);
  const b = Math.min(255, parseInt(parsed.slice(4, 6), 16) + amount);
  return `#${r.toString(16).padStart(2, "0")}${g.toString(16).padStart(2, "0")}${b.toString(16).padStart(2, "0")}`;
}

function tintHex(hex, ratio) {
  const parsed = normalizeHex(hex, "#2563eb").slice(1);
  const r = Math.round(parseInt(parsed.slice(0, 2), 16) + (255 - parseInt(parsed.slice(0, 2), 16)) * ratio);
  const g = Math.round(parseInt(parsed.slice(2, 4), 16) + (255 - parseInt(parsed.slice(2, 4), 16)) * ratio);
  const b = Math.round(parseInt(parsed.slice(4, 6), 16) + (255 - parseInt(parsed.slice(4, 6), 16)) * ratio);
  return `#${r.toString(16).padStart(2, "0")}${g.toString(16).padStart(2, "0")}${b.toString(16).padStart(2, "0")}`;
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

  const themeMeta = document.querySelector('meta[name="theme-color"]');
  if (themeMeta) {
    themeMeta.setAttribute("content", primary);
  }

  const appName = b.appName || "ThinkCRM";
  document.title = appName;
  if (brandTitle) {
    brandTitle.textContent = appName;
  }
  if (brandMark) {
    const logoSrc = b.logoUrl || "/default-brand.svg";
    brandMark.innerHTML = `<img src="${logoSrc}" alt="logo" />`;
  }

  applyThemeMode(b.themeMode || "LIGHT");
  applyFavicon(b.faviconUrl || null);
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
  link.type = src.endsWith(".svg") ? "image/svg+xml" : "image/png";
}

function renderThemeDebugChip() {
  return `<span class="chip theme-debug-chip">Tenant: ${state.tenantThemeMode} | User: ${state.themeOverride}</span>`;
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
      el.innerHTML = `<img src="${state.user.avatarUrl}" alt="${state.user.fullName || ""}" style="width:${size}px;height:${size}px;border-radius:50%;object-fit:cover;display:block">`;
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

function setStatus(text, isError = false, isWarning = false) {
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
    <span class="toast-msg">${text}</span>
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

async function api(path, options = {}) {
  const isFormData = options.body instanceof FormData;
  const hasBody = options.body !== undefined && options.body !== null;
  const headers = {
    ...(hasBody && !isFormData ? { "content-type": "application/json" } : {}),
    ...(options.headers || {})
  };
  if (state.token) headers.Authorization = `Bearer ${state.token}`;

  const response = await fetch(`/api/v1${path}`, {
    method: options.method || "GET",
    headers,
    body: hasBody ? (isFormData ? options.body : JSON.stringify(options.body)) : undefined
  });

  const text = await response.text();
  const data = text ? JSON.parse(text) : null;

  if (!response.ok) {
    throw new Error(data?.message || `API ${response.status}`);
  }
  return data;
}

const voiceNoteState = {
  onClose: null,
  entityType: null,
  entityId: null,
  jobId: null,
  mediaRecorder: null,
  chunks: [],
  stream: null,
  initBound: false,
  aiAvailable: null,   // null = not yet checked, true/false = cached result
  recognition: null,   // SpeechRecognition instance
  transcript: "",      // accumulated browser speech-to-text transcript
  outputLang: "TH",    // "TH" | "EN" — default Thai
  processing: false    // true while upload/summarize is in flight
};

function getVoiceNoteEls() {
  const root = qs("#voice-note-modal");
  if (!root) return null;
  return {
    root,
    subtitle: qs("#voice-note-modal-subtitle"),
    aiWarning: qs("#voice-note-ai-warning"),
    recordBtn: qs("#voice-note-record"),
    stopBtn: qs("#voice-note-stop"),
    status: qs("#voice-note-status"),
    review: qs("#voice-note-review"),
    transcript: qs("#voice-note-transcript"),
    summary: qs("#voice-note-summary"),
    confirmBtn: qs("#voice-note-confirm"),
    fileInput: qs("#voice-note-file")
  };
}

function setVoiceNoteStatus(text, isError = false) {
  const els = getVoiceNoteEls();
  if (!els?.status) return;
  els.status.textContent = text || "";
  els.status.style.color = isError ? "#b91c1c" : "";
}

function stopVoiceNoteMedia() {
  if (voiceNoteState.mediaRecorder && voiceNoteState.mediaRecorder.state !== "inactive") {
    try {
      voiceNoteState.mediaRecorder.stop();
    } catch {
      /* ignore */
    }
  }
  voiceNoteState.mediaRecorder = null;
  voiceNoteState.chunks = [];
  if (voiceNoteState.stream) {
    voiceNoteState.stream.getTracks().forEach((t) => t.stop());
    voiceNoteState.stream = null;
  }
  if (voiceNoteState.recognition) {
    try { voiceNoteState.recognition.abort(); } catch { /* ignore */ }
    voiceNoteState.recognition = null;
  }
}

function resetVoiceNoteModal() {
  const els = getVoiceNoteEls();
  if (!els) return;
  stopVoiceNoteMedia();
  voiceNoteState.jobId = null;
  voiceNoteState.transcript = "";
  voiceNoteState.processing = false;
  els.review.hidden = true;
  els.transcript.value = "";
  els.transcript.disabled = false;
  els.summary.value = "";
  els.fileInput.value = "";
  els.recordBtn.disabled = false;
  els.stopBtn.disabled = true;
  els.confirmBtn.disabled = false;
  setVoiceNoteStatus("");
}

async function openVoiceNoteModal(entityType, entityId, subtitle) {
  const els = getVoiceNoteEls();
  if (!els) return;
  resetVoiceNoteModal();
  voiceNoteState.entityType = entityType;
  voiceNoteState.entityId = entityId;
  els.subtitle.textContent = subtitle ? `${entityType} · ${subtitle}` : entityType;
  els.root.hidden = false;

  // Check AI availability (cached after first call)
  if (voiceNoteState.aiAvailable === null) {
    try {
      const status = await api("/ai/status");
      voiceNoteState.aiAvailable = status.transcriptionAvailable === true;
    } catch {
      voiceNoteState.aiAvailable = false;
    }
  }
  els.aiWarning.hidden = voiceNoteState.aiAvailable !== false;
}

function closeVoiceNoteModal() {
  if (voiceNoteState.processing) return;   // block close while upload/summarize is in flight
  const els = getVoiceNoteEls();
  if (!els) return;
  resetVoiceNoteModal();
  els.root.hidden = true;
  const cb = voiceNoteState.onClose;
  voiceNoteState.onClose = null;
  if (cb) cb();
}

function _lockVoiceNoteModal() {
  voiceNoteState.processing = true;
  const els = getVoiceNoteEls();
  if (!els) return;
  els.recordBtn.disabled = true;
  els.stopBtn.disabled = true;
  els.confirmBtn.disabled = true;
  els.fileInput.disabled = true;
  els.root.querySelectorAll("[data-voice-note-close]").forEach(el => el.setAttribute("disabled", "true"));
}

function _unlockVoiceNoteModal() {
  voiceNoteState.processing = false;
  const els = getVoiceNoteEls();
  if (!els) return;
  els.confirmBtn.disabled = false;
  els.fileInput.disabled = false;
  els.root.querySelectorAll("[data-voice-note-close]").forEach(el => el.removeAttribute("disabled"));
}

async function uploadVoiceNoteAudio(blob, filename) {
  if (!voiceNoteState.entityType || !voiceNoteState.entityId) return;
  const aiReady = voiceNoteState.aiAvailable === true;
  const hasTranscript = Boolean(voiceNoteState.transcript);
  _lockVoiceNoteModal();
  setVoiceNoteStatus(aiReady && hasTranscript ? "Uploading and summarizing…" : "Uploading audio…");
  try {
    const form = new FormData();
    form.append("entityType", voiceNoteState.entityType);
    form.append("entityId", voiceNoteState.entityId);
    form.append("audio", blob, filename || "voice-note.webm");
    if (voiceNoteState.transcript) form.append("transcriptText", voiceNoteState.transcript);
    form.append("outputLang", voiceNoteState.outputLang);
    const job = await api("/voice-notes", { method: "POST", body: form });
    const els2 = getVoiceNoteEls();
    if (els2) {
      voiceNoteState.jobId = job.id;
      els2.transcript.value = job.transcript?.transcriptText ?? "";
      els2.transcript.disabled = false;
      els2.summary.value = job.transcript?.summaryText ?? "";
      els2.review.hidden = false;
    }
    setVoiceNoteStatus(
      aiReady && hasTranscript
        ? "Review and edit, then confirm to save."
        : aiReady
          ? "No speech detected. Enter notes manually and confirm to save."
          : "Audio uploaded. Enter visit notes and confirm to save."
    );
  } catch (error) {
    setVoiceNoteStatus(error.message, true);
    const els2 = getVoiceNoteEls();
    if (els2) els2.recordBtn.disabled = false;
  } finally {
    _unlockVoiceNoteModal();
  }
}

async function startVoiceNoteRecording() {
  const els = getVoiceNoteEls();
  if (!els || !navigator.mediaDevices?.getUserMedia) {
    setVoiceNoteStatus("Recording is not available in this browser. Use “Upload file”.", true);
    return;
  }
  if (!window.MediaRecorder) {
    setVoiceNoteStatus("MediaRecorder is not supported. Use “Upload file”.", true);
    return;
  }
  try {
    voiceNoteState.stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    // Probe in priority order: MP4/AAC first (universal playback incl. Safari/iOS)
    const PREFERRED_TYPES = [
      "audio/mp4;codecs=mp4a.40.2",
      "audio/mp4",
      "audio/webm;codecs=opus",
      "audio/webm",
      "audio/ogg;codecs=opus"
    ];
    const mime = PREFERRED_TYPES.find(t => MediaRecorder.isTypeSupported(t)) || "";
    voiceNoteState.chunks = [];
    try {
      voiceNoteState.mediaRecorder = new MediaRecorder(voiceNoteState.stream, ...(mime ? [{ mimeType: mime }] : []));
    } catch {
      voiceNoteState.mediaRecorder = new MediaRecorder(voiceNoteState.stream);
    }
    voiceNoteState.mediaRecorder.ondataavailable = (ev) => {
      if (ev.data && ev.data.size > 0) voiceNoteState.chunks.push(ev.data);
    };
    voiceNoteState.mediaRecorder.start();

    // Start browser speech-to-text in parallel (if supported and AI is available)
    voiceNoteState.transcript = "";
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (SpeechRecognition && voiceNoteState.aiAvailable) {
      try {
        const recog = new SpeechRecognition();
        recog.continuous = true;
        recog.interimResults = false;
        recog.lang = voiceNoteState.outputLang === "TH" ? "th-TH" : "en-US";
        recog.onresult = (ev) => {
          for (let i = ev.resultIndex; i < ev.results.length; i++) {
            if (ev.results[i].isFinal) {
              voiceNoteState.transcript += (voiceNoteState.transcript ? " " : "") + ev.results[i][0].transcript.trim();
            }
          }
        };
        recog.onerror = () => { /* silently ignore — audio still uploads */ };
        recog.start();
        voiceNoteState.recognition = recog;
      } catch {
        voiceNoteState.recognition = null;
      }
    }

    // Lock all controls except the Stop button while recording
    els.recordBtn.disabled = true;
    els.confirmBtn.disabled = true;
    els.fileInput.disabled = true;
    els.root.querySelectorAll("[data-voice-note-close]").forEach(el => el.setAttribute("disabled", "true"));
    els.stopBtn.disabled = false;
    els.stopBtn.textContent = voiceNoteState.aiAvailable ? "Stop & transcribe" : "Stop & upload";
    setVoiceNoteStatus("Recording… click Stop when finished.");
  } catch (error) {
    setVoiceNoteStatus(error.message || "Could not access microphone.", true);
    stopVoiceNoteMedia();
    // Re-enable controls if mic access failed
    _unlockVoiceNoteModal();
    els.recordBtn.disabled = false;
  }
}

function stopVoiceNoteRecording() {
  const els = getVoiceNoteEls();
  if (!els || !voiceNoteState.mediaRecorder) return;
  const mr = voiceNoteState.mediaRecorder;
  if (mr.state === "inactive") return;
  els.stopBtn.disabled = true;
  setVoiceNoteStatus("Processing recording…");
  // Stop speech recognition so its final results are committed before upload
  if (voiceNoteState.recognition) {
    try { voiceNoteState.recognition.stop(); } catch { /* ignore */ }
    voiceNoteState.recognition = null;
  }
  mr.addEventListener(
    "stop",
    async () => {
      voiceNoteState.stream?.getTracks().forEach((t) => t.stop());
      voiceNoteState.stream = null;
      const blob = new Blob(voiceNoteState.chunks, { type: mr.mimeType || "audio/webm" });
      voiceNoteState.chunks = [];
      voiceNoteState.mediaRecorder = null;
      if (!blob.size) {
        setVoiceNoteStatus("No audio captured. Try again or upload a file.", true);
        els.recordBtn.disabled = false;
        return;
      }
      const ext = blob.type.includes("webm") ? "webm"
        : blob.type.includes("mp4")  ? "mp4"
        : blob.type.includes("ogg")  ? "ogg"
        : "audio";
      await uploadVoiceNoteAudio(blob, `note.${ext}`);
    },
    { once: true }
  );
  mr.stop();
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
        <span class="ncm-title">🔌 Setup Guide</span>
        <button type="button" class="ncm-close" id="intg-guide-close">✕</button>
      </div>
      <div class="intg-guide-body">
        <div class="intg-guide-banner">
          <div class="intg-guide-banner-icon">📋</div>
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

function bindVoiceNoteModal() {
  if (voiceNoteState.initBound) return;
  const els = getVoiceNoteEls();
  if (!els) return;
  voiceNoteState.initBound = true;
  els.root.addEventListener("click", (event) => {
    if (event.target?.closest?.("[data-voice-note-close]")) closeVoiceNoteModal();
    const langBtn = event.target?.closest?.(".vn-lang-btn");
    if (langBtn) {
      voiceNoteState.outputLang = langBtn.dataset.lang || "TH";
      els.root.querySelectorAll(".vn-lang-btn").forEach(b => b.classList.toggle("vn-lang-btn--active", b === langBtn));
    }
  });
  els.recordBtn.addEventListener("click", () => {
    void startVoiceNoteRecording();
  });
  els.stopBtn.addEventListener("click", () => {
    stopVoiceNoteRecording();
  });
  els.fileInput.addEventListener("change", () => {
    const file = els.fileInput.files?.[0];
    if (!file) return;
    void uploadVoiceNoteAudio(file, file.name);
    els.fileInput.value = "";
  });
  els.confirmBtn.addEventListener("click", async () => {
    if (!voiceNoteState.jobId) return;
    setVoiceNoteStatus("Saving…");
    els.confirmBtn.disabled = true;
    try {
      await api(`/voice-notes/${voiceNoteState.jobId}/confirm`, {
        method: "POST",
        body: {
          transcriptText: els.transcript.value,
          summaryText: els.summary.value
        }
      });
      const reloadAs   = voiceNoteState.entityType;
      const reloadId   = voiceNoteState.entityId;
      const savedSummary = els.summary.value.trim();
      setStatus("Voice note confirmed and saved.");
      closeVoiceNoteModal();
      if (reloadAs === "DEAL") {
        await loadDeals();
        await loadDashboard();
      } else if (reloadAs === "VISIT") {
        // If the checkout popup is still open, pre-fill its result field with the voice note summary
        // so the user sees the text and it gets included in the check-out submission.
        if (savedSummary) {
          const checkoutResultEl = qs("#mt-checkout-result");
          if (checkoutResultEl && !checkoutResultEl.value.trim()) {
            checkoutResultEl.value = savedSummary;
          }
        }
        await loadVisits();
        if (reloadId && visitDetailBody && !visitDetailBody.closest("[hidden]")) {
          openVisitDetail(reloadId);
        }
      }
    } catch (error) {
      setVoiceNoteStatus(error.message, true);
      els.confirmBtn.disabled = false;
    }
  });
}

function switchView(target) {
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

function showApp() {
  authScreen.classList.remove("active");
  appScreen.classList.add("active");
}

function showAuth() {
  appScreen.classList.remove("active");
  authScreen.classList.add("active");
}

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
  "cron-jobs":      "/settings/scheduled-jobs"
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
  integrations: "/integrations"
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

function renderDashboard(data) {
  const completion = Number(data.kpis.visitCompletionRate || 0);
  const periodMonth = data?.period?.month || state.dashboardMonth;
  state.dashboardMonth = periodMonth;
  const topGamers = Array.isArray(data.gamification) ? data.gamification.slice(0, 5) : [];
  const teams = Array.isArray(data.teamPerformance) ? data.teamPerformance : [];
  const role = state.user?.role ?? "REP";
  const canFilterReps = role !== "REP";
  const allReps = state.cache.salesReps || [];
  const allTeams = state.cache.teams || [];

  // Filter rep list to selected team
  const visibleReps = state.dashboardTeamId
    ? allReps.filter(r => r.teamId === state.dashboardTeamId)
    : allReps;

  const teamSelectHtml = (canFilterReps && allTeams.length > 0) ? `
    <label class="dashboard-filter-label">Team
      <select id="dashboard-team-select" class="dashboard-rep-select">
        <option value="">All Teams</option>
        ${allTeams.map(t => `<option value="${t.id}" ${state.dashboardTeamId === t.id ? "selected" : ""}>${escHtml(t.teamName)}</option>`).join("")}
      </select>
    </label>` : "";

  const repSelectHtml = (canFilterReps && visibleReps.length > 0) ? `
    <label class="dashboard-filter-label">Sales Rep
      <select id="dashboard-rep-select" class="dashboard-rep-select">
        <option value="">All Reps</option>
        ${visibleReps.map(r => `<option value="${r.id}" ${state.dashboardRepId === r.id ? "selected" : ""}>${escHtml(r.fullName)}</option>`).join("")}
      </select>
    </label>` : "";

  views.dashboard.innerHTML = `
    <div class="dash-view">
      <div class="dash-filter-bar">
        <form id="dashboard-month-form" class="inline-actions dashboard-filter-form">
          <label class="dashboard-filter-label">
            <input type="month" name="month" value="${periodMonth}" required />
          </label>
          ${teamSelectHtml}
          ${repSelectHtml}
          <button type="submit">Apply</button>
        </form>
        <div class="inline-actions wrap dashboard-chip-row">
          <span class="chip">👥 ${data.kpis.usersInScope} reps</span>
          <span class="chip">✨ ${data.kpis.dealsCreatedInPeriod} new deals</span>
          <span class="chip">📅 ${data.kpis.visitsPlannedInPeriod} visits planned</span>
        </div>
      </div>

      <div class="kpi-strip">
        <article class="kpi">
          <div class="kpi-icon">📊</div>
          <h4>Active Deals</h4>
          <strong>${data.kpis.activeDeals}</strong>
          <div class="muted">Open in pipeline</div>
        </article>
        <article class="kpi kpi--pipeline">
          <div class="kpi-icon">💰</div>
          <h4>Pipeline</h4>
          <strong>${asMoney(data.kpis.pipelineValue)}</strong>
          <div class="muted">Potential revenue</div>
        </article>
        <article class="kpi kpi--won">
          <div class="kpi-icon">🏆</div>
          <h4>Won</h4>
          <strong>${asMoney(data.kpis.wonValue)}</strong>
          <div class="muted">Closed &amp; collected 🎉</div>
        </article>
        <article class="kpi kpi--lost">
          <div class="kpi-icon">📉</div>
          <h4>Lost</h4>
          <strong>${asMoney(data.kpis.lostValue)}</strong>
          <div class="muted">Learn &amp; bounce back 💪</div>
        </article>
        <article class="kpi kpi--visits">
          <div class="kpi-icon">🚀</div>
          <h4>Visit Rate</h4>
          <strong>${completion}%</strong>
          <div class="progress kpi-progress"><span style="width:${Math.min(completion, 100)}%"></span></div>
          <div class="muted">Completed visits</div>
        </article>
      </div>

      <div class="dash-grid">
        <div class="dash-section">
          <h3 class="section-title">🎯 Target Achievement</h3>
          ${
            data.targetVsActual.length
              ? data.targetVsActual.map((t) => {
                  const pv = Number(t.progress.visits || 0);
                  const pd = Number(t.progress.newDealValue || 0);
                  const pr = Number(t.progress.revenue || 0);
                  const barCls = (p) => p >= 100 ? "progress-bar--great" : p >= 70 ? "progress-bar--good" : p >= 40 ? "progress-bar--warn" : "progress-bar--low";
                  const valCls = (p) => p >= 100 ? "metric-val--great" : p >= 70 ? "metric-val--good" : "";
                  return `
                <div class="target-rep">
                  <div class="target-rep-head">
                    <h4>${escHtml(t.userName)}</h4>
                    <span class="chip">${escHtml(t.teamName)}</span>
                    <span class="muted">${t.month}</span>
                  </div>
                  <div class="target-metric">
                    <span class="target-metric-label">🏃 Visits</span>
                    <div class="progress"><span class="${barCls(pv)}" style="width:${Math.min(pv, 100)}%"></span></div>
                    <span class="target-metric-val ${valCls(pv)}">${t.actual.visits}/${t.target.visits}</span>
                  </div>
                  <div class="target-metric">
                    <span class="target-metric-label">💼 New Deal</span>
                    <div class="progress"><span class="${barCls(pd)}" style="width:${Math.min(pd, 100)}%"></span></div>
                    <span class="target-metric-val ${valCls(pd)}">${asPercent(t.progress.newDealValue)}%</span>
                  </div>
                  <div class="target-metric">
                    <span class="target-metric-label">💵 Revenue</span>
                    <div class="progress"><span class="${barCls(pr)}" style="width:${Math.min(pr, 100)}%"></span></div>
                    <span class="target-metric-val ${valCls(pr)}">${asPercent(t.progress.revenue)}%</span>
                  </div>
                </div>`;
                }).join("")
              : '<div class="empty-state compact"><div class="empty-icon">🎯</div><div><strong>No KPI targets yet</strong><p>Set monthly targets in Settings.</p></div></div>'
          }
        </div>

        <div class="dash-section">
          <div class="section-title-row">
            <h3 class="section-title" style="margin:0">🏅 Leaderboard</h3>
            <button type="button" class="section-info-btn" id="leaderboard-info-btn" aria-label="How scoring works">
              <svg width="15" height="15" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="8"/><polyline points="11 12 12 12 12 16"/></svg>
            </button>
          </div>
          ${
            topGamers.length
              ? (() => {
                  const isRep = (state.user?.role ?? "") === "REP";
                  const myUserId = state.user?.id ?? "";
                  return topGamers.map((g) => {
                    const rankLabel = g.rank === 1 ? "🥇" : g.rank === 2 ? "🥈" : g.rank === 3 ? "🥉" : `#${g.rank}`;
                    const badgeEmoji = g.badge === "Legend" ? "🌟" : g.badge === "Gold" ? "🏅" : g.badge === "Silver" ? "🥈" : "🎖";
                    const momentumHtml = g.momentum === "up"
                      ? `<span class="lb-momentum lb-momentum--up"><svg width="11" height="11" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="18 15 12 9 6 15"/></svg>UP</span>`
                      : g.momentum === "steady"
                      ? `<span class="lb-momentum lb-momentum--steady"><svg width="11" height="11" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="5 12 19 12"/><polyline points="14 7 19 12 14 17"/></svg>STEADY</span>`
                      : `<span class="lb-momentum lb-momentum--down"><svg width="11" height="11" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="6 9 12 15 18 9"/></svg>DOWN</span>`;

                    const isMe = g.userId === myUserId;
                    const masked = isRep && !isMe;

                    if (masked) {
                      return `
                      <div class="leaderboard-item leaderboard-item--masked${g.rank <= 3 ? " leaderboard-item--top" : ""}">
                        <div class="lb-rank">${rankLabel}</div>
                        <div class="leaderboard-info">
                          <h4 class="lb-masked-name">Competitor</h4>
                          <div class="lb-sub"><span class="lb-masked-badge">———</span></div>
                        </div>
                        <div class="leaderboard-score">
                          <strong>${asPercent(g.score)}</strong>
                          ${momentumHtml}
                        </div>
                      </div>`;
                    }

                    return `
                    <div class="leaderboard-item${g.rank <= 3 ? " leaderboard-item--top" : ""}${isMe ? " leaderboard-item--me" : ""}">
                      <div class="lb-rank">${rankLabel}</div>
                      <div class="lb-avatar" style="${g.avatarUrl ? "overflow:hidden" : "background:" + avatarColor(g.userName)}">${repAvatarHtml(g.userName, g.avatarUrl)}</div>
                      <div class="leaderboard-info">
                        <h4>${escHtml(g.userName)}${isMe ? ' <span class="lb-you-badge">You</span>' : ""}</h4>
                        <div class="lb-sub">
                          <span class="lb-badge-pill lb-badge--${g.badge.toLowerCase()}">${badgeEmoji} ${g.badge}</span>
                          <span class="lb-streak">🔥 ${g.streakDays}d</span>
                          <span class="lb-team muted">${escHtml(g.teamName)}</span>
                        </div>
                      </div>
                      <div class="leaderboard-score">
                        <strong>${asPercent(g.score)}</strong>
                        ${momentumHtml}
                      </div>
                    </div>`;
                  }).join("");
                })()
              : '<div class="empty-state compact"><div class="empty-icon">🏆</div><div><strong>No leaderboard data</strong><p>Create KPI targets to generate rankings.</p></div></div>'
          }
        </div>
      </div>

      ${teams.length ? `
        <div class="dash-section" style="margin-top: var(--sp-4)">
          <h3 class="section-title">👥 Team Performance</h3>
          ${teams.map((team) => {
            const tvr = Number(team.visitCompletionRate || 0);
            const barCls = tvr >= 100 ? "progress-bar--great" : tvr >= 70 ? "progress-bar--good" : tvr >= 40 ? "progress-bar--warn" : "progress-bar--low";
            return `
            <div class="team-row">
              <div class="target-rep-head">
                <h4>🏢 ${escHtml(team.teamName)}</h4>
                <span class="chip">👤 ${team.memberCount} member${team.memberCount === 1 ? "" : "s"}</span>
              </div>
              <div class="inline-actions wrap dashboard-chip-row" style="margin-top: var(--sp-1)">
                <span class="chip">📂 ${team.activeDeals} deals</span>
                <span class="chip">💰 ${asMoney(team.pipelineValue)}</span>
                <span class="chip chip-success">🏆 ${asMoney(team.wonValue)}</span>
                <span class="chip chip-danger">📉 ${asMoney(team.lostValue)}</span>
              </div>
              <div class="target-metric" style="margin-top: var(--sp-2)">
                <span class="target-metric-label">📍 Visits</span>
                <div class="progress"><span class="${barCls}" style="width:${Math.min(tvr, 100)}%"></span></div>
                <span class="target-metric-val">${team.checkedOutVisits}/${team.plannedVisits}</span>
              </div>
            </div>`;
          }).join("")}
        </div>
      ` : ""}

      <!-- ── AI Lost Deals Insights ─────────────────────────── -->
      <div class="dash-section ai-insights-section" style="margin-top: var(--sp-4)">
        <div class="ai-insights-header">
          <div class="ai-insights-title-row">
            <span class="ai-insights-icon">
              <svg width="16" height="16" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 2a10 10 0 1 0 10 10"/><path d="M12 6v6l4 2"/><circle cx="19" cy="5" r="3" fill="currentColor" stroke="none"/></svg>
            </span>
            <h3 class="section-title" style="margin:0">AI Lost Deals Insights</h3>
            <span class="chip">Beta</span>
          </div>
          <div class="ai-insights-controls">
            <input type="month" id="ai-date-from" class="ai-date-input" title="From" />
            <span class="muted small">to</span>
            <input type="month" id="ai-date-to"   class="ai-date-input" title="To" />
            <button type="button" class="ai-run-btn" id="ai-run-btn">
              <svg width="13" height="13" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polygon points="5 3 19 12 5 21 5 3"/></svg>
              Analyze
            </button>
          </div>
        </div>
        <div id="ai-insights-body" class="ai-insights-body">
          <p class="ai-insights-placeholder">
            <svg width="32" height="32" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.5" opacity=".35" aria-hidden="true"><path d="M9.663 17h4.673M12 3v1m6.364 1.636-.707.707M21 12h-1M4 12H3m3.343-5.657-.707-.707m2.828 9.9a5 5 0 1 1 7.072 0l-.548.547A3.374 3.374 0 0 0 14 18.469V19a2 2 0 1 1-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z"/></svg>
            Select a date range and click <strong>Analyze</strong> to get AI insights from your lost deal notes.
          </p>
        </div>
      </div>
    </div>
  `;

  qs("#dashboard-month-form")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const fd = new FormData(event.currentTarget);
    const month = String(fd.get("month") || "");
    if (!month) return;
    state.dashboardRepId = String(fd.get("repId") || "");
    await loadDashboard(month);
  });

  qs("#dashboard-team-select")?.addEventListener("change", async (e) => {
    state.dashboardTeamId = e.target.value;
    state.dashboardRepId = "";
    await loadDashboard();
  });

  qs("#dashboard-rep-select")?.addEventListener("change", async (e) => {
    state.dashboardRepId = e.target.value;
    await loadDashboard();
  });

  // Pre-fill date range to last 3 months
  const now = new Date();
  const toMonth   = now.toISOString().slice(0, 7);
  const fromMonth = new Date(now.getFullYear(), now.getMonth() - 2, 1).toISOString().slice(0, 7);
  const aiFromEl = qs("#ai-date-from");
  const aiToEl   = qs("#ai-date-to");
  if (aiFromEl) aiFromEl.value = fromMonth;
  if (aiToEl)   aiToEl.value   = toMonth;

  qs("#ai-run-btn")?.addEventListener("click", async () => {
    const body = qs("#ai-insights-body");
    const runBtn = qs("#ai-run-btn");
    if (!body || !runBtn) return;

    const dateFrom = aiFromEl?.value ? `${aiFromEl.value}-01T00:00:00.000Z` : undefined;
    const dateTo   = aiToEl?.value   ? `${aiToEl.value}-31T23:59:59.999Z`   : undefined;
    const params   = new URLSearchParams();
    if (dateFrom) params.set("dateFrom", dateFrom);
    if (dateTo)   params.set("dateTo",   dateTo);

    runBtn.disabled = true;
    runBtn.textContent = "Analyzing…";
    body.innerHTML = `<div class="ai-insights-loading"><span class="ai-spinner"></span> Reading lost deal notes and finding patterns…</div>`;

    try {
      const result = await api(`/ai/lost-deals-analysis?${params}`);

      if (result.configured === false) {
        body.innerHTML = `
          <div class="ai-not-configured">
            <div class="ai-not-configured-icon">
              <svg width="28" height="28" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>
              </svg>
            </div>
            <div class="ai-not-configured-body">
              <strong>Anthropic API key not configured</strong>
              <p>To use AI-powered insights, add your Anthropic API key in Organization Settings.</p>
              <button class="primary small" id="ai-goto-settings-btn">Go to Settings → Integrations</button>
            </div>
          </div>`;
        qs("#ai-goto-settings-btn")?.addEventListener("click", () => {
          state.settingsPage = "integrations";
          navigateToSettingsPage("integrations");
          switchView("settings");
        });
        return;
      }

      if (!result.analysis || result.dealCount === 0) {
        body.innerHTML = `<p class="ai-insights-placeholder">No lost deals with notes found for this period. Move deals to your Lost stage and add notes to start building insights.</p>`;
        return;
      }

      const { analysis, dealCount } = result;
      const priColor = (p) => p === "high" ? "var(--danger)" : p === "medium" ? "var(--warning)" : "var(--success)";
      const priBg    = (p) => p === "high" ? "var(--danger-bg)" : p === "medium" ? "var(--warning-bg)" : "var(--success-bg)";

      body.innerHTML = `
        <div class="ai-insights-result">
          <div class="ai-summary-box">
            <p class="ai-summary-text">${escHtml(analysis.summary || "")}</p>
            <span class="ai-summary-meta">${dealCount} lost deal${dealCount !== 1 ? "s" : ""} analyzed</span>
          </div>

          ${analysis.themes?.length ? `
          <div class="ai-block">
            <h4 class="ai-block-title">Key Themes</h4>
            <div class="ai-themes">
              ${analysis.themes.map((t) => `
                <div class="ai-theme-row">
                  <div class="ai-theme-bar-wrap">
                    <div class="ai-theme-bar" style="width:${Math.min(t.percentage || 0, 100)}%"></div>
                  </div>
                  <div class="ai-theme-body">
                    <div class="ai-theme-head">
                      <strong>${escHtml(t.name)}</strong>
                      <span class="ai-theme-pct">${t.count} deal${t.count !== 1 ? "s" : ""} · ${t.percentage || 0}%</span>
                    </div>
                    <p class="ai-theme-desc">${escHtml(t.description || "")}</p>
                    ${t.examples?.length ? `<div class="ai-theme-quotes">${t.examples.slice(0, 2).map((q) => `<span class="ai-quote">"${escHtml(q)}"</span>`).join("")}</div>` : ""}
                  </div>
                </div>
              `).join("")}
            </div>
          </div>` : ""}

          ${analysis.trends?.length ? `
          <div class="ai-block">
            <h4 class="ai-block-title">Trends</h4>
            <ul class="ai-trend-list">
              ${analysis.trends.map((t) => `<li>${escHtml(t)}</li>`).join("")}
            </ul>
          </div>` : ""}

          ${analysis.recommendations?.length ? `
          <div class="ai-block">
            <h4 class="ai-block-title">Recommendations</h4>
            <div class="ai-recs">
              ${analysis.recommendations.map((r) => `
                <div class="ai-rec-row">
                  <span class="ai-rec-badge" style="color:${priColor(r.priority)};background:${priBg(r.priority)}">${r.priority}</span>
                  <div class="ai-rec-body">
                    <strong>${escHtml(r.title)}</strong>
                    <p>${escHtml(r.detail)}</p>
                  </div>
                </div>
              `).join("")}
            </div>
          </div>` : ""}
        </div>`;
    } catch (err) {
      body.innerHTML = `<p class="ai-insights-placeholder" style="color:var(--danger)">${escHtml(err.message || "Analysis failed. Check that ANTHROPIC_API_KEY is set on the server.")}</p>`;
    } finally {
      runBtn.disabled = false;
      runBtn.innerHTML = `<svg width="13" height="13" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polygon points="5 3 19 12 5 21 5 3"/></svg> Analyze`;
    }
  });
}

function renderMasterData(paymentTerms) {
  const termOptions = paymentTerms
    .map((term) => `<option value="${term.id}">${term.code} - ${term.name}</option>`)
    .join("");
  const paymentTermFieldDefinitions = getCustomFieldDefinitions("payment-terms");
  const itemFieldDefinitions = getCustomFieldDefinitions("items");
  const isAdmin = state.user?.role === "ADMIN";
  const exportBtn = (id) => isAdmin ? `
    <div style="margin-left:auto;display:inline-flex">
      <button class="ghost export-btn" data-export="${id}" data-format="xlsx" style="font-size:0.8rem;border-right:none;border-radius:var(--r) 0 0 var(--r);padding-right:var(--sp-2)">↓ Excel</button>
      <button class="ghost export-chevron" data-export="${id}" style="font-size:0.8rem;border-radius:0 var(--r) var(--r) 0;padding:0 var(--sp-2)" aria-label="More export formats">▾</button>
    </div>` : "";

  views.master.innerHTML = `
    <div class="master-outer">
    <div class="master-tabs">
      <button class="master-page-btn ${state.masterPage === "customers" ? "active-master-btn" : ""}" data-page="customers">🏢 Customers</button>
      <button class="master-page-btn ${state.masterPage === "items" ? "active-master-btn" : ""}" data-page="items">📦 Items</button>
      <button class="master-page-btn ${state.masterPage === "payment-terms" ? "active-master-btn" : ""}" data-page="payment-terms">💳 Payment Terms</button>
    </div>

    <section class="card" ${state.masterPage !== "payment-terms" ? 'style="display:none"' : ""}>
      <div style="display:flex;align-items:center;margin-bottom:var(--sp-4)">
        <h3 class="section-title" style="margin:0">Payment Terms</h3>
        ${exportBtn("payment-terms")}
      </div>
      <form id="payment-term-form" class="mini-form">
        <input name="code" placeholder="Code (e.g. NET45)" required />
        <input name="name" placeholder="Name" required />
        <input name="dueDays" type="number" min="0" placeholder="Due days" required />
        ${renderCustomFieldInputs(paymentTermFieldDefinitions)}
        <button type="submit">Create Payment Term</button>
      </form>
      <h4>Custom Fields</h4>
      <form class="mini-form custom-field-def-form" data-entity="payment-term">
        <input name="fieldKey" placeholder="fieldKey (e.g. collectionMethod)" required />
        <input name="label" placeholder="Label" required />
        <select name="dataType" required>
          <option value="TEXT">Text</option>
          <option value="NUMBER">Number</option>
          <option value="BOOLEAN">Boolean</option>
          <option value="DATE">Date</option>
          <option value="SELECT">Select</option>
        </select>
        <input name="options" placeholder="Select options (comma separated)" />
        <input name="displayOrder" type="number" min="0" placeholder="Display order" />
        <label><input name="isRequired" type="checkbox" /> Required</label>
        <button type="submit">Add Field</button>
      </form>
      <div class="list">${renderCustomFieldDefinitionRows("payment-terms")}</div>
      <div class="list">
        ${paymentTerms
          .map(
            (p) => `
          <div class="row">
            <h4>${p.name} (${p.code})</h4>
            <div class="muted">Due ${p.dueDays} days</div>
            <div class="chip ${p.isActive ? "chip-success" : "chip-danger"}">${p.isActive ? "Active" : "Inactive"}</div>
            ${renderCustomFieldsSummary(p.customFields)}
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
        ${exportBtn("customers")}
      </div>
      <div id="cust-list-mount"></div>
    </section>
    <section class="card" ${state.masterPage !== "items" ? 'style="display:none"' : ""}>
      <div style="display:flex;align-items:center;margin-bottom:var(--sp-4)">
        <h3 class="section-title" style="margin:0">Items</h3>
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
      <h4>Custom Fields</h4>
      <form class="mini-form custom-field-def-form" data-entity="item">
        <input name="fieldKey" placeholder="fieldKey (e.g. warrantyMonths)" required />
        <input name="label" placeholder="Label" required />
        <select name="dataType" required>
          <option value="TEXT">Text</option>
          <option value="NUMBER">Number</option>
          <option value="BOOLEAN">Boolean</option>
          <option value="DATE">Date</option>
          <option value="SELECT">Select</option>
        </select>
        <input name="options" placeholder="Select options (comma separated)" />
        <input name="displayOrder" type="number" min="0" placeholder="Display order" />
        <label><input name="isRequired" type="checkbox" /> Required</label>
        <button type="submit">Add Field</button>
      </form>
      <div class="list">${renderCustomFieldDefinitionRows("items")}</div>
      <div class="list" id="item-list"></div>
    </section>
    </div>
  `;

  const custMount = views.master.querySelector("#cust-list-mount");
  if (custMount) renderCustomerListSection(custMount, termOptions);

  const itemList = qs("#item-list");
  itemList.innerHTML = state.cache.items
    .map(
      (item) => `
    <div class="row">
      <h4>${item.name} (${item.itemCode})</h4>
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

  views.master.querySelectorAll(".custom-field-def-form").forEach((form) => {
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      const entity = form.dataset.entity;
      if (!entity) return;
      const formData = new FormData(event.currentTarget);
      const options = String(formData.get("options") || "")
        .split(",")
        .map((option) => option.trim())
        .filter(Boolean);
      const payload = {
        fieldKey: String(formData.get("fieldKey") || ""),
        label: String(formData.get("label") || ""),
        dataType: String(formData.get("dataType") || "TEXT"),
        isRequired: formData.get("isRequired") === "on",
        displayOrder: Number(formData.get("displayOrder") || 0),
        options
      };
      if (!options.length) delete payload.options;
      try {
        await api(`/custom-fields/${entity}`, {
          method: "POST",
          body: payload
        });
        setStatus("Custom field created.");
        await loadMaster();
      } catch (error) {
        setStatus(error.message, true);
      }
    });
  });

  views.master.querySelectorAll(".custom-field-toggle").forEach((btn) => {
    btn.addEventListener("click", async () => {
      try {
        await api(`/custom-fields/${btn.dataset.entity}/${btn.dataset.id}`, {
          method: "PATCH",
          body: { isActive: btn.dataset.active !== "true" }
        });
        setStatus("Custom field updated.");
        await loadMaster();
      } catch (error) {
        setStatus(error.message, true);
      }
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
  const urgencyIcon = isOverdue ? "🔥" : (followUp && followUp >= today && followUp < tomorrow) ? "⚡" : "📅";
  const followUpText = followUp
    ? followUp.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" })
    : "—";

  // value tier badge
  const v = deal.estimatedValue || 0;
  const tierBadge = v >= 100000
    ? `<span class="deal-tier deal-tier--diamond" title="Big deal">💎</span>`
    : v >= 10000
    ? `<span class="deal-tier deal-tier--star" title="Mid deal">⭐</span>`
    : "";

  // stage progress bar (skip for closed)
  const openStages = kanban.stages.filter(s => !s.isClosedWon && !s.isClosedLost);
  const openIdx = openStages.findIndex(s => s.id === deal.stageId);
  const stageProgressPct = !isClosed && openStages.length > 1
    ? Math.round((openIdx / (openStages.length - 1)) * 100)
    : null;

  // won/lost banner
  const closedBanner = deal.status === "WON"
    ? `<div class="deal-closed-banner deal-closed-banner--won">🏆 Deal Won!</div>`
    : deal.status === "LOST"
    ? `<div class="deal-closed-banner deal-closed-banner--lost">💔 Deal Lost</div>`
    : "";

  const customerInitial = (deal.customer?.name || "?")[0].toUpperCase();
  const stageOptions = kanban.stages
    .map((s) => `<option value="${s.id}" ${s.id === deal.stageId ? "selected" : ""}>${s.stageName}</option>`)
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
        <span class="deal-assignee">👤 ${escHtml(deal.owner?.fullName || "Unassigned")}</span>
        <button class="deal-detail-btn" data-id="${deal.id}" data-no="${escHtml(deal.dealNo)}" title="Open deal detail">
          <svg width="11" height="11" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>
        </button>
      </div>
      <div class="deal-card-actions">
        <select class="deal-stage-select" data-id="${deal.id}">${stageOptions}</select>
        <button class="deal-stage-save" data-id="${deal.id}">Move</button>
        <button type="button" class="voice-note-btn ghost" data-entity-type="DEAL" data-entity-id="${deal.id}" title="Voice note">🎙</button>
      </div>
      ${stageProgressPct !== null ? `<div class="deal-stage-progress"><span style="width:${stageProgressPct}%"></span></div>` : ""}
    </div>
  `;
}

function openDealCreateModal(kanban) {
  const modal = qs("#deal-create-modal");
  if (!modal) return;
  const stageOptions = kanban.stages
    .map((s) => `<option value="${s.id}">${s.stageName}</option>`).join("");
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
                  <h3>${stage.stageName}</h3>
                  <span class="kanban-col-count">${stage.deals.length}</span>
                </div>
                <div class="kanban-col-value">${asMoney(colValue)}</div>
              </div>
              <div class="kanban-cards">
                ${
                  stage.deals.length
                    ? stage.deals.map((deal) => renderDealCard(deal, kanban)).join("")
                    : `<div class="empty-state compact"><div class="empty-icon">🗃️</div><div><strong>${hasFilter ? "No matches" : "No deals"}</strong></div></div>`
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
        <h2 class="deals-title">🤝 Deal Pipeline</h2>
        <button class="deals-create-btn" id="deals-create-btn">
          ✨ New Deal
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
          Overdue follow-ups${suspicious ? " ✓" : ""}
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
        <div class="mt-card-type mt-type--visit">📍 Visit</div>
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
        <div class="mt-card-type mt-type--deal">💼 Deal</div>
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
          ${closeToday ? `<div class="mt-close-today-hint">🎯 Target close today</div>` : ""}
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
  const greeting = hour < 12 ? "Good morning ☀️" : hour < 17 ? "Good afternoon 🌤️" : hour < 21 ? "Good evening 🌙" : "Burning the midnight oil 🌟";
  const todayLabel = now.toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long" });

  views.repHub.innerHTML = `
    <div class="mt-page">
      <div class="mt-page-head">
        <div>
          <div class="mt-page-title-row">
            <h2 class="mt-page-title">📋 My Tasks</h2>
            ${total ? `<span class="mt-total-badge">${total}</span>` : ""}
          </div>
          <div class="mt-page-greeting">${greeting} — ${todayLabel}</div>
        </div>
        <div class="mt-page-actions">
          <button class="ghost topnav-icon-btn" id="mt-refresh" title="Refresh">
            <svg width="15" height="15" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M23 4v6h-6"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg>
          </button>
          <button class="primary" id="mt-new-visit">📍 Plan Visit</button>
          <button class="ghost" id="mt-new-deal">💼 Add Deal</button>
        </div>
      </div>

      ${!total && !inProgress.length ? `
        <div class="empty-state" style="margin-top:var(--sp-8)">
          <div style="font-size:3rem;line-height:1;margin-bottom:var(--sp-2)">🎉</div>
          <div><strong>All clear — you're crushing it!</strong><p>No tasks due today or coming up.</p></div>
        </div>` : `

        ${section("📍 Meeting In-Progress", inProgress, "mt-section--inprogress")}
        ${section("⚠️ Need Follow-Up", overdue, "mt-section--overdue", { overdue: true })}
        ${section("☀️ Today", today, "mt-section--today")}
        ${section("🌅 Tomorrow", tomorrow, "mt-section--tomorrow")}
        ${section("📅 Next 7 Days", nextWeek, "mt-section--nextweek")}
        ${section("🗓️ Next 30 Days", nextMonth, "mt-section--nextmonth")}
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
          <button class="ced-close" id="mt-checkin-close" aria-label="Close">✕</button>
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
          <button class="ced-close" id="mt-checkout-close" aria-label="Close">✕</button>
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
    voiceNoteState.onClose = () => { modal.style.display = ""; };
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
      <p class="vd-section-title">🏢 Customer</p>
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
      <p class="vd-section-title">🤝 Related Deal</p>
      <div class="vd-deal-card">
        <div class="vd-deal-no">${escHtml(visit.deal.dealNo)}</div>
        <div class="vd-deal-name">${escHtml(visit.deal.dealName)}</div>
        ${visit.deal.stage ? `<div class="vd-deal-stage">${escHtml(visit.deal.stage.stageName)}</div>` : ""}
      </div>
    </div>` : "";

  // ── Timing ──────────────────────────────────────────────────────────────────
  const timingHtml = `
    <div class="vd-section">
      <p class="vd-section-title">⏰ Timing</p>
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
      <p class="vd-section-title">🎯 Expected Result</p>
      <div class="vd-result-block ${visit.objective ? "" : "empty"}">${visit.objective ? escHtml(visit.objective) : "No objective recorded."}</div>
    </div>`;

  // ── Actual Result ────────────────────────────────────────────────────────────
  const resultHtml = `
    <div class="vd-section">
      <p class="vd-section-title">✅ Actual Result</p>
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
      : `<div class="vd-map-fallback">📍 ${lat.toFixed(5)}, ${lng.toFixed(5)}</div>`;
    locationHtml = `
      <div class="vd-section">
        <p class="vd-section-title">📍 Location</p>
        ${mapHtml}
        <a class="vd-directions-btn" href="${dirUrl}" target="_blank" rel="noopener">
          Get Directions
        </a>
      </div>`;
  } else if (addrText) {
    const dirUrl = `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(addrText)}`;
    locationHtml = `
      <div class="vd-section">
        <p class="vd-section-title">📍 Location</p>
        <div class="vd-map-fallback">📍 ${escHtml(addrText)}</div>
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
        <p class="vd-section-title">📝 Change History</p>
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
        <p class="vd-section-title">🎙️ Voice Notes</p>
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

function renderVisits(visits) {
  const f         = state.visitPage;
  const isAdmin   = state.user?.role === "ADMIN";
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
      <h3 class="visits-title">📍 Visits</h3>
      <button type="button" id="add-visit-btn">
        📍 Plan Visit
      </button>
    </div>

    <div class="vp-stats-bar">
      <div class="vp-stat"><span class="vp-stat-value">${total}</span><span class="vp-stat-label">📋 Total</span></div>
      <div class="vp-stat"><span class="vp-stat-value">${planned}</span><span class="vp-stat-label">🗓️ Planned</span></div>
      <div class="vp-stat vp-stat--active"><span class="vp-stat-value">${active}</span><span class="vp-stat-label">🔥 Active</span></div>
      <div class="vp-stat vp-stat--done"><span class="vp-stat-value">${done}</span><span class="vp-stat-label">✅ Done</span></div>
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

  // Status chips — toggle (click active to clear)
  views.visits.querySelectorAll("[data-vp-status]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      state.visitPage.status = state.visitPage.status === btn.dataset.vpStatus ? "" : btn.dataset.vpStatus;
      await loadVisits();
    });
  });

  // Text search — repaint list only
  qs("#vp-search")?.addEventListener("input", (e) => {
    state.visitPage.query = e.target.value;
    const container = qs("#vp-list-container");
    if (container) {
      container.innerHTML = buildVisitListHtml(state.cache.visits, e.target.value.toLowerCase(), state.visitPage.status);
      attachVisitListListeners(container);
    }
  });

  // Date range
  qs("#vp-date-from")?.addEventListener("change", async (e) => { state.visitPage.dateFrom = e.target.value; await loadVisits(); });
  qs("#vp-date-to")?.addEventListener("change",   async (e) => { state.visitPage.dateTo   = e.target.value; await loadVisits(); });

  // Rep multiselect
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

function openVisitCreateModal(dateTime) {
  const modal = qs("#visit-create-modal");
  if (!modal) return;
  // Reset customer autocomplete
  const inp = modal.querySelector("#visit-customer-input");
  const hid = modal.querySelector("#visit-customer-id");
  const lst = modal.querySelector("#visit-customer-list");
  if (inp) inp.value = "";
  if (hid) hid.value = "";
  if (lst) lst.hidden = true;
  // Reset deal field
  const dealLabel  = modal.querySelector("#visit-deal-label");
  const dealSelect = modal.querySelector("#visit-deal-select");
  if (dealLabel)  dealLabel.hidden = true;
  if (dealSelect) dealSelect.innerHTML = `<option value="">— No deal —</option>`;
  // Pre-fill plannedAt: use provided dateTime or default to now rounded to nearest minute
  const now = new Date();
  now.setSeconds(0, 0);
  const nowLocal = new Date(now.getTime() - now.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
  const base = dateTime ? new Date(dateTime) : new Date();
  base.setSeconds(0, 0);
  const local = new Date(base.getTime() - base.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
  const plannedAtInput = modal.querySelector("#visit-planned-at");
  plannedAtInput.min   = nowLocal;
  plannedAtInput.value = local < nowLocal ? nowLocal : local;
  // Reset location field
  const siteLat = modal.querySelector("#visit-site-lat");
  const siteLng = modal.querySelector("#visit-site-lng");
  const locPreview = modal.querySelector("#visit-location-preview");
  const pickBtn = modal.querySelector("#visit-pick-location-btn");
  if (siteLat) siteLat.value = "";
  if (siteLng) siteLng.value = "";
  if (locPreview) locPreview.hidden = true;
  if (pickBtn) pickBtn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/></svg> Pick on Map`;
  // Reset visit type to PLANNED and sync required state
  const plannedRadio = modal.querySelector('[name="visitType"][value="PLANNED"]');
  if (plannedRadio) plannedRadio.checked = true;
  syncVisitPlannedAtRequired(modal);
  modal.querySelector("#visit-form")?.reset && false; // intentional: keep defaults above
  modal.hidden = false;
}

function closeVisitCreateModal() {
  const modal = qs("#visit-create-modal");
  if (modal) modal.hidden = true;
}

// ── Visit Edit Modal ──────────────────────────────────────────────────────────

function openVisitEditModal(visit) {
  const modal = qs("#visit-edit-modal");
  if (!modal) return;
  qs("#visit-edit-id").value = visit.id;
  // Pre-fill plannedAt in local time
  if (visit.plannedAt) {
    const d = new Date(visit.plannedAt);
    const local = new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
    qs("#visit-edit-planned-at").value = local;
  } else {
    qs("#visit-edit-planned-at").value = "";
  }
  qs("#visit-edit-objective").value = visit.objective || "";
  // Pre-fill location
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

function closeVisitEditModal() {
  const modal = qs("#visit-edit-modal");
  if (modal) modal.hidden = true;
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

function syncVisitPlannedAtRequired(modal) {
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

function showEventDetail(ev, anchorEl) {
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

  // Compute stage accent var by finding the stage's non-terminal index in the cache
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
    ev.customer ? `<div class="ced-row"><span class="ced-label">Customer</span><span class="ced-value">${ev.customer.name}</span></div>` : "",
    ev.owner    ? `<div class="ced-row"><span class="ced-label">${ev.type === "deal" ? "Owner" : "Sales Rep"}</span><span class="ced-value">${ev.owner.name}</span></div>` : "",
    ev.stage && stageAccent ? `<div class="ced-row"><span class="ced-label">Stage</span><span class="ced-value"><span class="ced-stage-badge" style="--sa:var(${stageAccent})">${ev.stage.name}</span></span></div>` : "",
    statusLabel ? `<div class="ced-row"><span class="ced-label">Status</span><span class="ced-value"><span class="ced-status ced-status--${statusColor}">${statusLabel}</span></span></div>` : "",
  ].filter(Boolean).join("");

  document.body.insertAdjacentHTML("beforeend", `
    <div id="cal-event-popover" class="cal-event-popover">
      <div class="ced-header">
        <span class="ced-type-badge ced-type--${ev.type}">${typeLabel}</span>
        <span class="ced-title">${titleCore}</span>
        <button class="ced-close" id="ced-close-btn" aria-label="Close">✕</button>
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

// Visit create modal events (wired once at module level below)
function renderCalendar(calendarData) {
  const filters = state.calendarFilters;
  const events = Array.isArray(calendarData?.events) ? calendarData.events : [];
  const view = filters.view || "month";

  // Group events by local date key "YYYY-MM-DD"
  const eventsByDate = {};
  events.forEach((ev) => {
    const d = new Date(ev.at);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    if (!eventsByDate[key]) eventsByDate[key] = [];
    eventsByDate[key].push(ev);
  });

  const anchor = new Date(filters.anchorDate || new Date().toISOString());
  const year = anchor.getFullYear();
  const month = anchor.getMonth();
  const todayStr = (() => {
    const t = new Date();
    return `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, "0")}-${String(t.getDate()).padStart(2, "0")}`;
  })();

  const MONTH_NAMES = ["January","February","March","April","May","June","July","August","September","October","November","December"];

  function eventChip(ev, compact = false) {
    const label = ev.title || ev.customer?.name || "Event";
    return `<div class="cal-event cal-event--${ev.color || "blue"}" data-event-id="${ev.id}" title="${label}${ev.customer?.name ? " · " + ev.customer.name : ""}">
      ${compact ? "" : `<span class="cal-event-dot"></span>`}
      <span class="cal-event-label">${label}</span>
    </div>`;
  }

  function renderMonthView() {
    const firstDay = new Date(year, month, 1);
    const lastDate = new Date(year, month + 1, 0).getDate();
    const startOffset = (firstDay.getDay() + 6) % 7; // Mon=0
    const cells = [];
    for (let i = 0; i < startOffset; i++) cells.push(null);
    for (let d = 1; d <= lastDate; d++) cells.push(d);
    while (cells.length % 7 !== 0) cells.push(null);

    return `
      <div class="cal-month">
        <div class="cal-weekdays">
          ${["Mon","Tue","Wed","Thu","Fri","Sat","Sun"].map((d) => `<div class="cal-weekday">${d}</div>`).join("")}
        </div>
        <div class="cal-grid">
          ${cells.map((day) => {
            if (!day) return `<div class="cal-day cal-day--empty"></div>`;
            const dateKey = `${year}-${String(month + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
            const dayEvs = eventsByDate[dateKey] || [];
            const isToday = dateKey === todayStr;
            const maxShow = 3;
            const overflow = Math.max(0, dayEvs.length - maxShow);
            return `
              <div class="cal-day${isToday ? " cal-day--today" : ""}${dayEvs.length ? " cal-day--has-events" : ""}" data-date="${dateKey}">
                <span class="cal-day-num">${day}</span>
                <div class="cal-event-list">
                  ${dayEvs.slice(0, maxShow).map((e) => eventChip(e)).join("")}
                  ${overflow ? `<div class="cal-overflow">+${overflow} more</div>` : ""}
                </div>
              </div>
            `;
          }).join("")}
        </div>
      </div>
    `;
  }

  function renderDayView() {
    const dayKey = `${anchor.getFullYear()}-${String(anchor.getMonth() + 1).padStart(2, "0")}-${String(anchor.getDate()).padStart(2, "0")}`;
    const dayEvs = eventsByDate[dayKey] || [];
    const dayLabel = anchor.toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long", year: "numeric" });

    // Group by hour
    const byHour = {};
    dayEvs.forEach((ev) => {
      const h = new Date(ev.at).getHours();
      if (!byHour[h]) byHour[h] = [];
      byHour[h].push(ev);
    });

    const hours = Array.from({ length: 24 }, (_, i) => i);
    return `
      <div class="cal-day-view">
        <div class="cal-day-header">${dayLabel}
          ${dayEvs.length ? `<span class="cal-day-count">${dayEvs.length} event${dayEvs.length !== 1 ? "s" : ""}</span>` : ""}
        </div>
        <div class="cal-timeline">
          ${hours.map((h) => {
            const evs = byHour[h] || [];
            const timeLabel = `${String(h).padStart(2, "0")}:00`;
            return `
              <div class="cal-hour-slot${evs.length ? " cal-hour-slot--has-events" : ""}" data-date="${dayKey}" data-hour="${h}">
                <div class="cal-hour-label">${timeLabel}</div>
                <div class="cal-hour-events">
                  ${evs.map((ev) => `
                    <div class="cal-tl-event cal-event--${ev.color || "blue"}" data-event-id="${ev.id}">
                      <span class="cal-tl-title">${ev.title}</span>
                      ${ev.customer?.name ? `<span class="cal-tl-meta">${ev.customer.name}</span>` : ""}
                      ${ev.status ? `<span class="cal-tl-badge">${ev.status}</span>` : ""}
                    </div>
                  `).join("")}
                </div>
              </div>
            `;
          }).join("")}
        </div>
        ${!dayEvs.length ? `<div class="empty-state"><div class="empty-icon">🗓️</div><div><strong>No events on this day</strong><p class="muted">Use the arrows to navigate or switch to Month view.</p></div></div>` : ""}
      </div>
    `;
  }

  function renderYearView() {
    return `
      <div class="cal-year-view">
        ${MONTH_NAMES.map((mName, mIdx) => {
          const firstDay = new Date(year, mIdx, 1);
          const lastDate = new Date(year, mIdx + 1, 0).getDate();
          const startOffset = (firstDay.getDay() + 6) % 7;
          const cells = [];
          for (let i = 0; i < startOffset; i++) cells.push(null);
          for (let d = 1; d <= lastDate; d++) cells.push(d);
          while (cells.length % 7 !== 0) cells.push(null);

          return `
            <div class="cal-mini-month">
              <div class="cal-mini-title">${mName}</div>
              <div class="cal-mini-weekdays">
                ${["M","T","W","T","F","S","S"].map((d) => `<span>${d}</span>`).join("")}
              </div>
              <div class="cal-mini-grid">
                ${cells.map((day) => {
                  if (!day) return `<span class="cal-mini-day cal-mini-day--empty"></span>`;
                  const dateKey = `${year}-${String(mIdx + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
                  const hasEvents = (eventsByDate[dateKey] || []).length > 0;
                  const isToday = dateKey === todayStr;
                  return `<span class="cal-mini-day${isToday ? " cal-mini-day--today" : ""}${hasEvents ? " cal-mini-day--dot" : ""}">${day}</span>`;
                }).join("")}
              </div>
            </div>
          `;
        }).join("")}
      </div>
    `;
  }

  const navTitle = view === "month"
    ? `${MONTH_NAMES[month]} ${year}`
    : view === "day"
      ? anchor.toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" })
      : `${year}`;

  views.calendar.innerHTML = `
    <div class="calendar-outer">
      <div class="cal-toolbar">
        <div class="cal-toolbar-main">
          <div class="cal-nav-group">
            <button class="cal-nav-btn" id="calendar-prev">‹</button>
            <h2 class="cal-nav-title">${navTitle}</h2>
            <button class="cal-nav-btn" id="calendar-next">›</button>
          </div>
          <div class="cal-view-tabs">
            <button class="cal-view-tab${view === "month" ? " active" : ""}" data-view="month">Month</button>
            <button class="cal-view-tab${view === "day" ? " active" : ""}" data-view="day">Day</button>
            <button class="cal-view-tab${view === "year" ? " active" : ""}" data-view="year">Year</button>
          </div>
          <button class="cal-filter-toggle ghost" id="cal-filter-toggle">
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true"><path d="M2 3h10M4 7h6M6 11h2" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>
            Filters${events.length ? ` · ${events.length}` : ""}
          </button>
        </div>
        <div class="cal-filter-bar" id="cal-filter-bar" hidden>
          <form id="calendar-filter-form" class="cal-filter-grid">
            ${(() => {

              // ── Events ───────────────────────────────────────────────────
              const eventsHtml = msDropdown({
                id: "cal-events", fieldName: "eventTypes",
                options: [{ value: "visit", label: "Visit" }, { value: "deal", label: "Deal" }],
                selected: filters.eventTypes || [], allLabel: "All Events", singularUnit: "event"
              });

              // ── Sales Rep ─────────────────────────────────────────────────
              const calReps = state.cache.salesReps || [];
              const calCanFilterReps = state.user?.role !== "REP" && calReps.length > 0;
              const ownerOptions = calReps.map(u => ({ value: u.id, label: u.fullName || u.id }));
              const ownerHtml = calCanFilterReps ? msDropdown({
                id: "cal-owner", fieldName: "ownerIds",
                options: ownerOptions, selected: filters.ownerIds || [],
                allLabel: "All Sales Reps", singularUnit: "rep"
              }) : "";

              // ── Status ────────────────────────────────────────────────────
              const statusHtml = msDropdown({
                id: "cal-status", fieldName: "visitStatuses",
                options: [
                  { value: "PLANNED",      label: "Planned" },
                  { value: "CHECKED_IN",   label: "Checked-in" },
                  { value: "CHECKED_OUT",  label: "Checked-out" }
                ],
                selected: filters.visitStatuses || [], allLabel: "All Statuses", singularUnit: "status"
              });

              // ── Stage ─────────────────────────────────────────────────────
              const stageOptions = (state.cache.dealStages || []).map(s => ({ value: s.id, label: s.stageName }));
              const stageHtml = stageOptions.length ? msDropdown({
                id: "cal-stage", fieldName: "dealStageIds",
                options: stageOptions, selected: filters.dealStageIds || [],
                allLabel: "All Stages", singularUnit: "stage"
              }) : "";

              return `
            <div class="cal-filter-field">
              <span class="cal-filter-label">Events</span>
              ${eventsHtml}
            </div>

            <div class="cal-filter-field">
              <span class="cal-filter-label">Customer</span>
              <div class="cal-autocomplete" id="cal-customer-wrap">
                <input class="cal-autocomplete-input" id="cal-customer-input" type="text"
                  placeholder="Name or code…" autocomplete="off"
                  value="${filters.customerName || ""}" />
                <button type="button" class="cal-autocomplete-clear" id="cal-customer-clear"
                  ${filters.customerId ? "" : "hidden"} aria-label="Clear customer">✕</button>
                <div class="cal-autocomplete-list" id="cal-customer-list" hidden></div>
                <input type="hidden" name="customerId" id="cal-customer-id" value="${filters.customerId || ""}" />
              </div>
            </div>

            ${calCanFilterReps ? `
            <div class="cal-filter-field">
              <span class="cal-filter-label">Sales Rep</span>
              ${ownerHtml}
            </div>` : ""}

            <div class="cal-filter-field">
              <span class="cal-filter-label">Status</span>
              ${statusHtml}
            </div>

            ${stageOptions.length ? `
            <div class="cal-filter-field">
              <span class="cal-filter-label">Stage</span>
              ${stageHtml}
            </div>` : ""}`;
            })()}

            <div class="cal-filter-actions">
              <button type="submit" class="cal-filter-apply">Apply</button>
              <button type="button" id="cal-filter-reset" class="cal-filter-reset">Reset</button>
            </div>
          </form>
        </div>
      </div>

      <div class="cal-legend">
        <span class="cal-legend-item cal-event--blue">Visit</span>
        <span class="cal-legend-item cal-event--green">Checked-out</span>
        <span class="cal-legend-item cal-event--yellow">Checked-in</span>
        <span class="cal-legend-item cal-event--purple">Deal</span>
        <span class="cal-legend-item cal-event--red">Overdue</span>
      </div>

      ${view === "month" ? renderMonthView() : view === "day" ? renderDayView() : renderYearView()}
    </div>
  `;

  // filter toggle
  qs("#cal-filter-toggle")?.addEventListener("click", () => {
    const bar = qs("#cal-filter-bar");
    if (bar) bar.hidden = !bar.hidden;
  });

  // ── Click-to-create visit ────────────────────────────────────────────────
  // Month view: click a day cell → open modal at 09:00 that day
  views.calendar.querySelectorAll(".cal-day[data-date]").forEach((cell) => {
    cell.addEventListener("click", (e) => {
      if (e.target.closest(".cal-event, .cal-overflow")) return; // ignore event chip clicks
      const dateTime = new Date(cell.dataset.date + "T09:00:00");
      openVisitCreateModal(dateTime);
    });
  });

  // Day view: click an hour slot → open modal at that hour
  views.calendar.querySelectorAll(".cal-hour-slot[data-date]").forEach((slot) => {
    slot.addEventListener("click", (e) => {
      if (e.target.closest(".cal-tl-event")) return; // ignore event clicks
      const dateTime = new Date(`${slot.dataset.date}T${String(slot.dataset.hour).padStart(2, "0")}:00:00`);
      openVisitCreateModal(dateTime);
    });
  });

  // ── Event chip click → show detail popover ──────────────────────────────
  const eventsMap = new Map(events.map((e) => [e.id, e]));
  views.calendar.querySelectorAll("[data-event-id]").forEach((chip) => {
    chip.addEventListener("click", (e) => {
      e.stopPropagation();
      const ev = eventsMap.get(chip.dataset.eventId);
      if (ev) showEventDetail(ev, chip);
    });
  });

  // ── Customer autocomplete ────────────────────────────────────────────────
  const customerInput = qs("#cal-customer-input");
  const customerList  = qs("#cal-customer-list");
  const customerIdEl  = qs("#cal-customer-id");
  const customerClear = qs("#cal-customer-clear");

  customerInput?.addEventListener("input", () => {
    const q = customerInput.value.trim().toLowerCase();
    if (!q) { customerList.hidden = true; return; }
    const matches = state.cache.customers.filter(
      (c) => c.name.toLowerCase().includes(q) || (c.customerCode || "").toLowerCase().includes(q)
    ).slice(0, 8);
    if (!matches.length) { customerList.hidden = true; return; }
    customerList.innerHTML = matches.map((c) =>
      `<button type="button" class="cal-autocomplete-item" data-id="${c.id}" data-name="${c.name}">
         <span class="cal-ac-name">${c.name}</span>
         ${c.customerCode ? `<span class="cal-ac-code">${c.customerCode}</span>` : ""}
       </button>`
    ).join("");
    customerList.hidden = false;
  });

  customerList?.addEventListener("click", (e) => {
    const item = e.target.closest(".cal-autocomplete-item");
    if (!item) return;
    customerInput.value = item.dataset.name;
    customerIdEl.value  = item.dataset.id;
    customerList.hidden = true;
    if (customerClear) customerClear.hidden = false;
  });

  customerInput?.addEventListener("blur", () => {
    setTimeout(() => { if (customerList) customerList.hidden = true; }, 150);
  });

  customerClear?.addEventListener("click", () => {
    customerInput.value = "";
    customerIdEl.value  = "";
    customerClear.hidden = true;
  });

  // ── Multiselect dropdowns ────────────────────────────────────────────────
  ["cal-events", "cal-owner", "cal-status", "cal-stage"].forEach((id) => {
    const allLabel = { "cal-events": "All Events", "cal-owner": "All Sales Reps", "cal-status": "All Statuses", "cal-stage": "All Stages" }[id];
    initMsDropdown(id, allLabel);
  });

  // ── Filter form submit ───────────────────────────────────────────────────
  const form = qs("#calendar-filter-form");

  form?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    await loadCalendar({
      eventTypes:    fd.getAll("eventTypes"),
      ownerIds:      fd.getAll("ownerIds"),
      visitStatuses: fd.getAll("visitStatuses"),
      dealStageIds:  fd.getAll("dealStageIds"),
      customerId:    fd.get("customerId") || "",
      customerName:  customerInput?.value.trim() || "",
    });
  });

  qs("#cal-filter-reset")?.addEventListener("click", async () => {
    await loadCalendar({
      eventTypes:    ["visit", "deal"],
      ownerIds:      state.user?.id ? [state.user.id] : [],
      visitStatuses: ["PLANNED", "CHECKED_IN", "CHECKED_OUT"],
      dealStageIds:  [],
      dealStatuses:  ["OPEN"],
      customerId:    "",
      customerName:  "",
    });
  });

  qs("#calendar-prev")?.addEventListener("click", async () => {
    await loadCalendar({ anchorDate: shiftAnchorDate(filters.anchorDate, filters.view, "prev") });
  });

  qs("#calendar-next")?.addEventListener("click", async () => {
    await loadCalendar({ anchorDate: shiftAnchorDate(filters.anchorDate, filters.view, "next") });
  });

  views.calendar.querySelectorAll(".cal-view-tab").forEach((tab) => {
    tab.addEventListener("click", async () => {
      await loadCalendar({ view: tab.dataset.view });
    });
  });
}

function renderIntegrationLogs(logs) {
  views.integrations.innerHTML = `
    <div class="logs-outer">
      <h3 class="section-title">🔌 Integration Logs</h3>
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
            : '<div class="empty-state"><div class="empty-icon">🔌</div><div><strong>No integration logs yet</strong><p>Run a connection test in Settings to generate the first log.</p></div></div>'
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
  const isAdmin = state.user?.role === "ADMIN";
  const isManager = state.user?.role === "MANAGER";
  const branding = state.cache.branding || {};
  const tax = state.cache.taxConfig || { vatEnabled: true, vatRatePercent: 7 };
  const visitCfg = state.cache.visitConfig || { checkInMaxDistanceM: 1000, minVisitDurationMinutes: 15 };
  const tenantThemeMode = branding.themeMode || "LIGHT";
  const integrationCredentials = state.cache.integrationCredentials || [];
  const teams = state.cache.teams || [];
  const allUsers = state.cache.allUsers || [];
  const tenantInfo = state.cache.tenantInfo || {};
  const salesRepOptions = state.cache.salesReps
    .map((rep) => {
      const teamSuffix = rep.team?.teamName ? ` · ${rep.team.teamName}` : "";
      return `<option value="${rep.id}">${rep.fullName}${teamSuffix}</option>`;
    })
    .join("");
  const defaultRepId = state.cache.salesReps[0]?.id || "";

  const role = state.user?.role || "REP";
  const roleRank = { ADMIN: 5, DIRECTOR: 4, MANAGER: 3, SUPERVISOR: 2, REP: 1 };
  const hasRole = (...allowed) => allowed.includes(role);

  const personalNavItems = [
    { page: "my-profile",    label: "My Profile",               emoji: "👤" },
    { page: "notifications", label: "Notifications",            emoji: "🔔" }
  ];

  const allNavItems = [
    { page: "company",        label: "Company Settings",      emoji: "🏢", roles: ["ADMIN"] },
    { page: "branding",       label: "Branding & Theme",      emoji: "🎨", roles: ["ADMIN"] },
    { page: "team-structure", label: "Team Structure",         emoji: "👥", roles: ["ADMIN", "DIRECTOR", "MANAGER", "SUPERVISOR", "REP"] },
    { page: "roles",          label: "Roles & Permissions",   emoji: "🔐", roles: ["ADMIN"] },
    { page: "kpi-targets",    label: "KPI Targets",            emoji: "🎯", roles: ["ADMIN", "DIRECTOR", "MANAGER", "SUPERVISOR", "REP"] },
    { page: "integrations",   label: "Integrations",          emoji: "🔌", roles: ["ADMIN"] },
    { page: "cron-jobs",      label: "Scheduled Jobs",         emoji: "⏱", roles: ["ADMIN"] }
  ];
  const navItems = allNavItems.filter(item => item.roles.includes(role));

  // Redirect to my-profile if current page is not accessible
  const allAllowedPages = [...personalNavItems.map(i => i.page), ...navItems.map(i => i.page)];
  if (!allAllowedPages.includes(page)) {
    state.settingsPage = "my-profile";
    return renderSettings();
  }

  // ── Page content ─────────────────────────────────────────────
  let pageHtml = "";

  if (page === "my-profile") {
    const me = state.user;
    const roleLabels = { ADMIN: "Admin", MANAGER: "Sales Manager", SUPERVISOR: "Supervisor", REP: "Sales Rep" };
    const roleCls    = { ADMIN: "rp-badge--admin", MANAGER: "rp-badge--manager", SUPERVISOR: "rp-badge--supervisor", REP: "rp-badge--rep" };
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
        <h3 class="section-title">👤 Personal Information</h3>
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
        <h3 class="section-title">🔒 Change Password</h3>
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
        provider: "LINE", label: "LINE", icon: "💬",
        hint: "Enter your LINE User ID (get it from your admin or by messaging the LINE OA)",
        placeholder: "e.g. U1a2b3c4d5e6f7890",
        helpHtml: `
          <p class="notif-help-steps" style="list-style:none;padding:0;margin:0 0 var(--sp-2)">
            ⚠️ <strong>หมายเหตุ:</strong> LINE User ID นี้ <em>ไม่ใช่</em> LINE ID (ชื่อผู้ใช้) ที่เห็นในแอป<br>
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
        provider: "MS_TEAMS", label: "Microsoft Teams", icon: "🟦",
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
        provider: "SLACK", label: "Slack", icon: "💼",
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
          <h3 class="section-title">🔔 Notification Channels</h3>
          <p class="muted" style="margin-bottom:var(--sp-4);font-size:0.88rem">Connect a messaging app so the system can send you deal follow-up reminders and visit check-in alerts.</p>
          <div class="notif-channels-list">
            ${channelProviders.map(ch => {
              const info = integrationsByProvider[ch.provider];
              const connected = info?.status === "CONNECTED";
              return `
              <div class="notif-channel-card" data-provider="${ch.provider}">
                <div class="notif-channel-main">
                  <span class="notif-channel-icon">${ch.icon}</span>
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
        <span>⚠️ No notification channel connected. Connect one below to receive alerts.</span>
      </div>` : "";
    const isGroupRole = ["ADMIN", "DIRECTOR", "MANAGER", "SUPERVISOR"].includes(state.user?.role);
    pageHtml = `
      ${channelsSection}
      ${channelWarning}
      <section class="card">
        <h3 class="section-title">👤 Personal Notifications</h3>
        <p class="muted" style="font-size:0.85rem;margin-bottom:var(--sp-3)">Sent directly to you via your connected channel.</p>
        <div class="notif-group">
          ${toggle("dealFollowUp", "Follow-up deal reminder",   "Remind me before a deal follow-up date is due")}
          ${toggle("visitRemind",  "Check-in reminder",         "Remind me when I have a visit scheduled for check-in")}
          ${toggle("kpiAlert",     "🎯 KPI Alert",              "แจ้งเตือนประจำวัน 5 วันสุดท้ายของเดือน หากคืบหน้าต่ำกว่า 85% (ส่งส่วนตัว หรือกลุ่มหากไม่มีช่องส่วนตัว)")}
          ${toggle("weeklyDigest", "📊 Weekly Digest",          "สรุปผลงานทุกวันจันทร์ 06:00 น. ส่งเข้าช่องกลุ่มของทีม")}
        </div>
      </section>

      ${isGroupRole ? `
      <section class="card">
        <h3 class="section-title">👥 Group Notifications</h3>
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
    `;
  } else if (page === "branding") {
    pageHtml = `
      <section class="card">
        <h3 class="section-title">🎨 Logo &amp; Colors</h3>
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
          <div class="settings-field-row">
            <label class="form-label">Primary Color
              <div class="color-input-row">
                <input type="color" name="primaryColorPicker" value="${branding.primaryColor || "#7c3aed"}" class="color-swatch" />
                <input class="form-input" name="primaryColor" placeholder="#7c3aed" value="${branding.primaryColor || "#7c3aed"}" required style="flex:1" />
              </div>
            </label>
            <label class="form-label">Secondary Color
              <div class="color-input-row">
                <input type="color" name="secondaryColorPicker" value="${branding.secondaryColor || "#0f172a"}" class="color-swatch" />
                <input class="form-input" name="secondaryColor" placeholder="#0f172a" value="${branding.secondaryColor || "#0f172a"}" required style="flex:1" />
              </div>
            </label>
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
          <button type="submit">Save Branding</button>
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
        <div class="org-node-name">${m.fullName || "—"}</div>
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
    const channelTypeIcon  = { LINE: "💬", SLACK: "#", EMAIL: "✉️", MS_TEAMS: "🟦" };

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
            <span class="org-team-name">${team.teamName}</span>
            <span class="chip ${team.isActive ? "chip-success" : ""}" style="font-size:0.7rem;padding:1px 6px">${team.isActive ? "Active" : "Inactive"}</span>
          </div>
          ${isAdmin ? `<div class="org-team-actions">
            <button class="ghost small team-rename-btn" data-team-id="${team.id}" data-team-name="${team.teamName}">Rename</button>
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
            <div class="org-node-name">${director.fullName}</div>
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
        : `<div class="empty-state compact"><div class="empty-icon">👥</div><div><strong>No teams yet</strong>${isAdmin ? `<p>Click "+ Create Team" to get started.</p>` : ""}</div></div>`}
    `;
  } else if (page === "roles") {
    const me = state.user;
    const roleLabel = { ADMIN: "Admin", MANAGER: "Sales Manager", SUPERVISOR: "Supervisor", REP: "Sales Rep" };
    const roleCls   = { ADMIN: "rp-badge--admin", MANAGER: "rp-badge--manager", SUPERVISOR: "rp-badge--supervisor", REP: "rp-badge--rep" };
    const roleCounts = { ADMIN: 0, MANAGER: 0, SUPERVISOR: 0, REP: 0 };
    for (const u of allUsers) if (u.role in roleCounts) roleCounts[u.role]++;

    // Build manager options for each role (Reports To)
    const managers    = allUsers.filter(u => u.role === "MANAGER");
    const supervisors = allUsers.filter(u => u.role === "SUPERVISOR");

    function reportsToOptions(u) {
      if (u.role === "ADMIN" || u.role === "MANAGER") return '<span class="rp-dash">—</span>';
      const pool   = u.role === "SUPERVISOR" ? managers : supervisors;
      const cur    = u.managerUserId || "";
      const opts   = pool.map(m =>
        `<option value="${m.id}" ${m.id === cur ? "selected" : ""}>${escHtml(m.fullName)}</option>`
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
              <span class="rp-badge rp-badge--admin">👑 Admin</span>
              <span class="rp-arrow">→</span>
              <span class="rp-badge rp-badge--manager">🏢 Sales Manager</span>
              <span class="rp-arrow">→ (multiple)</span>
              <span class="rp-badge rp-badge--supervisor">👤 Supervisor</span>
              <span class="rp-arrow">→ (multiple)</span>
              <span class="rp-badge rp-badge--rep">👥 Sales Rep</span>
            </div>
            <p class="rp-hierarchy-note">Use the <strong>Reports To</strong> column to assign each Sales Rep to a Supervisor, and each Supervisor to a Sales Manager.</p>
          </div>
          <div class="rp-cards">
            <div class="rp-card">
              <div class="rp-card-head"><span class="rp-card-icon">👑</span><span class="rp-card-label">Admin</span><span class="rp-card-count">${roleCounts.ADMIN}</span></div>
              <p class="rp-card-desc">Full access: manage users, all data, reports</p>
            </div>
            <div class="rp-card">
              <div class="rp-card-head"><span class="rp-card-icon">🏢</span><span class="rp-card-label">Sales Manager</span><span class="rp-card-count">${roleCounts.MANAGER}</span></div>
              <p class="rp-card-desc">View all their Supervisors' and Reps' data</p>
            </div>
            <div class="rp-card">
              <div class="rp-card-head"><span class="rp-card-icon">👤</span><span class="rp-card-label">Supervisor</span><span class="rp-card-count">${roleCounts.SUPERVISOR}</span></div>
              <p class="rp-card-desc">View their team data, reports, calendar</p>
            </div>
            <div class="rp-card">
              <div class="rp-card-head"><span class="rp-card-icon">👥</span><span class="rp-card-label">Sales Rep</span><span class="rp-card-count">${roleCounts.REP}</span></div>
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
        <button class="rp-refresh-btn" id="rp-refresh-btn">↻ Refresh</button>
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
              return `
              <div class="rp-row" data-uid="${u.id}">
                <div class="rp-user-cell">
                  <div class="rp-avatar" style="background:${avatarColor(u.fullName)}">${initials}</div>
                  <div class="rp-user-info">
                    <span class="rp-user-name">${escHtml(u.fullName || "—")}${isSelf ? '<span class="rp-you-badge">You</span>' : ""}</span>
                    <span class="rp-user-email">${escHtml(u.email)}</span>
                    ${teamName ? `<span class="rp-user-team">${escHtml(teamName)}</span>` : ""}
                  </div>
                </div>
                <span><span class="rp-badge ${roleCls[u.role] || ""}">${roleLabel[u.role] || u.role}</span></span>
                <span>${reportsToOptions(u)}</span>
                <span class="rp-role-change-cell">${roleOptions(u)}</span>
              </div>`;
            }).join("")}
          </div>
        </div></div>
      </div>

      <div class="rp-role-guide">
        <h4 class="rp-role-guide-title">How roles work</h4>
        <ul class="rp-role-guide-list">
          <li><span class="rp-badge rp-badge--rep">Sales Rep</span> Default role. Can only view and manage their own visits, check-ins, and calendar.</li>
          <li><span class="rp-badge rp-badge--supervisor">Supervisor</span> Can view all their team's (assigned Sales Reps') data, filter calendar, and access reports.</li>
          <li><span class="rp-badge rp-badge--manager">Sales Manager</span> Can view data for all Supervisors assigned to them and all Sales Reps under those Supervisors. Assign Supervisors using the <strong>Reports To</strong> column above.</li>
          <li><span class="rp-badge rp-badge--admin">Admin</span> Full access including this User Access Management page. Cannot remove their own Admin role.</li>
        </ul>
      </div>
    `;
  } else if (page === "kpi-targets") {
    const canEditKpi = hasRole("ADMIN", "DIRECTOR", "MANAGER");
    pageHtml = `
      <section class="card">
        <h3 class="section-title">🎯 Set KPI Target</h3>
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
        <h3 class="section-title">📊 KPI Targets</h3>
        ${state.cache.kpiTargets.length ? `
          <div class="roles-table kpi-table">
            <div class="roles-table-head">
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
                            <button type="button" class="ghost small teams-push-all-btn" data-tenant-id="${tenantId}" title="Requires User.Read.All, AppCatalog.Read.All, TeamsAppInstallation.ReadWriteForUser.All permissions with admin consent">🚀 Push to All Users</button>` : ""}
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
  } else if (page === "cron-jobs") {
    const cronData = state.cache.cronJobs;
    if (cronData === null) {
      pageHtml = `<section class="card"><div class="muted">กำลังโหลด…</div></section>`;
    } else {
      const jobs = cronData || [];
      pageHtml = `
        <section class="card" style="margin-bottom:var(--sp-4)">
          <h3 class="section-title">⏱ Scheduled Jobs</h3>
          <p class="muted" style="font-size:0.85rem">กำหนดตารางเวลา และดูประวัติการทำงานของแต่ละงาน Admin เท่านั้น</p>
        </section>
        ${jobs.map(job => {
          const cfg = job.config;
          const lastRun = job.runs?.[0];
          const statusBadge = (status) => {
            if (status === "SUCCESS")  return `<span class="cron-badge cron-badge--success">✅ Success</span>`;
            if (status === "FAILURE")  return `<span class="cron-badge cron-badge--failure">❌ Failed</span>`;
            if (status === "RUNNING")  return `<span class="cron-badge cron-badge--running">⏳ Running</span>`;
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
                  <label class="cron-config-label">
                    Cron Expression
                    <button class="cron-help-btn" data-job-key="${job.jobKey}" title="How cron expressions work">?</button>
                  </label>
                  <input class="cron-expr-input" type="text" data-job-key="${job.jobKey}" value="${escHtml(cfg.cronExpr)}" placeholder="e.g. 0 6 * * 1" />
                  <div class="cron-expr-preview" id="cron-preview-${job.jobKey}">${describeCron(cfg.cronExpr, cfg.timezone)}</div>
                </div>
              </div>
              <div class="cron-help-panel" id="cron-help-${job.jobKey}" hidden>
                <p class="cron-help-title">Cron Expression Format</p>
                <code class="cron-help-format">┌─────── minute (0–59)<br>│ ┌───── hour (0–23)<br>│ │ ┌─── day of month (1–31)<br>│ │ │ ┌─ month (1–12)<br>│ │ │ │ ┌ day of week (0–7, 0&amp;7=Sun)<br>│ │ │ │ │<br>* * * * *</code>
                <table class="cron-help-table">
                  <thead><tr><th>Expression</th><th>Meaning</th></tr></thead>
                  <tbody>
                    <tr><td><code>0 6 * * 1</code></td><td>Every Monday at 06:00</td></tr>
                    <tr><td><code>0 7 * * *</code></td><td>Every day at 07:00</td></tr>
                    <tr><td><code>0 9 * * 1-5</code></td><td>Weekdays at 09:00</td></tr>
                    <tr><td><code>0 8 1 * *</code></td><td>1st of every month at 08:00</td></tr>
                    <tr><td><code>30 17 * * 5</code></td><td>Every Friday at 17:30</td></tr>
                  </tbody>
                </table>
                <p class="cron-help-note">⏰ Time is interpreted in the Tenant timezone (configured in Company settings). Use <strong>*</strong> as a wildcard for "every".</p>
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
            <span class="settings-nav-emoji" aria-hidden="true">${item.emoji}</span>
            <span class="settings-nav-label">${item.label}</span>
          </button>
        `).join("")}
        <p class="settings-sidenav-label" style="margin-top:var(--sp-3)">ORGANIZATION</p>
        ${navItems.map((item) => `
          <button class="settings-nav-item ${page === item.page ? "active" : ""}" data-settings-nav="${item.page}" title="${navCollapsed ? item.label : ""}">
            <span class="settings-nav-emoji" aria-hidden="true">${item.emoji}</span>
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
          setStatus("✅ " + res.message);
        } else {
          setStatus("❌ " + res.message, true);
        }
      } catch (err) {
        setStatus("❌ " + err.message, true);
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
    // Help panel toggle (? button)
    views.settings.querySelectorAll(".cron-help-btn").forEach(btn => {
      btn.addEventListener("click", () => {
        const panel = qs(`#cron-help-${btn.dataset.jobKey}`);
        if (panel) panel.hidden = !panel.hidden;
      });
    });

    // Live preview of cron expression (updates as user types)
    const updatePreview = (jobKey) => {
      const exprInput = views.settings.querySelector(`.cron-expr-input[data-job-key="${jobKey}"]`);
      const preview = qs(`#cron-preview-${jobKey}`);
      const jobData = (state.cache.cronJobs || []).find(j => j.jobKey === jobKey);
      if (preview && exprInput) preview.textContent = describeCron(exprInput.value, jobData?.config?.timezone || "");
    };
    views.settings.querySelectorAll(".cron-expr-input").forEach(input => {
      input.addEventListener("input", () => updatePreview(input.dataset.jobKey));
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
          if (statusEl) { statusEl.textContent = "✅ Saved"; statusEl.className = "cron-save-status cron-save-ok"; }
          renderSettings();
        } catch (e) {
          if (statusEl) { statusEl.textContent = "❌ " + (e.message || "Error"); statusEl.className = "cron-save-status cron-save-err"; }
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
        btn.textContent = "⏳ Running…";
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

  // ── Sidebar nav ───────────────────────────────────────────────
  qs("#settings-nav-toggle")?.addEventListener("click", () => {
    state.settingsNavCollapsed = !state.settingsNavCollapsed;
    renderSettings();
  });

  views.settings.querySelectorAll("[data-settings-nav]").forEach((btn) => {
    btn.addEventListener("click", () => {
      navigateToSettingsPage(btn.dataset.settingsNav);
      renderSettings();
    });
  });

  // ── Roles page listeners ──────────────────────────────────────
  qs("#rp-info-toggle")?.addEventListener("click", () => {
    state.roleInfoExpanded = !state.roleInfoExpanded;
    renderSettings();
  });

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
      } catch (error) {
        setStatus(error.message, true);
        await loadSettings();
      }
    });
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

  qs("#branding-form")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const fd = new FormData(event.currentTarget);
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
    const payload = Object.fromEntries(fd.entries());
    if (!payload.logoUrl) delete payload.logoUrl;
    if (!payload.faviconUrl) delete payload.faviconUrl;
    delete payload.logoFile;
    delete payload.faviconFile;
    delete payload.primaryColorPicker;
    delete payload.secondaryColorPicker;
    try {
      await api(`/tenants/${tenantId}/branding`, { method: "PUT", body: payload });
      setStatus("Branding saved.");
      await loadSettings();
    } catch (error) {
      setStatus(error.message, true);
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
        resultEl.textContent = passed ? "✓ Test passed" : `✗ Test failed${result.message ? ": " + result.message : ""}`;
      } catch (error) {
        resultEl.className = "intg-test-result small intg-test-result--fail";
        resultEl.textContent = `✗ ${error.message}`;
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
          setStatus(`✅ ${res.message} (${detail})${res.errors?.length ? " Errors: " + res.errors.join("; ") : ""}`);
        } else {
          setStatus(`❌ ${res.message} — ${detail}${res.sampleAadEmails?.length ? ` | Sample AAD emails: ${res.sampleAadEmails.join(", ")}` : ""}`, true);
        }
      } catch (e) {
        setStatus("❌ " + e.message, true);
      } finally {
        btn.disabled = false;
        btn.textContent = "🚀 Push to All Users";
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

async function loadDashboard(month = state.dashboardMonth) {
  const params = new URLSearchParams();
  if (month) params.set("month", month);
  if (state.dashboardTeamId) params.set("teamId", state.dashboardTeamId);
  if (state.dashboardRepId) params.set("repId", state.dashboardRepId);
  const query = params.size ? `?${params}` : "";
  const data = await api(`/dashboard/overview${query}`);
  renderDashboard(data);
}

// ── Customer List helpers ───────────────────────────────────────────────────

const CUST_PAGE_SIZE = 20;

function filteredCustomers() {
  const q = (state.customerListQuery || "").toLowerCase().trim();
  if (!q) return state.cache.customers;
  return state.cache.customers.filter(
    (c) =>
      c.customerCode?.toLowerCase().includes(q) ||
      c.name?.toLowerCase().includes(q) ||
      c.taxId?.toLowerCase().includes(q)
  );
}

function dealsForCustomer(customerId) {
  if (!state.cache.kanban?.stages) return [];
  return state.cache.kanban.stages.flatMap((s) =>
    s.deals.filter((d) => d.customer?.id === customerId || d.customerId === customerId)
  );
}

function c360Initials(name) {
  return (name || "?")
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0].toUpperCase())
    .join("");
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
  return (name || "?").split(" ").filter(Boolean).slice(0, 2).map(w => w[0].toUpperCase()).join("");
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
        <button class="popup-close-btn" aria-label="Close">✕</button>
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
        <button class="cust-create-btn" id="cust-open-modal">
          <svg width="14" height="14" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
          New Customer
        </button>
      </div>
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
                  <span>🏢 Company</span>
                </label>
                <label class="ncm-type-pill">
                  <input type="radio" name="customerType" value="PERSONAL">
                  <span>👤 Personal</span>
                </label>
              </div>
            </div>
            <div class="ncm-field">
              <label class="ncm-label" for="ncm-code">Customer Code <span class="ncm-req">*</span></label>
              <input class="ncm-input" id="ncm-code" name="customerCode" placeholder="e.g. CUST-000001" required />
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
        if (statusEl) { statusEl.textContent = `✓ Found: ${data.name}${data.status ? " (" + data.status + ")" : ""}`; statusEl.className = "ncm-dbd-status ncm-dbd-ok"; }
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
        <button type="button" class="ncm-close" id="ecm-close">✕</button>
      </div>
      <form id="edit-cust-form" class="ncm-body" novalidate>
        <div class="ncm-row">
          <label class="ncm-label" for="ecm-code">Customer Code</label>
          <input class="ncm-input" id="ecm-code" name="customerCode" value="${escHtml(cust.customerCode || "")}" required />
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

const MONTHS_SHORT = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
function fmtDateTime(dateOrStr) {
  const d = dateOrStr instanceof Date ? dateOrStr : new Date(dateOrStr);
  const pad = (n, w = 2) => String(n).padStart(w, "0");
  return `${pad(d.getDate())}-${MONTHS_SHORT[d.getMonth()]}-${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function escHtml(str) {
  return String(str ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
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

async function openCustomer360(customerIdOrCode, customerCode) {
  // customerCode is the human-readable code used in the URL
  // customerIdOrCode may be a UUID (from list click) or a code (from URL/popstate)
  const urlCode = customerCode || customerIdOrCode;
  navigateToCustomer360(urlCode);
  switchView("master");
  setStatus("Loading customer…");
  try {
    const customer = await api(`/customers/${encodeURIComponent(customerIdOrCode)}`);
    const [deals, visits] = await Promise.all([
      api("/deals"),
      api(`/visits?customerId=${encodeURIComponent(customer.id)}`)
    ]);
    const customerDeals = deals.filter(
      (d) => d.customerId === customer.id || d.customer?.id === customer.id
    );
    state.c360 = { customer, deals: customerDeals, visits, activeTab: "deals" };
    setStatus("");
    renderCustomer360();
  } catch (error) {
    setStatus(error.message, true);
  }
}

function renderC360TabContent(c360) {
  const { customer, deals, visits, activeTab } = c360;

  if (activeTab === "overview") {
    const cfEntries = customer.customFields && typeof customer.customFields === "object"
      ? Object.entries(customer.customFields)
      : [];
    return `
      <div class="c360-info-grid" style="margin-top:var(--sp-4)">
        <div class="c360-info-section">
          <p class="c360-info-section-title">Customer Info</p>
          <div class="c360-info-row"><span class="c360-info-key">Code</span><span class="c360-info-val">${escHtml(customer.customerCode)}</span></div>
          <div class="c360-info-row"><span class="c360-info-key">Payment Term</span><span class="c360-info-val">${customer.paymentTerm ? escHtml(customer.paymentTerm.code + " — " + customer.paymentTerm.name) : "—"}</span></div>
          <div class="c360-info-row"><span class="c360-info-key">Due Days</span><span class="c360-info-val">${customer.paymentTerm?.dueDays ?? "—"} days</span></div>
          <div class="c360-info-row"><span class="c360-info-key">Created</span><span class="c360-info-val">${new Date(customer.createdAt).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" })}</span></div>
          ${customer.siteLat != null && customer.siteLng != null
            ? `<div class="c360-info-row"><span class="c360-info-key">Location</span><span class="c360-info-val"><a class="c360-address-map" href="https://maps.google.com/?q=${customer.siteLat},${customer.siteLng}" target="_blank" rel="noopener">📍 Open map</a></span></div>`
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
    if (!deals.length) return `<div class="c360-empty"><div class="c360-empty-icon">📋</div>No deals yet for this customer.</div>`;
    const stageName = (d) => d.stage?.stageName ?? "Unknown";
    return `
      <div style="border:1px solid var(--border);border-radius:var(--r-md);overflow:hidden;margin-top:var(--sp-4)">
        ${deals.map((d, i) => `
          <div class="c360-deal-row">
            <span class="c360-deal-num">${i + 1}</span>
            <div class="c360-deal-body">
              <div class="c360-deal-name">${escHtml(d.dealName)}</div>
              <div class="c360-deal-meta">
                ${stageName(d)} · Follow-up ${d.followUpAt ? new Date(d.followUpAt).toLocaleDateString("en-GB", { day: "numeric", month: "short" }) : "—"}
                ${d.closedAt ? ` · Closed ${new Date(d.closedAt).toLocaleDateString("en-GB", { day: "numeric", month: "short" })}` : ""}
              </div>
            </div>
            <div class="c360-deal-right">
              <span class="badge badge--${(stageName(d).toLowerCase().includes("won") ? "won" : stageName(d).toLowerCase().includes("lost") ? "lost" : "open")}">${stageName(d)}</span>
              <span class="c360-deal-value">${asMoney(d.estimatedValue)}</span>
            </div>
          </div>`).join("")}
      </div>`;
  }

  if (activeTab === "visits") {
    if (!visits.length) return `<div class="c360-empty"><div class="c360-empty-icon">📍</div>No visits recorded for this customer.</div>`;
    return `
      <div style="border:1px solid var(--border);border-radius:var(--r-md);overflow:hidden;margin-top:var(--sp-4)">
        ${visits.map((v) => {
          const vDate = new Date(v.plannedAt || v.createdAt);
          const notes = v.voiceNoteTranscript || v.notes || "";
          return `
            <div class="c360-visit-row">
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
    if (!contacts.length) return `<div class="c360-empty"><div class="c360-empty-icon">👤</div>No contacts added yet.</div>`;
    return `
      <div style="border:1px solid var(--border);border-radius:var(--r-md);overflow:hidden;margin-top:var(--sp-4)">
        ${contacts.map((c) => `
          <div class="c360-contact-row">
            <div class="c360-contact-avatar" style="background:${avatarColor(c.name)}">${c360Initials(c.name)}</div>
            <div>
              <div class="c360-contact-name">${escHtml(c.name)}</div>
              <div class="c360-contact-pos">${escHtml(c.position)}</div>
            </div>
          </div>`).join("")}
      </div>`;
  }

  if (activeTab === "addresses") {
    const addresses = customer.addresses ?? [];
    if (!addresses.length) return `<div class="c360-empty"><div class="c360-empty-icon">🏢</div>No addresses added yet.</div>`;
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

function renderCustomer360() {
  const c360 = state.c360;
  if (!c360) return;
  const { customer, deals, visits } = c360;

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
    { key: "overview", label: "Overview", count: null }
  ];

  views.master.innerHTML = `
    <div class="master-outer">
      <div class="c360-wrap">
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
            <div class="c360-avatar" style="background:${avatarColor(customer.name)}">${c360Initials(customer.name)}</div>
            <div class="c360-header-info">
              <h2 class="c360-name">${escHtml(customer.name)}</h2>
              <div class="c360-meta">
                <span class="c360-code">${escHtml(customer.customerCode)}</span>
                <span class="c360-meta-sep">·</span>
                <span class="c360-meta-item">
                  <svg width="12" height="12" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="1" y="4" width="22" height="16" rx="2" ry="2"/><line x1="1" y1="10" x2="23" y2="10"/></svg>
                  ${customer.paymentTerm ? escHtml(customer.paymentTerm.code) : "No term"}
                </span>
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
            <p class="c360-kpi-value" style="font-size:1.1rem">${asMoney(pipelineValue)}</p>
          </div>
          <div class="c360-kpi">
            <p class="c360-kpi-label">Won Value</p>
            <p class="c360-kpi-value" style="color:oklch(55% 0.18 145);font-size:1.1rem">${asMoney(wonValue)}</p>
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

  // Back
  views.master.querySelector("#c360-back")?.addEventListener("click", () => {
    state.c360 = null;
    navigateToMasterPage("customers");
    switchView("master");
    renderMasterData(state.cache.paymentTerms || []);
  });

  // Tabs
  views.master.querySelectorAll(".c360-tab-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      state.c360.activeTab = btn.dataset.tab;
      views.master.querySelectorAll(".c360-tab-btn").forEach((b) => b.classList.toggle("active", b.dataset.tab === btn.dataset.tab));
      const content = views.master.querySelector("#c360-tab-content");
      if (content) content.innerHTML = renderC360TabContent(state.c360);
    });
  });

  // Quick actions
  views.master.querySelector("#c360-schedule-visit")?.addEventListener("click", async () => {
    openVisitCreateModal();
    const modal = qs("#visit-create-modal");
    if (!modal) return;
    const hid = modal.querySelector("#visit-customer-id");
    const inp = modal.querySelector("#visit-customer-input");
    if (hid) hid.value = customer.id;
    if (inp) inp.value = customer.name;
    // Populate deal dropdown for this customer
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
    openDealCreateModal(state.cache.kanban);
    const modal = qs("#deal-create-modal");
    if (!modal) return;
    const hid = modal.querySelector("#deal-customer-id");
    const inp = modal.querySelector("#deal-customer-input");
    if (hid) hid.value = customer.id;
    if (inp) inp.value = customer.name;
  });
}

// ── Deal 360 ──────────────────────────────────────────────────────────────────

state.deal360 = null;

function navigateToDeal360(dealNo) {
  const route = `/deals/${encodeURIComponent(dealNo)}`;
  if (window.location.pathname !== route) {
    window.history.pushState({ dealNo }, "", route);
  }
}

function syncDeal360FromLocation() {
  const match = window.location.pathname.match(/^\/deals\/([^/]+)$/);
  return match ? decodeURIComponent(match[1]) : null;
}

async function openDeal360(dealId, dealNo) {
  const urlNo = dealNo || dealId;
  navigateToDeal360(urlNo);
  switchView("deals");
  setStatus("Loading deal…");
  try {
    const [deal, progress, visits] = await Promise.all([
      api(`/deals/${dealId}`),
      api(`/deals/${dealId}/progress-updates`),
      api(`/visits?dealId=${encodeURIComponent(dealId)}`)
    ]);
    let changelog = [];
    const role = state.user?.role;
    const canSeeChangelog = ["ADMIN", "DIRECTOR", "MANAGER"].includes(role);
    if (canSeeChangelog) {
      try {
        changelog = await api(`/changelogs?entityType=DEAL&entityId=${encodeURIComponent(dealId)}&limit=50`);
      } catch { /* role may not be permitted */ }
    }
    state.deal360 = { deal, progress, visits, changelog, activeTab: "progress", canSeeChangelog };
    setStatus("");
    renderDeal360();
  } catch (error) {
    setStatus(error.message, true);
  }
}

function renderDeal360TabContent(d360) {
  const { deal, progress, visits, changelog, activeTab } = d360;

  // ── Progress Updates ────────────────────────────────────────────────────────
  if (activeTab === "progress") {
    const attachmentSvg = `<svg width="13" height="13" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"/></svg>`;
    const renderAttachments = (urls) => {
      const list = Array.isArray(urls) ? urls : (urls ? [urls] : []);
      if (!list.length) return "";
      return list.map((url) => {
        const isR2 = url.startsWith("r2://");
        const fileName = url.split("/").pop() || "Attachment";
        const displayName = fileName.replace(/^\d+_/, ""); // strip timestamp prefix
        if (isR2) {
          return `<button class="d360-tl-attachment d360-tl-attachment--btn" data-r2ref="${escHtml(url)}" title="Download attachment">
            ${attachmentSvg} ${escHtml(displayName)}
          </button>`;
        }
        return `<a class="d360-tl-attachment" href="${escHtml(url)}" target="_blank" rel="noopener">
          ${attachmentSvg} ${escHtml(displayName)}
        </a>`;
      }).join("");
    };

    const timelineHtml = progress.length
      ? `<div class="d360-timeline">
          ${progress.map((u) => {
            const dt = new Date(u.createdAt);
            return `
              <div class="d360-tl-item">
                <div class="d360-tl-avatar" style="background:${avatarColor(u.createdBy?.fullName || '?')}">${c360Initials(u.createdBy?.fullName || '?')}</div>
                <div class="d360-tl-body">
                  <div class="d360-tl-meta">
                    <span class="d360-tl-author">${escHtml(u.createdBy?.fullName || '—')}</span>
                    <span class="d360-tl-date">${fmtDateTime(dt)}</span>
                  </div>
                  <div class="d360-tl-note">${escHtml(u.note)}</div>
                  ${renderAttachments(u.attachmentUrls)}
                </div>
              </div>`;
          }).join("")}
        </div>`
      : `<div class="c360-empty" style="padding:var(--sp-6) 0"><div class="c360-empty-icon">📝</div>No progress updates yet.</div>`;

    return `
      <div class="d360-progress-wrap">
        <form class="d360-update-form" id="d360-update-form" data-deal-id="${escHtml(deal.id)}">
          <div class="d360-update-form-inner">
            <div class="d360-update-form-avatar" style="background:${avatarColor(state.user?.fullName || '?')}">${c360Initials(state.user?.fullName || '?')}</div>
            <div class="d360-update-form-body">
              <textarea
                class="d360-update-textarea"
                id="d360-update-note"
                placeholder="Write a progress update…"
                rows="3"
                required
              ></textarea>
              <div class="d360-update-file-row" id="d360-file-row">
                <label class="d360-file-pick-btn" id="d360-file-pick-label" title="Attach up to 5 files">
                  <svg width="14" height="14" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"/></svg>
                  Attach files
                  <input type="file" id="d360-file-input" class="d360-file-input-hidden" multiple />
                </label>
                <div class="d360-file-chips" id="d360-file-chips"></div>
              </div>
              <div class="d360-update-form-actions">
                <button type="submit" class="d360-update-submit btn-primary" id="d360-update-submit">
                  <svg width="14" height="14" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>
                  Post update
                </button>
              </div>
            </div>
          </div>
        </form>
        ${timelineHtml}
      </div>`;
  }

  // ── Customer Info ───────────────────────────────────────────────────────────
  if (activeTab === "customer") {
    const c = deal.customer;
    if (!c) return `<div class="c360-empty"><div class="c360-empty-icon">👤</div>No customer linked.</div>`;
    const contacts = c.contacts ?? [];
    const addresses = c.addresses ?? [];
    return `
      <div class="d360-customer-wrap">
        <div class="d360-cust-header">
          <div class="c360-avatar" style="background:${avatarColor(c.name)}">${c360Initials(c.name)}</div>
          <div class="d360-cust-info">
            <div class="d360-cust-name">${escHtml(c.name)}</div>
            <div class="d360-cust-meta">
              <span class="c360-code">${escHtml(c.customerCode)}</span>
              ${c.taxId ? `<span class="c360-meta-sep">·</span><span class="c360-meta-item">Tax: ${escHtml(c.taxId)}</span>` : ""}
              ${c.paymentTerm ? `<span class="c360-meta-sep">·</span><span class="c360-meta-item">${escHtml(c.paymentTerm.code)} · ${c.paymentTerm.dueDays}d</span>` : ""}
            </div>
          </div>
          <button class="d360-open-cust ghost" data-id="${c.id}" data-code="${escHtml(c.customerCode)}">
            <svg width="12" height="12" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>
            View full profile
          </button>
        </div>

        ${contacts.length > 0 ? `
          <div class="d360-section-label">Contacts</div>
          <div style="border:1px solid var(--border);border-radius:var(--r-md);overflow:hidden">
            ${contacts.map((ct) => `
              <div class="c360-contact-row">
                <div class="c360-contact-avatar" style="background:${avatarColor(ct.name)}">${c360Initials(ct.name)}</div>
                <div>
                  <div class="c360-contact-name">${escHtml(ct.name)}</div>
                  <div class="c360-contact-pos">${escHtml(ct.position || "")}</div>
                  <div class="cpop-channels">
                    ${ct.tel      ? `<span class="cpop-channel"><svg width="11" height="11" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07A19.5 19.5 0 0 1 4.69 12 19.79 19.79 0 0 1 1.62 3.48 2 2 0 0 1 3.62 1.27h3a2 2 0 0 1 2 1.72c.127.96.361 1.903.7 2.81a2 2 0 0 1-.45 2.11L7.91 8.91a16 16 0 0 0 6.18 6.18l.97-.97a2 2 0 0 1 2.11-.45c.907.339 1.85.573 2.81.7A2 2 0 0 1 22 16.92z"/></svg>${escHtml(ct.tel)}</span>` : ""}
                    ${ct.email    ? `<span class="cpop-channel"><svg width="11" height="11" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"/><polyline points="22,6 12,13 2,6"/></svg>${escHtml(ct.email)}</span>` : ""}
                    ${ct.lineId   ? `<span class="cpop-channel">LINE: ${escHtml(ct.lineId)}</span>` : ""}
                  </div>
                </div>
              </div>`).join("")}
          </div>` : ""}

        ${addresses.length > 0 ? `
          <div class="d360-section-label">Addresses</div>
          <div class="c360-addresses-grid">
            ${addresses.map((a) => `
              <div class="c360-address-card">
                <div class="c360-address-labels">
                  ${a.isDefaultBilling  ? '<span class="c360-address-badge">Billing</span>'  : ""}
                  ${a.isDefaultShipping ? '<span class="c360-address-badge">Shipping</span>' : ""}
                </div>
                <div class="c360-address-line">
                  ${escHtml(a.addressLine1)}${a.city ? ", " + escHtml(a.city) : ""}${a.province ? ", " + escHtml(a.province) : ""}${a.country ? ", " + escHtml(a.country) : ""}${a.postalCode ? " " + escHtml(a.postalCode) : ""}
                </div>
                ${a.latitude != null && a.longitude != null
                  ? `<a class="c360-address-map" href="https://maps.google.com/?q=${a.latitude},${a.longitude}" target="_blank" rel="noopener">
                      <svg width="12" height="12" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/></svg>
                      Open in Maps
                    </a>`
                  : ""}
              </div>`).join("")}
          </div>` : ""}
      </div>`;
  }

  // ── Visits ──────────────────────────────────────────────────────────────────
  if (activeTab === "visits") {
    if (!visits.length) {
      return `<div class="c360-empty"><div class="c360-empty-icon">📍</div>No visits linked to this deal yet.</div>`;
    }
    return `
      <div style="border:1px solid var(--border);border-radius:var(--r-md);overflow:hidden;margin-top:var(--sp-4)">
        ${visits.map((v) => {
          const vDate = new Date(v.plannedAt || v.createdAt);
          const statusColor = v.status === "CHECKED_OUT" ? "won" : v.status === "CHECKED_IN" ? "open" : "muted";
          return `
            <div class="c360-visit-row">
              <div class="c360-visit-date">
                <strong>${vDate.getDate()}</strong>
                <span>${vDate.toLocaleDateString("en-GB", { month: "short", year: "2-digit" })}</span>
              </div>
              <div class="c360-visit-body">
                <div class="c360-visit-rep">${escHtml(v.rep?.fullName ?? "—")}</div>
                ${v.objective ? `<div class="c360-visit-notes">${escHtml(v.objective)}</div>` : ""}
                ${v.result ? `<div class="c360-visit-notes" style="color:var(--text-muted)">${escHtml(v.result)}</div>` : ""}
              </div>
              <div style="display:flex;flex-direction:column;align-items:flex-end;gap:var(--sp-1)">
                <span class="badge badge--${statusColor}">${v.status}</span>
                <span class="muted small">${v.visitType}</span>
              </div>
            </div>`;
        }).join("")}
      </div>`;
  }

  // ── Changelog ───────────────────────────────────────────────────────────────
  if (activeTab === "changelog") {
    if (!changelog.length) {
      return `<div class="c360-empty"><div class="c360-empty-icon">📋</div>No changelog entries found.</div>`;
    }
    const actionIcon = (action) => {
      if (action === "CREATE") return `<span class="d360-cl-action d360-cl-action--create">Created</span>`;
      if (action === "DELETE") return `<span class="d360-cl-action d360-cl-action--delete">Deleted</span>`;
      return `<span class="d360-cl-action d360-cl-action--update">Updated</span>`;
    };
    const diffFields = (before, after) => {
      if (!before || !after) return [];
      const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
      const changes = [];
      for (const k of keys) {
        const bv = before[k]; const av = after[k];
        if (JSON.stringify(bv) !== JSON.stringify(av)) {
          changes.push({ key: k, before: bv, after: av });
        }
      }
      return changes;
    };
    return `
      <div class="d360-timeline">
        ${changelog.map((entry) => {
          const dt = new Date(entry.createdAt);
          const diffs = diffFields(entry.beforeJson, entry.afterJson);
          return `
            <div class="d360-tl-item">
              <div class="d360-tl-avatar d360-tl-avatar--sys" style="background:${avatarColor(entry.changedBy?.fullName || 'System')}">${c360Initials(entry.changedBy?.fullName || 'SYS')}</div>
              <div class="d360-tl-body">
                <div class="d360-tl-meta">
                  <span class="d360-tl-author">${escHtml(entry.changedBy?.fullName || 'System')}</span>
                  ${actionIcon(entry.action)}
                  <span class="d360-tl-date">${fmtDateTime(dt)}</span>
                </div>
                ${diffs.length > 0 ? `
                  <div class="d360-cl-diffs">
                    ${diffs.map(({ key, before: bv, after: av }) => `
                      <div class="d360-cl-diff-row">
                        <span class="d360-cl-field">${escHtml(key)}</span>
                        <span class="d360-cl-before">${escHtml(String(bv ?? "—"))}</span>
                        <svg width="10" height="10" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="5" y1="12" x2="19" y2="12"/><polyline points="12 5 19 12 12 19"/></svg>
                        <span class="d360-cl-after">${escHtml(String(av ?? "—"))}</span>
                      </div>`).join("")}
                  </div>` : ""}
              </div>
            </div>`;
        }).join("")}
      </div>`;
  }

  return "";
}

function renderDeal360() {
  const d360 = state.deal360;
  if (!d360) return;
  const { deal, progress, visits, changelog, canSeeChangelog } = d360;
  const c = deal.customer;

  const statusBadgeClass = deal.status === "WON" ? "won" : deal.status === "LOST" ? "lost" : "open";
  const isClosed = deal.status === "WON" || deal.status === "LOST";

  const tabs = [
    { key: "progress", label: "Progress",  count: progress.length },
    { key: "customer", label: "Customer",  count: null },
    { key: "visits",   label: "Visits",    count: visits.length },
    ...(canSeeChangelog ? [{ key: "changelog", label: "Changelog", count: changelog.length }] : [])
  ];

  views.deals.innerHTML = `
    <div class="master-outer">
      <div class="c360-wrap">

        <div class="c360-breadcrumb">
          <button class="c360-back-btn" id="d360-back">
            <svg width="14" height="14" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"/></svg>
            Deals
          </button>
          <span class="c360-breadcrumb-sep">›</span>
          <span>${escHtml(deal.dealNo)} — ${escHtml(deal.dealName)}</span>
        </div>

        <div class="c360-header">
          <div class="c360-header-left">
            <div class="d360-deal-icon">
              <svg width="22" height="22" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/></svg>
            </div>
            <div class="c360-header-info">
              <h2 class="c360-name">${escHtml(deal.dealName)}</h2>
              <div class="c360-meta">
                <span class="c360-code">${escHtml(deal.dealNo)}</span>
                <span class="c360-meta-sep">·</span>
                <span class="badge badge--${statusBadgeClass}">${deal.status}</span>
                <span class="c360-meta-sep">·</span>
                <span class="c360-meta-item">${escHtml(deal.stage?.stageName || "—")}</span>
                <span class="c360-meta-sep">·</span>
                <span class="c360-meta-item">${escHtml(deal.owner?.fullName || "Unassigned")}</span>
              </div>
            </div>
          </div>
        </div>

        <div class="c360-kpi-strip">
          <div class="c360-kpi">
            <p class="c360-kpi-label">Value</p>
            <p class="c360-kpi-value" style="font-size:1.1rem">${asMoney(deal.estimatedValue)}</p>
          </div>
          <div class="c360-kpi">
            <p class="c360-kpi-label">Stage</p>
            <p class="c360-kpi-value" style="font-size:0.95rem;font-weight:600">${escHtml(deal.stage?.stageName || "—")}</p>
          </div>
          <div class="c360-kpi">
            <p class="c360-kpi-label">Follow-up</p>
            <p class="c360-kpi-value" style="font-size:0.9rem${!isClosed && deal.is_overdue_followup ? ";color:var(--danger)" : ""}">
              ${deal.followUpAt ? new Date(deal.followUpAt).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" }) : "—"}
            </p>
          </div>
          ${isClosed ? `
            <div class="c360-kpi">
              <p class="c360-kpi-label">Closed</p>
              <p class="c360-kpi-value" style="font-size:0.9rem">${deal.closedAt ? new Date(deal.closedAt).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" }) : "—"}</p>
            </div>` : ""}
          <div class="c360-kpi">
            <p class="c360-kpi-label">Customer</p>
            <p class="c360-kpi-value" style="font-size:0.85rem;font-weight:600">${escHtml(c?.name || "—")}</p>
          </div>
          <div class="c360-kpi">
            <p class="c360-kpi-label">Visits</p>
            <p class="c360-kpi-value">${visits.length}</p>
          </div>
          <div class="c360-kpi">
            <p class="c360-kpi-label">Updates</p>
            <p class="c360-kpi-value">${progress.length}</p>
          </div>
        </div>

        ${deal.lostNote ? `
          <div class="d360-lost-note">
            <svg width="14" height="14" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
            <span>Lost reason: ${escHtml(deal.lostNote)}</span>
          </div>` : ""}

        <div class="c360-tab-bar">
          ${tabs.map((t) => `
            <button class="c360-tab-btn ${d360.activeTab === t.key ? "active" : ""}" data-tab="${t.key}">
              ${t.label}
              ${t.count !== null ? `<span class="c360-tab-count">${t.count}</span>` : ""}
            </button>`).join("")}
        </div>

        <div class="c360-tab-content" id="d360-tab-content">
          ${renderDeal360TabContent(d360)}
        </div>
      </div>
    </div>
  `;

  views.deals.querySelector("#d360-back")?.addEventListener("click", () => {
    state.deal360 = null;
    navigateToView("deals");
    switchView("deals");
    if (state.cache.kanban) renderDeals(state.cache.kanban);
  });

  views.deals.querySelectorAll(".c360-tab-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      state.deal360.activeTab = btn.dataset.tab;
      views.deals.querySelectorAll(".c360-tab-btn").forEach((b) => b.classList.toggle("active", b.dataset.tab === btn.dataset.tab));
      const content = views.deals.querySelector("#d360-tab-content");
      if (content) content.innerHTML = renderDeal360TabContent(state.deal360);
      bindDeal360TabListeners();
    });
  });

  bindDeal360TabListeners();
}

function bindDeal360TabListeners() {
  // Customer tab — open c360
  views.deals.querySelectorAll(".d360-open-cust").forEach((btn) => {
    btn.addEventListener("click", () => openCustomer360(btn.dataset.id, btn.dataset.code));
  });

  // r2:// attachment download buttons — fetch presigned URL on demand
  views.deals.querySelectorAll(".d360-tl-attachment--btn").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const ref = btn.dataset.r2ref;
      if (!ref) return;
      btn.disabled = true;
      const origHtml = btn.innerHTML;
      btn.textContent = "Fetching…";
      try {
        const result = await api(`/storage/r2/presign-download?objectKey=${encodeURIComponent(ref)}`);
        window.open(result.downloadUrl, "_blank", "noopener");
      } catch (err) {
        showToast(err.message || "Could not fetch download URL", "error");
      } finally {
        btn.innerHTML = origHtml;
        btn.disabled = false;
      }
    });
  });

  // Progress update form
  const form = views.deals.querySelector("#d360-update-form");
  if (!form) return;

  const fileInput  = form.querySelector("#d360-file-input");
  const fileChips  = form.querySelector("#d360-file-chips");
  const submitBtn  = form.querySelector("#d360-update-submit");

  const MAX_FILES = 5;

  const renderFileChips = () => {
    if (!fileChips) return;
    const files = Array.from(fileInput?.files ?? []);
    fileChips.innerHTML = files.map((f, i) => `
      <div class="d360-file-chip">
        <svg width="12" height="12" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"/></svg>
        <span class="d360-file-name">${escHtml(f.name)}</span>
        <button type="button" class="d360-file-remove" data-idx="${i}" aria-label="Remove file">
          <svg width="11" height="11" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
        </button>
      </div>`).join("");
    fileChips.querySelectorAll(".d360-file-remove").forEach((btn) => {
      btn.addEventListener("click", () => {
        const idx = parseInt(btn.dataset.idx, 10);
        const dt = new DataTransfer();
        Array.from(fileInput.files).forEach((f, i) => { if (i !== idx) dt.items.add(f); });
        fileInput.files = dt.files;
        renderFileChips();
      });
    });
  };

  fileInput?.addEventListener("change", () => {
    if (fileInput.files.length > MAX_FILES) {
      showToast(`You can attach up to ${MAX_FILES} files at a time.`, "error");
      fileInput.value = "";
      renderFileChips();
      return;
    }
    renderFileChips();
  });

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const dealId   = form.dataset.dealId;
    const noteEl   = form.querySelector("#d360-update-note");
    const noteText = noteEl?.value?.trim();
    if (!noteText) { noteEl?.focus(); return; }

    submitBtn.disabled = true;
    const origLabel = submitBtn.innerHTML;
    submitBtn.innerHTML = `<svg width="14" height="14" class="spin" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-6.219-8.56"/></svg> Posting…`;

    try {
      const files = Array.from(fileInput?.files ?? []);
      const attachmentUrls = [];

      for (const file of files) {
        const presign = await api("/storage/r2/presign-upload", {
          method: "POST",
          body: {
            entityType: "DEAL",
            entityId: dealId,
            filename: file.name,
            contentType: file.type || "application/octet-stream"
          }
        });

        const uploadResp = await fetch(presign.uploadUrl, {
          method: "PUT",
          headers: { "content-type": file.type || "application/octet-stream" },
          body: file
        });
        if (!uploadResp.ok) throw new Error(`File upload failed (HTTP ${uploadResp.status})`);

        attachmentUrls.push(presign.objectRef);
      }

      await api(`/deals/${dealId}/progress-updates`, {
        method: "POST",
        body: { note: noteText, ...(attachmentUrls.length ? { attachmentUrls } : {}) }
      });

      const updated = await api(`/deals/${dealId}/progress-updates`);
      state.deal360.progress = updated;
      state.deal360.activeTab = "progress";

      noteEl.value = "";
      if (fileInput) fileInput.value = "";
      renderFileChips();

      const content = views.deals.querySelector("#d360-tab-content");
      if (content) content.innerHTML = renderDeal360TabContent(state.deal360);
      bindDeal360TabListeners();

      showToast("Progress update posted.", "success");
    } catch (err) {
      showToast(err.message || "Failed to post update", "error");
    } finally {
      submitBtn.disabled = false;
      submitBtn.innerHTML = origLabel;
    }
  });
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

async function loadVisits() {
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

async function loadCalendar(nextFilters = {}) {
  state.calendarFilters = { ...state.calendarFilters, ...nextFilters };
  const f = state.calendarFilters;
  const query = new URLSearchParams();

  // Scalar params
  if (f.view)       query.set("view", f.view);
  if (f.anchorDate) query.set("anchorDate", f.anchorDate);
  if (f.query?.trim()) query.set("query", f.query.trim());
  if (f.customerId) query.set("customerId", f.customerId);

  // For day view, pass explicit local-day boundaries so the backend returns
  // events that fall within the user's local calendar day (not UTC day).
  if (f.view === "day" && f.anchorDate) {
    const anchor = new Date(f.anchorDate);
    const dayStart = new Date(anchor.getFullYear(), anchor.getMonth(), anchor.getDate(), 0, 0, 0, 0);
    const dayEnd   = new Date(anchor.getFullYear(), anchor.getMonth(), anchor.getDate() + 1, 0, 0, 0, 0);
    query.set("dateFrom", dayStart.toISOString());
    query.set("dateTo",   dayEnd.toISOString());
  }

  // Array params — send as comma-separated; omit when empty (= no filter)
  if (f.eventTypes?.length)    query.set("eventTypes",    f.eventTypes.join(","));
  if (f.ownerIds?.length)      query.set("ownerIds",      f.ownerIds.join(","));
  if (f.visitStatuses?.length) query.set("visitStatuses", f.visitStatuses.join(","));
  if (f.dealStageIds?.length)  query.set("dealStageIds",  f.dealStageIds.join(","));
  if (f.dealStatuses?.length)  query.set("dealStatuses",  f.dealStatuses.join(","));

  const data = await api(`/calendar/events?${query.toString()}`);
  state.cache.calendar = data;
  renderCalendar(data);
}

async function loadIntegrations() {
  const isAtLeastManager = state.user?.role === "ADMIN" || state.user?.role === "MANAGER";
  if (!isAtLeastManager) return;
  const data = await api("/integrations/logs");
  state.cache.logs = data;
  renderIntegrationLogs(data);
}

async function loadSettings() {
  const tenantId = state.user?.tenantId;
  if (!tenantId) return;
  const isAdmin   = state.user?.role === "ADMIN";
  const isManager = state.user?.role === "ADMIN" || state.user?.role === "MANAGER";
  // branding, taxConfig, visitConfig, and integrationCredentials require MANAGER+
  // — skip them for REP so the Promise.all doesn't fail with 403
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
  if (branding) applyBrandingTheme(branding);
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
    loadSettings()
  ]);
}

loginForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  authMessage.textContent = "";

  const formData = new FormData(loginForm);
  const payload = Object.fromEntries(formData.entries());
  try {
    const result = await api("/auth/login", { method: "POST", body: payload, headers: {} });
    state.token = result.accessToken;
    state.user = result.user;
    state.calendarFilters.ownerIds = [result.user.id];
    localStorage.setItem("thinkcrm_token", state.token);
    showApp();
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
    } else {
      window.history.replaceState({ view: "repHub" }, "", "/task");
      switchView("repHub");
      paintRepHubFull();
    }
  } catch (error) {
    authMessage.textContent = error.message;
  }
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
  const payload = Object.fromEntries(new FormData(e.currentTarget).entries());
  if (!payload.customerId) {
    setStatus("Please select a customer from the list.", true);
    qs("#deal-customer-input")?.focus();
    return;
  }
  const followUpAt = new Date(payload.followUpAt).toISOString();
  const btn = e.currentTarget.querySelector('[type="submit"]');
  if (btn) btn.disabled = true;
  try {
    await api("/deals", {
      method: "POST",
      body: { ...payload, estimatedValue: Number(payload.estimatedValue), followUpAt }
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
let _gmapsLoaded = false;
let _gmapsLoading = false;
const _gmapsWaiters = [];

function loadGoogleMapsApi(apiKey) {
  return new Promise((resolve, reject) => {
    if (_gmapsLoaded) { resolve(); return; }
    _gmapsWaiters.push({ resolve, reject });
    if (_gmapsLoading) return;
    _gmapsLoading = true;
    window.__gmapsReady = () => {
      _gmapsLoaded = true;
      _gmapsWaiters.splice(0).forEach(w => w.resolve());
    };
    const s = document.createElement("script");
    s.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(apiKey)}&callback=__gmapsReady&libraries=places`;
    s.async = true;
    s.defer = true;
    s.onerror = () => {
      _gmapsLoading = false;
      _gmapsWaiters.splice(0).forEach(w => w.reject(new Error("Failed to load Google Maps API.")));
    };
    document.head.appendChild(s);
  });
}

let _mapInst = null;
let _mapMarker = null;
let _mapPickedCoords = null;
let _mapPickerOnConfirm = null;

function updateMapCoordsDisplay(lat, lng) {
  _mapPickedCoords = { lat, lng };
  const el = qs("#map-coords-display");
  if (el) el.textContent = `${lat.toFixed(6)}, ${lng.toFixed(6)}`;
  const btn = qs("#map-picker-confirm");
  if (btn) btn.disabled = false;
}

function initGoogleMap(lat, lng) {
  const canvas = qs("#map-picker-canvas");
  if (!canvas) return;
  qs("#map-picker-loading")?.remove();

  const center = { lat, lng };
  _mapInst = new google.maps.Map(canvas, {
    center,
    zoom: 15,
    mapTypeControl: false,
    streetViewControl: false,
    fullscreenControl: false,
    zoomControl: true
  });

  _mapMarker = new google.maps.Marker({
    position: center,
    map: _mapInst,
    draggable: true,
    title: "Visit location"
  });

  if (_mapPickedCoords) {
    updateMapCoordsDisplay(_mapPickedCoords.lat, _mapPickedCoords.lng);
  }

  _mapInst.addListener("click", (e) => {
    const lat = e.latLng.lat();
    const lng = e.latLng.lng();
    _mapMarker.setPosition(e.latLng);
    updateMapCoordsDisplay(lat, lng);
  });

  _mapMarker.addListener("dragend", () => {
    const pos = _mapMarker.getPosition();
    updateMapCoordsDisplay(pos.lat(), pos.lng());
  });

  // Places autocomplete on the search input
  const searchInput = qs("#map-search-input");
  if (searchInput && window.google?.maps?.places) {
    const autocomplete = new google.maps.places.Autocomplete(searchInput, {
      fields: ["geometry", "name"]
    });
    autocomplete.addListener("place_changed", () => {
      const place = autocomplete.getPlace();
      if (place.geometry?.location) {
        const lat = place.geometry.location.lat();
        const lng = place.geometry.location.lng();
        _mapInst.setCenter(place.geometry.location);
        _mapInst.setZoom(16);
        _mapMarker.setPosition(place.geometry.location);
        updateMapCoordsDisplay(lat, lng);
      }
    });
  }
}

async function openMapPicker(defaultLat, defaultLng, onConfirm) {
  // Fetch key on-demand if not yet loaded (handles race with bootstrap)
  if (!state.googleMapsApiKey) {
    try {
      const cfg = await fetch("/api/v1/config/public").then(r => r.ok ? r.json() : {});
      state.googleMapsApiKey = cfg.googleMapsApiKey ?? null;
    } catch (_) {}
  }

  const apiKey = state.googleMapsApiKey;
  if (!apiKey) {
    setStatus("Google Maps API key is not configured. Please set GOOGLE_MAPS_API_KEY in server settings.", true);
    return;
  }

  _mapPickerOnConfirm = onConfirm;
  // Reset state
  _mapPickedCoords = defaultLat && defaultLng ? { lat: defaultLat, lng: defaultLng } : null;
  const modal = qs("#map-picker-modal");
  if (!modal) return;

  // Reset UI
  const canvas = qs("#map-picker-canvas");
  if (canvas) {
    canvas.innerHTML = `<div class="map-picker-loading" id="map-picker-loading">Loading map…</div>`;
  }
  const coordsEl = qs("#map-coords-display");
  if (coordsEl) coordsEl.textContent = "Click on map to set location";
  const confirmBtn = qs("#map-picker-confirm");
  if (confirmBtn) confirmBtn.disabled = !_mapPickedCoords;
  const searchInput = qs("#map-search-input");
  if (searchInput) searchInput.value = "";

  modal.hidden = false;
  _mapInst = null;
  _mapMarker = null;

  try {
    await loadGoogleMapsApi(apiKey);
    const lat = defaultLat ?? 13.7563;
    const lng = defaultLng ?? 100.5018;
    initGoogleMap(lat, lng);
    if (_mapPickedCoords) {
      updateMapCoordsDisplay(_mapPickedCoords.lat, _mapPickedCoords.lng);
    }
  } catch (err) {
    modal.hidden = true;
    setStatus(err.message || "Failed to load Google Maps. Please check your connection.", true);
  }
}

function closeMapPicker() {
  const modal = qs("#map-picker-modal");
  if (modal) modal.hidden = true;
  _mapInst = null;
  _mapMarker = null;
  _mapPickerOnConfirm = null;
}

// Wire up map picker modal buttons
qs("#map-picker-close")?.addEventListener("click", closeMapPicker);
qs("#map-picker-cancel")?.addEventListener("click", closeMapPicker);
qs("#map-picker-backdrop")?.addEventListener("click", closeMapPicker);

qs("#map-picker-confirm")?.addEventListener("click", () => {
  if (_mapPickedCoords && _mapPickerOnConfirm) {
    _mapPickerOnConfirm(_mapPickedCoords.lat, _mapPickedCoords.lng);
  }
  closeMapPicker();
});

qs("#map-my-location-btn")?.addEventListener("click", () => {
  if (!navigator.geolocation) {
    alert("Geolocation is not supported by your browser.");
    return;
  }
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      if (!_mapInst) return;
      const loc = new google.maps.LatLng(pos.coords.latitude, pos.coords.longitude);
      _mapInst.setCenter(loc);
      _mapInst.setZoom(16);
      _mapMarker.setPosition(loc);
      updateMapCoordsDisplay(pos.coords.latitude, pos.coords.longitude);
    },
    () => alert("Could not retrieve your location.")
  );
});

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && qs("#map-picker-modal") && !qs("#map-picker-modal").hidden) {
    closeMapPicker();
  }
});

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
  const data = Object.fromEntries(new FormData(e.currentTarget).entries());
  if (!data.customerId) {
    setStatus("Please select a customer from the list.", true);
    qs("#visit-customer-input")?.focus();
    return;
  }
  const visitType = data.visitType;
  const endpoint = visitType === "PLANNED" ? "/visits/planned" : "/visits/unplanned";
  const body = { customerId: data.customerId };
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

// Close dropdown when its nav items are clicked
userDropdown?.querySelectorAll(".nav-btn[data-view]").forEach((item) => {
  item.addEventListener("click", () => closeUserDropdown());
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
      if (target === "dashboard") await loadDashboard();
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

qs("#gear-logs-item")?.addEventListener("click", () => {
  closeGearDropdown();
  navigateToView("integrations");
  switchView("integrations");
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
      if (simpleView === "dashboard") await loadDashboard();
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
    }).catch(() => {});
    const me = await api("/auth/me");
    state.user = me;
    updateUserMeta();
    showApp();
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
    } else {
      window.history.replaceState({ view: "repHub" }, "", "/task");
      switchView("repHub");
      paintRepHubFull();
    }
  } catch {
    localStorage.removeItem("thinkcrm_token");
    state.token = "";
  }
}

// ── QUICK SEARCH ──────────────────────────────────────────────────────────────

(function initQuickSearch() {
  const modal    = qs("#quick-search-modal");
  const backdrop = qs("#qs-backdrop");
  const input    = qs("#qs-input");
  const results  = qs("#qs-results");

  if (!modal || !input || !results) return;

  let activeIdx = -1;

  function openSearch() {
    modal.hidden = false;
    activeIdx = -1;
    input.value = "";
    renderResults("");
    requestAnimationFrame(() => input.focus());
  }

  function closeSearch() {
    modal.hidden = true;
  }

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

  // ── helpers ───────────────────────────────────────────────
  function dealStageOf(dealId) {
    return (state.cache.dealStages || []).find((s) =>
      (s.deals || []).some((x) => x.id === dealId)
    )?.stageName || "";
  }

  function matchesAny(q, ...terms) {
    return terms.filter(Boolean).some((t) => String(t).toLowerCase().includes(q));
  }

  // ── main index builder ────────────────────────────────────
  function buildIndex(query) {
    const q = query.trim().toLowerCase();
    const groups = [];

    // ── 1. ACTIONS ─────────────────────────────────────────
    const ACTION_DEFS = [
      {
        name: "Create Deal",
        meta: "Add a new deal to the pipeline",
        keywords: ["deal", "create", "new", "pipeline", "opportunity"],
        action() {
          closeSearch();
          navigateToView("deals");
          switchView("deals");
          requestAnimationFrame(() => openDealCreateModal(state.cache.kanban));
        }
      },
      {
        name: "Create Visit",
        meta: "Schedule or log a customer visit",
        keywords: ["visit", "create", "new", "schedule", "checkin", "check"],
        action() {
          closeSearch();
          navigateToView("visits");
          switchView("visits");
          requestAnimationFrame(() => openVisitCreateModal());
        }
      },
      {
        name: "Create Quotation",
        meta: "Open Deals to prepare a new quotation",
        keywords: ["quotation", "quote", "quot", "create", "new", "qt"],
        action() {
          closeSearch();
          navigateToView("deals");
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

    // ── 2. DASHBOARD NAV ───────────────────────────────────
    if (!q || matchesAny(q, "dashboard", "report", "kpi", "performance")) {
      groups.push({
        label: "Navigation",
        items: [{
          type: "dashboard",
          name: "Dashboard",
          meta: "KPIs, pipeline, team performance",
          action() { closeSearch(); navigateToView("dashboard"); switchView("dashboard"); }
        }]
      });
    }

    // ── 3. CUSTOMER-CENTRIC SEARCH ─────────────────────────
    // When query matches a customer, show ALL their related records grouped
    if (q) {
      const allDeals = (state.cache.dealStages || []).flatMap((s) => s.deals || []);
      const allVisits = state.cache.visits || [];

      const matchedCustomers = (state.cache.customers || []).filter((c) =>
        matchesAny(q, c.name, c.code, c.email, c.phone)
      );

      matchedCustomers.slice(0, 2).forEach((customer) => {
        const custDeals = allDeals.filter(
          (d) => d.customer?.id === customer.id || d.customerId === customer.id
        );
        const custVisits = allVisits.filter(
          (v) => v.customer?.id === customer.id || v.customerId === customer.id
        );

        const items = [];

        // Customer row
        items.push({
          type: "customer",
          name: customer.name,
          meta: [customer.code, customer.email].filter(Boolean).join(" · ") || "Customer",
          action() { closeSearch(); navigateToMasterPage("customers"); switchView("master"); }
        });

        // Related deals
        custDeals.slice(0, 4).forEach((d) => {
          items.push({
            type: "deal",
            name: d.dealName,
            meta: [d.dealNo, dealStageOf(d.id)].filter(Boolean).join(" · "),
            badge: d.estimatedValue ? asMoney(d.estimatedValue) : null,
            action() { closeSearch(); navigateToView("deals"); switchView("deals"); }
          });
        });

        // Related visits
        custVisits.slice(0, 3).forEach((v) => {
          const dateStr = v.plannedAt ? new Date(v.plannedAt).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" }) : "";
          items.push({
            type: "visit",
            name: `Visit${dateStr ? " · " + dateStr : ""}`,
            meta: [v.visitType, v.status?.replace(/_/g, " "), v.objective].filter(Boolean).join(" · "),
            action() { closeSearch(); navigateToView("visits"); switchView("visits"); }
          });
        });

        // Quotation shortcut if deals exist
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

      // If customer-centric groups were added, skip the generic customer group below
      if (matchedCustomers.length > 0) {
        // Still show non-customer matches: items, deals by name, visits by objective
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
              action() { closeSearch(); navigateToMasterPage("items"); switchView("master"); }
            }))
          });
        }
        return groups;
      }
    }

    // ── 4. STANDARD SEARCH (no specific customer match) ────

    // Customers
    const customers = (state.cache.customers || []).filter((c) =>
      !q || matchesAny(q, c.name, c.code, c.email, c.phone)
    );
    if (customers.length) {
      groups.push({
        label: "Customers",
        items: customers.slice(0, 6).map((c) => ({
          type: "customer",
          name: c.name,
          meta: [c.code, c.email, c.phone].filter(Boolean).join(" · ") || "Customer",
          action() { closeSearch(); navigateToMasterPage("customers"); switchView("master"); }
        }))
      });
    }

    // Items
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
          action() { closeSearch(); navigateToMasterPage("items"); switchView("master"); }
        }))
      });
    }

    // Deals
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
          badge: d.estimatedValue ? asMoney(d.estimatedValue) : null,
          action() { closeSearch(); switchView("deals"); }
        }))
      });
    }

    // Visits
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

  function renderResults(query) {
    const groups = buildIndex(query);
    activeIdx = -1;

    if (!groups.length) {
      results.innerHTML = query.trim()
        ? `<div class="qs-empty"><strong>No results found</strong>Try a customer name, deal number, or action like "create deal"</div>`
        : `<div class="qs-empty"><strong>Start typing to search</strong>Type a customer code to see all their records</div>`;
      return;
    }

    results.innerHTML = groups.map((group) => `
      <div class="qs-group-label">${group.label}</div>
      ${group.items.map((item) => `
        <button class="qs-item qs-item--${item.type}" type="button" role="option">
          ${iconHTML(item.type)}
          <div class="qs-item-body">
            <div class="qs-item-name">${item.name}</div>
            ${item.meta ? `<div class="qs-item-meta">${item.meta}</div>` : ""}
          </div>
          ${item.badge ? `<span class="qs-item-badge">${item.badge}</span>` : ""}
        </button>
      `).join("")}
    `).join("");

    // Wire click handlers after rendering
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

  input.addEventListener("input", () => renderResults(input.value));

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

  qs("#search-btn")?.addEventListener("click", openSearch);
  backdrop?.addEventListener("click", closeSearch);

  document.addEventListener("keydown", (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === "k") {
      e.preventDefault();
      modal.hidden ? openSearch() : closeSearch();
    }
    if (e.key === "Escape" && !modal.hidden) closeSearch();
  });
})();

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

bindVoiceNoteModal();
applyThemeMode("LIGHT");
bootstrap();
