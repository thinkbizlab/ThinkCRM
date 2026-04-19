import { state } from "./state.js";

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

  if (!response.ok) {
    throw new Error(data?.message || `API ${response.status}`);
  }
  return data;
}
