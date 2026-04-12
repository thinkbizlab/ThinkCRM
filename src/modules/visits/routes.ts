import {
  DealStatus,
  EntityType,
  VisitStatus,
  VisitType,
  type Prisma
} from "../../lib/prisma-generated.js";
import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { listVisibleUserIds, requireTenantId, requireUserId } from "../../lib/http.js";
import { writeEntityChangelog } from "../../lib/changelog.js";
import { prisma } from "../../lib/prisma.js";

const ONSITE_MAX_DISTANCE_METERS = 200;
const EARTH_RADIUS_METERS = 6371000;

type VisitWithCustomerRep = Prisma.VisitGetPayload<{
  include: {
    customer: { select: { id: true; name: true } };
    rep: { select: { id: true; fullName: true } };
  };
}>;

type DealCalendarWithRelations = Prisma.DealGetPayload<{
  include: {
    customer: { select: { id: true; name: true } };
    owner: { select: { id: true; fullName: true } };
    stage: { select: { id: true; stageName: true } };
  };
}>;

type DealTodoWithRelations = Prisma.DealGetPayload<{
  include: {
    customer: { select: { id: true; name: true } };
    owner: { select: { id: true; fullName: true } };
  };
}>;

const plannedVisitCreateSchema = z.object({
  customerId: z.string().min(1),
  dealId: z.string().min(1).optional(),
  plannedAt: z.string().datetime(),
  objective: z.string().trim().min(1).optional()
}).strict();

const unplannedVisitCreateSchema = z.object({
  customerId: z.string().min(1),
  dealId: z.string().min(1).optional(),
  plannedAt: z.string().datetime().optional(),
  objective: z.string().trim().min(1).optional()
}).strict();

const checkInSchema = z.object({
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
  selfieUrl: z.string().min(1)
}).strict();

const checkOutSchema = z.object({
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
  result: z.string().trim().min(1)
}).strict();

const calendarQuerySchema = z
  .object({
    view: z.enum(["year", "month", "day"]).optional().default("month"),
    anchorDate: z.string().datetime().optional(),
    dateFrom: z.string().datetime().optional(),
    dateTo: z.string().datetime().optional(),
    eventType: z.enum(["all", "visit", "deal"]).optional().default("all"),
    query: z.string().trim().optional(),
    ownerId: z.string().trim().min(1).optional(),
    customerId: z.string().trim().min(1).optional(),
    visitStatus: z.nativeEnum(VisitStatus).optional(),
    dealStageId: z.string().trim().min(1).optional()
  })
  .strict();

const todoEventsQuerySchema = z
  .object({
    query: z.string().trim().optional(),
    eventType: z.enum(["all", "visit", "deal"]).optional().default("all"),
    status: z.string().trim().min(1).optional(),
    bucket: z.enum(["all", "today", "tomorrow", "next_week", "next_month", "pinned"]).optional().default("all"),
    customerId: z.string().trim().min(1).optional(),
    priority: z.enum(["all", "high", "normal"]).optional().default("all")
  })
  .strict();

type TodoBucketKey = "today" | "tomorrow" | "next_week" | "next_month";

type TodoEventAction = {
  type: "CHECK_IN" | "CHECK_OUT" | "OPEN_DEAL";
  label: string;
  method: "GET" | "POST";
  href: string;
};

type TodoEvent = {
  id: string;
  type: "visit" | "deal";
  entityId: string;
  at: string;
  title: string;
  bucket: TodoBucketKey;
  status: string;
  priority: "high" | "normal";
  customer: {
    id: string;
    name: string;
  };
  owner: {
    id: string;
    name: string;
  };
  nextAction: TodoEventAction;
};

const allowedTransitions: Record<VisitStatus, VisitStatus | null> = {
  PLANNED: VisitStatus.CHECKED_IN,
  CHECKED_IN: VisitStatus.CHECKED_OUT,
  CHECKED_OUT: null
};

function throwInvalidTransition(
  app: Parameters<FastifyPluginAsync>[0],
  currentStatus: VisitStatus,
  targetStatus: VisitStatus
): never {
  const expectedNext = allowedTransitions[currentStatus];
  if (!expectedNext) {
    throw app.httpErrors.badRequest(
      `Visit already reached terminal status ${currentStatus}. Cannot transition to ${targetStatus}.`
    );
  }
  throw app.httpErrors.badRequest(
    `Invalid visit transition ${currentStatus} -> ${targetStatus}. Expected ${currentStatus} -> ${expectedNext}.`
  );
}

