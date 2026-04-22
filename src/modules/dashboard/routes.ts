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

    const visibleUserIds = resolveVisibleUserIds(users, requesterId, requesterRole ?? undefined);
    // Narrow scope to a specific team if requested
    if (teamId) {
      for (const id of [...visibleUserIds]) {
        const user = users.find((u) => u.id === id);
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

    const [scopedDeals, scopedVisits, scopedTargets] = await Promise.all([
      prisma.deal.findMany({ where: { tenantId, ownerId: { in: visibleUserIdList } } }),
      prisma.visit.findMany({ where: { tenantId, repId: { in: visibleUserIdList } } }),
      prisma.salesKpiTarget.findMany({
        where: {
          tenantId,
          targetMonth: monthKey,
          userId: { in: visibleUserIdList }
        }
      })
    ]);
    const scopedUsers = users.filter((user) => visibleUserIds.has(user.id));

    const periodVisits = scopedVisits.filter((visit) => visit.plannedAt >= dateFrom && visit.plannedAt < dateTo);
    const periodCreatedDeals = scopedDeals.filter((deal) => deal.createdAt >= dateFrom && deal.createdAt < dateTo);
    const periodClosedWonDeals = scopedDeals.filter(
      (deal) => deal.status === DealStatus.WON && deal.closedAt && deal.closedAt >= dateFrom && deal.closedAt < dateTo
    );
    const periodClosedLostDeals = scopedDeals.filter(
      (deal) => deal.status === DealStatus.LOST && deal.closedAt && deal.closedAt >= dateFrom && deal.closedAt < dateTo
    );

    const activeDeals = scopedDeals.filter((d) => d.status === DealStatus.OPEN).length;
    const wonValue = scopedDeals
      .filter((d) => d.status === DealStatus.WON && d.closedAt && d.closedAt >= dateFrom && d.closedAt < dateTo)
      .reduce((sum, d) => sum + d.estimatedValue, 0);
    const lostValue = scopedDeals
      .filter((d) => d.status === DealStatus.LOST && d.closedAt && d.closedAt >= dateFrom && d.closedAt < dateTo)
      .reduce((sum, d) => sum + d.estimatedValue, 0);
    const pipelineValue = scopedDeals
      .filter((d) => d.status === DealStatus.OPEN)
      .reduce((sum, d) => sum + d.estimatedValue, 0);
    const visitCompletion =
      periodVisits.length === 0
        ? 0
        : periodVisits.filter((v) => v.status === VisitStatus.CHECKED_OUT).length / periodVisits.length;

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
      acc[user.id] = {
        visits: periodVisits.filter((visit) => visit.repId === user.id && visit.status === VisitStatus.CHECKED_OUT).length,
        newDealValue: periodCreatedDeals
          .filter((deal) => deal.ownerId === user.id)
          .reduce((sum, deal) => sum + deal.estimatedValue, 0),
        revenue: periodClosedWonDeals
          .filter((deal) => deal.ownerId === user.id)
          .reduce((sum, deal) => sum + deal.estimatedValue, 0),
        teamId: user.teamId
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

      const userDeals = scopedDeals.filter((deal) => deal.ownerId === user.id);
      row.activeDeals += userDeals.filter((deal) => deal.status === DealStatus.OPEN).length;
      row.pipelineValue += userDeals.filter((deal) => deal.status === DealStatus.OPEN).reduce((sum, deal) => sum + deal.estimatedValue, 0);
      row.wonValue += userDeals
        .filter((deal) => deal.status === DealStatus.WON && deal.closedAt && deal.closedAt >= dateFrom && deal.closedAt < dateTo)
        .reduce((sum, deal) => sum + deal.estimatedValue, 0);
      row.lostValue += userDeals
        .filter((deal) => deal.status === DealStatus.LOST && deal.closedAt && deal.closedAt >= dateFrom && deal.closedAt < dateTo)
        .reduce((sum, deal) => sum + deal.estimatedValue, 0);

      const userPeriodVisits = periodVisits.filter((visit) => visit.repId === user.id);
      row.plannedVisits += userPeriodVisits.length;
      row.checkedOutVisits += userPeriodVisits.filter((visit) => visit.status === VisitStatus.CHECKED_OUT).length;
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
        dealsCreatedInPeriod: periodCreatedDeals.length,
        visitsPlannedInPeriod: periodVisits.length,
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
      include: { customer: true }
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
          customer: visit.customer.name,
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
