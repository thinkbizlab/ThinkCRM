import { ChannelType, DealStatus, EntityType, IntegrationPlatform, Prisma, QuotationStatus, SourceStatus, UserRole } from "@prisma/client";
import type { FastifyPluginAsync } from "fastify";
import { config } from "../../config.js";
import { z } from "zod";
import {
  assertTenantPathAccess,
  listVisibleUserIds,
  requireRoleAtLeast,
  requireTenantId,
  requireUserId,
  zodMsg
} from "../../lib/http.js";
import { writeEntityChangelog } from "../../lib/changelog.js";
import { prisma } from "../../lib/prisma.js";
import { decryptCredential } from "../../lib/secrets.js";
import { smtpPort } from "../../lib/smtp-port.js";
import { fmtBahtCurrency, fmtThaiDateTime } from "../../lib/format.js";
import { validateCustomFields, asRecord } from "../../lib/custom-fields.js";
import { getTenantUrl } from "../../lib/tenant-url.js";

type DealNotifyKind = "CREATED" | typeof DealStatus.WON | typeof DealStatus.LOST;

async function sendDealLineNotification(opts: {
  tenantId: string;
  ownerId: string;
  dealId: string;
  status: DealNotifyKind;
}) {
  try {
    const [owner, lineCredential, emailCredential, branding] = await Promise.all([
      prisma.user.findUnique({
        where: { id: opts.ownerId },
        select: { teamId: true, fullName: true }
      }),
      prisma.tenantIntegrationCredential.findUnique({
        where: { tenantId_platform: { tenantId: opts.tenantId, platform: IntegrationPlatform.LINE } },
        select: { apiKeyRef: true, status: true }
      }).then(r => decryptCredential(r)),
      prisma.tenantIntegrationCredential.findUnique({
        where: { tenantId_platform: { tenantId: opts.tenantId, platform: IntegrationPlatform.EMAIL } },
        select: { clientIdRef: true, clientSecretRef: true, apiKeyRef: true, webhookTokenRef: true, status: true }
      }).then(r => decryptCredential(r)),
      prisma.tenantBranding.findUnique({
        where: { tenantId: opts.tenantId },
        select: { appName: true }
      })
    ]);

    if (!owner?.teamId) {
      console.warn("[sendDealLineNotification] missing owner.teamId", { teamId: owner?.teamId });
      return;
    }

    const allChannels = await prisma.teamNotificationChannel.findMany({
      where: { tenantId: opts.tenantId, teamId: owner.teamId, isEnabled: true,
        channelType: { in: [ChannelType.LINE, ChannelType.MS_TEAMS, ChannelType.EMAIL] } },
      select: { channelType: true, channelTarget: true }
    });
    if (allChannels.length === 0) {
      console.warn("[sendDealLineNotification] no notification channels configured for team", { teamId: owner.teamId });
      return;
    }

    const lineChannels  = allChannels.filter(c => c.channelType === ChannelType.LINE);
    const teamsChannels = allChannels.filter(c => c.channelType === ChannelType.MS_TEAMS);
    const emailChannels = allChannels.filter(c => c.channelType === ChannelType.EMAIL);

    const deal = await prisma.deal.findUnique({
      where: { id: opts.dealId },
      select: {
        dealNo: true,
        dealName: true,
        estimatedValue: true,
        lostNote: true,
        followUpAt: true,
        customer: { select: { name: true } }
      }
    });

    const appName = branding?.appName || "CRM";
    const repName = owner.fullName || "Sales Rep";
    const customerName = deal?.customer?.name || "—";
    const dealNo = deal?.dealNo || "—";
    const dealName = deal?.dealName || "—";
    const value = deal?.estimatedValue != null
      ? fmtBahtCurrency(deal.estimatedValue)
      : "—";

    const isCreated = opts.status === "CREATED";
    const isWon = opts.status === DealStatus.WON;
    const emoji = isCreated ? "🆕" : isWon ? "🏆" : "❌";
    const label = isCreated ? "New Deal" : isWon ? "Deal WON" : "Deal LOST";

    const timeLabel = isCreated ? "Follow-up" : "Closed At";
    const timeValue = isCreated && deal?.followUpAt
      ? fmtThaiDateTime(deal.followUpAt)
      : fmtThaiDateTime(new Date());

    const lostLine = opts.status === DealStatus.LOST && deal?.lostNote
      ? `📝 Lost Reason : ${deal.lostNote}\n`
      : "";

    const text =
      `${emoji} ${label}\n` +
      `${"─".repeat(28)}\n` +
      `🔖 Deal ID     : ${dealNo}\n` +
      `👤 Sales Rep   : ${repName}\n` +
      `🏢 Customer    : ${customerName}\n` +
      `📋 Deal        : ${dealName}\n` +
      `💰 Value       : ${value}\n` +
      lostLine +
      `🕐 ${timeLabel.padEnd(11, " ")}: ${timeValue}\n` +
      `${"─".repeat(28)}\n` +
      `[${appName}]`;

    const sends: Promise<unknown>[] = [];

    if (lineChannels.length > 0 && lineCredential?.apiKeyRef && lineCredential.status === SourceStatus.ENABLED) {
      const { sendLinePush } = await import("../../lib/line-notify.js");
      lineChannels.forEach(ch => sends.push(sendLinePush(lineCredential.apiKeyRef!, ch.channelTarget, { type: "text", text })));
    }

    if (teamsChannels.length > 0) {
      const { sendTeamsCard } = await import("../../lib/teams-notify.js");
      const facts = [
        { title: "Deal ID",    value: dealNo },
        { title: "Sales Rep",  value: repName },
        { title: "Customer",   value: customerName },
        { title: "Deal",       value: dealName },
        { title: "Value",      value: value },
        ...(opts.status === DealStatus.LOST && deal?.lostNote ? [{ title: "Lost Reason", value: deal.lostNote }] : []),
        { title: timeLabel,    value: timeValue }
      ];
      teamsChannels.forEach(ch => sends.push(sendTeamsCard(ch.channelTarget, {
        title: `${emoji} ${label}`,
        accentColor: isCreated ? "accent" : isWon ? "good" : "attention",
        facts,
        footer: `[${appName}]`
      })));
    }

    if (emailChannels.length > 0 && emailCredential?.clientIdRef && emailCredential?.apiKeyRef && emailCredential?.webhookTokenRef && emailCredential.status === SourceStatus.ENABLED) {
      const { sendEmailCard } = await import("../../lib/email-notify.js");
      const emailConfig = {
        host: emailCredential.clientIdRef,
        port: smtpPort(emailCredential.clientSecretRef),
        fromAddress: emailCredential.webhookTokenRef,
        password: emailCredential.apiKeyRef
      };
      const emailFacts = [
        { label: "Deal ID",     value: dealNo },
        { label: "Sales Rep",   value: repName },
        { label: "Customer",    value: customerName },
        { label: "Deal",        value: dealName },
        { label: "Value",       value: value },
        ...(opts.status === DealStatus.LOST && deal?.lostNote ? [{ label: "Lost Reason", value: deal.lostNote }] : []),
        { label: timeLabel,     value: timeValue }
      ];
      const baseUrl = await getTenantUrl(opts.tenantId).catch(() => config.APP_URL ?? "");
      emailChannels.forEach(ch => sends.push(sendEmailCard(emailConfig, ch.channelTarget, {
        subject: `${emoji} ${label} — ${dealName}`,
        title: `${emoji} ${label}`,
        facts: emailFacts,
        detailUrl: baseUrl ? `${baseUrl}/deals/${encodeURIComponent(dealNo)}` : undefined,
        footer: `[${appName}]`
      })));
    }

    await Promise.allSettled(sends);
  } catch (err) {
    console.error("[sendDealLineNotification] error:", err);
  }
}

