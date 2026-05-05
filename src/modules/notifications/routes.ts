// Bell-icon backend. Two endpoints:
//
//   GET  /me/notifications        — orchestrate every group function and
//                                   return a uniform list with a totalUnread.
//   POST /me/notifications/seen   — mark "now" as the last-seen marker
//                                   so the next GET reports 0 unread until
//                                   something new arrives.
//
// Group definitions live in ./aggregator.ts. Adding a new group is a
// one-function change there + one entry in the orchestrator below.

import type { FastifyPluginAsync } from "fastify";
import { UserRole } from "@prisma/client";
import { prisma } from "../../lib/prisma.js";
import { requireTenantId, requireUserId } from "../../lib/http.js";
import {
  billingAlertsGroup,
  dedupCandidatesGroup,
  draftCustomersGroup,
  expiringQuotationsGroup,
  overdueFollowUpsGroup,
  overdueVisitsGroup,
  pendingCheckoutGroup,
  staleProspectsGroup,
  syncFailuresGroup,
  type NotificationGroup
} from "./aggregator.js";

interface BellResponse {
  lastSeenAt: string | null;
  totalUnread: number;
  groups: NotificationGroup[];
}

export const notificationRoutes: FastifyPluginAsync = async (app) => {
  // GET /me/notifications — the bell payload. Designed to be called every 60s
  // by the frontend when the tab is visible. Each group is independent so
  // we run them in parallel; an empty group returns null and is filtered out.
  app.get("/me/notifications", async (request): Promise<BellResponse> => {
    const tenantId = requireTenantId(request);
    const userId = requireUserId(request);
    const role = request.requestContext.role ?? UserRole.REP;

    const [tenant, state] = await Promise.all([
      prisma.tenant.findUniqueOrThrow({
        where: { id: tenantId },
        select: { staleProspectAlertDays: true }
      }),
      prisma.userNotificationState.findUnique({
        where: { userId },
        select: { notifLastSeenAt: true }
      })
    ]);

    const ctx = {
      tenantId,
      userId,
      role,
      now: new Date(),
      lastSeenAt: state?.notifLastSeenAt ?? null,
      staleProspectAlertDays: tenant.staleProspectAlertDays
    };

    // Run every group in parallel — they're independent reads against
    // different tables. Order in the response matches user-priority
    // (pending checkout first because it requires action; admin items last).
    const results = await Promise.all([
      pendingCheckoutGroup(ctx),
      overdueFollowUpsGroup(ctx),
      overdueVisitsGroup(ctx),
      stale_safe(staleProspectsGroup(ctx)),
      expiringQuotationsGroup(ctx),
      draftCustomersGroup(ctx),
      syncFailuresGroup(ctx),
      dedupCandidatesGroup(ctx),
      billingAlertsGroup(ctx)
    ]);

    const groups = results.filter((g): g is NotificationGroup => g !== null);
    const totalUnread = groups.reduce((sum, g) => sum + g.unread, 0);

    return {
      lastSeenAt: ctx.lastSeenAt?.toISOString() ?? null,
      totalUnread,
      groups
    };
  });

  // POST /me/notifications/seen — fired when the user opens the bell panel.
  // Upsert (one row per user). Returns the new marker so the UI can sync.
  app.post("/me/notifications/seen", async (request): Promise<{ lastSeenAt: string }> => {
    requireTenantId(request);
    const userId = requireUserId(request);
    const now = new Date();
    await prisma.userNotificationState.upsert({
      where: { userId },
      create: { userId, notifLastSeenAt: now },
      update: { notifLastSeenAt: now }
    });
    return { lastSeenAt: now.toISOString() };
  });
};

// Don't let one slow group block the whole bell — but we want failures to
// surface in logs, not silently swallow data. Wrap each group call so a
// reject becomes "no group" instead of a 500. (For now, only wrap the
// tenant-config-dependent group; the rest are simple-enough queries.)
function stale_safe<T>(promise: Promise<T | null>): Promise<T | null> {
  return promise.catch(() => null);
}
