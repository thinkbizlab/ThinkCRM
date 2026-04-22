import type { FastifyPluginAsync } from "fastify";
import os from "node:os";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import { isSuperAdmin, requireSuperAdmin, requireUserId } from "../../lib/http.js";
import { prisma } from "../../lib/prisma.js";
import { logAuditEvent } from "../../lib/audit.js";
import { getTenantR2Storage, isR2Configured } from "../../lib/r2-storage.js";
import { removeVercelDomain } from "../../lib/vercel-domains.js";
import { sendInvoiceEmail } from "../billing/invoice-email.js";

const tenantUpdateSchema = z.object({
  name: z.string().min(2).max(120).trim().optional(),
  slug: z.string().min(2).max(60).regex(/^[a-z0-9-]+$/).optional(),
  isActive: z.boolean().optional(),
  timezone: z.string().optional(),
});

export const superAdminRoutes: FastifyPluginAsync = async (app) => {
  // All routes require super admin
  app.addHook("onRequest", async (request) => {
    requireSuperAdmin(request);
  });

  // ── Check if current user is super admin ─────────────────────────────────
  // (Called before the hook — registered separately outside the guard)
  // We handle this with a separate endpoint registered in app.ts

  // ── List all tenants ─────────────────────────────────────────────────────
  app.get("/super-admin/tenants", async (request) => {
    const q = (request.query as { search?: string; status?: string });
    const search = q.search?.trim();
    const statusFilter = q.status; // "active" | "inactive" | undefined (all)

    const where: Record<string, unknown> = {};
    if (search) {
      where.OR = [
        { name: { contains: search, mode: "insensitive" } },
        { slug: { contains: search, mode: "insensitive" } },
      ];
    }
    if (statusFilter === "active") where.isActive = true;
    if (statusFilter === "inactive") where.isActive = false;

    const tenants = await prisma.tenant.findMany({
      where,
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        name: true,
        slug: true,
        isActive: true,
        timezone: true,
        createdAt: true,
        deactivatedAt: true,
        _count: { select: { users: true, deals: true, customers: true, visits: true } },
        subscriptions: {
          take: 1,
          orderBy: { createdAt: "desc" },
          select: { status: true, trialEndsAt: true, seatCount: true, billingCycle: true },
        },
        storageQuotas: {
          take: 1,
          select: { includedBytes: true },
        },
      },
    });

    return tenants.map((t) => ({
      id: t.id,
      name: t.name,
      slug: t.slug,
      isActive: t.isActive,
      timezone: t.timezone,
      createdAt: t.createdAt,
      deactivatedAt: t.deactivatedAt,
      userCount: t._count.users,
      dealCount: t._count.deals,
      customerCount: t._count.customers,
      visitCount: t._count.visits,
      storageQuotaBytes: t.storageQuotas[0] ? Number(t.storageQuotas[0].includedBytes) : null,
      subscription: t.subscriptions[0] ?? null,
    }));
  });

  // ── Get single tenant detail ─────────────────────────────────────────────
  app.get("/super-admin/tenants/:tenantId", async (request) => {
    const { tenantId } = request.params as { tenantId: string };
    const tenant = await prisma.tenant.findUnique({
      where: { id: tenantId },
      select: {
        id: true,
        name: true,
        slug: true,
        isActive: true,
        timezone: true,
        createdAt: true,
        deactivatedAt: true,
        stripeCustomerId: true,
        users: {
          select: { id: true, email: true, fullName: true, role: true, isActive: true, emailVerified: true, createdAt: true },
          orderBy: { createdAt: "asc" },
        },
        subscriptions: {
          take: 1,
          orderBy: { createdAt: "desc" },
          select: { id: true, status: true, trialEndsAt: true, seatCount: true, seatPriceCents: true, currency: true, billingCycle: true },
        },
        customDomain: { select: { domain: true, status: true, verifiedAt: true } },
        _count: { select: { deals: true, customers: true, visits: true, quotations: true } },
      },
    });
    if (!tenant) throw app.httpErrors.notFound("Tenant not found.");
    return tenant;
  });

  // ── Update tenant ────────────────────────────────────────────────────────
  app.patch("/super-admin/tenants/:tenantId", async (request) => {
    const { tenantId } = request.params as { tenantId: string };
    const parsed = tenantUpdateSchema.safeParse(request.body);
    if (!parsed.success) throw app.httpErrors.badRequest(parsed.error.issues[0]?.message ?? "Invalid input");

    const data = parsed.data;

    // Check slug uniqueness if changing
    if (data.slug) {
      const conflict = await prisma.tenant.findFirst({ where: { slug: data.slug, NOT: { id: tenantId } } });
      if (conflict) throw app.httpErrors.conflict("Slug is already in use.");
    }

    // Handle activation/deactivation
    const updateData: Record<string, unknown> = {};
    if (data.name !== undefined) updateData.name = data.name;
    if (data.slug !== undefined) updateData.slug = data.slug;
    if (data.timezone !== undefined) updateData.timezone = data.timezone;
    if (data.isActive !== undefined) {
      updateData.isActive = data.isActive;
      updateData.deactivatedAt = data.isActive ? null : new Date();
    }

    const updated = await prisma.tenant.update({
      where: { id: tenantId },
      data: updateData,
      select: { id: true, name: true, slug: true, isActive: true, timezone: true, deactivatedAt: true },
    });

    await logAuditEvent(tenantId, request.requestContext.userId, "SUPER_ADMIN_TENANT_UPDATE", { changes: data }, request.ip);

    return updated;
  });

  // ── Delete tenant ────────────────────────────────────────────────────────
  app.delete("/super-admin/tenants/:tenantId", async (request) => {
    const { tenantId } = request.params as { tenantId: string };

    const tenant = await prisma.tenant.findUnique({
      where: { id: tenantId },
      select: { id: true, name: true, slug: true, customDomain: { select: { domain: true } } },
    });
    if (!tenant) throw app.httpErrors.notFound("Tenant not found.");

    // Remove custom domain from Vercel if present
    if (tenant.customDomain?.domain) {
      await removeVercelDomain(tenant.customDomain.domain);
    }

    // Cascade delete takes care of all related records
    await prisma.tenant.delete({ where: { id: tenantId } });

    await logAuditEvent(tenantId, request.requestContext.userId, "SUPER_ADMIN_TENANT_DELETE", { name: tenant.name, slug: tenant.slug }, request.ip);

    return { ok: true, message: `Tenant "${tenant.name}" (${tenant.slug}) deleted.` };
  });

  // ── Impersonate: generate a JWT for any tenant's admin ───────────────────
  app.post("/super-admin/tenants/:tenantId/impersonate", async (request) => {
    const { tenantId } = request.params as { tenantId: string };

    const tenant = await prisma.tenant.findUnique({ where: { id: tenantId }, select: { id: true, slug: true, isActive: true } });
    if (!tenant) throw app.httpErrors.notFound("Tenant not found.");

    // Find the first active admin of the tenant
    const admin = await prisma.user.findFirst({
      where: { tenantId, role: "ADMIN", isActive: true },
      select: { id: true, email: true, role: true },
    });
    if (!admin) throw app.httpErrors.notFound("No active admin found for this tenant.");

    const token = await app.jwt.sign(
      { tenantId: tenant.id, userId: admin.id, role: admin.role, email: admin.email },
      { expiresIn: "1h" }  // Short-lived for security
    );

    await logAuditEvent(tenantId, request.requestContext.userId, "SUPER_ADMIN_IMPERSONATE", { targetUserId: admin.id, targetEmail: admin.email }, request.ip);

    return { token, tenantSlug: tenant.slug, userId: admin.id, email: admin.email, expiresIn: "1h" };
  });

  // ── Dashboard stats ──────────────────────────────────────────────────────
  app.get("/super-admin/stats", async () => {
    const [tenantCount, userCount, dealCount, activeCount, trialCount] = await Promise.all([
      prisma.tenant.count(),
      prisma.user.count(),
      prisma.deal.count(),
      prisma.tenant.count({ where: { isActive: true } }),
      prisma.subscription.count({ where: { status: "TRIALING" } }),
    ]);
    return { tenantCount, userCount, dealCount, activeCount, inactiveCount: tenantCount - activeCount, trialCount };
  });

  // ── R2 storage usage per tenant ──────────────────────────────────────────
  app.get("/super-admin/storage", async (request) => {
    if (!isR2Configured) return { configured: false, tenants: [] };

    const q = request.query as { skip?: string; take?: string };
    const skip = Math.max(0, parseInt(q.skip ?? "0", 10) || 0);
    const take = Math.min(50, Math.max(1, parseInt(q.take ?? "20", 10) || 20));

    const tenants = await prisma.tenant.findMany({
      orderBy: { createdAt: "desc" },
      skip,
      take,
      select: {
        id: true,
        name: true,
        slug: true,
        storageQuotas: { take: 1, select: { includedBytes: true } },
      },
    });

    // Fetch R2 storage for all tenants in parallel
    const storageResults = await Promise.all(
      tenants.map(async (t) => {
        try {
          const usage = await getTenantR2Storage(t.slug);
          return {
            tenantId: t.id,
            name: t.name,
            slug: t.slug,
            quotaBytes: t.storageQuotas[0] ? Number(t.storageQuotas[0].includedBytes) : 0,
            usedBytes: usage.totalBytes,
            objectCount: usage.objectCount,
          };
        } catch {
          return {
            tenantId: t.id,
            name: t.name,
            slug: t.slug,
            quotaBytes: t.storageQuotas[0] ? Number(t.storageQuotas[0].includedBytes) : 0,
            usedBytes: -1,
            objectCount: 0,
          };
        }
      })
    );

    const totalUsedBytes = storageResults.reduce((sum, t) => sum + Math.max(0, t.usedBytes), 0);
    return { configured: true, totalUsedBytes, tenants: storageResults };
  });

  // ── Realtime tenant activity ─────────────────────────────────────────────
  // One response covers: platform totals + per-tenant online count + today's
  // activity + 7-day audit sparkline. Frontend polls this every 20s.
  app.get("/super-admin/realtime", async () => {
    const now = new Date();
    const threeMinAgo = new Date(now.getTime() - 3 * 60 * 1000);
    const startOfDayUtc = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    const sevenDaysAgo = new Date(startOfDayUtc);
    sevenDaysAgo.setUTCDate(sevenDaysAgo.getUTCDate() - 6);

    const [tenants, onlineGroups, loginGroups, dealGroups, visitGroups, sparkRows] = await Promise.all([
      prisma.tenant.findMany({
        orderBy: { createdAt: "desc" },
        select: { id: true, name: true, slug: true, isActive: true },
      }),
      prisma.user.groupBy({
        by: ["tenantId"],
        where: { lastSeenAt: { gte: threeMinAgo } },
        _count: { _all: true },
      }),
      prisma.auditLog.groupBy({
        by: ["tenantId"],
        where: { action: "LOGIN", createdAt: { gte: startOfDayUtc } },
        _count: { _all: true },
      }),
      prisma.deal.groupBy({
        by: ["tenantId"],
        where: { createdAt: { gte: startOfDayUtc } },
        _count: { _all: true },
      }),
      prisma.visit.groupBy({
        by: ["tenantId"],
        where: { createdAt: { gte: startOfDayUtc } },
        _count: { _all: true },
      }),
      // 7-day audit activity bucketed by day, grouped by tenant
      prisma.$queryRaw<{ tenantId: string; day: Date; n: bigint }[]>`
        SELECT "tenantId", DATE_TRUNC('day', "createdAt") AS day, COUNT(*)::bigint AS n
        FROM "AuditLog"
        WHERE "createdAt" >= ${sevenDaysAgo}
        GROUP BY "tenantId", day
        ORDER BY day ASC
      `,
    ]);

    const onlineByTenant = new Map(onlineGroups.map((g) => [g.tenantId, g._count._all]));
    const loginsByTenant = new Map(loginGroups.map((g) => [g.tenantId, g._count._all]));
    const dealsByTenant  = new Map(dealGroups.map((g)  => [g.tenantId, g._count._all]));
    const visitsByTenant = new Map(visitGroups.map((g) => [g.tenantId, g._count._all]));

    // Build sparkline array of 7 ints per tenant. Day 0 = 6 days ago, day 6 = today.
    const sparkByTenant = new Map<string, number[]>();
    for (const row of sparkRows) {
      const dayStart = new Date(Date.UTC(row.day.getUTCFullYear(), row.day.getUTCMonth(), row.day.getUTCDate()));
      const offsetDays = Math.floor((dayStart.getTime() - sevenDaysAgo.getTime()) / (86400 * 1000));
      if (offsetDays < 0 || offsetDays > 6) continue;
      const arr = sparkByTenant.get(row.tenantId) ?? new Array(7).fill(0);
      arr[offsetDays] = Number(row.n);
      sparkByTenant.set(row.tenantId, arr);
    }

    const tenantSnapshot = tenants.map((t) => ({
      id: t.id,
      name: t.name,
      slug: t.slug,
      isActive: t.isActive,
      onlineUsers: onlineByTenant.get(t.id) ?? 0,
      loginsToday: loginsByTenant.get(t.id) ?? 0,
      dealsCreatedToday: dealsByTenant.get(t.id) ?? 0,
      visitsCreatedToday: visitsByTenant.get(t.id) ?? 0,
      spark: sparkByTenant.get(t.id) ?? new Array(7).fill(0),
    }));

    const onlineTotal  = tenantSnapshot.reduce((s, t) => s + t.onlineUsers, 0);
    const loginsTotal  = tenantSnapshot.reduce((s, t) => s + t.loginsToday, 0);
    const dealsTotal   = tenantSnapshot.reduce((s, t) => s + t.dealsCreatedToday, 0);
    const activeCount  = tenantSnapshot.filter((t) => t.isActive).length;

    return {
      generatedAt: now.toISOString(),
      totals: {
        onlineUsers: onlineTotal,
        loginsToday: loginsTotal,
        dealsCreatedToday: dealsTotal,
        activeTenants: activeCount,
        totalTenants: tenantSnapshot.length,
      },
      tenants: tenantSnapshot,
    };
  });

  // ── Infrastructure monitor ───────────────────────────────────────────────
  // What the Node process can truthfully report + DB-side queries. The sample
  // instance fields reflect the CURRENT Vercel function instance only.
  app.get("/super-admin/infra", async () => {
    const mem = process.memoryUsage();

    type DbStatsRow = { active: number; idle: number; max: number; dbSize: bigint };
    let dbStats: DbStatsRow = { active: 0, idle: 0, max: 0, dbSize: BigInt(0) };
    try {
      const rows = await prisma.$queryRaw<DbStatsRow[]>`
        SELECT
          (SELECT count(*)::int FROM pg_stat_activity WHERE state = 'active') AS active,
          (SELECT count(*)::int FROM pg_stat_activity WHERE state = 'idle')   AS idle,
          (SELECT setting::int FROM pg_settings WHERE name = 'max_connections') AS max,
          pg_database_size(current_database()) AS "dbSize"
      `;
      if (rows[0]) dbStats = rows[0];
    } catch (err) {
      // Neon may restrict pg_stat_activity access; fall through with zeros
      request_log_warn(err);
    }

    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
    const auditEventsLastHour = await prisma.auditLog.count({ where: { createdAt: { gte: oneHourAgo } } });

    return {
      sampleInstance: {
        rssBytes: mem.rss,
        heapUsedBytes: mem.heapUsed,
        heapTotalBytes: mem.heapTotal,
        externalBytes: mem.external,
        uptimeSec: Math.round(process.uptime()),
        nodeVersion: process.version,
        region: process.env.VERCEL_REGION ?? process.env.AWS_REGION ?? null,
        loadAvg: os.loadavg(),
      },
      database: {
        activeConnections: dbStats.active,
        idleConnections: dbStats.idle,
        maxConnections: dbStats.max,
        dbSizeBytes: Number(dbStats.dbSize),
      },
      audit: {
        auditEventsLastHour,
      },
      external: {
        vercelDashboardUrl: "https://vercel.com/dashboard",
        neonDashboardUrl: "https://console.neon.tech/",
        sentryDashboardUrl: process.env.SENTRY_DSN ? "https://sentry.io/" : null,
      },
    };
  });

  // ── Subscriptions overview ───────────────────────────────────────────────
  app.get("/super-admin/subscriptions", async () => {
    const subs = await prisma.subscription.findMany({
      orderBy: [{ status: "asc" }, { billingPeriodEnd: "asc" }],
      select: {
        id: true,
        status: true,
        billingCycle: true,
        seatCount: true,
        seatPriceCents: true,
        currency: true,
        billingPeriodStart: true,
        billingPeriodEnd: true,
        trialEndsAt: true,
        externalCustomerId: true,
        tenant: { select: { id: true, name: true, slug: true, isActive: true } },
      },
    });

    const now = Date.now();
    const rows = subs.map((s) => {
      const gross = (s.seatCount * s.seatPriceCents) / 100;
      const mrr = s.billingCycle === "YEARLY" ? gross / 12 : gross;
      const daysUntilRenewal = Math.ceil((s.billingPeriodEnd.getTime() - now) / 86_400_000);
      const daysUntilTrialEnd = s.trialEndsAt
        ? Math.ceil((s.trialEndsAt.getTime() - now) / 86_400_000)
        : null;
      return {
        subscriptionId: s.id,
        tenantId: s.tenant.id,
        tenantName: s.tenant.name,
        tenantSlug: s.tenant.slug,
        tenantActive: s.tenant.isActive,
        status: s.status,
        billingCycle: s.billingCycle,
        seatCount: s.seatCount,
        seatPriceCents: s.seatPriceCents,
        currency: s.currency,
        billingPeriodStart: s.billingPeriodStart,
        billingPeriodEnd: s.billingPeriodEnd,
        trialEndsAt: s.trialEndsAt,
        daysUntilRenewal,
        daysUntilTrialEnd,
        mrrCents: Math.round(mrr * 100),
        stripeCustomerId: s.externalCustomerId,
      };
    });

    const totals = rows.reduce(
      (acc, r) => {
        acc.mrrCents += r.mrrCents;
        acc.byStatus[r.status] = (acc.byStatus[r.status] ?? 0) + 1;
        return acc;
      },
      { mrrCents: 0, byStatus: {} as Record<string, number> }
    );

    return {
      totals: {
        ...totals,
        arrCents: totals.mrrCents * 12,
      },
      subscriptions: rows,
    };
  });

  // ── Tenant invoices (list) ───────────────────────────────────────────────
  app.get("/super-admin/tenants/:tenantId/invoices", async (request) => {
    const { tenantId } = request.params as { tenantId: string };
    const invoices = await prisma.tenantInvoice.findMany({
      where: { tenantId },
      orderBy: { invoiceMonth: "desc" },
      select: {
        id: true,
        invoiceMonth: true,
        periodStart: true,
        periodEnd: true,
        currency: true,
        seatsBaseCents: true,
        storageOverageCents: true,
        prorationAdjustmentsCents: true,
        totalDueCents: true,
        status: true,
        finalizedAt: true,
        createdAt: true,
      },
    });

    // Find the last INVOICE_EMAIL_SENT audit entry per invoice so the UI can
    // show "sentAt" without a schema change.
    const invoiceIds = invoices.map((i) => i.id);
    const sentRows = invoiceIds.length === 0
      ? []
      : await prisma.$queryRaw<{ invoiceId: string; sentAt: Date }[]>`
          SELECT detail->>'invoiceId' AS "invoiceId", MAX("createdAt") AS "sentAt"
          FROM "AuditLog"
          WHERE action = 'INVOICE_EMAIL_SENT'
            AND "tenantId" = ${tenantId}
            AND detail->>'invoiceId' IN (${Prisma.join(invoiceIds)})
          GROUP BY detail->>'invoiceId'
        `;
    const sentMap = new Map(sentRows.map((r) => [r.invoiceId, r.sentAt]));

    return invoices.map((i) => ({ ...i, sentAt: sentMap.get(i.id) ?? null }));
  });

  // ── Send / resend invoice email ──────────────────────────────────────────
  app.post("/super-admin/tenants/:tenantId/invoices/:invoiceId/send", async (request, reply) => {
    const { tenantId, invoiceId } = request.params as { tenantId: string; invoiceId: string };
    const actorUserId = requireUserId(request);
    const result = await sendInvoiceEmail({ tenantId, invoiceId, actorUserId });
    if (!result.ok) {
      return reply.status(400).send(result);
    }
    return result;
  });
};

// Tiny local helper — scoped to this file — so the tenant-scoped queries above
// don't swallow exceptions silently.
function request_log_warn(err: unknown): void {
  const msg = err instanceof Error ? err.message : String(err);
  console.warn(`[super-admin/infra] db stats unavailable: ${msg}`);
}
