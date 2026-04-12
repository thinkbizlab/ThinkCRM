import { UserRole } from "@prisma/client";
import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { requireRoleAtLeast, requireTenantId } from "../../lib/http.js";
import { prisma } from "../../lib/prisma.js";
import { recordStripeWebhookAndSyncSubscription } from "../../lib/stripe-webhook.js";
import { updateSubscriptionSeatCount } from "../../lib/subscription-seats.js";

const captureSubscriptionSchema = z.object({
  seatPriceCents: z.number().int().positive(),
  seatCount: z.number().int().positive(),
  currency: z.string().length(3),
  paymentMethodRef: z.string().min(3),
  externalCustomerId: z.string().optional(),
  billingCycle: z.enum(["MONTHLY", "YEARLY"]).default("MONTHLY")
});

const seatUpdateSchema = z.object({
  seatCount: z.number().int().positive(),
  effectiveAt: z.string().datetime().optional()
});

const storageRecordSchema = z.object({
  usageDate: z.string().min(7),
  totalBytes: z.number().int().nonnegative()
});

const monthlyInvoiceQuerySchema = z.object({
  month: z
    .string()
    .regex(/^\d{4}-\d{2}$/)
    .optional()
});

const finalizeInvoiceSchema = z.object({
  month: z
    .string()
    .regex(/^\d{4}-\d{2}$/)
    .optional()
});

function addDays(base: Date, days: number): Date {
  const next = new Date(base);
  next.setDate(next.getDate() + days);
  return next;
}

function cycleDays(cycle: "MONTHLY" | "YEARLY"): number {
  return cycle === "YEARLY" ? 365 : 30;
}

function startOfMonth(month?: string): Date {
  if (!month) {
    const now = new Date();
    return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  }
  const [yearPart = "", monthPart = ""] = month.split("-");
  const year = Number(yearPart);
  const monthIndex = Number(monthPart) - 1;
  if (!Number.isInteger(year) || !Number.isInteger(monthIndex) || monthIndex < 0 || monthIndex > 11) {
    throw new Error("Invalid month format.");
  }
  return new Date(Date.UTC(year, monthIndex, 1));
}

function endOfMonth(start: Date): Date {
  return new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 0, 23, 59, 59, 999));
}

function asDateKey(value: Date): string {
  return value.toISOString().slice(0, 10);
}

type MonthlyInvoicePreview = {
  currency: string;
  month: string;
  periodStart: string;
  periodEnd: string;
  lineItems: {
    seatsBaseCents: number;
    storageOverageCents: number;
    prorationAdjustmentsCents: number;
  };
  seatSnapshot: {
    seatCount: number;
    seatPriceCents: number;
  };
  totalDueCents: number;
};

async function buildMonthlyInvoicePreview(tenantId: string, month?: string): Promise<MonthlyInvoicePreview | null> {
  const subscription = await prisma.subscription.findFirst({
    where: { tenantId },
    orderBy: { createdAt: "desc" }
  });
  if (!subscription) {
    return null;
  }

  const periodStart = startOfMonth(month);
  const periodEnd = endOfMonth(periodStart);
  const fromDateKey = asDateKey(periodStart);
  const toDateKey = asDateKey(periodEnd);

  const storageRows = await prisma.tenantStorageUsageDaily.findMany({
    where: {
      tenantId,
      usageDate: {
        gte: fromDateKey,
        lte: toDateKey
      }
    }
  });
  const storageOverageCents = storageRows.reduce((sum, row) => sum + row.estimatedOverageAmount, 0);

  const prorationRows = await prisma.subscriptionProrationEvent.findMany({
    where: {
      tenantId,
      effectiveAt: {
        gte: periodStart,
        lte: periodEnd
      }
    }
  });
  const prorationAdjustmentsCents = prorationRows.reduce((sum, row) => sum + row.proratedAmountCents, 0);

  const seatBaseCents = subscription.seatCount * subscription.seatPriceCents;
  const totalDueCents = seatBaseCents + storageOverageCents + prorationAdjustmentsCents;

  return {
    currency: subscription.currency,
    month: month ?? asDateKey(periodStart).slice(0, 7),
    periodStart: fromDateKey,
    periodEnd: toDateKey,
    lineItems: {
      seatsBaseCents: seatBaseCents,
      storageOverageCents,
      prorationAdjustmentsCents
    },
    seatSnapshot: {
      seatCount: subscription.seatCount,
      seatPriceCents: subscription.seatPriceCents
    },
    totalDueCents
  };
}

