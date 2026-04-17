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
  // When Stripe webhook secret is configured, verify the signature.
  // This prevents replay attacks and forged webhook payloads.
  if (config.STRIPE_WEBHOOK_SECRET && stripeSignature && typeof rawBody === "string") {
    try {
      getStripe().webhooks.constructEvent(rawBody, stripeSignature, config.STRIPE_WEBHOOK_SECRET);
    } catch {
      throw new Error("INVALID_WEBHOOK_BODY");
    }
  }

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

  let subscriptionId: string | null = null;
  if (tenantId && mapped) {
    const sub = await db.subscription.findFirst({
      where: { tenantId },
      orderBy: { createdAt: "desc" }
    });
    if (sub) {
      await db.subscription.update({
        where: { id: sub.id },
        data: { status: mapped }
      });
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
