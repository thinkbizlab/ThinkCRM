import {
  DealStatus,
  EntityType,
  VisitStatus,
  VisitType,
  type Prisma
} from "../../lib/prisma-generated.js";
import { ChannelType, IntegrationPlatform, SourceStatus } from "@prisma/client";
import type { FastifyPluginAsync } from "fastify";
import { config } from "../../config.js";
import { z } from "zod";
import { listVisibleUserIds, requireTenantId, requireUserId, zodMsg } from "../../lib/http.js";
import { writeEntityChangelog } from "../../lib/changelog.js";
import { prisma } from "../../lib/prisma.js";
import { decryptCredential } from "../../lib/secrets.js";
import { getTenantUrl } from "../../lib/tenant-url.js";
import { smtpPort } from "../../lib/smtp-port.js";
import { uploadBufferToR2, buildR2PublicUrl, createR2PresignedDownload } from "../../lib/r2-storage.js";
import { formatThaiDateTime, googleMapsLink, formatDuration } from "../../lib/line-notify.js";

const DEFAULT_CHECKIN_MAX_DISTANCE_M = 1_000; // fallback when tenant has no visit config
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
    stage: { select: { id: true; stageName: true } };
  };
}>;

const plannedVisitCreateSchema = z.object({
  customerId: z.string().min(1),
  dealId: z.string().min(1).optional(),
  plannedAt: z.string().datetime(),
  objective: z.string().trim().min(1),
  siteLat: z.number().min(-90).max(90).optional(),
  siteLng: z.number().min(-180).max(180).optional()
}).strict();