function toRadians(value: number): number {
  return (value * Math.PI) / 180;
}

function calculateDistanceMeters(
  lat1: number,
  lng1: number,
  lat2: number,
  lng2: number
): number {
  const dLat = toRadians(lat2 - lat1);
  const dLng = toRadians(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRadians(lat1)) * Math.cos(toRadians(lat2)) * Math.sin(dLng / 2) * Math.sin(dLng / 2);

  return 2 * EARTH_RADIUS_METERS * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function resolveSiteCoordinates(
  addresses: Array<{ latitude: number | null; longitude: number | null; isDefaultShipping: boolean; isDefaultBilling: boolean }>
): { latitude: number; longitude: number } | null {
  const pickable = addresses.filter((address) => address.latitude !== null && address.longitude !== null);
  if (pickable.length === 0) {
    return null;
  }

  const defaultShipping = pickable.find((address) => address.isDefaultShipping);
  if (defaultShipping) {
    return {
      latitude: defaultShipping.latitude as number,
      longitude: defaultShipping.longitude as number
    };
  }

  const defaultBilling = pickable.find((address) => address.isDefaultBilling);
  if (defaultBilling) {
    return {
      latitude: defaultBilling.latitude as number,
      longitude: defaultBilling.longitude as number
    };
  }

  const firstPick = pickable[0];
  if (!firstPick) {
    return null;
  }

  return {
    latitude: firstPick.latitude as number,
    longitude: firstPick.longitude as number
  };
}

function startOfMonth(value: Date): Date {
  return new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), 1, 0, 0, 0, 0));
}

function startOfUtcDay(value: Date): Date {
  return new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate(), 0, 0, 0, 0));
}

function addDays(value: Date, days: number): Date {
  return new Date(value.getTime() + days * 86400000);
}

function resolveTodoBucket(at: Date, now: Date): TodoBucketKey {
  const todayStart = startOfUtcDay(now);
  const tomorrowStart = addDays(todayStart, 1);
  const dayAfterTomorrowStart = addDays(todayStart, 2);
  const nextWeekStart = addDays(todayStart, 8);

  if (at < dayAfterTomorrowStart) {
    return at < tomorrowStart ? "today" : "tomorrow";
  }

  if (at < nextWeekStart) {
    return "next_week";
  }

  return "next_month";
}

function resolveCalendarDateRange(input: {
  view: "year" | "month" | "day";
  anchorDate?: string;
  dateFrom?: string;
  dateTo?: string;
}): { dateFrom: Date; dateTo: Date; anchorDate: Date } {
  if (input.dateFrom || input.dateTo) {
    const dateFrom = input.dateFrom ? new Date(input.dateFrom) : new Date(Date.now() - 7 * 86400000);
    const dateTo = input.dateTo ? new Date(input.dateTo) : new Date(Date.now() + 30 * 86400000);
    return {
      dateFrom,
      dateTo,
      anchorDate: input.anchorDate ? new Date(input.anchorDate) : dateFrom
    };
  }

  const anchorDate = input.anchorDate ? new Date(input.anchorDate) : new Date();
  if (input.view === "day") {
    const dateFrom = new Date(Date.UTC(anchorDate.getUTCFullYear(), anchorDate.getUTCMonth(), anchorDate.getUTCDate(), 0, 0, 0, 0));
    const dateTo = new Date(Date.UTC(anchorDate.getUTCFullYear(), anchorDate.getUTCMonth(), anchorDate.getUTCDate() + 1, 0, 0, 0, 0));
    return { dateFrom, dateTo, anchorDate };
  }

  if (input.view === "year") {
    const dateFrom = new Date(Date.UTC(anchorDate.getUTCFullYear(), 0, 1, 0, 0, 0, 0));
    const dateTo = new Date(Date.UTC(anchorDate.getUTCFullYear() + 1, 0, 1, 0, 0, 0, 0));
    return { dateFrom, dateTo, anchorDate };
  }

  const dateFrom = startOfMonth(anchorDate);
  const dateTo = new Date(Date.UTC(anchorDate.getUTCFullYear(), anchorDate.getUTCMonth() + 1, 1, 0, 0, 0, 0));
  return { dateFrom, dateTo, anchorDate };
}

