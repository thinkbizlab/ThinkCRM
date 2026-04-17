/**
 * S6: Stripe client singleton.
 *
 * All Stripe SDK access goes through this module.
 * When STRIPE_SECRET_KEY is not configured, isStripeConfigured() returns false
 * and callers should gracefully degrade (e.g. skip checkout, show a "contact us" CTA).
 */

import Stripe from "stripe";
import { config } from "../config.js";

let _stripe: InstanceType<typeof Stripe> | null = null;

export function getStripe(): InstanceType<typeof Stripe> {
  if (!_stripe) {
    if (!config.STRIPE_SECRET_KEY) {
      throw new Error("STRIPE_SECRET_KEY is not configured.");
    }
    _stripe = new Stripe(config.STRIPE_SECRET_KEY, { apiVersion: "2026-03-25.dahlia" });
  }
  return _stripe;
}

export function isStripeConfigured(): boolean {
  return Boolean(config.STRIPE_SECRET_KEY);
}

/**
 * Get or create a Stripe Customer for a tenant.
 * Stores the Stripe customer ID on the Tenant row for reuse.
 */
export async function getOrCreateStripeCustomer(
  tenantId: string,
  tenantName: string,
  adminEmail: string,
  prisma: import("@prisma/client").PrismaClient
): Promise<string> {
  const tenant = await prisma.tenant.findUnique({
    where: { id: tenantId },
    select: { stripeCustomerId: true }
  });
  if (tenant?.stripeCustomerId) return tenant.stripeCustomerId;

  const stripe = getStripe();
  const customer = await stripe.customers.create({
    name: tenantName,
    email: adminEmail,
    metadata: { tenantId }
  });

  await prisma.tenant.update({
    where: { id: tenantId },
    data: { stripeCustomerId: customer.id }
  });

  return customer.id;
}
