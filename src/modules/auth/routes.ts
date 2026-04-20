import type { FastifyPluginAsync } from "fastify";
import { randomBytes } from "node:crypto";
import { z } from "zod";
import { createRemoteJWKSet, jwtVerify } from "jose";
import { generateRegistrationOptions, verifyRegistrationResponse, generateAuthenticationOptions, verifyAuthenticationResponse } from "@simplewebauthn/server";
import { config } from "../../config.js";
import { requireAuth, requireTenantId, requireUserId, isSuperAdmin, zodMsg } from "../../lib/http.js";
import { hashPassword, verifyPassword } from "../../lib/password.js";

// JWKS sets are created once and cached (jose handles key rotation internally)
const GOOGLE_JWKS = createRemoteJWKSet(new URL("https://www.googleapis.com/oauth2/v3/certs"));
const SLACK_JWKS  = createRemoteJWKSet(new URL("https://slack.com/openid/connect/keys"));

import { createOAuthState, consumeOAuthState, createConnectState, consumeConnectState, createLineConnectState, consumeLineConnectState, createExchangeCode, consumeExchangeCode } from "../../lib/oauth-state.js";

// Pre-computed dummy hash consumed when a user is not found.
// Ensures the scrypt cost is always paid so response timing doesn't reveal whether an email exists.
const DUMMY_HASH = hashPassword("__dummy_will_never_match__");
import { prisma } from "../../lib/prisma.js";
import { logAuditEvent } from "../../lib/audit.js";
import { decryptCredential } from "../../lib/secrets.js";
import { smtpPort } from "../../lib/smtp-port.js";
import { sendEmailCard, type EmailConfig } from "../../lib/email-notify.js";
import { isR2Configured, uploadBufferToR2, buildR2PublicUrl, buildR2ObjectRef, createR2PresignedDownload, deleteR2Object } from "../../lib/r2-storage.js";
import { IntegrationPlatform, AccountStatus, SourceStatus, UserRole } from "@prisma/client";
import { getTenantUrl } from "../../lib/tenant-url.js";

const superAdminEmailSet: Set<string> = new Set(
  (config.SUPER_ADMIN_EMAILS ?? "").split(",").map(e => e.trim().toLowerCase()).filter(Boolean)
);

const loginSchema = z.object({
  tenantSlug: z.string().min(2),
  email: z.string().email().transform(s => s.toLowerCase()),  // M9
  password: z.string().min(8)
});

const firstLoginResetSchema = z.object({
  tenantSlug: z.string().min(2),
  email: z.string().email().transform(s => s.toLowerCase()),  // M9
  currentPassword: z.string().min(8),
  newPassword: z.string().min(12)  // H11
});

const profileUpdateSchema = z.object({
  fullName: z.string().min(1).max(120),
  email: z.string().email().transform(s => s.toLowerCase())  // M9
});

const changePasswordSchema = z.object({
  currentPassword: z.string().min(8),
  newPassword: z.string().min(12)  // H11
});

const forgotPasswordSchema = z.object({
  tenantSlug: z.string().min(2),
  email: z.string().email().transform(s => s.toLowerCase())
});

const resetPasswordSchema = z.object({
  token: z.string().min(1),
  newPassword: z.string().min(12)  // H11
});

const acceptInviteSchema = z.object({
  token: z.string().min(1),
  fullName: z.string().min(2).max(120),
  password: z.string().min(12)  // H11
});

const registerDeviceSchema = z.object({
  platform: z.enum(["IOS", "ANDROID", "WEB"]),
  deviceToken: z.string().min(1).max(512),
  deviceName: z.string().max(120).optional()
});

const REFRESH_TOKEN_TTL_DAYS = 90;

async function createRefreshToken(tenantId: string, userId: string, deviceId?: string): Promise<string> {
  const token = randomBytes(48).toString("hex");
  const expiresAt = new Date(Date.now() + REFRESH_TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000);
  await prisma.refreshToken.create({ data: { token, tenantId, userId, deviceId, expiresAt } });
  return token;
}

