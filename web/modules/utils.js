// Pure utility functions — no dependencies on state, DOM, or other modules.

export function escHtml(str) {
  return String(str ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function base64urlToBuffer(base64url) {
  const base64 = base64url.replace(/-/g, "+").replace(/_/g, "/");
  const pad = base64.length % 4 === 0 ? "" : "=".repeat(4 - (base64.length % 4));
  const binary = atob(base64 + pad);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export function bufferToBase64url(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function normalizeHex(value, fallback) {
  if (typeof value !== "string") return fallback;
  const trimmed = value.trim();
  if (/^#[0-9a-fA-F]{6}$/.test(trimmed)) return trimmed;
  if (/^#[0-9a-fA-F]{3}$/.test(trimmed)) {
    return `#${trimmed[1]}${trimmed[1]}${trimmed[2]}${trimmed[2]}${trimmed[3]}${trimmed[3]}`;
  }
  return fallback;
}

export function darkenHex(hex, amount = 26) {
  const parsed = normalizeHex(hex, "#2563eb").slice(1);
  const r = Math.max(0, parseInt(parsed.slice(0, 2), 16) - amount);
  const g = Math.max(0, parseInt(parsed.slice(2, 4), 16) - amount);
  const b = Math.max(0, parseInt(parsed.slice(4, 6), 16) - amount);
  return `#${r.toString(16).padStart(2, "0")}${g.toString(16).padStart(2, "0")}${b.toString(16).padStart(2, "0")}`;
}

export function lightenHex(hex, amount = 26) {
  const parsed = normalizeHex(hex, "#2563eb").slice(1);
  const r = Math.min(255, parseInt(parsed.slice(0, 2), 16) + amount);
  const g = Math.min(255, parseInt(parsed.slice(2, 4), 16) + amount);
  const b = Math.min(255, parseInt(parsed.slice(4, 6), 16) + amount);
  return `#${r.toString(16).padStart(2, "0")}${g.toString(16).padStart(2, "0")}${b.toString(16).padStart(2, "0")}`;
}

export function tintHex(hex, ratio) {
  const parsed = normalizeHex(hex, "#2563eb").slice(1);
  const r = Math.round(parseInt(parsed.slice(0, 2), 16) + (255 - parseInt(parsed.slice(0, 2), 16)) * ratio);
  const g = Math.round(parseInt(parsed.slice(2, 4), 16) + (255 - parseInt(parsed.slice(2, 4), 16)) * ratio);
  const b = Math.round(parseInt(parsed.slice(4, 6), 16) + (255 - parseInt(parsed.slice(4, 6), 16)) * ratio);
  return `#${r.toString(16).padStart(2, "0")}${g.toString(16).padStart(2, "0")}${b.toString(16).padStart(2, "0")}`;
}

export function prettyLabel(value) {
  return String(value)
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

const dateTime = new Intl.DateTimeFormat("en-GB", {
  year: "numeric",
  month: "short",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit"
});

export function asDate(value) {
  if (!value) return "-";
  return dateTime.format(new Date(value));
}

export function asDateInput(value) {
  if (!value) return "";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "";
  return d.toISOString().slice(0, 10);
}

export function asPercent(value) {
  if (value == null || Number.isNaN(Number(value))) return "0.00";
  return Number(value).toFixed(2);
}

export function shiftAnchorDate(anchorDate, view, direction) {
  const d = new Date(anchorDate || new Date().toISOString());
  const amount = direction === "next" ? 1 : -1;
  if (view === "year") d.setUTCFullYear(d.getUTCFullYear() + amount);
  if (view === "month") d.setUTCMonth(d.getUTCMonth() + amount);
  if (view === "day") d.setUTCDate(d.getUTCDate() + amount);
  return d.toISOString();
}

export function debounce(fn, ms = 250) {
  let t;
  return function (...args) {
    clearTimeout(t);
    t = setTimeout(() => fn.apply(this, args), ms);
  };
}

const MONTHS_SHORT = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
export function fmtDateTime(dateOrStr) {
  const d = dateOrStr instanceof Date ? dateOrStr : new Date(dateOrStr);
  const pad = (n, w = 2) => String(n).padStart(w, "0");
  return `${pad(d.getDate())}-${MONTHS_SHORT[d.getMonth()]}-${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}