const createDealSchema = z.object({
  dealName: z.string().min(2),
  customerId: z.string().min(1),
  stageId: z.string().min(1),
  estimatedValue: z.number().nonnegative(),
  followUpAt: z.string().datetime(),
  closedAt: z.string().datetime().optional(),
  customFields: z.record(z.string(), z.any()).optional()
});
const updateDealSchema = createDealSchema.partial();

const progressSchema = z.object({
  note: z.string().trim().min(1),
  attachmentUrls: z
    .array(
      z.string().refine(
        (v) => v.startsWith("r2://") || z.string().url().safeParse(v).success,
        "each attachmentUrl must be a valid URL or r2:// object reference"
      )
    )
    .max(5, "A maximum of 5 attachments is allowed")
    .optional(),
  followUpAt: z.string().datetime().optional()
});

const createVisitFromProgressSchema = z
  .object({
    plannedAt: z.string().datetime().optional(),
    objective: z.string().trim().min(1).optional()
  })
  .strict();

const stageRuleSchema = z.object({
  allowForwardMove: z.boolean().default(true),
  allowBackwardMove: z.boolean().default(false),
  allowStageSkip: z.boolean().default(false),
  allowedSourceStageIds: z.array(z.string().min(1)).optional().nullable()
});

const stageCreateSchema = z
  .object({
    stageName: z.string().trim().min(1),
    isDefault: z.boolean().optional().default(false),
    isClosedWon: z.boolean().optional().default(false),
    isClosedLost: z.boolean().optional().default(false),
    insertAt: z.number().int().positive().optional()
  })
  .merge(stageRuleSchema.partial());

const stagePatchSchema = z
  .object({
    stageName: z.string().trim().min(1).optional(),
    isDefault: z.boolean().optional(),
    isClosedWon: z.boolean().optional(),
    isClosedLost: z.boolean().optional()
  })
  .merge(stageRuleSchema.partial());

const stageReorderSchema = z.object({
  stageIds: z.array(z.string().min(1)).min(1)
});

const moveStageSchema = z.object({
  stageId: z.string().min(1),
  lostNote: z.string().trim().min(10).optional()
});

const quoteItemSchema = z.object({
  itemId: z.string().min(1),
  unitPrice: z.number().nonnegative(),
  discountPercent: z.number().min(0).max(100).default(0),
  quantity: z.number().int().positive()
});

const quotationCreateSchema = z.object({
  quotationNo: z.string().trim().min(1),
  customerId: z.string().min(1),
  paymentTermId: z.string().min(1),
  billingAddressId: z.string().min(1).optional(),
  shippingAddressId: z.string().min(1).optional(),
  validTo: z.string().datetime(),
  items: z.array(quoteItemSchema).min(1)
});

const quotationItemsUpsertSchema = z.object({
  items: z.array(quoteItemSchema).min(1)
});

const quotationStatusPatchSchema = z.object({
  status: z.nativeEnum(QuotationStatus)
});

const dealItemsAssignSchema = z.object({
  quotationId: z.string().cuid().optional()
});

const quotationFormFieldSchema = z.object({
  fieldKey: z.string().trim().min(1),
  label: z.string().trim().min(1),
  isVisible: z.boolean(),
  isRequired: z.boolean(),
  displayOrder: z.number().int().min(0)
});

const quotationFormConfigSchema = z.object({
  header: z.array(quotationFormFieldSchema).min(1),
  item: z.array(quotationFormFieldSchema).min(1)
});

const DEFAULT_QUOTATION_HEADER_LAYOUT = [
  { fieldKey: "customerId", label: "Customer", isVisible: true, isRequired: true, displayOrder: 1 },
  {
    fieldKey: "billingAddressId",
    label: "Billing Address",
    isVisible: true,
    isRequired: true,
    displayOrder: 2
  },
  {
    fieldKey: "shippingAddressId",
    label: "Shipping Address",
    isVisible: true,
    isRequired: true,
    displayOrder: 3
  },
  {
    fieldKey: "paymentTermId",
    label: "Payment Term",
    isVisible: true,
    isRequired: true,
    displayOrder: 4
  },
  { fieldKey: "validTo", label: "Valid To", isVisible: true, isRequired: true, displayOrder: 5 }
] as const;

const DEFAULT_QUOTATION_ITEM_LAYOUT = [
  { fieldKey: "itemId", label: "Item", isVisible: true, isRequired: true, displayOrder: 1 },
  { fieldKey: "unitPrice", label: "Unit Price", isVisible: true, isRequired: true, displayOrder: 2 },
  {
    fieldKey: "discountPercent",
    label: "Discount %",
    isVisible: true,
    isRequired: false,
    displayOrder: 3
  },
  { fieldKey: "quantity", label: "Quantity", isVisible: true, isRequired: true, displayOrder: 4 }
] as const;

function parseAllowedSourceStageIds(value: Prisma.JsonValue | null): string[] | null {
  if (!Array.isArray(value)) {
    return null;
  }

  const stageIds = value.filter((item): item is string => typeof item === "string");
  return stageIds.length > 0 ? stageIds : null;
}

