import { EntityType, IntegrationPlatform, Prisma, SourceStatus, SubscriptionStatus, UserRole } from "@prisma/client";
import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import { randomBytes } from "node:crypto";
import { z } from "zod";
import {
  assertTenantPathAccess,
  requireAuth,
  requireRoleAtLeast,
  requireSelfOrManagerAccess,
  requireTenantId,
  requireUserId
} from "../../lib/http.js";
import { hashPassword } from "../../lib/password.js";
import { prisma } from "../../lib/prisma.js";
import { assertSeatAvailable } from "../../lib/plan-limits.js";
import { updateSubscriptionSeatCount } from "../../lib/subscription-seats.js";
import { validateCustomFields, asRecord as asRecordCf } from "../../lib/custom-fields.js";
import { onboardTenantSchema } from "../tenants/schemas.js";
import { config } from "../../config.js";
import { decryptCredential } from "../../lib/secrets.js";
import { smtpPort } from "../../lib/smtp-port.js";
import { sendEmailCard, type EmailConfig } from "../../lib/email-notify.js";
import { getTenantUrl } from "../../lib/tenant-url.js";

const userInviteSchema = z.object({
  email: z.string().email(),
  fullName: z.string().min(2).max(120),
  role: z.nativeEnum(UserRole).default(UserRole.REP),
  teamId: z.string().cuid().optional(),
  managerUserId: z.string().cuid().optional()
});

const roleUpdateSchema = z.object({
  role: z.nativeEnum(UserRole)
});

const tenantScopedPaymentMethodSchema = z.object({
  paymentMethodRef: z.string().min(3)
});

const seatUpdateSchema = z.object({
  seatCount: z.number().int().positive(),
  effectiveAt: z.string().datetime().optional()
});

const roleChainSchema = z.object({
  chain: z
    .array(
      z.object({
        roleCode: z.string().min(1),
        roleName: z.string().min(1),
        rankOrder: z.number().int().nonnegative()
      })
    )
    .min(1)
});

const customFieldsUpsertSchema = z.object({
  customFields: z.record(z.string(), z.unknown())
});

const customerAddressDefaultsSchema = z
  .object({
    isDefaultBilling: z.boolean().optional(),
    isDefaultShipping: z.boolean().optional()
  })
  .refine(
    (value) => value.isDefaultBilling !== undefined || value.isDefaultShipping !== undefined,
    "At least one defaults field is required."
  );

function toEntityType(rawEntityType: string): EntityType | null {
  const normalized = rawEntityType.trim().toLowerCase();
  switch (normalized) {
    case "customer":
    case "customers":
      return EntityType.CUSTOMER;
    case "item":
    case "items":
      return EntityType.ITEM;
    case "payment-term":
    case "payment_terms":
    case "paymentterm":
      return EntityType.PAYMENT_TERM;
    default:
      return null;
  }
}

function normalizeDashboardQuery(query: unknown): string {
  if (!query || typeof query !== "object") return "";
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query as Record<string, unknown>)) {
    if (value === undefined || value === null || value === "") continue;
    params.set(key, String(value));
  }
  const queryString = params.toString();
  return queryString ? `?${queryString}` : "";
}

async function resolveDashboardOverview(request: FastifyRequest): Promise<{
  period: unknown;
  kpis: unknown;
  targetVsActual: unknown[];
  gamification: unknown[];
  teamPerformance: unknown[];
}> {
  const response = await request.server.inject({
    method: "GET",
    url: `/api/v1/dashboard/overview${normalizeDashboardQuery(request.query)}`,
    headers: request.headers as Record<string, string>
  });
  if (response.statusCode >= 400) {
    throw request.server.httpErrors.createError(response.statusCode, response.body);
  }
  return response.json();
}

function addDays(base: Date, days: number): Date {
  const next = new Date(base);
  next.setDate(next.getDate() + days);
  return next;
}

async function validateTenantScopedReferences(tenantId: string, body: z.infer<typeof userInviteSchema>) {
  if (body.teamId) {
    const team = await prisma.team.findFirst({
      where: { id: body.teamId, tenantId },
      select: { id: true }
    });
    if (!team) {
      throw new Error("teamId does not belong to tenant.");
    }
  }
  if (body.managerUserId) {
    const manager = await prisma.user.findFirst({
      where: { id: body.managerUserId, tenantId },
      select: { id: true }
    });
    if (!manager) {
      throw new Error("managerUserId does not belong to tenant.");
    }
  }
}

