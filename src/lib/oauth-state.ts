/**
 * Short-lived in-memory state store for OAuth CSRF protection.
 * Each state entry expires after 10 minutes.
 */

import { randomUUID } from "node:crypto";

const TTL_MS = 10 * 60 * 1000; // 10 minutes

// ── Login flow (stores tenantSlug only) ───────────────────────────────────────

interface OAuthStateEntry {
  tenantSlug: string;
  createdAt: number;
}

const store = new Map<string, OAuthStateEntry>();

setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of store) {
    if (now - entry.createdAt > TTL_MS) store.delete(key);
  }
}, 5 * 60 * 1000);

export function createOAuthState(tenantSlug: string): string {
  const state = randomUUID();
  store.set(state, { tenantSlug, createdAt: Date.now() });
  return state;
}

export function consumeOAuthState(state: string): string | null {
  const entry = store.get(state);
  if (!entry) return null;
  store.delete(state);
  if (Date.now() - entry.createdAt > TTL_MS) return null;
  return entry.tenantSlug;
}

// ── Connect flow (stores tenantSlug + userId — shared by LINE / Teams / Slack) ─

interface ConnectStateEntry {
  tenantSlug: string;
  userId: string;
  createdAt: number;
}

const connectStore = new Map<string, ConnectStateEntry>();

setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of connectStore) {
    if (now - entry.createdAt > TTL_MS) connectStore.delete(key);
  }
}, 5 * 60 * 1000);

export function createConnectState(tenantSlug: string, userId: string): string {
  const state = randomUUID();
  connectStore.set(state, { tenantSlug, userId, createdAt: Date.now() });
  return state;
}

export function consumeConnectState(state: string): { tenantSlug: string; userId: string } | null {
  const entry = connectStore.get(state);
  if (!entry) return null;
  connectStore.delete(state);
  if (Date.now() - entry.createdAt > TTL_MS) return null;
  return { tenantSlug: entry.tenantSlug, userId: entry.userId };
}

// LINE-specific aliases (kept for backward compatibility)
export const createLineConnectState = createConnectState;
export const consumeLineConnectState = consumeConnectState;