export const visitRoutes: FastifyPluginAsync = async (app) => {
  async function createVisitRecord(input: {
    tenantId: string;
    repId: string;
    customerId: string;
    dealId?: string;
    objective?: string;
    plannedAt: Date;
    visitType: VisitType;
    changedById: string;
  }) {
    return prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      const customer = await tx.customer.findFirst({
        where: { id: input.customerId, tenantId: input.tenantId },
        select: { id: true }
      });
      if (!customer) {
        throw app.httpErrors.notFound("Customer not found in tenant.");
      }

      if (input.dealId) {
        const deal = await tx.deal.findFirst({
          where: {
            id: input.dealId,
            tenantId: input.tenantId,
            customerId: input.customerId
          },
          select: { id: true }
        });
        if (!deal) {
          throw app.httpErrors.badRequest("Deal must belong to the same tenant and customer.");
        }
      }

      const created = await tx.visit.create({
        data: {
          tenantId: input.tenantId,
          repId: input.repId,
          customerId: input.customerId,
          dealId: input.dealId,
          plannedAt: input.plannedAt,
          objective: input.objective,
          visitType: input.visitType
        }
      });
      await writeEntityChangelog({
        db: tx,
        tenantId: input.tenantId,
        entityType: EntityType.VISIT,
        entityId: created.id,
        action: "CREATE",
        changedById: input.changedById,
        after: created
      });
      return created;
    });
  }

  app.post("/visits/planned", async (request, reply) => {
    const tenantId = requireTenantId(request);
    const repId = requireUserId(request);
    const parsed = plannedVisitCreateSchema.safeParse(request.body);
    if (!parsed.success) {
      throw app.httpErrors.badRequest(parsed.error.message);
    }
    const created = await createVisitRecord({
      tenantId,
      repId,
      customerId: parsed.data.customerId,
      dealId: parsed.data.dealId,
      plannedAt: new Date(parsed.data.plannedAt),
      objective: parsed.data.objective,
      visitType: VisitType.PLANNED,
      changedById: repId
    });
    return reply.code(201).send(created);
  });

  app.post("/visits/unplanned", async (request, reply) => {
    const tenantId = requireTenantId(request);
    const repId = requireUserId(request);
    const parsed = unplannedVisitCreateSchema.safeParse(request.body);
    if (!parsed.success) {
      throw app.httpErrors.badRequest(parsed.error.message);
    }
    const created = await createVisitRecord({
      tenantId,
      repId,
      customerId: parsed.data.customerId,
      dealId: parsed.data.dealId,
      plannedAt: parsed.data.plannedAt ? new Date(parsed.data.plannedAt) : new Date(),
      objective: parsed.data.objective,
      visitType: VisitType.UNPLANNED,
      changedById: repId
    });
    return reply.code(201).send(created);
  });

  app.get("/visits", async (request) => {
    const tenantId = requireTenantId(request);
    const visibleUserIds = await listVisibleUserIds(request);
    const visibleUserIdList = [...visibleUserIds];
    const query = request.query as { status?: VisitStatus; repId?: string };
    if (query.repId && !visibleUserIds.has(query.repId)) {
      throw app.httpErrors.forbidden("Requested rep is outside hierarchy scope.");
    }
    return prisma.visit.findMany({
      where: {
        tenantId,
        status: query.status,
        repId: query.repId ?? { in: visibleUserIdList }
      },
      include: { customer: true, deal: true, rep: true },
      orderBy: { plannedAt: "asc" }
    });
  });

  app.get("/visits/:id", async (request) => {
    const tenantId = requireTenantId(request);
    const visibleUserIds = await listVisibleUserIds(request);
    const params = request.params as { id: string };
    const visit = await prisma.visit.findFirst({
      where: { id: params.id, tenantId, repId: { in: [...visibleUserIds] } },
      include: {
        customer: true,
        rep: { select: { id: true, fullName: true, email: true } },
        deal: {
          include: {
            stage: true
          }
        }
      }
    });
    if (!visit) {
      throw app.httpErrors.notFound("Visit not found.");
    }
    return visit;
  });

  app.get("/visits/:id/preparation-suggestions", async (request) => {
    const tenantId = requireTenantId(request);
    const visibleUserIds = await listVisibleUserIds(request);
    const params = request.params as { id: string };
    const visit = await prisma.visit.findFirst({
      where: { id: params.id, tenantId, repId: { in: [...visibleUserIds] } },
      include: { deal: true, customer: true }
    });
    if (!visit) {
      throw app.httpErrors.notFound("Visit not found.");
    }

    if (!visit.deal) {
      return {
        suggestions: [
          "Review latest customer profile and contact history.",
          "Prepare objective and expected outcome for this visit."
        ]
      };
    }

    return {
      suggestions: [
        `Review deal ${visit.deal.dealNo} (${visit.deal.dealName}) and open issues.`,
        "Prepare quotation comparison and objection handling points.",
        "Confirm follow-up date and next step owner before leaving."
      ]
    };
  });

  app.post("/visits/:id/checkin", async (request) => {
    const tenantId = requireTenantId(request);
    const repId = requireUserId(request);
    const params = request.params as { id: string };
    const parsed = checkInSchema.safeParse(request.body);
    if (!parsed.success) {
      throw app.httpErrors.badRequest(parsed.error.message);
    }

    return prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      const visit = await tx.visit.findFirst({
        where: { id: params.id, tenantId, repId },
        include: {
          customer: {
            include: {
              addresses: {
                select: {
                  latitude: true,
                  longitude: true,
                  isDefaultShipping: true,
                  isDefaultBilling: true
                }
              }
            }
          }
        }
      });
      if (!visit) {
        throw app.httpErrors.notFound("Visit not found.");
      }

      if (visit.status !== VisitStatus.PLANNED) {
        throwInvalidTransition(app, visit.status, VisitStatus.CHECKED_IN);
      }
      const beforeState = {
        status: visit.status,
        checkInAt: visit.checkInAt,
        checkOutAt: visit.checkOutAt
      };

      const openVisit = await tx.visit.findFirst({
        where: {
          tenantId,
          repId,
          status: VisitStatus.CHECKED_IN,
          id: { not: params.id }
        },
        select: { id: true }
      });
      if (openVisit) {
        throw app.httpErrors.conflict("Cannot check in while another visit is pending checkout.");
      }

      const siteCoordinates = resolveSiteCoordinates(visit.customer.addresses);
      if (!siteCoordinates) {
        throw app.httpErrors.badRequest(
          "Customer site coordinates are not configured. Please set latitude/longitude on customer address."
        );
      }

      const distanceMeters = calculateDistanceMeters(
        parsed.data.lat,
        parsed.data.lng,
        siteCoordinates.latitude,
        siteCoordinates.longitude
      );
      if (distanceMeters > ONSITE_MAX_DISTANCE_METERS) {
        throw app.httpErrors.badRequest(
          `Check-in is outside onsite range (${Math.round(distanceMeters)}m > ${ONSITE_MAX_DISTANCE_METERS}m).`
        );
      }

      const transitionResult = await tx.visit.updateMany({
        where: { id: params.id, status: VisitStatus.PLANNED },
        data: {
          status: VisitStatus.CHECKED_IN,
          checkInAt: new Date(),
          checkInLat: parsed.data.lat,
          checkInLng: parsed.data.lng,
          checkInDistanceM: distanceMeters,
          checkInSelfie: parsed.data.selfieUrl
        }
      });

      if (transitionResult.count !== 1) {
        throw app.httpErrors.conflict("Visit state changed during check-in. Refresh and retry.");
      }

      const updated = await tx.visit.findUniqueOrThrow({
        where: { id: params.id }
      });
      await writeEntityChangelog({
        db: tx,
        tenantId,
        entityType: EntityType.VISIT,
        entityId: updated.id,
        action: "UPDATE",
        changedById: repId,
        before: beforeState,
        after: updated,
        context: { workflow: "CHECK_IN" }
      });
      return updated;
    });
  });

  app.post("/visits/:id/checkout", async (request) => {
    const tenantId = requireTenantId(request);
    const repId = requireUserId(request);
    const params = request.params as { id: string };
    const parsed = checkOutSchema.safeParse(request.body);
    if (!parsed.success) {
      throw app.httpErrors.badRequest(parsed.error.message);
    }

    return prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      const visit = await tx.visit.findFirst({
        where: { id: params.id, tenantId, repId }
      });
      if (!visit) {
        throw app.httpErrors.notFound("Visit not found.");
      }
      if (visit.status !== VisitStatus.CHECKED_IN) {
        throwInvalidTransition(app, visit.status, VisitStatus.CHECKED_OUT);
      }
      const beforeState = {
        status: visit.status,
        checkInAt: visit.checkInAt,
        checkOutAt: visit.checkOutAt,
        result: visit.result
      };

      const transitionResult = await tx.visit.updateMany({
        where: { id: params.id, status: VisitStatus.CHECKED_IN },
        data: {
          status: VisitStatus.CHECKED_OUT,
          checkOutAt: new Date(),
          checkOutLat: parsed.data.lat,
          checkOutLng: parsed.data.lng,
          result: parsed.data.result
        }
      });

      if (transitionResult.count !== 1) {
        throw app.httpErrors.conflict("Visit state changed during checkout. Refresh and retry.");
      }

      const updated = await tx.visit.findUniqueOrThrow({
        where: { id: params.id }
      });
      await writeEntityChangelog({
        db: tx,
        tenantId,
        entityType: EntityType.VISIT,
        entityId: updated.id,
        action: "UPDATE",
        changedById: repId,
        before: beforeState,
        after: updated,
        context: { workflow: "CHECK_OUT" }
      });
      return updated;
    });
  });

  app.get("/calendar/events", async (request) => {
    const tenantId = requireTenantId(request);
    const visibleUserIds = await listVisibleUserIds(request);
    const visibleUserIdList = [...visibleUserIds];
    const parsed = calendarQuerySchema.safeParse(request.query ?? {});
    if (!parsed.success) {
      throw app.httpErrors.badRequest(parsed.error.message);
    }

    const query = parsed.data;
    if (query.ownerId && !visibleUserIds.has(query.ownerId)) {
      throw app.httpErrors.forbidden("Requested owner is outside hierarchy scope.");
    }
    const { dateFrom, dateTo, anchorDate } = resolveCalendarDateRange({
      view: query.view,
      anchorDate: query.anchorDate,
      dateFrom: query.dateFrom,
      dateTo: query.dateTo
    });
    const now = new Date();

    const visitPromise =
      query.eventType === "deal"
        ? Promise.resolve([] as VisitWithCustomerRep[])
        : prisma.visit.findMany({
            where: {
              tenantId,
              plannedAt: { gte: dateFrom, lt: dateTo },
              repId: query.ownerId ?? { in: visibleUserIdList },
              customerId: query.customerId,
              status: query.visitStatus
            },
            include: {
              customer: {
                select: { id: true, name: true }
              },
              rep: {
                select: { id: true, fullName: true }
              }
            },
            orderBy: { plannedAt: "asc" }
          });

    const dealPromise =
      query.eventType === "visit"
        ? Promise.resolve([] as DealCalendarWithRelations[])
        : prisma.deal.findMany({
            where: {
              tenantId,
              followUpAt: { gte: dateFrom, lt: dateTo },
              ownerId: query.ownerId ?? { in: visibleUserIdList },
              customerId: query.customerId,
              stageId: query.dealStageId
            },
            include: {
              customer: {
                select: { id: true, name: true }
              },
              owner: {
                select: { id: true, fullName: true }
              },
              stage: {
                select: { id: true, stageName: true }
              }
            },
            orderBy: { followUpAt: "asc" }
          });

    const [visits, deals]: [VisitWithCustomerRep[], DealCalendarWithRelations[]] = await Promise.all([
      visitPromise,
      dealPromise
    ]);
    const queryText = query.query?.toLowerCase();

    const visitEvents = visits
      .map((visit) => {
        const color =
          visit.status === VisitStatus.CHECKED_OUT
            ? "green"
            : visit.status === VisitStatus.CHECKED_IN
              ? "yellow"
              : visit.plannedAt < now
                ? "red"
                : "blue";

        return {
          id: `visit:${visit.id}`,
          entityId: visit.id,
          type: "visit" as const,
          color,
          eventTypeColor: "blue",
          at: visit.plannedAt.toISOString(),
          title: `Visit: ${visit.customer.name}`,
          status: visit.status,
          owner: { id: visit.rep.id, name: visit.rep.fullName },
          customer: { id: visit.customer.id, name: visit.customer.name }
        };
      })
      .filter((event) => {
        if (!queryText) return true;
        return (
          event.title.toLowerCase().includes(queryText) ||
          event.customer.name.toLowerCase().includes(queryText) ||
          event.owner.name.toLowerCase().includes(queryText)
        );
      });

    const dealEvents = deals
      .map((deal) => {
        const isRed =
          deal.followUpAt < now || (deal.closedAt && deal.followUpAt > deal.closedAt) || (deal.closedAt && deal.closedAt < now);

        return {
          id: `deal:${deal.id}`,
          entityId: deal.id,
          type: "deal" as const,
          color: isRed ? "red" : "purple",
          eventTypeColor: "purple",
          at: deal.followUpAt.toISOString(),
          title: `Deal: ${deal.dealName}`,
          status: deal.status,
          stage: { id: deal.stage.id, name: deal.stage.stageName },
          owner: { id: deal.owner.id, name: deal.owner.fullName },
          customer: { id: deal.customer.id, name: deal.customer.name }
        };
      })
      .filter((event) => {
        if (!queryText) return true;
        return (
          event.title.toLowerCase().includes(queryText) ||
          event.customer.name.toLowerCase().includes(queryText) ||
          event.owner.name.toLowerCase().includes(queryText) ||
          event.stage.name.toLowerCase().includes(queryText)
        );
      });

    const events = [...visitEvents, ...dealEvents].sort((a, b) => +new Date(a.at) - +new Date(b.at));

    return {
      view: query.view,
      anchorDate: anchorDate.toISOString(),
      dateFrom: dateFrom.toISOString(),
      dateTo: dateTo.toISOString(),
      filters: {
        eventType: query.eventType,
        ownerId: query.ownerId ?? null,
        customerId: query.customerId ?? null,
        visitStatus: query.visitStatus ?? null,
        dealStageId: query.dealStageId ?? null,
        query: query.query ?? ""
      },
      legend: {
        eventType: {
          visit: "blue",
          deal: "purple"
        },
        status: {
          green: "Visit checked-in and checked-out",
          yellow: "Visit checked-in but not checked-out",
          red: "Overdue or invalid schedule state",
          blue: "Future planned visit",
          purple: "Upcoming deal follow-up"
        }
      },
      counts: {
        total: events.length,
        visit: visitEvents.length,
        deal: dealEvents.length
      },
      events
    };
  });

  app.get("/todo/events", async (request) => {
    const tenantId = requireTenantId(request);
    const userId = requireUserId(request);
    const parsed = todoEventsQuerySchema.safeParse(request.query ?? {});
    if (!parsed.success) {
      throw app.httpErrors.badRequest(parsed.error.message);
    }

    const query = parsed.data;
    const now = new Date();
    const startToday = startOfUtcDay(now);
    const endNextMonth = addDays(startToday, 31);
    const queryText = query.query?.toLowerCase();

    const [visits, deals]: [VisitWithCustomerRep[], DealTodoWithRelations[]] = await Promise.all([
      query.eventType === "deal"
        ? Promise.resolve([] as VisitWithCustomerRep[])
        : prisma.visit.findMany({
            where: {
              tenantId,
              repId: userId,
              status: { in: [VisitStatus.PLANNED, VisitStatus.CHECKED_IN] },
              OR: [
                { status: VisitStatus.CHECKED_IN },
                { plannedAt: { gte: startToday, lt: endNextMonth } }
              ],
              customerId: query.customerId
            },
            include: {
              customer: {
                select: { id: true, name: true }
              },
              rep: {
                select: { id: true, fullName: true }
              }
            },
            orderBy: { plannedAt: "asc" }
          }),
      query.eventType === "visit"
        ? Promise.resolve([] as DealTodoWithRelations[])
        : prisma.deal.findMany({
            where: {
              tenantId,
              ownerId: userId,
              status: DealStatus.OPEN,
              followUpAt: { gte: startToday, lt: endNextMonth },
              customerId: query.customerId
            },
            include: {
              customer: {
                select: { id: true, name: true }
              },
              owner: {
                select: { id: true, fullName: true }
              }
            },
            orderBy: { followUpAt: "asc" }
          })
    ]);

    const todoVisitEvents: Array<TodoEvent & { isPinned: boolean }> = visits.map((visit) => {
      const isPinned = visit.status === VisitStatus.CHECKED_IN;
      return {
        id: `visit:${visit.id}`,
        type: "visit",
        entityId: visit.id,
        at: visit.plannedAt.toISOString(),
        title: `Visit: ${visit.customer.name}`,
        bucket: resolveTodoBucket(visit.plannedAt, now),
        status: visit.status,
        priority: isPinned || visit.plannedAt < now ? "high" : "normal",
        customer: { id: visit.customer.id, name: visit.customer.name },
        owner: { id: visit.rep.id, name: visit.rep.fullName },
        nextAction: isPinned
          ? {
              type: "CHECK_OUT",
              label: "Check-out",
              method: "POST",
              href: `/api/v1/visits/${visit.id}/checkout`
            }
          : {
              type: "CHECK_IN",
              label: "Check-in",
              method: "POST",
              href: `/api/v1/visits/${visit.id}/checkin`
            },
        isPinned
      };
    });

    const todoDealEvents: Array<TodoEvent & { isPinned: boolean }> = deals.map((deal) => ({
      id: `deal:${deal.id}`,
      type: "deal",
      entityId: deal.id,
      at: deal.followUpAt.toISOString(),
      title: `Deal follow-up: ${deal.dealName}`,
      bucket: resolveTodoBucket(deal.followUpAt, now),
      status: deal.status,
      priority: deal.followUpAt < now ? "high" : "normal",
      customer: { id: deal.customer.id, name: deal.customer.name },
      owner: { id: deal.owner.id, name: deal.owner.fullName },
      nextAction: {
        type: "OPEN_DEAL",
        label: "Open deal",
        method: "GET",
        href: `/api/v1/deals/${deal.id}`
      },
      isPinned: false
    }));

    const events = [...todoVisitEvents, ...todoDealEvents].filter((event) => {
      if (query.status && event.status.toLowerCase() !== query.status.toLowerCase()) {
        return false;
      }
      if (query.priority !== "all" && event.priority !== query.priority) {
        return false;
      }
      if (!queryText) {
        return true;
      }
      return (
        event.title.toLowerCase().includes(queryText) ||
        event.customer.name.toLowerCase().includes(queryText) ||
        event.owner.name.toLowerCase().includes(queryText)
      );
    });

    const pinned = events
      .filter((event) => event.isPinned)
      .sort((a, b) => +new Date(a.at) - +new Date(b.at))
      .map(({ isPinned: _, ...event }) => event);

    const grouped: Record<TodoBucketKey, TodoEvent[]> = {
      today: [],
      tomorrow: [],
      next_week: [],
      next_month: []
    };

    for (const event of events) {
      if (event.isPinned) {
        continue;
      }
      const { isPinned: _, ...normalized } = event;
      grouped[event.bucket].push(normalized);
    }

    if (query.bucket !== "all") {
      if (query.bucket === "pinned") {
        grouped.today = [];
        grouped.tomorrow = [];
        grouped.next_week = [];
        grouped.next_month = [];
      } else {
        for (const key of Object.keys(grouped) as TodoBucketKey[]) {
          if (key !== query.bucket) {
            grouped[key] = [];
          }
        }
      }
    }

    const allBucketEvents = [...grouped.today, ...grouped.tomorrow, ...grouped.next_week, ...grouped.next_month];
    return {
      generatedAt: now.toISOString(),
      pinned: {
        checkedInWaitingCheckout: query.bucket === "pinned" || query.bucket === "all" ? pinned : []
      },
      buckets: grouped,
      counts: {
        pinned: query.bucket === "pinned" || query.bucket === "all" ? pinned.length : 0,
        today: grouped.today.length,
        tomorrow: grouped.tomorrow.length,
        next_week: grouped.next_week.length,
        next_month: grouped.next_month.length,
        total: (query.bucket === "pinned" || query.bucket === "all" ? pinned.length : 0) + allBucketEvents.length
      },
      filters: {
        query: query.query ?? "",
        eventType: query.eventType,
        status: query.status ?? null,
        bucket: query.bucket,
        customerId: query.customerId ?? null,
        priority: query.priority
      }
    };
  });
};