export const apiFirstRoutes: FastifyPluginAsync = async (app) => {
  app.get("/api-capabilities", async () => {
    return {
      version: "v1",
      objective: "Complete API-first contract coverage for web and future native mobile clients.",
      capabilityGroups: [
        "tenant_onboarding",
        "billing_and_subscription",
        "users_and_hierarchy",
        "master_data_and_custom_fields",
        "deals_and_quotations",
        "visits_and_calendar",
        "dashboard_and_gamification",
        "ai_and_integrations"
      ]
    };
  });

  app.post("/tenants/signup", async (request, reply) => {
    const parsed = onboardTenantSchema.safeParse(request.body);
    if (!parsed.success) {
      throw app.httpErrors.badRequest(parsed.error.message);
    }

    const payload = parsed.data;
    const tempPassword = `ThinkCRM-${randomBytes(4).toString("hex")}!`;
    const exists = await prisma.tenant.findUnique({
      where: { slug: payload.companySlug }
    });
    if (exists) {
      throw app.httpErrors.conflict("Tenant slug is already used.");
    }

    const result = await prisma.$transaction(async (tx) => {
      const tenant = await tx.tenant.create({
        data: { name: payload.companyName, slug: payload.companySlug }
      });
      const admin = await tx.user.create({
        data: {
          tenantId: tenant.id,
          email: payload.admin.email,
          passwordHash: hashPassword(tempPassword),
          mustResetPassword: true,
          fullName: payload.admin.fullName,
          role: UserRole.ADMIN
        }
      });
      const periodStart = new Date();
      await tx.subscription.create({
        data: {
          tenantId: tenant.id,
          provider: "STRIPE",
          pricingModel: "FIXED_PER_USER",
          status: "ACTIVE",
          seatPriceCents: payload.billing.seatPriceCents,
          seatCount: payload.billing.initialSeatCount,
          currency: payload.billing.currency.toUpperCase(),
          paymentMethodRef: payload.billing.paymentMethodRef,
          billingCycle: "MONTHLY",
          billingPeriodStart: periodStart,
          billingPeriodEnd: addDays(periodStart, 30)
        }
      });
      await tx.tenantStorageQuota.create({
        data: {
          tenantId: tenant.id,
          includedBytes: BigInt(payload.billing.includedBytes),
          overagePricePerGb: payload.billing.overagePricePerGb
        }
      });
      await tx.tenantTaxConfig.create({
        data: { tenantId: tenant.id, vatEnabled: true, vatRatePercent: 7 }
      });
      await tx.paymentTerm.create({
        data: {
          tenantId: tenant.id,
          code: "NET30",
          name: "Net 30",
          dueDays: 30
        }
      });
      await tx.dealStage.createMany({
        data: [
          { tenantId: tenant.id, stageName: "Opportunity", stageOrder: 1, isDefault: true },
          { tenantId: tenant.id, stageName: "Quotation", stageOrder: 2 },
          { tenantId: tenant.id, stageName: "Won", stageOrder: 3, isClosedWon: true },
          { tenantId: tenant.id, stageName: "Lost", stageOrder: 4, isClosedLost: true }
        ]
      });
      return { tenant, admin };
    });

    return reply.code(201).send({
      message: "Tenant signup completed.",
      tenantId: result.tenant.id,
      adminUserId: result.admin.id,
      temporaryPassword: tempPassword
    });
  });

  app.get("/dashboard/summary", async (request) => {
    requireAuth(request);
    const overview = await resolveDashboardOverview(request);
    return {
      period: overview.period,
      kpis: overview.kpis
    };
  });

  app.get("/dashboard/pipeline", async (request) => {
    requireAuth(request);
    const overview = await resolveDashboardOverview(request);
    const kpis = overview.kpis as Record<string, unknown>;
    return {
      period: overview.period,
      activeDeals: kpis.activeDeals ?? 0,
      pipelineValue: kpis.pipelineValue ?? 0,
      wonValue: kpis.wonValue ?? 0,
      lostValue: kpis.lostValue ?? 0
    };
  });

  app.get("/dashboard/visits", async (request) => {
    requireAuth(request);
    const overview = await resolveDashboardOverview(request);
    const kpis = overview.kpis as Record<string, unknown>;
    return {
      period: overview.period,
      visitCompletionRate: kpis.visitCompletionRate ?? 0,
      visitsPlannedInPeriod: kpis.visitsPlannedInPeriod ?? 0
    };
  });

  app.get("/dashboard/team-performance", async (request) => {
    requireAuth(request);
    const overview = await resolveDashboardOverview(request);
    return {
      period: overview.period,
      teams: overview.teamPerformance
    };
  });

  app.get("/dashboard/gamification", async (request) => {
    requireAuth(request);
    const overview = await resolveDashboardOverview(request);
    return {
      period: overview.period,
      leaderboard: overview.gamification
    };
  });

  app.get("/tenants/:id/storage/quota", async (request) => {
    requireRoleAtLeast(request, UserRole.MANAGER);
    const params = request.params as { id: string };
    assertTenantPathAccess(request, params.id);
    const quota = await prisma.tenantStorageQuota.findFirst({
      where: { tenantId: params.id },
      orderBy: { createdAt: "desc" }
    });
    if (!quota) {
      throw app.httpErrors.notFound("Storage quota not found.");
    }
    const latestUsage = await prisma.tenantStorageUsageDaily.findFirst({
      where: { tenantId: params.id },
      orderBy: { usageDate: "desc" }
    });
    return {
      tenantId: params.id,
      includedBytes: quota.includedBytes.toString(),
      overagePricePerGb: quota.overagePricePerGb,
      latestUsage: latestUsage
        ? {
            usageDate: latestUsage.usageDate,
            totalBytes: latestUsage.totalBytes.toString(),
            overageBytes: latestUsage.overageBytes.toString(),
            estimatedOverageAmount: latestUsage.estimatedOverageAmount
          }
        : null
    };
  });

  app.get("/tenants/:id/storage/usage", async (request) => {
    requireRoleAtLeast(request, UserRole.MANAGER);
    const params = request.params as { id: string };
    assertTenantPathAccess(request, params.id);
    const rows = await prisma.tenantStorageUsageDaily.findMany({
      where: { tenantId: params.id },
      orderBy: { usageDate: "desc" }
    });
    return rows.map((row) => ({
      ...row,
      totalBytes: row.totalBytes.toString(),
      overageBytes: row.overageBytes.toString()
    }));
  });

  app.get("/tenants/:id/subscription", async (request) => {
    requireRoleAtLeast(request, UserRole.MANAGER);
    const params = request.params as { id: string };
    assertTenantPathAccess(request, params.id);
    const subscription = await prisma.subscription.findFirst({
      where: { tenantId: params.id },
      orderBy: { createdAt: "desc" }
    });
    if (!subscription) {
      throw app.httpErrors.notFound("Subscription not found.");
    }
    return subscription;
  });

  app.post("/tenants/:id/subscription/payment-method", async (request) => {
    requireRoleAtLeast(request, UserRole.ADMIN);
    const params = request.params as { id: string };
    assertTenantPathAccess(request, params.id);
    const parsed = tenantScopedPaymentMethodSchema.safeParse(request.body);
    if (!parsed.success) {
      throw app.httpErrors.badRequest(parsed.error.message);
    }
    const subscription = await prisma.subscription.findFirst({
      where: { tenantId: params.id },
      orderBy: { createdAt: "desc" }
    });
    if (!subscription) {
      throw app.httpErrors.notFound("Subscription not found.");
    }
    return prisma.subscription.update({
      where: { id: subscription.id },
      data: {
        paymentMethodRef: parsed.data.paymentMethodRef,
        status: SubscriptionStatus.ACTIVE
      }
    });
  });

  app.patch("/tenants/:id/subscription/seats", async (request) => {
    requireRoleAtLeast(request, UserRole.ADMIN);
    const params = request.params as { id: string };
    assertTenantPathAccess(request, params.id);
    const parsed = seatUpdateSchema.safeParse(request.body);
    if (!parsed.success) {
      throw app.httpErrors.badRequest(parsed.error.message);
    }
    try {
      return await updateSubscriptionSeatCount(prisma, {
        tenantId: params.id,
        seatCount: parsed.data.seatCount,
        effectiveAt: parsed.data.effectiveAt ? new Date(parsed.data.effectiveAt) : undefined
      });
    } catch (error) {
      if (error instanceof Error && error.message === "SUBSCRIPTION_NOT_FOUND") {
        throw app.httpErrors.notFound("Subscription not found.");
      }
      throw error;
    }
  });

  app.post("/users/invite", async (request, reply) => {
    requireRoleAtLeast(request, UserRole.ADMIN);
    const tenantId = requireTenantId(request);
    const invitedById = requireUserId(request);
    const parsed = userInviteSchema.safeParse(request.body);
    if (!parsed.success) {
      throw app.httpErrors.badRequest(parsed.error.message);
    }
    try {
      await validateTenantScopedReferences(tenantId, parsed.data);
    } catch (error) {
      throw app.httpErrors.badRequest(error instanceof Error ? error.message : "Invalid tenant references.");
    }
    // S7: enforce seat limit before creating the invite
    await assertSeatAvailable(tenantId, app.httpErrors);

    const existing = await prisma.user.findFirst({
      where: { tenantId, email: parsed.data.email },
      select: { id: true }
    });
    if (existing) {
      throw app.httpErrors.conflict("User email already exists in this tenant.");
    }

    // Expire any previous pending invites for this email in this tenant.
    await prisma.userInvite.updateMany({
      where: { tenantId, email: parsed.data.email, acceptedAt: null },
      data: { expiresAt: new Date() }
    });

    const token = randomBytes(32).toString("hex");
    const invite = await prisma.userInvite.create({
      data: {
        tenantId,
        email: parsed.data.email,
        role: parsed.data.role,
        teamId: parsed.data.teamId,
        invitedById,
        token,
        expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000) // 7 days
      }
    });

    // Best-effort email delivery.
    let emailSent = false;
    try {
      const cred = await prisma.tenantIntegrationCredential.findUnique({
        where: { tenantId_platform: { tenantId, platform: IntegrationPlatform.EMAIL } },
        select: { clientIdRef: true, clientSecretRef: true, apiKeyRef: true, webhookTokenRef: true }
      }).then(r => decryptCredential(r));

      const branding = await prisma.tenantBranding.findUnique({
        where: { tenantId },
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
        const baseUrl = await getTenantUrl(tenantId);
        const inviteLink = `${baseUrl}/accept-invite?token=${token}`;
        await sendEmailCard(emailConfig, parsed.data.email, {
          subject: `You've been invited to ${appName}`,
          title: `Join ${appName}`,
          facts: [
            { label: "Role", value: parsed.data.role },
            { label: "Expires in", value: "7 days" }
          ],
          detailUrl: inviteLink,
          footer: "If you did not expect this invitation, you can safely ignore this email."
        });
        emailSent = true;
      } else {
        app.log.warn(`[invite] No SMTP configured — invite email for ${parsed.data.email} not sent. Token: ${token}`);
      }
    } catch (err) {
      app.log.error({ err }, `[invite] Failed to send invite email to ${parsed.data.email}`);
    }

    const acceptBaseUrl = await getTenantUrl(tenantId).catch(() => config.APP_URL?.replace(/\/$/, "") ?? "");
    return reply.code(201).send({
      id: invite.id,
      email: invite.email,
      role: invite.role,
      expiresAt: invite.expiresAt,
      emailSent,
      acceptUrl: `${acceptBaseUrl}/accept-invite?token=${token}`
    });
  });

  // ── Bulk user import (S12) ─────────────────────────────────────────────────

  const userImportRowSchema = z.object({
    email: z.string().email(),
    fullName: z.string().min(2).max(120),
    role: z.nativeEnum(UserRole).default(UserRole.REP),
    teamId: z.string().cuid().optional()
  });

  app.post("/users/import", async (request, reply) => {
    requireRoleAtLeast(request, UserRole.ADMIN);
    const tenantId = requireTenantId(request);

    // Accept JSON array or { users: [...] }
    const body = request.body as unknown;
    const rawRows: unknown[] = Array.isArray(body)
      ? body
      : (body as Record<string, unknown>)?.users as unknown[] ?? [];

    if (!Array.isArray(rawRows) || rawRows.length === 0) {
      throw app.httpErrors.badRequest("Expected a JSON array of users or { users: [...] }.");
    }
    if (rawRows.length > 200) {
      throw app.httpErrors.badRequest("Maximum 200 users per import.");
    }

    // Pre-fetch valid team IDs for this tenant.
    const tenantTeams = await prisma.team.findMany({
      where: { tenantId },
      select: { id: true }
    });
    const validTeamIds = new Set(tenantTeams.map(t => t.id));

    // Pre-fetch existing emails to avoid duplicates.
    const existingUsers = await prisma.user.findMany({
      where: { tenantId },
      select: { email: true }
    });
    const existingEmails = new Set(existingUsers.map(u => u.email.toLowerCase()));

    const created: { email: string; role: string }[] = [];
    const errors: { row: number; email?: string; error: string }[] = [];
    const seenEmails = new Set<string>();

    // Validate all rows first.
    type ValidRow = z.infer<typeof userImportRowSchema>;
    const validRows: ValidRow[] = [];

    for (let i = 0; i < rawRows.length; i++) {
      const parsed = userImportRowSchema.safeParse(rawRows[i]);
      if (!parsed.success) {
        errors.push({ row: i + 1, error: parsed.error.issues.map(e => e.message).join("; ") });
        continue;
      }
      const email = parsed.data.email.toLowerCase();
      if (existingEmails.has(email)) {
        errors.push({ row: i + 1, email, error: "Email already exists in tenant." });
        continue;
      }
      if (seenEmails.has(email)) {
        errors.push({ row: i + 1, email, error: "Duplicate email in import." });
        continue;
      }
      if (parsed.data.teamId && !validTeamIds.has(parsed.data.teamId)) {
        errors.push({ row: i + 1, email, error: "teamId does not belong to tenant." });
        continue;
      }
      seenEmails.add(email);
      validRows.push(parsed.data);
    }

    // Create all valid users in a single transaction.
    if (validRows.length > 0) {
      const tempPassword = `ThinkCRM-${randomBytes(4).toString("hex")}!`;
      const pw = hashPassword(tempPassword);

      await prisma.$transaction(
        validRows.map(row =>
          prisma.user.create({
            data: {
              tenantId,
              email: row.email.toLowerCase(),
              fullName: row.fullName,
              role: row.role,
              teamId: row.teamId,
              mustResetPassword: true,
              passwordHash: pw
            }
          })
        )
      );

      for (const row of validRows) {
        created.push({ email: row.email, role: row.role });
      }
    }

    return reply.code(created.length > 0 ? 201 : 200).send({
      created: created.length,
      errors: errors.length,
      results: created,
      errorDetails: errors
    });
  });

  app.patch("/users/:id/role", async (request) => {
    requireRoleAtLeast(request, UserRole.ADMIN);
    const tenantId = requireTenantId(request);
    const params = request.params as { id: string };
    const parsed = roleUpdateSchema.safeParse(request.body);
    if (!parsed.success) {
      throw app.httpErrors.badRequest(parsed.error.message);
    }
    const target = await prisma.user.findFirst({
      where: { id: params.id, tenantId }
    });
    if (!target) {
      throw app.httpErrors.notFound("User not found.");
    }
    return prisma.user.update({
      where: { id: target.id },
      data: { role: parsed.data.role }
    });
  });

  app.get("/users/:id/scope", async (request) => {
    requireAuth(request);
    const tenantId = requireTenantId(request);
    const params = request.params as { id: string };
    await requireSelfOrManagerAccess(request, params.id);
    const users = await prisma.user.findMany({
      where: { tenantId, isActive: true },
      select: { id: true, managerUserId: true, role: true }
    });
    const user = users.find((row) => row.id === params.id);
    if (!user) {
      throw app.httpErrors.notFound("User not found.");
    }
    const directReports = users.filter((row) => row.managerUserId === user.id).map((row) => row.id);
    const scoped = new Set<string>([user.id]);
    const queue = [...directReports];
    while (queue.length > 0) {
      const current = queue.shift();
      if (!current || scoped.has(current)) continue;
      scoped.add(current);
      for (const row of users) {
        if (row.managerUserId === current) {
          queue.push(row.id);
        }
      }
    }
    return {
      userId: user.id,
      role: user.role,
      scopeUserIds: [...scoped],
      directReportUserIds: directReports
    };
  });

  app.get("/tenants/:id/role-chain", async (request) => {
    requireRoleAtLeast(request, UserRole.MANAGER);
    const params = request.params as { id: string };
    assertTenantPathAccess(request, params.id);
    const rows = await prisma.tenantRoleChain.findMany({
      where: { tenantId: params.id, isActive: true },
      orderBy: { rankOrder: "asc" }
    });
    return { tenantId: params.id, chain: rows };
  });

  app.put("/tenants/:id/role-chain", async (request) => {
    requireRoleAtLeast(request, UserRole.ADMIN);
    const params = request.params as { id: string };
    assertTenantPathAccess(request, params.id);
    const parsed = roleChainSchema.safeParse(request.body);
    if (!parsed.success) {
      throw app.httpErrors.badRequest(parsed.error.message);
    }
    const sorted = parsed.data.chain.sort((a, b) => a.rankOrder - b.rankOrder);
    const created = await prisma.$transaction(async (tx) => {
      await tx.tenantRoleChain.deleteMany({ where: { tenantId: params.id } });
      if (sorted.length === 0) {
        return [];
      }
      await tx.tenantRoleChain.createMany({
        data: sorted.map((entry) => ({
          tenantId: params.id,
          roleCode: entry.roleCode,
          roleName: entry.roleName,
          rankOrder: entry.rankOrder,
          isActive: true
        }))
      });
      return tx.tenantRoleChain.findMany({
        where: { tenantId: params.id },
        orderBy: { rankOrder: "asc" }
      });
    });
    return { tenantId: params.id, chain: created, persisted: true };
  });

  app.post("/:entityType/:id/custom-fields", async (request) => {
    requireAuth(request);
    const tenantId = requireTenantId(request);
    const params = request.params as { entityType: string; id: string };
    const entityType = toEntityType(params.entityType);
    if (!entityType) {
      throw app.httpErrors.badRequest("Unsupported entityType for custom field upsert.");
    }
    const parsed = customFieldsUpsertSchema.safeParse(request.body);
    if (!parsed.success) {
      throw app.httpErrors.badRequest(parsed.error.message);
    }

    const definitions = await prisma.customFieldDefinition.findMany({
      where: { tenantId, entityType, isActive: true }
    });

    if (entityType === EntityType.CUSTOMER) {
      const customer = await prisma.customer.findFirst({
        where: { id: params.id, tenantId },
        select: { id: true, customFields: true }
      });
      if (!customer) {
        throw app.httpErrors.notFound("Customer not found.");
      }
      const customFields = validateCustomFields(app, definitions, {
        ...asRecordCf(customer.customFields),
        ...parsed.data.customFields
      });
      const updated = await prisma.customer.update({
        where: { id: customer.id },
        data: { customFields }
      });
      return updated;
    }

    if (entityType === EntityType.ITEM) {
      const item = await prisma.item.findFirst({
        where: { id: params.id, tenantId },
        select: { id: true, customFields: true }
      });
      if (!item) {
        throw app.httpErrors.notFound("Item not found.");
      }
      const customFields = validateCustomFields(app, definitions, {
        ...asRecordCf(item.customFields),
        ...parsed.data.customFields
      });
      const updated = await prisma.item.update({
        where: { id: item.id },
        data: { customFields }
      });
      return updated;
    }

    const paymentTerm = await prisma.paymentTerm.findFirst({
      where: { id: params.id, tenantId },
      select: { id: true, customFields: true }
    });
    if (!paymentTerm) {
      throw app.httpErrors.notFound("Payment term not found.");
    }
    const customFields = validateCustomFields(app, definitions, {
      ...asRecordCf(paymentTerm.customFields),
      ...parsed.data.customFields
    });
    const updated = await prisma.paymentTerm.update({
      where: { id: paymentTerm.id },
      data: { customFields }
    });
    return updated;
  });

  app.patch("/customers/:id/addresses/:addressId/defaults", async (request) => {
    requireAuth(request);
    const tenantId = requireTenantId(request);
    const params = request.params as { id: string; addressId: string };
    const parsed = customerAddressDefaultsSchema.safeParse(request.body);
    if (!parsed.success) {
      throw app.httpErrors.badRequest(parsed.error.message);
    }

    const customer = await prisma.customer.findFirst({
      where: { id: params.id, tenantId },
      select: { id: true }
    });
    if (!customer) {
      throw app.httpErrors.notFound("Customer not found.");
    }
    const address = await prisma.customerAddress.findFirst({
      where: { id: params.addressId, customerId: params.id }
    });
    if (!address) {
      throw app.httpErrors.notFound("Address not found.");
    }

    await prisma.$transaction(async (tx) => {
      if (parsed.data.isDefaultBilling) {
        await tx.customerAddress.updateMany({
          where: { customerId: params.id },
          data: { isDefaultBilling: false }
        });
      }
      if (parsed.data.isDefaultShipping) {
        await tx.customerAddress.updateMany({
          where: { customerId: params.id },
          data: { isDefaultShipping: false }
        });
      }
      await tx.customerAddress.update({
        where: { id: params.addressId },
        data: {
          isDefaultBilling: parsed.data.isDefaultBilling ?? undefined,
          isDefaultShipping: parsed.data.isDefaultShipping ?? undefined
        }
      });
    });

    return prisma.customerAddress.findUnique({ where: { id: params.addressId } });
  });
};
