import { DealStatus, UserRole, VisitStatus } from "@prisma/client";
import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { listVisibleUserIds, requireTenantId, resolveVisibleUserIds } from "../../lib/http.js";
import { prisma } from "../../lib/prisma.js";

const monthQuerySchema = z.object({
  month: z
    .string()
    .regex(/^\d{4}-\d{2}$/)
    .optional(),
  repId: z.string().optional(),
  teamId: z.string().optional()
});

function resolveMonthWindow(month?: string): { monthKey: string; dateFrom: Date; dateTo: Date } {
  const raw = month ?? new Date().toISOString().slice(0, 7);
  const [yearStr = "", monthStr = ""] = raw.split("-");
  const year = Number(yearStr);
  const monthIndex = Number(monthStr);
  const safeYear = Number.isFinite(year) ? year : new Date().getUTCFullYear();
  const safeMonthIndex = Number.isFinite(monthIndex) ? Math.min(Math.max(monthIndex, 1), 12) - 1 : new Date().getUTCMonth();
  const dateFrom = new Date(Date.UTC(safeYear, safeMonthIndex, 1, 0, 0, 0, 0));
  const dateTo = new Date(Date.UTC(safeYear, safeMonthIndex + 1, 1, 0, 0, 0, 0));
  return {
    monthKey: `${safeYear}-${String(safeMonthIndex + 1).padStart(2, "0")}`,
    dateFrom,
    dateTo
  };
}

