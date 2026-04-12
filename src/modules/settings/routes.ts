import {
  ChannelType,
  Direction,
  EntityType,
  ExecutionStatus,
  IntegrationPlatform,
  Prisma,
  SourceStatus,
  TriggerType,
  UserRole
} from "@prisma/client";
import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import {
  assertTenantPathAccess,
  listVisibleUserIds,
  requireAuth,
  requireRoleAtLeast,
  requireSelfOrManagerAccess,
  requireTenantId,
  requireUserId
} from "../../lib/http.js";
import { prisma } from "../../lib/prisma.js";
import {
  createR2PresignedDownload,
  createR2PresignedUpload,
  uploadBufferToR2
} from "../../lib/r2-storage.js";

const brandingSchema = z.object({
  logoUrl: z
    .union([z.string().trim(), z.literal("")])
    .optional()
    .transform((value) => (value === "" ? undefined : value))
    .refine(
      (value) =>
        value === undefined ||
        value.startsWith("/uploads/") ||
        value.startsWith("r2://") ||
        z.url().safeParse(value).success,
      "logoUrl must be an absolute URL, r2:// reference, or an /uploads/ path."
    ),
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
  themeMode: z.enum(["LIGHT", "DARK"]).default("LIGHT")
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
  IntegrationPlatform.LINE
] as const;

type ProfileIntegrationProvider = (typeof profileIntegrationProviders)[number];

const providerAliasMap: Record<string, ProfileIntegrationProvider> = {
  ms365: IntegrationPlatform.MS365,
  microsoft365: IntegrationPlatform.MS365,
  google: IntegrationPlatform.GOOGLE,
  google_calendar: IntegrationPlatform.GOOGLE,
  line: IntegrationPlatform.LINE
};

function resolveProfileProvider(rawProvider: string): ProfileIntegrationProvider | null {
  const normalized = rawProvider.trim().toLowerCase();
  return providerAliasMap[normalized] ?? null;
}

function buildProfileIntegrationCapabilities(provider: ProfileIntegrationProvider): {
  calendarSyncEnabled: boolean;
  notificationsEnabled: boolean;
} {
  return {
    calendarSyncEnabled:
      provider === IntegrationPlatform.MS365 || provider === IntegrationPlatform.GOOGLE,
    notificationsEnabled: provider === IntegrationPlatform.LINE
  };
}

function buildConnectOperationType(provider: ProfileIntegrationProvider): string {
  if (provider === IntegrationPlatform.LINE) {
    return "LINE_BIND_CONNECT";
  }
  return "CALENDAR_BIND_CONNECT";
}

function buildSyncOperationType(provider: ProfileIntegrationProvider): string {
  if (provider === IntegrationPlatform.LINE) {
    return "LINE_NOTIFICATION_SYNC";
  }
  return "CALENDAR_SYNC";
}

const tenantIntegrationPlatforms = [
  IntegrationPlatform.MS365,
  IntegrationPlatform.GOOGLE,
  IntegrationPlatform.LINE,
  IntegrationPlatform.MS_TEAMS,
  IntegrationPlatform.SLACK,
  IntegrationPlatform.EMAIL
] as const;

type TenantIntegrationPlatform = (typeof tenantIntegrationPlatforms)[number];
const MAX_LOGO_BYTES = 5 * 1024 * 1024;
const logoMimeToExt = new Map<string, string>([
  ["image/png", ".png"],
  ["image/jpeg", ".jpg"],
  ["image/webp", ".webp"],
  ["image/svg+xml", ".svg"]
]);
const storagePresignUploadSchema = z.object({
  objectKey: z.string().trim().min(1),
  contentType: z.string().trim().min(1).max(200).optional(),
  expiresInSeconds: z.coerce.number().int().min(60).max(3600).optional()
});
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
  managerUserId: z.string().cuid().nullable()
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
        platform: TenantIntegrationPlatform;
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
  const activeRecord = record && record.platform === platform ? record : null;
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
    requireRoleAtLeast(request, UserRole.MANAGER);
    assertTenantPathAccess(request, params.id);
    return prisma.tenantBranding.findUnique({ where: { tenantId: params.id } });
  });

  app.put("/tenants/:id/branding", async (request) => {
    const params = request.params as { id: string };
    requireRoleAtLeast(request, UserRole.ADMIN);
    assertTenantPathAccess(request, params.id);
    const parsed = brandingSchema.safeParse(request.body);
    if (!parsed.success) {
      throw app.httpErrors.badRequest(parsed.error.message);
    }

    return prisma.tenantBranding.upsert({
      where: { tenantId: params.id },
      update: parsed.data,
      create: { tenantId: params.id, ...parsed.data }
    });
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

    const objectKey = `branding/logos/${Date.now()}-${randomUUID()}${ext}`;
    let uploaded: { objectKey: string; objectRef: string };
    try {
      uploaded = await uploadBufferToR2({
        tenantId: params.id,
        objectKeyOrRef: objectKey,
        contentType: file.mimetype,
        data: logoBuffer
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown upload failure.";
      throw app.httpErrors.badGateway(message);
    }
    const logoUrl = uploaded.objectRef;
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
    const logoDownload = await createR2PresignedDownload({
      tenantId: params.id,
      objectKeyOrRef: uploaded.objectKey
    });
    return reply.code(201).send({
      message: "Logo uploaded",
      logoUrl,
      logoDownloadUrl: logoDownload.downloadUrl,
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
    const body = request.body as { vatEnabled: boolean; vatRatePercent: number };
    return prisma.tenantTaxConfig.upsert({
      where: { tenantId: params.id },
      update: body,
      create: { tenantId: params.id, ...body }
    });
  });

  app.post("/users/:id/integrations/ms365/connect", async (request, reply) => {
    const params = request.params as { id: string };
    await requireSelfOrManagerAccess(request, params.id);
    const tenantId = requireTenantId(request);
    await ensureTargetUserInTenant(params.id, tenantId);
    const parsed = profileIntegrationConnectSchema.safeParse(request.body);
    if (!parsed.success) {
      throw app.httpErrors.badRequest(parsed.error.message);
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
      throw app.httpErrors.badRequest(parsed.error.message);
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
      throw app.httpErrors.badRequest(parsed.error.message);
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
      throw app.httpErrors.badRequest(parsed.error.message);
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

  app.get("/users/:id/integrations", async (request) => {
    const params = request.params as { id: string };
    await requireSelfOrManagerAccess(request, params.id);
    const tenantId = requireTenantId(request);
    await ensureTargetUserInTenant(params.id, tenantId);

    const [accounts, logs] = await Promise.all([
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
      })
    ]);

    const accountByProvider = new Map(accounts.map((account) => [account.provider, account]));
    const latestConnectByProvider = new Map<ProfileIntegrationProvider, Date>();
    const latestCalendarSyncByProvider = new Map<ProfileIntegrationProvider, Date>();
    const latestLineSyncByProvider = new Map<ProfileIntegrationProvider, Date>();

    for (const log of logs) {
      const provider = log.platform as ProfileIntegrationProvider;
      const completedAt = log.completedAt ?? log.startedAt;

      if (
        (log.operationType === "CALENDAR_BIND_CONNECT" || log.operationType === "LINE_BIND_CONNECT") &&
        !latestConnectByProvider.has(provider)
      ) {
        latestConnectByProvider.set(provider, completedAt);
      }
      if (log.operationType === "CALENDAR_SYNC" && !latestCalendarSyncByProvider.has(provider)) {
        latestCalendarSyncByProvider.set(provider, completedAt);
      }
      if (log.operationType === "LINE_NOTIFICATION_SYNC" && !latestLineSyncByProvider.has(provider)) {
        latestLineSyncByProvider.set(provider, completedAt);
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
          ? latestLineSyncByProvider.get(provider) ?? null
          : null,
        capabilities
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
      throw app.httpErrors.badRequest(parsed.error.message);
    }

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
        clientIdRef: parsed.data.clientId,
        clientSecretRef: parsed.data.clientSecret,
        apiKeyRef: parsed.data.apiKey,
        webhookTokenRef: parsed.data.webhookToken,
        status: SourceStatus.DISABLED,
        lastTestStatus: null,
        lastTestResult: "Credentials saved. Run Test Connection before enabling."
      },
      update: {
        clientIdRef: parsed.data.clientId,
        clientSecretRef: parsed.data.clientSecret,
        apiKeyRef: parsed.data.apiKey,
        webhookTokenRef: parsed.data.webhookToken,
        status: SourceStatus.DISABLED,
        lastTestStatus: null,
        lastTestedAt: null,
        lastTestResult: "Credentials updated. Re-run Test Connection before enabling."
      }
    });
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

    const hasCredentialValue = Boolean(
      credential.clientIdRef ||
        credential.clientSecretRef ||
        credential.apiKeyRef ||
        credential.webhookTokenRef
    );
    const hasFailureHint = [
      credential.clientIdRef,
      credential.clientSecretRef,
      credential.apiKeyRef,
      credential.webhookTokenRef
    ]
      .filter((value): value is string => Boolean(value))
      .some((value) => value.toLowerCase().includes("fail"));

    const testStatus =
      hasCredentialValue && !hasFailureHint ? ExecutionStatus.SUCCESS : ExecutionStatus.FAILURE;
    const testResult =
      testStatus === ExecutionStatus.SUCCESS
        ? "Connection test passed."
        : "Connection test failed. Verify credentials and test again.";

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
      throw app.httpErrors.badRequest(parsed.error.message);
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

  app.post("/teams", async (request, reply) => {
    requireRoleAtLeast(request, UserRole.MANAGER);
    const tenantId = requireTenantId(request);
    const parsed = teamCreateSchema.safeParse(request.body);
    if (!parsed.success) {
      throw app.httpErrors.badRequest(parsed.error.message);
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
    requireRoleAtLeast(request, UserRole.MANAGER);
    const tenantId = requireTenantId(request);
    const teams = await prisma.team.findMany({
      where: { tenantId },
      orderBy: [{ teamName: "asc" }],
      include: {
        users: {
          select: {
            id: true,
            fullName: true,
            email: true,
            role: true,
            isActive: true
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
      throw app.httpErrors.badRequest(parsed.error.message);
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
      throw app.httpErrors.badRequest(parsed.error.message);
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
      throw app.httpErrors.badRequest(parsed.error.message);
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

  app.post("/kpi-targets", async (request, reply) => {
    requireRoleAtLeast(request, UserRole.ADMIN);
    const tenantId = requireTenantId(request);
    const parsed = kpiTargetCreateSchema.safeParse(request.body);
    if (!parsed.success) {
      throw app.httpErrors.badRequest(parsed.error.message);
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

  app.patch("/kpi-targets/:id", async (request) => {
    requireRoleAtLeast(request, UserRole.ADMIN);
    const tenantId = requireTenantId(request);
    const params = request.params as { id: string };
    const parsed = kpiTargetUpdateSchema.safeParse(request.body);
    if (!parsed.success) {
      throw app.httpErrors.badRequest(parsed.error.message);
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

  app.get("/kpi-targets", async (request) => {
    requireRoleAtLeast(request, UserRole.ADMIN);
    const tenantId = requireTenantId(request);
    const parsed = kpiTargetListQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      throw app.httpErrors.badRequest(parsed.error.message);
    }

    const filters = parsed.data;
    if (filters.userId) {
      const rep = await prisma.user.findFirst({
        where: {
          tenantId,
          id: filters.userId
        },
        select: {
          id: true
        }
      });
      if (!rep) {
        throw app.httpErrors.badRequest("Requested user does not belong to this tenant.");
      }
    }
    if (filters.teamId) {
      const team = await prisma.team.findFirst({
        where: {
          id: filters.teamId,
          tenantId
        },
        select: { id: true }
      });
      if (!team) {
        throw app.httpErrors.badRequest("Requested team does not belong to this tenant.");
      }
    }

    let teamRepIds: string[] | undefined;
    if (filters.teamId) {
      const repsInTeam = await prisma.user.findMany({
        where: {
          tenantId,
          teamId: filters.teamId,
          role: UserRole.REP
        },
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

    const rows = await prisma.salesKpiTarget.findMany({
      where: {
        tenantId,
        targetMonth: filters.targetMonth,
        ...(filteredUserIds ? { userId: { in: filteredUserIds } } : {})
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
      throw app.httpErrors.badRequest(parsed.error.message);
    }
    try {
      return await createR2PresignedUpload({
        tenantId,
        objectKeyOrRef: parsed.data.objectKey,
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
      throw app.httpErrors.badRequest(parsed.error.message);
    }
    try {
      return await createR2PresignedDownload({
        tenantId,
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
      throw app.httpErrors.badRequest(parsed.error.message);
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
      throw app.httpErrors.badRequest(parsed.error.message);
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
};
