import { state } from "./state.js";

const REFRESH_KEY = "thinkcrm_refresh";
const TOKEN_KEY = "thinkcrm_token";
const IMPERSONATE_FLAG = "thinkcrm_impersonate";

let redirectingToLogin = false;
let inflightRefresh = null;

// In an impersonation tab the access token lives in sessionStorage (per-tab).
// All token IO routes through here so we never touch the admin tab's
// localStorage from the impersonation tab and vice versa. Detected purely
// from sessionStorage so the flag is tab-local — no cross-tab leakage.
function isImpersonating() {
  try { return sessionStorage.getItem(IMPERSONATE_FLAG) === "1"; } catch { return false; }
}

function redirectToLogin() {
  if (redirectingToLogin) return;
  redirectingToLogin = true;
  state.token = "";
  state.user = null;
  try {
    if (isImpersonating()) {
      sessionStorage.removeItem(TOKEN_KEY);
      sessionStorage.removeItem(IMPERSONATE_FLAG);
    } else {
      localStorage.removeItem(TOKEN_KEY);
      localStorage.removeItem(REFRESH_KEY);
    }
  } catch {}
  window.location.replace("/");
}

export function storeTokens({ accessToken, refreshToken }) {
  if (accessToken) {
    state.token = accessToken;
    try {
      if (isImpersonating()) {
        sessionStorage.setItem(TOKEN_KEY, accessToken);
      } else {
        localStorage.setItem(TOKEN_KEY, accessToken);
      }
    } catch {}
  }
  // Refresh tokens are scoped to the real session (admin/normal user). The
  // impersonation flow has no refresh pair — when it 401s, we redirect to
  // login rather than silently elevating back into the admin's session via
  // the inherited refresh token in shared localStorage.
  if (refreshToken && !isImpersonating()) {
    try { localStorage.setItem(REFRESH_KEY, refreshToken); } catch {}
  }
}

export function getRefreshToken() {
  // Impersonation tabs MUST NOT use the admin's refresh token (shared
  // localStorage) — doing so would silently swap the impersonation back into
  // an admin session on the next 401.
  if (isImpersonating()) return "";
  try { return localStorage.getItem(REFRESH_KEY) || ""; } catch { return ""; }
}

export function clearTokens() {
  state.token = "";
  try {
    if (isImpersonating()) {
      sessionStorage.removeItem(TOKEN_KEY);
      sessionStorage.removeItem(IMPERSONATE_FLAG);
    } else {
      localStorage.removeItem(TOKEN_KEY);
      localStorage.removeItem(REFRESH_KEY);
    }
  } catch {}
}

// Exchange the stored refresh token for a new access+refresh pair.
// Returns the new access token on success, or null if refresh failed
// (token missing, expired, revoked, or the server is unreachable).
// Single-flight: concurrent callers share the same refresh request.
export async function refreshAccessToken() {
  if (inflightRefresh) return inflightRefresh;
  const rt = getRefreshToken();
  if (!rt) return null;
  inflightRefresh = (async () => {
    try {
      const res = await fetch("/api/v1/auth/refresh", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ refreshToken: rt })
      });
      if (!res.ok) return null;
      const data = await res.json();
      if (!data?.accessToken) return null;
      storeTokens({ accessToken: data.accessToken, refreshToken: data.refreshToken });
      return data.accessToken;
    } catch {
      return null;
    } finally {
      // Release the lock on next tick so late awaiters still see the resolved value.
      setTimeout(() => { inflightRefresh = null; }, 0);
    }
  })();
  return inflightRefresh;
}

async function doFetch(path, options, token) {
  const isFormData = options.body instanceof FormData;
  const hasBody = options.body !== undefined && options.body !== null;
  const headers = {
    ...(hasBody && !isFormData ? { "content-type": "application/json" } : {}),
    ...(options.headers || {})
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  return fetch(`/api/v1${path}`, {
    method: options.method || "GET",
    headers,
    body: hasBody ? (isFormData ? options.body : JSON.stringify(options.body)) : undefined
  });
}

export async function api(path, options = {}) {
  let response = await doFetch(path, options, state.token);

  // On 401: try refreshing once, then retry the original request.
  if (response.status === 401 && state.token && path !== "/auth/refresh") {
    const newToken = await refreshAccessToken();
    if (newToken) {
      response = await doFetch(path, options, newToken);
    } else {
      const text = await response.text();
      const data = text ? safeJson(text) : null;
      redirectToLogin();
      throw new Error(data?.message || "Session expired. Please sign in again.");
    }
  }

  const text = await response.text();
  const data = text ? safeJson(text) : null;

  if (response.status === 401 && state.token) {
    redirectToLogin();
    throw new Error(data?.message || "Session expired. Please sign in again.");
  }

  if (!response.ok) {
    throw new Error(data?.message || `API ${response.status}`);
  }
  return data;
}

function safeJson(text) {
  try { return JSON.parse(text); } catch { return null; }
}
