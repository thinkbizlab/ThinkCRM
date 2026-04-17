/**
 * S7: Plan limits — derives feature gates and seat caps from a tenant's subscription.
 *
 * Until Stripe billing is integrated (S6), limits are derived from subscription status:
 *   TRIALING  — 5 seats, all features enabled (full trial experience)
 *   ACTIVE    — limits from planFeatures JSON, or generous defaults
 *   CANCELED/PAST_DUE — 1 seat, core features only
 *
 * When S6 lands, planFeatures JSON will be written by the Stripe webhook handler and
 * this function will use it without changes to its callers.
 */

import { prisma } from "./prisma.js";

export interface PlanLimits {
  maxSeats:       number;
  maxStorageMB:   number;
  hasVoiceNotes:  boolean;
  hasKpiAlerts:   boolean;
  hasApiAccess:   boolean;
}

const TRIAL_LIMITS: PlanLimits = {
  maxSeats:      5,
  maxStorageMB:  1024,
  hasVoiceNotes: true,
  hasKpiAlerts:  true,
  hasApiAccess:  true,
};

const ACTIVE_DEFAULTS: PlanLimits = {
  maxSeats:      50,
  maxStorageMB:  5120,
  hasVoiceNotes: true,
  hasKpiAlerts:  true,
  hasApiAccess:  true,
};

const RESTRICTED_LIMITS: PlanLimits = {
  maxSeats:      1,
  maxStorageMB:  256,
  hasVoiceNotes: false,
  hasKpiAlerts:  false,
  hasApiAccess:  false,
};

export async function getPlanLimits(tenantId: string): Promise<PlanLimits> {
  const sub = await prisma.subscription.findFirst({
    where: { tenantId },
    select: { status: true, planFeatures: true, seatCount: true }
  });

  if (!sub) return RESTRICTED_LIMITS;

  if (sub.status === "TRIALING") return { ...TRIAL_LIMITS, maxSeats: sub.seatCount };
  if (sub.status === "ACTIVE") {
    const features = sub.planFeatures as Partial<PlanLimits> | null;
    return {
      maxSeats:      features?.maxSeats      ?? sub.seatCount ?? ACTIVE_DEFAULTS.maxSeats,
      maxStorageMB:  features?.maxStorageMB  ?? ACTIVE_DEFAULTS.maxStorageMB,
      hasVoiceNotes: features?.hasVoiceNotes ?? ACTIVE_DEFAULTS.hasVoiceNotes,
      hasKpiAlerts:  features?.hasKpiAlerts  ?? ACTIVE_DEFAULTS.hasKpiAlerts,
      hasApiAccess:  features?.hasApiAccess  ?? ACTIVE_DEFAULTS.hasApiAccess,
    };
  }

  // CANCELED, PAST_DUE, EXPIRED
  return RESTRICTED_LIMITS;
}

/** Throws 402 if the tenant has reached their seat limit. */
export async function assertSeatAvailable(
  tenantId: string,
  httpErrors: { paymentRequired: (msg: string) => Error }
): Promise<void> {
  const [limits, currentCount] = await Promise.all([
    getPlanLimits(tenantId),
    prisma.user.count({ where: { tenantId, isActive: true } })
  ]);
  if (currentCount >= limits.maxSeats) {
    throw httpErrors.paymentRequired(
      `Seat limit reached (${limits.maxSeats} seats). Upgrade your plan to add more users.`
    );
  }
}

/** Throws 402 if voice notes are not available on this plan. */
export function assertVoiceNotesAvailable(
  limits: PlanLimits,
  httpErrors: { paymentRequired: (msg: string) => Error }
): void {
  if (!limits.hasVoiceNotes) {
    throw httpErrors.paymentRequired("Voice notes require an upgraded plan.");
  }
}
