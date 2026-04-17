import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { isSuperAdmin, requireSuperAdmin } from "../../lib/http.js";
import { prisma } from "../../lib/prisma.js";
import { logAuditEvent } from "../../lib/audit.js";
import { getTenantR2Storage, isR2Configured } from "../../lib/r2-storage.js";
import { removeVercelDomain } from "../../lib/vercel-domains.js";

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
        } catch (err) {
          app.log.error({ err, slug: t.slug }, "[super-admin] R2 storage scan failed");
          return {
            tenantId: t.id,
            name: t.name,
            slug: t.slug,
            quotaBytes: t.storageQuotas[0] ? Number(t.storageQuotas[0].includedBytes) : 0,
            usedBytes: -1,
            objectCount: 0,
            error: err instanceof Error ? err.message : String(err),
          };
        }
      })
    );

    const totalUsedBytes = storageResults.reduce((sum, t) => sum + Math.max(0, t.usedBytes), 0);
    return { configured: true, totalUsedBytes, tenants: storageResults };
  });
};