export const authRoutes: FastifyPluginAsync = async (app) => {
  app.post("/auth/login", async (request) => {
    const parsed = loginSchema.safeParse(request.body);
    if (!parsed.success) {
      throw app.httpErrors.badRequest(zodMsg(parsed.error));
    }

    // When the login request arrives via a tenant-bound host (subdomain or verified
    // custom domain), lock the workspace to that host regardless of what the client
    // submitted — customers should not be able to sign in to another workspace.
    const hostResolved = await resolveHostTenantSlug(request.hostname);
    if (hostResolved && hostResolved.tenantSlug !== parsed.data.tenantSlug) {
      throw app.httpErrors.unauthorized("Invalid tenant or credentials.");
    }

    const emailIsSuperAdmin = superAdminEmailSet.has(parsed.data.email);

    const tenant = await prisma.tenant.findUnique({
      where: { slug: parsed.data.tenantSlug },
      select: { id: true, slug: true, name: true }
    });
    if (!tenant && !emailIsSuperAdmin) {
      throw app.httpErrors.unauthorized("Invalid tenant or credentials.");
    }

    let user = tenant
      ? await prisma.user.findFirst({
          where: { tenantId: tenant.id, email: parsed.data.email, isActive: true }
        })
      : null;

    // Super-admin cross-tenant fallback: allow login at any workspace URL by resolving
    // the super admin's home tenant (where their User row actually lives).
    if (!user && emailIsSuperAdmin) {
      user = await prisma.user.findFirst({
        where: { email: parsed.data.email, isActive: true },
        orderBy: { createdAt: "asc" }
      });
    }

    // Always run verifyPassword to pay the scrypt cost even when user is not found (timing attack defence).
    const passwordOk = verifyPassword(parsed.data.password, user?.passwordHash ?? DUMMY_HASH);
    if (!user || !passwordOk) {
      const auditTenantId = tenant?.id ?? user?.tenantId;
      if (auditTenantId) {
        try { await logAuditEvent(auditTenantId, user?.id ?? null, "LOGIN_FAILED", { email: parsed.data.email, reason: "invalid_credentials" }, request.ip); } catch { /* best-effort */ }
      }
      throw app.httpErrors.unauthorized("Invalid tenant or credentials.");
    }

    // Resolve the tenant the JWT will be signed for — always the user's home tenant.
    const homeTenant = tenant && user.tenantId === tenant.id
      ? tenant
      : await prisma.tenant.findUnique({ where: { id: user.tenantId }, select: { id: true, slug: true, name: true } });
    if (!homeTenant) {
      throw app.httpErrors.unauthorized("Invalid tenant or credentials.");
    }

    if (!user.emailVerified) {
      return { needsEmailVerification: true, tenantSlug: homeTenant.slug, email: user.email };
    }
    if (user.mustResetPassword) {
      throw app.httpErrors.forbidden("First login password reset required.");
    }

    const accessToken = await app.jwt.sign({
      userId: user.id,
      tenantId: homeTenant.id,
      role: user.role,
      email: user.email
    }, { expiresIn: "1h" });

    await logAuditEvent(user.tenantId, user.id, "LOGIN", { email: user.email, method: "password", crossTenant: tenant ? tenant.id !== user.tenantId : true }, request.ip);

    const refreshToken = await createRefreshToken(homeTenant.id, user.id);

    return {
      accessToken,
      refreshToken,
      tokenType: "Bearer",
      user: {
        id: user.id,
        tenantId: homeTenant.id,
        tenantSlug: homeTenant.slug,
        role: user.role,
        email: user.email,
        fullName: user.fullName,
        avatarUrl: resolveAvatarUrl(user.id, user.avatarUrl, homeTenant.id)
      }
    };
  });

  app.post("/auth/first-login-reset", async (request) => {
    const parsed = firstLoginResetSchema.safeParse(request.body);
    if (!parsed.success) {
      throw app.httpErrors.badRequest(zodMsg(parsed.error));
    }
    if (parsed.data.currentPassword === parsed.data.newPassword) {
      throw app.httpErrors.badRequest("New password must be different from current password.");
    }

    const tenant = await prisma.tenant.findUnique({
      where: { slug: parsed.data.tenantSlug },
      select: { id: true }
    });
    if (!tenant) {
      throw app.httpErrors.unauthorized("Invalid tenant or credentials.");
    }

    const user = await prisma.user.findFirst({
      where: {
        tenantId: tenant.id,
        email: parsed.data.email,
        isActive: true
      }
    });
    if (!user || !verifyPassword(parsed.data.currentPassword, user.passwordHash)) {
      throw app.httpErrors.unauthorized("Invalid tenant or credentials.");
    }
    if (!user.mustResetPassword) {
      throw app.httpErrors.badRequest("Password reset is not required for this account.");
    }

    await prisma.user.update({
      where: { id: user.id },
      data: {
        passwordHash: hashPassword(parsed.data.newPassword),
        mustResetPassword: false
      }
    });

    return { message: "Password reset completed. Please login again." };
  });

  app.patch("/auth/profile", async (request) => {
    requireAuth(request);
    const tenantId = requireTenantId(request);
    const userId = requireUserId(request);
    const parsed = profileUpdateSchema.safeParse(request.body);
    if (!parsed.success) throw app.httpErrors.badRequest(zodMsg(parsed.error));

    const existing = await prisma.user.findFirst({ where: { id: userId, tenantId } });
    if (!existing) throw app.httpErrors.notFound("User not found.");

    if (parsed.data.email !== existing.email) {
      const emailTaken = await prisma.user.findFirst({
        where: { tenantId, email: parsed.data.email, id: { not: userId } }
      });
      if (emailTaken) throw app.httpErrors.conflict("Email is already in use.");
    }

    const updated = await prisma.user.update({
      where: { id: userId },
      data: { fullName: parsed.data.fullName, email: parsed.data.email },
      select: { id: true, fullName: true, email: true, role: true, tenantId: true }
    });
    return updated;
  });

  app.post("/auth/change-password", async (request) => {
    requireAuth(request);
    const tenantId = requireTenantId(request);
    const userId = requireUserId(request);
    const parsed = changePasswordSchema.safeParse(request.body);
    if (!parsed.success) throw app.httpErrors.badRequest(zodMsg(parsed.error));
    if (parsed.data.currentPassword === parsed.data.newPassword) {
      throw app.httpErrors.badRequest("New password must differ from current password.");
    }

    const user = await prisma.user.findFirst({ where: { id: userId, tenantId } });
    if (!user || !verifyPassword(parsed.data.currentPassword, user.passwordHash)) {
      throw app.httpErrors.unauthorized("Current password is incorrect.");
    }

    await prisma.user.update({
      where: { id: userId },
      data: { passwordHash: hashPassword(parsed.data.newPassword) }
    });
    return { message: "Password changed successfully." };
  });

  /**
   * M10: Resolve an r2:// branding URL to an HTTP URL the browser can load.
   * Prefers the fast R2 public CDN URL; falls back to a presigned download URL.
   * Returns null/undefined passthrough for empty values and plain HTTP URLs.
   */
  async function resolveBrandingUrl(raw: string | null | undefined, tenantSlug: string): Promise<string | null> {
    if (!raw) return null;
    if (!raw.startsWith("r2://")) return raw;
    const publicUrl = buildR2PublicUrl(raw);
    if (publicUrl) return publicUrl;
    try {
      const { downloadUrl } = await createR2PresignedDownload({
        tenantSlug,
        objectKeyOrRef: raw,
        expiresInSeconds: 3600
      });
      return downloadUrl;
    } catch {
      return null; // Cannot resolve — hide rather than leak the r2:// ref
    }
  }

  // Public endpoint — no auth required. Used by login page before authentication.
  app.get("/auth/branding/public", async (request, reply) => {
    const slug = (request.query as { slug?: string }).slug?.trim().toLowerCase();
    if (!slug) {
      throw app.httpErrors.badRequest("slug query parameter is required.");
    }
    const tenant = await prisma.tenant.findUnique({
      where: { slug },
      select: { id: true, name: true, slug: true, branding: true }
    });
    // M8: Return default branding for unknown slugs — prevents tenant-existence enumeration.
    if (!tenant) {
      return reply.send({ appName: "ThinkCRM", primaryColor: "#2563eb", secondaryColor: "#0f172a", themeMode: "LIGHT" });
    }
    const b = tenant.branding;
    return reply.send({
      appName:        b?.appName        ?? tenant.name,
      logoUrl:        await resolveBrandingUrl(b?.logoUrl, tenant.slug),
      faviconUrl:     await resolveBrandingUrl(b?.faviconUrl, tenant.slug),
      primaryColor:   b?.primaryColor   ?? "#2563eb",
      secondaryColor: b?.secondaryColor ?? "#0f172a",
      themeMode:      b?.themeMode      ?? "LIGHT"
    });
  });

  // ── Avatar proxy ─────────────────────────────────────────────────────────────
  // tenantId is in the path so the server can verify cross-tenant access (C7).
  // Still public (no JWT) so <img src> works, but the caller must know both
  // tenantId AND userId — preventing blind cross-tenant enumeration.
  app.get("/auth/avatar/:tenantId/:userId", async (request, reply) => {
    const { tenantId, userId } = request.params as { tenantId: string; userId: string };
    const user = await prisma.user.findFirst({
      where: { id: userId, tenantId },   // C7: userId must belong to tenantId
      select: { avatarUrl: true, tenant: { select: { slug: true } } }
    });
    if (!user?.avatarUrl) throw app.httpErrors.notFound("Avatar not found.");

    if (user.avatarUrl.startsWith("r2://")) {
      const { downloadUrl } = await createR2PresignedDownload({
        tenantSlug: user.tenant.slug,
        objectKeyOrRef: user.avatarUrl,
        expiresInSeconds: 3600
      });
      return reply.redirect(downloadUrl);
    }

    // Plain HTTPS URL (Google CDN, or public R2)
    return reply.redirect(user.avatarUrl);
  });

  /** Convert an r2:// ref to the scoped proxy URL so the browser can load it without credentials. */
  function resolveAvatarUrl(userId: string, raw: string | null | undefined, tenantId: string): string | null {
    if (!raw) return null;
    if (raw.startsWith("r2://")) return `/api/v1/auth/avatar/${tenantId}/${userId}`;
    return raw;
  }

  // ── OAuth helpers ────────────────────────────────────────────────────────────

  function oauthBase(request: { protocol: string; hostname: string }): string {
    if (config.APP_URL) return config.APP_URL.replace(/\/$/, "");
    // H12: In production APP_URL must be set — never derive the OAuth redirect base from headers.
    if (config.NODE_ENV === "production") {
      throw new Error("APP_URL must be configured in production for OAuth to work securely.");
    }
    // Development fallback: use Fastify's parsed protocol/hostname (trustProxy handles forwarding).
    return `${request.protocol}://${request.hostname}`;
  }

  // Resolve MS365 / Google OAuth credentials, preferring per-tenant configuration
  // (TenantIntegrationCredential, ENABLED) and falling back to server-level env.
  async function resolveMs365OAuthCreds(tenantSlug: string):
    Promise<{ clientId: string; clientSecret: string; msTenantId: string } | null> {
    const tenant = await prisma.tenant.findUnique({ where: { slug: tenantSlug }, select: { id: true } });
    if (tenant) {
      const cred = decryptCredential(await prisma.tenantIntegrationCredential.findFirst({
        where: { tenantId: tenant.id, platform: IntegrationPlatform.MS365, status: SourceStatus.ENABLED }
      }));
      if (cred?.clientIdRef && cred?.clientSecretRef) {
        return {
          clientId: cred.clientIdRef,
          clientSecret: cred.clientSecretRef,
          msTenantId: cred.webhookTokenRef ?? config.MS365_TENANT_ID ?? "common"
        };
      }
    }
    if (config.MS365_CLIENT_ID && config.MS365_CLIENT_SECRET) {
      return {
        clientId: config.MS365_CLIENT_ID,
        clientSecret: config.MS365_CLIENT_SECRET,
        msTenantId: config.MS365_TENANT_ID ?? "common"
      };
    }
    return null;
  }

  async function resolveGoogleOAuthCreds(tenantSlug: string):
    Promise<{ clientId: string; clientSecret: string } | null> {
    const tenant = await prisma.tenant.findUnique({ where: { slug: tenantSlug }, select: { id: true } });
    if (tenant) {
      const cred = decryptCredential(await prisma.tenantIntegrationCredential.findFirst({
        where: { tenantId: tenant.id, platform: IntegrationPlatform.GOOGLE, status: SourceStatus.ENABLED }
      }));
      if (cred?.clientIdRef && cred?.clientSecretRef) {
        return { clientId: cred.clientIdRef, clientSecret: cred.clientSecretRef };
      }
    }
    if (config.GOOGLE_CLIENT_ID && config.GOOGLE_CLIENT_SECRET) {
      return { clientId: config.GOOGLE_CLIENT_ID, clientSecret: config.GOOGLE_CLIENT_SECRET };
    }
    return null;
  }

  // ── MS365 OAuth ──────────────────────────────────────────────────────────────

  app.get("/auth/oauth/ms365", async (request, reply) => {
    const { tenantSlug } = request.query as { tenantSlug?: string };
    if (!tenantSlug) throw app.httpErrors.badRequest("tenantSlug is required.");
    const creds = await resolveMs365OAuthCreds(tenantSlug);
    if (!creds) throw app.httpErrors.notImplemented("MS365 OAuth is not configured.");
    const state = await createOAuthState(tenantSlug);
    const base  = oauthBase(request);
    const params = new URLSearchParams({
      client_id: creds.clientId, response_type: "code",
      redirect_uri: `${base}/api/v1/auth/oauth/ms365/callback`,
      scope: "openid email profile User.Read", response_mode: "query", state
    });
    return reply.redirect(`https://login.microsoftonline.com/${creds.msTenantId}/oauth2/v2.0/authorize?${params}`);
  });

  app.get("/auth/oauth/ms365/callback", async (request, reply) => {
    const { code, state, error, error_description } = request.query as Record<string, string>;
    const base = oauthBase(request);
    if (error || !code || !state) {
      return reply.redirect(`${base}/?oauth_error=${encodeURIComponent(error_description ?? error ?? "OAuth cancelled")}`);
    }
    const tenantSlug = await consumeOAuthState(state);
    if (!tenantSlug) {
      return reply.redirect(`${base}/?oauth_error=${encodeURIComponent("Invalid or expired state. Please try again.")}`);
    }
    try {
      const creds = await resolveMs365OAuthCreds(tenantSlug);
      if (!creds) throw new Error("MS365 OAuth is not configured.");
      const redirectUri = `${base}/api/v1/auth/oauth/ms365/callback`;
      const tokenRes = await fetch(`https://login.microsoftonline.com/${creds.msTenantId}/oauth2/v2.0/token`, {
        method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ client_id: creds.clientId, client_secret: creds.clientSecret,
          code, redirect_uri: redirectUri, grant_type: "authorization_code" })
      });
      const tok = await tokenRes.json() as { access_token?: string; error_description?: string };
      if (!tok.access_token) throw new Error(tok.error_description ?? "Token exchange failed");
      const at = tok.access_token;

      const meRes  = await fetch("https://graph.microsoft.com/v1.0/me?$select=mail,userPrincipalName,displayName", {
        headers: { Authorization: `Bearer ${at}` }
      });
      const me = await meRes.json() as { mail?: string; userPrincipalName?: string };
      const email = (me.mail ?? me.userPrincipalName ?? "").toLowerCase();
      if (!email) throw new Error("Could not read email from MS365 profile.");

      const tenant = await prisma.tenant.findUnique({ where: { slug: tenantSlug }, select: { id: true } });
      if (!tenant) throw new Error("Workspace not found.");
      const user = await prisma.user.findFirst({ where: { tenantId: tenant.id, email, isActive: true } });
      if (!user) throw new Error(`No active account for ${email} in this workspace.`);

      // Fetch avatar — upload to R2; use public URL if available, else store r2:// ref (served via proxy)
      let avatarUrl: string | undefined;
      try {
        const photoRes = await fetch("https://graph.microsoft.com/v1.0/me/photo/$value", {
          headers: { Authorization: `Bearer ${at}` }
        });
        if (photoRes.ok) {
          const buf = Buffer.from(await photoRes.arrayBuffer());
          const ct  = photoRes.headers.get("content-type") ?? "image/jpeg";
          if (isR2Configured) {
            const slug = tenantSlug.replace(/[^a-z0-9-]/g, "-");
            const key  = `${slug}/avatars/${user.id}.jpg`;
            await uploadBufferToR2({ tenantSlug: slug, objectKeyOrRef: key, contentType: ct, data: buf });
            avatarUrl = buildR2PublicUrl(key) ?? buildR2ObjectRef(key);
          }
        }
      } catch (e) {
        app.log.warn({ err: e }, "[MS365 OAuth] avatar upload failed — skipping");
      }
      if (avatarUrl) await prisma.user.update({ where: { id: user.id }, data: { avatarUrl } });

      const jwt = await app.jwt.sign({ userId: user.id, tenantId: tenant.id, role: user.role, email: user.email }, { expiresIn: "1h" });
      const exchangeCode = await createExchangeCode(jwt);
      return reply.redirect(`${base}/?oauth_code=${encodeURIComponent(exchangeCode)}`);
    } catch (err) {
      app.log.error({ err }, "[MS365 OAuth] callback error");
      return reply.redirect(`${base}/?oauth_error=${encodeURIComponent(err instanceof Error ? err.message : "Login failed")}`);
    }
  });

  // ── Google OAuth ─────────────────────────────────────────────────────────────

  app.get("/auth/oauth/google", async (request, reply) => {
    const { tenantSlug } = request.query as { tenantSlug?: string };
    if (!tenantSlug) throw app.httpErrors.badRequest("tenantSlug is required.");
    const creds = await resolveGoogleOAuthCreds(tenantSlug);
    if (!creds) throw app.httpErrors.notImplemented("Google OAuth is not configured.");
    const state = await createOAuthState(tenantSlug);
    const base  = oauthBase(request);
    const params = new URLSearchParams({
      client_id: creds.clientId, response_type: "code",
      redirect_uri: `${base}/api/v1/auth/oauth/google/callback`,
      scope: "openid email profile", access_type: "online", state
    });
    return reply.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params}`);
  });

  app.get("/auth/oauth/google/callback", async (request, reply) => {
    const { code, state, error } = request.query as Record<string, string>;
    const base = oauthBase(request);
    if (error || !code || !state) {
      return reply.redirect(`${base}/?oauth_error=${encodeURIComponent(error ?? "OAuth cancelled")}`);
    }
    const tenantSlug = await consumeOAuthState(state);
    if (!tenantSlug) {
      return reply.redirect(`${base}/?oauth_error=${encodeURIComponent("Invalid or expired state. Please try again.")}`);
    }
    try {
      const creds = await resolveGoogleOAuthCreds(tenantSlug);
      if (!creds) throw new Error("Google OAuth is not configured.");
      const redirectUri = `${base}/api/v1/auth/oauth/google/callback`;
      const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
        method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ client_id: creds.clientId, client_secret: creds.clientSecret,
          code, redirect_uri: redirectUri, grant_type: "authorization_code" })
      });
      const tok = await tokenRes.json() as { id_token?: string; error_description?: string };
      if (!tok.id_token) throw new Error(tok.error_description ?? "Token exchange failed");

      // Verify Google ID token signature against Google's JWKS, and validate aud + iss claims
      const { payload } = await jwtVerify(tok.id_token, GOOGLE_JWKS, {
        issuer: ["https://accounts.google.com", "accounts.google.com"],
        audience: creds.clientId,
      });
      const email = (typeof payload["email"] === "string" ? payload["email"] : "").toLowerCase();
      if (!email) throw new Error("Could not read email from Google profile.");

      const tenant = await prisma.tenant.findUnique({ where: { slug: tenantSlug }, select: { id: true } });
      if (!tenant) throw new Error("Workspace not found.");
      const user = await prisma.user.findFirst({ where: { tenantId: tenant.id, email, isActive: true } });
      if (!user) throw new Error(`No active account for ${email} in this workspace.`);

      // Google picture is a public CDN URL — store directly
      const picture = typeof payload["picture"] === "string" ? payload["picture"] : undefined;
      if (picture) {
        await prisma.user.update({ where: { id: user.id }, data: { avatarUrl: picture } });
      }

      const jwt = await app.jwt.sign({ userId: user.id, tenantId: tenant.id, role: user.role, email: user.email }, { expiresIn: "1h" });
      const exchangeCode = await createExchangeCode(jwt);
      return reply.redirect(`${base}/?oauth_code=${encodeURIComponent(exchangeCode)}`);
    } catch (err) {
      app.log.error({ err }, "[Google OAuth] callback error");
      return reply.redirect(`${base}/?oauth_error=${encodeURIComponent(err instanceof Error ? err.message : "Login failed")}`);
    }
  });

  // ── OAuth exchange code → JWT (C5 fix: JWT never travels in a URL) ──────────
  // Frontend posts the one-time code received via ?oauth_code= to get the JWT.
  app.post("/auth/oauth/exchange", async (request, reply) => {
    const { code } = request.body as { code?: string };
    if (!code || typeof code !== "string") throw app.httpErrors.badRequest("code is required.");
    const jwt = await consumeExchangeCode(code);
    if (!jwt) throw app.httpErrors.badRequest("Invalid or expired exchange code.");
    // Decode the JWT we signed to extract user info for the refresh token.
    const payload = app.jwt.verify<{ userId: string; tenantId: string }>(jwt);
    const refreshToken = await createRefreshToken(payload.tenantId, payload.userId);
    return reply.send({ token: jwt, refreshToken });
  });

  // ── LINE Connect OAuth (link LINE account while already logged in) ───────────

  app.get("/auth/oauth/line-connect", async (request, reply) => {
    const { token } = request.query as { token?: string };
    if (!token) throw app.httpErrors.badRequest("token is required.");

    let userId: string;
    let tenantId: string;
    let tenantSlug: string;
    try {
      const payload = app.jwt.verify<{ userId: string; tenantId: string }>(token);
      userId = payload.userId;
      tenantId = payload.tenantId;
      const tenant = await prisma.tenant.findUnique({
        where: { id: tenantId },
        select: { slug: true }
      });
      if (!tenant) throw new Error("Tenant not found.");
      tenantSlug = tenant.slug;
    } catch {
      throw app.httpErrors.unauthorized("Invalid or expired token.");
    }

    const cred = decryptCredential(await prisma.tenantIntegrationCredential.findFirst({
      where: { tenantId, platform: IntegrationPlatform.LINE_LOGIN, status: SourceStatus.ENABLED }
    }));
    if (!cred?.clientIdRef) {
      throw app.httpErrors.notImplemented("LINE Login is not configured or not enabled for this workspace.");
    }

    const state = await createLineConnectState(tenantSlug, userId);
    const base = oauthBase(request);
    const params = new URLSearchParams({
      response_type: "code",
      client_id: cred.clientIdRef,
      redirect_uri: `${base}/api/v1/auth/oauth/line-connect/callback`,
      state,
      scope: "profile",
      bot_prompt: "aggressive"
    });
    return reply.redirect(`https://access.line.me/oauth2/v2.1/authorize?${params}`);
  });

  app.get("/auth/oauth/line-connect/callback", async (request, reply) => {
    const { code, state, error, error_description } = request.query as Record<string, string>;
    const base = oauthBase(request);

    if (error || !code || !state) {
      return reply.redirect(
        `${base}/settings/notifications?line_error=${encodeURIComponent(error_description ?? error ?? "LINE login cancelled")}`
      );
    }

    const stateData = await consumeLineConnectState(state);
    if (!stateData) {
      return reply.redirect(
        `${base}/settings/notifications?line_error=${encodeURIComponent("Invalid or expired state. Please try again.")}`
      );
    }

    try {
      const tenant = await prisma.tenant.findUnique({
        where: { slug: stateData.tenantSlug },
        select: { id: true }
      });
      if (!tenant) throw new Error("Workspace not found.");

      const cred = decryptCredential(await prisma.tenantIntegrationCredential.findFirst({
        where: { tenantId: tenant.id, platform: IntegrationPlatform.LINE_LOGIN }
      }));
      if (!cred?.clientIdRef || !cred?.clientSecretRef) {
        throw new Error("LINE Login credentials are no longer configured.");
      }

      const redirectUri = `${base}/api/v1/auth/oauth/line-connect/callback`;
      const tokenRes = await fetch("https://api.line.me/oauth2/v2.1/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code,
          redirect_uri: redirectUri,
          client_id: cred.clientIdRef,
          client_secret: cred.clientSecretRef
        })
      });
      const tok = await tokenRes.json() as { access_token?: string; error_description?: string };
      if (!tok.access_token) throw new Error(tok.error_description ?? "Token exchange failed.");

      const profileRes = await fetch("https://api.line.me/v2/profile", {
        headers: { Authorization: `Bearer ${tok.access_token}` }
      });
      const profile = await profileRes.json() as { userId?: string; displayName?: string };
      if (!profile.userId) throw new Error("Could not retrieve LINE User ID from profile.");

      await prisma.userExternalAccount.upsert({
        where: { userId_provider: { userId: stateData.userId, provider: IntegrationPlatform.LINE } },
        update: { externalUserId: profile.userId, status: AccountStatus.CONNECTED },
        create: {
          userId: stateData.userId,
          provider: IntegrationPlatform.LINE,
          externalUserId: profile.userId
        }
      });

      return reply.redirect(`${base}/settings/notifications?line_connected=1`);
    } catch (err) {
      app.log.error({ err }, "[LINE Connect] callback error");
      return reply.redirect(
        `${base}/settings/notifications?line_error=${encodeURIComponent(err instanceof Error ? err.message : "Connection failed")}`
      );
    }
  });

  // ── MS Teams Connect OAuth (link Teams account while already logged in) ──────

  app.get("/auth/oauth/ms-teams-connect", async (request, reply) => {
    const { token } = request.query as { token?: string };
    if (!token) throw app.httpErrors.badRequest("token is required.");

    let userId: string;
    let tenantId: string;
    let tenantSlug: string;
    try {
      const payload = app.jwt.verify<{ userId: string; tenantId: string }>(token);
      userId = payload.userId;
      tenantId = payload.tenantId;
      const tenant = await prisma.tenant.findUnique({
        where: { id: tenantId },
        select: { slug: true }
      });
      if (!tenant) throw new Error("Tenant not found.");
      tenantSlug = tenant.slug;
    } catch {
      throw app.httpErrors.unauthorized("Invalid or expired token.");
    }

    const cred = decryptCredential(await prisma.tenantIntegrationCredential.findFirst({
      where: { tenantId, platform: IntegrationPlatform.MS365, status: SourceStatus.ENABLED }
    }));
    if (!cred?.clientIdRef) {
      throw app.httpErrors.notImplemented("Microsoft 365 OAuth is not configured or not enabled for this workspace.");
    }

    // Tenant ID: per-tenant setting (webhookTokenRef) takes priority over server env var
    const aadTenantId = cred.webhookTokenRef ?? config.MS365_TENANT_ID;

    const state = await createConnectState(tenantSlug, userId);
    const base = oauthBase(request);
    const params = new URLSearchParams({
      client_id: cred.clientIdRef,
      response_type: "code",
      redirect_uri: `${base}/api/v1/auth/oauth/ms-teams-connect/callback`,
      scope: "openid User.Read",
      response_mode: "query",
      state
    });
    return reply.redirect(`https://login.microsoftonline.com/${aadTenantId}/oauth2/v2.0/authorize?${params}`);
  });

  app.get("/auth/oauth/ms-teams-connect/callback", async (request, reply) => {
    const { code, state, error, error_description } = request.query as Record<string, string>;
    const base = oauthBase(request);

    if (error || !code || !state) {
      return reply.redirect(
        `${base}/settings/notifications?ms_teams_error=${encodeURIComponent(error_description ?? error ?? "Microsoft login cancelled")}`
      );
    }

    const stateData = await consumeConnectState(state);
    if (!stateData) {
      return reply.redirect(
        `${base}/settings/notifications?ms_teams_error=${encodeURIComponent("Invalid or expired state. Please try again.")}`
      );
    }

    try {
      const tenant = await prisma.tenant.findUnique({
        where: { slug: stateData.tenantSlug },
        select: { id: true }
      });
      if (!tenant) throw new Error("Workspace not found.");

      const cred = decryptCredential(await prisma.tenantIntegrationCredential.findFirst({
        where: { tenantId: tenant.id, platform: IntegrationPlatform.MS365 }
      }));
      if (!cred?.clientIdRef || !cred?.clientSecretRef) {
        throw new Error("Microsoft 365 credentials are no longer configured.");
      }

      const aadTenantId = cred.webhookTokenRef ?? config.MS365_TENANT_ID;
      const redirectUri = `${base}/api/v1/auth/oauth/ms-teams-connect/callback`;
      const tokenRes = await fetch(`https://login.microsoftonline.com/${aadTenantId}/oauth2/v2.0/token`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code,
          redirect_uri: redirectUri,
          client_id: cred.clientIdRef,
          client_secret: cred.clientSecretRef
        })
      });
      const tok = await tokenRes.json() as { access_token?: string; error_description?: string };
      if (!tok.access_token) throw new Error(tok.error_description ?? "Token exchange failed.");

      const meRes = await fetch("https://graph.microsoft.com/v1.0/me?$select=id", {
        headers: { Authorization: `Bearer ${tok.access_token}` }
      });
      const me = await meRes.json() as { id?: string };
      if (!me.id) throw new Error("Could not retrieve AAD Object ID from Microsoft Graph.");

      const teamsUserId = `8:orgid:${me.id}`;

      await prisma.userExternalAccount.upsert({
        where: { userId_provider: { userId: stateData.userId, provider: IntegrationPlatform.MS_TEAMS } },
        update: { externalUserId: teamsUserId, status: AccountStatus.CONNECTED },
        create: {
          userId: stateData.userId,
          provider: IntegrationPlatform.MS_TEAMS,
          externalUserId: teamsUserId
        }
      });

      return reply.redirect(`${base}/settings/notifications?ms_teams_connected=1`);
    } catch (err) {
      app.log.error({ err }, "[MS Teams Connect] callback error");
      return reply.redirect(
        `${base}/settings/notifications?ms_teams_error=${encodeURIComponent(err instanceof Error ? err.message : "Connection failed")}`
      );
    }
  });

  // ── Slack Connect OAuth (link Slack account while already logged in) ─────────

  app.get("/auth/oauth/slack-connect", async (request, reply) => {
    const { token } = request.query as { token?: string };
    if (!token) throw app.httpErrors.badRequest("token is required.");

    let userId: string;
    let tenantId: string;
    let tenantSlug: string;
    try {
      const payload = app.jwt.verify<{ userId: string; tenantId: string }>(token);
      userId = payload.userId;
      tenantId = payload.tenantId;
      const tenant = await prisma.tenant.findUnique({
        where: { id: tenantId },
        select: { slug: true }
      });
      if (!tenant) throw new Error("Tenant not found.");
      tenantSlug = tenant.slug;
    } catch {
      throw app.httpErrors.unauthorized("Invalid or expired token.");
    }

    const cred = decryptCredential(await prisma.tenantIntegrationCredential.findFirst({
      where: { tenantId, platform: IntegrationPlatform.SLACK, status: SourceStatus.ENABLED }
    }));
    if (!cred?.clientIdRef) {
      throw app.httpErrors.notImplemented("Slack OAuth is not configured or not enabled for this workspace.");
    }

    const state = await createConnectState(tenantSlug, userId);
    const base = oauthBase(request);
    const params = new URLSearchParams({
      response_type: "code",
      client_id: cred.clientIdRef,
      redirect_uri: `${base}/api/v1/auth/oauth/slack-connect/callback`,
      scope: "openid profile email",
      state
    });
    return reply.redirect(`https://slack.com/openid/connect/authorize?${params}`);
  });

  app.get("/auth/oauth/slack-connect/callback", async (request, reply) => {
    const { code, state, error } = request.query as Record<string, string>;
    const base = oauthBase(request);

    if (error || !code || !state) {
      return reply.redirect(
        `${base}/settings/notifications?slack_error=${encodeURIComponent(error ?? "Slack login cancelled")}`
      );
    }

    const stateData = await consumeConnectState(state);
    if (!stateData) {
      return reply.redirect(
        `${base}/settings/notifications?slack_error=${encodeURIComponent("Invalid or expired state. Please try again.")}`
      );
    }

    try {
      const tenant = await prisma.tenant.findUnique({
        where: { slug: stateData.tenantSlug },
        select: { id: true }
      });
      if (!tenant) throw new Error("Workspace not found.");

      const cred = decryptCredential(await prisma.tenantIntegrationCredential.findFirst({
        where: { tenantId: tenant.id, platform: IntegrationPlatform.SLACK }
      }));
      if (!cred?.clientIdRef || !cred?.clientSecretRef) {
        throw new Error("Slack credentials are no longer configured.");
      }

      const redirectUri = `${base}/api/v1/auth/oauth/slack-connect/callback`;
      const tokenRes = await fetch("https://slack.com/api/openid.connect.token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code,
          redirect_uri: redirectUri,
          client_id: cred.clientIdRef,
          client_secret: cred.clientSecretRef
        })
      });
      const tok = await tokenRes.json() as { ok?: boolean; id_token?: string; error?: string };
      if (!tok.ok || !tok.id_token) throw new Error(tok.error ?? "Token exchange failed.");

      // Verify Slack ID token signature against Slack's JWKS, and validate aud + iss claims
      const { payload: slackPayload } = await jwtVerify(tok.id_token, SLACK_JWKS, {
        issuer: "https://slack.com",
        audience: cred.clientIdRef,
      });
      const slackUserId = typeof slackPayload.sub === "string" ? slackPayload.sub : undefined;
      if (!slackUserId) throw new Error("Could not retrieve Slack member ID.");

      await prisma.userExternalAccount.upsert({
        where: { userId_provider: { userId: stateData.userId, provider: IntegrationPlatform.SLACK } },
        update: { externalUserId: slackUserId, status: AccountStatus.CONNECTED },
        create: {
          userId: stateData.userId,
          provider: IntegrationPlatform.SLACK,
          externalUserId: slackUserId
        }
      });

      return reply.redirect(`${base}/settings/notifications?slack_connected=1`);
    } catch (err) {
      app.log.error({ err }, "[Slack Connect] callback error");
      return reply.redirect(
        `${base}/settings/notifications?slack_error=${encodeURIComponent(err instanceof Error ? err.message : "Connection failed")}`
      );
    }
  });

  // Returns which OAuth providers are configured — tenant-level credentials take
  // precedence over server-level env fallbacks. Used by the login page.
  app.get("/auth/oauth/providers", async (request) => {
    const { tenantSlug } = request.query as { tenantSlug?: string };
    const slug = tenantSlug?.trim();
    if (slug) {
      const [ms365, google] = await Promise.all([
        resolveMs365OAuthCreds(slug),
        resolveGoogleOAuthCreds(slug)
      ]);
      return { ms365: Boolean(ms365), google: Boolean(google) };
    }
    return {
      ms365:  Boolean(config.MS365_CLIENT_ID && config.MS365_CLIENT_SECRET),
      google: Boolean(config.GOOGLE_CLIENT_ID && config.GOOGLE_CLIENT_SECRET)
    };
  });

  // Resolve a request hostname to a tenant slug, if it belongs to a subdomain
  // or verified custom domain. Returns null if the host is unclaimed (the normal
  // case for the shared app URL — user picks their workspace on the login form).
  async function resolveHostTenantSlug(host: string):
    Promise<{ tenantSlug: string; resolvedVia: "subdomain" | "custom-domain" } | null> {
    const h = host.trim().toLowerCase();
    if (!h) return null;

    // Tier 1: Subdomain — if BASE_DOMAIN is set and host is {slug}.basedomain
    const baseDomain = config.BASE_DOMAIN?.toLowerCase();
    if (baseDomain && h.endsWith(`.${baseDomain}`)) {
      const subdomain = h.slice(0, -(baseDomain.length + 1));
      if (subdomain && !subdomain.includes(".")) {
        const tenant = await prisma.tenant.findUnique({
          where: { slug: subdomain },
          select: { slug: true }
        });
        if (tenant) return { tenantSlug: tenant.slug, resolvedVia: "subdomain" };
      }
    }

    // Tier 2: Custom domain — look up in TenantCustomDomain table
    const record = await prisma.tenantCustomDomain.findFirst({
      where: { domain: h, status: "VERIFIED" },
      select: { tenant: { select: { slug: true } } }
    });
    if (record) return { tenantSlug: record.tenant.slug, resolvedVia: "custom-domain" };

    return null;
  }

  app.get("/auth/resolve-domain", async (request, reply) => {
    const host = (request.query as { host?: string }).host;
    if (!host) {
      throw app.httpErrors.badRequest("host query parameter is required.");
    }
    const resolved = await resolveHostTenantSlug(host);
    if (!resolved) {
      throw app.httpErrors.notFound("No tenant found for this host.");
    }
    return reply.send(resolved);
  });

  app.get("/auth/me", async (request) => {
    requireAuth(request);
    const tenantId = requireTenantId(request);
    const userId = requireUserId(request);
    const [user, subscription] = await Promise.all([
      prisma.user.findFirst({
        where: { id: userId, tenantId },
        select: {
          id: true,
          email: true,
          fullName: true,
          role: true,
          mustResetPassword: true,
          tenantId: true,
          managerUserId: true,
          teamId: true,
          avatarUrl: true
        }
      }),
      prisma.subscription.findFirst({
        where: { tenantId },
        select: { status: true, trialEndsAt: true, seatCount: true }
      })
    ]);
    if (!user) {
      throw app.httpErrors.notFound("Authenticated user not found.");
    }
    return {
      ...user,
      avatarUrl: resolveAvatarUrl(user.id, user.avatarUrl, tenantId),
      subscription: subscription ? {
        status: subscription.status,
        trialEndsAt: subscription.trialEndsAt,
        seatCount: subscription.seatCount
      } : null
    };
  });

  // Returns whether the current user has super-admin privileges (used by frontend to show admin UI).
  app.get("/auth/me/super-admin", async (request) => {
    requireAuth(request);
    return { isSuperAdmin: isSuperAdmin(request) };
  });

  // ── Avatar upload / remove ───────────────────────────────────────────────────

  /** H5: Detect MIME type from magic bytes — ignores client-supplied Content-Type. */
  function detectImageMimeType(buf: Buffer): string {
    // JPEG: FF D8 FF
    if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "image/jpeg";
    // PNG: 89 50 4E 47 0D 0A 1A 0A
    if (buf.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return "image/png";
    // WebP: 52 49 46 46 ?? ?? ?? ?? 57 45 42 50
    if (buf.length >= 12 && buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 &&
        buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50) return "image/webp";
    return "";
  }

  app.post("/auth/me/avatar", async (request, reply) => {
    requireAuth(request);
    const tenantId = requireTenantId(request);
    const userId   = requireUserId(request);

    const tenant = await prisma.tenant.findUnique({ where: { id: tenantId }, select: { slug: true } });
    if (!tenant) throw app.httpErrors.notFound("Tenant not found.");

    if (!isR2Configured) throw app.httpErrors.serviceUnavailable("File storage (R2) is not configured. Contact your administrator.");

    const MAX_BYTES = 2 * 1024 * 1024; // 2 MB

    let fileBuffer: Buffer | null = null;
    let mimeType = "image/jpeg";

    for await (const part of request.parts()) {
      if (part.type !== "file") continue;
      fileBuffer = await part.toBuffer();
      if (fileBuffer.length > MAX_BYTES) throw app.httpErrors.payloadTooLarge("Image must be smaller than 2 MB.");
      // H5: Verify MIME type via magic bytes — client-supplied mimetype is untrusted.
      mimeType = detectImageMimeType(fileBuffer);
      if (!mimeType) throw app.httpErrors.badRequest("Invalid file type. Allowed: JPEG, PNG, WebP.");
      break;
    }
    if (!fileBuffer) throw app.httpErrors.badRequest("No image file provided.");

    const slug = tenant.slug.replace(/[^a-z0-9-]/g, "-");
    const ext  = mimeType === "image/png" ? "png" : mimeType === "image/webp" ? "webp" : "jpg";
    const key  = `${slug}/avatars/${userId}.${ext}`;
    await uploadBufferToR2({ tenantSlug: slug, objectKeyOrRef: key, contentType: mimeType, data: fileBuffer });

    const rawUrl = buildR2PublicUrl(key) ?? buildR2ObjectRef(key);
    await prisma.user.update({ where: { id: userId }, data: { avatarUrl: rawUrl } });

    return reply.send({ avatarUrl: resolveAvatarUrl(userId, rawUrl, tenantId) ?? rawUrl });
  });

  app.delete("/auth/me/avatar", async (request) => {
    requireAuth(request);
    const tenantId = requireTenantId(request);
    const userId   = requireUserId(request);

    const user = await prisma.user.findFirst({ where: { id: userId, tenantId }, select: { avatarUrl: true, tenant: { select: { slug: true } } } });

    // M7: Delete the R2 object before clearing the DB field to avoid orphaned storage.
    if (user?.avatarUrl?.startsWith("r2://")) {
      try { await deleteR2Object(user.tenant.slug, user.avatarUrl); } catch { /* best-effort */ }
    }

    await prisma.user.update({ where: { id: userId }, data: { avatarUrl: null } });
    return { ok: true };
  });

  // ── Forgot / Reset password (H10) ────────────────────────────────────────────

  // Always returns 200 regardless of whether the user/tenant exists — prevents enumeration.
  app.post("/auth/forgot-password", async (request, reply) => {
    const parsed = forgotPasswordSchema.safeParse(request.body);
    if (!parsed.success) throw app.httpErrors.badRequest(zodMsg(parsed.error));

    const tenant = await prisma.tenant.findUnique({
      where: { slug: parsed.data.tenantSlug },
      select: { id: true }
    });
    if (!tenant) return reply.send({ ok: true });

    const user = await prisma.user.findFirst({
      where: { tenantId: tenant.id, email: parsed.data.email, isActive: true },
      select: { id: true, fullName: true, email: true }
    });
    if (!user) return reply.send({ ok: true });

    // Clean up any existing unused tokens for this user before creating a new one.
    await prisma.passwordResetToken.deleteMany({
      where: { tenantId: tenant.id, userId: user.id, usedAt: null }
    });

    const token     = randomBytes(32).toString("hex");
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000); // 1 hour
    await prisma.passwordResetToken.create({
      data: { token, tenantId: tenant.id, userId: user.id, expiresAt }
    });

    // Best-effort email delivery — failure must not leak whether the user exists.
    try {
      // Try tenant SMTP first, fall back to system SMTP env vars.
      const cred = await prisma.tenantIntegrationCredential.findUnique({
        where: { tenantId_platform: { tenantId: tenant.id, platform: IntegrationPlatform.EMAIL } },
        select: { clientIdRef: true, clientSecretRef: true, apiKeyRef: true, webhookTokenRef: true }
      }).then(r => decryptCredential(r));

      const branding = await prisma.tenantBranding.findUnique({
        where: { tenantId: tenant.id },
        select: { appName: true }
      });
      const appName = branding?.appName || "ThinkCRM";

      let emailConfig: EmailConfig | null = null;
      if (cred?.clientIdRef && cred?.apiKeyRef && cred?.webhookTokenRef) {
        emailConfig = {
          host: cred.clientIdRef,
          port: smtpPort(cred.clientSecretRef),
          fromAddress: cred.webhookTokenRef,
          password: cred.apiKeyRef
        };
      } else if (config.SMTP_HOST && config.SMTP_FROM) {
        emailConfig = {
          host: config.SMTP_HOST,
          port: config.SMTP_PORT,
          fromAddress: config.SMTP_FROM,
          password: config.SMTP_PASS ?? ""
        };
      }

      if (emailConfig) {
        const baseUrl = await getTenantUrl(tenant.id);
        const resetLink = `${baseUrl}/reset-password?token=${token}`;
        await sendEmailCard(
          emailConfig,
          user.email,
          {
            subject: `Password reset request — ${appName}`,
            title: `Reset your ${appName} password`,
            facts: [
              { label: "Requested for", value: user.email },
              { label: "Expires in",    value: "1 hour" }
            ],
            detailUrl: resetLink,
            footer: "If you did not request this, you can safely ignore this email."
          }
        );
      } else {
        app.log.warn(`[forgot-password] No SMTP configured (tenant or system) — password reset email for ${user.email} could not be sent.`);
      }
    } catch { /* never surface email errors */ }

    return reply.send({ ok: true });
  });

  app.post("/auth/reset-password", async (request) => {
    const parsed = resetPasswordSchema.safeParse(request.body);
    if (!parsed.success) throw app.httpErrors.badRequest(zodMsg(parsed.error));

    const record = await prisma.passwordResetToken.findUnique({
      where: { token: parsed.data.token }
    });
    if (!record || record.usedAt || record.expiresAt < new Date()) {
      throw app.httpErrors.badRequest("Invalid or expired reset token.");
    }

    const user = await prisma.user.findFirst({
      where: { id: record.userId, tenantId: record.tenantId, isActive: true },
      select: { id: true, tenantId: true }
    });
    if (!user) throw app.httpErrors.badRequest("Invalid or expired reset token.");

    await prisma.$transaction([
      prisma.user.update({
        where: { id: user.id },
        data: { passwordHash: hashPassword(parsed.data.newPassword), mustResetPassword: false }
      }),
      prisma.passwordResetToken.update({
        where: { token: parsed.data.token },
        data: { usedAt: new Date() }
      })
    ]);

    await logAuditEvent(user.tenantId, user.id, "PASSWORD_RESET", {}, request.ip);

    return { message: "Password reset successfully. Please login with your new password." };
  });

  // ── Email verification ──────────────────────────────────────────────────────

  /** Verify email address using the token sent after signup. */
  app.get("/auth/verify-email", async (request, reply) => {
    const { token } = request.query as { token?: string };
    if (!token) throw app.httpErrors.badRequest("Verification token is required.");

    const user = await prisma.user.findFirst({
      where: { emailVerifyToken: token },
      select: { id: true, tenantId: true, email: true, emailVerified: true, emailVerifyExpiresAt: true,
                tenant: { select: { slug: true } } }
    });
    if (!user) throw app.httpErrors.badRequest("Invalid verification token.");
    if (user.emailVerified) {
      return reply.send({ verified: true, tenantSlug: user.tenant.slug, message: "Email already verified. You can sign in." });
    }
    if (user.emailVerifyExpiresAt && user.emailVerifyExpiresAt < new Date()) {
      throw app.httpErrors.badRequest("Verification token has expired. Please request a new one.");
    }

    await prisma.user.update({
      where: { id: user.id },
      data: { emailVerified: true, emailVerifyToken: null, emailVerifyExpiresAt: null }
    });

    await logAuditEvent(user.tenantId, user.id, "EMAIL_VERIFIED", { email: user.email }, request.ip);

    return reply.send({ verified: true, tenantSlug: user.tenant.slug, message: "Email verified successfully! You can now sign in." });
  });

  /** Resend verification email (public, rate-limited by token regeneration). */
  app.post("/auth/resend-verification", async (request) => {
    const { tenantSlug, email } = request.body as { tenantSlug?: string; email?: string };
    if (!tenantSlug || !email) throw app.httpErrors.badRequest("tenantSlug and email are required.");

    const tenant = await prisma.tenant.findUnique({ where: { slug: tenantSlug }, select: { id: true } });
    if (!tenant) return { ok: true }; // Don't reveal tenant existence

    const user = await prisma.user.findFirst({
      where: { tenantId: tenant.id, email: email.toLowerCase(), isActive: true, emailVerified: false },
      select: { id: true, email: true, fullName: true, tenantId: true }
    });
    if (!user) return { ok: true }; // Don't reveal user existence

    // Generate a fresh token
    const emailVerifyToken = randomBytes(32).toString("hex");
    const emailVerifyExpiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
    await prisma.user.update({
      where: { id: user.id },
      data: { emailVerifyToken, emailVerifyExpiresAt }
    });

    // Best-effort email delivery
    try {
      const cred = await prisma.tenantIntegrationCredential.findUnique({
        where: { tenantId_platform: { tenantId: tenant.id, platform: IntegrationPlatform.EMAIL } },
        select: { clientIdRef: true, clientSecretRef: true, apiKeyRef: true, webhookTokenRef: true }
      }).then(r => decryptCredential(r));

      let emailConfig: EmailConfig | null = null;
      if (cred?.clientIdRef && cred?.apiKeyRef && cred?.webhookTokenRef) {
        emailConfig = {
          host: cred.clientIdRef,
          port: smtpPort(cred.clientSecretRef),
          fromAddress: cred.webhookTokenRef,
          password: cred.apiKeyRef
        };
      } else if (config.SMTP_HOST && config.SMTP_FROM) {
        emailConfig = {
          host: config.SMTP_HOST,
          port: config.SMTP_PORT,
          fromAddress: config.SMTP_FROM,
          password: config.SMTP_PASS ?? ""
        };
      }

      if (emailConfig) {
        const baseUrl = await getTenantUrl(tenant.id, tenantSlug);
        const verifyLink = `${baseUrl}/verify-email?token=${emailVerifyToken}`;
        await sendEmailCard(emailConfig, user.email, {
          subject: "Verify your email — ThinkCRM",
          title: "Verify your email address",
          facts: [
            { label: "Email", value: user.email },
            { label: "Expires in", value: "24 hours" }
          ],
          detailUrl: verifyLink,
          footer: "Click the button above to verify your email and activate your workspace."
        });
      }
    } catch { /* best-effort */ }

    return { ok: true };
  });

  // ── Accept invite (S4) ──────────────────────────────────────────────────────

  app.post("/auth/accept-invite", async (request, reply) => {
    const parsed = acceptInviteSchema.safeParse(request.body);
    if (!parsed.success) throw app.httpErrors.badRequest(zodMsg(parsed.error));

    const invite = await prisma.userInvite.findUnique({
      where: { token: parsed.data.token }
    });
    if (!invite || invite.acceptedAt || invite.expiresAt < new Date()) {
      throw app.httpErrors.badRequest("Invalid or expired invite token.");
    }

    // Check tenant is still active.
    const tenant = await prisma.tenant.findUnique({
      where: { id: invite.tenantId },
      select: { id: true, isActive: true, slug: true }
    });
    if (!tenant?.isActive) {
      throw app.httpErrors.badRequest("This workspace is no longer active.");
    }

    // Prevent duplicate if user was created by another path after the invite was sent.
    const existing = await prisma.user.findFirst({
      where: { tenantId: invite.tenantId, email: invite.email },
      select: { id: true }
    });
    if (existing) {
      // Mark invite as accepted and return conflict.
      await prisma.userInvite.update({ where: { id: invite.id }, data: { acceptedAt: new Date() } });
      throw app.httpErrors.conflict("A user with this email already exists in this workspace.");
    }

    // Create user + mark invite accepted in a transaction.
    const [user] = await prisma.$transaction([
      prisma.user.create({
        data: {
          tenantId: invite.tenantId,
          email: invite.email,
          fullName: parsed.data.fullName,
          role: invite.role as UserRole,
          teamId: invite.teamId,
          passwordHash: hashPassword(parsed.data.password),
          mustResetPassword: false,
          emailVerified: true
        }
      }),
      prisma.userInvite.update({
        where: { id: invite.id },
        data: { acceptedAt: new Date() }
      })
    ]);

    await logAuditEvent(invite.tenantId, user.id, "INVITE_ACCEPTED", { email: invite.email, invitedById: invite.invitedById }, request.ip);

    // Issue JWT so the user is immediately logged in.
    const token = await app.jwt.sign(
      { userId: user.id, tenantId: user.tenantId, role: user.role, email: user.email },
      { expiresIn: "1h" }
    );

    return reply.code(201).send({
      token,
      user: { id: user.id, email: user.email, fullName: user.fullName, role: user.role, tenantSlug: tenant.slug }
    });
  });

  // ── Refresh token (mobile) ───────────────────────────────────────────────────

  app.post("/auth/refresh", async (request) => {
    const { refreshToken: rt } = request.body as { refreshToken?: string };
    if (!rt || typeof rt !== "string") throw app.httpErrors.badRequest("refreshToken is required.");

    const record = await prisma.refreshToken.findUnique({ where: { token: rt } });
    if (!record || record.expiresAt < new Date()) {
      throw app.httpErrors.unauthorized("Invalid or expired refresh token.");
    }

    // Token rotation replay detection: if a previously-revoked token is reused,
    // an attacker may have stolen it. Revoke ALL tokens for this user as a precaution.
    if (record.revokedAt) {
      await prisma.refreshToken.updateMany({
        where: { userId: record.userId, revokedAt: null },
        data: { revokedAt: new Date() }
      });
      app.log.warn({ userId: record.userId }, "Revoked refresh token reused — all tokens revoked (possible token theft)");
      throw app.httpErrors.unauthorized("Invalid or expired refresh token.");
    }

    const user = await prisma.user.findFirst({
      where: { id: record.userId, tenantId: record.tenantId, isActive: true },
      select: { id: true, role: true, email: true, tenantId: true }
    });
    if (!user) throw app.httpErrors.unauthorized("User not found or inactive.");

    // Rotate: revoke old token and issue a new one atomically.
    const [, newRefreshToken] = await Promise.all([
      prisma.refreshToken.update({ where: { id: record.id }, data: { revokedAt: new Date() } }),
      createRefreshToken(record.tenantId, record.userId, record.deviceId ?? undefined),
    ]);

    const accessToken = await app.jwt.sign({
      userId: user.id,
      tenantId: user.tenantId,
      role: user.role,
      email: user.email
    }, { expiresIn: "15m" });

    return { accessToken, refreshToken: newRefreshToken, tokenType: "Bearer" };
  });

  // ── Logout (revoke refresh token) ─────────────────────────────────────────────

  app.post("/auth/logout", async (request) => {
    const { refreshToken: rt } = request.body as { refreshToken?: string };
    if (!rt || typeof rt !== "string") return { ok: true };

    await prisma.refreshToken.updateMany({
      where: { token: rt, revokedAt: null },
      data: { revokedAt: new Date() }
    });
    return { ok: true };
  });

  // ── Device registration (push tokens) ─────────────────────────────────────────

  app.post("/auth/devices", async (request) => {
    requireAuth(request);
    const tenantId = requireTenantId(request);
    const userId   = requireUserId(request);
    const parsed   = registerDeviceSchema.safeParse(request.body);
    if (!parsed.success) throw app.httpErrors.badRequest(zodMsg(parsed.error));

    const device = await prisma.userDevice.upsert({
      where: { userId_deviceToken: { userId, deviceToken: parsed.data.deviceToken } },
      update: { platform: parsed.data.platform, deviceName: parsed.data.deviceName },
      create: {
        tenantId,
        userId,
        platform: parsed.data.platform,
        deviceToken: parsed.data.deviceToken,
        deviceName: parsed.data.deviceName
      }
    });
    return { id: device.id, platform: device.platform, deviceToken: device.deviceToken };
  });

  app.delete("/auth/devices", async (request) => {
    requireAuth(request);
    const userId = requireUserId(request);
    const { deviceToken } = request.body as { deviceToken?: string };
    if (!deviceToken || typeof deviceToken !== "string") {
      throw app.httpErrors.badRequest("deviceToken is required.");
    }

    await prisma.userDevice.deleteMany({ where: { userId, deviceToken } });
    return { ok: true };
  });

  // ── WebAuthn Passkey ──────────────────────────────────────────────────────────

  /**
   * Derive WebAuthn RP ID / origin from the incoming request so passkeys work on
   * custom domains and subdomains. Falls back to APP_URL when no request is
   * provided (e.g. unit tests). The browser enforces that rpId matches the
   * current page's effective domain, so trusting request.hostname is safe.
   */
  function getWebAuthnRP(
    request?: { protocol?: string; hostname?: string }
  ): { rpId: string; rpName: string; origin: string } {
    if (request?.hostname) {
      const proto = request.protocol ?? "https";
      return {
        rpId: request.hostname,
        rpName: "ThinkCRM",
        origin: `${proto}://${request.hostname}`
      };
    }
    const appUrl = config.APP_URL ?? "http://localhost:3000";
    const url = new URL(appUrl);
    return {
      rpId: url.hostname,
      rpName: "ThinkCRM",
      origin: url.origin
    };
  }

  const passkeyLoginOptionsSchema = z.object({
    tenantSlug: z.string().min(2),
    email: z.string().email().transform(s => s.toLowerCase())
  });

  /** Cleanup expired challenges (best-effort, runs occasionally). */
  async function cleanupExpiredChallenges(): Promise<void> {
    if (Math.random() > 0.1) return; // ~10% chance per request
    await prisma.webAuthnChallenge.deleteMany({ where: { expiresAt: { lt: new Date() } } });
  }

  // ── Register passkey: step 1 — get options ──────────────────────────────────

  app.post("/auth/passkey/register-options", async (request) => {
    requireAuth(request);
    const tenantId = requireTenantId(request);
    const userId   = requireUserId(request);

    const user = await prisma.user.findFirst({
      where: { id: userId, tenantId, isActive: true },
      select: { id: true, email: true, fullName: true, passkeys: { select: { credentialId: true } } }
    });
    if (!user) throw app.httpErrors.notFound("User not found.");

    const MAX_PASSKEYS_PER_USER = 10;
    if (user.passkeys.length >= MAX_PASSKEYS_PER_USER) {
      throw app.httpErrors.badRequest(`Maximum of ${MAX_PASSKEYS_PER_USER} passkeys per user. Remove an existing passkey first.`);
    }

    const { rpId, rpName } = getWebAuthnRP(request);

    const options = await generateRegistrationOptions({
      rpName,
      rpID: rpId,
      userName: user.email,
      userDisplayName: user.fullName,
      excludeCredentials: user.passkeys.map(pk => ({
        id: pk.credentialId,
        transports: []
      })),
      authenticatorSelection: {
        residentKey: "preferred",
        userVerification: "preferred"
      },
      attestationType: "none"
    });

    // Store challenge in DB (not memory — works across serverless instances)
    await prisma.webAuthnChallenge.create({
      data: {
        challenge: options.challenge,
        userId,
        tenantId,
        type: "registration",
        expiresAt: new Date(Date.now() + 5 * 60 * 1000) // 5 minutes
      }
    });

    void cleanupExpiredChallenges();

    return options;
  });

  // ── Register passkey: step 2 — verify ───────────────────────────────────────

  app.post("/auth/passkey/register", async (request) => {
    requireAuth(request);
    const tenantId = requireTenantId(request);
    const userId   = requireUserId(request);
    const body = request.body as Record<string, unknown>;
    const deviceName = typeof body.deviceName === "string" ? body.deviceName.slice(0, 120) : "Passkey";
    const response = body.credential;
    if (!response || typeof response !== "object") {
      throw app.httpErrors.badRequest("Missing credential in request body.");
    }

    // Find and consume the challenge
    const challengeRecord = await prisma.webAuthnChallenge.findFirst({
      where: { userId, tenantId, type: "registration", expiresAt: { gt: new Date() } },
      orderBy: { createdAt: "desc" }
    });
    if (!challengeRecord) {
      throw app.httpErrors.badRequest("No pending registration challenge. Please start again.");
    }

    const { rpId, origin } = getWebAuthnRP(request);

    // Consume challenge immediately — single-use regardless of verification outcome
    await prisma.webAuthnChallenge.delete({ where: { id: challengeRecord.id } });

    let verification;
    try {
      verification = await verifyRegistrationResponse({
        response: response as any,
        expectedChallenge: challengeRecord.challenge,
        expectedOrigin: origin,
        expectedRPID: rpId,
        requireUserVerification: false
      });
    } catch {
      throw app.httpErrors.badRequest("Passkey registration verification failed. Please try again.");
    }

    if (!verification.verified || !verification.registrationInfo) {
      throw app.httpErrors.badRequest("Passkey registration verification failed.");
    }

    const { credential, aaguid } = verification.registrationInfo;

    // Save the passkey
    const passkey = await prisma.userPasskey.create({
      data: {
        userId,
        credentialId: credential.id,
        publicKey: Buffer.from(credential.publicKey),
        counter: credential.counter,
        transports: credential.transports ?? [],
        deviceName,
        aaguid: aaguid ?? null
      }
    });

    await logAuditEvent(tenantId, userId, "PASSKEY_REGISTERED", { passkeyId: passkey.id, deviceName }, request.ip);

    return {
      ok: true,
      passkey: {
        id: passkey.id,
        deviceName: passkey.deviceName,
        createdAt: passkey.createdAt
      }
    };
  });

  // ── Login with passkey: step 1 — get options ────────────────────────────────

  app.post("/auth/passkey/login-options", async (request) => {
    const parsed = passkeyLoginOptionsSchema.safeParse(request.body);
    if (!parsed.success) throw app.httpErrors.badRequest(zodMsg(parsed.error));

    const tenant = await prisma.tenant.findUnique({
      where: { slug: parsed.data.tenantSlug },
      select: { id: true }
    });
    if (!tenant) throw app.httpErrors.unauthorized("Invalid tenant or credentials.");

    const user = await prisma.user.findFirst({
      where: { tenantId: tenant.id, email: parsed.data.email, isActive: true },
      select: { id: true, passkeys: { select: { credentialId: true, transports: true } } }
    });
    // Return generic options even if user not found (timing attack defence)
    if (!user || user.passkeys.length === 0) {
      const dummyOptions = await generateAuthenticationOptions({
        rpID: getWebAuthnRP(request).rpId,
        userVerification: "preferred",
        allowCredentials: []
      });
      // Don't store challenge — it will never verify
      return dummyOptions;
    }

    const { rpId } = getWebAuthnRP(request);

    const options = await generateAuthenticationOptions({
      rpID: rpId,
      userVerification: "preferred",
      allowCredentials: user.passkeys.map(pk => ({
        id: pk.credentialId,
        transports: pk.transports as any[]
      }))
    });

    await prisma.webAuthnChallenge.create({
      data: {
        challenge: options.challenge,
        userId: user.id,
        tenantId: tenant.id,
        type: "authentication",
        expiresAt: new Date(Date.now() + 5 * 60 * 1000)
      }
    });

    void cleanupExpiredChallenges();

    return options;
  });

  // ── Login with passkey: step 2 — verify ─────────────────────────────────────

  app.post("/auth/passkey/login", async (request) => {
    const body = request.body as Record<string, unknown>;
    const tenantSlug = typeof body.tenantSlug === "string" ? body.tenantSlug : "";
    const email = typeof body.email === "string" ? body.email.toLowerCase() : "";
    const credential = body.credential;
    if (!tenantSlug || !email || !credential || typeof credential !== "object") {
      throw app.httpErrors.badRequest("tenantSlug, email, and credential are required.");
    }

    const tenant = await prisma.tenant.findUnique({
      where: { slug: tenantSlug },
      select: { id: true, slug: true, name: true }
    });
    if (!tenant) throw app.httpErrors.unauthorized("Invalid tenant or credentials.");

    const user = await prisma.user.findFirst({
      where: { tenantId: tenant.id, email, isActive: true },
      select: { id: true, email: true, fullName: true, role: true, tenantId: true, avatarUrl: true, emailVerified: true, mustResetPassword: true }
    });
    if (!user) throw app.httpErrors.unauthorized("Invalid tenant or credentials.");

    if (!user.emailVerified) {
      return { needsEmailVerification: true, tenantSlug: tenant.slug, email: user.email };
    }
    if (user.mustResetPassword) {
      throw app.httpErrors.forbidden("First login password reset required.");
    }

    // Find the challenge
    const challengeRecord = await prisma.webAuthnChallenge.findFirst({
      where: { userId: user.id, tenantId: tenant.id, type: "authentication", expiresAt: { gt: new Date() } },
      orderBy: { createdAt: "desc" }
    });
    if (!challengeRecord) {
      throw app.httpErrors.unauthorized("Invalid tenant or credentials.");
    }

    // Find the passkey credential
    const cred = credential as Record<string, unknown>;
    const credentialId = typeof cred.id === "string" ? cred.id : "";
    const passkey = await prisma.userPasskey.findUnique({ where: { credentialId } });
    if (!passkey || passkey.userId !== user.id) {
      throw app.httpErrors.unauthorized("Invalid tenant or credentials.");
    }

    const { rpId, origin } = getWebAuthnRP(request);

    // Consume challenge immediately — single-use regardless of verification outcome
    await prisma.webAuthnChallenge.delete({ where: { id: challengeRecord.id } });

    let verification;
    try {
      verification = await verifyAuthenticationResponse({
        response: credential as any,
        expectedChallenge: challengeRecord.challenge,
        expectedOrigin: origin,
        expectedRPID: rpId,
        requireUserVerification: false,
        credential: {
          id: passkey.credentialId,
          publicKey: passkey.publicKey,
          counter: Number(passkey.counter),
          transports: passkey.transports as any[]
        }
      });
    } catch (err: any) {
      await logAuditEvent(tenant.id, user.id, "LOGIN_FAILED", { email, reason: "passkey_verification_failed", error: err.message }, request.ip);
      throw app.httpErrors.unauthorized("Invalid tenant or credentials.");
    }

    if (!verification.verified) {
      throw app.httpErrors.unauthorized("Invalid tenant or credentials.");
    }

    // Update counter & last used timestamp
    await prisma.userPasskey.update({
      where: { id: passkey.id },
      data: {
        counter: verification.authenticationInfo.newCounter,
        lastUsedAt: new Date()
      }
    });

    const accessToken = await app.jwt.sign({
      userId: user.id,
      tenantId: tenant.id,
      role: user.role,
      email: user.email
    }, { expiresIn: "1h" });

    await logAuditEvent(tenant.id, user.id, "LOGIN", { email, method: "passkey", passkeyId: passkey.id }, request.ip);

    const refreshToken = await createRefreshToken(tenant.id, user.id);

    return {
      accessToken,
      refreshToken,
      tokenType: "Bearer",
      user: {
        id: user.id,
        tenantId: tenant.id,
        role: user.role,
        email: user.email,
        fullName: user.fullName,
        avatarUrl: resolveAvatarUrl(user.id, user.avatarUrl, tenant.id)
      }
    };
  });

  // ── List own passkeys ───────────────────────────────────────────────────────

  app.get("/auth/passkeys", async (request) => {
    requireAuth(request);
    const userId = requireUserId(request);

    const passkeys = await prisma.userPasskey.findMany({
      where: { userId },
      select: { id: true, deviceName: true, createdAt: true, lastUsedAt: true, aaguid: true },
      orderBy: { createdAt: "desc" }
    });

    return { passkeys };
  });

  // ── Delete own passkey ──────────────────────────────────────────────────────

  app.delete("/auth/passkeys/:passkeyId", async (request) => {
    requireAuth(request);
    const tenantId = requireTenantId(request);
    const userId   = requireUserId(request);
    const { passkeyId } = request.params as { passkeyId: string };

    const passkey = await prisma.userPasskey.findFirst({ where: { id: passkeyId, userId } });
    if (!passkey) throw app.httpErrors.notFound("Passkey not found.");

    await prisma.userPasskey.delete({ where: { id: passkeyId } });
    await logAuditEvent(tenantId, userId, "PASSKEY_DELETED", { passkeyId, deviceName: passkey.deviceName }, request.ip);

    return { ok: true };
  });

  // ── Admin: list passkeys for a user ─────────────────────────────────────────

  app.get("/auth/users/:userId/passkeys", async (request) => {
    requireAuth(request);
    const tenantId = requireTenantId(request);
    if (request.requestContext.role !== "ADMIN") throw app.httpErrors.forbidden("Only admins can manage other users' passkeys.");

    const { userId } = request.params as { userId: string };

    // Verify user belongs to same tenant
    const user = await prisma.user.findFirst({
      where: { id: userId, tenantId },
      select: { id: true, email: true, fullName: true }
    });
    if (!user) throw app.httpErrors.notFound("User not found.");

    const passkeys = await prisma.userPasskey.findMany({
      where: { userId },
      select: { id: true, deviceName: true, createdAt: true, lastUsedAt: true, aaguid: true },
      orderBy: { createdAt: "desc" }
    });

    return { user: { id: user.id, email: user.email, fullName: user.fullName }, passkeys };
  });

  // ── Admin: delete passkey for a user ────────────────────────────────────────

  app.delete("/auth/users/:userId/passkeys/:passkeyId", async (request) => {
    requireAuth(request);
    const tenantId = requireTenantId(request);
    const adminUserId = requireUserId(request);
    if (request.requestContext.role !== "ADMIN") throw app.httpErrors.forbidden("Only admins can manage other users' passkeys.");

    const { userId, passkeyId } = request.params as { userId: string; passkeyId: string };

    // Verify user belongs to same tenant
    const user = await prisma.user.findFirst({ where: { id: userId, tenantId }, select: { id: true } });
    if (!user) throw app.httpErrors.notFound("User not found.");

    const passkey = await prisma.userPasskey.findFirst({ where: { id: passkeyId, userId } });
    if (!passkey) throw app.httpErrors.notFound("Passkey not found.");

    await prisma.userPasskey.delete({ where: { id: passkeyId } });
    await logAuditEvent(tenantId, adminUserId, "PASSKEY_DELETED_BY_ADMIN", { passkeyId, targetUserId: userId, deviceName: passkey.deviceName }, request.ip);

    return { ok: true };
  });
};