function withDealCardFlags<T extends { followUpAt: Date; closedAt: Date | null }>(deal: T) {
  const now = new Date();
  const isOverdueFollowup = deal.followUpAt < now;
  const isInvalidFollowupAfterClose = deal.closedAt ? deal.followUpAt > deal.closedAt : false;
  const isClosedPastDue = deal.closedAt ? deal.closedAt < now : false;

  return {
    ...deal,
    is_overdue_followup: isOverdueFollowup,
    is_invalid_followup_after_close: isInvalidFollowupAfterClose,
    is_closed_past_due: isClosedPastDue
  };
}

function assertValidFollowUpWindow(
  app: Parameters<FastifyPluginAsync>[0],
  followUpAt: Date,
  closedAt?: Date | null
) {
  if (closedAt && followUpAt > closedAt) {
    throw app.httpErrors.badRequest("followUpAt must be on or before closedAt.");
  }
}

async function assertCustomerBelongsToTenant(
  app: Parameters<FastifyPluginAsync>[0],
  tenantId: string,
  customerId: string
) {
  const customer = await prisma.customer.findFirst({
    where: { id: customerId, tenantId },
    select: { id: true }
  });
  if (!customer) {
    throw app.httpErrors.badRequest("customerId is not valid for this tenant.");
  }
}

function assertValidClosedFlags(
  app: Parameters<FastifyPluginAsync>[0],
  flags: { isClosedWon: boolean; isClosedLost: boolean }
) {
  if (flags.isClosedWon && flags.isClosedLost) {
    throw app.httpErrors.badRequest("A stage cannot be both closed-won and closed-lost.");
  }
}

async function assertAllowedSourceStagesExist(
  app: Parameters<FastifyPluginAsync>[0],
  tenantId: string,
  allowedSourceStageIds: string[] | null | undefined,
  currentStageId?: string
) {
  if (allowedSourceStageIds === undefined || allowedSourceStageIds === null) {
    return;
  }

  if (currentStageId && allowedSourceStageIds.includes(currentStageId)) {
    throw app.httpErrors.badRequest("A stage cannot list itself in allowedSourceStageIds.");
  }

  const distinctIds = Array.from(new Set(allowedSourceStageIds));
  if (distinctIds.length === 0) {
    return;
  }

  const existing = await prisma.dealStage.findMany({
    where: { tenantId, id: { in: distinctIds } },
    select: { id: true }
  });
  if (existing.length !== distinctIds.length) {
    throw app.httpErrors.badRequest("allowedSourceStageIds contains unknown stage ids.");
  }
}

async function reorderTenantStages(
  tx: Prisma.TransactionClient,
  tenantId: string,
  stageIds: string[]
) {
  for (let index = 0; index < stageIds.length; index += 1) {
    await tx.dealStage.update({
      where: { id: stageIds[index] },
      data: { stageOrder: 1000 + index }
    });
  }

  for (let index = 0; index < stageIds.length; index += 1) {
    await tx.dealStage.update({
      where: { id: stageIds[index] },
      data: { stageOrder: index + 1 }
    });
  }
}

function isStageTransitionAllowed(
  fromStage: {
    id: string;
    stageOrder: number;
    isClosedWon: boolean;
    isClosedLost: boolean;
  },
  toStage: {
    id: string;
    stageOrder: number;
    isClosedLost: boolean;
    allowForwardMove: boolean;
    allowBackwardMove: boolean;
    allowStageSkip: boolean;
    allowedSourceStageIds: Prisma.JsonValue | null;
  }
) {
  if (fromStage.id === toStage.id) {
    return true;
  }

  if (fromStage.isClosedWon || fromStage.isClosedLost) {
    return false;
  }

  // Lost is a terminal stage reachable from any open stage regardless of skip rules
  if (toStage.isClosedLost) {
    return true;
  }

  const explicitAllowedSources = parseAllowedSourceStageIds(toStage.allowedSourceStageIds);
  if (explicitAllowedSources && explicitAllowedSources.length > 0) {
    return explicitAllowedSources.includes(fromStage.id);
  }

  const movingForward = toStage.stageOrder > fromStage.stageOrder;
  const movingBackward = toStage.stageOrder < fromStage.stageOrder;
  const skippingStage = Math.abs(toStage.stageOrder - fromStage.stageOrder) > 1;

  if (movingForward && !toStage.allowForwardMove) {
    return false;
  }
  if (movingBackward && !toStage.allowBackwardMove) {
    return false;
  }
  if (skippingStage && !toStage.allowStageSkip) {
    return false;
  }
  return true;
}

function normalizeLayoutFields(
  fields: Array<z.infer<typeof quotationFormFieldSchema>>
): Array<z.infer<typeof quotationFormFieldSchema>> {
  return [...fields].sort((left, right) => left.displayOrder - right.displayOrder);
}

async function resolveQuotationItems(
  app: Parameters<FastifyPluginAsync>[0],
  tenantId: string,
  items: Array<z.infer<typeof quoteItemSchema>>
) {
  const distinctItemIds = Array.from(new Set(items.map((item) => item.itemId)));
  const dbItems = await prisma.item.findMany({
    where: {
      tenantId,
      id: { in: distinctItemIds }
    },
    select: { id: true, itemCode: true }
  });
  const itemMap = new Map(dbItems.map((item) => [item.id, item]));
  if (itemMap.size !== distinctItemIds.length) {
    throw app.httpErrors.badRequest("One or more items are not available in this tenant.");
  }

  return items.map((item) => {
    const dbItem = itemMap.get(item.itemId);
    if (!dbItem) {
      throw app.httpErrors.badRequest("One or more items are not available in this tenant.");
    }
    const netPricePerUnit = item.unitPrice * (1 - item.discountPercent / 100);
    const totalPrice = netPricePerUnit * item.quantity;
    return {
      itemId: item.itemId,
      itemCode: dbItem.itemCode,
      unitPrice: item.unitPrice,
      discountPercent: item.discountPercent,
      netPricePerUnit,
      quantity: item.quantity,
      totalPrice
    };
  });
}

function calculateQuotationTotals(
  lineItems: Array<{
    totalPrice: number;
  }>,
  taxConfig: { vatEnabled: boolean; vatRatePercent: number } | null
) {
  const subtotal = lineItems.reduce((sum, item) => sum + item.totalPrice, 0);
  const vatRate = taxConfig?.vatEnabled ? taxConfig.vatRatePercent : 0;
  const vatAmount = subtotal * (vatRate / 100);

  return {
    subtotal,
    vatRate,
    vatAmount,
    grandTotal: subtotal + vatAmount
  };
}