export const dashboardRoutes: FastifyPluginAsync = async (app) => {
  app.get("/dashboard/overview", async (request) => {
    const tenantId = requireTenantId(request);
    const parsedQuery = monthQuerySchema.safeParse(request.query);
    if (!parsedQuery.success) {
      throw app.httpErrors.badRequest("Invalid month query. Expected YYYY-MM.");
    }
    const { monthKey, dateFrom, dateTo } = resolveMonthWindow(parsedQuery.data.month);
    const { repId, teamId } = parsedQuery.data;
    const requesterId = request.requestContext.userId;
    const requesterRole = request.requestContext.role;
    if (!requesterId) {
      throw app.httpErrors.unauthorized("Missing user context in token.");
    }

    const [users, teams] = await Promise.all([
      prisma.user.findMany({
        where: { tenantId, isActive: true },
        select: {
          id: true,
          role: true,
          managerUserId: true,
          teamId: true,
          fullName: true,
          avatarUrl: true
        }
      }),
      prisma.team.findMany({
        where: { tenantId, isActive: true },
        select: { id: true, teamName: true }
      })
    ]);

    const userById = new Map(users.map((user) => [user.id, user]));
    const visibleUserIds = resolveVisibleUserIds(users, requesterId, requesterRole ?? undefined);
    // Narrow scope to a specific team if requested
    if (teamId) {
      for (const id of [...visibleUserIds]) {
        const user = userById.get(id);
        if (!user || user.teamId !== teamId) visibleUserIds.delete(id);
      }
    }
    // Narrow scope to a specific rep if requested (must be within the caller's visible set)
    if (repId && visibleUserIds.has(repId)) {
      for (const id of [...visibleUserIds]) {
        if (id !== repId) visibleUserIds.delete(id);
      }
    }
    const visibleUserIdList = [...visibleUserIds];

    const [scopedTargets, openDealsByOwner, createdDealsByOwner, wonDealsByOwner, lostDealsByOwner, visitsByRepStatus] = await Promise.all([
      prisma.salesKpiTarget.findMany({
        where: {
          tenantId,
          targetMonth: monthKey,
          userId: { in: visibleUserIdList }
        }
      }),
      prisma.deal.groupBy({
        by: ["ownerId"],
        where: {
          tenantId,
          ownerId: { in: visibleUserIdList },
          status: DealStatus.OPEN
        },
        _count: { _all: true },
        _sum: { estimatedValue: true }
      }),
      prisma.deal.groupBy({
        by: ["ownerId"],
        where: {
          tenantId,
          ownerId: { in: visibleUserIdList },
          createdAt: { gte: dateFrom, lt: dateTo }
        },
        _count: { _all: true },
        _sum: { estimatedValue: true }
      }),
      prisma.deal.groupBy({
        by: ["ownerId"],
        where: {
          tenantId,
          ownerId: { in: visibleUserIdList },
          status: DealStatus.WON,
          closedAt: { gte: dateFrom, lt: dateTo }
        },
        _count: { _all: true },
        _sum: { estimatedValue: true }
      }),
      prisma.deal.groupBy({
        by: ["ownerId"],
        where: {
          tenantId,
          ownerId: { in: visibleUserIdList },
          status: DealStatus.LOST,
          closedAt: { gte: dateFrom, lt: dateTo }
        },
        _count: { _all: true },
        _sum: { estimatedValue: true }
      }),
      prisma.visit.groupBy({
        by: ["repId", "status"],
        where: {
          tenantId,
          repId: { in: visibleUserIdList },
          plannedAt: { gte: dateFrom, lt: dateTo }
        },
        _count: { _all: true }
      })
    ]);
    const scopedUsers = users.filter((user) => visibleUserIds.has(user.id));

    type UserMetrics = {
      activeDeals: number;
      pipelineValue: number;
      wonValue: number;
      lostValue: number;
      checkedOutVisits: number;
      plannedVisits: number;
      newDealValue: number;
      teamId: string | null;
    };

    const metricsByUser = scopedUsers.reduce<Record<string, UserMetrics>>((acc, user) => {
      acc[user.id] = {
        activeDeals: 0,
        pipelineValue: 0,
        wonValue: 0,
        lostValue: 0,
        checkedOutVisits: 0,
        plannedVisits: 0,
        newDealValue: 0,
        teamId: user.teamId
      };
      return acc;
    }, {});

    for (const row of openDealsByOwner) {
      const metrics = metricsByUser[row.ownerId];
      if (!metrics) continue;
      metrics.activeDeals = row._count._all;
      metrics.pipelineValue = row._sum.estimatedValue ?? 0;
    }

    for (const row of createdDealsByOwner) {
      const metrics = metricsByUser[row.ownerId];
      if (!metrics) continue;
      metrics.newDealValue = row._sum.estimatedValue ?? 0;
    }

    for (const row of wonDealsByOwner) {
      const metrics = metricsByUser[row.ownerId];
      if (!metrics) continue;
      metrics.wonValue = row._sum.estimatedValue ?? 0;
    }

    for (const row of lostDealsByOwner) {
      const metrics = metricsByUser[row.ownerId];
      if (!metrics) continue;
      metrics.lostValue = row._sum.estimatedValue ?? 0;
    }

    for (const row of visitsByRepStatus) {
      const metrics = metricsByUser[row.repId];
      if (!metrics) continue;
      metrics.plannedVisits += row._count._all;
      if (row.status === VisitStatus.CHECKED_OUT) {
        metrics.checkedOutVisits += row._count._all;
      }
    }

    const activeDeals = openDealsByOwner.reduce((sum, row) => sum + row._count._all, 0);
    const pipelineValue = openDealsByOwner.reduce((sum, row) => sum + (row._sum.estimatedValue ?? 0), 0);
    const wonValue = wonDealsByOwner.reduce((sum, row) => sum + (row._sum.estimatedValue ?? 0), 0);
    const lostValue = lostDealsByOwner.reduce((sum, row) => sum + (row._sum.estimatedValue ?? 0), 0);
    const dealsCreatedInPeriod = createdDealsByOwner.reduce((sum, row) => sum + row._count._all, 0);
    const visitsPlannedInPeriod = visitsByRepStatus.reduce((sum, row) => sum + row._count._all, 0);
    const checkedOutVisitsInPeriod = visitsByRepStatus
      .filter((row) => row.status === VisitStatus.CHECKED_OUT)
      .reduce((sum, row) => sum + row._count._all, 0);
    const visitCompletion = visitsPlannedInPeriod === 0 ? 0 : checkedOutVisitsInPeriod / visitsPlannedInPeriod;

    const actualByUser = scopedUsers.reduce<
      Record<
        string,
        {
          visits: number;
          newDealValue: number;
          revenue: number;
          teamId: string | null;
        }
      >
    >((acc, user) => {
      const metrics = metricsByUser[user.id];
      acc[user.id] = {
        visits: metrics?.checkedOutVisits ?? 0,
        newDealValue: metrics?.newDealValue ?? 0,
        revenue: metrics?.wonValue ?? 0,
        teamId: metrics?.teamId ?? user.teamId
      };
      return acc;
    }, {});

    const teamNameById  = new Map(teams.map((team) => [team.id, team.teamName]));
    const userNameById  = new Map(users.map((user) => [user.id, user.fullName]));
    const userAvatarById = new Map(users.map((user) => [user.id, user.avatarUrl ?? null]));

    const targetVsActual = scopedTargets.map((target) => {
      const actual = actualByUser[target.userId] ?? { visits: 0, newDealValue: 0, revenue: 0, teamId: null };
      const progressVisits = target.visitTargetCount === 0 ? 0 : (actual.visits / target.visitTargetCount) * 100;
      const progressNewDeal = target.newDealValueTarget === 0 ? 0 : (actual.newDealValue / target.newDealValueTarget) * 100;
      const progressRevenue = target.revenueTarget === 0 ? 0 : (actual.revenue / target.revenueTarget) * 100;

      return {
        userId: target.userId,
        userName: userNameById.get(target.userId) ?? target.userId,
        avatarUrl: userAvatarById.get(target.userId) ?? null,
        teamId: actual.teamId,
        teamName: actual.teamId ? (teamNameById.get(actual.teamId) ?? "Unassigned Team") : "Unassigned Team",
        month: target.targetMonth,
        target: {
          visits: target.visitTargetCount,
          newDealValue: target.newDealValueTarget,
          revenue: target.revenueTarget
        },
        actual: {
          visits: actual.visits,
          newDealValue: Number(actual.newDealValue.toFixed(2)),
          revenue: Number(actual.revenue.toFixed(2))
        },
        progress: {
          visits: Number(progressVisits.toFixed(2)),
          newDealValue: Number(progressNewDeal.toFixed(2)),
          revenue: Number(progressRevenue.toFixed(2))
        }
      };
    });

    const teamPerformanceMap = new Map<
      string,
      {
        teamId: string;
        teamName: string;
        memberCount: number;
        activeDeals: number;
        pipelineValue: number;
        wonValue: number;
        lostValue: number;
        checkedOutVisits: number;
        plannedVisits: number;
        visitCompletionRate: number;
      }
    >();

    for (const user of scopedUsers) {
      const teamId = user.teamId ?? "unassigned";
      if (!teamPerformanceMap.has(teamId)) {
        teamPerformanceMap.set(teamId, {
          teamId,
          teamName: user.teamId ? (teamNameById.get(user.teamId) ?? "Unknown Team") : "Unassigned Team",
          memberCount: 0,
          activeDeals: 0,
          pipelineValue: 0,
          wonValue: 0,
          lostValue: 0,
          checkedOutVisits: 0,
          plannedVisits: 0,
          visitCompletionRate: 0
        });
      }

      const row = teamPerformanceMap.get(teamId);
      if (!row) continue;
      row.memberCount += 1;
      const metrics = metricsByUser[user.id];
      if (!metrics) continue;

      row.activeDeals += metrics.activeDeals;
      row.pipelineValue += metrics.pipelineValue;
      row.wonValue += metrics.wonValue;
      row.lostValue += metrics.lostValue;
      row.plannedVisits += metrics.plannedVisits;
      row.checkedOutVisits += metrics.checkedOutVisits;
    }

    const teamPerformance = [...teamPerformanceMap.values()]
      .map((team) => ({
        ...team,
        pipelineValue: Number(team.pipelineValue.toFixed(2)),
        wonValue: Number(team.wonValue.toFixed(2)),
        lostValue: Number(team.lostValue.toFixed(2)),
        visitCompletionRate: Number((team.plannedVisits === 0 ? 0 : (team.checkedOutVisits / team.plannedVisits) * 100).toFixed(2))
      }))
      .sort((a, b) => b.wonValue - a.wonValue);

    const gamification = targetVsActual
      .map((entry) => {
        const score = Number(
          (
            (entry.progress.visits * 0.35 + entry.progress.newDealValue * 0.3 + entry.progress.revenue * 0.35) *
            (entry.actual.visits > 0 ? 1 : 0.5)
          ).toFixed(2)
        );
        const badge = score >= 120 ? "Legend" : score >= 90 ? "Gold" : score >= 70 ? "Silver" : "Bronze";
        return {
          userId: entry.userId,
          userName: entry.userName,
          avatarUrl: entry.avatarUrl,
          teamName: entry.teamName,
          score,
          badge,
          streakDays: Math.min(31, Math.max(1, Math.round(entry.progress.revenue / 10))),
          momentum: score >= 100 ? "up" : score >= 70 ? "steady" : "down"
        };
      })
      .sort((a, b) => b.score - a.score)
      .map((entry, index) => ({
        ...entry,
        rank: index + 1
      }));

    return {
      period: {
        month: monthKey,
        dateFrom,
        dateTo
      },
      kpis: {
        activeDeals,
        pipelineValue,
        wonValue,
        lostValue,
        visitCompletionRate: Number((visitCompletion * 100).toFixed(2)),
        dealsCreatedInPeriod,
        visitsPlannedInPeriod,
        usersInScope: visibleUserIdList.length
      },
      targetVsActual,
      gamification,
      teamPerformance
    };
  });

  // Deals rolled up by customer group. Returns one row per group plus an
  // "Ungrouped" bucket for customers with no customerGroupId. Counts all
  // deals visible to the caller's hierarchy.
  app.get("/dashboard/by-customer-group", async (request) => {
    const tenantId = requireTenantId(request);
    const visibleUserIds = [...(await listVisibleUserIds(request))];
    const [groups, rows] = await Promise.all([
      prisma.customerGroup.findMany({
        where: { tenantId },
        select: { id: true, code: true, name: true },
        orderBy: { name: "asc" }
      }),
      prisma.deal.findMany({
        where: { tenantId, ownerId: { in: visibleUserIds } },
        select: {
          estimatedValue: true,
          status: true,
          customer: { select: { customerGroupId: true } }
        }
      })
    ]);
    const byGroup = new Map<string, { count: number; estimatedValue: number; won: number }>();
    const addTo = (key: string, estimated: number, status: DealStatus) => {
      const cur = byGroup.get(key) ?? { count: 0, estimatedValue: 0, won: 0 };
      cur.count += 1;
      cur.estimatedValue += estimated;
      if (status === DealStatus.WON) cur.won += estimated;
      byGroup.set(key, cur);
    };
    for (const r of rows) {
      const key = r.customer.customerGroupId ?? "__none__";
      addTo(key, Number(r.estimatedValue ?? 0), r.status);
    }
    const result = groups.map((g) => ({
      id: g.id,
      code: g.code,
      name: g.name,
      ...(byGroup.get(g.id) ?? { count: 0, estimatedValue: 0, won: 0 })
    }));
    const none = byGroup.get("__none__");
    if (none) {
      result.push({
        id: null as unknown as string,
        code: "",
        name: "Ungrouped",
        ...none
      });
    }
    return result;
  });

  app.get("/rep-todo", async (request) => {
    const tenantId = requireTenantId(request);
    const userId = request.requestContext.userId;
    if (!userId) {
      throw app.httpErrors.unauthorized("Missing x-user-id");
    }
    const now = new Date();
    const tomorrow = new Date(now.getTime() + 86400000);
    const nextWeek = new Date(now.getTime() + 7 * 86400000);
    const nextMonth = new Date(now.getTime() + 30 * 86400000);

    const visits = await prisma.visit.findMany({
      where: { tenantId, repId: userId, plannedAt: { gte: now, lte: nextMonth } },
      include: {
        customer: true,
        prospect: { select: { id: true, displayName: true } }
      }
    });

    const bucketOf = (at: Date) => {
      if (at < tomorrow) return "today";
      if (at < new Date(tomorrow.getTime() + 86400000)) return "tomorrow";
      if (at < nextWeek) return "next_week";
      return "next_month";
    };

    const pinned = visits.filter((v) => v.status === VisitStatus.CHECKED_IN);
    const grouped = visits.reduce<Record<string, unknown[]>>(
      (acc, visit) => {
        const bucket = bucketOf(visit.plannedAt);
        acc[bucket] = acc[bucket] ?? [];
        acc[bucket].push({
          id: visit.id,
          customer: visit.customer
            ? visit.customer.name
            : visit.prospect
              ? `Prospect: ${visit.prospect.displayName ?? "(unnamed)"}`
              : "—",
          at: visit.plannedAt,
          status: visit.status,
          action: visit.status === VisitStatus.CHECKED_IN ? "CHECK_OUT" : "CHECK_IN"
        });
        return acc;
      },
      { today: [], tomorrow: [], next_week: [], next_month: [] }
    );

    return {
      pinned: pinned.map((v) => ({
        id: v.id,
        customerId: v.customerId,
        status: v.status,
        action: "CHECK_OUT"
      })),
      buckets: grouped
    };
  });
};
