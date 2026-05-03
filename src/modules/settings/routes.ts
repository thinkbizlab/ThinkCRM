import {
  ChannelType,
  Direction,
  EntityType,
  ExecutionStatus,
  IntegrationPlatform,
  Prisma,
  SourceStatus,
  SourceType,
  TriggerType,
  UserRole
} from "@prisma/client";
import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import { deflateSync } from "node:zlib";
import { writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import {
  assertTenantPathAccess,
  listActivePrincipalIds,
  listVisibleUserIds,
  requireAuth,
  requireRoleAtLeast,
  requireSelfOrManagerAccess,
  requireTenantId,
  requireUserId,
  zodMsg
} from "../../lib/http.js";
import { encryptField, decryptCredential } from "../../lib/secrets.js";
import { clearFederationCaches } from "../federation/customer-federation.js";
import { smtpPort } from "../../lib/smtp-port.js";
import { stableTeamsAppId } from "../../lib/ms-teams-app-id.js";
import { JOB_DEFS, rescheduleJob, runJobNow } from "../../lib/scheduler.js";
import { prisma } from "../../lib/prisma.js";
import { logAuditEvent } from "../../lib/audit.js";
import {
  buildR2PublicUrl,
  createR2PresignedDownload,
  createR2PresignedUpload,
  uploadBufferToR2,
  isR2Configured
} from "../../lib/r2-storage.js";

const r2UrlOrPathSchema = z
  .union([z.string().trim(), z.literal("")])
  .optional()
  .transform((value) => (value === "" ? undefined : value))
  .refine(
    (value) =>
      value === undefined ||
      value.startsWith("/uploads/") ||
      value.startsWith("r2://") ||
      z.url().safeParse(value).success,
    "Must be an absolute URL, r2:// reference, or an /uploads/ path."
  );

const themeHex = z
  .string()
  .trim()
  .regex(/^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/, "color must be hex (#RGB or #RRGGBB).")
  .transform(normalizeHexColor);

const emptyToUndef = (v: unknown) => (typeof v === "string" && v.trim() === "" ? undefined : v);

const boolFromForm = z
  .preprocess((v) => {
    if (typeof v === "boolean") return v;
    if (typeof v === "string") return v === "true" || v === "on" || v === "1";
    return undefined;
  }, z.boolean())
  .optional();

const brandingSchema = z.object({
  appName: z.string().trim().max(64).optional(),
  logoUrl: r2UrlOrPathSchema,
  faviconUrl: r2UrlOrPathSchema,
  primaryColor: z
    .string()
    .trim()
    .regex(/^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/, "primaryColor must be hex (#RGB or #RRGGBB).")
    .transform(normalizeHexColor),
  secondaryColor: z
    .string()
    .trim()
    .regex(/^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/, "secondaryColor must be hex (#RGB or #RRGGBB).")
    .transform(normalizeHexColor),
  accentGradientEnabled: z
    .preprocess((v) => {
      if (typeof v === "boolean") return v;
      if (typeof v === "string") return v === "true" || v === "on" || v === "1";
      return false;
    }, z.boolean())
    .optional(),
  accentGradientColor: z
    .string()
    .trim()
    .regex(/^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/, "accentGradientColor must be hex (#RGB or #RRGGBB).")
    .transform(normalizeHexColor)
    .optional(),
  accentGradientAngle: z.coerce.number().int().min(0).max(360).optional(),
  themeTokens: z
    .preprocess((v) => {
      if (typeof v === "string") {
        try { return JSON.parse(v); } catch { return {}; }
      }
      return v ?? {};
    }, z.object({
      background:  themeHex.optional(),
      text:        themeHex.optional(),
      accent:      themeHex.optional(),
      card:        themeHex.optional(),
      muted:       themeHex.optional(),
      border:      themeHex.optional(),
      destructive: themeHex.optional(),
      radius:      z.coerce.number().int().min(0).max(32).optional(),
      shadow:      z.enum(["NONE", "SM", "MD", "LG", "XL"]).optional()
    }).strict())
    .optional(),
  themeMode: z.enum(["LIGHT", "DARK"]).default("LIGHT"),
  loginTaglineHeadline: z.preprocess(emptyToUndef, z.string().trim().max(120).optional()),
  loginTaglineSubtext:  z.preprocess(emptyToUndef, z.string().trim().max(160).optional()),
  loginHeroImageUrl:    r2UrlOrPathSchema,
  loginWelcomeMessage:  z.preprocess(emptyToUndef, z.string().trim().max(200).optional()),
  loginFooterText:      z.preprocess(emptyToUndef, z.string().trim().max(200).optional()),
  loginTermsUrl:        z.preprocess(emptyToUndef, z.url("loginTermsUrl must be a URL.").max(300).optional()),
  loginPrivacyUrl:      z.preprocess(emptyToUndef, z.url("loginPrivacyUrl must be a URL.").max(300).optional()),
  loginSupportEmail:    z.preprocess(emptyToUndef, z.email("loginSupportEmail must be an email.").max(200).optional()),
  loginShowSignup:    boolFromForm,
  loginShowGoogle:    boolFromForm,
  loginShowMicrosoft: boolFromForm,
  loginShowPasskey:   boolFromForm
});

const kpiMonthPattern = /^\d{4}-(0[1-9]|1[0-2])$/;

const kpiTargetCreateSchema = z.object({
  userId: z.string().cuid(),
  targetMonth: z.string().regex(kpiMonthPattern, "targetMonth must be in YYYY-MM format."),
  visitTargetCount: z.coerce.number().int().min(0),
  newDealValueTarget: z.coerce.number().min(0),
  revenueTarget: z.coerce.number().min(0)
});

const kpiTargetUpdateSchema = z
  .object({
    userId: z.string().cuid().optional(),
    targetMonth: z.string().regex(kpiMonthPattern, "targetMonth must be in YYYY-MM format.").optional(),
    visitTargetCount: z.coerce.number().int().min(0).optional(),
    newDealValueTarget: z.coerce.number().min(0).optional(),
    revenueTarget: z.coerce.number().min(0).optional()
  })
  .refine(
    (payload) =>
      payload.userId !== undefined ||
      payload.targetMonth !== undefined ||
      payload.visitTargetCount !== undefined ||
      payload.newDealValueTarget !== undefined ||
      payload.revenueTarget !== undefined,
    { message: "At least one field is required to update KPI target." }
  );

const kpiTargetListQuerySchema = z.object({
  targetMonth: z.string().regex(kpiMonthPattern).optional(),
  userId: z.string().cuid().optional(),
  teamId: z.string().cuid().optional()
});

const kpiTargetImportRowSchema = z.object({
  email: z.string().email().transform((s) => s.toLowerCase()),
  targetMonth: z.string().regex(kpiMonthPattern, "targetMonth must be in YYYY-MM format."),
  visitTargetCount: z.coerce.number().int().min(0),
  newDealValueTarget: z.coerce.number().min(0),
  revenueTarget: z.coerce.number().min(0)
});

const teamCreateSchema = z.object({
  teamName: z.string().trim().min(1).max(120),
  isActive: z.boolean().optional().default(true)
});

const teamUpdateSchema = z
  .object({
    teamName: z.string().trim().min(1).max(120).optional(),
    isActive: z.boolean().optional()
  })
  .refine((payload) => payload.teamName !== undefined || payload.isActive !== undefined, {
    message: "At least one field is required to update a team."
  });

const teamMemberAssignSchema = z.object({
  userId: z.string().cuid()
});

const teamNotificationChannelsUpsertSchema = z.object({
  channels: z.array(
    z.object({
      channelType: z.nativeEnum(ChannelType),
      channelTarget: z.string().trim().min(1).max(400),
      isEnabled: z.boolean().optional().default(true)
    })
  )
});

const profileIntegrationConnectSchema = z.object({
  externalUserId: z.string().min(1),
  accessTokenRef: z.string().min(1).optional(),
  refreshTokenRef: z.string().min(1).optional()
});

const profileIntegrationProviders = [
  IntegrationPlatform.MS365,
  IntegrationPlatform.GOOGLE,
  IntegrationPlatform.LINE,
  IntegrationPlatform.SLACK,
  IntegrationPlatform.MS_TEAMS
] as const;

type ProfileIntegrationProvider = (typeof profileIntegrationProviders)[number];

const providerAliasMap: Record<string, ProfileIntegrationProvider> = {
  ms365: IntegrationPlatform.MS365,
  microsoft365: IntegrationPlatform.MS365,
  google: IntegrationPlatform.GOOGLE,
  google_calendar: IntegrationPlatform.GOOGLE,
  line: IntegrationPlatform.LINE,
  slack: IntegrationPlatform.SLACK,
  teams: IntegrationPlatform.MS_TEAMS,
  ms_teams: IntegrationPlatform.MS_TEAMS,
  msteams: IntegrationPlatform.MS_TEAMS,
  microsoft_teams: IntegrationPlatform.MS_TEAMS
};

function resolveProfileProvider(rawProvider: string): ProfileIntegrationProvider | null {
  const normalized = rawProvider.trim().toLowerCase();
  return providerAliasMap[normalized] ?? null;
}

const notifProviders = new Set<ProfileIntegrationProvider>([
  IntegrationPlatform.LINE,
  IntegrationPlatform.SLACK,
  IntegrationPlatform.MS_TEAMS
]);

function buildProfileIntegrationCapabilities(provider: ProfileIntegrationProvider): {
  calendarSyncEnabled: boolean;
  notificationsEnabled: boolean;
} {
  return {
    calendarSyncEnabled:
      provider === IntegrationPlatform.MS365 || provider === IntegrationPlatform.GOOGLE,
    notificationsEnabled: notifProviders.has(provider)
  };
}

function buildConnectOperationType(provider: ProfileIntegrationProvider): string {
  if (notifProviders.has(provider)) {
    return `${provider}_BIND_CONNECT`;
  }
  return "CALENDAR_BIND_CONNECT";
}

function buildSyncOperationType(provider: ProfileIntegrationProvider): string {
  if (notifProviders.has(provider)) {
    return `${provider}_NOTIFICATION_SYNC`;
  }
  return "CALENDAR_SYNC";
}

const tenantIntegrationPlatforms = [
  IntegrationPlatform.MS365,
  IntegrationPlatform.GOOGLE,
  IntegrationPlatform.LINE,
  IntegrationPlatform.LINE_LOGIN,
  IntegrationPlatform.MS_TEAMS,
  IntegrationPlatform.SLACK,
  IntegrationPlatform.EMAIL,
  IntegrationPlatform.ANTHROPIC,
  IntegrationPlatform.GEMINI,
  IntegrationPlatform.OPENAI
] as const;

// Summary/analysis providers are mutually exclusive per tenant — enabling one
// disables the others. OpenAI is intentionally excluded: it is used only for
// voice-note transcription (a separate capability) and can run alongside whichever
// summary provider the tenant has enabled.
const AI_SUMMARY_PLATFORMS = new Set<IntegrationPlatform>([
  IntegrationPlatform.ANTHROPIC,
  IntegrationPlatform.GEMINI
]);

type TenantIntegrationPlatform = (typeof tenantIntegrationPlatforms)[number];
const MAX_LOGO_BYTES = 5 * 1024 * 1024;
const logoMimeToExt = new Map<string, string>([
  ["image/png", ".png"],
  ["image/jpeg", ".jpg"],
  ["image/webp", ".webp"],
  ["image/svg+xml", ".svg"]
]);
// Folder each entity type maps to inside the tenant's R2 prefix.
const ENTITY_FOLDER: Record<string, string> = {
  VISIT:        "visits",
  DEAL:         "deals",
  CUSTOMER:     "customers",
  QUOTATION:    "quotations",
  ITEM:         "items",
  PAYMENT_TERM: "payment-terms"
};

const storagePresignUploadSchema = z.object({
  entityType: z.string().trim().toUpperCase().optional(),
  entityId:   z.string().trim().min(1).optional(),
  filename:   z.string().trim().min(1).max(255).optional(),
  // Legacy: caller may still supply a full objectKey directly (no entityType required)
  objectKey:  z.string().trim().min(1).optional(),
  contentType: z.string().trim().min(1).max(200).optional(),
  expiresInSeconds: z.coerce.number().int().min(60).max(3600).optional()
}).refine(
  (d) => d.objectKey || d.entityType,
  { message: "Provide either objectKey (legacy) or entityType." }
);
const storagePresignDownloadSchema = z.object({
  objectKey: z.string().trim().min(1),
  expiresInSeconds: z.coerce.number().int().min(60).max(3600).optional()
});

function normalizeHexColor(value: string): string {
  const color = value.trim();
  if (color.length === 4) {
    return `#${color[1]}${color[1]}${color[2]}${color[2]}${color[3]}${color[3]}`.toLowerCase();
  }
  return color.toLowerCase();
}

const tenantIntegrationCredentialSchema = z
  .object({
    clientId: z.string().trim().min(1).max(400).optional(),
    clientSecret: z.string().trim().min(1).max(400).optional(),
    apiKey: z.string().trim().min(1).max(400).optional(),
    webhookToken: z.string().trim().min(1).max(400).optional()
  })
  .refine(
    (value) =>
      value.clientId !== undefined ||
      value.clientSecret !== undefined ||
      value.apiKey !== undefined ||
      value.webhookToken !== undefined,
    { message: "At least one credential field is required." }
  );

const tenantIntegrationEnableSchema = z.object({
  enabled: z.boolean()
});

const userManagerAssignSchema = z.object({
  managerUserId: z.preprocess(v => (v === "" ? null : v), z.string().min(1).nullable())
});

const changelogQuerySchema = z.object({
  entityType: z.nativeEnum(EntityType).optional(),
  entityId: z.string().min(1).optional(),
  action: z.enum(["CREATE", "UPDATE", "DELETE"]).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional().default(100)
});

function maskCredential(value: string | null): string | null {
  if (!value) return null;
  if (value.length <= 4) return `${"*".repeat(Math.max(value.length - 1, 0))}${value.slice(-1)}`;
  return `${value.slice(0, 2)}***${value.slice(-2)}`;
}

function resolveTenantIntegrationPlatform(rawPlatform: string): TenantIntegrationPlatform | null {
  const normalized = rawPlatform.trim().toUpperCase();
  const resolved = IntegrationPlatform[normalized as keyof typeof IntegrationPlatform];
  if (!resolved) return null;
  return tenantIntegrationPlatforms.includes(resolved as TenantIntegrationPlatform)
    ? (resolved as TenantIntegrationPlatform)
    : null;
}

function mapTenantCredential(
  record:
    | {
        id: string;
        platform: IntegrationPlatform;
        status: SourceStatus;
        clientIdRef: string | null;
        clientSecretRef: string | null;
        apiKeyRef: string | null;
        webhookTokenRef: string | null;
        lastTestedAt: Date | null;
        lastTestResult: string | null;
        lastTestStatus: ExecutionStatus | null;
        updatedAt: Date;
      }
    | null,
  platform: TenantIntegrationPlatform
) {
  const activeRecord = record && record.platform === platform ? decryptCredential(record) : null;
  return {
    id: activeRecord?.id ?? null,
    platform,
    status: activeRecord?.status ?? SourceStatus.DISABLED,
    isEnabled: activeRecord?.status === SourceStatus.ENABLED,
    hasStoredCredentials: Boolean(
      activeRecord?.clientIdRef ||
        activeRecord?.clientSecretRef ||
        activeRecord?.apiKeyRef ||
        activeRecord?.webhookTokenRef
    ),
    credentialsMasked: {
      clientId: maskCredential(activeRecord?.clientIdRef ?? null),
      clientSecret: maskCredential(activeRecord?.clientSecretRef ?? null),
      apiKey: maskCredential(activeRecord?.apiKeyRef ?? null),
      webhookToken: maskCredential(activeRecord?.webhookTokenRef ?? null)
    },
    lastTestedAt: activeRecord?.lastTestedAt ?? null,
    lastTestResult: activeRecord?.lastTestResult ?? null,
    lastTestStatus: activeRecord?.lastTestStatus ?? null,
    canEnable: activeRecord?.lastTestStatus === ExecutionStatus.SUCCESS,
    updatedAt: activeRecord?.updatedAt ?? null
  };
}

// ── Platform connection tests ─────────────────────────────────────────────────

type CredentialRecord = {
  clientIdRef: string | null;
  clientSecretRef: string | null;
  apiKeyRef: string | null;
  webhookTokenRef: string | null;
};

async function runPlatformConnectionTest(
  platform: TenantIntegrationPlatform,
  cred: CredentialRecord
): Promise<{ testStatus: ExecutionStatus; testResult: string }> {
  const ok  = (msg: string) => ({ testStatus: ExecutionStatus.SUCCESS, testResult: msg });
  const err = (msg: string) => ({ testStatus: ExecutionStatus.FAILURE, testResult: msg });

  switch (platform) {

    case IntegrationPlatform.MS365: {
      if (!cred.clientIdRef || !cred.clientSecretRef) return err("Client ID and Client Secret are required.");
      const tenantId = cred.webhookTokenRef ?? "common";
      const res = await fetch(`https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ grant_type: "client_credentials", client_id: cred.clientIdRef,
          client_secret: cred.clientSecretRef, scope: "https://graph.microsoft.com/.default" })
      });
      const tok = await res.json() as { access_token?: string; error_description?: string };
      return tok.access_token ? ok("Microsoft 365 credentials verified — Graph API token acquired.") : err(tok.error_description ?? "Token request failed.");
    }

    case IntegrationPlatform.MS_TEAMS: {
      if (!cred.clientIdRef || !cred.clientSecretRef || !cred.webhookTokenRef)
        return err("App (Client) ID, Client Secret, and Tenant ID are all required.");
      // Step 1: acquire Bot Framework token
      const tokenRes = await fetch(`https://login.microsoftonline.com/${cred.webhookTokenRef}/oauth2/v2.0/token`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ grant_type: "client_credentials", client_id: cred.clientIdRef,
          client_secret: cred.clientSecretRef, scope: "https://api.botframework.com/.default" })
      });
      const tok = await tokenRes.json() as { access_token?: string; error_description?: string };
      if (!tok.access_token) return err(tok.error_description ?? "Token request failed — check App ID, Client Secret, and Tenant ID.");
      // Step 2: verify the App ID is recognized by the Bot Framework connector (catches mismatched App ID).
      // Success indicator: HTTP 400 Bad Request — means the connector accepted the JWT but rejected the
      // payload (expected — our test payload is minimal). HTTP 401 means the JWT itself was rejected
      // (wrong App ID). HTTP 5xx is inconclusive (connector may be temporarily unavailable).
      for (const serviceUrl of ["https://smba.trafficmanager.net/ap/", "https://smba.trafficmanager.net/apis/"]) {
        const probeRes = await fetch(`${serviceUrl}v3/conversations`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${tok.access_token}` },
          body: JSON.stringify({ bot: { id: cred.clientIdRef, name: "test" }, members: [{ id: "test" }], isGroup: false })
        });
        // H7: Explicitly accept 400 as success (JWT accepted, bad payload is expected).
        // Treat 5xx as inconclusive rather than erroneously reporting success.
        if (probeRes.status === 400) {
          return ok(`Bot Framework credentials verified — App ID recognized by connector.`);
        }
        if (probeRes.status >= 500) {
          return err(`Bot Framework connector returned ${probeRes.status} — server error. Credentials may be valid; try again in a moment.`);
        }
        if (probeRes.status !== 401) {
          // 2xx or other non-401/non-5xx — connector accepted the JWT
          return ok(`Bot Framework credentials verified — App ID recognized by connector (${probeRes.status}).`);
        }
        const body = await probeRes.json().catch(() => ({})) as { error?: { message?: string } };
        if (body.error?.message && !body.error.message.includes("Invalid JWT")) {
          return ok(`Bot Framework credentials verified — App ID recognized by connector.`);
        }
      }
      return err("Token acquired but Bot Framework connector rejected the App ID with 401 Invalid JWT. Ensure the App ID matches exactly what is shown in Azure Portal → Azure Bot → Configuration → Microsoft App ID.");
    }

    case IntegrationPlatform.LINE: {
      if (!cred.apiKeyRef) return err("Channel Access Token (API Key) is required.");
      const res = await fetch("https://api.line.me/v2/bot/info", {
        headers: { Authorization: `Bearer ${cred.apiKeyRef}` }
      });
      if (res.ok) {
        const info = await res.json() as { displayName?: string };
        return ok(`LINE bot connected — "${info.displayName ?? "unknown bot"}".`);
      }
      return err(`LINE API error ${res.status} — check the Channel Access Token.`);
    }

    case IntegrationPlatform.LINE_LOGIN: {
      if (!cred.clientIdRef || !cred.clientSecretRef) return err("Channel ID and Channel Secret are required.");
      // Verify the channel exists by calling LINE's token endpoint (will fail gracefully with wrong creds)
      const res = await fetch("https://api.line.me/oauth2/v2.1/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ grant_type: "authorization_code", code: "test",
          redirect_uri: "https://example.com", client_id: cred.clientIdRef, client_secret: cred.clientSecretRef })
      });
      // 400 "invalid_grant" means credentials are valid but the code is fake — that's expected
      // 401 / error about client means credentials are wrong
      const body = await res.json() as { error?: string; error_description?: string };
      if (res.status === 400 && body.error === "invalid_grant") {
        return ok("LINE Login credentials verified — Channel ID and Secret are valid.");
      }
      if (res.status === 401 || body.error === "invalid_client") {
        return err("Invalid Channel ID or Channel Secret.");
      }
      return ok("LINE Login credentials accepted.");
    }

    case IntegrationPlatform.SLACK: {
      if (!cred.apiKeyRef) return err("Bot Token is required.");
      const res = await fetch("https://slack.com/api/auth.test", {
        method: "POST",
        headers: { Authorization: `Bearer ${cred.apiKeyRef}`, "Content-Type": "application/json" }
      });
      const body = await res.json() as { ok: boolean; error?: string; team?: string; user?: string };
      return body.ok ? ok(`Slack connected — workspace: "${body.team}", bot: "${body.user}".`) : err(`Slack error: ${body.error ?? "auth.test failed"}`);
    }

    case IntegrationPlatform.EMAIL: {
      if (!cred.clientIdRef || !cred.apiKeyRef || !cred.webhookTokenRef) return err("SMTP Host, Password, and From Address are required.");
      const port = smtpPort(cred.clientSecretRef);
      const nodemailer = await import("nodemailer");
      const transporter = nodemailer.createTransport({
        host: cred.clientIdRef, port, secure: port === 465,
        auth: { user: cred.webhookTokenRef, pass: cred.apiKeyRef }
      });
      try {
        await transporter.verify();
        return ok(`SMTP connection verified — ${cred.clientIdRef}:${port}`);
      } catch (e) {
        return err(`SMTP error: ${e instanceof Error ? e.message : String(e)}`);
      }
    }

    case IntegrationPlatform.ANTHROPIC: {
      if (!cred.apiKeyRef) return err("API Key is required.");
      const res = await fetch("https://api.anthropic.com/v1/models", {
        headers: { "x-api-key": cred.apiKeyRef, "anthropic-version": "2023-06-01" }
      });
      if (res.ok) return ok("Anthropic API key verified.");
      const body = await res.json() as { error?: { message?: string } };
      return err(body.error?.message ?? `Anthropic API error ${res.status}`);
    }

    case IntegrationPlatform.OPENAI: {
      if (!cred.apiKeyRef) return err("API Key is required.");
      const res = await fetch("https://api.openai.com/v1/models", {
        headers: { Authorization: `Bearer ${cred.apiKeyRef}` }
      });
      if (res.ok) return ok("OpenAI API key verified.");
      const body = await res.json() as { error?: { message?: string } };
      return err(body.error?.message ?? `OpenAI API error ${res.status}`);
    }

    case IntegrationPlatform.GEMINI: {
      if (!cred.apiKeyRef) return err("API Key is required.");
      const res = await fetch("https://generativelanguage.googleapis.com/v1beta/models", {
        headers: { "x-goog-api-key": cred.apiKeyRef }
      });
      if (res.ok) return ok("Google Gemini API key verified.");
      const body = await res.json() as { error?: { message?: string } };
      return err(body.error?.message ?? `Gemini API error ${res.status}`);
    }

    case IntegrationPlatform.GOOGLE: {
      // Google OAuth cannot be tested with client_credentials — no server-to-server flow available.
      if (!cred.clientIdRef || !cred.clientSecretRef) return err("Client ID and Client Secret are required.");
      return ok("Google OAuth credentials saved. They will be verified on first user login (OAuth requires a user flow).");
    }

    default: {
      const hasAny = Boolean(cred.clientIdRef || cred.clientSecretRef || cred.apiKeyRef || cred.webhookTokenRef);
      return hasAny ? ok("Credentials saved.") : err("No credentials found.");
    }
  }
}

async function ensureRepBelongsToTenant(
  tenantId: string,
  userId: string,
  app: { httpErrors: { badRequest: (message: string) => Error } }
) {
  const rep = await prisma.user.findFirst({
    where: {
      id: userId,
      tenantId,
      role: UserRole.REP,
      isActive: true
    },
    select: {
      id: true,
      fullName: true,
      email: true,
      teamId: true
    }
  });
  if (!rep) {
    throw app.httpErrors.badRequest("Target sales rep was not found in this tenant or is inactive.");
  }
  return rep;
}

async function ensureTeamBelongsToTenant(
  tenantId: string,
  teamId: string,
  app: { httpErrors: { notFound: (message: string) => Error } }
) {
  const team = await prisma.team.findFirst({
    where: {
      id: teamId,
      tenantId
    },
    select: {
      id: true,
      teamName: true,
      isActive: true,
      createdAt: true,
      updatedAt: true
    }
  });
  if (!team) {
    throw app.httpErrors.notFound("Team not found in tenant.");
  }
  return team;
}


// ── PNG helper ────────────────────────────────────────────────────────────────
// Generates a minimal valid solid-colour PNG without external dependencies.

const CRC32_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf: Buffer): number {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) crc = (CRC32_TABLE[(crc ^ buf[i]!) & 0xff]!) ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const len = Buffer.allocUnsafe(4); len.writeUInt32BE(data.length);
  const typeBytes = Buffer.from(type, "ascii");
  const crcVal = Buffer.allocUnsafe(4);
  crcVal.writeUInt32BE(crc32(Buffer.concat([typeBytes, data])));
  return Buffer.concat([len, typeBytes, data, crcVal]);
}

function createSolidPng(width: number, height: number, r: number, g: number, b: number): Buffer {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

  const ihdrData = Buffer.allocUnsafe(13);
  ihdrData.writeUInt32BE(width, 0);
  ihdrData.writeUInt32BE(height, 4);
  ihdrData[8] = 8; ihdrData[9] = 2; ihdrData[10] = 0; ihdrData[11] = 0; ihdrData[12] = 0;

  const row = Buffer.allocUnsafe(1 + width * 3);
  row[0] = 0; // filter: None
  for (let x = 0; x < width; x++) { row[1 + x * 3] = r; row[2 + x * 3] = g; row[3 + x * 3] = b; }
  const raw = Buffer.concat(Array.from({ length: height }, () => row));
  const compressed = deflateSync(raw);

  return Buffer.concat([
    sig,
    pngChunk("IHDR", ihdrData),
    pngChunk("IDAT", compressed),
    pngChunk("IEND", Buffer.alloc(0))
  ]);
}

export const settingsRoutes: FastifyPluginAsync = async (app) => {
  async function ensureTargetUserInTenant(targetUserId: string, tenantId: string): Promise<void> {
    const target = await prisma.user.findFirst({
      where: {
        id: targetUserId,
        tenantId
      },
      select: { id: true }
    });
    if (!target) {
      throw app.httpErrors.notFound("Target user not found in tenant.");
    }
  }

  async function writeProfileIntegrationLog(input: {
    tenantId: string;
    userId: string;
    provider: ProfileIntegrationProvider;
    operationType: string;
    status: ExecutionStatus;
    responseSummary: string;
    payloadMasked?: Prisma.InputJsonValue;
    errorCode?: string;
    errorMessage?: string;
  }): Promise<void> {
    await prisma.integrationExecutionLog.create({
      data: {
        tenantId: input.tenantId,
        executedById: input.userId,
        platform: input.provider,
        operationType: input.operationType,
        direction: Direction.OUTBOUND,
        triggerType: TriggerType.MANUAL,
        status: input.status,
        responseSummary: input.responseSummary,
        payloadMasked: input.payloadMasked,
        errorCode: input.errorCode,
        errorMessage: input.errorMessage,
        completedAt: new Date()
      }
    });
  }

  async function connectProfileIntegration(input: {
    tenantId: string;
    userId: string;
    provider: ProfileIntegrationProvider;
    externalUserId: string;
    accessTokenRef?: string;
    refreshTokenRef?: string;
  }) {
    const account = await prisma.userExternalAccount.upsert({
      where: {
        userId_provider: {
          userId: input.userId,
          provider: input.provider
        }
      },
      update: {
        externalUserId: input.externalUserId,
        status: "CONNECTED"
      },
      create: {
        userId: input.userId,
        provider: input.provider,
        externalUserId: input.externalUserId
      }
    });

    const payloadMasked = {
      externalUserId: input.externalUserId,
      tokenLinked: Boolean(input.accessTokenRef),
      refreshTokenLinked: Boolean(input.refreshTokenRef)
    } satisfies Prisma.JsonObject;

    await writeProfileIntegrationLog({
      tenantId: input.tenantId,
      userId: input.userId,
      provider: input.provider,
      operationType: buildConnectOperationType(input.provider),
      status: ExecutionStatus.SUCCESS,
      responseSummary: `${input.provider} account connected.`,
      payloadMasked
    });
    await writeProfileIntegrationLog({
      tenantId: input.tenantId,
      userId: input.userId,
      provider: input.provider,
      operationType: buildSyncOperationType(input.provider),
      status: ExecutionStatus.SUCCESS,
      responseSummary:
        input.provider === IntegrationPlatform.LINE
          ? "Initial LINE notification sync completed."
          : "Initial calendar sync completed.",
      payloadMasked: {
        syncMode: "INITIAL"
      } satisfies Prisma.JsonObject
    });

    return {
      ...account,
      capabilities: buildProfileIntegrationCapabilities(input.provider)
    };
  }

  async function disconnectProfileIntegration(input: {
    tenantId: string;
    userId: string;
    provider: ProfileIntegrationProvider;
  }) {
    const account = await prisma.userExternalAccount.update({
      where: {
        userId_provider: {
          userId: input.userId,
          provider: input.provider
        }
      },
      data: {
        status: "DISCONNECTED"
      }
    });
    await writeProfileIntegrationLog({
      tenantId: input.tenantId,
      userId: input.userId,
      provider: input.provider,
      operationType: "PROFILE_ACCOUNT_DISCONNECT",
      status: ExecutionStatus.SUCCESS,
      responseSummary: `${input.provider} account disconnected.`
    });
    return {
      ...account,
      capabilities: buildProfileIntegrationCapabilities(input.provider)
    };
  }

  app.get("/tenants/:id/branding", async (request) => {
    const params = request.params as { id: string };
    assertTenantPathAccess(request, params.id);
    const branding = await prisma.tenantBranding.findUnique({ where: { tenantId: params.id } });
    if (!branding) return branding;
    const tenant = await prisma.tenant.findUnique({ where: { id: params.id }, select: { slug: true } });
    if (!tenant) return branding;
    const resolved = { ...branding } as typeof branding & { logoUrl?: string | null; faviconUrl?: string | null; loginHeroImageUrl?: string | null };
    // M10: Prefer fast R2 public CDN URL; fall back to presigned download URL.
    if (resolved.logoUrl?.startsWith("r2://")) {
      resolved.logoUrl = buildR2PublicUrl(resolved.logoUrl) ?? await (async () => {
        try {
          const dl = await createR2PresignedDownload({ tenantSlug: tenant.slug, objectKeyOrRef: resolved.logoUrl! });
          return dl.downloadUrl;
        } catch { return null; }
      })();
    }
    if (resolved.faviconUrl?.startsWith("r2://")) {
      resolved.faviconUrl = buildR2PublicUrl(resolved.faviconUrl) ?? await (async () => {
        try {
          const dl = await createR2PresignedDownload({ tenantSlug: tenant.slug, objectKeyOrRef: resolved.faviconUrl! });
          return dl.downloadUrl;
        } catch { return null; }
      })();
    }
    if (resolved.loginHeroImageUrl?.startsWith("r2://")) {
      resolved.loginHeroImageUrl = buildR2PublicUrl(resolved.loginHeroImageUrl) ?? await (async () => {
        try {
          const dl = await createR2PresignedDownload({ tenantSlug: tenant.slug, objectKeyOrRef: resolved.loginHeroImageUrl! });
          return dl.downloadUrl;
        } catch { return null; }
      })();
    }
    return resolved;
  });

  app.put("/tenants/:id/branding", async (request) => {
    const params = request.params as { id: string };
    requireRoleAtLeast(request, UserRole.ADMIN);
    assertTenantPathAccess(request, params.id);
    const parsed = brandingSchema.safeParse(request.body);
    if (!parsed.success) {
      throw app.httpErrors.badRequest(zodMsg(parsed.error));
    }

    const branding = await prisma.tenantBranding.upsert({
      where: { tenantId: params.id },
      update: parsed.data,
      create: { tenantId: params.id, ...parsed.data }
    });
    await logAuditEvent(
      params.id,
      requireUserId(request),
      "BRANDING_UPDATED",
      { fields: Object.keys(parsed.data) },
      request.ip
    );
    return branding;
  });

  app.post("/tenants/:id/branding/logo", async (request, reply) => {
    const params = request.params as { id: string };
    requireRoleAtLeast(request, UserRole.ADMIN);
    assertTenantPathAccess(request, params.id);

    const file = await request.file();
    if (!file) {
      throw app.httpErrors.badRequest("Logo file is required.");
    }
    const ext = logoMimeToExt.get(file.mimetype);
    if (!ext) {
      throw app.httpErrors.badRequest("Unsupported logo file type. Use png, jpg, webp, or svg.");
    }

    const logoBuffer = await file.toBuffer();
    if (logoBuffer.length > MAX_LOGO_BYTES) {
      throw app.httpErrors.badRequest("Logo exceeds 5MB limit.");
    }

    const tenant = await prisma.tenant.findUnique({ where: { id: params.id }, select: { slug: true } });
    if (!tenant) throw app.httpErrors.notFound("Tenant not found.");

    let logoUrl: string;
    let logoDownloadUrl: string;
    if (isR2Configured) {
      const objectKey = `branding/logos/${Date.now()}-${randomUUID()}${ext}`;
      let uploaded: { objectKey: string; objectRef: string };
      try {
        uploaded = await uploadBufferToR2({
          tenantSlug: tenant.slug,
          objectKeyOrRef: objectKey,
          contentType: file.mimetype,
          data: logoBuffer
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unknown upload failure.";
        throw app.httpErrors.badGateway(message);
      }
      logoUrl = uploaded.objectRef;
      const logoDownload = await createR2PresignedDownload({ tenantSlug: tenant.slug, objectKeyOrRef: uploaded.objectKey });
      logoDownloadUrl = logoDownload.downloadUrl;
    } else {
      const filename = `${Date.now()}-${randomUUID()}${ext}`;
      const uploadsDir = join(process.cwd(), "uploads");
      await mkdir(uploadsDir, { recursive: true });
      await writeFile(join(uploadsDir, filename), logoBuffer);
      logoUrl = `/uploads/${filename}`;
      logoDownloadUrl = logoUrl;
    }
    const branding = await prisma.tenantBranding.upsert({
      where: { tenantId: params.id },
      update: { logoUrl },
      create: {
        tenantId: params.id,
        logoUrl,
        primaryColor: "#2563eb",
        secondaryColor: "#0f172a",
        themeMode: "LIGHT"
      }
    });
    return reply.code(201).send({
      message: "Logo uploaded",
      logoUrl,
      logoDownloadUrl,
      branding
    });
  });

  app.post("/tenants/:id/branding/favicon", async (request, reply) => {
    const params = request.params as { id: string };
    requireRoleAtLeast(request, UserRole.ADMIN);
    assertTenantPathAccess(request, params.id);

    const file = await request.file();
    if (!file) {
      throw app.httpErrors.badRequest("Favicon file is required.");
    }
    const ext = logoMimeToExt.get(file.mimetype);
    if (!ext) {
      throw app.httpErrors.badRequest("Unsupported favicon file type. Use png, jpg, webp, or svg.");
    }

    const faviconBuffer = await file.toBuffer();
    if (faviconBuffer.length > MAX_LOGO_BYTES) {
      throw app.httpErrors.badRequest("Favicon exceeds 5MB limit.");
    }

    const tenantForFavicon = await prisma.tenant.findUnique({ where: { id: params.id }, select: { slug: true } });
    if (!tenantForFavicon) throw app.httpErrors.notFound("Tenant not found.");

    let faviconUrl: string;
    let faviconDownloadUrl: string;
    if (isR2Configured) {
      const objectKey = `branding/favicons/${Date.now()}-${randomUUID()}${ext}`;
      let uploaded: { objectKey: string; objectRef: string };
      try {
        uploaded = await uploadBufferToR2({
          tenantSlug: tenantForFavicon.slug,
          objectKeyOrRef: objectKey,
          contentType: file.mimetype,
          data: faviconBuffer
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unknown upload failure.";
        throw app.httpErrors.badGateway(message);
      }
      faviconUrl = uploaded.objectRef;
      const faviconDownload = await createR2PresignedDownload({ tenantSlug: tenantForFavicon.slug, objectKeyOrRef: uploaded.objectKey });
      faviconDownloadUrl = faviconDownload.downloadUrl;
    } else {
      const filename = `${Date.now()}-${randomUUID()}${ext}`;
      const uploadsDir = join(process.cwd(), "uploads");
      await mkdir(uploadsDir, { recursive: true });
      await writeFile(join(uploadsDir, filename), faviconBuffer);
      faviconUrl = `/uploads/${filename}`;
      faviconDownloadUrl = faviconUrl;
    }
    const branding = await prisma.tenantBranding.upsert({
      where: { tenantId: params.id },
      update: { faviconUrl },
      create: {
        tenantId: params.id,
        faviconUrl,
        primaryColor: "#2563eb",
        secondaryColor: "#0f172a",
        themeMode: "LIGHT"
      }
    });
    return reply.code(201).send({
      message: "Favicon uploaded",
      faviconUrl,
      faviconDownloadUrl,
      branding
    });
  });

  app.post("/tenants/:id/branding/login-hero", async (request, reply) => {
    const params = request.params as { id: string };
    requireRoleAtLeast(request, UserRole.ADMIN);
    assertTenantPathAccess(request, params.id);

    const file = await request.file();
    if (!file) {
      throw app.httpErrors.badRequest("Hero image file is required.");
    }
    const ext = logoMimeToExt.get(file.mimetype);
    if (!ext) {
      throw app.httpErrors.badRequest("Unsupported image file type. Use png, jpg, webp, or svg.");
    }

    const heroBuffer = await file.toBuffer();
    if (heroBuffer.length > MAX_LOGO_BYTES) {
      throw app.httpErrors.badRequest("Hero image exceeds 5MB limit.");
    }

    const tenantForHero = await prisma.tenant.findUnique({ where: { id: params.id }, select: { slug: true } });
    if (!tenantForHero) throw app.httpErrors.notFound("Tenant not found.");

    let loginHeroImageUrl: string;
    let loginHeroDownloadUrl: string;
    if (isR2Configured) {
      const objectKey = `branding/login-hero/${Date.now()}-${randomUUID()}${ext}`;
      let uploaded: { objectKey: string; objectRef: string };
      try {
        uploaded = await uploadBufferToR2({
          tenantSlug: tenantForHero.slug,
          objectKeyOrRef: objectKey,
          contentType: file.mimetype,
          data: heroBuffer
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unknown upload failure.";
        throw app.httpErrors.badGateway(message);
      }
      loginHeroImageUrl = uploaded.objectRef;
      const dl = await createR2PresignedDownload({ tenantSlug: tenantForHero.slug, objectKeyOrRef: uploaded.objectKey });
      loginHeroDownloadUrl = dl.downloadUrl;
    } else {
      const filename = `${Date.now()}-${randomUUID()}${ext}`;
      const uploadsDir = join(process.cwd(), "uploads");
      await mkdir(uploadsDir, { recursive: true });
      await writeFile(join(uploadsDir, filename), heroBuffer);
      loginHeroImageUrl = `/uploads/${filename}`;
      loginHeroDownloadUrl = loginHeroImageUrl;
    }
    const branding = await prisma.tenantBranding.upsert({
      where: { tenantId: params.id },
      update: { loginHeroImageUrl },
      create: {
        tenantId: params.id,
        loginHeroImageUrl,
        primaryColor: "#2563eb",
        secondaryColor: "#0f172a",
        themeMode: "LIGHT"
      }
    });
    return reply.code(201).send({
      message: "Login hero image uploaded",
      loginHeroImageUrl,
      loginHeroDownloadUrl,
      branding
    });
  });

  app.get("/tenants/:id/tax-config", async (request) => {
    const params = request.params as { id: string };
    requireRoleAtLeast(request, UserRole.MANAGER);
    assertTenantPathAccess(request, params.id);
    return prisma.tenantTaxConfig.findUnique({ where: { tenantId: params.id } });
  });

  app.put("/tenants/:id/tax-config", async (request) => {
    const params = request.params as { id: string };
    requireRoleAtLeast(request, UserRole.ADMIN);
    assertTenantPathAccess(request, params.id);
    const taxConfigSchema = z.object({
      vatEnabled: z.boolean(),
      vatRatePercent: z.number().min(0).max(100)
    });
    const parsed = taxConfigSchema.safeParse(request.body);
    if (!parsed.success) throw request.server.httpErrors.badRequest(parsed.error.issues[0]?.message ?? "Invalid input");
    return prisma.tenantTaxConfig.upsert({
      where: { tenantId: params.id },
      update: parsed.data,
      create: { tenantId: params.id, ...parsed.data }
    });
  });

  app.get("/tenants/:id/visit-config", async (request) => {
    const params = request.params as { id: string };
    requireRoleAtLeast(request, UserRole.MANAGER);
    assertTenantPathAccess(request, params.id);
    return prisma.tenantVisitConfig.findUnique({ where: { tenantId: params.id } });
  });

  app.put("/tenants/:id/visit-config", async (request) => {
    const params = request.params as { id: string };
    requireRoleAtLeast(request, UserRole.ADMIN);
    assertTenantPathAccess(request, params.id);
    const body = request.body as { checkInMaxDistanceM: number; minVisitDurationMinutes: number };
    const parsed = z.object({
      checkInMaxDistanceM: z.number().int().min(100).max(100_000),
      minVisitDurationMinutes: z.number().int().min(1).max(480)
    }).safeParse(body);
    if (!parsed.success) throw app.httpErrors.badRequest(zodMsg(parsed.error));
    return prisma.tenantVisitConfig.upsert({
      where: { tenantId: params.id },
      update: parsed.data,
      create: { tenantId: params.id, ...parsed.data }
    });
  });

  app.get("/tenants/:id/master-api-lock", async (request) => {
    const params = request.params as { id: string };
    requireRoleAtLeast(request, UserRole.MANAGER);
    assertTenantPathAccess(request, params.id);
    const t = await prisma.tenant.findUnique({
      where: { id: params.id },
      select: {
        manageCustomersByApi: true,
        manageItemsByApi: true,
        managePaymentTermsByApi: true,
        manageCustomerGroupsByApi: true
      }
    });
    if (!t) throw app.httpErrors.notFound("Tenant not found.");
    return t;
  });

  app.put("/tenants/:id/master-api-lock", async (request) => {
    const params = request.params as { id: string };
    requireRoleAtLeast(request, UserRole.ADMIN);
    assertTenantPathAccess(request, params.id);
    const parsed = z.object({
      manageCustomersByApi: z.boolean(),
      manageItemsByApi: z.boolean(),
      managePaymentTermsByApi: z.boolean(),
      manageCustomerGroupsByApi: z.boolean()
    }).safeParse(request.body);
    if (!parsed.success) throw app.httpErrors.badRequest(zodMsg(parsed.error));
    return prisma.tenant.update({
      where: { id: params.id },
      data: parsed.data,
      select: {
        manageCustomersByApi: true,
        manageItemsByApi: true,
        managePaymentTermsByApi: true,
        manageCustomerGroupsByApi: true
      }
    });
  });

  // ── Federated Customer Master config ──────────────────────────────────────
  // GET returns the current source id (or null). PUT sets/clears it. Setting
  // it to a non-null value flips the tenant into federated mode — Customer
  // mutations from the UI/API are blocked, reads hit the tenant's MySQL live.
  app.get("/tenants/:id/customer-federation", async (request) => {
    const params = request.params as { id: string };
    requireRoleAtLeast(request, UserRole.MANAGER);
    assertTenantPathAccess(request, params.id);
    const t = await prisma.tenant.findUnique({
      where: { id: params.id },
      select: {
        customerFederationSourceId: true,
        customerFederationSource: {
          select: { id: true, sourceName: true, sourceType: true, status: true }
        }
      }
    });
    if (!t) throw app.httpErrors.notFound("Tenant not found.");
    return t;
  });

  app.put("/tenants/:id/customer-federation", async (request) => {
    const params = request.params as { id: string };
    requireRoleAtLeast(request, UserRole.ADMIN);
    assertTenantPathAccess(request, params.id);
    const parsed = z.object({
      customerFederationSourceId: z.string().min(1).nullable()
    }).safeParse(request.body);
    if (!parsed.success) throw app.httpErrors.badRequest(zodMsg(parsed.error));

    if (parsed.data.customerFederationSourceId) {
      const source = await prisma.integrationSource.findFirst({
        where: {
          id: parsed.data.customerFederationSourceId,
          tenantId: params.id,
          sourceType: SourceType.MYSQL
        },
        select: { id: true }
      });
      if (!source) {
        throw app.httpErrors.badRequest("customerFederationSourceId must reference a MYSQL IntegrationSource owned by this tenant.");
      }
    }

    const updated = await prisma.tenant.update({
      where: { id: params.id },
      data: { customerFederationSourceId: parsed.data.customerFederationSourceId },
      select: {
        customerFederationSourceId: true,
        customerFederationSource: {
          select: { id: true, sourceName: true, sourceType: true, status: true }
        }
      }
    });
    // Drop cached config so the next request re-resolves.
    clearFederationCaches(params.id);
    return updated;
  });

  app.post("/users/:id/integrations/ms365/connect", async (request, reply) => {
    const params = request.params as { id: string };
    await requireSelfOrManagerAccess(request, params.id);
    const tenantId = requireTenantId(request);
    await ensureTargetUserInTenant(params.id, tenantId);
    const parsed = profileIntegrationConnectSchema.safeParse(request.body);
    if (!parsed.success) {
      throw app.httpErrors.badRequest(zodMsg(parsed.error));
    }

    const account = await connectProfileIntegration({
      tenantId,
      userId: params.id,
      provider: IntegrationPlatform.MS365,
      externalUserId: parsed.data.externalUserId,
      accessTokenRef: parsed.data.accessTokenRef,
      refreshTokenRef: parsed.data.refreshTokenRef
    });
    return reply.code(201).send(account);
  });

  app.post("/users/:id/integrations/google/connect", async (request, reply) => {
    const params = request.params as { id: string };
    await requireSelfOrManagerAccess(request, params.id);
    const tenantId = requireTenantId(request);
    await ensureTargetUserInTenant(params.id, tenantId);
    const parsed = profileIntegrationConnectSchema.safeParse(request.body);
    if (!parsed.success) {
      throw app.httpErrors.badRequest(zodMsg(parsed.error));
    }

    const account = await connectProfileIntegration({
      tenantId,
      userId: params.id,
      provider: IntegrationPlatform.GOOGLE,
      externalUserId: parsed.data.externalUserId,
      accessTokenRef: parsed.data.accessTokenRef,
      refreshTokenRef: parsed.data.refreshTokenRef
    });
    return reply.code(201).send(account);
  });

  app.post("/users/:id/integrations/line/connect", async (request, reply) => {
    const params = request.params as { id: string };
    await requireSelfOrManagerAccess(request, params.id);
    const tenantId = requireTenantId(request);
    await ensureTargetUserInTenant(params.id, tenantId);
    const parsed = profileIntegrationConnectSchema.safeParse(request.body);
    if (!parsed.success) {
      throw app.httpErrors.badRequest(zodMsg(parsed.error));
    }

    const account = await connectProfileIntegration({
      tenantId,
      userId: params.id,
      provider: IntegrationPlatform.LINE,
      externalUserId: parsed.data.externalUserId,
      accessTokenRef: parsed.data.accessTokenRef,
      refreshTokenRef: parsed.data.refreshTokenRef
    });
    return reply.code(201).send(account);
  });

  app.post("/users/:id/integrations/:provider/connect", async (request, reply) => {
    const params = request.params as { id: string; provider: string };
    await requireSelfOrManagerAccess(request, params.id);
    const tenantId = requireTenantId(request);
    await ensureTargetUserInTenant(params.id, tenantId);
    const provider = resolveProfileProvider(params.provider);
    if (!provider) {
      throw app.httpErrors.badRequest("Unsupported profile integration provider.");
    }
    const parsed = profileIntegrationConnectSchema.safeParse(request.body);
    if (!parsed.success) {
      throw app.httpErrors.badRequest(zodMsg(parsed.error));
    }
    const account = await connectProfileIntegration({
      tenantId,
      userId: params.id,
      provider,
      externalUserId: parsed.data.externalUserId,
      accessTokenRef: parsed.data.accessTokenRef,
      refreshTokenRef: parsed.data.refreshTokenRef
    });
    return reply.code(201).send(account);
  });

  app.delete("/users/:id/integrations/:provider", async (request) => {
    const params = request.params as { id: string; provider: string };
    await requireSelfOrManagerAccess(request, params.id);
    const tenantId = requireTenantId(request);
    await ensureTargetUserInTenant(params.id, tenantId);
    const provider = resolveProfileProvider(params.provider);
    if (!provider) {
      throw app.httpErrors.badRequest("Unsupported profile integration provider.");
    }
    const existing = await prisma.userExternalAccount.findUnique({
      where: {
        userId_provider: {
          userId: params.id,
          provider
        }
      },
      select: { id: true }
    });
    if (!existing) {
      throw app.httpErrors.notFound("Integration account not found.");
    }
    return disconnectProfileIntegration({
      tenantId,
      userId: params.id,
      provider
    });
  });

  app.post("/users/:id/test-teams-dm", async (request) => {
    const params = request.params as { id: string };
    await requireSelfOrManagerAccess(request, params.id);
    const tenantId = requireTenantId(request);
    await ensureTargetUserInTenant(params.id, tenantId);

    const [acct, botCred, ms365Cred, branding] = await Promise.all([
      prisma.userExternalAccount.findUnique({
        where: { userId_provider: { userId: params.id, provider: IntegrationPlatform.MS_TEAMS } }
      }),
      prisma.tenantIntegrationCredential.findUnique({
        where: { tenantId_platform: { tenantId, platform: IntegrationPlatform.MS_TEAMS } },
        select: { clientIdRef: true, clientSecretRef: true, webhookTokenRef: true, status: true }
      }).then(r => decryptCredential(r)),
      prisma.tenantIntegrationCredential.findUnique({
        where: { tenantId_platform: { tenantId, platform: IntegrationPlatform.MS365 } },
        select: { clientIdRef: true, clientSecretRef: true, webhookTokenRef: true, status: true }
      }).then(r => decryptCredential(r)),
      prisma.tenantBranding.findUnique({ where: { tenantId }, select: { appName: true } })
    ]);

    if (!acct) return { ok: false, message: "User has no MS Teams account connected. Ask them to use the 'Connect with Microsoft Teams' button on their Notifications page." };
    if (!botCred?.clientIdRef || !botCred?.clientSecretRef || !botCred?.webhookTokenRef) return { ok: false, message: "MS Teams Bot credentials are incomplete. Check Settings → Integrations → Microsoft Teams." };
    if (botCred.status !== SourceStatus.ENABLED) return { ok: false, message: "MS Teams integration is disabled. Enable it in Settings → Integrations → Microsoft Teams." };

    const appName = branding?.appName || "ThinkCRM";
    const testMsg = `🔔 Test message from ${appName} — your Teams notifications are working!`;
    const meta = acct.metadata as { serviceUrl?: string; conversationId?: string; chatId?: string } | null;

    const { sendTeamsDmViaGraph, sendTeamsDirectMessage } = await import("../../lib/teams-notify.js");

    // ── Try Graph API first (more reliable — no pairwise ID required) ─────────
    if (ms365Cred?.clientIdRef && ms365Cred?.clientSecretRef && ms365Cred?.status === SourceStatus.ENABLED) {
      const aadObjectId = acct.externalUserId.replace(/^8:orgid:/, "").replace(/^29:/, "");
      const graphCreds = {
        clientId: ms365Cred.clientIdRef,
        clientSecret: ms365Cred.clientSecretRef,
        tenantId: ms365Cred.webhookTokenRef ?? botCred.webhookTokenRef,
        botAppId: botCred.clientIdRef
      };
      const result = await sendTeamsDmViaGraph(aadObjectId, graphCreds, testMsg, meta?.chatId);
      if (result.ok) {
        // Cache the chatId for future sends
        if (result.chatId && result.chatId !== meta?.chatId) {
          await prisma.userExternalAccount.update({
            where: { id: acct.id },
            data: { metadata: { ...meta, chatId: result.chatId } }
          });
        }
        return { ok: true, message: "Test DM sent successfully via Graph API!", method: "graph", userMri: acct.externalUserId };
      }
      app.log.warn(`[test-dm] Graph API failed: ${result.message} — trying Bot Framework fallback`);
    }

    // ── Fallback: Bot Framework with stored convRef ───────────────────────────
    const botCreds = { appId: botCred.clientIdRef, appPassword: botCred.clientSecretRef, tenantId: botCred.webhookTokenRef };
    const convRef = meta?.serviceUrl && meta?.conversationId
      ? { serviceUrl: meta.serviceUrl, conversationId: meta.conversationId }
      : undefined;

    const result = await sendTeamsDirectMessage(acct.externalUserId, botCreds, testMsg, convRef);

    return {
      ok: result.ok,
      message: result.ok ? "Test DM sent successfully via Bot Framework!" : result.message,
      method: "bot-framework",
      userMri: acct.externalUserId,
      hasConvRef: !!convRef,
      convRefServiceUrl: convRef?.serviceUrl
    };
  });

  app.get("/users/:id/integrations", async (request) => {
    const params = request.params as { id: string };
    await requireSelfOrManagerAccess(request, params.id);
    const tenantId = requireTenantId(request);
    await ensureTargetUserInTenant(params.id, tenantId);

    const [accounts, logs, lineLoginCred, ms365Cred, msTeamsCred, slackCred] = await Promise.all([
      prisma.userExternalAccount.findMany({
        where: {
          userId: params.id,
          provider: { in: [...profileIntegrationProviders] }
        }
      }),
      prisma.integrationExecutionLog.findMany({
        where: {
          tenantId,
          executedById: params.id,
          platform: { in: [...profileIntegrationProviders] },
          status: ExecutionStatus.SUCCESS
        },
        orderBy: { startedAt: "desc" }
      }),
      prisma.tenantIntegrationCredential.findFirst({
        where: { tenantId, platform: IntegrationPlatform.LINE_LOGIN, status: SourceStatus.ENABLED },
        select: { id: true }
      }),
      prisma.tenantIntegrationCredential.findFirst({
        where: { tenantId, platform: IntegrationPlatform.MS365, status: SourceStatus.ENABLED },
        select: { id: true, clientIdRef: true }
      }),
      prisma.tenantIntegrationCredential.findFirst({
        where: { tenantId, platform: IntegrationPlatform.MS_TEAMS, status: SourceStatus.ENABLED },
        select: { id: true }
      }),
      prisma.tenantIntegrationCredential.findFirst({
        where: { tenantId, platform: IntegrationPlatform.SLACK, status: SourceStatus.ENABLED },
        select: { id: true, clientIdRef: true }
      })
    ]);

    const accountByProvider = new Map(accounts.map((account) => [account.provider, account]));
    const latestConnectByProvider = new Map<ProfileIntegrationProvider, Date>();
    const latestCalendarSyncByProvider = new Map<ProfileIntegrationProvider, Date>();
    const latestNotifSyncByProvider = new Map<ProfileIntegrationProvider, Date>();

    for (const log of logs) {
      const provider = log.platform as ProfileIntegrationProvider;
      const completedAt = log.completedAt ?? log.startedAt;

      if (
        (log.operationType === "CALENDAR_BIND_CONNECT" || log.operationType.endsWith("_BIND_CONNECT")) &&
        !latestConnectByProvider.has(provider)
      ) {
        latestConnectByProvider.set(provider, completedAt);
      }
      if (log.operationType === "CALENDAR_SYNC" && !latestCalendarSyncByProvider.has(provider)) {
        latestCalendarSyncByProvider.set(provider, completedAt);
      }
      if (log.operationType.endsWith("_NOTIFICATION_SYNC") && !latestNotifSyncByProvider.has(provider)) {
        latestNotifSyncByProvider.set(provider, completedAt);
      }
    }

    return profileIntegrationProviders.map((provider) => {
      const account = accountByProvider.get(provider);
      const capabilities = buildProfileIntegrationCapabilities(provider);
      return {
        provider,
        status: account?.status ?? "DISCONNECTED",
        externalUserId: account?.externalUserId ?? null,
        connectedAt: latestConnectByProvider.get(provider) ?? null,
        lastCalendarSyncAt: capabilities.calendarSyncEnabled
          ? latestCalendarSyncByProvider.get(provider) ?? null
          : null,
        lastNotificationSyncAt: capabilities.notificationsEnabled
          ? latestNotifSyncByProvider.get(provider) ?? null
          : null,
        capabilities,
        // Platform-specific OAuth connect availability
        ...(provider === IntegrationPlatform.LINE && { lineLoginEnabled: lineLoginCred !== null }),
        ...(provider === IntegrationPlatform.MS_TEAMS && { msTeamsConnectEnabled: ms365Cred?.clientIdRef != null && msTeamsCred !== null }),
        ...(provider === IntegrationPlatform.SLACK && { slackConnectEnabled: slackCred?.clientIdRef != null })
      };
    });
  });

  app.get("/tenants/:id/integrations/credentials", async (request) => {
    const params = request.params as { id: string };
    requireRoleAtLeast(request, UserRole.MANAGER);
    assertTenantPathAccess(request, params.id);
    const rows = await prisma.tenantIntegrationCredential.findMany({
      where: {
        tenantId: params.id,
        platform: {
          in: [...tenantIntegrationPlatforms]
        }
      },
      orderBy: [{ platform: "asc" }]
    });
    const rowsByPlatform = new Map(rows.map((row) => [row.platform, row]));
    return tenantIntegrationPlatforms.map((platform) =>
      mapTenantCredential(rowsByPlatform.get(platform) ?? null, platform)
    );
  });

  app.put("/tenants/:id/integrations/credentials/:platform", async (request) => {
    const params = request.params as { id: string; platform: string };
    requireRoleAtLeast(request, UserRole.MANAGER);
    assertTenantPathAccess(request, params.id);
    const platform = resolveTenantIntegrationPlatform(params.platform);
    if (!platform) {
      throw app.httpErrors.badRequest("Unsupported tenant integration platform.");
    }
    const parsed = tenantIntegrationCredentialSchema.safeParse(request.body);
    if (!parsed.success) {
      throw app.httpErrors.badRequest(zodMsg(parsed.error));
    }

    // H6: For EMAIL, clientSecret holds the SMTP port — validate it is a valid port number.
    if (platform === IntegrationPlatform.EMAIL && parsed.data.clientSecret !== undefined) {
      const port = parseInt(parsed.data.clientSecret, 10);
      if (!Number.isInteger(port) || port < 1 || port > 65535) {
        throw app.httpErrors.badRequest("SMTP Port must be a valid port number (1–65535). Common values: 587 (STARTTLS), 465 (SSL), 25.");
      }
    }

    const fieldUpdates: Record<string, unknown> = {};
    if (parsed.data.clientId !== undefined) fieldUpdates.clientIdRef = encryptField(parsed.data.clientId);
    if (parsed.data.clientSecret !== undefined) fieldUpdates.clientSecretRef = encryptField(parsed.data.clientSecret);
    if (parsed.data.apiKey !== undefined) fieldUpdates.apiKeyRef = encryptField(parsed.data.apiKey);
    if (parsed.data.webhookToken !== undefined) fieldUpdates.webhookTokenRef = encryptField(parsed.data.webhookToken);

    const credential = await prisma.tenantIntegrationCredential.upsert({
      where: {
        tenantId_platform: {
          tenantId: params.id,
          platform
        }
      },
      create: {
        tenantId: params.id,
        platform,
        clientIdRef: encryptField(parsed.data.clientId),
        clientSecretRef: encryptField(parsed.data.clientSecret),
        apiKeyRef: encryptField(parsed.data.apiKey),
        webhookTokenRef: encryptField(parsed.data.webhookToken),
        status: SourceStatus.DISABLED,
        lastTestStatus: null,
        lastTestResult: "Credentials saved. Run Test Connection before enabling."
      },
      update: {
        ...fieldUpdates,
        status: SourceStatus.DISABLED,
        lastTestStatus: null,
        lastTestedAt: null,
        lastTestResult: "Credentials updated. Re-run Test Connection before enabling."
      }
    });
    await logAuditEvent(
      params.id,
      requireUserId(request),
      "INTEGRATION_CREDENTIALS_SAVED",
      {
        platform,
        status: credential.status,
        fields: Object.keys(parsed.data).filter((key) => parsed.data[key as keyof typeof parsed.data] !== undefined)
      },
      request.ip
    );
    return mapTenantCredential(credential, platform);
  });

  app.post("/tenants/:id/integrations/credentials/:platform/test", async (request) => {
    const params = request.params as { id: string; platform: string };
    requireRoleAtLeast(request, UserRole.MANAGER);
    assertTenantPathAccess(request, params.id);
    const executedById = requireUserId(request);
    const platform = resolveTenantIntegrationPlatform(params.platform);
    if (!platform) {
      throw app.httpErrors.badRequest("Unsupported tenant integration platform.");
    }
    const credential = await prisma.tenantIntegrationCredential.findUnique({
      where: {
        tenantId_platform: {
          tenantId: params.id,
          platform
        }
      }
    });
    if (!credential) {
      throw app.httpErrors.notFound("Credential record not found. Save credentials first.");
    }

    let testStatus: ExecutionStatus;
    let testResult: string;

    try {
      ({ testStatus, testResult } = await runPlatformConnectionTest(platform, decryptCredential(credential)));
    } catch (err) {
      testStatus = ExecutionStatus.FAILURE;
      testResult = `Test error: ${err instanceof Error ? err.message : String(err)}`;
    }

    const updatedCredential = await prisma.tenantIntegrationCredential.update({
      where: { id: credential.id },
      data: {
        status:
          testStatus === ExecutionStatus.SUCCESS ? credential.status : SourceStatus.DISABLED,
        lastTestStatus: testStatus,
        lastTestedAt: new Date(),
        lastTestResult: testResult
      }
    });
    await prisma.integrationExecutionLog.create({
      data: {
        tenantId: params.id,
        executedById,
        platform,
        operationType: "TEST_CONNECTION",
        direction: Direction.OUTBOUND,
        triggerType: TriggerType.MANUAL,
        status: testStatus,
        responseSummary: testResult,
        payloadMasked: {
          credentialId: credential.id,
          hasClientId: Boolean(credential.clientIdRef),
          hasClientSecret: Boolean(credential.clientSecretRef),
          hasApiKey: Boolean(credential.apiKeyRef),
          hasWebhookToken: Boolean(credential.webhookTokenRef)
        } satisfies Prisma.JsonObject,
        completedAt: new Date()
      }
    });

    return {
      ok: testStatus === ExecutionStatus.SUCCESS,
      credential: mapTenantCredential(updatedCredential, platform)
    };
  });

  app.patch("/tenants/:id/integrations/credentials/:platform/enable", async (request) => {
    const params = request.params as { id: string; platform: string };
    requireRoleAtLeast(request, UserRole.MANAGER);
    assertTenantPathAccess(request, params.id);
    const executedById = requireUserId(request);
    const platform = resolveTenantIntegrationPlatform(params.platform);
    if (!platform) {
      throw app.httpErrors.badRequest("Unsupported tenant integration platform.");
    }
    const parsed = tenantIntegrationEnableSchema.safeParse(request.body);
    if (!parsed.success) {
      throw app.httpErrors.badRequest(zodMsg(parsed.error));
    }

    const credential = await prisma.tenantIntegrationCredential.findUnique({
      where: {
        tenantId_platform: {
          tenantId: params.id,
          platform
        }
      }
    });
    if (!credential) {
      throw app.httpErrors.notFound("Credential record not found.");
    }
    if (parsed.data.enabled && credential.lastTestStatus !== ExecutionStatus.SUCCESS) {
      throw app.httpErrors.badRequest(
        "Platform integration can only be enabled after a successful test connection."
      );
    }

    const nextStatus = parsed.data.enabled ? SourceStatus.ENABLED : SourceStatus.DISABLED;

    // If enabling an AI summary provider, disable the other summary providers for this
    // tenant first (mutex). OpenAI is transcription-only and is not part of this group.
    if (parsed.data.enabled && AI_SUMMARY_PLATFORMS.has(platform)) {
      const otherSummaryPlatforms = [...AI_SUMMARY_PLATFORMS].filter((p) => p !== platform);
      await prisma.tenantIntegrationCredential.updateMany({
        where: {
          tenantId: params.id,
          platform: { in: otherSummaryPlatforms },
          status: SourceStatus.ENABLED
        },
        data: { status: SourceStatus.DISABLED }
      });
    }

    const updatedCredential = await prisma.tenantIntegrationCredential.update({
      where: { id: credential.id },
      data: {
        status: nextStatus
      }
    });
    await prisma.integrationExecutionLog.create({
      data: {
        tenantId: params.id,
        executedById,
        platform,
        operationType: parsed.data.enabled ? "ENABLE_INTEGRATION" : "DISABLE_INTEGRATION",
        direction: Direction.OUTBOUND,
        triggerType: TriggerType.MANUAL,
        status: ExecutionStatus.SUCCESS,
        responseSummary: parsed.data.enabled
          ? "Integration enabled."
          : "Integration disabled.",
        payloadMasked: {
          credentialId: credential.id
        } satisfies Prisma.JsonObject,
        completedAt: new Date()
      }
    });

    return mapTenantCredential(updatedCredential, platform);
  });

  // ── Teams App Package download ─────────────────────────────────────────────
  app.get("/tenants/:id/integrations/ms-teams-app-package", async (request, reply) => {
    requireRoleAtLeast(request, UserRole.MANAGER);
    assertTenantPathAccess(request, (request.params as { id: string }).id);
    const tenantId = requireTenantId(request);

    const [botCred, branding] = await Promise.all([
      prisma.tenantIntegrationCredential.findUnique({
        where: { tenantId_platform: { tenantId, platform: IntegrationPlatform.MS_TEAMS } },
        select: { clientIdRef: true }
      }).then(r => decryptCredential(r)),
      prisma.tenantBranding.findUnique({ where: { tenantId }, select: { appName: true } })
    ]);

    if (!botCred?.clientIdRef) {
      throw app.httpErrors.badRequest("MS Teams Bot App ID is not configured. Save the Bot credentials first.");
    }

    const appName = branding?.appName || "ThinkCRM";
    // Stable UUID derived from the bot App ID — same every download so the catalog app can be found by externalId
    const teamsAppId = stableTeamsAppId(botCred.clientIdRef);

    const manifest = {
      $schema: "https://developer.microsoft.com/en-us/json-schemas/teams/v1.17/MicrosoftTeams.schema.json",
      manifestVersion: "1.17",
      version: "1.0.0",
      id: teamsAppId,
      developer: {
        name: appName,
        websiteUrl: "https://thinkcrm.app",
        privacyUrl: "https://thinkcrm.app/privacy",
        termsOfUseUrl: "https://thinkcrm.app/terms"
      },
      icons: { color: "color.png", outline: "outline.png" },
      name: { short: appName.slice(0, 30), full: `${appName} Notifications`.slice(0, 100) },
      description: {
        short: `${appName} KPI and activity alerts`.slice(0, 80),
        full: `Receive KPI alerts, check-in reminders, and deal follow-up notifications from ${appName} directly in Microsoft Teams.`.slice(0, 4000)
      },
      accentColor: "#5558AF",
      bots: [
        {
          botId: botCred.clientIdRef,
          scopes: ["personal"],
          isNotificationOnly: true,
          supportsFiles: false
        }
      ],
      validDomains: []
    };

    const manifestJson = Buffer.from(JSON.stringify(manifest, null, 2), "utf8");
    const colorPng  = createSolidPng(192, 192, 85, 88, 175);  // #5558AF
    const outlinePng = createSolidPng(32, 32, 255, 255, 255);  // white

    const { zipSync } = await import("fflate");
    const zipBuffer = Buffer.from(zipSync({
      "manifest.json": new Uint8Array(manifestJson),
      "color.png":     new Uint8Array(colorPng),
      "outline.png":   new Uint8Array(outlinePng)
    }));

    reply
      .header("Content-Type", "application/zip")
      .header("Content-Disposition", `attachment; filename="${appName.replace(/[^a-zA-Z0-9_-]/g, "-")}-teams-app.zip"`)
      .send(zipBuffer);
  });

  // ── Push Teams bot to all org users via Microsoft Graph ─────────────────────
  app.post("/tenants/:id/integrations/ms-teams-push-all", async (request) => {
    requireRoleAtLeast(request, UserRole.ADMIN);
    assertTenantPathAccess(request, (request.params as { id: string }).id);
    const tenantId = requireTenantId(request);

    const [ms365Cred, botCred] = await Promise.all([
      prisma.tenantIntegrationCredential.findUnique({
        where: { tenantId_platform: { tenantId, platform: IntegrationPlatform.MS365 } },
        select: { clientIdRef: true, clientSecretRef: true, webhookTokenRef: true, status: true }
      }).then(r => decryptCredential(r)),
      prisma.tenantIntegrationCredential.findUnique({
        where: { tenantId_platform: { tenantId, platform: IntegrationPlatform.MS_TEAMS } },
        select: { clientIdRef: true }
      }).then(r => decryptCredential(r))
    ]);

    if (!ms365Cred?.clientIdRef || !ms365Cred?.clientSecretRef)
      throw app.httpErrors.badRequest("MS365 integration credentials are not configured.");
    if (ms365Cred.status !== SourceStatus.ENABLED)
      throw app.httpErrors.badRequest("MS365 integration is not enabled.");
    if (!botCred?.clientIdRef)
      throw app.httpErrors.badRequest("MS Teams Bot App ID is not configured.");

    const aadTenantId = ms365Cred.webhookTokenRef ?? "";

    // Acquire Graph token
    const tokenRes = await fetch(`https://login.microsoftonline.com/${aadTenantId}/oauth2/v2.0/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "client_credentials",
        client_id: ms365Cred.clientIdRef,
        client_secret: ms365Cred.clientSecretRef,
        scope: "https://graph.microsoft.com/.default"
      })
    });
    const tokenData = await tokenRes.json() as { access_token?: string; error_description?: string };
    if (!tokenData.access_token)
      throw app.httpErrors.badGateway(tokenData.error_description ?? "Failed to acquire Graph token.");

    const graphToken = tokenData.access_token;
    const appExternalId = stableTeamsAppId(botCred.clientIdRef);

    // Find the app in the org catalog by its stable externalId
    const catalogRes = await fetch(
      `https://graph.microsoft.com/v1.0/appCatalogs/teamsApps?$filter=externalId eq '${appExternalId}'&$select=id,displayName`,
      { headers: { Authorization: `Bearer ${graphToken}` } }
    );
    const catalogData = await catalogRes.json() as { value?: Array<{ id: string; displayName?: string }> };
    const catalogApp = catalogData.value?.[0];
    if (!catalogApp?.id) {
      return {
        ok: false,
        message: "App not found in your org's Teams catalog. Upload the app package first via Teams Admin Center → Manage apps, then try again.",
        externalId: appExternalId
      };
    }

    // Get all org users from Graph
    const usersRes = await fetch(
      "https://graph.microsoft.com/v1.0/users?$select=id,displayName,mail,userPrincipalName&$top=999",
      { headers: { Authorization: `Bearer ${graphToken}` } }
    );
    const usersRaw = await usersRes.json() as { value?: Array<{ id: string; displayName?: string; mail?: string; userPrincipalName?: string }>; error?: { message?: string } };
    if (!usersRes.ok || usersRaw.error) {
      return {
        ok: false,
        message: `Graph API error listing users (HTTP ${usersRes.status}): ${usersRaw.error?.message ?? "No users returned. Ensure User.Read.All is granted with admin consent."}`,
        installed: 0, skipped: 0, failed: 0, errors: []
      };
    }
    const orgUsers = usersRaw.value ?? [];

    // Match org users to CRM users by email, upsert UserExternalAccount MRI
    const tenantUsers = await prisma.user.findMany({
      where: { tenantId, isActive: true },
      select: { id: true, email: true }
    });
    const emailToUserId = new Map(tenantUsers.map(u => [u.email.toLowerCase(), u.id]));

    let installed = 0, skipped = 0, failed = 0, matched = 0;
    const errors: string[] = [];
    // Sample of first 3 Azure AD emails for debugging email-match issues
    const sampleAadEmails = orgUsers.slice(0, 3).map(u => u.mail ?? u.userPrincipalName ?? "(none)");

    for (const orgUser of orgUsers) {
      const email = (orgUser.mail ?? orgUser.userPrincipalName ?? "").toLowerCase();
      const crmUserId = emailToUserId.get(email);
      if (!crmUserId) continue; // not a CRM user
      matched++;

      const mri = `8:orgid:${orgUser.id}`;

      // Upsert the Teams MRI into UserExternalAccount (don't overwrite existing connected accounts)
      await prisma.userExternalAccount.upsert({
        where: { userId_provider: { userId: crmUserId, provider: IntegrationPlatform.MS_TEAMS } },
        create: { userId: crmUserId, provider: IntegrationPlatform.MS_TEAMS, externalUserId: mri, status: "CONNECTED" },
        update: {}  // Don't overwrite — user may have already connected via OAuth
      });

      // Install the app for this user via Graph
      const installRes = await fetch(
        `https://graph.microsoft.com/v1.0/users/${orgUser.id}/teamwork/installedApps`,
        {
          method: "POST",
          headers: { Authorization: `Bearer ${graphToken}`, "Content-Type": "application/json" },
          body: JSON.stringify({ "teamsApp@odata.bind": `https://graph.microsoft.com/v1.0/appCatalogs/teamsApps/${catalogApp.id}` })
        }
      );

      if (installRes.status === 201 || installRes.status === 204) {
        installed++;
      } else if (installRes.status === 409) {
        skipped++; // Already installed
      } else {
        failed++;
        const errText = await installRes.text().catch(() => "");
        errors.push(`${orgUser.displayName ?? email}: HTTP ${installRes.status} — ${errText.slice(0, 100)}`);
      }
    }

    const diagMsg = matched === 0
      ? `No email matches found. Azure AD returned ${orgUsers.length} user(s) but none matched CRM emails. Sample AAD emails: ${sampleAadEmails.join(", ")}`
      : `Done. Installed: ${installed}, already installed (skipped): ${skipped}, failed: ${failed}.`;

    return {
      ok: matched > 0,
      message: diagMsg,
      orgUsersFound: orgUsers.length,
      crmUsersFound: tenantUsers.length,
      matched,
      installed,
      skipped,
      failed,
      sampleAadEmails,
      errors: errors.slice(0, 10)
    };
  });

  app.post("/teams", async (request, reply) => {
    requireRoleAtLeast(request, UserRole.MANAGER);
    const tenantId = requireTenantId(request);
    const parsed = teamCreateSchema.safeParse(request.body);
    if (!parsed.success) {
      throw app.httpErrors.badRequest(zodMsg(parsed.error));
    }

    const normalizedTeamName = parsed.data.teamName.trim();
    const tenantTeams = await prisma.team.findMany({
      where: {
        tenantId
      },
      select: { teamName: true }
    });
    const hasNameConflict = tenantTeams.some(
      (team) => team.teamName.trim().toLowerCase() === normalizedTeamName.toLowerCase()
    );
    if (hasNameConflict) {
      throw app.httpErrors.conflict("Team name already exists in this tenant.");
    }

    const team = await prisma.team.create({
      data: {
        tenantId,
        teamName: normalizedTeamName,
        isActive: parsed.data.isActive
      },
      select: {
        id: true,
        tenantId: true,
        teamName: true,
        isActive: true,
        createdAt: true,
        updatedAt: true
      }
    });
    return reply.code(201).send(team);
  });

  app.get("/teams", async (request) => {
    requireAuth(request);
    const tenantId = requireTenantId(request);
    const teams = await prisma.team.findMany({
      where: { tenantId },
      orderBy: [{ teamName: "asc" }],
      include: {
        director: {
          select: { id: true, fullName: true, role: true, avatarUrl: true }
        },
        users: {
          select: {
            id: true,
            fullName: true,
            email: true,
            role: true,
            isActive: true,
            avatarUrl: true
          },
          orderBy: [{ fullName: "asc" }]
        },
        channels: {
          select: {
            id: true,
            channelType: true,
            channelTarget: true,
            isEnabled: true,
            createdAt: true,
            updatedAt: true
          },
          orderBy: [{ channelType: "asc" }, { createdAt: "asc" }]
        }
      }
    });
    return teams.map((team) => ({
      ...team,
      members: team.users
    }));
  });

  app.patch("/teams/:id", async (request) => {
    requireRoleAtLeast(request, UserRole.MANAGER);
    const tenantId = requireTenantId(request);
    const params = request.params as { id: string };
    await ensureTeamBelongsToTenant(tenantId, params.id, app);

    const parsed = teamUpdateSchema.safeParse(request.body);
    if (!parsed.success) {
      throw app.httpErrors.badRequest(zodMsg(parsed.error));
    }

    const requestedName = parsed.data.teamName?.trim();
    if (requestedName) {
      const tenantTeams = await prisma.team.findMany({
        where: {
          tenantId,
          id: { not: params.id }
        },
        select: { id: true, teamName: true }
      });
      const hasNameConflict = tenantTeams.some(
        (team) => team.teamName.trim().toLowerCase() === requestedName.toLowerCase()
      );
      if (hasNameConflict) {
        throw app.httpErrors.conflict("Team name already exists in this tenant.");
      }
    }

    return prisma.team.update({
      where: { id: params.id },
      data: {
        teamName: requestedName,
        isActive: parsed.data.isActive
      },
      include: {
        channels: {
          select: {
            id: true,
            channelType: true,
            channelTarget: true,
            isEnabled: true
          },
          orderBy: [{ channelType: "asc" }, { createdAt: "asc" }]
        }
      }
    });
  });

  app.post("/teams/:id/members", async (request) => {
    requireRoleAtLeast(request, UserRole.MANAGER);
    const tenantId = requireTenantId(request);
    const params = request.params as { id: string };
    await ensureTeamBelongsToTenant(tenantId, params.id, app);

    const parsed = teamMemberAssignSchema.safeParse(request.body);
    if (!parsed.success) {
      throw app.httpErrors.badRequest(zodMsg(parsed.error));
    }
    const rep = await ensureRepBelongsToTenant(tenantId, parsed.data.userId, app);

    const updatedRep = await prisma.user.update({
      where: { id: rep.id },
      data: { teamId: params.id },
      select: {
        id: true,
        fullName: true,
        email: true,
        role: true,
        isActive: true,
        teamId: true,
        team: {
          select: {
            id: true,
            teamName: true,
            isActive: true
          }
        }
      }
    });
    return {
      userId: updatedRep.id,
      previousTeamId: rep.teamId,
      assignedTeamId: params.id,
      member: updatedRep
    };
  });

  app.put("/teams/:id/notification-channels", async (request) => {
    requireRoleAtLeast(request, UserRole.MANAGER);
    const tenantId = requireTenantId(request);
    const params = request.params as { id: string };
    await ensureTeamBelongsToTenant(tenantId, params.id, app);

    const parsed = teamNotificationChannelsUpsertSchema.safeParse(request.body);
    if (!parsed.success) {
      throw app.httpErrors.badRequest(zodMsg(parsed.error));
    }

    const dedupeKey = new Set<string>();
    for (const channel of parsed.data.channels) {
      const normalizedTarget = channel.channelTarget.trim().toLowerCase();
      const key = `${channel.channelType}:${normalizedTarget}`;
      if (dedupeKey.has(key)) {
        throw app.httpErrors.badRequest(
          "Duplicate notification channel entries are not allowed."
        );
      }
      dedupeKey.add(key);
    }

    const result = await prisma.$transaction(async (tx) => {
      await tx.teamNotificationChannel.deleteMany({
        where: {
          tenantId,
          teamId: params.id
        }
      });
      if (parsed.data.channels.length > 0) {
        await tx.teamNotificationChannel.createMany({
          data: parsed.data.channels.map((channel) => ({
            tenantId,
            teamId: params.id,
            channelType: channel.channelType,
            channelTarget: channel.channelTarget.trim(),
            isEnabled: channel.isEnabled ?? true
          }))
        });
      }
      const channels = await tx.teamNotificationChannel.findMany({
        where: {
          tenantId,
          teamId: params.id
        },
        select: {
          id: true,
          channelType: true,
          channelTarget: true,
          isEnabled: true,
          createdAt: true,
          updatedAt: true
        },
        orderBy: [{ channelType: "asc" }, { createdAt: "asc" }]
      });
      return channels;
    });

    return {
      teamId: params.id,
      channels: result
    };
  });

  app.post("/teams/:id/notification-channels/test", async (request) => {
    requireRoleAtLeast(request, UserRole.MANAGER);
    const tenantId = requireTenantId(request);
    const params = request.params as { id: string };
    await ensureTeamBelongsToTenant(tenantId, params.id, app);

    const channels = await prisma.teamNotificationChannel.findMany({
      where: { tenantId, teamId: params.id, isEnabled: true },
      select: { id: true, channelType: true, channelTarget: true }
    });

    if (channels.length === 0) {
      throw app.httpErrors.badRequest("No notification channels configured for this team.");
    }

    // Load credentials and branding in parallel
    const [lineCredential, emailCredential, branding] = await Promise.all([
      prisma.tenantIntegrationCredential.findUnique({
        where: { tenantId_platform: { tenantId, platform: IntegrationPlatform.LINE } },
        select: { apiKeyRef: true }
      }).then(r => decryptCredential(r)),
      prisma.tenantIntegrationCredential.findUnique({
        where: { tenantId_platform: { tenantId, platform: IntegrationPlatform.EMAIL } },
        select: { clientIdRef: true, clientSecretRef: true, apiKeyRef: true, webhookTokenRef: true }
      }).then(r => decryptCredential(r)),
      prisma.tenantBranding.findUnique({
        where: { tenantId },
        select: { appName: true }
      })
    ]);
    const appName = branding?.appName || "CRM";

    const results: { channelType: string; channelTarget: string; status: string; message: string }[] = [];

    for (const ch of channels) {
      if (ch.channelType === ChannelType.LINE) {
        if (!lineCredential?.apiKeyRef) {
          results.push({ channelType: ch.channelType, channelTarget: ch.channelTarget, status: "ERROR", message: "LINE Channel Access Token not configured. Set it in Integrations settings." });
          continue;
        }
        const { sendLinePush } = await import("../../lib/line-notify.js");
        const r = await sendLinePush(lineCredential.apiKeyRef, ch.channelTarget, { type: "text", text: `🔔 Test connection successful.\n[${appName}]` });
        results.push({ channelType: ch.channelType, channelTarget: ch.channelTarget, status: r.ok ? "OK" : "ERROR", message: r.message });
      } else if (ch.channelType === ChannelType.MS_TEAMS) {
        const { sendTeamsCard } = await import("../../lib/teams-notify.js");
        const r = await sendTeamsCard(ch.channelTarget, {
          title: "🔔 Test Connection Successful",
          accentColor: "good",
          facts: [{ title: "Source", value: appName }],
          footer: `[${appName}]`
        });
        results.push({ channelType: ch.channelType, channelTarget: ch.channelTarget, status: r.ok ? "OK" : "ERROR", message: r.message });
      } else if (ch.channelType === ChannelType.EMAIL) {
        if (!emailCredential?.clientIdRef || !emailCredential?.apiKeyRef || !emailCredential?.webhookTokenRef) {
          results.push({ channelType: ch.channelType, channelTarget: ch.channelTarget, status: "ERROR", message: "Email SMTP credentials not fully configured. Set Host, From Address and Password in Integrations settings." });
          continue;
        }
        const { sendEmailCard } = await import("../../lib/email-notify.js");
        const emailConfig = {
          host: emailCredential.clientIdRef,
          port: smtpPort(emailCredential.clientSecretRef),
          fromAddress: emailCredential.webhookTokenRef,
          password: emailCredential.apiKeyRef
        };
        const r = await sendEmailCard(emailConfig, ch.channelTarget, {
          subject: `🔔 Test Connection Successful — [${appName}]`,
          title: "🔔 Test Connection Successful",
          facts: [{ label: "Source", value: appName }],
          footer: `[${appName}]`
        });
        results.push({ channelType: ch.channelType, channelTarget: ch.channelTarget, status: r.ok ? "OK" : "ERROR", message: r.message });
      } else {
        results.push({ channelType: ch.channelType, channelTarget: ch.channelTarget, status: "NOT_IMPLEMENTED", message: "Notification delivery for this channel type is not yet configured." });
      }
    }

    return { teamId: params.id, results };
  });

  app.get("/kpi-targets/reps", async (request) => {
    requireRoleAtLeast(request, UserRole.ADMIN);
    const tenantId = requireTenantId(request);
    return prisma.user.findMany({
      where: {
        tenantId,
        role: UserRole.REP,
        isActive: true
      },
      select: {
        id: true,
        fullName: true,
        email: true,
        teamId: true,
        team: {
          select: {
            id: true,
            teamName: true
          }
        }
      },
      orderBy: [{ fullName: "asc" }]
    });
  });

  app.get("/users/visible-reps", async (request) => {
    requireAuth(request);
    const role = request.requestContext.role;
    if (role === UserRole.REP) return [];
    const tenantId = requireTenantId(request);
    const visibleIds = [...(await listVisibleUserIds(request))];
    return prisma.user.findMany({
      where: { id: { in: visibleIds }, tenantId, isActive: true },
      select: { id: true, fullName: true, role: true, teamId: true, avatarUrl: true },
      orderBy: { fullName: "asc" }
    });
  });

  app.get("/users/pending-invites", async (request) => {
    requireRoleAtLeast(request, UserRole.ADMIN);
    const tenantId = requireTenantId(request);
    const invites = await prisma.userInvite.findMany({
      where: { tenantId, acceptedAt: null, expiresAt: { gt: new Date() } },
      select: { id: true, email: true, role: true, teamId: true, createdAt: true, expiresAt: true },
      orderBy: { createdAt: "desc" }
    });
    return invites;
  });

  app.delete("/users/:id", async (request, reply) => {
    requireRoleAtLeast(request, UserRole.ADMIN);
    const tenantId = requireTenantId(request);
    const actorId = requireUserId(request);
    const params = request.params as { id: string };
    if (params.id === actorId) throw app.httpErrors.badRequest("You cannot delete your own account.");
    const user = await prisma.user.findFirst({ where: { id: params.id, tenantId } });
    if (!user) throw app.httpErrors.notFound("User not found.");
    await prisma.user.update({ where: { id: params.id }, data: { isActive: false } });
    return reply.code(204).send();
  });

  app.post("/kpi-targets", async (request, reply) => {
    requireRoleAtLeast(request, UserRole.MANAGER);
    const tenantId = requireTenantId(request);
    const parsed = kpiTargetCreateSchema.safeParse(request.body);
    if (!parsed.success) {
      throw app.httpErrors.badRequest(zodMsg(parsed.error));
    }
    const body = parsed.data;
    const rep = await ensureRepBelongsToTenant(tenantId, body.userId, app);

    try {
      const row = await prisma.salesKpiTarget.create({
        data: {
          tenantId,
          userId: body.userId,
          targetMonth: body.targetMonth,
          visitTargetCount: body.visitTargetCount,
          newDealValueTarget: body.newDealValueTarget,
          revenueTarget: body.revenueTarget
        }
      });
      return reply.code(201).send({
        ...row,
        rep
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
        throw app.httpErrors.conflict("KPI target already exists for this rep and month.");
      }
      throw error;
    }
  });

  app.delete("/kpi-targets/:id", async (request, reply) => {
    requireRoleAtLeast(request, UserRole.MANAGER);
    const tenantId = requireTenantId(request);
    const params = request.params as { id: string };
    const existing = await prisma.salesKpiTarget.findFirst({
      where: { id: params.id, tenantId },
      select: { id: true }
    });
    if (!existing) {
      throw app.httpErrors.notFound("KPI target not found.");
    }
    await prisma.salesKpiTarget.delete({ where: { id: existing.id } });
    return reply.code(204).send();
  });

  app.post("/kpi-targets/bulk-delete", async (request) => {
    requireRoleAtLeast(request, UserRole.MANAGER);
    const tenantId = requireTenantId(request);
    const parsed = z.object({ ids: z.array(z.string().cuid()).min(1).max(200) }).safeParse(request.body);
    if (!parsed.success) {
      throw app.httpErrors.badRequest(zodMsg(parsed.error));
    }
    const result = await prisma.salesKpiTarget.deleteMany({
      where: { tenantId, id: { in: parsed.data.ids } }
    });
    return { deleted: result.count };
  });

  app.post("/kpi-targets/copy-to-next-month", async (request) => {
    requireRoleAtLeast(request, UserRole.MANAGER);
    const tenantId = requireTenantId(request);
    const parsed = z.object({ ids: z.array(z.string().cuid()).min(1).max(200) }).safeParse(request.body);
    if (!parsed.success) {
      throw app.httpErrors.badRequest(zodMsg(parsed.error));
    }
    const sources = await prisma.salesKpiTarget.findMany({
      where: { tenantId, id: { in: parsed.data.ids } }
    });

    // Advance "YYYY-MM" by one month, wrapping December → January of next year.
    const nextMonth = (ym: string): string => {
      const [yStr, mStr] = ym.split("-");
      const y = Number(yStr);
      const m = Number(mStr);
      if (!Number.isFinite(y) || !Number.isFinite(m)) return ym;
      const date = new Date(Date.UTC(y, m, 1)); // m is 0-indexed after +1, so passing m gives us next month
      return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
    };

    let copied = 0;
    let skipped = 0;
    for (const src of sources) {
      try {
        await prisma.salesKpiTarget.create({
          data: {
            tenantId,
            userId: src.userId,
            targetMonth: nextMonth(src.targetMonth),
            visitTargetCount: src.visitTargetCount,
            newDealValueTarget: src.newDealValueTarget,
            revenueTarget: src.revenueTarget
          }
        });
        copied++;
      } catch (error) {
        if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
          skipped++; // target already exists for next month
          continue;
        }
        throw error;
      }
    }
    return { copied, skipped };
  });

  app.patch("/kpi-targets/:id", async (request) => {
    requireRoleAtLeast(request, UserRole.MANAGER);
    const tenantId = requireTenantId(request);
    const params = request.params as { id: string };
    const parsed = kpiTargetUpdateSchema.safeParse(request.body);
    if (!parsed.success) {
      throw app.httpErrors.badRequest(zodMsg(parsed.error));
    }

    const existing = await prisma.salesKpiTarget.findFirst({
      where: {
        id: params.id,
        tenantId
      }
    });
    if (!existing) {
      throw app.httpErrors.notFound("KPI target not found.");
    }

    const updateInput = parsed.data;
    const nextUserId = updateInput.userId ?? existing.userId;
    await ensureRepBelongsToTenant(tenantId, nextUserId, app);

    try {
      return await prisma.salesKpiTarget.update({
        where: {
          id: existing.id
        },
        data: {
          userId: updateInput.userId,
          targetMonth: updateInput.targetMonth,
          visitTargetCount: updateInput.visitTargetCount,
          newDealValueTarget: updateInput.newDealValueTarget,
          revenueTarget: updateInput.revenueTarget
        }
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
        throw app.httpErrors.conflict("KPI target already exists for this rep and month.");
      }
      throw error;
    }
  });

  app.get("/import-logs", async (request) => {
    requireRoleAtLeast(request, UserRole.MANAGER);
    const tenantId = requireTenantId(request);
    const q = request.query as { type?: string };
    const typeFilter = q.type === "users" ? ["USER_IMPORT"]
      : q.type === "kpi" ? ["KPI_TARGET_IMPORT"]
      : q.type === "customers" ? ["CUSTOMER_IMPORT"]
      : q.type === "items" ? ["ITEM_IMPORT"]
      : q.type === "payment-terms" ? ["PAYMENT_TERM_IMPORT"]
      : ["USER_IMPORT", "KPI_TARGET_IMPORT", "CUSTOMER_IMPORT", "ITEM_IMPORT", "PAYMENT_TERM_IMPORT"];

    const rows = await prisma.auditLog.findMany({
      where: { tenantId, action: { in: typeFilter } },
      orderBy: { createdAt: "desc" },
      take: 50
    });

    const actorIds = [...new Set(rows.map((r) => r.userId).filter((id): id is string => !!id))];
    const actors = actorIds.length
      ? await prisma.user.findMany({
          where: { id: { in: actorIds }, tenantId },
          select: { id: true, fullName: true, email: true }
        })
      : [];
    const actorById = new Map(actors.map((a) => [a.id, a]));

    return rows.map((r) => ({
      id: r.id,
      action: r.action,
      createdAt: r.createdAt,
      detail: r.detail,
      actor: r.userId ? (actorById.get(r.userId) ?? { id: r.userId, fullName: null, email: null }) : null
    }));
  });

  app.post("/kpi-targets/import", async (request) => {
    requireRoleAtLeast(request, UserRole.MANAGER);
    const tenantId = requireTenantId(request);

    const body = request.body as unknown;
    const rawRows: unknown[] = Array.isArray(body)
      ? body
      : (body as Record<string, unknown>)?.targets as unknown[] ?? [];

    if (!Array.isArray(rawRows) || rawRows.length === 0) {
      throw app.httpErrors.badRequest("Expected a non-empty array of targets or { targets: [...] }.");
    }
    if (rawRows.length > 500) {
      throw app.httpErrors.badRequest("Maximum 500 rows per import.");
    }

    const repsInTenant = await prisma.user.findMany({
      where: { tenantId, isActive: true, role: UserRole.REP },
      select: { id: true, email: true }
    });
    const userIdByEmail = new Map(repsInTenant.map((u) => [u.email.toLowerCase(), u.id]));

    const errors: { row: number; email?: string; error: string }[] = [];
    let imported = 0;

    for (let i = 0; i < rawRows.length; i++) {
      const parsed = kpiTargetImportRowSchema.safeParse(rawRows[i]);
      if (!parsed.success) {
        errors.push({ row: i + 1, error: zodMsg(parsed.error) });
        continue;
      }
      const row = parsed.data;
      const userId = userIdByEmail.get(row.email);
      if (!userId) {
        errors.push({ row: i + 1, email: row.email, error: "No active sales rep with this email in this tenant." });
        continue;
      }
      try {
        await prisma.salesKpiTarget.upsert({
          where: { tenantId_userId_targetMonth: { tenantId, userId, targetMonth: row.targetMonth } },
          update: {
            visitTargetCount: row.visitTargetCount,
            newDealValueTarget: row.newDealValueTarget,
            revenueTarget: row.revenueTarget
          },
          create: {
            tenantId,
            userId,
            targetMonth: row.targetMonth,
            visitTargetCount: row.visitTargetCount,
            newDealValueTarget: row.newDealValueTarget,
            revenueTarget: row.revenueTarget
          }
        });
        imported += 1;
      } catch (error) {
        errors.push({ row: i + 1, email: row.email, error: (error as Error).message });
      }
    }

    await logAuditEvent(
      tenantId,
      request.requestContext.userId,
      "KPI_TARGET_IMPORT",
      {
        total: rawRows.length,
        imported,
        errors: errors.length,
        errorSample: errors.slice(0, 5)
      },
      request.ip
    );

    return { imported, errors: errors.length, errorDetails: errors };
  });

  app.get("/kpi-targets", async (request) => {
    requireRoleAtLeast(request, UserRole.REP);
    const tenantId = requireTenantId(request);
    const parsed = kpiTargetListQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      throw app.httpErrors.badRequest(zodMsg(parsed.error));
    }

    const filters = parsed.data;

    // Non-admins can only see KPI targets for users visible to them
    const visibleIds = await listVisibleUserIds(request);
    const visibilityScope = visibleIds.size > 0 ? [...visibleIds] : null;

    if (filters.userId) {
      if (visibilityScope && !visibilityScope.includes(filters.userId)) {
        throw app.httpErrors.forbidden("You do not have access to that user's KPI data.");
      }
      const rep = await prisma.user.findFirst({
        where: { tenantId, id: filters.userId },
        select: { id: true }
      });
      if (!rep) {
        throw app.httpErrors.badRequest("Requested user does not belong to this tenant.");
      }
    }
    if (filters.teamId) {
      const team = await prisma.team.findFirst({
        where: { id: filters.teamId, tenantId },
        select: { id: true }
      });
      if (!team) {
        throw app.httpErrors.badRequest("Requested team does not belong to this tenant.");
      }
    }

    let teamRepIds: string[] | undefined;
    if (filters.teamId) {
      const repsInTeam = await prisma.user.findMany({
        where: { tenantId, teamId: filters.teamId, role: UserRole.REP },
        select: { id: true }
      });
      teamRepIds = repsInTeam.map((rep) => rep.id);
    }

    const filteredUserIds =
      filters.userId && teamRepIds
        ? teamRepIds.includes(filters.userId)
          ? [filters.userId]
          : []
        : filters.userId
          ? [filters.userId]
          : teamRepIds;

    // Intersect explicit filters with visibility scope
    const finalUserIds = visibilityScope
      ? filteredUserIds
        ? filteredUserIds.filter((id) => visibilityScope.includes(id))
        : visibilityScope
      : filteredUserIds;

    const rows = await prisma.salesKpiTarget.findMany({
      where: {
        tenantId,
        targetMonth: filters.targetMonth,
        ...(finalUserIds ? { userId: { in: finalUserIds } } : {})
      },
      orderBy: [{ targetMonth: "desc" }, { createdAt: "desc" }]
    });

    const repIds = [...new Set(rows.map((row) => row.userId))];
    const reps = repIds.length
      ? await prisma.user.findMany({
          where: {
            tenantId,
            id: { in: repIds }
          },
          select: {
            id: true,
            fullName: true,
            email: true,
            teamId: true,
            avatarUrl: true,
            team: {
              select: {
                id: true,
                teamName: true
              }
            }
          }
        })
      : [];
    const repById = new Map(reps.map((rep) => [rep.id, rep]));
    return rows.map((row) => {
      return {
        ...row,
        rep: repById.get(row.userId) ?? null
      };
    });
  });

  app.post("/storage/r2/presign-upload", async (request) => {
    const tenantId = requireTenantId(request);
    const parsed = storagePresignUploadSchema.safeParse(request.body);
    if (!parsed.success) {
      throw app.httpErrors.badRequest(zodMsg(parsed.error));
    }

    const tenantForUpload = await prisma.tenant.findUnique({ where: { id: tenantId }, select: { slug: true } });
    if (!tenantForUpload) throw app.httpErrors.notFound("Tenant not found.");

    let objectKey: string;
    if (parsed.data.entityType) {
      const folder = ENTITY_FOLDER[parsed.data.entityType];
      if (!folder) {
        throw app.httpErrors.badRequest(
          `Unknown entityType "${parsed.data.entityType}". Valid values: ${Object.keys(ENTITY_FOLDER).join(", ")}.`
        );
      }
      const safeName = (parsed.data.filename ?? "file")
        .replace(/[^a-zA-Z0-9._-]/g, "_")
        .replace(/_{2,}/g, "_")
        .slice(0, 200);
      const parts = [folder];
      if (parsed.data.entityId) parts.push(parsed.data.entityId);
      parts.push(`${Date.now()}_${safeName}`);
      objectKey = parts.join("/");
    } else {
      objectKey = parsed.data.objectKey!;
    }

    try {
      return await createR2PresignedUpload({
        tenantSlug: tenantForUpload.slug,
        objectKeyOrRef: objectKey,
        contentType: parsed.data.contentType,
        expiresInSeconds: parsed.data.expiresInSeconds
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unable to generate upload URL.";
      throw app.httpErrors.badRequest(message);
    }
  });

  app.get("/storage/r2/presign-download", async (request) => {
    const tenantId = requireTenantId(request);
    const parsed = storagePresignDownloadSchema.safeParse(request.query);
    if (!parsed.success) {
      throw app.httpErrors.badRequest(zodMsg(parsed.error));
    }

    const tenantForDownload = await prisma.tenant.findUnique({ where: { id: tenantId }, select: { slug: true } });
    if (!tenantForDownload) throw app.httpErrors.notFound("Tenant not found.");

    try {
      return await createR2PresignedDownload({
        tenantSlug: tenantForDownload.slug,
        objectKeyOrRef: parsed.data.objectKey,
        expiresInSeconds: parsed.data.expiresInSeconds
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unable to generate download URL.";
      throw app.httpErrors.badRequest(message);
    }
  });

  app.put("/users/:id/manager", async (request) => {
    requireRoleAtLeast(request, UserRole.MANAGER);
    const tenantId = requireTenantId(request);
    const params = request.params as { id: string };
    const parsed = userManagerAssignSchema.safeParse(request.body);
    if (!parsed.success) {
      throw app.httpErrors.badRequest(zodMsg(parsed.error));
    }
    const visibleUserIds = await listVisibleUserIds(request);
    if (request.requestContext.role !== UserRole.ADMIN && !visibleUserIds.has(params.id)) {
      throw app.httpErrors.forbidden("Target user is outside hierarchy scope.");
    }
    if (parsed.data.managerUserId === params.id) {
      throw app.httpErrors.badRequest("managerUserId cannot point to the same user.");
    }

    const targetUser = await prisma.user.findFirst({
      where: { id: params.id, tenantId },
      select: { id: true, managerUserId: true, role: true }
    });
    if (!targetUser) {
      throw app.httpErrors.notFound("Target user not found in tenant.");
    }

    if (!parsed.data.managerUserId) {
      return prisma.user.update({
        where: { id: params.id },
        data: { managerUserId: null },
        select: {
          id: true,
          tenantId: true,
          managerUserId: true,
          role: true
        }
      });
    }

    const managerUser = await prisma.user.findFirst({
      where: { id: parsed.data.managerUserId, tenantId, isActive: true },
      select: { id: true, managerUserId: true }
    });
    if (!managerUser) {
      throw app.httpErrors.badRequest("managerUserId is invalid for this tenant.");
    }
    if (request.requestContext.role !== UserRole.ADMIN && !visibleUserIds.has(managerUser.id)) {
      throw app.httpErrors.forbidden("managerUserId is outside hierarchy scope.");
    }

    let cursor: string | null = managerUser.managerUserId;
    while (cursor) {
      if (cursor === targetUser.id) {
        throw app.httpErrors.badRequest("Manager assignment would create a reporting cycle.");
      }
      const manager = await prisma.user.findFirst({
        where: { id: cursor, tenantId },
        select: { managerUserId: true }
      });
      cursor = manager?.managerUserId ?? null;
    }

    return prisma.user.update({
      where: { id: targetUser.id },
      data: { managerUserId: managerUser.id },
      select: {
        id: true,
        tenantId: true,
        managerUserId: true,
        role: true
      }
    });
  });

  app.get("/changelogs", async (request) => {
    requireRoleAtLeast(request, UserRole.MANAGER);
    const tenantId = requireTenantId(request);
    const parsed = changelogQuerySchema.safeParse(request.query ?? {});
    if (!parsed.success) {
      throw app.httpErrors.badRequest(zodMsg(parsed.error));
    }

    const rows = await prisma.entityChangelog.findMany({
      where: {
        tenantId,
        entityType: parsed.data.entityType,
        entityId: parsed.data.entityId,
        action: parsed.data.action
      },
      include: {
        changedBy: {
          select: { id: true, fullName: true, email: true }
        }
      },
      orderBy: { createdAt: "desc" },
      take: parsed.data.limit
    });
    if (request.requestContext.role === UserRole.ADMIN) {
      return rows;
    }

    const visibleUserIds = await listVisibleUserIds(request);
    const dealIds = rows.filter((row) => row.entityType === EntityType.DEAL).map((row) => row.entityId);
    const visitIds = rows.filter((row) => row.entityType === EntityType.VISIT).map((row) => row.entityId);
    const customerIds = rows
      .filter((row) => row.entityType === EntityType.CUSTOMER)
      .map((row) => row.entityId);

    const [deals, visits, customers] = await Promise.all([
      dealIds.length
        ? prisma.deal.findMany({
            where: { tenantId, id: { in: dealIds } },
            select: { id: true, ownerId: true }
          })
        : Promise.resolve([]),
      visitIds.length
        ? prisma.visit.findMany({
            where: { tenantId, id: { in: visitIds } },
            select: { id: true, repId: true }
          })
        : Promise.resolve([]),
      customerIds.length
        ? prisma.customer.findMany({
            where: { tenantId, id: { in: customerIds } },
            select: { id: true, ownerId: true }
          })
        : Promise.resolve([])
    ]);

    const dealOwnerById = new Map(deals.map((deal) => [deal.id, deal.ownerId]));
    const visitOwnerById = new Map(visits.map((visit) => [visit.id, visit.repId]));
    const customerOwnerById = new Map(customers.map((customer) => [customer.id, customer.ownerId]));

    return rows.filter((row) => {
      if (row.entityType === EntityType.DEAL) {
        const ownerId = dealOwnerById.get(row.entityId);
        return ownerId ? visibleUserIds.has(ownerId) : false;
      }
      if (row.entityType === EntityType.VISIT) {
        const ownerId = visitOwnerById.get(row.entityId);
        return ownerId ? visibleUserIds.has(ownerId) : false;
      }
      if (row.entityType === EntityType.CUSTOMER) {
        const ownerId = customerOwnerById.get(row.entityId);
        return ownerId ? visibleUserIds.has(ownerId) : false;
      }
      return row.entityType === EntityType.ITEM;
    });
  });

  app.get("/whoami", async (request) => {
    requireAuth(request);
    return {
      tenantId: request.requestContext.tenantId,
      userId: request.requestContext.userId,
      role: request.requestContext.role
    };
  });

  app.post("/integrations/test-connection", async (request) => {
    requireRoleAtLeast(request, UserRole.MANAGER);
    const tenantId = requireTenantId(request);
    const executedById = requireUserId(request);
    const body = request.body as { platform: IntegrationPlatform; configMasked?: Record<string, unknown> };
    await prisma.integrationExecutionLog.create({
      data: {
        tenantId,
        executedById,
        platform: body.platform,
        operationType: "TEST_CONNECTION",
        direction: "OUTBOUND",
        triggerType: "MANUAL",
        status: "SUCCESS",
        responseSummary: "Test connection success.",
        payloadMasked: body.configMasked as Prisma.InputJsonValue | undefined,
        completedAt: new Date()
      }
    });
    return { ok: true };
  });

  app.get("/auth/session-policy", async (request) => {
    requireRoleAtLeast(request, UserRole.MANAGER);
    const tenantId = requireTenantId(request);
    return {
      tenantId,
      mfaPolicy: "OPTIONAL",
      sessionTimeoutMinutes: 120,
      adminIpAllowlistEnabled: false,
      sso: { enabled: false, protocol: "SAML" }
    };
  });

  // ── Notification preferences (self) ─────────────────────────────────────
  const notifPrefsSchema = z.object({
    // Personal notifications (delivered to the user's connected channel)
    dealFollowUp:    z.boolean().optional(),
    visitRemind:     z.boolean().optional(),
    // Group notifications (delivered to supervisors/managers/directors about their reps)
    repCheckin:      z.boolean().optional(),
    repCheckout:     z.boolean().optional(),
    repDealWon:      z.boolean().optional(),
    repDealLost:     z.boolean().optional(),
    // Legacy keys kept for backward compatibility
    dealAssigned:   z.boolean().optional(),
    dealWon:        z.boolean().optional(),
    dealLost:       z.boolean().optional(),
    visitScheduled: z.boolean().optional(),
    visitCheckin:   z.boolean().optional(),
    visitCheckout:  z.boolean().optional(),
    kpiAlert:       z.boolean().optional(),
    weeklyDigest:   z.boolean().optional()
  });

  app.get("/users/me/notif-prefs", async (request) => {
    requireAuth(request);
    const userId = requireUserId(request);
    const user = await prisma.user.findUnique({ where: { id: userId }, select: { notifPrefs: true } });
    return (user?.notifPrefs ?? {}) as Record<string, boolean>;
  });

  app.put("/users/me/notif-prefs", async (request) => {
    requireAuth(request);
    const userId = requireUserId(request);
    const parsed = notifPrefsSchema.safeParse(request.body ?? {});
    if (!parsed.success) throw app.httpErrors.badRequest(zodMsg(parsed.error));
    await prisma.user.update({ where: { id: userId }, data: { notifPrefs: parsed.data } });
    return parsed.data;
  });

  // ── User profile read/edit (ADMIN only) ──────────────────────────────────
  app.get("/users/:id", async (request) => {
    requireRoleAtLeast(request, UserRole.ADMIN);
    const tenantId = requireTenantId(request);
    const { id } = request.params as { id: string };
    const user = await prisma.user.findFirst({
      where: { id, tenantId },
      select: {
        id: true,
        fullName: true,
        email: true,
        role: true,
        teamId: true,
        managerUserId: true,
        createdAt: true,
        manager: { select: { id: true, fullName: true } }
      }
    });
    if (!user) throw app.httpErrors.notFound("User not found.");
    return user;
  });

  const userEditSchema = z.object({
    fullName:      z.string().min(1).max(120),
    email:         z.string().email(),
    role:          z.nativeEnum(UserRole),
    managerUserId: z.preprocess(v => (v === "" ? null : v), z.string().min(1).nullable().optional()),
    teamId:        z.preprocess(v => (v === "" ? null : v), z.string().min(1).nullable().optional())
  });

  app.patch("/users/:id", async (request) => {
    requireRoleAtLeast(request, UserRole.ADMIN);
    const tenantId = requireTenantId(request);
    const { id } = request.params as { id: string };

    const existing = await prisma.user.findFirst({ where: { id, tenantId } });
    if (!existing) throw app.httpErrors.notFound("User not found.");

    const parsed = userEditSchema.safeParse(request.body);
    if (!parsed.success) throw app.httpErrors.badRequest(zodMsg(parsed.error));

    const { fullName, email, role, managerUserId, teamId } = parsed.data;

    // Validate managerUserId belongs to same tenant if provided
    if (managerUserId) {
      const mgr = await prisma.user.findFirst({ where: { id: managerUserId, tenantId } });
      if (!mgr) throw app.httpErrors.badRequest("Manager user not found in tenant.");
      if (managerUserId === id) throw app.httpErrors.badRequest("User cannot be their own manager.");
    }

    // Validate teamId belongs to same tenant if provided
    if (teamId) {
      const team = await prisma.team.findFirst({ where: { id: teamId, tenantId } });
      if (!team) throw app.httpErrors.badRequest("Team not found in tenant.");
    }

    const updateData: {
      fullName: string;
      email: string;
      role: UserRole;
      managerUserId: string | null;
      teamId?: string | null;
    } = {
      fullName,
      email,
      role,
      managerUserId: managerUserId ?? null
    };
    if (teamId !== undefined) updateData.teamId = teamId;

    return prisma.user.update({
      where: { id },
      data: updateData,
      select: { id: true, fullName: true, email: true, role: true, managerUserId: true, teamId: true }
    });
  });

  // ── Cron Job management (Admin only) ─────────────────────────────────────────

  const cronJobUpdateSchema = z.object({
    cronExpr: z.string().trim().min(9).max(100),
    isEnabled: z.boolean(),
    timezone: z.string().trim().min(1).max(80).optional()
  });

  /** List all job definitions with their tenant config + last 10 runs. */
  app.get("/cron-jobs", async (request) => {
    requireRoleAtLeast(request, UserRole.ADMIN);
    const tenantId = requireTenantId(request);

    // Read tenant timezone once for default seeding
    const tenantRecord = await prisma.tenant.findUnique({
      where: { id: tenantId },
      select: { timezone: true }
    });
    const tenantTz = tenantRecord?.timezone || "Asia/Bangkok";

    const results = await Promise.all(
      JOB_DEFS.map(async (def) => {
        // Upsert default config if it doesn't exist yet, using tenant's own timezone
        const config = await prisma.cronJobConfig.upsert({
          where: { tenantId_jobKey: { tenantId, jobKey: def.key } },
          update: {},
          create: {
            tenantId,
            jobKey: def.key,
            cronExpr: def.defaultCronExpr,
            timezone: tenantTz,
            isEnabled: true
          }
        });

        const runs = await prisma.cronJobRun.findMany({
          where: { tenantId, jobKey: def.key },
          orderBy: { startedAt: "desc" },
          take: 20
        });

        return {
          jobKey: def.key,
          label: def.label,
          description: def.description,
          defaultCronExpr: def.defaultCronExpr,
          config: {
            id: config.id,
            cronExpr: config.cronExpr,
            timezone: config.timezone,
            isEnabled: config.isEnabled,
            updatedAt: config.updatedAt
          },
          runs
        };
      })
    );

    return results;
  });

  /** Update schedule config for a single job. */
  app.put("/cron-jobs/:jobKey", async (request) => {
    requireRoleAtLeast(request, UserRole.ADMIN);
    const tenantId = requireTenantId(request);
    const { jobKey } = request.params as { jobKey: string };

    if (!JOB_DEFS.find(d => d.key === jobKey)) {
      throw app.httpErrors.notFound("Unknown job key.");
    }

    const parsed = cronJobUpdateSchema.safeParse(request.body);
    if (!parsed.success) throw app.httpErrors.badRequest(zodMsg(parsed.error));

    // Validate cron expression using node-cron
    const cron = await import("node-cron");
    if (!cron.validate(parsed.data.cronExpr)) {
      throw app.httpErrors.badRequest(`Invalid cron expression: "${parsed.data.cronExpr}"`);
    }

    // Use tenant's timezone as default when caller doesn't supply one
    const tenantForUpdate = await prisma.tenant.findUnique({
      where: { id: tenantId },
      select: { timezone: true }
    });
    const effectiveTz = parsed.data.timezone ?? tenantForUpdate?.timezone ?? "Asia/Bangkok";

    const config = await prisma.cronJobConfig.upsert({
      where: { tenantId_jobKey: { tenantId, jobKey } },
      update: {
        cronExpr: parsed.data.cronExpr,
        isEnabled: parsed.data.isEnabled,
        timezone: effectiveTz
      },
      create: {
        tenantId,
        jobKey,
        cronExpr: parsed.data.cronExpr,
        isEnabled: parsed.data.isEnabled,
        timezone: effectiveTz
      }
    });

    // Hot-reload the scheduled task
    await rescheduleJob(tenantId, jobKey);

    return config;
  });

  /** Manually trigger a job right now. */
  app.post("/cron-jobs/:jobKey/trigger", async (request, reply) => {
    requireRoleAtLeast(request, UserRole.ADMIN);
    const tenantId = requireTenantId(request);
    const { jobKey } = request.params as { jobKey: string };

    if (!JOB_DEFS.find(d => d.key === jobKey)) {
      throw app.httpErrors.notFound("Unknown job key.");
    }

    const runId = await runJobNow(tenantId, jobKey);
    return reply.code(202).send({ runId, message: "Job triggered. Check run history for results." });
  });

  /** Paginated run history for a job. */
  app.get("/cron-jobs/:jobKey/runs", async (request) => {
    requireRoleAtLeast(request, UserRole.ADMIN);
    const tenantId = requireTenantId(request);
    const { jobKey } = request.params as { jobKey: string };

    const query = request.query as { limit?: string; offset?: string };
    const limit = Math.min(parseInt(query.limit ?? "50", 10), 200);
    const offset = parseInt(query.offset ?? "0", 10);

    const [runs, total] = await Promise.all([
      prisma.cronJobRun.findMany({
        where: { tenantId, jobKey },
        orderBy: { startedAt: "desc" },
        take: limit,
        skip: offset
      }),
      prisma.cronJobRun.count({ where: { tenantId, jobKey } })
    ]);

    return { runs, total, limit, offset };
  });

  app.get("/settings/audit-log", async (request) => {
    const tenantId = requireTenantId(request);
    requireRoleAtLeast(request, UserRole.ADMIN);
    const q = request.query as { page?: string; limit?: string; action?: string };
    const page  = Math.max(1, parseInt(q.page  ?? "1",  10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(q.limit ?? "50", 10) || 50));
    const skip  = (page - 1) * limit;

    const where = {
      tenantId,
      ...(q.action ? { action: q.action } : {})
    };

    const [rows, total] = await Promise.all([
      prisma.auditLog.findMany({
        where,
        orderBy: { createdAt: "desc" },
        skip,
        take: limit,
        select: { id: true, userId: true, action: true, detail: true, ipAddress: true, createdAt: true }
      }),
      prisma.auditLog.count({ where })
    ]);

    return { data: rows, total, page, limit, pages: Math.ceil(total / limit) };
  });

  // ── User Delegations ─────────────────────────────────────────────────────
  // SALES_ADMIN / ASSISTANT_MANAGER act on behalf of their principals. Only
  // tenant admins can manage the mapping. endsAt defaults to the far future;
  // temporary coverage sets an earlier endsAt, which auto-expires at runtime.
  const delegationCreateSchema = z.object({
    delegateUserId:  z.string().min(1),
    principalUserId: z.string().min(1),
    startsAt: z.string().datetime().optional(),
    endsAt:   z.string().datetime().optional()
  }).strict();

  const delegationPatchSchema = z.object({
    startsAt: z.string().datetime().optional(),
    endsAt:   z.string().datetime().optional()
  }).strict();

  app.get("/settings/delegations", async (request) => {
    requireRoleAtLeast(request, UserRole.ADMIN);
    const tenantId = requireTenantId(request);
    const rows = await prisma.userDelegation.findMany({
      where: { tenantId },
      orderBy: [{ createdAt: "desc" }],
      select: {
        id: true,
        delegateUserId: true,
        principalUserId: true,
        startsAt: true,
        endsAt: true,
        createdAt: true,
        updatedAt: true,
        delegate:  { select: { id: true, fullName: true, email: true, role: true } },
        principal: { select: { id: true, fullName: true, email: true, role: true } }
      }
    });
    return { data: rows };
  });

  app.post("/settings/delegations", async (request, reply) => {
    requireRoleAtLeast(request, UserRole.ADMIN);
    const tenantId = requireTenantId(request);
    const parsed = delegationCreateSchema.safeParse(request.body);
    if (!parsed.success) throw app.httpErrors.badRequest(zodMsg(parsed.error));
    const { delegateUserId, principalUserId } = parsed.data;
    if (delegateUserId === principalUserId) {
      throw app.httpErrors.badRequest("Delegate and principal must be different users.");
    }

    const [delegate, principal] = await Promise.all([
      prisma.user.findFirst({ where: { id: delegateUserId,  tenantId }, select: { id: true, role: true } }),
      prisma.user.findFirst({ where: { id: principalUserId, tenantId }, select: { id: true } })
    ]);
    if (!delegate)  throw app.httpErrors.badRequest("Delegate user not found in tenant.");
    if (!principal) throw app.httpErrors.badRequest("Principal user not found in tenant.");
    if (delegate.role !== UserRole.SALES_ADMIN && delegate.role !== UserRole.ASSISTANT_MANAGER) {
      throw app.httpErrors.badRequest("Only SALES_ADMIN or ASSISTANT_MANAGER users can be delegates.");
    }

    try {
      const created = await prisma.userDelegation.create({
        data: {
          tenantId,
          delegateUserId,
          principalUserId,
          ...(parsed.data.startsAt ? { startsAt: new Date(parsed.data.startsAt) } : {}),
          ...(parsed.data.endsAt   ? { endsAt:   new Date(parsed.data.endsAt)   } : {})
        }
      });
      return reply.code(201).send(created);
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
        throw app.httpErrors.conflict("This delegate already has a delegation to that principal.");
      }
      throw e;
    }
  });

  app.patch("/settings/delegations/:id", async (request) => {
    requireRoleAtLeast(request, UserRole.ADMIN);
    const tenantId = requireTenantId(request);
    const { id } = request.params as { id: string };
    const parsed = delegationPatchSchema.safeParse(request.body);
    if (!parsed.success) throw app.httpErrors.badRequest(zodMsg(parsed.error));

    const existing = await prisma.userDelegation.findFirst({ where: { id, tenantId }, select: { id: true } });
    if (!existing) throw app.httpErrors.notFound("Delegation not found.");

    return prisma.userDelegation.update({
      where: { id },
      data: {
        ...(parsed.data.startsAt ? { startsAt: new Date(parsed.data.startsAt) } : {}),
        ...(parsed.data.endsAt   ? { endsAt:   new Date(parsed.data.endsAt)   } : {})
      }
    });
  });

  app.delete("/settings/delegations/:id", async (request) => {
    requireRoleAtLeast(request, UserRole.ADMIN);
    const tenantId = requireTenantId(request);
    const { id } = request.params as { id: string };
    const existing = await prisma.userDelegation.findFirst({ where: { id, tenantId }, select: { id: true } });
    if (!existing) throw app.httpErrors.notFound("Delegation not found.");
    await prisma.userDelegation.delete({ where: { id } });
    return { ok: true };
  });

  // Who is this user served by? Used by the human-icon tooltip on record
  // detail + profile pages. Returns only currently-active delegations.
  app.get("/users/:id/delegates", async (request) => {
    requireAuth(request);
    const tenantId = requireTenantId(request);
    const { id } = request.params as { id: string };
    const now = new Date();
    const rows = await prisma.userDelegation.findMany({
      where: { tenantId, principalUserId: id, startsAt: { lte: now }, endsAt: { gt: now } },
      select: {
        id: true,
        endsAt: true,
        delegate: { select: { id: true, fullName: true, email: true, role: true } }
      }
    });
    return { data: rows };
  });

  // Who can I act on behalf of? Used by the "On behalf of" picker on record
  // create forms. Returns only the caller's currently-active principals.
  app.get("/users/me/principals", async (request) => {
    requireAuth(request);
    const tenantId = requireTenantId(request);
    const activeIds = await listActivePrincipalIds(request);
    if (activeIds.size === 0) return { data: [] };
    const rows = await prisma.user.findMany({
      where: { id: { in: [...activeIds] }, tenantId, isActive: true },
      select: { id: true, fullName: true, email: true, role: true },
      orderBy: { fullName: "asc" }
    });
    return { data: rows };
  });
};
