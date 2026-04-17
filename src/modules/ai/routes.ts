import {
  AiVisitRecommendationSourceType,
  AiVisitRecommendationStatus,
  DealStatus,
  IntegrationPlatform,
  JobStatus,
  Prisma,
  UserRole,
  VisitStatus,
  VisitType
} from "@prisma/client";
import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import { extname } from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { Anthropic } from "@anthropic-ai/sdk";
import { requireTenantId, requireUserId, resolveVisibleUserIds, type UserHierarchyNode } from "../../lib/http.js";

type UserLite = UserHierarchyNode & { role: UserRole; teamId: string | null };
import { prisma } from "../../lib/prisma.js";
import { getPlanLimits, assertVoiceNotesAvailable } from "../../lib/plan-limits.js";
import { decryptField } from "../../lib/secrets.js";
import { uploadBufferToR2, createR2PresignedDownload } from "../../lib/r2-storage.js";
import { config } from "../../config.js";
import { convertToMp4, isFfmpegAvailable } from "../../lib/audio-convert.js";

const createRecommendationRunSchema = z
  .object({
    dateFrom: z.string().datetime(),
    dateTo: z.string().datetime()
  })
  .strict();

const recommendationSelectionSchema = z
  .object({
    recommendationIds: z.array(z.string().trim().min(1)).min(1).optional()
  })
  .strict();

const aiAnalysisFilterSchema = z
  .object({
    dateFrom: z.coerce.date().optional(),
    dateTo: z.coerce.date().optional(),
    teamId: z.string().min(1).optional(),
    repId: z.string().min(1).optional(),
    stageId: z.string().min(1).optional()
  })
  .strict();

const jsonVoiceNoteCreateSchema = z
  .object({
    entityType: z.enum(["VISIT", "DEAL", "QUOTATION"]),
    entityId: z.string().trim().min(1),
    audioObjectKey: z.string().trim().min(1)
  })
  .strict();

const voiceNoteConfirmSchema = z
  .object({
    transcriptText: z.preprocess(v => (v === "" ? undefined : v), z.string().trim().min(1).optional()),
    summaryText: z.preprocess(v => (v === "" ? undefined : v), z.string().trim().min(1).optional())
  })
  .strict();

const OPPORTUNITY_KEYWORDS = ["opportunity", "quotation"];

type RecommendationDraft = {
  sourceType: AiVisitRecommendationSourceType;
  customerId: string;
  dealId: string | null;
  proposedDate: Date;
  reason: string;
  score: number;
};

function resolveAudioFileExtension(fileName: string, mimeType: string): string {
  const safeExt = extname(fileName).toLowerCase();
  if (safeExt) {
    return safeExt;
  }

  switch (mimeType) {
    case "audio/mpeg":
      return ".mp3";
    case "audio/wav":
    case "audio/x-wav":
      return ".wav";
    case "audio/ogg":
      return ".ogg";
    case "audio/webm":
      return ".webm";
    case "audio/mp4":
      return ".m4a";
    default:
      return ".bin";
  }
}

