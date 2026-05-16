/**
 * Mobile offline-sync discard analytics. The mobile clients (iOS + Android)
 * POST here every time a rep manually discards a permanently-failed offline
 * action (typically POST /visits/:id/checkin that exhausted retries with a 4xx).
 *
 * Why a dedicated endpoint instead of just AuditLog:
 *   - We want fast aggregation queries for the admin dashboard
 *     ("3 reps discarded check-ins with HTTP 410 this week").
 *   - AuditLog is the wrong shape — it's keyed on entity mutations, not
 *     client-side intent events.
 *
 * Privacy: we deliberately don't store coordinates, selfie bytes, or notes.
 * Just the failure metadata (kind, retryCount, error class, platform).
 */

import type { FastifyPluginAsync } from "fastify";
import { UserRole } from "@prisma/client";
import { z } from "zod";
import { prisma } from "../../lib/prisma.js";
import { requireRoleAtLeast, requireTenantId, requireUserId, zodMsg } from "../../lib/http.js";

const eventSchema = z.object({
  kind: z.enum(["visit_checkin", "visit_checkout"]),
  visitId: z.string().min(1).max(200),
  retryCount: z.number().int().min(0).max(10_000),
  // Cap defensively — clients should send a 500-char limit but long error
  // strings (stack traces, raw HTML 502 pages) sometimes slip through.
  lastError: z.string().max(500).optional().nullable().transform((v) => v ?? null),
  queuedDurationMs: z.number().int().min(0).max(30 * 24 * 60 * 60 * 1000),
  platform: z.enum(["IOS", "ANDROID"])
});

const batchSchema = z.object({
  events: z.array(eventSchema).min(1).max(50)
});

const listQuerySchema = z.object({
  since: z.string().datetime().optional(),
  kind: z.enum(["visit_checkin", "visit_checkout"]).optional(),
  limit: z.coerce.number().int().min(1).max(500).optional().default(100)
});

export const mobileDiscardRoutes: FastifyPluginAsync = async (app) => {
  // POST /api/v1/sync/discards — batch insert from the mobile client's outbox.
  // Returns the inserted count so the client can confirm before clearing its
  // local outbox queue.
  app.post("/sync/discards", async (request, reply) => {
    const tenantId = requireTenantId(request);
    const userId = requireUserId(request);

    const parsed = batchSchema.safeParse(request.body);
    if (!parsed.success) {
      throw app.httpErrors.badRequest(zodMsg(parsed.error));
    }

    const data = parsed.data.events.map((e) => ({
      tenantId, userId,
      kind: e.kind,
      visitId: e.visitId,
      retryCount: e.retryCount,
      lastError: e.lastError,
      queuedDurationMs: e.queuedDurationMs,
      platform: e.platform
    }));

    // A network blip causing the client to POST twice would create duplicate
    // rows. Acceptable noise for analytics — much simpler than threading a
    // client-generated dedupe id, and the only consumer is aggregated reports.
    const result = await prisma.syncDiscardEvent.createMany({ data });
    return reply.code(201).send({ inserted: result.count });
  });

  // GET /api/v1/sync/discards — admin-only raw listing. Default window: 30 days.
  app.get("/sync/discards", async (request) => {
    requireRoleAtLeast(request, UserRole.ADMIN);
    const tenantId = requireTenantId(request);

    const parsed = listQuerySchema.safeParse(request.query ?? {});
    if (!parsed.success) {
      throw app.httpErrors.badRequest(zodMsg(parsed.error));
    }
    const { since, kind, limit } = parsed.data;
    const sinceDate = since ? new Date(since) : new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

    const where = {
      tenantId,
      createdAt: { gte: sinceDate },
      ...(kind ? { kind } : {})
    };

    const [rows, total] = await Promise.all([
      prisma.syncDiscardEvent.findMany({
        where,
        orderBy: { createdAt: "desc" },
        take: limit
      }),
      prisma.syncDiscardEvent.count({ where })
    ]);

    return { rows, total, since: sinceDate.toISOString() };
  });

  // GET /api/v1/sync/discards/summary — bucketed aggregation. Drives the
  // "top error classes" widget on the admin dashboard.
  app.get("/sync/discards/summary", async (request) => {
    requireRoleAtLeast(request, UserRole.ADMIN);
    const tenantId = requireTenantId(request);
    const sinceDate = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

    const events = await prisma.syncDiscardEvent.findMany({
      where: { tenantId, createdAt: { gte: sinceDate } },
      select: { kind: true, platform: true, lastError: true }
    });

    // Bucket by (kind, platform, normalised error). The normaliser strips
    // request-specific context (cuid-shaped IDs, trailing whitespace) so
    // HTTP 410 errors all collapse to one bucket regardless of visitId.
    type Bucket = { kind: string; platform: string; errorClass: string; count: number };
    const buckets = new Map<string, Bucket>();
    for (const e of events) {
      const errorClass = normaliseError(e.lastError);
      const key = `${e.kind}|${e.platform}|${errorClass}`;
      const existing = buckets.get(key);
      if (existing) {
        existing.count += 1;
      } else {
        buckets.set(key, { kind: e.kind, platform: e.platform, errorClass, count: 1 });
      }
    }

    return {
      since: sinceDate.toISOString(),
      total: events.length,
      buckets: [...buckets.values()].sort((a, b) => b.count - a.count)
    };
  });
};

/**
 * Collapse similar errors into one bucket. Strips cuid-shaped tokens
 * (e.g. `visit cl1abc…xyz`), preserves any HTTP status as the bucket name,
 * and truncates anything past 80 chars. Keeps the report skim-friendly.
 *
 * If buckets get noisy in production we can move to a categorical enum
 * sent by the mobile client (e.g. ErrorClass.HTTP_410, .NetworkTimeout).
 */
function normaliseError(raw: string | null): string {
  if (!raw) return "(no error message)";
  let s = raw.trim();
  const httpMatch = /^HTTP\s+(\d{3})/i.exec(s);
  if (httpMatch) return `HTTP ${httpMatch[1]}`;
  s = s.replace(/c[a-z0-9]{20,30}/gi, "<id>");
  if (s.length > 80) s = s.slice(0, 80) + "…";
  return s;
}
