import { createHash, randomBytes } from "node:crypto";
import type { FastifyRequest } from "fastify";
import { prisma } from "./prisma.js";

/**
 * Generates a new sync API key. Returns the raw key (show once to admin)
 * and the hash + prefix to store in the database.
 */
export function generateSyncApiKey(): { rawKey: string; keyHash: string; keyPrefix: string } {
  const rawKey = `tcrm_${randomBytes(24).toString("base64url")}`;
  const keyHash = createHash("sha256").update(rawKey).digest("hex");
  const keyPrefix = rawKey.slice(0, 12);
  return { rawKey, keyHash, keyPrefix };
}

export function hashApiKey(rawKey: string): string {
  return createHash("sha256").update(rawKey).digest("hex");
}

export type SyncAuthContext = {
  tenantId: string;
  apiKeyId: string;
  scopes: string[];
};

/**
 * Authenticates an inbound sync request using the `X-Api-Key` header.
 * Returns the tenant context if valid, or throws a Fastify HTTP error.
 */
export async function authenticateSyncApiKey(request: FastifyRequest): Promise<SyncAuthContext> {
  const rawKey = request.headers["x-api-key"];
  if (typeof rawKey !== "string" || rawKey.length < 10) {
    throw request.server.httpErrors.unauthorized("Missing or invalid X-Api-Key header.");
  }

  const keyHash = hashApiKey(rawKey);
  const apiKey = await prisma.syncApiKey.findUnique({
    where: { keyHash },
    select: { id: true, tenantId: true, scopes: true, isActive: true, expiresAt: true },
  });

  if (!apiKey) {
    throw request.server.httpErrors.unauthorized("Invalid API key.");
  }
  if (!apiKey.isActive) {
    throw request.server.httpErrors.forbidden("API key is deactivated.");
  }
  if (apiKey.expiresAt && apiKey.expiresAt < new Date()) {
    throw request.server.httpErrors.forbidden("API key has expired.");
  }

  // Fire-and-forget last-used timestamp update
  prisma.syncApiKey.update({
    where: { id: apiKey.id },
    data: { lastUsedAt: new Date() },
  }).catch(() => {});

  return {
    tenantId: apiKey.tenantId,
    apiKeyId: apiKey.id,
    scopes: apiKey.scopes,
  };
}

/**
 * Checks whether the API key's scopes allow a specific entity type.
 * Scopes are entity type names (e.g., "CUSTOMER", "ITEM") or "*" for all.
 */
export function assertSyncScope(ctx: SyncAuthContext, entityType: string, request: FastifyRequest): void {
  if (ctx.scopes.includes("*") || ctx.scopes.includes(entityType)) {
    return;
  }
  throw request.server.httpErrors.forbidden(
    `API key does not have scope for entity type "${entityType}". Allowed: ${ctx.scopes.join(", ")}`
  );
}
