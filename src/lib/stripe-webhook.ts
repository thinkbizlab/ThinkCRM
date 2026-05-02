import type { PrismaClient, SubscriptionStatus } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { config } from "../config.js";
import { getStripe } from "./stripe.js";

const legacyBodySchema = z.object({
  eventType: z.string().min(1),
  tenantId: z.string().cuid().optional(),
  subscriptionId: z.string().cuid().optional(),
  status: z.enum(["TRIALING", "ACTIVE", "PAST_DUE", "CANCELED"]).optional()
});

const stripeEnvelopeSchema = z
  .object({
    id: z.string().min(1).optional(),
    type: z.string().min(1).optional(),
    data: z
      .object({
        object: z.record(z.string(), z.unknown()).optional()
      })
      .optional()
  })
  .passthrough();

/**
 * Ensures webhook payloads are authentic. In production, STRIPE_WEBHOOK_SECRET must be set
 * and every request must include a valid Stripe-Signature over the raw body.
 */
function assertStripeWebhookVerified(rawBody: unknown, stripeSignature?: string): void {
  if (config.NODE_ENV === "production") {
    if (!config.STRIPE_WEBHOOK_SECRET) {
      throw new Error("STRIPE_WEBHOOK_SECRET is required in production.");
    }
    if (typeof rawBody !== "string" || !stripeSignature) {
      throw new Error("INVALID_WEBHOOK_BODY");
    }
    try {
      getStripe().webhooks.constructEvent(rawBody, stripeSignature, config.STRIPE_WEBHOOK_SECRET);
    } catch {
      throw new Error("INVALID_WEBHOOK_BODY");
    }
    return;
  }

  // Development / test: verify when all pieces are present; otherwise accept (local fixtures).
  if (config.STRIPE_WEBHOOK_SECRET && stripeSignature && typeof rawBody === "string") {
    try {
      getStripe().webhooks.constructEvent(rawBody, stripeSignature, config.STRIPE_WEBHOOK_SECRET);
    } catch {
      throw new Error("INVALID_WEBHOOK_BODY");
    }
  }
}

function mapStripeSubscriptionStatus(raw: string | undefined): SubscriptionStatus | null {
  if (!raw) return null;
  switch (raw) {
    case "active":
      return "ACTIVE";
    case "trialing":
      return "TRIALING";
    case "past_due":
      return "PAST_DUE";
    case "canceled":
    case "unpaid":
    case "incomplete_expired":
      return "CANCELED";
    default:
      return null;
  }
}

export async function recordStripeWebhookAndSyncSubscription(
  db: PrismaClient,
  rawBody: unknown,
  stripeSignature?: string
): Promise<{
  received: boolean;
  duplicate?: boolean;
  eventId?: string | null;
  subscriptionId?: string | null;
  statusApplied?: SubscriptionStatus | null;
}> {
  assertStripeWebhookVerified(rawBody, stripeSignature);

  // Parse the verified (or unverified-dev) body as JSON if it arrived as a string.
  const body = typeof rawBody === "string" ? JSON.parse(rawBody) : rawBody;

  const legacy = legacyBodySchema.safeParse(body);
  if (legacy.success) {
    const body = legacy.data;
    const eventId =
      body.subscriptionId || body.tenantId
        ? `legacy:${body.eventType}:${body.subscriptionId ?? body.tenantId}`
        : `legacy:${body.eventType}:${randomUUID()}`;
    try {
      await db.stripeWebhookDelivery.create({
        data: {
          eventId,
          eventType: body.eventType,
          tenantId: body.tenantId ?? null
        }
      });
    } catch {
      return { received: true, duplicate: true, eventId };
    }

    const subscription = body.subscriptionId
      ? await db.subscription.findUnique({ where: { id: body.subscriptionId } })
      : body.tenantId
        ? await db.subscription.findFirst({
            where: { tenantId: body.tenantId },
            orderBy: { createdAt: "desc" }
          })
        : null;

    if (subscription && body.status) {
      await db.subscription.update({
        where: { id: subscription.id },
        data: { status: body.status }
      });
    }

    return {
      received: true,
      eventId,
      subscriptionId: subscription?.id ?? null,
      statusApplied: body.status ?? null
    };
  }

  const envelope = stripeEnvelopeSchema.safeParse(body);
  if (!envelope.success) {
    throw new Error("INVALID_WEBHOOK_BODY");
  }
  const payload = envelope.data;
  const eventId = payload.id ?? `synthetic:${payload.type ?? "unknown"}:${Date.now()}`;
  const eventType = payload.type ?? "unknown";

  try {
    await db.stripeWebhookDelivery.create({
      data: {
        eventId,
        eventType,
        tenantId: extractTenantIdFromStripePayload(payload) ?? null
      }
    });
  } catch {
    return { received: true, duplicate: true, eventId };
  }

  const obj = payload.data?.object ?? {};
  const stripeStatus = typeof obj.status === "string" ? obj.status : undefined;
  const mapped = mapStripeSubscriptionStatus(stripeStatus);
  const tenantId = extractTenantIdFromStripePayload(payload);
  const stripeSubId = extractStripeSubscriptionId(payload);

  let subscriptionId: string | null = null;
  if (mapped || stripeSubId) {
    let sub = stripeSubId
      ? await db.subscription.findUnique({ where: { stripeSubscriptionId: stripeSubId } })
      : null;
    if (!sub && tenantId) {
      sub = await db.subscription.findFirst({
        where: { tenantId },
        orderBy: { createdAt: "desc" }
      });
    }
    if (sub) {
      const data: { status?: SubscriptionStatus; stripeSubscriptionId?: string } = {};
      if (mapped) data.status = mapped;
      if (stripeSubId && !sub.stripeSubscriptionId) data.stripeSubscriptionId = stripeSubId;
      if (Object.keys(data).length > 0) {
        await db.subscription.update({ where: { id: sub.id }, data });
      }
      subscriptionId = sub.id;
    }
  }

  return {
    received: true,
    eventId,
    subscriptionId,
    statusApplied: mapped
  };
}

function extractTenantIdFromStripePayload(payload: z.infer<typeof stripeEnvelopeSchema>): string | null {
  const obj = payload.data?.object ?? {};
  const meta = obj.metadata;
  if (meta && typeof meta === "object" && !Array.isArray(meta)) {
    const tenantId = (meta as Record<string, unknown>).tenantId;
    if (typeof tenantId === "string" && tenantId.length > 0) {
      return tenantId;
    }
  }
  return null;
}

function extractStripeSubscriptionId(payload: z.infer<typeof stripeEnvelopeSchema>): string | null {
  const obj = payload.data?.object ?? {};
  // customer.subscription.* events: obj.id IS the Stripe subscription id.
  if (typeof obj.object === "string" && obj.object === "subscription" && typeof obj.id === "string" && obj.id.startsWith("sub_")) {
    return obj.id;
  }
  // checkout.session.completed, invoice.*: obj.subscription holds the subscription id.
  if (typeof obj.subscription === "string" && obj.subscription.startsWith("sub_")) {
    return obj.subscription;
  }
  return null;
}
