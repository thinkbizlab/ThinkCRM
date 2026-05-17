/**
 * Mobile MS365 OAuth (PKCE) — schema + state-handling contract tests.
 *
 * We don't (and can't) drive a real Microsoft login from a unit test — that
 * needs interactive consent and a live Azure AD app. So these tests focus on
 * the parts we own:
 *   - /begin returns a valid authorize URL with PKCE params and a state we
 *     can later consume
 *   - /complete refuses requests with mismatched state (CSRF protection)
 *   - /complete refuses requests where redirectUri isn't on the allow-list
 *   - /complete fails cleanly when MS365 isn't configured for the tenant
 *
 * The actual code-exchange path (token + Graph /me + user lookup) is exercised
 * by the existing web /auth/oauth/ms365/callback test — same helper functions.
 */

import { IntegrationPlatform, SourceStatus, UserRole } from "@prisma/client";
import { randomBytes, randomUUID, createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { buildApp } from "../../build-app.js";
import { prisma } from "../../lib/prisma.js";
import { encryptField } from "../../lib/secrets.js";

function base64UrlNoPadding(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function pkce(): { verifier: string; challenge: string } {
  const verifier = base64UrlNoPadding(randomBytes(32));         // 43 chars
  const challenge = base64UrlNoPadding(createHash("sha256").update(verifier).digest());
  return { verifier, challenge };
}

async function createTenantWithMs365Creds(): Promise<{ tenantId: string; tenantSlug: string }> {
  const token = randomUUID().replace(/-/g, "");
  const tenantSlug = `tenant-${token}`;
  const tenantId = `tenant_${token}`;
  await prisma.tenant.create({ data: { id: tenantId, name: `Tenant ${token}`, slug: tenantSlug } });
  await prisma.tenantIntegrationCredential.create({
    data: {
      tenantId,
      platform: IntegrationPlatform.MS365,
      status: SourceStatus.ENABLED,
      clientIdRef: encryptField("test-client-id"),
      clientSecretRef: encryptField("test-client-secret"),
      webhookTokenRef: encryptField("common")
    }
  });
  return { tenantId, tenantSlug };
}

async function createTenantWithoutMs365(): Promise<{ tenantSlug: string }> {
  const token = randomUUID().replace(/-/g, "");
  const tenantSlug = `tenant-${token}`;
  await prisma.tenant.create({ data: { id: `tenant_${token}`, name: `Tenant ${token}`, slug: tenantSlug } });
  return { tenantSlug };
}

describe("MS365 mobile OAuth — /begin", () => {
  it("returns an authorize URL embedding the PKCE challenge + state", async () => {
    const app = await buildApp();
    const { tenantSlug } = await createTenantWithMs365Creds();
    const { challenge } = pkce();

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/auth/oauth/ms365/mobile/begin",
      payload: { tenantSlug, codeChallenge: challenge, redirectUri: "workcrm://oauth/callback" }
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { authorizationUrl: string; state: string };
    expect(body.state).toMatch(/^[0-9a-f-]{36}$/);                    // uuid v4 ish
    expect(body.authorizationUrl).toContain("login.microsoftonline.com");
    expect(body.authorizationUrl).toContain(`code_challenge=${encodeURIComponent(challenge)}`);
    expect(body.authorizationUrl).toContain("code_challenge_method=S256");
    expect(body.authorizationUrl).toContain(`state=${body.state}`);
    await app.close();
  });

  it("rejects a malformed code_challenge", async () => {
    const app = await buildApp();
    const { tenantSlug } = await createTenantWithMs365Creds();
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/auth/oauth/ms365/mobile/begin",
      payload: { tenantSlug, codeChallenge: "too-short", redirectUri: "workcrm://oauth/callback" }
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it("rejects an unknown redirect URI", async () => {
    const app = await buildApp();
    const { tenantSlug } = await createTenantWithMs365Creds();
    const { challenge } = pkce();
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/auth/oauth/ms365/mobile/begin",
      payload: { tenantSlug, codeChallenge: challenge, redirectUri: "https://evil.example.com/callback" }
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it("returns 501 when the tenant has no MS365 credentials", async () => {
    const app = await buildApp();
    const { tenantSlug } = await createTenantWithoutMs365();
    const { challenge } = pkce();
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/auth/oauth/ms365/mobile/begin",
      payload: { tenantSlug, codeChallenge: challenge, redirectUri: "workcrm://oauth/callback" }
    });
    expect(res.statusCode).toBe(501);
    await app.close();
  });
});

describe("MS365 mobile OAuth — /complete", () => {
  it("rejects mismatched state", async () => {
    const app = await buildApp();
    const { tenantSlug } = await createTenantWithMs365Creds();
    const { verifier } = pkce();
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/auth/oauth/ms365/mobile/complete",
      payload: {
        tenantSlug,
        code:         "fake-code",
        state:        randomUUID(),       // never issued by us
        codeVerifier: verifier,
        redirectUri:  "workcrm://oauth/callback"
      }
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().message).toContain("state");
    await app.close();
  });

  it("rejects an unknown redirect URI on /complete", async () => {
    const app = await buildApp();
    const { tenantSlug } = await createTenantWithMs365Creds();
    const { verifier } = pkce();
    // Even with a valid state, an off-list redirectUri must be refused before
    // we hit Microsoft — defence-in-depth in case the begin allow-list ever drifts.
    const beginRes = await app.inject({
      method: "POST",
      url: "/api/v1/auth/oauth/ms365/mobile/begin",
      payload: { tenantSlug, codeChallenge: pkce().challenge, redirectUri: "workcrm://oauth/callback" }
    });
    const state = (beginRes.json() as { state: string }).state;

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/auth/oauth/ms365/mobile/complete",
      payload: {
        tenantSlug,
        code: "fake",
        state,
        codeVerifier: verifier,
        redirectUri:  "https://evil.example.com/callback"
      }
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it("rejects a malformed codeVerifier", async () => {
    const app = await buildApp();
    const { tenantSlug } = await createTenantWithMs365Creds();
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/auth/oauth/ms365/mobile/complete",
      payload: {
        tenantSlug,
        code:         "fake-code",
        state:        randomUUID(),
        codeVerifier: "way too short",     // < 43 chars + has spaces
        redirectUri:  "workcrm://oauth/callback"
      }
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });
});