export const billingRoutes: FastifyPluginAsync = async (app) => {
  app.post("/billing/stripe/webhooks", async (request, reply) => {
    try {
      const result = await recordStripeWebhookAndSyncSubscription(prisma, request.body);
      return reply.code(200).send(result);
    } catch (error) {
      if (error instanceof Error && error.message === "INVALID_WEBHOOK_BODY") {
        throw app.httpErrors.badRequest("Invalid webhook body.");
      }
      throw error;
    }
  });

  app.get("/billing/subscription", async (request) => {
    requireRoleAtLeast(request, UserRole.MANAGER);
    const tenantId = requireTenantId(request);

    const subscription = await prisma.subscription.findFirst({
      where: { tenantId },
      orderBy: { createdAt: "desc" }
    });
    if (!subscription) {
      throw app.httpErrors.notFound("Subscription not found.");
    }
    return subscription;
  });

  app.put("/billing/subscription/capture", async (request) => {
    requireRoleAtLeast(request, UserRole.ADMIN);
    const tenantId = requireTenantId(request);
    const parsed = captureSubscriptionSchema.safeParse(request.body);
    if (!parsed.success) {
      throw app.httpErrors.badRequest(parsed.error.message);
    }

    const current = await prisma.subscription.findFirst({
      where: { tenantId },
      orderBy: { createdAt: "desc" }
    });
    if (!current) {
      throw app.httpErrors.notFound("Subscription not found.");
    }

    return prisma.subscription.update({
      where: { id: current.id },
      data: {
        pricingModel: "FIXED_PER_USER",
        status: "ACTIVE",
        seatPriceCents: parsed.data.seatPriceCents,
        seatCount: parsed.data.seatCount,
        currency: parsed.data.currency.toUpperCase(),
        paymentMethodRef: parsed.data.paymentMethodRef,
        externalCustomerId: parsed.data.externalCustomerId,
        billingCycle: parsed.data.billingCycle,
        billingPeriodStart: new Date(),
        billingPeriodEnd: addDays(new Date(), cycleDays(parsed.data.billingCycle))
      }
    });
  });

  app.patch("/billing/subscription/seats", async (request) => {
    requireRoleAtLeast(request, UserRole.ADMIN);
    const tenantId = requireTenantId(request);
    const parsed = seatUpdateSchema.safeParse(request.body);
    if (!parsed.success) {
      throw app.httpErrors.badRequest(parsed.error.message);
    }

    try {
      return await updateSubscriptionSeatCount(prisma, {
        tenantId,
        seatCount: parsed.data.seatCount,
        effectiveAt: parsed.data.effectiveAt ? new Date(parsed.data.effectiveAt) : undefined
      });
    } catch (error) {
      if (error instanceof Error && error.message === "SUBSCRIPTION_NOT_FOUND") {
        throw app.httpErrors.notFound("Subscription not found.");
      }
      throw error;
    }
  });

  app.get("/billing/storage/usage", async (request) => {
    requireRoleAtLeast(request, UserRole.MANAGER);
    const tenantId = requireTenantId(request);

    const rows = await prisma.tenantStorageUsageDaily.findMany({
      where: { tenantId },
      orderBy: { usageDate: "desc" }
    });
    return rows.map((row) => ({
      ...row,
      totalBytes: row.totalBytes.toString(),
      overageBytes: row.overageBytes.toString()
    }));
  });

  app.post("/billing/storage/usage/record", async (request) => {
    requireRoleAtLeast(request, UserRole.ADMIN);
    const tenantId = requireTenantId(request);
    const parsed = storageRecordSchema.safeParse(request.body);
    if (!parsed.success) {
      throw app.httpErrors.badRequest(parsed.error.message);
    }

    const quota = await prisma.tenantStorageQuota.findFirst({ where: { tenantId } });
    if (!quota) {
      throw app.httpErrors.notFound("Storage quota config not found.");
    }

    const totalBytesBig = BigInt(parsed.data.totalBytes);
    const overageBytes = totalBytesBig > quota.includedBytes ? totalBytesBig - quota.includedBytes : BigInt(0);
    const overageGb = Number(overageBytes) / 1_073_741_824;
    const estimatedOverageAmount = Math.ceil(overageGb * quota.overagePricePerGb);

    const row = await prisma.tenantStorageUsageDaily.upsert({
      where: {
        tenantId_usageDate: {
          tenantId,
          usageDate: parsed.data.usageDate
        }
      },
      update: {
        totalBytes: totalBytesBig,
        overageBytes,
        estimatedOverageAmount
      },
      create: {
        tenantId,
        usageDate: parsed.data.usageDate,
        totalBytes: totalBytesBig,
        overageBytes,
        estimatedOverageAmount
      }
    });
    return {
      ...row,
      totalBytes: row.totalBytes.toString(),
      overageBytes: row.overageBytes.toString()
    };
  });

  app.get("/billing/storage/overage-preview", async (request) => {
    requireRoleAtLeast(request, UserRole.MANAGER);
    const tenantId = requireTenantId(request);

    const quota = await prisma.tenantStorageQuota.findFirst({ where: { tenantId } });
    if (!quota) {
      throw app.httpErrors.notFound("Storage quota config not found.");
    }

    const latest = await prisma.tenantStorageUsageDaily.findFirst({
      where: { tenantId },
      orderBy: { usageDate: "desc" }
    });

    return {
      includedBytes: quota.includedBytes.toString(),
      overagePricePerGb: quota.overagePricePerGb,
      latestUsage: latest
        ? {
            usageDate: latest.usageDate,
            totalBytes: latest.totalBytes.toString(),
            overageBytes: latest.overageBytes.toString(),
            estimatedOverageAmount: latest.estimatedOverageAmount
          }
        : null
    };
  });

  app.get("/billing/invoices/monthly-preview", async (request) => {
    requireRoleAtLeast(request, UserRole.MANAGER);
    const tenantId = requireTenantId(request);
    const parsed = monthlyInvoiceQuerySchema.safeParse(request.query ?? {});
    if (!parsed.success) {
      throw app.httpErrors.badRequest(parsed.error.message);
    }
    const targetMonth = parsed.data.month;
    const invoiceMonth = targetMonth ?? asDateKey(startOfMonth(undefined)).slice(0, 7);

    const finalizedInvoice = await prisma.tenantInvoice.findUnique({
      where: { tenantId_invoiceMonth: { tenantId, invoiceMonth } }
    });
    if (finalizedInvoice?.status === "FINALIZED") {
      return {
        currency: finalizedInvoice.currency,
        month: finalizedInvoice.invoiceMonth,
        periodStart: finalizedInvoice.periodStart,
        periodEnd: finalizedInvoice.periodEnd,
        lineItems: {
          seatsBaseCents: finalizedInvoice.seatsBaseCents,
          storageOverageCents: finalizedInvoice.storageOverageCents,
          prorationAdjustmentsCents: finalizedInvoice.prorationAdjustmentsCents
        },
        seatSnapshot: null,
        totalDueCents: finalizedInvoice.totalDueCents,
        status: finalizedInvoice.status,
        finalizedAt: finalizedInvoice.finalizedAt
      };
    }

    const preview = await buildMonthlyInvoicePreview(tenantId, targetMonth);
    if (!preview) {
      throw app.httpErrors.notFound("Subscription not found.");
    }
    return {
      ...preview,
      status: finalizedInvoice?.status ?? "DRAFT",
      finalizedAt: finalizedInvoice?.finalizedAt ?? null
    };
  });

  app.post("/billing/invoices/finalize", async (request) => {
    requireRoleAtLeast(request, UserRole.ADMIN);
    const tenantId = requireTenantId(request);
    const parsed = finalizeInvoiceSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      throw app.httpErrors.badRequest(parsed.error.message);
    }

    const preview = await buildMonthlyInvoicePreview(tenantId, parsed.data.month);
    if (!preview) {
      throw app.httpErrors.notFound("Subscription not found.");
    }
    const existing = await prisma.tenantInvoice.findUnique({
      where: { tenantId_invoiceMonth: { tenantId, invoiceMonth: preview.month } }
    });
    if (existing?.status === "FINALIZED") {
      throw app.httpErrors.conflict(`Invoice ${preview.month} is already finalized.`);
    }

    const finalized = await prisma.tenantInvoice.upsert({
      where: { tenantId_invoiceMonth: { tenantId, invoiceMonth: preview.month } },
      update: {
        periodStart: preview.periodStart,
        periodEnd: preview.periodEnd,
        currency: preview.currency,
        seatsBaseCents: preview.lineItems.seatsBaseCents,
        storageOverageCents: preview.lineItems.storageOverageCents,
        prorationAdjustmentsCents: preview.lineItems.prorationAdjustmentsCents,
        totalDueCents: preview.totalDueCents,
        status: "FINALIZED",
        finalizedAt: new Date()
      },
      create: {
        tenantId,
        invoiceMonth: preview.month,
        periodStart: preview.periodStart,
        periodEnd: preview.periodEnd,
        currency: preview.currency,
        seatsBaseCents: preview.lineItems.seatsBaseCents,
        storageOverageCents: preview.lineItems.storageOverageCents,
        prorationAdjustmentsCents: preview.lineItems.prorationAdjustmentsCents,
        totalDueCents: preview.totalDueCents,
        status: "FINALIZED",
        finalizedAt: new Date()
      }
    });

    return finalized;
  });

  app.get("/billing/invoices", async (request) => {
    requireRoleAtLeast(request, UserRole.MANAGER);
    const tenantId = requireTenantId(request);
    return prisma.tenantInvoice.findMany({
      where: { tenantId },
      orderBy: { invoiceMonth: "desc" }
    });
  });
};
