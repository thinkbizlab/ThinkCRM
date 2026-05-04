import { api } from "./api.js";
import { qs, views, showTrialBanner, setStatus } from "./dom.js";
import { icon } from "./icons.js";
import { state } from "./state.js";
import { escHtml } from "./utils.js";

let deps = {
  CURRENCIES: [],
  getActiveCurrency: () => "THB",
  CURRENCY_STORAGE_KEY: "thinkcrm_currency",
  getThemePresets: () => [],
  findPresetBySlug: () => null,
  renderThemeRow: () => "",
  applyBrandingTheme: () => {},
  applyThemeMode: () => {},
  renderDeals: () => {},
  renderDashboard: () => {},
  loadSettings: async () => {},
  renderSettings: () => {},
  loadMaster: async () => {}
};

export function setSettingsAdminDeps(nextDeps) {
  deps = { ...deps, ...nextDeps };
}

export function renderCompanySettingsPage({
  isAdmin = false,
  tax = { vatEnabled: true, vatRatePercent: 7 },
  visitCfg = { checkInMaxDistanceM: 1000, minVisitDurationMinutes: 15 },
  masterLock = {
    manageCustomersByApi: false,
    manageItemsByApi: false,
    managePaymentTermsByApi: false,
    manageCustomerGroupsByApi: false
  },
  tenantInfo = {}
} = {}) {
  const { CURRENCIES, getActiveCurrency } = deps;

  const csec = (title, body) => `
    <section class="card settings-collapsible" data-collapsed="true">
      <button type="button" class="settings-section-toggle">
        <span class="section-title">${title}</span>
        <svg class="settings-collapse-icon" width="16" height="16" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="6 9 12 15 18 9"/></svg>
      </button>
      <div class="settings-section-body">${body}</div>
    </section>`;

  const sub = state.user?.subscription;
  const subscriptionHtml = (() => {
    if (!sub || !isAdmin) return "";
    const isTrialing = sub.status === "TRIALING";
    const daysLeft = sub.trialEndsAt
      ? Math.max(0, Math.ceil((new Date(sub.trialEndsAt) - Date.now()) / 86400000))
      : null;
    const trialEndDate = sub.trialEndsAt
      ? new Date(sub.trialEndsAt).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" })
      : "-";
    const statusBadge = {
      TRIALING: `<span class="badge badge--warning">Trial</span>`,
      ACTIVE: `<span class="badge badge--success">Active</span>`,
      PAST_DUE: `<span class="badge badge--danger">Past Due</span>`,
      CANCELED: `<span class="badge badge--danger">Canceled</span>`
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
  })();

  return `
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
            ${CURRENCIES.map((currency) => `<option value="${currency.code}" ${getActiveCurrency() === currency.code ? "selected" : ""}>${currency.label}</option>`).join("")}
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
              ["Pacific/Midway", "-11:00 Midway Island"], ["Pacific/Honolulu", "-10:00 Hawaii"], ["America/Anchorage", "-09:00 Alaska"],
              ["America/Los_Angeles", "-08:00 Pacific Time (US)"], ["America/Denver", "-07:00 Mountain Time (US)"],
              ["America/Chicago", "-06:00 Central Time (US)"], ["America/New_York", "-05:00 Eastern Time (US)"],
              ["America/Bogota", "-05:00 Bogota, Lima"], ["America/Caracas", "-04:30 Caracas"],
              ["America/Halifax", "-04:00 Atlantic Time (Canada)"], ["America/Sao_Paulo", "-03:00 Brasilia"],
              ["Atlantic/Azores", "-01:00 Azores"], ["UTC", "+/-00:00 UTC"], ["Europe/London", "+00:00 London, Dublin"],
              ["Europe/Paris", "+01:00 Paris, Madrid, Rome"], ["Europe/Helsinki", "+02:00 Helsinki, Kiev"],
              ["Europe/Moscow", "+03:00 Moscow"], ["Asia/Tehran", "+03:30 Tehran"],
              ["Asia/Dubai", "+04:00 Dubai, Abu Dhabi"], ["Asia/Kabul", "+04:30 Kabul"],
              ["Asia/Karachi", "+05:00 Karachi, Islamabad"], ["Asia/Kolkata", "+05:30 Mumbai, Kolkata"],
              ["Asia/Kathmandu", "+05:45 Kathmandu"], ["Asia/Dhaka", "+06:00 Dhaka"],
              ["Asia/Rangoon", "+06:30 Yangon"], ["Asia/Bangkok", "+07:00 Bangkok, Hanoi, Jakarta"],
              ["Asia/Ho_Chi_Minh", "+07:00 Ho Chi Minh City"], ["Asia/Singapore", "+08:00 Singapore, Kuala Lumpur"],
              ["Asia/Shanghai", "+08:00 Beijing, Shanghai"], ["Asia/Taipei", "+08:00 Taipei"],
              ["Asia/Manila", "+08:00 Manila"], ["Asia/Seoul", "+09:00 Seoul"],
              ["Asia/Tokyo", "+09:00 Tokyo, Osaka"], ["Australia/Adelaide", "+09:30 Adelaide"],
              ["Australia/Sydney", "+10:00 Sydney, Melbourne"], ["Pacific/Noumea", "+11:00 New Caledonia"],
              ["Pacific/Auckland", "+12:00 Auckland"]
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

    ${csec("Master Data - Manage by API", isAdmin ? `
      <form id="master-api-lock-form" class="settings-form">
        <p style="margin:0 0 var(--sp-3);font-size:0.83rem;color:var(--muted-color)">
          When a toggle is ON, the corresponding master entity can only be changed through the sync API (X-Api-Key). UI actions (create / edit / delete / import) on that entity are disabled tenant-wide. Use this when an ERP is the authoritative source.
        </p>
        <label class="settings-checkbox-label">
          <input name="manageCustomersByApi" type="checkbox" ${masterLock.manageCustomersByApi ? "checked" : ""} />
          Manage <strong>Customer</strong> by API only
        </label>
        <label class="settings-checkbox-label">
          <input name="manageItemsByApi" type="checkbox" ${masterLock.manageItemsByApi ? "checked" : ""} />
          Manage <strong>Item</strong> by API only
        </label>
        <label class="settings-checkbox-label">
          <input name="managePaymentTermsByApi" type="checkbox" ${masterLock.managePaymentTermsByApi ? "checked" : ""} />
          Manage <strong>Payment Term</strong> by API only
        </label>
        <label class="settings-checkbox-label">
          <input name="manageCustomerGroupsByApi" type="checkbox" ${masterLock.manageCustomerGroupsByApi ? "checked" : ""} />
          Manage <strong>Customer Group</strong> by API only
        </label>
        <button type="submit">Save Master Data Lock</button>
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

    ${subscriptionHtml}
  `;
}

export function renderBrandingSettingsPage({
  branding = {},
  brandingTokens = {},
  activePresetSlug = "custom",
  isAdmin = false
} = {}) {
  const { findPresetBySlug, getThemePresets, renderThemeRow } = deps;

  return `
    <section class="card">
      <h3 class="section-title">${icon("palette")} Logo &amp; Colors</h3>
      ${isAdmin ? `
      <form id="branding-form" class="settings-form">
        <div class="brand-assets-row">
          <div class="brand-asset-col">
            <p class="form-label" style="margin-bottom:var(--sp-2)">Company Logo</p>
            <div class="logo-upload-area" id="logo-upload-area">
              <img src="${branding.logoUrl || "/default-brand.svg"}" class="logo-upload-preview" id="logo-preview" alt="Current logo" />
              <span class="logo-upload-change-hint">${branding.logoUrl ? "Click to change" : "Default - click to upload"}</span>
              <input type="file" name="logoFile" id="logo-file-input" accept="image/*" class="logo-file-input" />
            </div>
          </div>
          <div class="brand-asset-col brand-asset-col--favicon">
            <p class="form-label" style="margin-bottom:var(--sp-2)">Favicon</p>
            <div class="logo-upload-area favicon-upload-area" id="favicon-upload-area">
              <img src="${branding.faviconUrl || "/default-brand.svg"}" class="favicon-upload-preview" id="favicon-preview" alt="Current favicon" />
              <span class="logo-upload-change-hint">${branding.faviconUrl ? "Click to change" : "Default - click to upload"}</span>
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
                  .map((color) => `<span style="background:${escHtml(color)}"></span>`).join("")}
              </span>
              <span class="theme-preset-name" data-role="preset-name">${escHtml(findPresetBySlug(activePresetSlug)?.name || "Custom Theme")}</span>
              ${icon("chevronDown", 14, "theme-preset-chevron")}
              <select class="theme-preset-select" name="themePreset" aria-label="Theme preset">
                <option value="custom"${activePresetSlug === "custom" ? " selected" : ""}>Custom Theme</option>
                ${getThemePresets().map((preset) => `<option value="${preset.slug}"${activePresetSlug === preset.slug ? " selected" : ""}>${escHtml(preset.name)}</option>`).join("")}
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
                  <span class="muted" style="font-size:0.78rem">deg</span>
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
              <option value="LIGHT"${(branding.themeMode || "LIGHT") === "LIGHT" ? " selected" : ""}>Light</option>
              <option value="DARK"${branding.themeMode === "DARK" ? " selected" : ""}>Dark</option>
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
              <span class="logo-upload-change-hint">${branding.loginHeroImageUrl ? "Click to change" : "Optional - click to upload"}</span>
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
              <input class="form-input" name="loginFooterText" maxlength="200" placeholder="(c) 2026 Acme Co. All rights reserved." value="${escHtml(branding.loginFooterText || "")}" style="margin-top:var(--sp-1)" />
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
          <p class="muted small" style="margin-top:var(--sp-2)">
            Visible sign-in options moved to <strong>Settings &rarr; Login Methods</strong>.
          </p>
        </details>
        <div style="display:flex;gap:var(--sp-2);align-items:center;flex-wrap:wrap">
          <button type="submit">Save Branding</button>
          <button type="button" id="branding-restore-default" class="ghost">Restore to Default</button>
        </div>
      </form>
      ` : `<div class="muted">Admin access required.</div>`}
    </section>
  `;
}

export function wireCompanySettingsPage({ tenantId }) {
  const { loadSettings, loadMaster, renderDeals, renderDashboard, CURRENCY_STORAGE_KEY } = deps;
  const content = qs(".settings-content");

  content?.querySelectorAll(".settings-section-toggle").forEach((btn) => {
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
    const btn = event.currentTarget.querySelector("button[type='submit']");
    const days = parseInt(qs("#extend-trial-days")?.value || "0", 10);
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

  qs("#master-api-lock-form")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const fd = new FormData(event.currentTarget);
    try {
      await api(`/tenants/${tenantId}/master-api-lock`, {
        method: "PUT",
        body: {
          manageCustomersByApi: !!fd.get("manageCustomersByApi"),
          manageItemsByApi: !!fd.get("manageItemsByApi"),
          managePaymentTermsByApi: !!fd.get("managePaymentTermsByApi"),
          manageCustomerGroupsByApi: !!fd.get("manageCustomerGroupsByApi")
        }
      });
      setStatus("Master data lock saved.");
      await loadSettings();
      try {
        state.user = await api("/auth/me");
      } catch {}
      await loadMaster();
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
}

export function wireBrandingSettingsPage({ tenantId, tenantThemeMode = "LIGHT", branding = {} }) {
  const {
    findPresetBySlug,
    applyBrandingTheme,
    loadSettings,
    renderSettings
  } = deps;
  const root = views.settings;
  const q = (selector) => root.querySelector(selector);

  const wireUploadArea = (areaSelector, inputSelector, previewSelector) => {
    const area = q(areaSelector);
    const input = q(inputSelector);
    if (!area || !input) return;

    area.addEventListener("click", () => input.click());
    area.addEventListener("dragover", (event) => {
      event.preventDefault();
      area.classList.add("drag-over");
    });
    area.addEventListener("dragleave", () => area.classList.remove("drag-over"));
    area.addEventListener("drop", (event) => {
      event.preventDefault();
      area.classList.remove("drag-over");
      const file = event.dataTransfer?.files?.[0];
      if (!file) return;
      const dt = new DataTransfer();
      dt.items.add(file);
      input.files = dt.files;
      input.dispatchEvent(new Event("change"));
    });
    input.addEventListener("change", () => {
      const file = input.files?.[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = (event) => {
        const preview = q(previewSelector);
        if (preview) preview.src = event.target.result;
        const hint = area.querySelector(".logo-upload-change-hint");
        if (hint) hint.textContent = "Click to change";
      };
      reader.readAsDataURL(file);
    });
  };

  ["primary", "secondary"].forEach((key) => {
    const picker = q(`[name="${key}ColorPicker"]`);
    const text = q(`[name="${key}Color"]`);
    if (!picker || !text) return;
    picker.addEventListener("input", () => {
      text.value = picker.value;
    });
    text.addEventListener("input", () => {
      if (/^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(text.value)) {
        picker.value = text.value;
      }
    });
  });

  wireUploadArea("#logo-upload-area", "#logo-file-input", "#logo-preview");
  wireUploadArea("#favicon-upload-area", "#favicon-file-input", "#favicon-preview");
  wireUploadArea("#login-hero-upload-area", "#login-hero-file-input", "#login-hero-preview");

  const gradientHidden = q('[name="accentGradientEnabled"]');
  const gradientControls = q(".gradient-controls");
  const refreshGradientPreview = () => {
    const swatch = q("#gradient-preview-swatch");
    if (!swatch) return;
    const primary = q('[name="primaryColor"]')?.value || "#7c3aed";
    const gradient = q('[name="accentGradientColor"]')?.value || "#ec4899";
    const angle = q('[name="accentGradientAngle"]')?.value || 135;
    swatch.style.background = `linear-gradient(${angle}deg, ${primary}, ${gradient})`;
  };

  const collectThemeDraft = () => {
    const read = (name) => q(`[name="${name}"]`)?.value || "";
    return {
      primaryColor: read("primaryColor") || "#7c3aed",
      secondaryColor: read("secondaryColor") || "#0f172a",
      themeTokens: {
        background: read("tokenBackground"),
        text: read("tokenText"),
        accent: read("tokenAccent"),
        card: read("tokenCard"),
        muted: read("tokenMuted"),
        border: read("tokenBorder"),
        destructive: read("tokenDestructive"),
        radius: Number(read("tokenRadius")) || 12,
        shadow: read("tokenShadow") || "MD"
      },
      accentGradientEnabled: q('[name="accentGradientEnabled"]')?.value === "true",
      accentGradientColor: read("accentGradientColor"),
      accentGradientAngle: Number(read("accentGradientAngle")) || 135,
      themeMode: read("themeMode") || "LIGHT",
      appName: branding.appName,
      logoUrl: branding.logoUrl,
      faviconUrl: branding.faviconUrl
    };
  };

  const refreshPresetChrome = (slug) => {
    const preset = findPresetBySlug(slug);
    const nameEl = q('[data-role="preset-name"]');
    const swatchEl = q('[data-role="preset-swatches"]');
    if (nameEl) nameEl.textContent = preset?.name || "Custom Theme";
    if (swatchEl) {
      const swatches = preset?.swatches || (() => {
        const draft = collectThemeDraft();
        return [draft.themeTokens.background, draft.secondaryColor, draft.primaryColor];
      })();
      swatchEl.innerHTML = swatches.map((color) => `<span style="background:${escHtml(color)}"></span>`).join("");
    }
  };

  const livePreview = () => {
    applyBrandingTheme(collectThemeDraft());
  };

  const setPresetSelect = (slug) => {
    const select = q('[name="themePreset"]');
    if (select && select.value !== slug) select.value = slug;
    refreshPresetChrome(slug);
  };

  const markCustom = () => setPresetSelect("custom");

  const segmentedItems = root.querySelectorAll(".accent-mode-row .segmented-item");
  segmentedItems.forEach((btn) => {
    btn.addEventListener("click", () => {
      const enabled = btn.dataset.value === "true";
      segmentedItems.forEach((item) => item.setAttribute("aria-selected", String(item === btn)));
      if (gradientHidden) gradientHidden.value = enabled ? "true" : "false";
      if (gradientControls) gradientControls.style.display = enabled ? "" : "none";
      livePreview();
    });
  });

  q('[name="accentGradientColorPicker"]')?.addEventListener("input", (event) => {
    const hex = q('[name="accentGradientColor"]');
    if (hex) hex.value = event.target.value;
    refreshGradientPreview();
  });
  q('[name="accentGradientColor"]')?.addEventListener("input", (event) => {
    const picker = q('[name="accentGradientColorPicker"]');
    if (picker && /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(event.target.value)) picker.value = event.target.value;
    refreshGradientPreview();
  });
  q('[name="accentGradientAngleRange"]')?.addEventListener("input", (event) => {
    const input = q('[name="accentGradientAngle"]');
    if (input) input.value = event.target.value;
    refreshGradientPreview();
  });
  q('[name="accentGradientAngle"]')?.addEventListener("input", (event) => {
    const range = q('[name="accentGradientAngleRange"]');
    if (range) range.value = event.target.value;
    refreshGradientPreview();
  });

  const themeColorInputs = [
    "tokenBackground", "tokenText", "tokenAccent",
    "tokenCard", "tokenMuted", "tokenBorder", "tokenDestructive",
    "primaryColor", "secondaryColor"
  ];

  themeColorInputs.forEach((name) => {
    const picker = q(`[name="${name}Picker"]`);
    const input = q(`[name="${name}"]`);
    picker?.addEventListener("input", (event) => {
      if (input) input.value = event.target.value;
      markCustom();
      livePreview();
      refreshGradientPreview();
    });
    input?.addEventListener("input", (event) => {
      if (picker && /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(event.target.value)) picker.value = event.target.value;
      markCustom();
      livePreview();
      refreshGradientPreview();
    });
  });

  q('[name="tokenRadiusRange"]')?.addEventListener("input", (event) => {
    const input = q('[name="tokenRadius"]');
    if (input) input.value = event.target.value;
    markCustom();
    livePreview();
  });
  q('[name="tokenRadius"]')?.addEventListener("input", (event) => {
    const range = q('[name="tokenRadiusRange"]');
    if (range) range.value = event.target.value;
    markCustom();
    livePreview();
  });
  q('[name="tokenShadow"]')?.addEventListener("change", () => {
    markCustom();
    livePreview();
  });

  q('[name="themePreset"]')?.addEventListener("change", (event) => {
    const slug = event.target.value;
    if (slug === "custom") {
      refreshPresetChrome("custom");
      return;
    }
    const preset = findPresetBySlug(slug);
    if (!preset) return;

    const setValue = (name, value) => {
      const input = q(`[name="${name}"]`);
      if (input) input.value = value;
      const picker = q(`[name="${name}Picker"]`);
      if (picker && typeof value === "string" && /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(value)) {
        picker.value = value;
      }
    };

    const tokens = preset.tokens;
    setValue("primaryColor", tokens.primaryColor);
    setValue("secondaryColor", tokens.secondaryColor);
    setValue("tokenBackground", tokens.background);
    setValue("tokenText", tokens.text);
    setValue("tokenAccent", tokens.accent);
    setValue("tokenCard", tokens.card);
    setValue("tokenMuted", tokens.muted);
    setValue("tokenBorder", tokens.border);
    setValue("tokenDestructive", tokens.destructive);
    const radiusNumber = q('[name="tokenRadius"]');
    if (radiusNumber) radiusNumber.value = tokens.radius;
    const radiusRange = q('[name="tokenRadiusRange"]');
    if (radiusRange) radiusRange.value = tokens.radius;
    const shadowSelect = q('[name="tokenShadow"]');
    if (shadowSelect) shadowSelect.value = tokens.shadow;
    refreshPresetChrome(slug);
    livePreview();
  });

  q("#branding-form")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const submitBtn = form.querySelector('button[type="submit"]');
    const originalBtnText = submitBtn?.textContent;
    if (submitBtn) {
      submitBtn.disabled = true;
      submitBtn.textContent = "Saving...";
    }
    try {
      const fd = new FormData(form);
      const uploadAsset = async (fieldName, endpoint, resultKey, previewSelector) => {
        const file = fd.get(fieldName);
        if (!(file instanceof File) || file.size <= 0) return;
        const uploadFd = new FormData();
        uploadFd.append("file", file, file.name);
        const uploadResult = await api(endpoint, { method: "POST", body: uploadFd });
        if (uploadResult?.[resultKey]) fd.set(resultKey, uploadResult[resultKey]);
        const previewSrc = uploadResult?.[`${resultKey.replace(/Url$/, "DownloadUrl")}`] || uploadResult?.[resultKey];
        if (previewSrc) {
          const preview = q(previewSelector);
          if (preview) preview.src = previewSrc;
        }
      };

      try {
        await uploadAsset("logoFile", `/tenants/${tenantId}/branding/logo`, "logoUrl", "#logo-preview");
        await uploadAsset("faviconFile", `/tenants/${tenantId}/branding/favicon`, "faviconUrl", "#favicon-preview");
        await uploadAsset("loginHeroFile", `/tenants/${tenantId}/branding/login-hero`, "loginHeroImageUrl", "#login-hero-preview");
      } catch (error) {
        setStatus(error.message, true);
        return;
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
      // loginShow* fields moved to Settings → Login Methods. Don't include
      // them in this PUT; the server's branding upsert would otherwise
      // overwrite the per-tenant choices (the form no longer has those
      // checkboxes so fd.get returns null → "false" → silent regression).
      payload.themeTokens = {
        background: fd.get("tokenBackground") || undefined,
        text: fd.get("tokenText") || undefined,
        accent: fd.get("tokenAccent") || undefined,
        card: fd.get("tokenCard") || undefined,
        muted: fd.get("tokenMuted") || undefined,
        border: fd.get("tokenBorder") || undefined,
        destructive: fd.get("tokenDestructive") || undefined,
        radius: Number(fd.get("tokenRadius")) || 12,
        shadow: fd.get("tokenShadow") || "MD"
      };
      [
        "themePreset",
        "tokenBackground", "tokenBackgroundPicker",
        "tokenText", "tokenTextPicker",
        "tokenAccent", "tokenAccentPicker",
        "tokenCard", "tokenCardPicker",
        "tokenMuted", "tokenMutedPicker",
        "tokenBorder", "tokenBorderPicker",
        "tokenDestructive", "tokenDestructivePicker",
        "tokenRadius", "tokenRadiusRange", "tokenShadow"
      ].forEach((key) => delete payload[key]);

      await api(`/tenants/${tenantId}/branding`, { method: "PUT", body: payload });
      setStatus("Branding saved.");
      await loadSettings();
    } catch (error) {
      setStatus(error.message, true);
    } finally {
      if (submitBtn) {
        submitBtn.disabled = false;
        submitBtn.textContent = originalBtnText || "Save Branding";
      }
    }
  });

  q("#branding-restore-default")?.addEventListener("click", async (event) => {
    const btn = event.currentTarget;
    if (!confirm("Restore branding to defaults? App name, colors, gradient, theme mode, and login-screen customizations will be reset. Logo, favicon, and hero image will be kept.")) return;
    btn.disabled = true;
    const original = btn.textContent;
    btn.textContent = "Restoring...";
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
          loginSupportEmail: ""
          // loginShow* are owned by Settings → Login Methods; restore-default
          // here is for visual branding only.
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

  void tenantThemeMode;
  void renderSettings;
}

// ── Login Methods ──────────────────────────────────────────────────────────
//
// Per-tenant control over which sign-in options the login page shows. Backed
// by the four loginShow* boolean fields on TenantBranding (originally lived
// inside the Branding page; broken out so admins find them without scanning
// a long branding form).
//
// Saving uses PUT /tenants/:id/branding/login-methods which only touches
// these four columns — the full /branding endpoint would re-fill themeMode
// to "LIGHT" (it has a default) and silently flip the theme.

export function renderLoginMethodsPage({ branding, isAdmin }) {
  const b = branding ?? {};
  const isOn = (v) => v !== false; // undefined/null also default to on
  const row = (name, label, hint) => `
    <label class="settings-toggle-row">
      <input type="checkbox" name="${name}" ${isOn(b[name]) ? "checked" : ""} />
      <div class="settings-toggle-text">
        <span class="settings-toggle-label">${escHtml(label)}</span>
        ${hint ? `<span class="settings-toggle-hint">${escHtml(hint)}</span>` : ""}
      </div>
    </label>
  `;
  return `
    <section class="card">
      <header class="settings-section-header">
        <h3 class="section-title">Login Methods</h3>
        <p class="muted small">Choose which sign-in options appear on this workspace's login page. Note: a method only appears if both this toggle is on <strong>and</strong> the platform credentials for that provider are configured (Settings → Integrations).</p>
      </header>
      ${isAdmin ? `
      <form id="login-methods-form" class="settings-form">
        <div class="settings-toggle-list">
          ${row("loginShowSignup",    "Show \\"Create a new workspace\\" link",
                "Lets visitors start a brand-new tenant from the login page. Turn off if signups are invite-only.")}
          ${row("loginShowGoogle",    "Show Google / Gmail sign-in",
                "Requires a configured Google OAuth credential for this tenant (or a platform-level fallback).")}
          ${row("loginShowMicrosoft", "Show Microsoft 365 sign-in",
                "Requires a configured MS365 OAuth credential. Often used by tenants that standardise on Office 365.")}
          ${row("loginShowPasskey",   "Show Passkey sign-in",
                "Lets users sign in via WebAuthn (Touch ID / Face ID / hardware key) if their browser supports it.")}
        </div>
        <div style="display:flex;gap:var(--sp-2);align-items:center;margin-top:var(--sp-3)">
          <button type="submit">Save Login Methods</button>
        </div>
      </form>
      ` : `<div class="muted">Admin access required.</div>`}
    </section>
  `;
}

export function wireLoginMethodsPage({ tenantId }) {
  const { loadSettings } = deps;
  const form = qs("#login-methods-form");
  if (!form) return;
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const submitBtn = form.querySelector('button[type="submit"]');
    const originalText = submitBtn?.textContent;
    if (submitBtn) { submitBtn.disabled = true; submitBtn.textContent = "Saving..."; }
    try {
      const fd = new FormData(form);
      const body = {
        loginShowSignup:    fd.get("loginShowSignup")    === "on",
        loginShowGoogle:    fd.get("loginShowGoogle")    === "on",
        loginShowMicrosoft: fd.get("loginShowMicrosoft") === "on",
        loginShowPasskey:   fd.get("loginShowPasskey")   === "on"
      };
      await api(`/tenants/${tenantId}/branding/login-methods`, { method: "PUT", body });
      setStatus("Login methods saved.");
      await loadSettings?.();
    } catch (error) {
      setStatus(error.message, true);
    } finally {
      if (submitBtn) { submitBtn.disabled = false; submitBtn.textContent = originalText || "Save Login Methods"; }
    }
  });
}
