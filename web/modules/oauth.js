// OAuth login helpers: probes which providers are enabled for the workspace,
// wires the provider buttons, and handles the redirect-back code exchange.
// Post-login orchestration (token storage, navigation) stays in the host so
// this module doesn't need to know about app-level state.
import { qs } from "./dom.js";

// Show / hide the MS365, Google, and passkey buttons based on what the
// server reports as configured for this workspace and what the browser supports.
//
// While the providers fetch is in flight, the #oauth-loading skeleton (3
// animated placeholder bars) is visible inside #oauth-providers — so the
// section appears at the same time as the username/password fields rather
// than popping in 1-3 seconds later. When the fetch resolves we hide the
// skeleton and swap in the actual buttons; if zero buttons would render we
// hide the entire panel including the "or sign in with" divider.
//
// Per-tenant configuration: tenant admins toggle which sign-in options are
// shown via Settings → Branding (loginShowGoogle / loginShowMicrosoft /
// loginShowPasskey / loginShowSignup flags). The branding fetch sets
// data-loginHiddenByAdmin on the relevant buttons before this runs.
export async function loadOAuthProviderButtons({ getTenantSlug } = {}) {
  const panel    = qs("#oauth-providers");
  const loading  = qs("#oauth-loading");
  const btnsWrap = qs("#oauth-btns");
  const ms365Btn  = qs("#oauth-ms365-btn");
  const googleBtn = qs("#oauth-google-btn");
  const passkeyBtn = qs("#oauth-passkey-btn");
  if (!panel || !ms365Btn || !googleBtn) return;

  const finish = ({ ms365 = false, google = false } = {}) => {
    const hiddenByAdmin = (el) => el?.dataset?.loginHiddenByAdmin === "true";
    const webauthnSupported = !!(window.PublicKeyCredential);
    const passkeyAllowed = webauthnSupported && !hiddenByAdmin(passkeyBtn);
    const ms365Allowed   = ms365  && !hiddenByAdmin(ms365Btn);
    const googleAllowed  = google && !hiddenByAdmin(googleBtn);
    if (passkeyBtn) passkeyBtn.hidden = !passkeyAllowed;
    ms365Btn.hidden  = !ms365Allowed;
    googleBtn.hidden = !googleAllowed;
    if (loading) loading.hidden = true;
    if (btnsWrap) btnsWrap.hidden = false;
    // If nothing would render, hide the whole section (including the divider)
    // so the login page collapses to just username/password.
    panel.hidden = !ms365Allowed && !googleAllowed && !passkeyAllowed;
  };

  try {
    const slug = getTenantSlug?.();
    const url = slug
      ? `/api/v1/auth/oauth/providers?tenantSlug=${encodeURIComponent(slug)}`
      : "/api/v1/auth/oauth/providers";
    const res = await fetch(url);
    if (!res.ok) { finish(); return; }
    finish(await res.json());
  } catch {
    // Network failure / OAuth fetch optional — fall through with everything off.
    finish();
  }
}

// Wire the MS365 / Google buttons so a click redirects to the provider.
// `getTenantSlug()` returns the current workspace slug from the login form.
// `onMissingSlug(message)` is fired when the user clicks before entering one.
export function wireOAuthProviderButtons({ getTenantSlug, onMissingSlug }) {
  const start = (provider) => {
    const slug = getTenantSlug();
    if (!slug) { onMissingSlug?.("Please enter your workspace first."); return; }
    window.location.href = `/api/v1/auth/oauth/${provider}?tenantSlug=${encodeURIComponent(slug)}`;
  };
  qs("#oauth-ms365-btn")?.addEventListener("click", () => start("ms365"));
  qs("#oauth-google-btn")?.addEventListener("click", () => start("google"));
}

// Detect ?oauth_code / ?oauth_error on page load. If a code is present, exchange
// it for a JWT, fetch the user, and resolve `{ token, user }`. Returns null if
// no OAuth params are on the URL. Calls `onError(message)` on any failure.
export async function consumeOAuthCallback({ onError } = {}) {
  const params = new URLSearchParams(window.location.search);
  const oauthCode  = params.get("oauth_code");
  const oauthError = params.get("oauth_error");
  if (!oauthCode && !oauthError) return null;
  // Clean URL immediately so the code doesn't linger in history
  window.history.replaceState({}, "", window.location.pathname);
  if (oauthError) {
    onError?.(oauthError);
    return null;
  }
  try {
    const exchangeRes = await fetch("/api/v1/auth/oauth/exchange", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code: oauthCode })
    });
    if (!exchangeRes.ok) throw new Error("Login succeeded but the session code was invalid. Please try again.");
    const { token, refreshToken } = await exchangeRes.json();

    const meRes = await fetch("/api/v1/auth/me", {
      headers: { Authorization: `Bearer ${token}` }
    });
    if (!meRes.ok) throw new Error("Login succeeded but could not load your profile. Please try again.");
    const user = await meRes.json();
    return { token, refreshToken, user };
  } catch (e) {
    onError?.(e.message);
    return null;
  }
}
