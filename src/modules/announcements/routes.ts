import { Prisma, UserRole } from "@prisma/client";
import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { logAuditEvent } from "../../lib/audit.js";
import { requireRoleAtLeast, requireTenantId, requireUserId, zodMsg } from "../../lib/http.js";
import { prisma } from "../../lib/prisma.js";

const createSchema = z.object({
  title: z.string().min(1).max(200).trim(),
  body: z.string().min(1).max(5000).trim(),
  // Empty array = broadcast to every user. Otherwise restrict to listed roles.
  // De-dupe on server so the array stored is canonical.
  roles: z.array(z.nativeEnum(UserRole))
    .default([])
    .transform((arr) => Array.from(new Set(arr)))
});

const updateSchema = createSchema.partial();

export const announcementRoutes: FastifyPluginAsync = async (app) => {
  // ── User-facing endpoints ──────────────────────────────────────────────────

  // List announcements the caller has not yet acknowledged. Newest first so
  // the modal can show them in reverse-chronological order.
  app.get("/announcements/unread", async (request) => {
    const tenantId = requireTenantId(request);
    const userId = requireUserId(request);
    const role = request.requestContext.role;
    const rows = await prisma.announcement.findMany({
      where: {
        tenantId,
        acknowledgments: { none: { userId } },
        // Targeting: empty `roles` array = broadcast to all; otherwise only
        // users whose role is included see the announcement. The OR is
        // expressed as `isEmpty: true` ∨ `has: <currentRole>` because
        // Prisma's array ops treat them as separate predicates.
        OR: [
          { roles: { isEmpty: true } },
          ...(role ? [{ roles: { has: role } }] : [])
        ]
      },
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        title: true,
        body: true,
        createdAt: true,
        createdBy: { select: { fullName: true } }
      }
    });
    return rows.map((r) => ({
      id: r.id,
      title: r.title,
      body: r.body,
      createdAt: r.createdAt,
      createdByName: r.createdBy?.fullName ?? null
    }));
  });

  // Acknowledge an announcement — idempotent. The unique (announcementId,userId)
  // index makes a second click a no-op rather than a duplicate row.
  app.post("/announcements/:id/ack", async (request, reply) => {
    const tenantId = requireTenantId(request);
    const userId = requireUserId(request);
    const { id } = request.params as { id: string };
    const announcement = await prisma.announcement.findFirst({
      where: { id, tenantId },
      select: { id: true }
    });
    if (!announcement) throw app.httpErrors.notFound("Announcement not found.");

    try {
      await prisma.announcementAck.create({
        data: { tenantId, announcementId: id, userId }
      });
    } catch (err) {
      // Unique violation = already acknowledged. Treat as success.
      if (!(err instanceof Prisma.PrismaClientKnownRequestError) || err.code !== "P2002") {
        throw err;
      }
    }
    await logAuditEvent(tenantId, userId, "ANNOUNCEMENT_ACKNOWLEDGED", { announcementId: id }, request.ip);
    return reply.code(204).send();
  });

  // ── Admin endpoints ────────────────────────────────────────────────────────

  // List all announcements with ack counts so the admin can see reach.
  // Reach is per-announcement: total active users when roles is empty,
  // otherwise active users whose role is in the targeting list.
  app.get("/announcements", async (request) => {
    requireRoleAtLeast(request, UserRole.ADMIN);
    const tenantId = requireTenantId(request);
    const [rows, usersByRole, totalUsers] = await Promise.all([
      prisma.announcement.findMany({
        where: { tenantId },
        orderBy: { createdAt: "desc" },
        select: {
          id: true,
          title: true,
          body: true,
          roles: true,
          createdAt: true,
          updatedAt: true,
          createdBy: { select: { id: true, fullName: true } },
          _count: { select: { acknowledgments: true } }
        }
      }),
      prisma.user.groupBy({
        by: ["role"],
        where: { tenantId, isActive: true },
        _count: { _all: true }
      }),
      prisma.user.count({ where: { tenantId, isActive: true } })
    ]);
    const countByRole = new Map<UserRole, number>(
      usersByRole.map((row) => [row.role, row._count._all])
    );
    const audienceFor = (roles: UserRole[]): number => {
      if (roles.length === 0) return totalUsers;
      return roles.reduce((sum, r) => sum + (countByRole.get(r) ?? 0), 0);
    };
    return {
      totalActiveUsers: totalUsers,
      announcements: rows.map((r) => ({
        id: r.id,
        title: r.title,
        body: r.body,
        roles: r.roles,
        createdAt: r.createdAt,
        updatedAt: r.updatedAt,
        createdBy: r.createdBy,
        ackCount: r._count.acknowledgments,
        audienceSize: audienceFor(r.roles)
      }))
    };
  });

  // Per-announcement ack log — shows who accepted and when.
  app.get("/announcements/:id/acks", async (request) => {
    requireRoleAtLeast(request, UserRole.ADMIN);
    const tenantId = requireTenantId(request);
    const { id } = request.params as { id: string };
    const announcement = await prisma.announcement.findFirst({
      where: { id, tenantId },
      select: { id: true }
    });
    if (!announcement) throw app.httpErrors.notFound("Announcement not found.");

    const acks = await prisma.announcementAck.findMany({
      where: { tenantId, announcementId: id },
      orderBy: { acknowledgedAt: "desc" },
      select: {
        id: true,
        acknowledgedAt: true,
        user: { select: { id: true, fullName: true, email: true } }
      }
    });
    return acks.map((a) => ({
      id: a.id,
      acknowledgedAt: a.acknowledgedAt,
      user: a.user
    }));
  });

  app.post("/announcements", async (request, reply) => {
    requireRoleAtLeast(request, UserRole.ADMIN);
    const tenantId = requireTenantId(request);
    const userId = requireUserId(request);
    const parsed = createSchema.safeParse(request.body);
    if (!parsed.success) throw app.httpErrors.badRequest(zodMsg(parsed.error));

    const created = await prisma.announcement.create({
      data: {
        tenantId,
        title: parsed.data.title,
        body: parsed.data.body,
        roles: parsed.data.roles,
        createdById: userId
      },
      select: { id: true, title: true, body: true, roles: true, createdAt: true }
    });
    await logAuditEvent(tenantId, userId, "ANNOUNCEMENT_CREATED", {
      announcementId: created.id,
      title: created.title,
      roles: created.roles
    }, request.ip);
    return reply.code(201).send(created);
  });

  app.patch("/announcements/:id", async (request) => {
    requireRoleAtLeast(request, UserRole.ADMIN);
    const tenantId = requireTenantId(request);
    const userId = requireUserId(request);
    const { id } = request.params as { id: string };
    const parsed = updateSchema.safeParse(request.body);
    if (!parsed.success) throw app.httpErrors.badRequest(zodMsg(parsed.error));

    const existing = await prisma.announcement.findFirst({
      where: { id, tenantId },
      select: { id: true }
    });
    if (!existing) throw app.httpErrors.notFound("Announcement not found.");

    const updated = await prisma.announcement.update({
      where: { id },
      data: parsed.data,
      select: { id: true, title: true, body: true, roles: true, createdAt: true, updatedAt: true }
    });
    await logAuditEvent(tenantId, userId, "ANNOUNCEMENT_UPDATED", {
      announcementId: id,
      changes: parsed.data
    }, request.ip);
    return updated;
  });

  app.delete("/announcements/:id", async (request, reply) => {
    requireRoleAtLeast(request, UserRole.ADMIN);
    const tenantId = requireTenantId(request);
    const userId = requireUserId(request);
    const { id } = request.params as { id: string };

    const existing = await prisma.announcement.findFirst({
      where: { id, tenantId },
      select: { id: true, title: true }
    });
    if (!existing) throw app.httpErrors.notFound("Announcement not found.");

    // Acks cascade-delete via FK ON DELETE CASCADE.
    await prisma.announcement.delete({ where: { id } });
    await logAuditEvent(tenantId, userId, "ANNOUNCEMENT_DELETED", {
      announcementId: id,
      title: existing.title
    }, request.ip);
    return reply.code(204).send();
  });
};