export const dealRoutes: FastifyPluginAsync = async (app) => {
  app.get("/deals/stages", async (request) => {
    const tenantId = requireTenantId(request);
    return prisma.dealStage.findMany({
      where: { tenantId },
      orderBy: { stageOrder: "asc" }
    });
  });

  app.post("/deals/stages", async (request, reply) => {
    const tenantId = requireTenantId(request);
    requireRoleAtLeast(request, UserRole.ADMIN);
    const parsed = stageCreateSchema.safeParse(request.body);
    if (!parsed.success) {
      throw app.httpErrors.badRequest(zodMsg(parsed.error));
    }

    const stageData = parsed.data;
    assertValidClosedFlags(app, {
      isClosedWon: stageData.isClosedWon,
      isClosedLost: stageData.isClosedLost
    });
    await assertAllowedSourceStagesExist(app, tenantId, stageData.allowedSourceStageIds);

    const existingStages = await prisma.dealStage.findMany({
      where: { tenantId },
      orderBy: { stageOrder: "asc" },
      select: { id: true }
    });
    const insertAt = stageData.insertAt
      ? Math.min(Math.max(stageData.insertAt, 1), existingStages.length + 1)
      : existingStages.length + 1;

    const created = await prisma.$transaction(async (tx) => {
      if (stageData.isDefault) {
        await tx.dealStage.updateMany({
          where: { tenantId, isDefault: true },
          data: { isDefault: false }
        });
      }

      const stage = await tx.dealStage.create({
        data: {
          tenantId,
          stageName: stageData.stageName,
          stageOrder: existingStages.length + 1,
          isDefault: stageData.isDefault,
          isClosedWon: stageData.isClosedWon,
          isClosedLost: stageData.isClosedLost,
          allowForwardMove: stageData.allowForwardMove ?? true,
          allowBackwardMove: stageData.allowBackwardMove ?? false,
          allowStageSkip: stageData.allowStageSkip ?? false,
          allowedSourceStageIds: stageData.allowedSourceStageIds
            ? Array.from(new Set(stageData.allowedSourceStageIds))
            : undefined
        }
      });

      const reorderedIds = [...existingStages.map((stageRow) => stageRow.id)];
      reorderedIds.splice(insertAt - 1, 0, stage.id);
      await reorderTenantStages(tx, tenantId, reorderedIds);
      return stage;
    });

    return reply.code(201).send(created);
  });

  app.patch("/deals/stages/:stageId", async (request) => {
    const tenantId = requireTenantId(request);
    requireRoleAtLeast(request, UserRole.ADMIN);
    const params = request.params as { stageId: string };
    const parsed = stagePatchSchema.safeParse(request.body);
    if (!parsed.success) {
      throw app.httpErrors.badRequest(zodMsg(parsed.error));
    }

    const stage = await prisma.dealStage.findFirst({
      where: { id: params.stageId, tenantId }
    });
    if (!stage) {
      throw app.httpErrors.notFound("Stage not found.");
    }

    const nextClosedWon = parsed.data.isClosedWon ?? stage.isClosedWon;
    const nextClosedLost = parsed.data.isClosedLost ?? stage.isClosedLost;
    assertValidClosedFlags(app, {
      isClosedWon: nextClosedWon,
      isClosedLost: nextClosedLost
    });
    await assertAllowedSourceStagesExist(
      app,
      tenantId,
      parsed.data.allowedSourceStageIds,
      params.stageId
    );

    if (parsed.data.isDefault) {
      await prisma.dealStage.updateMany({
        where: { tenantId, isDefault: true, id: { not: params.stageId } },
        data: { isDefault: false }
      });
    }

    return prisma.dealStage.update({
      where: { id: params.stageId },
      data: {
        stageName: parsed.data.stageName,
        isDefault: parsed.data.isDefault,
        isClosedWon: parsed.data.isClosedWon,
        isClosedLost: parsed.data.isClosedLost,
        allowForwardMove: parsed.data.allowForwardMove,
        allowBackwardMove: parsed.data.allowBackwardMove,
        allowStageSkip: parsed.data.allowStageSkip,
        allowedSourceStageIds:
          parsed.data.allowedSourceStageIds === undefined
            ? undefined
            : parsed.data.allowedSourceStageIds
              ? Array.from(new Set(parsed.data.allowedSourceStageIds))
              : Prisma.JsonNull
      }
    });
  });

  app.put("/deals/stages/reorder", async (request) => {
    const tenantId = requireTenantId(request);
    requireRoleAtLeast(request, UserRole.ADMIN);
    const parsed = stageReorderSchema.safeParse(request.body);
    if (!parsed.success) {
      throw app.httpErrors.badRequest(zodMsg(parsed.error));
    }

    const stageRows = await prisma.dealStage.findMany({
      where: { tenantId },
      select: { id: true },
      orderBy: { stageOrder: "asc" }
    });
    const currentIds = stageRows.map((stage) => stage.id);
    const nextIds = parsed.data.stageIds;

    if (currentIds.length !== nextIds.length) {
      throw app.httpErrors.badRequest("stageIds must include every stage in the tenant exactly once.");
    }

    const currentSet = new Set(currentIds);
    const nextSet = new Set(nextIds);
    if (currentSet.size !== nextSet.size) {
      throw app.httpErrors.badRequest("stageIds contains duplicate ids.");
    }
    for (const id of nextIds) {
      if (!currentSet.has(id)) {
        throw app.httpErrors.badRequest("stageIds contains unknown stage ids.");
      }
    }

    await prisma.$transaction(async (tx) => {
      await reorderTenantStages(tx, tenantId, nextIds);
    });

    return prisma.dealStage.findMany({
      where: { tenantId },
      orderBy: { stageOrder: "asc" }
    });
  });

  app.get("/deals/kanban", async (request) => {
    const tenantId = requireTenantId(request);
    const visibleUserIdList = [...(await listVisibleUserIds(request))];
    const [stages, deals] = await Promise.all([
      prisma.dealStage.findMany({ where: { tenantId }, orderBy: { stageOrder: "asc" } }),
      prisma.deal.findMany({
        where: { tenantId, ownerId: { in: visibleUserIdList } },
        include: { customer: true, stage: true, owner: true },
        orderBy: { updatedAt: "desc" }
      })
    ]);
    const dealCards = deals.map(withDealCardFlags);

    return {
      stages: stages.map((stage) => ({
        ...stage,
        deals: dealCards.filter((deal) => deal.stageId === stage.id)
      }))
    };
  });

  app.get("/deals", async (request) => {
    const tenantId = requireTenantId(request);
    const visibleUserIdList = [...(await listVisibleUserIds(request))];
    const { customerId } = request.query as { customerId?: string };
    const deals = await prisma.deal.findMany({
      where: {
        tenantId,
        ownerId: { in: visibleUserIdList },
        ...(customerId ? { customerId } : {})
      },
      include: { customer: true, stage: true, owner: true },
      orderBy: { createdAt: "desc" }
    });
    return deals.map(withDealCardFlags);
  });

  app.get("/deals/:id", async (request) => {
    const tenantId = requireTenantId(request);
    const visibleUserIdList = [...(await listVisibleUserIds(request))];
    const params = request.params as { id: string };
    const deal = await prisma.deal.findFirst({
      where: { id: params.id, tenantId, ownerId: { in: visibleUserIdList } },
      include: {
        customer: {
          include: {
            contacts: true,
            addresses: true,
            paymentTerm: true
          }
        },
        stage: true,
        owner: true
      }
    });
    if (!deal) {
      throw app.httpErrors.notFound("Deal not found.");
    }
    return withDealCardFlags(deal);
  });

  app.post("/deals", async (request, reply) => {
    const tenantId = requireTenantId(request);
    const ownerId = requireUserId(request);
    const parsed = createDealSchema.safeParse(request.body);
    if (!parsed.success) {
      throw app.httpErrors.badRequest(zodMsg(parsed.error));
    }

    const data = parsed.data;
    const stage = await prisma.dealStage.findFirst({
      where: { id: data.stageId, tenantId },
      select: { id: true }
    });
    if (!stage) {
      throw app.httpErrors.badRequest("stageId is not valid for this tenant.");
    }
    await assertCustomerBelongsToTenant(app, tenantId, data.customerId);
    assertValidFollowUpWindow(app, new Date(data.followUpAt), data.closedAt ? new Date(data.closedAt) : null);

    // H9: Validate custom fields against tenant definitions
    const dealCfDefs = await prisma.customFieldDefinition.findMany({
      where: { tenantId, entityType: EntityType.DEAL, isActive: true },
      select: { fieldKey: true, dataType: true, isRequired: true, isActive: true, optionsJson: true }
    });
    const customFields = validateCustomFields(app, dealCfDefs, data.customFields ?? {});

    const created = await prisma.$transaction(async (tx) => {
      const dealCount = await tx.deal.count({ where: { tenantId } });
      const dealNo = `D-${String(dealCount + 1).padStart(6, "0")}`;
      const row = await tx.deal.create({
        data: {
          tenantId,
          ownerId,
          dealNo,
          dealName: data.dealName,
          customerId: data.customerId,
          stageId: data.stageId,
          estimatedValue: data.estimatedValue,
          followUpAt: new Date(data.followUpAt),
          closedAt: data.closedAt ? new Date(data.closedAt) : null,
          customFields
        }
      });
      await writeEntityChangelog({
        db: tx,
        tenantId,
        entityType: EntityType.DEAL,
        entityId: row.id,
        action: "CREATE",
        changedById: ownerId,
        after: row
      });
      return row;
    });

    sendDealLineNotification({ tenantId, ownerId, dealId: created.id, status: "CREATED" })
      .catch(err => console.error("[deals] create notification error", err));

    return reply.code(201).send(created);
  });

  app.patch("/deals/:id", async (request) => {
    const tenantId = requireTenantId(request);
    const actorId = requireUserId(request);
    const visibleUserIdList = [...(await listVisibleUserIds(request))];
    const params = request.params as { id: string };
    const parsed = updateDealSchema.safeParse(request.body);
    if (!parsed.success) {
      throw app.httpErrors.badRequest(zodMsg(parsed.error));
    }
    const deal = await prisma.deal.findFirst({
      where: { id: params.id, tenantId, ownerId: { in: visibleUserIdList } }
    });
    if (!deal) {
      throw app.httpErrors.notFound("Deal not found.");
    }

    if (parsed.data.stageId) {
      const stage = await prisma.dealStage.findFirst({
        where: { id: parsed.data.stageId, tenantId },
        select: { id: true }
      });
      if (!stage) {
        throw app.httpErrors.badRequest("stageId is not valid for this tenant.");
      }
    }
    if (parsed.data.customerId) {
      await assertCustomerBelongsToTenant(app, tenantId, parsed.data.customerId);
    }

    const nextClosedAt =
      parsed.data.closedAt === undefined
        ? deal.closedAt
        : parsed.data.closedAt
          ? new Date(parsed.data.closedAt)
          : null;
    const nextFollowUpAt =
      parsed.data.followUpAt === undefined ? deal.followUpAt : new Date(parsed.data.followUpAt);
    assertValidFollowUpWindow(app, nextFollowUpAt, nextClosedAt);

    if (parsed.data.estimatedValue !== undefined) {
      const quotationCount = await prisma.quotation.count({
        where: { tenantId, dealId: params.id }
      });
      if (quotationCount > 0) {
        throw app.httpErrors.badRequest(
          "estimatedValue is auto-calculated from latest quotation once quotations exist."
        );
      }
    }

    // H9: Validate custom fields if provided
    let customFields: import("@prisma/client").Prisma.InputJsonValue | undefined;
    if (parsed.data.customFields !== undefined) {
      const dealCfDefs = await prisma.customFieldDefinition.findMany({
        where: { tenantId, entityType: EntityType.DEAL, isActive: true },
        select: { fieldKey: true, dataType: true, isRequired: true, isActive: true, optionsJson: true }
      });
      customFields = validateCustomFields(app, dealCfDefs, {
        ...asRecord(deal.customFields),
        ...parsed.data.customFields
      });
    }

    return prisma.$transaction(async (tx) => {
      const updated = await tx.deal.update({
        where: { id: params.id },
        data: {
          ...parsed.data,
          ...(customFields !== undefined ? { customFields } : {}),
          followUpAt: parsed.data.followUpAt ? new Date(parsed.data.followUpAt) : undefined,
          closedAt: parsed.data.closedAt ? new Date(parsed.data.closedAt) : undefined
        }
      });
      await writeEntityChangelog({
        db: tx,
        tenantId,
        entityType: EntityType.DEAL,
        entityId: updated.id,
        action: "UPDATE",
        changedById: actorId,
        before: deal,
        after: updated
      });
      return updated;
    });
  });

  app.patch("/deals/:id/stage", async (request) => {
    const tenantId = requireTenantId(request);
    const actorId = requireUserId(request);
    const visibleUserIdList = [...(await listVisibleUserIds(request))];
    const params = request.params as { id: string };
    const parsed = moveStageSchema.safeParse(request.body);
    if (!parsed.success) {
      throw app.httpErrors.badRequest(zodMsg(parsed.error));
    }

    const deal = await prisma.deal.findFirst({
      where: { id: params.id, tenantId, ownerId: { in: visibleUserIdList } },
      include: {
        stage: true
      }
    });
    if (!deal) {
      throw app.httpErrors.notFound("Deal not found.");
    }

    const targetStage = await prisma.dealStage.findFirst({
      where: { id: parsed.data.stageId, tenantId }
    });
    if (!targetStage) {
      throw app.httpErrors.badRequest("Target stage does not exist in this tenant.");
    }

    const canMove = isStageTransitionAllowed(deal.stage, targetStage);
    if (!canMove) {
      throw app.httpErrors.badRequest(
        "Stage movement is not allowed by this tenant's kanban transition rules."
      );
    }

    const nextStatus = targetStage.isClosedWon
      ? DealStatus.WON
      : targetStage.isClosedLost
        ? DealStatus.LOST
        : DealStatus.OPEN;

    if (nextStatus === DealStatus.LOST && !parsed.data.lostNote?.trim()) {
      throw app.httpErrors.badRequest("Lost reason is required when moving a deal to a Lost stage.");
    }

    const updated = await prisma.$transaction(async (tx) => {
      const result = await tx.deal.update({
        where: { id: params.id },
        data: {
          stageId: targetStage.id,
          status: nextStatus,
          closedAt: nextStatus === DealStatus.OPEN ? null : deal.closedAt ?? new Date(),
          ...(nextStatus === DealStatus.LOST ? { lostNote: parsed.data.lostNote } : {})
        }
      });
      await writeEntityChangelog({
        db: tx,
        tenantId,
        entityType: EntityType.DEAL,
        entityId: result.id,
        action: "UPDATE",
        changedById: actorId,
        before: { stageId: deal.stageId, status: deal.status, closedAt: deal.closedAt },
        after: { stageId: result.stageId, status: result.status, closedAt: result.closedAt },
        context: { workflow: "MOVE_STAGE" }
      });
      return result;
    });

    if (nextStatus === DealStatus.WON || nextStatus === DealStatus.LOST) {
      // H8: log errors from fire-and-forget notifications so failures are visible in server logs.
      sendDealLineNotification({ tenantId, ownerId: actorId, dealId: params.id, status: nextStatus })
        .catch(err => console.error("[deals] move-stage notification error", err));
    }

    return updated;
  });

  app.get("/deals/:id/progress-updates", async (request) => {
    const tenantId = requireTenantId(request);
    const visibleUserIdList = [...(await listVisibleUserIds(request))];
    const params = request.params as { id: string };
    const deal = await prisma.deal.findFirst({
      where: { id: params.id, tenantId, ownerId: { in: visibleUserIdList } },
      select: { id: true }
    });
    if (!deal) {
      throw app.httpErrors.notFound("Deal not found.");
    }
    return prisma.dealProgressUpdate.findMany({
      where: { dealId: params.id },
      include: {
        createdBy: {
          select: {
            id: true,
            fullName: true,
            email: true,
            role: true
          }
        }
      },
      orderBy: { createdAt: "desc" }
    });
  });

  app.post("/deals/:id/progress-updates", async (request, reply) => {
    const tenantId = requireTenantId(request);
    const createdById = requireUserId(request);
    const visibleUserIdList = [...(await listVisibleUserIds(request))];
    const params = request.params as { id: string };
    const parsed = progressSchema.safeParse(request.body);
    if (!parsed.success) {
      throw app.httpErrors.badRequest(zodMsg(parsed.error));
    }

    const deal = await prisma.deal.findFirst({
      where: { id: params.id, tenantId, ownerId: { in: visibleUserIdList } },
      select: { id: true, status: true, followUpAt: true, closedAt: true }
    });
    if (!deal) {
      throw app.httpErrors.notFound("Deal not found.");
    }

    const nextFollowUpAt = parsed.data.followUpAt ? new Date(parsed.data.followUpAt) : deal.followUpAt;
    assertValidFollowUpWindow(app, nextFollowUpAt, deal.closedAt);

    const row = await prisma.$transaction(async (tx) => {
      if (parsed.data.followUpAt) {
        await tx.deal.update({
          where: { id: params.id },
          data: { followUpAt: nextFollowUpAt }
        });
      }

      return tx.dealProgressUpdate.create({
        data: {
          dealId: params.id,
          createdById,
          note: parsed.data.note,
          attachmentUrls: parsed.data.attachmentUrls ?? []
        },
        include: {
          createdBy: {
            select: {
              id: true,
              fullName: true,
              email: true,
              role: true
            }
          }
        }
      });
    });

    return reply.code(201).send({
      ...row,
      follow_up_scheduled_at: parsed.data.followUpAt ?? undefined,
      create_visit_option: {
        allowed: deal.status === DealStatus.OPEN,
        skip_allowed: true,
        suggested_planned_at: nextFollowUpAt.toISOString(),
        endpoint: `/api/v1/deals/${params.id}/progress-updates/${row.id}/create-visit`
      }
    });
  });

  app.post("/deals/:id/progress-updates/:updateId/create-visit", async (request, reply) => {
    const tenantId = requireTenantId(request);
    const repId = requireUserId(request);
    const visibleUserIdList = [...(await listVisibleUserIds(request))];
    const params = request.params as { id: string; updateId: string };
    const parsed = createVisitFromProgressSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      throw app.httpErrors.badRequest(zodMsg(parsed.error));
    }
    const deal = await prisma.deal.findFirst({
      where: { id: params.id, tenantId, ownerId: { in: visibleUserIdList } }
    });
    if (!deal) {
      throw app.httpErrors.notFound("Deal not found.");
    }
    if (deal.status !== DealStatus.OPEN) {
      throw app.httpErrors.badRequest("Cannot create visit from progress update on a closed deal.");
    }
    const progressUpdate = await prisma.dealProgressUpdate.findFirst({
      where: { id: params.updateId, dealId: params.id },
      select: { id: true }
    });
    if (!progressUpdate) {
      throw app.httpErrors.notFound("Progress update not found for this deal.");
    }

    const visit = await prisma.$transaction(async (tx) => {
      const createdVisit = await tx.visit.create({
        data: {
          tenantId,
          repId,
          customerId: deal.customerId,
          dealId: deal.id,
          visitType: "PLANNED",
          plannedAt: parsed.data.plannedAt ? new Date(parsed.data.plannedAt) : deal.followUpAt,
          objective:
            parsed.data.objective ?? `Follow-up from deal progress update ${params.updateId}`
        }
      });
      await writeEntityChangelog({
        db: tx,
        tenantId,
        entityType: EntityType.VISIT,
        entityId: createdVisit.id,
        action: "CREATE",
        changedById: repId,
        after: createdVisit,
        context: { source: "deal_progress_update", dealId: params.id, updateId: params.updateId }
      });
      return createdVisit;
    });
    return reply.code(201).send(visit);
  });

  app.patch("/deals/:id/close", async (request) => {
    const tenantId = requireTenantId(request);
    const actorId = requireUserId(request);
    const visibleUserIdList = [...(await listVisibleUserIds(request))];
    const params = request.params as { id: string };
    const body = request.body as { outcome: "won" | "lost"; closedAt?: string };
    const status = body.outcome === "won" ? DealStatus.WON : DealStatus.LOST;
    const deal = await prisma.deal.findFirst({
      where: { id: params.id, tenantId, ownerId: { in: visibleUserIdList } }
    });
    if (!deal) {
      throw app.httpErrors.notFound("Deal not found.");
    }
    const updated = await prisma.$transaction(async (tx) => {
      const result = await tx.deal.update({
        where: { id: params.id },
        data: {
          status,
          closedAt: body.closedAt ? new Date(body.closedAt) : new Date()
        }
      });
      await writeEntityChangelog({
        db: tx,
        tenantId,
        entityType: EntityType.DEAL,
        entityId: result.id,
        action: "UPDATE",
        changedById: actorId,
        before: { status: deal.status, closedAt: deal.closedAt },
        after: { status: result.status, closedAt: result.closedAt },
        context: { workflow: "CLOSE_DEAL", outcome: body.outcome }
      });
      return result;
    });

    sendDealLineNotification({ tenantId, ownerId: actorId, dealId: params.id, status })
      .catch(err => console.error("[deals] close notification error", err));

    return updated;
  });

  app.delete("/deals/:id", async (request, reply) => {
    const tenantId = requireTenantId(request);
    const actorId = requireUserId(request);
    const visibleUserIdList = [...(await listVisibleUserIds(request))];
    const params = request.params as { id: string };
    const deal = await prisma.deal.findFirst({
      where: { id: params.id, tenantId, ownerId: { in: visibleUserIdList } }
    });
    if (!deal) {
      throw app.httpErrors.notFound("Deal not found.");
    }
    await prisma.$transaction(async (tx) => {
      await tx.deal.delete({ where: { id: params.id } });
      await writeEntityChangelog({
        db: tx,
        tenantId,
        entityType: EntityType.DEAL,
        entityId: params.id,
        action: "DELETE",
        changedById: actorId,
        before: deal
      });
    });
    return reply.code(204).send();
  });

  app.post("/deals/:id/quotations", async (request, reply) => {
    const tenantId = requireTenantId(request);
    const visibleUserIdList = [...(await listVisibleUserIds(request))];
    const params = request.params as { id: string };
    const parsed = quotationCreateSchema.safeParse(request.body);
    if (!parsed.success) {
      throw app.httpErrors.badRequest(zodMsg(parsed.error));
    }

    const deal = await prisma.deal.findFirst({
      where: { id: params.id, tenantId },
      select: { id: true, customerId: true, ownerId: true }
    });
    if (!deal) {
      throw app.httpErrors.notFound("Deal not found.");
    }
    if (!visibleUserIdList.includes(deal.ownerId)) {
      throw app.httpErrors.notFound("Deal not found.");
    }

    const payload = parsed.data;
    if (payload.customerId !== deal.customerId) {
      throw app.httpErrors.badRequest("Quotation customer must match deal customer.");
    }

    const [paymentTerm, customer, lineItems, taxConfig] = await Promise.all([
      prisma.paymentTerm.findFirst({
        where: { id: payload.paymentTermId, tenantId, isActive: true },
        select: { id: true }
      }),
      prisma.customer.findFirst({
        where: { id: payload.customerId, tenantId },
        select: { id: true }
      }),
      resolveQuotationItems(app, tenantId, payload.items),
      prisma.tenantTaxConfig.findUnique({ where: { tenantId } })
    ]);
    if (!paymentTerm) {
      throw app.httpErrors.badRequest("paymentTermId is invalid or inactive for this tenant.");
    }
    if (!customer) {
      throw app.httpErrors.badRequest("customerId is invalid for this tenant.");
    }

    if (payload.billingAddressId) {
      const billingAddress = await prisma.customerAddress.findFirst({
        where: { id: payload.billingAddressId, customerId: payload.customerId }
      });
      if (!billingAddress) {
        throw app.httpErrors.badRequest("billingAddressId must belong to the quotation customer.");
      }
    }
    if (payload.shippingAddressId) {
      const shippingAddress = await prisma.customerAddress.findFirst({
        where: { id: payload.shippingAddressId, customerId: payload.customerId }
      });
      if (!shippingAddress) {
        throw app.httpErrors.badRequest("shippingAddressId must belong to the quotation customer.");
      }
    }

    const totals = calculateQuotationTotals(lineItems, taxConfig);
    const quotation = await prisma.$transaction(async (tx) => {
      const created = await tx.quotation.create({
        data: {
          tenantId,
          dealId: params.id,
          quotationNo: payload.quotationNo,
          customerId: payload.customerId,
          paymentTermId: payload.paymentTermId,
          billingAddressId: payload.billingAddressId,
          shippingAddressId: payload.shippingAddressId,
          validTo: new Date(payload.validTo),
          ...totals,
          items: {
            create: lineItems
          }
        },
        include: {
          items: true,
          paymentTerm: true
        }
      });

      await tx.deal.update({
        where: { id: params.id },
        data: { estimatedValue: created.grandTotal }
      });

      return created;
    });

    return reply.code(201).send(quotation);
  });

  app.get("/deals/:id/quotations", async (request) => {
    const tenantId = requireTenantId(request);
    const visibleUserIdList = [...(await listVisibleUserIds(request))];
    const params = request.params as { id: string };
    const deal = await prisma.deal.findFirst({
      where: { id: params.id, tenantId, ownerId: { in: visibleUserIdList } },
      select: { id: true }
    });
    if (!deal) {
      throw app.httpErrors.notFound("Deal not found.");
    }
    return prisma.quotation.findMany({
      where: { tenantId, dealId: params.id },
      include: {
        paymentTerm: true,
        items: true,
        billingAddress: true,
        shippingAddress: true
      },
      orderBy: { createdAt: "desc" }
    });
  });

  app.post("/deals/:id/items", async (request) => {
    const tenantId = requireTenantId(request);
    const visibleUserIdList = [...(await listVisibleUserIds(request))];
    const params = request.params as { id: string };
    const parsed = dealItemsAssignSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      throw app.httpErrors.badRequest(zodMsg(parsed.error));
    }

    const deal = await prisma.deal.findFirst({
      where: { id: params.id, tenantId, ownerId: { in: visibleUserIdList } },
      select: { id: true }
    });
    if (!deal) {
      throw app.httpErrors.notFound("Deal not found.");
    }

    const quotation = parsed.data.quotationId
      ? await prisma.quotation.findFirst({
          where: { id: parsed.data.quotationId, tenantId, dealId: params.id },
          select: { id: true, grandTotal: true }
        })
      : await prisma.quotation.findFirst({
          where: { tenantId, dealId: params.id },
          orderBy: { createdAt: "desc" },
          select: { id: true, grandTotal: true }
        });
    if (!quotation) {
      throw app.httpErrors.badRequest("No quotation found to derive deal value.");
    }

    const updated = await prisma.deal.update({
      where: { id: params.id },
      data: { estimatedValue: quotation.grandTotal }
    });
    return {
      deal: updated,
      sourceQuotationId: quotation.id
    };
  });

  app.get("/quotations/:id", async (request) => {
    const tenantId = requireTenantId(request);
    const visibleUserIdList = [...(await listVisibleUserIds(request))];
    const params = request.params as { id: string };
    const quotation = await prisma.quotation.findFirst({
      where: { id: params.id, tenantId, deal: { ownerId: { in: visibleUserIdList } } },
      include: {
        deal: true,
        customer: {
          include: {
            addresses: true
          }
        },
        paymentTerm: true,
        billingAddress: true,
        shippingAddress: true,
        items: true
      }
    });
    if (!quotation) {
      throw app.httpErrors.notFound("Quotation not found.");
    }
    return quotation;
  });

  app.patch("/quotations/:id/status", async (request) => {
    const tenantId = requireTenantId(request);
    const visibleUserIdList = [...(await listVisibleUserIds(request))];
    const params = request.params as { id: string };
    const parsed = quotationStatusPatchSchema.safeParse(request.body);
    if (!parsed.success) {
      throw app.httpErrors.badRequest(zodMsg(parsed.error));
    }

    const quotation = await prisma.quotation.findFirst({
      where: { id: params.id, tenantId, deal: { ownerId: { in: visibleUserIdList } } },
      select: { id: true }
    });
    if (!quotation) {
      throw app.httpErrors.notFound("Quotation not found.");
    }

    return prisma.quotation.update({
      where: { id: params.id },
      data: { status: parsed.data.status },
      include: {
        deal: { select: { id: true, dealNo: true, dealName: true } },
        paymentTerm: true,
        items: true
      }
    });
  });

  app.post("/quotations/:id/items", async (request) => {
    const tenantId = requireTenantId(request);
    const visibleUserIdList = [...(await listVisibleUserIds(request))];
    const params = request.params as { id: string };
    const parsed = quotationItemsUpsertSchema.safeParse(request.body);
    if (!parsed.success) {
      throw app.httpErrors.badRequest(zodMsg(parsed.error));
    }

    const quotation = await prisma.quotation.findFirst({
      where: { id: params.id, tenantId, deal: { ownerId: { in: visibleUserIdList } } },
      select: { id: true, dealId: true }
    });
    if (!quotation) {
      throw app.httpErrors.notFound("Quotation not found.");
    }

    const [lineItems, taxConfig] = await Promise.all([
      resolveQuotationItems(app, tenantId, parsed.data.items),
      prisma.tenantTaxConfig.findUnique({ where: { tenantId } })
    ]);
    const totals = calculateQuotationTotals(lineItems, taxConfig);

    return prisma.$transaction(async (tx) => {
      await tx.quotationItem.deleteMany({
        where: { quotationId: params.id }
      });

      await tx.quotationItem.createMany({
        data: lineItems.map((item) => ({
          quotationId: params.id,
          ...item
        }))
      });

      const updatedQuotation = await tx.quotation.update({
        where: { id: params.id },
        data: totals,
        include: { items: true }
      });

      await tx.deal.update({
        where: { id: quotation.dealId },
        data: { estimatedValue: updatedQuotation.grandTotal }
      });

      return updatedQuotation;
    });
  });

  app.get("/tenants/:id/quotation-form-config", async (request) => {
    const params = request.params as { id: string };
    requireRoleAtLeast(request, UserRole.MANAGER);
    assertTenantPathAccess(request, params.id);

    const config = await prisma.quotationFormConfig.findUnique({
      where: { tenantId: params.id }
    });
    if (!config) {
      return {
        tenantId: params.id,
        header: DEFAULT_QUOTATION_HEADER_LAYOUT,
        item: DEFAULT_QUOTATION_ITEM_LAYOUT
      };
    }
    return {
      tenantId: params.id,
      header: config.headerLayoutJson,
      item: config.itemLayoutJson
    };
  });

  app.put("/tenants/:id/quotation-form-config", async (request) => {
    const params = request.params as { id: string };
    requireRoleAtLeast(request, UserRole.ADMIN);
    assertTenantPathAccess(request, params.id);
    const parsed = quotationFormConfigSchema.safeParse(request.body);
    if (!parsed.success) {
      throw app.httpErrors.badRequest(zodMsg(parsed.error));
    }

    const header = normalizeLayoutFields(parsed.data.header);
    const item = normalizeLayoutFields(parsed.data.item);
    const hasDuplicateHeaderKeys = new Set(header.map((field) => field.fieldKey)).size !== header.length;
    const hasDuplicateItemKeys = new Set(item.map((field) => field.fieldKey)).size !== item.length;
    if (hasDuplicateHeaderKeys || hasDuplicateItemKeys) {
      throw app.httpErrors.badRequest("Layout fields must be unique within each section.");
    }

    const saved = await prisma.quotationFormConfig.upsert({
      where: { tenantId: params.id },
      update: {
        headerLayoutJson: header as unknown as Prisma.InputJsonValue,
        itemLayoutJson: item as unknown as Prisma.InputJsonValue
      },
      create: {
        tenantId: params.id,
        headerLayoutJson: header as unknown as Prisma.InputJsonValue,
        itemLayoutJson: item as unknown as Prisma.InputJsonValue
      }
    });

    return {
      tenantId: params.id,
      header: saved.headerLayoutJson,
      item: saved.itemLayoutJson
    };
  });
};
