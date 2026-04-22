import { state } from "./state.js";

let redirectingToLogin = false;
function redirectToLogin() {
  if (redirectingToLogin) return;
  redirectingToLogin = true;
  state.token = "";
  state.user = null;
  try { localStorage.removeItem("thinkcrm_token"); } catch {}
  window.location.replace("/");
}

export async function api(path, options = {}) {
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

  if (response.status === 401 && state.token) {
    redirectToLogin();
    throw new Error(data?.message || "Session expired. Please sign in again.");
  }

  if (!response.ok) {
    throw new Error(data?.message || `API ${response.status}`);
  }
  return data;
}
