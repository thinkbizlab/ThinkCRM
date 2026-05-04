/**
 * Primedesk support-widget integration.
 *
 * The browser widget script (loaded from primedesk.workstationoffice.com)
 * calls `GET /api/v1/widget-token` to obtain a short-lived JWT it then
 * presents to Primedesk. We sign that JWT with HS256 using a per-tenant
 * shared secret (PRIMEDESK_WIDGET_SECRET) so Primedesk can verify the
 * widget user really is one of our authenticated users.
 *
 * Token TTL is 5 minutes — the widget refetches before each session.
 *
 * Auth: requires the caller to be an authenticated CRM user (the standard
 * JWT cookie/Authorization header pattern via requestContextPlugin).
 *
 * No `jsonwebtoken` dependency: HS256 JWT is a header.payload.signature
 * triple of base64url(JSON), and the signature is HMAC-SHA256(secret, msg).
 * Implementing it here keeps the install footprint small and matches the
 * crypto-only style used elsewhere in the codebase.
 */

import { createHmac } from "node:crypto";
import type { FastifyPluginAsync } from "fastify";
import { config } from "../../config.js";
import { requireTenantId, requireUserId } from "../../lib/http.js";
import { prisma } from "../../lib/prisma.js";

const TOKEN_TTL_SECONDS = 300; // matches Primedesk's snippet (5 min)
const ISSUER = "workcrm";
const SOURCE_APP = "workcrm";
// Currently the widget is enabled for one tenant only. Add slugs here when
// more tenants opt in (and update the matching guard in mountSupportWidget()
// in web/app.js so the frontend skips the network call for non-allowed
// tenants). If this list grows it should move to an env var.
const ALLOWED_TENANT_SLUGS = new Set(["workcrm"]);

function base64url(input: Buffer | string): string {
  return (typeof input === "string" ? Buffer.from(input) : input)
    .toString("base64")
    .replace(/=+$/, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

function signHs256(payload: Record<string, unknown>, secret: string): string {
  const header = { alg: "HS256", typ: "JWT" };
  const headerEncoded = base64url(JSON.stringify(header));
  const payloadEncoded = base64url(JSON.stringify(payload));
  const signingInput = `${headerEncoded}.${payloadEncoded}`;
  const signature = base64url(
    createHmac("sha256", secret).update(signingInput).digest()
  );
  return `${signingInput}.${signature}`;
}

function mintWidgetToken(input: {
  user: { id: string; email: string; fullName: string };
  context: { url?: string; module?: string; entityId?: string };
}): string {
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    iss: ISSUER,
    sub: input.user.id,
    email: input.user.email,
    name: input.user.fullName,
    source_app: SOURCE_APP,
    iat: now,
    exp: now + TOKEN_TTL_SECONDS,
    context: {
      url: input.context.url,
      module: input.context.module,
      entityId: input.context.entityId
    }
  };
  // Non-null because callers gate on config.PRIMEDESK_WIDGET_SECRET being set.
  return signHs256(payload, config.PRIMEDESK_WIDGET_SECRET as string);
}

export const widgetRoutes: FastifyPluginAsync = async (app) => {
  app.get("/widget-token", async (request) => {
    if (!config.PRIMEDESK_WIDGET_SECRET) {
      throw app.httpErrors.serviceUnavailable(
        "Support widget is not configured for this deployment (PRIMEDESK_WIDGET_SECRET unset)."
      );
    }
    const tenantId = requireTenantId(request);
    const userId = requireUserId(request);
    const tenant = await prisma.tenant.findUnique({
      where: { id: tenantId },
      select: { slug: true }
    });
    // Diagnostic: log every call (slug + allow result) so Vercel runtime
    // logs make it obvious why a user gets a 403 vs 200. One log line per
    // request; no PII beyond the tenant slug. Remove after the workcrm
    // rollout settles.
    console.log(
      "[widget-token] tenantId=%s slug=%j allowed=%s",
      tenantId,
      tenant?.slug ?? null,
      tenant ? ALLOWED_TENANT_SLUGS.has(tenant.slug) : false
    );
    if (!tenant || !ALLOWED_TENANT_SLUGS.has(tenant.slug)) {
      // Per-tenant opt-in. Other tenants get a 403 even if the secret env
      // var is set — they have to be added to ALLOWED_TENANT_SLUGS first.
      throw app.httpErrors.forbidden("Support widget is not enabled for this tenant.");
    }
    const user = await prisma.user.findFirst({
      where: { id: userId, tenantId, isActive: true },
      select: { id: true, email: true, fullName: true }
    });
    if (!user) {
      // The JWT is valid but the user vanished or was deactivated since.
      throw app.httpErrors.unauthorized("User not found.");
    }
    // Optional context lets agents see which CRM page the user is on.
    const q = request.query as { url?: string; module?: string; entityId?: string };
    const token = mintWidgetToken({
      user,
      context: {
        url: typeof q.url === "string" ? q.url : undefined,
        module: typeof q.module === "string" ? q.module : undefined,
        entityId: typeof q.entityId === "string" ? q.entityId : undefined
      }
    });
    return { token };
  });
};
