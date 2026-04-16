import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { config } from "../../config.js";
import { requireAuth, requireTenantId, requireUserId } from "../../lib/http.js";
import { hashPassword, verifyPassword } from "../../lib/password.js";
import { createOAuthState, consumeOAuthState, createConnectState, consumeConnectState, createLineConnectState, consumeLineConnectState } from "../../lib/oauth-state.js";
import { prisma } from "../../lib/prisma.js";
import { IntegrationPlatform, AccountStatus, SourceStatus } from "@prisma/client";

const loginSchema = z.object({
  tenantSlug: z.string().min(2),
  email: z.string().email(),
  password: z.string().min(8)
});

const firstLoginResetSchema = z.object({
  tenantSlug: z.string().min(2),
  email: z.string().email(),
  currentPassword: z.string().min(8),
  newPassword: z.string().min(8)
});

const profileUpdateSchema = z.object({
  fullName: z.string().min(1).max(120),
  email: z.string().email()
});

const changePasswordSchema = z.object({
  currentPassword: z.string().min(8),
  newPassword: z.string().min(8)
});

export const authRoutes: FastifyPluginAsync = async (app) => {
  app.post("/auth/login", async (request) => {
    const parsed = loginSchema.safeParse(request.body);
    if (!parsed.success) {
      throw app.httpErrors.badRequest(parsed.error.message);
    }

    const tenant = await prisma.tenant.findUnique({
      where: { slug: parsed.data.tenantSlug },
      select: { id: true, slug: true, name: true }
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
    if (!user || !verifyPassword(parsed.data.password, user.passwordHash)) {
      throw app.httpErrors.unauthorized("Invalid tenant or credentials.");
    }
    if (user.mustResetPassword) {
      throw app.httpErrors.forbidden("First login password reset required.");
    }

    const accessToken = await app.jwt.sign({
      userId: user.id,
      tenantId: tenant.id,
      role: user.role,
      email: user.email
    });

    return {
      accessToken,
      tokenType: "Bearer",
      user: {
        id: user.id,
        tenantId: tenant.id,
        role: user.role,
        email: user.email,
        fullName: user.fullName,
        avatarUrl: resolveAvatarUrl(user.id, user.avatarUrl)
      }
    };
  });

  app.post("/auth/first-login-reset", async (request) => {
    const parsed = firstLoginResetSchema.safeParse(request.body);
    if (!parsed.success) {
      throw app.httpErrors.badRequest(parsed.error.message);
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
    if (!parsed.success) throw app.httpErrors.badRequest(parsed.error.message);

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
    if (!parsed.success) throw app.httpErrors.badRequest(parsed.error.message);
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

  // Public endpoint — no auth required. Used by login page before authentication.
  app.get("/auth/branding/public", async (request, reply) => {
    const slug = (request.query as { slug?: string }).slug?.trim().toLowerCase();
    if (!slug) {
      throw app.httpErrors.badRequest("slug query parameter is required.");
    }
    const tenant = await prisma.tenant.findUnique({
      where: { slug },
      select: { id: true, name: true, branding: true }
    });
    if (!tenant) {
      throw app.httpErrors.notFound("Tenant not found.");
    }
    const b = tenant.branding;
    return reply.send({
      appName:        b?.appName        ?? tenant.name,
      primaryColor:   b?.primaryColor   ?? "#2563eb",
      secondaryColor: b?.secondaryColor ?? "#0f172a",
      themeMode:      b?.themeMode      ?? "LIGHT"
    });
  });

  // ── Avatar proxy ─────────────────────────────────────────────────────────────
  // Public endpoint — no auth required so <img src> works without JWT headers.
  // Resolves r2:// refs to a short-lived presigned URL and redirects.
  app.get("/auth/avatar/:userId", async (request, reply) => {
    const { userId } = request.params as { userId: string };
    const user = await prisma.user.findFirst({
      where: { id: userId },
      select: { avatarUrl: true, tenantId: true }
    });
    if (!user?.avatarUrl) throw app.httpErrors.notFound("Avatar not found.");

    if (user.avatarUrl.startsWith("r2://")) {
      const tenant = await prisma.tenant.findUnique({ where: { id: user.tenantId }, select: { slug: true } });
      if (!tenant) throw app.httpErrors.notFound("Avatar not found.");
      const { createR2PresignedDownload } = await import("../../lib/r2-storage.js");
      const { downloadUrl } = await createR2PresignedDownload({
        tenantSlug: tenant.slug,
        objectKeyOrRef: user.avatarUrl,
        expiresInSeconds: 3600
      });
      return reply.redirect(downloadUrl);
    }

    // Plain HTTPS URL (Google CDN, or public R2)
    return reply.redirect(user.avatarUrl);
  });

  /** Convert an r2:// ref to the proxy URL so the browser can load it without credentials. */
  function resolveAvatarUrl(userId: string, raw: string | null | undefined): string | null {
    if (!raw) return null;
    if (raw.startsWith("r2://")) return `/api/v1/auth/avatar/${userId}`;
    return raw;
  }

  // ── OAuth helpers ────────────────────────────────────────────────────────────

  function oauthBase(request: { headers: Record<string, string | string[] | undefined>; protocol: string; hostname: string }): string {
    if (config.APP_URL) return config.APP_URL.replace(/\/$/, "");
    const proto = (request.headers["x-forwarded-proto"] as string | undefined)?.split(",")[0]?.trim() ?? request.protocol;
    const host  = (request.headers["x-forwarded-host"] as string | undefined) ?? request.hostname;
    return `${proto}://${host}`;
  }

  // ── MS365 OAuth ──────────────────────────────────────────────────────────────

  app.get("/auth/oauth/ms365", async (request, reply) => {
    if (!config.MS365_CLIENT_ID) throw app.httpErrors.notImplemented("MS365 OAuth is not configured.");
    const { tenantSlug } = request.query as { tenantSlug?: string };
    if (!tenantSlug) throw app.httpErrors.badRequest("tenantSlug is required.");
    const state = createOAuthState(tenantSlug);
    const base  = oauthBase(request);
    const params = new URLSearchParams({
      client_id: config.MS365_CLIENT_ID, response_type: "code",
      redirect_uri: `${base}/api/v1/auth/oauth/ms365/callback`,
      scope: "openid email profile User.Read", response_mode: "query", state
    });
    return reply.redirect(`https://login.microsoftonline.com/${config.MS365_TENANT_ID}/oauth2/v2.0/authorize?${params}`);
  });

  app.get("/auth/oauth/ms365/callback", async (request, reply) => {
    const { code, state, error, error_description } = request.query as Record<string, string>;
    const base = oauthBase(request);
    if (error || !code || !state) {
      return reply.redirect(`${base}/?oauth_error=${encodeURIComponent(error_description ?? error ?? "OAuth cancelled")}`);
    }
    const tenantSlug = consumeOAuthState(state);
    if (!tenantSlug) {
      return reply.redirect(`${base}/?oauth_error=${encodeURIComponent("Invalid or expired state. Please try again.")}`);
    }
    try {
      const redirectUri = `${base}/api/v1/auth/oauth/ms365/callback`;
      const tokenRes = await fetch(`https://login.microsoftonline.com/${config.MS365_TENANT_ID}/oauth2/v2.0/token`, {
        method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ client_id: config.MS365_CLIENT_ID!, client_secret: config.MS365_CLIENT_SECRET!,
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
          const { uploadBufferToR2, buildR2PublicUrl, buildR2ObjectRef, isR2Configured } = await import("../../lib/r2-storage.js");
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

      const jwt = await app.jwt.sign({ userId: user.id, tenantId: tenant.id, role: user.role, email: user.email });
      return reply.redirect(`${base}/?oauth_token=${encodeURIComponent(jwt)}`);
    } catch (err) {
      app.log.error({ err }, "[MS365 OAuth] callback error");
      return reply.redirect(`${base}/?oauth_error=${encodeURIComponent(err instanceof Error ? err.message : "Login failed")}`);
    }
  });

  // ── Google OAuth ─────────────────────────────────────────────────────────────

  app.get("/auth/oauth/google", async (request, reply) => {
    if (!config.GOOGLE_CLIENT_ID) throw app.httpErrors.notImplemented("Google OAuth is not configured.");
    const { tenantSlug } = request.query as { tenantSlug?: string };
    if (!tenantSlug) throw app.httpErrors.badRequest("tenantSlug is required.");
    const state = createOAuthState(tenantSlug);
    const base  = oauthBase(request);
    const params = new URLSearchParams({
      client_id: config.GOOGLE_CLIENT_ID, response_type: "code",
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
    const tenantSlug = consumeOAuthState(state);
    if (!tenantSlug) {
      return reply.redirect(`${base}/?oauth_error=${encodeURIComponent("Invalid or expired state. Please try again.")}`);
    }
    try {
      const redirectUri = `${base}/api/v1/auth/oauth/google/callback`;
      const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
        method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ client_id: config.GOOGLE_CLIENT_ID!, client_secret: config.GOOGLE_CLIENT_SECRET!,
          code, redirect_uri: redirectUri, grant_type: "authorization_code" })
      });
      const tok = await tokenRes.json() as { id_token?: string; error_description?: string };
      if (!tok.id_token) throw new Error(tok.error_description ?? "Token exchange failed");

      // Decode Google ID token (JWT payload — already trusted, came directly from Google over HTTPS)
      const [, payloadB64 = ""] = tok.id_token.split(".");
      const payload = JSON.parse(Buffer.from(payloadB64, "base64url").toString()) as {
        email?: string; picture?: string;
      };
      const email = (payload.email ?? "").toLowerCase();
      if (!email) throw new Error("Could not read email from Google profile.");

      const tenant = await prisma.tenant.findUnique({ where: { slug: tenantSlug }, select: { id: true } });
      if (!tenant) throw new Error("Workspace not found.");
      const user = await prisma.user.findFirst({ where: { tenantId: tenant.id, email, isActive: true } });
      if (!user) throw new Error(`No active account for ${email} in this workspace.`);

      // Google picture is a public CDN URL — store directly
      if (payload.picture) {
        await prisma.user.update({ where: { id: user.id }, data: { avatarUrl: payload.picture } });
      }

      const jwt = await app.jwt.sign({ userId: user.id, tenantId: tenant.id, role: user.role, email: user.email });
      return reply.redirect(`${base}/?oauth_token=${encodeURIComponent(jwt)}`);
    } catch (err) {
      app.log.error({ err }, "[Google OAuth] callback error");
      return reply.redirect(`${base}/?oauth_error=${encodeURIComponent(err instanceof Error ? err.message : "Login failed")}`);
    }
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

    const cred = await prisma.tenantIntegrationCredential.findFirst({
      where: { tenantId, platform: IntegrationPlatform.LINE_LOGIN, status: SourceStatus.ENABLED }
    });
    if (!cred?.clientIdRef) {
      throw app.httpErrors.notImplemented("LINE Login is not configured or not enabled for this workspace.");
    }

    const state = createLineConnectState(tenantSlug, userId);
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

    const stateData = consumeLineConnectState(state);
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

      const cred = await prisma.tenantIntegrationCredential.findFirst({
        where: { tenantId: tenant.id, platform: IntegrationPlatform.LINE_LOGIN }
      });
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

    const cred = await prisma.tenantIntegrationCredential.findFirst({
      where: { tenantId, platform: IntegrationPlatform.MS365, status: SourceStatus.ENABLED }
    });
    if (!cred?.clientIdRef) {
      throw app.httpErrors.notImplemented("Microsoft 365 OAuth is not configured or not enabled for this workspace.");
    }

    // Tenant ID: per-tenant setting (webhookTokenRef) takes priority over server env var
    const aadTenantId = cred.webhookTokenRef ?? config.MS365_TENANT_ID;

    const state = createConnectState(tenantSlug, userId);
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

    const stateData = consumeConnectState(state);
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

      const cred = await prisma.tenantIntegrationCredential.findFirst({
        where: { tenantId: tenant.id, platform: IntegrationPlatform.MS365 }
      });
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

    const cred = await prisma.tenantIntegrationCredential.findFirst({
      where: { tenantId, platform: IntegrationPlatform.SLACK, status: SourceStatus.ENABLED }
    });
    if (!cred?.clientIdRef) {
      throw app.httpErrors.notImplemented("Slack OAuth is not configured or not enabled for this workspace.");
    }

    const state = createConnectState(tenantSlug, userId);
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

    const stateData = consumeConnectState(state);
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

      const cred = await prisma.tenantIntegrationCredential.findFirst({
        where: { tenantId: tenant.id, platform: IntegrationPlatform.SLACK }
      });
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

      // Decode Slack id_token (JWT) — sub field is the member ID (U...)
      const [, payloadB64 = ""] = tok.id_token.split(".");
      const slackPayload = JSON.parse(Buffer.from(payloadB64, "base64url").toString()) as {
        sub?: string;
      };
      const slackUserId = slackPayload.sub;
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

  // Returns which server-level OAuth providers are configured — used by the login page
  app.get("/auth/oauth/providers", async () => ({
    ms365:  Boolean(config.MS365_CLIENT_ID),
    google: Boolean(config.GOOGLE_CLIENT_ID)
  }));

  app.get("/auth/resolve-domain", async (request, reply) => {
    const host = (request.query as { host?: string }).host?.trim().toLowerCase();
    if (!host) {
      throw app.httpErrors.badRequest("host query parameter is required.");
    }
    const record = await prisma.tenantCustomDomain.findFirst({
      where: { domain: host, status: "VERIFIED" },
      select: { tenant: { select: { slug: true } } }
    });
    if (!record) {
      throw app.httpErrors.notFound("No verified custom domain found for this host.");
    }
    return reply.send({ tenantSlug: record.tenant.slug });
  });

  app.get("/auth/me", async (request) => {
    requireAuth(request);
    const tenantId = requireTenantId(request);
    const userId = requireUserId(request);
    const user = await prisma.user.findFirst({
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
    });
    if (!user) {
      throw app.httpErrors.notFound("Authenticated user not found.");
    }
    return { ...user, avatarUrl: resolveAvatarUrl(user.id, user.avatarUrl) };
  });

  // ── Avatar upload / remove ───────────────────────────────────────────────────

  app.post("/auth/me/avatar", async (request, reply) => {
    requireAuth(request);
    const tenantId = requireTenantId(request);
    const userId   = requireUserId(request);

    const tenant = await prisma.tenant.findUnique({ where: { id: tenantId }, select: { slug: true } });
    if (!tenant) throw app.httpErrors.notFound("Tenant not found.");

    const { isR2Configured, uploadBufferToR2, buildR2PublicUrl, buildR2ObjectRef } = await import("../../lib/r2-storage.js");
    if (!isR2Configured) throw app.httpErrors.serviceUnavailable("File storage (R2) is not configured. Contact your administrator.");

    const ALLOWED = new Set(["image/jpeg", "image/png", "image/webp"]);
    const MAX_BYTES = 2 * 1024 * 1024; // 2 MB

    let fileBuffer: Buffer | null = null;
    let mimeType = "image/jpeg";

    for await (const part of request.parts()) {
      if (part.type !== "file") continue;
      if (!ALLOWED.has(part.mimetype)) throw app.httpErrors.badRequest("Invalid file type. Allowed: JPEG, PNG, WebP.");
      fileBuffer = await part.toBuffer();
      if (fileBuffer.length > MAX_BYTES) throw app.httpErrors.payloadTooLarge("Image must be smaller than 2 MB.");
      mimeType = part.mimetype;
      break;
    }
    if (!fileBuffer) throw app.httpErrors.badRequest("No image file provided.");

    const slug = tenant.slug.replace(/[^a-z0-9-]/g, "-");
    const ext  = mimeType === "image/png" ? "png" : mimeType === "image/webp" ? "webp" : "jpg";
    const key  = `${slug}/avatars/${userId}.${ext}`;
    await uploadBufferToR2({ tenantSlug: slug, objectKeyOrRef: key, contentType: mimeType, data: fileBuffer });

    const rawUrl = buildR2PublicUrl(key) ?? buildR2ObjectRef(key);
    await prisma.user.update({ where: { id: userId }, data: { avatarUrl: rawUrl } });

    return reply.send({ avatarUrl: resolveAvatarUrl(userId, rawUrl) ?? rawUrl });
  });

  app.delete("/auth/me/avatar", async (request) => {
    requireAuth(request);
    const userId = requireUserId(request);
    await prisma.user.update({ where: { id: userId }, data: { avatarUrl: null } });
    return { ok: true };
  });
};
