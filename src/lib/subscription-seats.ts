import type { BillingCycle, PrismaClient, Subscription } from "@prisma/client";

const DAY_MS = 24 * 60 * 60 * 1000;

function addDays(base: Date, days: number): Date {
  const next = new Date(base);
  next.setDate(next.getDate() + days);
  return next;
}

function cycleDays(cycle: BillingCycle): number {
  return cycle === "YEARLY" ? 365 : 30;
}

function resolvePeriodBounds(subscription: {
  billingCycle: BillingCycle;
  billingPeriodStart: Date;
  billingPeriodEnd: Date;
}): { periodStart: Date; periodEnd: Date } {
  const periodStart = subscription.billingPeriodStart ?? new Date();
  const periodEnd =
    subscription.billingPeriodEnd ?? addDays(periodStart, cycleDays(subscription.billingCycle ?? "MONTHLY"));
  return { periodStart, periodEnd };
}

export async function updateSubscriptionSeatCount(
  db: PrismaClient,
  input: { tenantId: string; seatCount: number; effectiveAt?: Date }
): Promise<{ updatedSubscription: Subscription; prorationEvent: { id: string } }> {
  const current = await db.subscription.findFirst({
    where: { tenantId: input.tenantId },
    orderBy: { createdAt: "desc" }
  });
  if (!current) {
    throw new Error("SUBSCRIPTION_NOT_FOUND");
  }

  const effectiveAt = input.effectiveAt ?? new Date();
  const { periodStart, periodEnd } = resolvePeriodBounds({
    billingCycle: current.billingCycle,
    billingPeriodStart: current.billingPeriodStart,
    billingPeriodEnd: current.billingPeriodEnd
  });
  const totalPeriodDays = Math.max(1, Math.ceil((periodEnd.getTime() - periodStart.getTime()) / DAY_MS));
  const daysRemaining = Math.max(0, Math.ceil((periodEnd.getTime() - effectiveAt.getTime()) / DAY_MS));
  const seatDelta = input.seatCount - current.seatCount;
  const proratedAmountCents = Math.round((seatDelta * current.seatPriceCents * daysRemaining) / totalPeriodDays);

  return db.$transaction(async (tx) => {
    const updatedSubscription = await tx.subscription.update({
      where: { id: current.id },
      data: { seatCount: input.seatCount }
    });
    const prorationEvent = await tx.subscriptionProrationEvent.create({
      data: {
        tenantId: input.tenantId,
        subscriptionId: current.id,
        oldSeatCount: current.seatCount,
        newSeatCount: input.seatCount,
        seatDelta,
        daysRemaining,
        totalPeriodDays,
        proratedAmountCents,
        effectiveAt
      }
    });
    return { updatedSubscription, prorationEvent };
  });
}