async function createAudioObjectFromMultipart(input: {
  request: FastifyRequest;
  tenantId: string;
  tenantSlug: string;
  app: Parameters<FastifyPluginAsync>[0];
}): Promise<{
  entityType: "VISIT" | "DEAL" | "QUOTATION";
  entityId: string;
  audioObjectKey: string;
  audioBuffer: Buffer;
  audioMimeType: string;
  transcriptText: string | null;
  outputLang: "TH" | "EN";
}> {
  let entityType: "VISIT" | "DEAL" | "QUOTATION" | null = null;
  let entityId: string | null = null;
  let audioFileBuffer: Buffer | null = null;
  let audioFileName = "voice-note";
  let audioMimeType = "application/octet-stream";
  let transcriptText: string | null = null;
  let outputLang: "TH" | "EN" = "TH";

  for await (const part of input.request.parts()) {
    if (part.type === "file") {
      audioFileName = part.filename;
      audioMimeType = part.mimetype;
      audioFileBuffer = await part.toBuffer();
      continue;
    }

    if (part.fieldname === "entityType") {
      if (part.value === "VISIT" || part.value === "DEAL" || part.value === "QUOTATION") {
        entityType = part.value;
      }
      continue;
    }

    if (part.fieldname === "entityId") {
      const normalized = String(part.value ?? "").trim();
      if (normalized.length > 0) {
        entityId = normalized;
      }
      continue;
    }

    if (part.fieldname === "transcriptText") {
      const normalized = String(part.value ?? "").trim();
      if (normalized.length > 0) {
        transcriptText = normalized;
      }
      continue;
    }

    if (part.fieldname === "outputLang") {
      if (part.value === "EN") outputLang = "EN";
    }
  }

  if (!entityType || !entityId) {
    throw input.app.httpErrors.badRequest("Multipart upload requires entityType and entityId fields.");
  }
  if (!audioFileBuffer || audioFileBuffer.length === 0) {
    throw input.app.httpErrors.badRequest("Multipart upload requires a non-empty audio file.");
  }

  // Convert to MP4 (AAC) for universal playback — handles .webm, .mov, .wav, etc.
  let uploadBuffer = audioFileBuffer;
  let uploadMimeType = audioMimeType;
  let uploadExtension = resolveAudioFileExtension(audioFileName, audioMimeType);

  if (await isFfmpegAvailable()) {
    try {
      uploadBuffer = await convertToMp4(audioFileBuffer, uploadExtension);
      uploadMimeType = "audio/mp4";
      uploadExtension = ".mp4";
    } catch (err) {
      // Conversion failed — fall back to storing the original format
      input.app.log.warn({ err }, "ffmpeg conversion failed, storing original audio");
    }
  }

  // M12: Use only a random UUID — prefixing with Date.now() leaks the upload timestamp via the object key.
  const storedFileName = `${randomUUID()}${uploadExtension}`;
  let stored: { objectKey: string; objectRef: string };
  try {
    const entityFolder = entityType === "VISIT" ? "visits" : entityType === "QUOTATION" ? "quotations" : "deals";
    stored = await uploadBufferToR2({
      tenantSlug: input.tenantSlug,
      objectKeyOrRef: `${entityFolder}/${entityId}/${storedFileName}`,
      contentType: uploadMimeType,
      data: uploadBuffer
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown upload failure.";
    throw input.app.httpErrors.badGateway(message);
  }

  return {
    entityType,
    entityId,
    audioObjectKey: stored.objectRef,
    audioBuffer: audioFileBuffer,
    audioMimeType,
    transcriptText,
    outputLang
  };
}

async function resolveAnthropicApiKey(tenantId: string): Promise<string | null> {
  const cred = await prisma.tenantIntegrationCredential.findFirst({
    where: {
      tenantId,
      platform: IntegrationPlatform.ANTHROPIC,
      status: "ENABLED",
      apiKeyRef: { not: null }
    },
    select: { apiKeyRef: true }
  });
  if (cred?.apiKeyRef) return decryptField(cred.apiKeyRef);
  return config.ANTHROPIC_API_KEY ?? null;
}

async function summarizeTranscript(
  transcriptText: string,
  apiKey: string,
  outputLang: "TH" | "EN" = "TH"
): Promise<{ transcriptText: string; summaryText: string; confidenceScore: number }> {
  const client = new Anthropic({ apiKey });

  const langInstruction = outputLang === "TH"
    ? "Write the summary in Thai (ภาษาไทย)."
    : "Write the summary in English.";

  const response = await client.messages.create({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 512,
    messages: [
      {
        role: "user",
        content: `You are a CRM assistant. Summarize the following sales call transcript as 3-5 concise bullet points. Focus on key outcomes, customer needs, objections, and next steps. ${langInstruction} Respond ONLY with valid JSON: {"summary": "• point 1\\n• point 2\\n• point 3"}\n\nTranscript:\n${transcriptText}`
      }
    ]
  });

  const firstBlock = response.content[0];
  const rawText = firstBlock?.type === "text" ? firstBlock.text : "";
  try {
    const jsonMatch = rawText.match(/\{[\s\S]*\}/);
    const parsed = jsonMatch ? JSON.parse(jsonMatch[0]) : {};
    return {
      transcriptText,
      summaryText: parsed.summary || rawText || "No summary generated.",
      confidenceScore: 0.9
    };
  } catch {
    return {
      transcriptText: rawText || "Transcription failed.",
      summaryText: "No summary generated.",
      confidenceScore: 0.5
    };
  }
}

function normalizeRecommendation(row: {
  id: string;
  sourceType: AiVisitRecommendationSourceType;
  customerId: string;
  dealId: string | null;
  score: number;
  reason: string;
  proposedDate: Date;
  status: AiVisitRecommendationStatus;
  decisionAt: Date | null;
  createdAt: Date;
}) {
  return {
    id: row.id,
    sourceType: row.sourceType,
    customerId: row.customerId,
    dealId: row.dealId,
    score: row.score,
    reason: row.reason,
    proposedDate: row.proposedDate.toISOString(),
    status: row.status,
    decisionAt: row.decisionAt ? row.decisionAt.toISOString() : null,
    createdAt: row.createdAt.toISOString()
  };
}

type AnalysisContext = {
  filters: {
    dateFrom: Date;
    dateTo: Date;
    teamId?: string;
    repId?: string;
    stageId?: string;
  };
};

type AnalysisFindingDraft = {
  findingType: "pattern" | "anomaly" | "recommendation";
  title: string;
  description: string;
  confidenceScore: number;
  evidenceJson: Prisma.InputJsonValue;
};

function buildAnalysisWindow(dateFrom?: Date, dateTo?: Date): { dateFrom: Date; dateTo: Date } {
  const now = new Date();
  const safeDateTo = dateTo ?? now;
  const safeDateFrom = dateFrom ?? new Date(safeDateTo.getTime() - 30 * 24 * 60 * 60 * 1000);
  if (safeDateFrom >= safeDateTo) {
    throw new Error("dateFrom must be earlier than dateTo.");
  }
  return { dateFrom: safeDateFrom, dateTo: safeDateTo };
}

function clampScore(value: number): number {
  return Math.min(0.99, Math.max(0.5, Number(value.toFixed(2))));
}

function buildAnalysisFindings(
  context: AnalysisContext,
  records: {
    users: UserLite[];
    visits: Array<{
      id: string;
      repId: string;
      status: VisitStatus;
      plannedAt: Date;
      checkInAt: Date | null;
      checkOutAt: Date | null;
    }>;
    deals: Array<{
      id: string;
      ownerId: string;
      stageId: string;
      status: DealStatus;
      followUpAt: Date;
      closedAt: Date | null;
      estimatedValue: number;
    }>;
    stagesById: Map<string, string>;
  }
): AnalysisFindingDraft[] {
  const findings: AnalysisFindingDraft[] = [];
  const now = new Date();
  const usersById = new Map(records.users.map((user) => [user.id, user]));

  const afternoonCheckins = records.visits.filter(
    (visit) => visit.checkInAt && visit.checkInAt.getUTCHours() >= 12
  ).length;
  const totalCheckins = records.visits.filter((visit) => Boolean(visit.checkInAt)).length;
  if (totalCheckins >= 5) {
    const ratio = afternoonCheckins / totalCheckins;
    if (ratio >= 0.8) {
      findings.push({
        findingType: "pattern",
        title: "Afternoon-heavy visit behavior",
        description:
          "Check-ins are concentrated in afternoon slots, which may reduce same-day follow-up capacity.",
        confidenceScore: clampScore(0.65 + ratio * 0.25),
        evidenceJson: {
          total_checkins: totalCheckins,
          afternoon_checkins: afternoonCheckins,
          afternoon_ratio: Number(ratio.toFixed(2)),
          date_range: {
            from: context.filters.dateFrom.toISOString(),
            to: context.filters.dateTo.toISOString()
          }
        } satisfies Prisma.InputJsonValue
      });
    }
  }

  const checkedOutCount = records.visits.filter((visit) => visit.status === VisitStatus.CHECKED_OUT).length;
  const visitCompletionRate = records.visits.length === 0 ? 1 : checkedOutCount / records.visits.length;
  if (records.visits.length >= 6 && visitCompletionRate < 0.6) {
    findings.push({
      findingType: "anomaly",
      title: "Low visit completion quality",
      description:
        "A high share of visits are not completed with checkout, which can indicate process drift or missing evidence capture.",
      confidenceScore: clampScore(0.72 + (0.6 - visitCompletionRate) * 0.25),
      evidenceJson: {
        total_visits: records.visits.length,
        checked_out_visits: checkedOutCount,
        completion_rate: Number(visitCompletionRate.toFixed(2))
      } satisfies Prisma.InputJsonValue
    });
  }

  const overdueOpenDeals = records.deals.filter(
    (deal) => deal.status === DealStatus.OPEN && deal.followUpAt < now
  );
  const openDeals = records.deals.filter((deal) => deal.status === DealStatus.OPEN);
  const overdueRatio = openDeals.length === 0 ? 0 : overdueOpenDeals.length / openDeals.length;
  if (openDeals.length >= 3 && overdueRatio >= 0.4) {
    findings.push({
      findingType: "anomaly",
      title: "Follow-up backlog risk",
      description:
        "A significant portion of open deals has overdue follow-up dates, increasing the risk of stalled opportunities.",
      confidenceScore: clampScore(0.7 + overdueRatio * 0.2),
      evidenceJson: {
        open_deals: openDeals.length,
        overdue_open_deals: overdueOpenDeals.length,
        overdue_ratio: Number(overdueRatio.toFixed(2)),
        sample_deal_ids: overdueOpenDeals.slice(0, 5).map((deal) => deal.id)
      } satisfies Prisma.InputJsonValue
    });
  }

  const wonDeals = records.deals.filter(
    (deal) =>
      deal.status === DealStatus.WON &&
      deal.closedAt &&
      deal.closedAt >= context.filters.dateFrom &&
      deal.closedAt <= context.filters.dateTo
  );
  const lostDeals = records.deals.filter(
    (deal) =>
      deal.status === DealStatus.LOST &&
      deal.closedAt &&
      deal.closedAt >= context.filters.dateFrom &&
      deal.closedAt <= context.filters.dateTo
  );
  const closedDeals = [...wonDeals, ...lostDeals];
  if (closedDeals.length >= 5) {
    const winRate = wonDeals.length / closedDeals.length;
    if (winRate >= 0.65) {
      findings.push({
        findingType: "pattern",
        title: "Strong close-rate execution",
        description:
          "Closed deal outcomes indicate above-average conversion performance in the selected analysis window.",
        confidenceScore: clampScore(0.66 + winRate * 0.25),
        evidenceJson: {
          closed_deals: closedDeals.length,
          won_deals: wonDeals.length,
          lost_deals: lostDeals.length,
          win_rate: Number(winRate.toFixed(2))
        } satisfies Prisma.InputJsonValue
      });
    }
  }

  if (overdueOpenDeals.length > 0) {
    const topOverdueByRep = new Map<string, { repId: string; count: number }>();
    for (const deal of overdueOpenDeals) {
      const row = topOverdueByRep.get(deal.ownerId) ?? { repId: deal.ownerId, count: 0 };
      row.count += 1;
      topOverdueByRep.set(deal.ownerId, row);
    }
    const sortedRows = [...topOverdueByRep.values()].sort((a, b) => b.count - a.count).slice(0, 3);
    findings.push({
      findingType: "recommendation",
      title: "Prioritize overdue follow-up recovery",
      description:
        "Assign immediate visit or call slots to overdue opportunities and sequence by highest backlog owners first.",
      confidenceScore: clampScore(0.75 + Math.min(0.15, overdueRatio * 0.2)),
      evidenceJson: {
        target_reps: sortedRows.map((row) => ({
          rep_id: row.repId,
          rep_role: usersById.get(row.repId)?.role ?? null,
          overdue_count: row.count
        })),
        recommended_action: "Schedule top overdue opportunities within 48 hours."
      } satisfies Prisma.InputJsonValue
    });
  }

  const mostActiveOpenStages = records.deals
    .filter((deal) => deal.status === DealStatus.OPEN)
    .reduce<Map<string, number>>((acc, deal) => {
      const count = acc.get(deal.stageId) ?? 0;
      acc.set(deal.stageId, count + 1);
      return acc;
    }, new Map());
  const topStage = [...mostActiveOpenStages.entries()].sort((a, b) => b[1] - a[1])[0];
  if (topStage) {
    findings.push({
      findingType: "recommendation",
      title: "Run stage-specific action sprint",
      description:
        "Focus enablement on the stage with the largest open deal concentration to increase progression throughput.",
      confidenceScore: clampScore(0.68 + Math.min(0.2, topStage[1] / Math.max(1, records.deals.length))),
      evidenceJson: {
        stage_id: topStage[0],
        stage_name: records.stagesById.get(topStage[0]) ?? "Unknown stage",
        open_deal_count: topStage[1],
        recommendation: "Create next-step templates and daily review for this stage."
      } satisfies Prisma.InputJsonValue
    });
  }

  if (findings.length === 0) {
    findings.push({
      findingType: "pattern",
      title: "No strong outliers detected",
      description:
        "Current data scope appears balanced; continue monitoring with a wider window for higher-confidence signals.",
      confidenceScore: 0.61,
      evidenceJson: {
        visits_in_scope: records.visits.length,
        deals_in_scope: records.deals.length
      } satisfies Prisma.InputJsonValue
    });
  }

  return findings;
}

export const aiRoutes: FastifyPluginAsync = async (app) => {
  app.post("/visits/ai-recommendations", async (request, reply) => {
    const tenantId = requireTenantId(request);
    const repId = requireUserId(request);
    const parsed = createRecommendationRunSchema.safeParse(request.body);
    if (!parsed.success) {
      throw app.httpErrors.badRequest(parsed.error.message);
    }

    const dateFrom = new Date(parsed.data.dateFrom);
    const dateTo = new Date(parsed.data.dateTo);
    if (dateFrom >= dateTo) {
      throw app.httpErrors.badRequest("dateFrom must be earlier than dateTo.");
    }

    const now = new Date();
    const sixMonthsAgo = new Date(now);
    sixMonthsAgo.setUTCMonth(sixMonthsAgo.getUTCMonth() - 6);
    const twelveMonthsAgo = new Date(now);
    twelveMonthsAgo.setUTCMonth(twelveMonthsAgo.getUTCMonth() - 12);

    const candidateDeals = await prisma.deal.findMany({
      where: {
        tenantId,
        ownerId: repId,
        status: DealStatus.OPEN,
        followUpAt: { gte: dateFrom, lte: dateTo }
      },
      include: { customer: true, stage: true }
    });

    const dealRecommendations: RecommendationDraft[] = candidateDeals
      .filter((deal) =>
        OPPORTUNITY_KEYWORDS.some((keyword) => deal.stage.stageName.toLowerCase().includes(keyword))
      )
      .map((deal) => ({
        sourceType: AiVisitRecommendationSourceType.DEAL_FOLLOWUP,
        customerId: deal.customerId,
        dealId: deal.id,
        proposedDate: deal.followUpAt,
        reason: "Deal follow-up date is within selected range for active opportunity/quotation work.",
        score: 0.88
      }));

    const ownedCustomers = await prisma.customer.findMany({
      where: {
        tenantId,
        ownerId: repId
      },
      select: {
        id: true,
        name: true,
        visits: {
          orderBy: { plannedAt: "desc" },
          take: 1,
          select: { plannedAt: true }
        },
        deals: {
          where: {
            status: DealStatus.WON,
            closedAt: { not: null }
          },
          orderBy: { closedAt: "desc" },
          take: 1,
          select: { closedAt: true }
        }
      }
    });

    const customerRecommendations: RecommendationDraft[] = ownedCustomers.flatMap((customer): RecommendationDraft[] => {
      const latestVisitAt = customer.visits[0]?.plannedAt ?? null;
      const latestWonClosedAt = customer.deals[0]?.closedAt ?? null;
      const proposedDate = dateFrom > now ? dateFrom : now;

      if (!latestWonClosedAt) {
        return [
          {
            sourceType: AiVisitRecommendationSourceType.CUSTOMER_NEVER_SOLD,
            customerId: customer.id,
            dealId: null,
            proposedDate,
            reason: `Customer ${customer.name} has no purchase history and should be prioritized for prospecting.`,
            score: 0.72
          }
        ];
      }

      const isInactiveFor12Months = latestWonClosedAt <= twelveMonthsAgo;
      const isInactiveFor6To12Months = latestWonClosedAt <= sixMonthsAgo && latestWonClosedAt > twelveMonthsAgo;
      const noRecentVisitFor12Months = !latestVisitAt || latestVisitAt <= twelveMonthsAgo;
      const noRecentVisitFor6Months = !latestVisitAt || latestVisitAt <= sixMonthsAgo;

      if (isInactiveFor12Months && noRecentVisitFor12Months) {
        return [
          {
            sourceType: AiVisitRecommendationSourceType.CUSTOMER_GAP_12M,
            customerId: customer.id,
            dealId: null,
            proposedDate,
            reason: `Customer ${customer.name} has not purchased in over 12 months and has no recent visit.`,
            score: 0.84
          }
        ];
      }

      if (isInactiveFor6To12Months && noRecentVisitFor6Months) {
        return [
          {
            sourceType: AiVisitRecommendationSourceType.CUSTOMER_GAP_6M,
            customerId: customer.id,
            dealId: null,
            proposedDate,
            reason: `Customer ${customer.name} has not purchased in over 6 months and has no recent visit.`,
            score: 0.76
          }
        ];
      }

      return [];
    });

    const dedupedBySourceAndCustomer = new Map<string, RecommendationDraft>();
    for (const recommendation of [...dealRecommendations, ...customerRecommendations]) {
      const key = `${recommendation.sourceType}:${recommendation.customerId}:${recommendation.dealId ?? "none"}`;
      if (!dedupedBySourceAndCustomer.has(key)) {
        dedupedBySourceAndCustomer.set(key, recommendation);
      }
    }
    const recommendations = Array.from(dedupedBySourceAndCustomer.values());

    const run = await prisma.aiVisitRecommendationRun.create({
      data: {
        tenantId,
        repId,
        dateFrom,
        dateTo,
        recommendations: {
          create: recommendations.map((item) => ({
            sourceType: item.sourceType,
            customerId: item.customerId,
            dealId: item.dealId,
            proposedDate: item.proposedDate,
            reason: item.reason,
            score: item.score
          }))
        }
      },
      include: {
        recommendations: {
          orderBy: [{ score: "desc" }, { proposedDate: "asc" }]
        }
      }
    });

    return reply.code(201).send({
      runId: run.id,
      dateFrom: run.dateFrom.toISOString(),
      dateTo: run.dateTo.toISOString(),
      recommendationCount: run.recommendations.length,
      recommendations: run.recommendations.map(normalizeRecommendation)
    });
  });

  app.get("/visits/ai-recommendations/:runId", async (request) => {
    const tenantId = requireTenantId(request);
    const repId = requireUserId(request);
    const params = request.params as { runId: string };

    const run = await prisma.aiVisitRecommendationRun.findFirst({
      where: { id: params.runId, tenantId, repId },
      include: {
        recommendations: {
          orderBy: [{ status: "asc" }, { score: "desc" }, { proposedDate: "asc" }]
        }
      }
    });
    if (!run) {
      throw app.httpErrors.notFound("AI visit recommendation run not found.");
    }

    return {
      runId: run.id,
      dateFrom: run.dateFrom.toISOString(),
      dateTo: run.dateTo.toISOString(),
      generatedAt: run.generatedAt.toISOString(),
      recommendations: run.recommendations.map(normalizeRecommendation)
    };
  });

  app.post("/visits/ai-recommendations/:runId/confirm", async (request) => {
    const tenantId = requireTenantId(request);
    const repId = requireUserId(request);
    const params = request.params as { runId: string };
    const parsed = recommendationSelectionSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      throw app.httpErrors.badRequest(parsed.error.message);
    }

    const selectedIds = parsed.data.recommendationIds ?? [];
    const updated = await prisma.$transaction(async (tx) => {
      const run = await tx.aiVisitRecommendationRun.findFirst({
        where: { id: params.runId, tenantId, repId },
        select: { id: true }
      });
      if (!run) {
        throw app.httpErrors.notFound("AI visit recommendation run not found.");
      }

      const whereClause: Prisma.AiVisitRecommendationWhereInput = {
        runId: params.runId,
        status: AiVisitRecommendationStatus.RECOMMENDED
      };
      if (selectedIds.length > 0) {
        whereClause.id = { in: selectedIds };
      }

      const targetRecommendations = await tx.aiVisitRecommendation.findMany({
        where: whereClause
      });

      if (targetRecommendations.length === 0) {
        throw app.httpErrors.badRequest("No eligible recommendations to confirm.");
      }

      const nowAt = new Date();
      await tx.aiVisitRecommendation.updateMany({
        where: {
          id: { in: targetRecommendations.map((item) => item.id) }
        },
        data: {
          status: AiVisitRecommendationStatus.ACCEPTED,
          decisionAt: nowAt
        }
      });

      await tx.visit.createMany({
        data: targetRecommendations.map((item) => ({
          tenantId,
          repId,
          customerId: item.customerId,
          dealId: item.dealId,
          visitType: VisitType.PLANNED,
          plannedAt: item.proposedDate,
          objective: item.reason
        }))
      });

      return targetRecommendations;
    });

    return {
      runId: params.runId,
      acceptedCount: updated.length,
      createdVisitCount: updated.length,
      recommendationIds: updated.map((item) => item.id)
    };
  });

  app.post("/visits/ai-recommendations/:runId/reject", async (request) => {
    const tenantId = requireTenantId(request);
    const repId = requireUserId(request);
    const params = request.params as { runId: string };
    const parsed = recommendationSelectionSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      throw app.httpErrors.badRequest(parsed.error.message);
    }

    const selectedIds = parsed.data.recommendationIds ?? [];
    const result = await prisma.$transaction(async (tx) => {
      const run = await tx.aiVisitRecommendationRun.findFirst({
        where: { id: params.runId, tenantId, repId },
        select: { id: true }
      });
      if (!run) {
        throw app.httpErrors.notFound("AI visit recommendation run not found.");
      }

      const whereClause: Prisma.AiVisitRecommendationWhereInput = {
        runId: params.runId,
        status: AiVisitRecommendationStatus.RECOMMENDED
      };
      if (selectedIds.length > 0) {
        whereClause.id = { in: selectedIds };
      }

      const pending = await tx.aiVisitRecommendation.findMany({
        where: whereClause,
        select: { id: true }
      });
      if (pending.length === 0) {
        throw app.httpErrors.badRequest("No eligible recommendations to reject.");
      }

      const nowAt = new Date();
      await tx.aiVisitRecommendation.updateMany({
        where: { id: { in: pending.map((item) => item.id) } },
        data: {
          status: AiVisitRecommendationStatus.REJECTED,
          decisionAt: nowAt
        }
      });

      return pending;
    });

    return {
      runId: params.runId,
      rejectedCount: result.length,
      recommendationIds: result.map((item) => item.id)
    };
  });

  app.post("/ai-analysis/runs", async (request, reply) => {
    const tenantId = requireTenantId(request);
    const requestedBy = requireUserId(request);
    const parsed = aiAnalysisFilterSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      throw app.httpErrors.badRequest(parsed.error.issues.map((issue) => issue.message).join("; "));
    }

    const requesterRole = request.requestContext.role ?? null;
    let dateFrom: Date;
    let dateTo: Date;
    try {
      const window = buildAnalysisWindow(parsed.data.dateFrom, parsed.data.dateTo);
      dateFrom = window.dateFrom;
      dateTo = window.dateTo;
    } catch (error) {
      const message = error instanceof Error ? error.message : "Invalid analysis date window.";
      throw app.httpErrors.badRequest(message);
    }

    const filters = {
      dateFrom,
      dateTo,
      teamId: parsed.data.teamId,
      repId: parsed.data.repId,
      stageId: parsed.data.stageId
    };

    const users = await prisma.user.findMany({
      where: { tenantId, isActive: true },
      select: { id: true, role: true, managerUserId: true, teamId: true }
    });
    const visibleUserIds = resolveVisibleUserIds(users, requestedBy, requesterRole);
    const scopedUsers = users.filter((user) => visibleUserIds.has(user.id));

    let targetUsers = scopedUsers;
    if (filters.teamId) {
      targetUsers = targetUsers.filter((user) => user.teamId === filters.teamId);
    }
    if (filters.repId) {
      targetUsers = targetUsers.filter((user) => user.id === filters.repId);
    }
    if (targetUsers.length === 0) {
      throw app.httpErrors.badRequest("No users found in analysis scope for selected filters.");
    }
    const scopedUserIds = targetUsers.map((user) => user.id);

    const [visits, deals, stages] = await Promise.all([
      prisma.visit.findMany({
        where: {
          tenantId,
          repId: { in: scopedUserIds },
          plannedAt: {
            gte: dateFrom,
            lte: dateTo
          }
        },
        select: {
          id: true,
          repId: true,
          status: true,
          plannedAt: true,
          checkInAt: true,
          checkOutAt: true
        }
      }),
      prisma.deal.findMany({
        where: {
          tenantId,
          ownerId: { in: scopedUserIds },
          ...(filters.stageId ? { stageId: filters.stageId } : {}),
          OR: [
            { createdAt: { gte: dateFrom, lte: dateTo } },
            { followUpAt: { gte: dateFrom, lte: dateTo } },
            { closedAt: { gte: dateFrom, lte: dateTo } },
            { status: DealStatus.OPEN }
          ]
        },
        select: {
          id: true,
          ownerId: true,
          stageId: true,
          status: true,
          followUpAt: true,
          closedAt: true,
          estimatedValue: true
        }
      }),
      prisma.dealStage.findMany({
        where: { tenantId },
        select: { id: true, stageName: true }
      })
    ]);

    const findings = buildAnalysisFindings(
      { filters },
      {
        users: targetUsers,
        visits,
        deals,
        stagesById: new Map(stages.map((stage) => [stage.id, stage.stageName]))
      }
    );

    const run = await prisma.aiAnalysisRun.create({
      data: {
        tenantId,
        requestedBy,
        status: JobStatus.SUCCESS,
        filtersJson: {
          dateFrom: dateFrom.toISOString(),
          dateTo: dateTo.toISOString(),
          teamId: filters.teamId ?? null,
          repId: filters.repId ?? null,
          stageId: filters.stageId ?? null
        } satisfies Prisma.InputJsonValue,
        completedAt: new Date(),
        findings: {
          create: findings
        }
      },
      include: { findings: true }
    });

    return reply.code(201).send(run);
  });

  app.get("/ai-analysis/runs/:runId", async (request) => {
    const tenantId = requireTenantId(request);
    const params = request.params as { runId: string };
    const run = await prisma.aiAnalysisRun.findFirst({
      where: { id: params.runId, tenantId },
      include: { findings: true }
    });
    if (!run) {
      throw app.httpErrors.notFound("Analysis run not found.");
    }
    return run;
  });

  app.get("/ai-analysis/runs", async (request) => {
    const tenantId = requireTenantId(request);
    const rows = await prisma.aiAnalysisRun.findMany({
      where: { tenantId },
      include: { findings: true },
      orderBy: { createdAt: "desc" },
      take: 50
    });
    return {
      count: rows.length,
      rows
    };
  });

  app.get("/ai/status", async (request) => {
    const tenantId = requireTenantId(request);
    const apiKey = await resolveAnthropicApiKey(tenantId);
    return { transcriptionAvailable: Boolean(apiKey) };
  });

  app.post("/voice-notes", async (request, reply) => {
    const tenantId = requireTenantId(request);
    const requestedById = requireUserId(request);
    // S7: check voice notes feature gate before doing any file work
    const limits = await getPlanLimits(tenantId);
    assertVoiceNotesAvailable(limits, app.httpErrors);
    const tenant = await prisma.tenant.findUnique({ where: { id: tenantId }, select: { slug: true } });
    if (!tenant) throw app.httpErrors.notFound("Tenant not found.");
    let audioBuffer: Buffer | null = null;
    let audioMimeType = "audio/webm";
    let payload: { entityType: "VISIT" | "DEAL" | "QUOTATION"; entityId: string; audioObjectKey: string };
    let multipartResult: Awaited<ReturnType<typeof createAudioObjectFromMultipart>> | null = null;

    if (request.isMultipart()) {
      multipartResult = await createAudioObjectFromMultipart({ request, tenantId, tenantSlug: tenant.slug, app });
      audioBuffer = multipartResult.audioBuffer;
      audioMimeType = multipartResult.audioMimeType;
      payload = {
        entityType: multipartResult.entityType,
        entityId: multipartResult.entityId,
        audioObjectKey: multipartResult.audioObjectKey
      };
    } else {
      const parsed = jsonVoiceNoteCreateSchema.safeParse(request.body ?? {});
      if (!parsed.success) {
        throw app.httpErrors.badRequest(parsed.error.message);
      }
      payload = parsed.data;
    }

    if (payload.entityType === "VISIT") {
      const visit = await prisma.visit.findFirst({
        where: { id: payload.entityId, tenantId },
        select: { id: true }
      });
      if (!visit) throw app.httpErrors.notFound("Visit not found in tenant.");
    } else if (payload.entityType === "QUOTATION") {
      const quotation = await prisma.quotation.findFirst({
        where: { id: payload.entityId, tenantId },
        select: { id: true }
      });
      if (!quotation) throw app.httpErrors.notFound("Quotation not found in tenant.");
    } else {
      const deal = await prisma.deal.findFirst({
        where: { id: payload.entityId, tenantId },
        select: { id: true }
      });
      if (!deal) throw app.httpErrors.notFound("Deal not found in tenant.");
    }

    const anthropicApiKey = await resolveAnthropicApiKey(tenantId);
    const browserTranscript = multipartResult?.transcriptText ?? null;
    const outputLang = multipartResult?.outputLang ?? "TH";
    const transcript =
      browserTranscript && anthropicApiKey
        ? await summarizeTranscript(browserTranscript, anthropicApiKey, outputLang)
        : browserTranscript
          ? { transcriptText: browserTranscript, summaryText: "", confidenceScore: 0 }
          : { transcriptText: "", summaryText: "", confidenceScore: 0 };

    const created = await prisma.voiceNoteJob.create({
      data: {
        tenantId,
        entityType: payload.entityType,
        entityId: payload.entityId,
        audioObjectKey: payload.audioObjectKey,
        status: JobStatus.RUNNING,
        requestedById
      }
    });

    const job = await prisma.voiceNoteJob.update({
      where: { id: created.id },
      data: {
        status: JobStatus.SUCCESS,
        completedAt: new Date(),
        transcript: {
          create: transcript
        }
      },
      include: { transcript: true }
    });

    return reply.code(201).send({
      ...job,
      requiresConfirmation: true
    });
  });

  app.get("/voice-notes/:jobId", async (request) => {
    const tenantId = requireTenantId(request);
    const params = request.params as { jobId: string };
    const job = await prisma.voiceNoteJob.findUnique({
      where: { id: params.jobId },
      include: { transcript: true }
    });
    if (!job || job.tenantId !== tenantId) {
      throw app.httpErrors.notFound("Voice note job not found.");
    }
    return {
      ...job,
      requiresConfirmation: Boolean(job.transcript && !job.transcript.confirmedAt && !job.transcript.rejectedAt),
      confirmationState: job.transcript?.confirmedAt
        ? "confirmed"
        : job.transcript?.rejectedAt
          ? "rejected"
          : "pending"
    };
  });

  app.get("/voice-notes/:jobId/audio-url", async (request) => {
    const tenantId = requireTenantId(request);
    const params = request.params as { jobId: string };
    const job = await prisma.voiceNoteJob.findUnique({
      where: { id: params.jobId },
      select: { id: true, tenantId: true, audioObjectKey: true }
    });
    if (!job || job.tenantId !== tenantId) {
      throw app.httpErrors.notFound("Voice note job not found.");
    }
    if (!job.audioObjectKey || job.audioObjectKey.startsWith("dev://")) {
      return { url: null, reason: "Audio not available in local dev mode." };
    }
    const tenant = await prisma.tenant.findUnique({ where: { id: tenantId }, select: { slug: true } });
    if (!tenant) throw app.httpErrors.notFound("Tenant not found.");
    const { downloadUrl } = await createR2PresignedDownload({
      tenantSlug: tenant.slug,
      objectKeyOrRef: job.audioObjectKey,
      expiresInSeconds: 3600
    });
    return { url: downloadUrl };
  });

  app.post("/voice-notes/:jobId/confirm", async (request) => {
    const tenantId = requireTenantId(request);
    const confirmedById = requireUserId(request);
    const params = request.params as { jobId: string };
    const parsedBody = voiceNoteConfirmSchema.safeParse(request.body ?? {});
    if (!parsedBody.success) {
      throw app.httpErrors.badRequest(parsedBody.error.message);
    }

    const job = await prisma.voiceNoteJob.findUnique({
      where: { id: params.jobId },
      include: { transcript: true }
    });
    if (!job || job.tenantId !== tenantId || !job.transcript) {
      throw app.httpErrors.notFound("Voice note job not found.");
    }
    if (job.transcript.rejectedAt) {
      throw app.httpErrors.conflict("Cannot confirm a rejected transcript.");
    }
    if (job.transcript.confirmedAt) {
      throw app.httpErrors.conflict("Transcript already confirmed.");
    }

    const normalizedSummary = parsedBody.data.summaryText?.trim() || job.transcript.summaryText;
    const normalizedTranscript = parsedBody.data.transcriptText?.trim() || job.transcript.transcriptText;

    const result = await prisma.$transaction(async (tx) => {
      const updatedTranscript = await tx.voiceNoteTranscript.update({
        where: { jobId: params.jobId },
        data: {
          transcriptText: normalizedTranscript,
          summaryText: normalizedSummary,
          confirmedAt: new Date(),
          confirmedById
        }
      });

      if (job.entityType === "DEAL") {
        const deal = await tx.deal.findFirst({
          where: { id: job.entityId, tenantId },
          select: { id: true }
        });
        if (!deal) {
          throw app.httpErrors.notFound("Deal not found for voice note job.");
        }

        const progressUpdate = await tx.dealProgressUpdate.create({
          data: {
            dealId: job.entityId,
            createdById: confirmedById,
            note: normalizedSummary,
            attachmentUrl: job.audioObjectKey
          }
        });

        return {
          transcript: updatedTranscript,
          progressLogUpdate: {
            entityType: "DEAL",
            updateId: progressUpdate.id
          }
        };
      }

      const visit = await tx.visit.findFirst({
        where: { id: job.entityId, tenantId },
        select: { id: true, result: true }
      });
      if (!visit) {
        throw app.httpErrors.notFound("Visit not found for voice note job.");
      }

      const appendedResult = visit.result
        ? `${visit.result}\n\n[Voice note]\n${normalizedSummary}`
        : `[Voice note]\n${normalizedSummary}`;

      await tx.visit.update({
        where: { id: visit.id },
        data: {
          result: appendedResult
        }
      });

      return {
        transcript: updatedTranscript,
        progressLogUpdate: {
          entityType: "VISIT",
          visitId: visit.id
        }
      };
    });

    return {
      jobId: params.jobId,
      confirmed: true,
      transcript: result.transcript,
      progressLogUpdate: result.progressLogUpdate
    };
  });

  // ── Lost-deals AI analysis ───────────────────────────────────────────────
  app.get("/ai/lost-deals-analysis", async (request) => {
    const tenantId = requireTenantId(request);
    const query = request.query as {
      dateFrom?: string;
      dateTo?: string;
      repId?: string;
    };

    const where = {
      tenantId,
      status: DealStatus.LOST,
      lostNote: { not: null as null },
      closedAt: undefined as { gte?: Date; lte?: Date } | undefined,
      ownerId: undefined as string | undefined
    };
    if (query.dateFrom) where.closedAt = { ...where.closedAt, gte: new Date(query.dateFrom) };
    if (query.dateTo)   where.closedAt = { ...where.closedAt, lte: new Date(query.dateTo)   };
    if (query.repId)    where.ownerId  = query.repId;

    const deals = await prisma.deal.findMany({
      where,
      select: {
        id: true, dealNo: true, dealName: true, estimatedValue: true,
        closedAt: true, lostNote: true,
        customer: { select: { name: true, customerCode: true } },
        owner:    { select: { fullName: true } }
      },
      orderBy: { closedAt: "desc" }
    });

    if (!deals.length) {
      return { dealCount: 0, analysis: null, message: "No lost deals with notes found for the selected period." };
    }

    // Find the first enabled AI credential (ANTHROPIC, GEMINI, OPENAI) or fall back to env
    const AI_PLATFORMS_ORDERED = [
      IntegrationPlatform.ANTHROPIC,
      IntegrationPlatform.GEMINI,
      IntegrationPlatform.OPENAI
    ] as const;
    type AiPlatform = (typeof AI_PLATFORMS_ORDERED)[number];

    const enabledAiCred = await prisma.tenantIntegrationCredential.findFirst({
      where: {
        tenantId,
        platform: { in: [...AI_PLATFORMS_ORDERED] },
        status: "ENABLED",
        apiKeyRef: { not: null }
      }
    });

    let aiPlatform: AiPlatform = IntegrationPlatform.ANTHROPIC;
    let apiKey = "";

    if (enabledAiCred?.apiKeyRef) {
      aiPlatform = enabledAiCred.platform as AiPlatform;
      apiKey = decryptField(enabledAiCred.apiKeyRef) ?? "";
    } else {
      // Fall back to env variable (legacy)
      apiKey = process.env.ANTHROPIC_API_KEY ?? "";
      aiPlatform = IntegrationPlatform.ANTHROPIC;
    }

    if (!apiKey) {
      return { configured: false, dealCount: 0, analysis: null };
    }

    const notesBlock = deals
      .map((d, i) => {
        const closed = d.closedAt ? new Date(d.closedAt).toLocaleDateString("en-GB") : "unknown";
        const value  = d.estimatedValue.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
        return `[${i + 1}] Deal: "${d.dealName}" | Rep: ${d.owner.fullName} | Customer: ${d.customer.name} | Value: ${value} | Lost: ${closed}\nReason: ${d.lostNote}`;
      })
      .join("\n\n");

    const prompt = `You are a CRM sales analyst. Analyze the following ${deals.length} lost deal notes and return structured JSON insights.

LOST DEAL NOTES:
${notesBlock}

Return ONLY valid JSON with this structure (no prose, no markdown fences):
{
  "summary": "2-3 sentence executive summary of why deals are being lost",
  "themes": [
    {
      "name": "Theme name",
      "count": <integer>,
      "percentage": <0-100>,
      "description": "What this theme means",
      "examples": ["short direct quote from note 1", "short direct quote from note 2"]
    }
  ],
  "trends": ["Observation about a pattern or change over time"],
  "recommendations": [
    {
      "priority": "high",
      "title": "Short action title",
      "detail": "Concrete action the team can take"
    }
  ]
}

Rules:
- themes: identify 3-7 distinct themes; a single deal can belong to multiple themes
- examples: pick verbatim short phrases from the notes, not paraphrases
- recommendations: at least 3, ordered high → medium → low priority
- Return ONLY the JSON object, nothing else`;

    async function callAiProvider(platform: AiPlatform, key: string, userPrompt: string): Promise<string> {
      if (platform === IntegrationPlatform.GEMINI) {
        const res = await fetch(
          "https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent",
          {
            method: "POST",
            headers: { "content-type": "application/json", "x-goog-api-key": key },
            body: JSON.stringify({ contents: [{ parts: [{ text: userPrompt }] }] })
          }
        );
        if (!res.ok) {
          const err = await res.text().catch(() => "");
          throw app.httpErrors.badGateway(`Gemini error: ${res.status} ${err.slice(0, 120)}`);
        }
        const body = await res.json() as { candidates: Array<{ content: { parts: Array<{ text: string }> } }> };
        return body.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
      }

      if (platform === IntegrationPlatform.OPENAI) {
        const res = await fetch("https://api.openai.com/v1/chat/completions", {
          method: "POST",
          headers: { "Authorization": `Bearer ${key}`, "content-type": "application/json" },
          body: JSON.stringify({ model: "gpt-4o-mini", max_tokens: 2048, messages: [{ role: "user", content: userPrompt }] })
        });
        if (!res.ok) {
          const err = await res.text().catch(() => "");
          throw app.httpErrors.badGateway(`OpenAI error: ${res.status} ${err.slice(0, 120)}`);
        }
        const body = await res.json() as { choices: Array<{ message: { content: string } }> };
        return body.choices?.[0]?.message?.content ?? "";
      }

      // Default: Anthropic
      const res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" },
        body: JSON.stringify({ model: "claude-haiku-4-5-20251001", max_tokens: 2048, messages: [{ role: "user", content: userPrompt }] })
      });
      if (!res.ok) {
        const err = await res.text().catch(() => "");
        throw app.httpErrors.badGateway(`Anthropic error: ${res.status} ${err.slice(0, 120)}`);
      }
      const body = await res.json() as { content: Array<{ text: string }> };
      return body.content?.[0]?.text ?? "";
    }

    const rawText = await callAiProvider(aiPlatform, apiKey, prompt);

    let analysis: unknown;
    try {
      analysis = JSON.parse(rawText);
    } catch {
      analysis = { summary: rawText, themes: [], trends: [], recommendations: [] };
    }

    return { dealCount: deals.length, analysis };
  });

  app.post("/voice-notes/:jobId/reject", async (request) => {
    const tenantId = requireTenantId(request);
    const params = request.params as { jobId: string };
    const job = await prisma.voiceNoteJob.findUnique({
      where: { id: params.jobId },
      include: { transcript: true }
    });
    if (!job || job.tenantId !== tenantId || !job.transcript) {
      throw app.httpErrors.notFound("Voice note job not found.");
    }
    if (job.transcript.confirmedAt) {
      throw app.httpErrors.conflict("Cannot reject a confirmed transcript.");
    }

    const transcript = await prisma.voiceNoteTranscript.update({
      where: { jobId: params.jobId },
      data: { rejectedAt: new Date(), confirmedAt: null, confirmedById: null }
    });
    return {
      jobId: params.jobId,
      rejected: true,
      transcript
    };
  });
};