const unplannedVisitCreateSchema = z.object({
  customerId: z.string().min(1),
  dealId: z.string().min(1).optional(),
  plannedAt: z.string().datetime().optional(),
  objective: z.string().trim().min(1).optional(),
  siteLat: z.number().min(-90).max(90).optional(),
  siteLng: z.number().min(-180).max(180).optional()
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

const commaArray = (inner: z.ZodTypeAny) =>
  z.preprocess(
    (v) => (typeof v === "string" ? v.split(",").filter(Boolean) : Array.isArray(v) ? v : []),
    z.array(inner).default([])
  );

const calendarQuerySchema = z
  .object({
    view: z.enum(["year", "month", "day"]).optional().default("month"),
    anchorDate: z.string().datetime().optional(),
    dateFrom: z.string().datetime().optional(),
    dateTo: z.string().datetime().optional(),
    eventTypes: commaArray(z.enum(["visit", "deal"])),
    query: z.string().trim().optional(),
    ownerIds: commaArray(z.string().trim().min(1)),
    customerId: z.string().trim().min(1).optional(),
    visitStatuses: commaArray(z.nativeEnum(VisitStatus)),
    dealStageIds: commaArray(z.string().trim().min(1)),
    dealStatuses: commaArray(z.enum(["OPEN", "WON", "LOST"]))
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

type TodoBucketKey = "overdue" | "today" | "tomorrow" | "next_week" | "next_month";

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
  if (at < todayStart) return "overdue";

  const tomorrowStart = addDays(todayStart, 1);
  const dayAfterTomorrowStart = addDays(todayStart, 2);
  const nextWeekStart = addDays(todayStart, 8);

  if (at < dayAfterTomorrowStart) {
    return at < tomorrowStart ? "today" : "tomorrow";
  }

  if (at < nextWeekStart) return "next_week";
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
    siteLat?: number;
    siteLng?: number;
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

      const visitCount = await tx.visit.count({ where: { tenantId: input.tenantId } });
      const visitNo = `V-${String(visitCount + 1).padStart(6, "0")}`;
      const created = await tx.visit.create({
        data: {
          tenantId: input.tenantId,
          repId: input.repId,
          customerId: input.customerId,
          dealId: input.dealId,
          visitNo,
          plannedAt: input.plannedAt,
          objective: input.objective,
          visitType: input.visitType,
          siteLat: input.siteLat,
          siteLng: input.siteLng
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
      throw app.httpErrors.badRequest(zodMsg(parsed.error));
    }
    const created = await createVisitRecord({
      tenantId,
      repId,
      customerId: parsed.data.customerId,
      dealId: parsed.data.dealId,
      plannedAt: new Date(parsed.data.plannedAt),
      objective: parsed.data.objective,
      visitType: VisitType.PLANNED,
      changedById: repId,
      siteLat: parsed.data.siteLat,
      siteLng: parsed.data.siteLng
    });
    return reply.code(201).send(created);
  });

  app.post("/visits/unplanned", async (request, reply) => {
    const tenantId = requireTenantId(request);
    const repId = requireUserId(request);
    const parsed = unplannedVisitCreateSchema.safeParse(request.body);
    if (!parsed.success) {
      throw app.httpErrors.badRequest(zodMsg(parsed.error));
    }
    const created = await createVisitRecord({
      tenantId,
      repId,
      customerId: parsed.data.customerId,
      dealId: parsed.data.dealId,
      plannedAt: parsed.data.plannedAt ? new Date(parsed.data.plannedAt) : new Date(),
      objective: parsed.data.objective,
      visitType: VisitType.UNPLANNED,
      changedById: repId,
      siteLat: parsed.data.siteLat,
      siteLng: parsed.data.siteLng
    });
    return reply.code(201).send(created);
  });

  app.get("/visits", async (request) => {
    const tenantId = requireTenantId(request);
    const visibleUserIds = await listVisibleUserIds(request);
    const visibleUserIdList = [...visibleUserIds];
    const query = request.query as {
      status?: VisitStatus;
      repId?: string;
      repIds?: string;
      dateFrom?: string;
      dateTo?: string;
      customerId?: string;
      dealId?: string;
    };

    // Multi-rep support: repIds=id1,id2 takes precedence over legacy repId
    const repIdList: string[] = query.repIds
      ? query.repIds.split(",").filter(Boolean)
      : query.repId
        ? [query.repId]
        : [];

    for (const id of repIdList) {
      if (!visibleUserIds.has(id)) {
        throw app.httpErrors.forbidden("Requested rep is outside hierarchy scope.");
      }
    }

    return prisma.visit.findMany({
      where: {
        tenantId,
        status: query.status,
        repId: repIdList.length > 0 ? { in: repIdList } : { in: visibleUserIdList },
        plannedAt: {
          ...(query.dateFrom ? { gte: new Date(query.dateFrom) } : {}),
          ...(query.dateTo   ? { lte: new Date(query.dateTo)   } : {})
        },
        ...(query.customerId ? { customerId: query.customerId } : {}),
        ...(query.dealId     ? { dealId: query.dealId }         : {})
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
        customer: {
          include: {
            addresses: {
              select: {
                addressLine1: true,
                district: true,
                province: true,
                country: true,
                isDefaultShipping: true,
                isDefaultBilling: true
              },
              orderBy: [{ isDefaultShipping: "desc" }, { isDefaultBilling: "desc" }]
            }
          }
        },
        rep: { select: { id: true, fullName: true, email: true, avatarUrl: true } },
        deal: { include: { stage: true } }
      }
    });
    if (!visit) {
      throw app.httpErrors.notFound("Visit not found.");
    }

    const voiceNotes = await prisma.voiceNoteJob.findMany({
      where: {
        tenantId,
        entityType: "VISIT",
        entityId: params.id,
        transcript: { confirmedAt: { not: null } }
      },
      include: { transcript: { select: { summaryText: true, confirmedAt: true } } },
      orderBy: { createdAt: "desc" }
    });

    return { ...visit, voiceNotes };
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
      throw app.httpErrors.badRequest(zodMsg(parsed.error));
    }

    // Upload selfie to R2 before the transaction (avoids holding a TX open during I/O).
    let selfieStorageRef = parsed.data.selfieUrl;
    if (parsed.data.selfieUrl.startsWith("data:image/")) {
      try {
        const commaIdx = parsed.data.selfieUrl.indexOf(",");
        const header = parsed.data.selfieUrl.slice(0, commaIdx);
        const base64Data = parsed.data.selfieUrl.slice(commaIdx + 1);
        const mimeMatch = header.match(/data:(image\/[a-zA-Z+]+);base64/);
        const contentType = mimeMatch?.[1] ?? "image/jpeg";
        const ext = contentType.split("/")[1]?.replace("jpeg", "jpg") ?? "jpg";
        const imageBuffer = Buffer.from(base64Data, "base64");
        const tenant = await prisma.tenant.findUnique({ where: { id: tenantId }, select: { slug: true } });
        if (tenant?.slug) {
          const stored = await uploadBufferToR2({
            tenantSlug: tenant.slug,
            objectKeyOrRef: `visits/${params.id}/selfie-${Date.now()}.${ext}`,
            contentType,
            data: imageBuffer
          });
          selfieStorageRef = stored.objectRef;
        }
      } catch (err) {
        app.log.error({ err }, "selfie R2 upload failed — storing raw ref");
      }
    }

    const checkedIn = await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      const visit = await tx.visit.findFirst({
        where: { id: params.id, tenantId, repId }
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

      // Only validate distance when the visit has a planned location.
      // If no location was set (open meeting, coffee shop, etc.) check-in is unrestricted.
      let distanceMeters: number | null = null;
      if (visit.siteLat !== null && visit.siteLng !== null) {
        const visitConfig = await tx.tenantVisitConfig.findUnique({
          where: { tenantId },
          select: { checkInMaxDistanceM: true }
        });
        const maxDistanceM = visitConfig?.checkInMaxDistanceM ?? DEFAULT_CHECKIN_MAX_DISTANCE_M;

        distanceMeters = calculateDistanceMeters(
          parsed.data.lat,
          parsed.data.lng,
          visit.siteLat,
          visit.siteLng
        );
        if (distanceMeters > maxDistanceM) {
          throw app.httpErrors.badRequest(
            `Check-in is outside onsite range (${Math.round(distanceMeters)}m > ${maxDistanceM}m).`
          );
        }
      }

      const transitionResult = await tx.visit.updateMany({
        where: { id: params.id, status: VisitStatus.PLANNED },
        data: {
          status: VisitStatus.CHECKED_IN,
          checkInAt: new Date(),
          checkInLat: parsed.data.lat,
          checkInLng: parsed.data.lng,
          checkInDistanceM: distanceMeters,
          checkInSelfie: selfieStorageRef
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

    // After transaction: send group notifications (LINE + MS Teams + Email) for check-in.
    const notifWarnings: string[] = [];
    try {
      const [rep, lineCredential, emailCredential, branding] = await Promise.all([
        prisma.user.findUnique({
          where: { id: repId },
          select: { teamId: true, fullName: true }
        }),
        prisma.tenantIntegrationCredential.findUnique({
          where: { tenantId_platform: { tenantId, platform: IntegrationPlatform.LINE } },
          select: { apiKeyRef: true, status: true }
        }).then(r => decryptCredential(r)),
        prisma.tenantIntegrationCredential.findUnique({
          where: { tenantId_platform: { tenantId, platform: IntegrationPlatform.EMAIL } },
          select: { clientIdRef: true, clientSecretRef: true, apiKeyRef: true, webhookTokenRef: true, status: true }
        }).then(r => decryptCredential(r)),
        prisma.tenantBranding.findUnique({
          where: { tenantId },
          select: { appName: true }
        })
      ]);

      if (rep?.teamId != null) {
        const allChannels = await prisma.teamNotificationChannel.findMany({
          where: { tenantId, teamId: rep.teamId, isEnabled: true,
            channelType: { in: [ChannelType.LINE, ChannelType.MS_TEAMS, ChannelType.EMAIL] } },
          select: { channelType: true, channelTarget: true }
        });

        const lineChannels  = allChannels.filter(c => c.channelType === ChannelType.LINE);
        const teamsChannels = allChannels.filter(c => c.channelType === ChannelType.MS_TEAMS);
        const emailChannels = allChannels.filter(c => c.channelType === ChannelType.EMAIL);

        if (lineChannels.length > 0 || teamsChannels.length > 0 || emailChannels.length > 0) {
          const visitWithCustomer = await prisma.visit.findUnique({
            where: { id: checkedIn.id },
            select: { customer: { select: { name: true } } }
          });

          // Resolve selfie: get a public HTTPS URL LINE can fetch
          let selfieHttpUrl: string | null = null;
          const rawSelfie = checkedIn.checkInSelfie;
          if (rawSelfie?.startsWith("r2://")) {
            selfieHttpUrl = buildR2PublicUrl(rawSelfie);
            if (!selfieHttpUrl) {
              try {
                const tenant = await prisma.tenant.findUnique({ where: { id: tenantId }, select: { slug: true } });
                if (tenant?.slug) {
                  const dl = await createR2PresignedDownload({ tenantSlug: tenant.slug, objectKeyOrRef: rawSelfie, expiresInSeconds: 300 });
                  selfieHttpUrl = dl.downloadUrl;
                }
              } catch { /* skip image */ }
            }
          } else if (rawSelfie?.startsWith("https://")) {
            selfieHttpUrl = rawSelfie;
          }

          const { sendLinePush, buildCheckInMessages } = await import("../../lib/line-notify.js");
          const msgs = buildCheckInMessages({
            appName: branding?.appName || "CRM",
            visitNo: checkedIn.visitNo ?? "",
            repName: rep.fullName || "Sales Rep",
            customerName: visitWithCustomer?.customer?.name || "—",
            checkInAt: checkedIn.checkInAt ?? new Date(),
            objective: checkedIn.objective ?? null,
            lat: checkedIn.checkInLat ?? parsed.data.lat,
            lng: checkedIn.checkInLng ?? parsed.data.lng,
            selfieUrl: selfieHttpUrl
          });

          if (lineChannels.length > 0) {
            if (lineCredential?.status !== SourceStatus.ENABLED) {
              // LINE integration disabled — skip silently
            } else if (!lineCredential.apiKeyRef) {
              app.log.warn("[LINE check-in] Integration enabled but no access token configured.");
              notifWarnings.push("LINE");
            } else {
              const sends = await Promise.allSettled(
                lineChannels.map(ch => sendLinePush(lineCredential.apiKeyRef!, ch.channelTarget, msgs))
              );
              for (const s of sends) {
                if (s.status === "rejected") app.log.warn({ err: s.reason }, "[LINE check-in] push rejected");
                else if (!s.value.ok) app.log.warn(`[LINE check-in] push failed: ${s.value.message}`);
              }
              if (sends.some(s => s.status === "rejected" || (s.status === "fulfilled" && !s.value.ok))) notifWarnings.push("LINE");
            }
          }

          if (teamsChannels.length > 0) {
            const { sendTeamsCard } = await import("../../lib/teams-notify.js");
            const appName = branding?.appName || "CRM";
            const checkInAt = checkedIn.checkInAt ?? new Date();
            const facts = [
              { title: "Visit ID",    value: checkedIn.visitNo ?? "—" },
              { title: "Sales Rep",   value: rep.fullName || "—" },
              { title: "Customer",    value: visitWithCustomer?.customer?.name || "—" },
              { title: "Check-In",    value: formatThaiDateTime(checkInAt) },
              { title: "Objective",   value: checkedIn.objective?.trim() || "—" },
              { title: "Location",    value: `[Open in Maps](${googleMapsLink(checkedIn.checkInLat ?? parsed.data.lat, checkedIn.checkInLng ?? parsed.data.lng)})` }
            ];
            const sends = await Promise.allSettled(
              teamsChannels.map(ch => sendTeamsCard(ch.channelTarget, {
                title: "📍 Check-In Notification",
                accentColor: "accent",
                facts,
                footer: `[${appName}]`
              }))
            );
            if (sends.some(s => s.status === "rejected" || (s.status === "fulfilled" && !s.value.ok))) notifWarnings.push("MS_TEAMS");
          }

          if (emailChannels.length > 0) {
            if (emailCredential?.status !== SourceStatus.ENABLED) {
              // Email integration disabled — skip silently
            } else if (!emailCredential.clientIdRef || !emailCredential.apiKeyRef || !emailCredential.webhookTokenRef) {
              notifWarnings.push("EMAIL");
            } else {
              const { sendEmailCard } = await import("../../lib/email-notify.js");
              const appName = branding?.appName || "CRM";
              const checkInAt = checkedIn.checkInAt ?? new Date();
              const emailConfig = {
                host: emailCredential.clientIdRef,
                port: smtpPort(emailCredential.clientSecretRef),
                fromAddress: emailCredential.webhookTokenRef,
                password: emailCredential.apiKeyRef
              };
              const tenantBaseUrl = await getTenantUrl(tenantId).catch(() => config.APP_URL ?? "");
              const facts = [
                { label: "Visit ID",  value: checkedIn.visitNo ?? "—" },
                { label: "Sales Rep", value: rep.fullName || "—" },
                { label: "Customer",  value: visitWithCustomer?.customer?.name || "—" },
                { label: "Check-In",  value: formatThaiDateTime(checkInAt) },
                { label: "Objective", value: checkedIn.objective?.trim() || "—" },
                { label: "Location",  value: googleMapsLink(checkedIn.checkInLat ?? parsed.data.lat, checkedIn.checkInLng ?? parsed.data.lng) }
              ];
              const sends = await Promise.allSettled(
                emailChannels.map(ch => sendEmailCard(emailConfig, ch.channelTarget, {
                  subject: `📍 Check-In Notification — ${visitWithCustomer?.customer?.name || "Visit"}`,
                  title: "📍 Check-In Notification",
                  facts,
                  detailUrl: `${tenantBaseUrl}/visits`,
                  footer: `[${appName}]`
                }))
              );
              if (sends.some(s => s.status === "rejected" || (s.status === "fulfilled" && !s.value.ok))) notifWarnings.push("EMAIL");
            }
          }
        }
      }
    } catch (err) {
      app.log.error({ err }, "check-in notification failed");
    }

    return { visit: checkedIn, notifWarnings };
  });

  app.post("/visits/:id/checkout", async (request) => {
    const tenantId = requireTenantId(request);
    const repId = requireUserId(request);
    const params = request.params as { id: string };
    const parsed = checkOutSchema.safeParse(request.body);
    if (!parsed.success) {
      throw app.httpErrors.badRequest(zodMsg(parsed.error));
    }

    const updated = await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
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

      const result = await tx.visit.findUniqueOrThrow({
        where: { id: params.id }
      });
      await writeEntityChangelog({
        db: tx,
        tenantId,
        entityType: EntityType.VISIT,
        entityId: result.id,
        action: "UPDATE",
        changedById: repId,
        before: beforeState,
        after: result,
        context: { workflow: "CHECK_OUT" }
      });
      return result;
    });

    // After transaction: send group notifications (LINE + MS Teams + Email) for checkout.
    const notifWarnings: string[] = [];
    try {
      const [rep, lineCredential, emailCredential, branding] = await Promise.all([
        prisma.user.findUnique({
          where: { id: repId },
          select: { teamId: true, fullName: true }
        }),
        prisma.tenantIntegrationCredential.findUnique({
          where: { tenantId_platform: { tenantId, platform: IntegrationPlatform.LINE } },
          select: { apiKeyRef: true, status: true }
        }).then(r => decryptCredential(r)),
        prisma.tenantIntegrationCredential.findUnique({
          where: { tenantId_platform: { tenantId, platform: IntegrationPlatform.EMAIL } },
          select: { clientIdRef: true, clientSecretRef: true, apiKeyRef: true, webhookTokenRef: true, status: true }
        }).then(r => decryptCredential(r)),
        prisma.tenantBranding.findUnique({
          where: { tenantId },
          select: { appName: true }
        })
      ]);

      if (rep?.teamId != null) {
        const allChannels = await prisma.teamNotificationChannel.findMany({
          where: { tenantId, teamId: rep.teamId, isEnabled: true,
            channelType: { in: [ChannelType.LINE, ChannelType.MS_TEAMS, ChannelType.EMAIL] } },
          select: { channelType: true, channelTarget: true }
        });

        const lineChannels  = allChannels.filter(c => c.channelType === ChannelType.LINE);
        const teamsChannels = allChannels.filter(c => c.channelType === ChannelType.MS_TEAMS);
        const emailChannels = allChannels.filter(c => c.channelType === ChannelType.EMAIL);

        if (lineChannels.length > 0 || teamsChannels.length > 0 || emailChannels.length > 0) {
          const visitWithCustomer = await prisma.visit.findUnique({
            where: { id: updated.id },
            select: { customer: { select: { name: true } } }
          });
          const { sendLinePush, buildCheckOutMessages } = await import("../../lib/line-notify.js");
          const msgs = buildCheckOutMessages({
            appName: branding?.appName || "CRM",
            visitNo: updated.visitNo ?? "",
            repName: rep.fullName || "Sales Rep",
            customerName: visitWithCustomer?.customer?.name || "—",
            checkInAt: updated.checkInAt,
            checkOutAt: updated.checkOutAt ?? new Date(),
            result: updated.result,
            lat: updated.checkOutLat ?? parsed.data.lat,
            lng: updated.checkOutLng ?? parsed.data.lng
          });
          if (lineChannels.length > 0) {
            if (lineCredential?.status !== SourceStatus.ENABLED) {
              // LINE integration disabled — skip silently
            } else if (!lineCredential.apiKeyRef) {
              app.log.warn("[LINE checkout] Integration enabled but no access token configured.");
              notifWarnings.push("LINE");
            } else {
              const sends = await Promise.allSettled(
                lineChannels.map(ch => sendLinePush(lineCredential.apiKeyRef!, ch.channelTarget, msgs))
              );
              for (const s of sends) {
                if (s.status === "rejected") app.log.warn({ err: s.reason }, "[LINE checkout] push rejected");
                else if (!s.value.ok) app.log.warn(`[LINE checkout] push failed: ${s.value.message}`);
              }
              if (sends.some(s => s.status === "rejected" || (s.status === "fulfilled" && !s.value.ok))) notifWarnings.push("LINE");
            }
          }

          if (teamsChannels.length > 0) {
            const { sendTeamsCard } = await import("../../lib/teams-notify.js");
            const appName = branding?.appName || "CRM";
            const checkOutAt = updated.checkOutAt ?? new Date();
            const duration = updated.checkInAt ? formatDuration(updated.checkInAt, checkOutAt) : "—";
            const facts = [
              { title: "Visit ID",    value: updated.visitNo ?? "—" },
              { title: "Sales Rep",   value: rep.fullName || "—" },
              { title: "Customer",    value: visitWithCustomer?.customer?.name || "—" },
              { title: "Check-Out",   value: formatThaiDateTime(checkOutAt) },
              { title: "Duration",    value: duration },
              { title: "Result",      value: updated.result?.trim() || "—" },
              { title: "Location",    value: `[Open in Maps](${googleMapsLink(updated.checkOutLat ?? parsed.data.lat, updated.checkOutLng ?? parsed.data.lng)})` }
            ];
            const sends = await Promise.allSettled(
              teamsChannels.map(ch => sendTeamsCard(ch.channelTarget, {
                title: "✅ Check-Out Notification",
                accentColor: "good",
                facts,
                footer: `[${appName}]`
              }))
            );
            if (sends.some(s => s.status === "rejected" || (s.status === "fulfilled" && !s.value.ok))) notifWarnings.push("MS_TEAMS");
          }

          if (emailChannels.length > 0) {
            if (emailCredential?.status !== SourceStatus.ENABLED) {
              // Email integration disabled — skip silently
            } else if (!emailCredential.clientIdRef || !emailCredential.apiKeyRef || !emailCredential.webhookTokenRef) {
              notifWarnings.push("EMAIL");
            } else {
              const { sendEmailCard } = await import("../../lib/email-notify.js");
              const appName = branding?.appName || "CRM";
              const checkOutAt = updated.checkOutAt ?? new Date();
              const duration = updated.checkInAt ? formatDuration(updated.checkInAt, checkOutAt) : "—";
              const emailConfig = {
                host: emailCredential.clientIdRef,
                port: smtpPort(emailCredential.clientSecretRef),
                fromAddress: emailCredential.webhookTokenRef,
                password: emailCredential.apiKeyRef
              };
              const tenantBaseUrl2 = await getTenantUrl(tenantId).catch(() => config.APP_URL ?? "");
              const facts = [
                { label: "Visit ID",  value: updated.visitNo ?? "—" },
                { label: "Sales Rep", value: rep.fullName || "—" },
                { label: "Customer",  value: visitWithCustomer?.customer?.name || "—" },
                { label: "Check-Out", value: formatThaiDateTime(checkOutAt) },
                { label: "Duration",  value: duration },
                { label: "Result",    value: updated.result?.trim() || "—" },
                { label: "Location",  value: googleMapsLink(updated.checkOutLat ?? parsed.data.lat, updated.checkOutLng ?? parsed.data.lng) }
              ];
              const sends = await Promise.allSettled(
                emailChannels.map(ch => sendEmailCard(emailConfig, ch.channelTarget, {
                  subject: `✅ Check-Out Notification — ${visitWithCustomer?.customer?.name || "Visit"}`,
                  title: "✅ Check-Out Notification",
                  facts,
                  detailUrl: `${tenantBaseUrl2}/visits`,
                  footer: `[${appName}]`
                }))
              );
              if (sends.some(s => s.status === "rejected" || (s.status === "fulfilled" && !s.value.ok))) notifWarnings.push("EMAIL");
            }
          }
        }
      }
    } catch (err) {
      app.log.error({ err }, "checkout notification failed");
    }

    return { visit: updated, notifWarnings };
  });

  const visitUpdateSchema = z
    .object({
      plannedAt: z.string().datetime().optional(),
      objective: z.string().trim().min(1).optional(),
      siteLat: z.number().min(-90).max(90).nullable().optional(),
      siteLng: z.number().min(-180).max(180).nullable().optional()
    })
    .strict()
    .refine((data) => Object.keys(data).length > 0, "At least one field is required.");

  app.patch("/visits/:id", async (request) => {
    const tenantId = requireTenantId(request);
    const repId = requireUserId(request);
    const params = request.params as { id: string };
    const parsed = visitUpdateSchema.safeParse(request.body);
    if (!parsed.success) {
      throw app.httpErrors.badRequest(zodMsg(parsed.error));
    }

    const visit = await prisma.visit.findFirst({
      where: { id: params.id, tenantId, repId }
    });
    if (!visit) {
      throw app.httpErrors.notFound("Visit not found.");
    }
    if (visit.status !== VisitStatus.PLANNED) {
      throw app.httpErrors.badRequest("Only planned visits can be edited.");
    }

    const beforeState = { plannedAt: visit.plannedAt, objective: visit.objective, siteLat: visit.siteLat, siteLng: visit.siteLng };

    const updated = await prisma.visit.update({
      where: { id: params.id },
      data: {
        ...(parsed.data.plannedAt !== undefined && { plannedAt: new Date(parsed.data.plannedAt) }),
        ...(parsed.data.objective !== undefined && { objective: parsed.data.objective }),
        ...(parsed.data.siteLat !== undefined && { siteLat: parsed.data.siteLat }),
        ...(parsed.data.siteLng !== undefined && { siteLng: parsed.data.siteLng })
      }
    });

    await writeEntityChangelog({
      db: prisma,
      tenantId,
      entityType: EntityType.VISIT,
      entityId: updated.id,
      action: "UPDATE",
      changedById: repId,
      before: beforeState,
      after: { plannedAt: updated.plannedAt, objective: updated.objective, siteLat: updated.siteLat, siteLng: updated.siteLng },
      context: { workflow: "EDIT" }
    });

    return updated;
  });

  app.get("/calendar/events", async (request) => {
    const tenantId = requireTenantId(request);
    const visibleUserIds = await listVisibleUserIds(request);
    const visibleUserIdList = [...visibleUserIds];
    const parsed = calendarQuerySchema.safeParse(request.query ?? {});
    if (!parsed.success) {
      throw app.httpErrors.badRequest(zodMsg(parsed.error));
    }

    const query = parsed.data;
    const ownerIds      = query.ownerIds      as string[];
    const visitStatuses = query.visitStatuses as VisitStatus[];
    const dealStageIds  = query.dealStageIds  as string[];
    const dealStatuses  = query.dealStatuses  as DealStatus[];
    const eventTypes    = query.eventTypes    as string[];

    // Resolve owner filter — empty means all visible users
    const allowedOwnerIds = ownerIds.length
      ? ownerIds.filter((id) => visibleUserIds.has(id))
      : visibleUserIdList;
    if (ownerIds.length && allowedOwnerIds.length === 0) {
      throw app.httpErrors.forbidden("Requested owner is outside hierarchy scope.");
    }
    const ownerFilter: string | { in: string[] } = allowedOwnerIds.length === 1
      ? allowedOwnerIds[0]!
      : { in: allowedOwnerIds };

    // Decide which event types to include (empty = both)
    const includeVisits = eventTypes.length === 0 || eventTypes.includes("visit");
    const includeDeals  = eventTypes.length === 0 || eventTypes.includes("deal");

    const { dateFrom, dateTo, anchorDate } = resolveCalendarDateRange({
      view: query.view,
      anchorDate: query.anchorDate,
      dateFrom: query.dateFrom,
      dateTo: query.dateTo
    });
    const now = new Date();

    const visitPromise = !includeVisits
      ? Promise.resolve([] as VisitWithCustomerRep[])
      : prisma.visit.findMany({
          where: {
            tenantId,
            plannedAt: { gte: dateFrom, lt: dateTo },
            repId: ownerFilter,
            customerId: query.customerId,
            ...(visitStatuses.length ? { status: { in: visitStatuses } } : {})
          },
          include: {
            customer: { select: { id: true, name: true } },
            rep: { select: { id: true, fullName: true } }
          },
          orderBy: { plannedAt: "asc" }
        });

    const dealPromise = !includeDeals
      ? Promise.resolve([] as DealCalendarWithRelations[])
      : prisma.deal.findMany({
          where: {
            tenantId,
            followUpAt: { gte: dateFrom, lt: dateTo },
            ownerId: ownerFilter,
            customerId: query.customerId,
            ...(dealStageIds.length ? { stageId: { in: dealStageIds } } : {}),
            ...(dealStatuses.length ? { status: { in: dealStatuses } } : {})
          },
          include: {
            customer: { select: { id: true, name: true } },
            owner: { select: { id: true, fullName: true } },
            stage: { select: { id: true, stageName: true } }
          },
          orderBy: { followUpAt: "asc" }
        });

    const [visits, deals] = await Promise.all([visitPromise, dealPromise]) as [VisitWithCustomerRep[], DealCalendarWithRelations[]];
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
        const isClosed = deal.status === DealStatus.WON || deal.status === DealStatus.LOST;
        const isRed =
          !isClosed &&
          (deal.followUpAt < now || (deal.closedAt && deal.followUpAt > deal.closedAt) || (deal.closedAt && deal.closedAt < now));

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
        eventTypes,
        ownerIds,
        customerId: query.customerId ?? null,
        visitStatuses,
        dealStageIds,
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
      throw app.httpErrors.badRequest(zodMsg(parsed.error));
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
                { plannedAt: { lt: endNextMonth } }
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
              followUpAt: { lt: endNextMonth },
              customerId: query.customerId
            },
            include: {
              customer: { select: { id: true, name: true } },
              owner: { select: { id: true, fullName: true } },
              stage: { select: { id: true, stageName: true } }
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
        visitNo: visit.visitNo || null,
        objective: visit.objective || null,
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
      dealName: deal.dealName,
      dealNo: deal.dealNo,
      closedAt: deal.closedAt?.toISOString() ?? null,
      stage: { id: deal.stage.id, name: deal.stage.stageName },
      estimatedValue: deal.estimatedValue,
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
      overdue: [],
      today: [],
      tomorrow: [],
      next_week: [],
      next_month: []
    };

    for (const event of events) {
      if (event.isPinned) continue;
      const { isPinned: _, ...normalized } = event;
      grouped[event.bucket].push(normalized);
    }

    if (query.bucket !== "all") {
      if (query.bucket === "pinned") {
        grouped.overdue = [];
        grouped.today = [];
        grouped.tomorrow = [];
        grouped.next_week = [];
        grouped.next_month = [];
      } else {
        for (const key of Object.keys(grouped) as TodoBucketKey[]) {
          if (key !== query.bucket) grouped[key] = [];
        }
      }
    }

    const allBucketEvents = [
      ...grouped.overdue,
      ...grouped.today,
      ...grouped.tomorrow,
      ...grouped.next_week,
      ...grouped.next_month
    ];
    return {
      generatedAt: now.toISOString(),
      pinned: {
        checkedInWaitingCheckout: query.bucket === "pinned" || query.bucket === "all" ? pinned : []
      },
      buckets: grouped,
      counts: {
        pinned: query.bucket === "pinned" || query.bucket === "all" ? pinned.length : 0,
        overdue: grouped.overdue.length,
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
