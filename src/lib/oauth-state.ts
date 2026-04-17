/**
 * DB-backed OAuth state store for CSRF protection.
 * Replaces the previous in-memory Map implementation, which broke on restarts
 * and would not work with multiple server instances.
 *
 * Each state entry expires after 10 minutes. Expired rows are cleaned up
 * periodically; the cleanup is idempotent and safe to run on every instance.
 */

import { randomUUID } from "node:crypto";
import { prisma } from "./prisma.js";

const TTL_MS = 10 * 60 * 1000; // 10 minutes

setInterval(async () => {
  try {
    await prisma.oAuthState.deleteMany({ where: { expiresAt: { lt: new Date() } } });
    await prisma.oAuthExchangeCode.deleteMany({ where: { expiresAt: { lt: new Date() } } });
  } catch { /* non-critical cleanup — ignore */ }
}, 5 * 60 * 1000);

// ── Login flow (stores tenantSlug only) ───────────────────────────────────────

export async function createOAuthState(tenantSlug: string): Promise<string> {
  const state = randomUUID();
  await prisma.oAuthState.create({
    data: { state, tenantSlug, expiresAt: new Date(Date.now() + TTL_MS) }
  });
  return state;
}

export async function consumeOAuthState(state: string): Promise<string | null> {
  const entry = await prisma.oAuthState.findUnique({ where: { state } });
  if (!entry) return null;
  await prisma.oAuthState.delete({ where: { state } });
  if (entry.expiresAt < new Date()) return null;
  if (entry.userId) return null; // wrong flow — connect state, not login state
  return entry.tenantSlug;
}

// ── Connect flow (stores tenantSlug + userId — shared by LINE / Teams / Slack) ─

export async function createConnectState(tenantSlug: string, userId: string): Promise<string> {
  const state = randomUUID();
  await prisma.oAuthState.create({
    data: { state, tenantSlug, userId, expiresAt: new Date(Date.now() + TTL_MS) }
  });
  return state;
}

export async function consumeConnectState(state: string): Promise<{ tenantSlug: string; userId: string } | null> {
  const entry = await prisma.oAuthState.findUnique({ where: { state } });
  if (!entry || !entry.userId) return null;
  await prisma.oAuthState.delete({ where: { state } });
  if (entry.expiresAt < new Date()) return null;
  return { tenantSlug: entry.tenantSlug, userId: entry.userId };
}

// LINE-specific aliases (kept for backward compatibility)
export const createLineConnectState = createConnectState;
export const consumeLineConnectState = consumeConnectState;

// ── Exchange code (wraps JWT so it never travels in a URL) ────────────────────
// TTL is short — the frontend exchanges immediately on page load.
const EXCHANGE_TTL_MS = 2 * 60 * 1000; // 2 minutes

export async function createExchangeCode(jwt: string): Promise<string> {
  const code = randomUUID();
  await prisma.oAuthExchangeCode.create({
    data: { code, jwt, expiresAt: new Date(Date.now() + EXCHANGE_TTL_MS) }
  });
  return code;
}

export async function consumeExchangeCode(code: string): Promise<string | null> {
  const entry = await prisma.oAuthExchangeCode.findUnique({ where: { code } });
  if (!entry) return null;
  await prisma.oAuthExchangeCode.delete({ where: { code } });
  if (entry.expiresAt < new Date()) return null;
  return entry.jwt;
}
