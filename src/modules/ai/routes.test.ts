// Side-effect import: triggers dotenv.config() before the prisma client below
// is instantiated. This file builds its own Fastify app instead of using
// `buildApp()`, so the env load is not transitive — without this import, runs
// in an isolated vitest worker fail with "DATABASE_URL not found".
import "../../config.js";
import { DealStatus, UserRole, VisitStatus, VisitType } from "@prisma/client";
import jwt from "@fastify/jwt";
import multipart from "@fastify/multipart";
import sensible from "@fastify/sensible";
import Fastify from "fastify";
import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { prisma } from "../../lib/prisma.js";
import { requestContextPlugin } from "../../plugins/request-context.js";
import { aiRoutes } from "./routes.js";

const createdTenantIds: string[] = [];

async function createAiFixture() {
  const suffix = randomUUID();
  const tenant = await prisma.tenant.create({
    data: {
      name: `Tenant ${suffix}`,
      slug: `tenant-${suffix}`
    }
  });
  createdTenantIds.push(tenant.id);

  const nowPlus30 = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
  await prisma.subscription.create({
    data: {
      tenantId: tenant.id,
      status: "TRIALING",
      seatCount: 5,
      seatPriceCents: 1500,
      currency: "THB",
      pricingModel: "FIXED_PER_USER",
      provider: "STRIPE",
      billingPeriodEnd: nowPlus30
    }
  });

  const rep = await prisma.user.create({
    data: {
      tenantId: tenant.id,
      email: `rep-${suffix}@example.com`,
      passwordHash: "not-used",
      fullName: "AI Rep",
      role: UserRole.REP
    }
  });

  const paymentTerm = await prisma.paymentTerm.create({
    data: {
      tenantId: tenant.id,
      code: `NET30-${suffix.slice(0, 8)}`,
      name: "Net 30",
      dueDays: 30
    }
  });

  const stageOpportunity = await prisma.dealStage.create({
    data: {
      tenantId: tenant.id,
      stageName: "Opportunity",
      stageOrder: 10
    }
  });

  const stageWon = await prisma.dealStage.create({
    data: {
      tenantId: tenant.id,
      stageName: "Won",
      stageOrder: 20,
      isClosedWon: true
    }
  });

  const now = new Date();
  const followUpAt = new Date(now.getTime() + 2 * 24 * 60 * 60 * 1000);
  const eightMonthsAgo = new Date(now);
  eightMonthsAgo.setUTCMonth(eightMonthsAgo.getUTCMonth() - 8);
  const fourteenMonthsAgo = new Date(now);
  fourteenMonthsAgo.setUTCMonth(fourteenMonthsAgo.getUTCMonth() - 14);
  const twoMonthsAgo = new Date(now);
  twoMonthsAgo.setUTCMonth(twoMonthsAgo.getUTCMonth() - 2);

  const customerDeal = await prisma.customer.create({
    data: {
      tenantId: tenant.id,
      ownerId: rep.id,
      customerCode: `CUST-DEAL-${suffix.slice(0, 8)}`,
      name: "Deal Follow-Up Customer",
    }
  });

  const customerGap6 = await prisma.customer.create({
    data: {
      tenantId: tenant.id,
      ownerId: rep.id,
      customerCode: `CUST-GAP6-${suffix.slice(0, 8)}`,
      name: "Gap 6 Months Customer",
    }
  });

  const customerGap12 = await prisma.customer.create({
    data: {
      tenantId: tenant.id,
      ownerId: rep.id,
      customerCode: `CUST-GAP12-${suffix.slice(0, 8)}`,
      name: "Gap 12 Months Customer",
    }
  });

  const customerNeverSold = await prisma.customer.create({
    data: {
      tenantId: tenant.id,
      ownerId: rep.id,
      customerCode: `CUST-NEVER-${suffix.slice(0, 8)}`,
      name: "Never Sold Customer",
    }
  });

  await prisma.deal.create({
    data: {
      tenantId: tenant.id,
      ownerId: rep.id,
      dealNo: `OPEN-${suffix.slice(0, 8)}`,
      dealName: "In-range opportunity",
      customerId: customerDeal.id,
      stageId: stageOpportunity.id,
      estimatedValue: 120000,
      followUpAt
    }
  });

  await prisma.deal.createMany({
    data: [
      {
        tenantId: tenant.id,
        ownerId: rep.id,
        dealNo: `WON-DEAL-${suffix.slice(0, 8)}`,
        dealName: "Recently won customer",
        customerId: customerDeal.id,
        stageId: stageWon.id,
        estimatedValue: 10000,
        followUpAt: now,
        status: DealStatus.WON,
        closedAt: twoMonthsAgo
      },
      {
        tenantId: tenant.id,
        ownerId: rep.id,
        dealNo: `WON-GAP6-${suffix.slice(0, 8)}`,
        dealName: "Gap 6 won customer",
        customerId: customerGap6.id,
        stageId: stageWon.id,
        estimatedValue: 10000,
        followUpAt: now,
        status: DealStatus.WON,
        closedAt: eightMonthsAgo
      },
      {
        tenantId: tenant.id,
        ownerId: rep.id,
        dealNo: `WON-GAP12-${suffix.slice(0, 8)}`,
        dealName: "Gap 12 won customer",
        customerId: customerGap12.id,
        stageId: stageWon.id,
        estimatedValue: 10000,
        followUpAt: now,
        status: DealStatus.WON,
        closedAt: fourteenMonthsAgo
      }
    ]
  });

  return {
    tenantId: tenant.id,
    repId: rep.id,
    followUpRange: {
      dateFrom: new Date(now.getTime() - 60 * 60 * 1000).toISOString(),
      dateTo: new Date(now.getTime() + 3 * 24 * 60 * 60 * 1000).toISOString()
    },
    customerNeverSoldId: customerNeverSold.id
  };
}

afterAll(async () => {
  if (createdTenantIds.length === 0) {
    return;
  }

  await prisma.voiceNoteTranscript.deleteMany({
    where: {
      job: {
        tenantId: { in: createdTenantIds }
      }
    }
  });
  await prisma.voiceNoteJob.deleteMany({
    where: { tenantId: { in: createdTenantIds } }
  });
  await prisma.dealProgressUpdate.deleteMany({
    where: {
      deal: {
        tenantId: { in: createdTenantIds }
      }
    }
  });
  await prisma.visit.deleteMany({
    where: { tenantId: { in: createdTenantIds } }
  });
  await prisma.deal.deleteMany({
    where: { tenantId: { in: createdTenantIds } }
  });
  await prisma.dealStage.deleteMany({
    where: { tenantId: { in: createdTenantIds } }
  });
  await prisma.customer.deleteMany({
    where: { tenantId: { in: createdTenantIds } }
  });
  await prisma.paymentTerm.deleteMany({
    where: { tenantId: { in: createdTenantIds } }
  });
  await prisma.subscription.deleteMany({
    where: { tenantId: { in: createdTenantIds } }
  });
  await prisma.user.deleteMany({
    where: { tenantId: { in: createdTenantIds } }
  });
  await prisma.tenant.deleteMany({
    where: { id: { in: createdTenantIds } }
  });
});

async function buildAiTestApp() {
  const app = Fastify();
  await app.register(sensible);
  await app.register(jwt, { secret: "test-jwt-secret" });
  await app.register(multipart);
  await app.register(requestContextPlugin);
  await app.register(aiRoutes, { prefix: "/api/v1" });
  return app;
}

async function createAuthHeader(app: Awaited<ReturnType<typeof buildAiTestApp>>, tenantId: string, repId: string) {
  const token = await app.jwt.sign({
    tenantId,
    userId: repId,
    role: UserRole.REP,
    email: "ai-rep@thinkcrm.dev"
  });
  return { authorization: `Bearer ${token}` };
}

describe("AI visit recommendations", () => {
  it("generates scoped recommendations", async () => {
    const app = await buildAiTestApp();
    const fixture = await createAiFixture();
    const headers = await createAuthHeader(app, fixture.tenantId, fixture.repId);

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/visits/ai-recommendations",
      headers,
      payload: fixture.followUpRange
    });

    expect(res.statusCode).toBe(201);
    const payload = res.json();
    expect(payload.recommendationCount).toBeGreaterThanOrEqual(4);
    await app.close();
  });
});

describe("Voice note confirmation flow", () => {
  it("creates deal progress updates only after confirmation", async () => {
    const app = await buildAiTestApp();
    const fixture = await createAiFixture();
    const headers = await createAuthHeader(app, fixture.tenantId, fixture.repId);

    const deal = await prisma.deal.findFirstOrThrow({
      where: { tenantId: fixture.tenantId, ownerId: fixture.repId, status: DealStatus.OPEN },
      select: { id: true }
    });

    const createRes = await app.inject({
      method: "POST",
      url: "/api/v1/voice-notes",
      headers,
      payload: {
        entityType: "DEAL",
        entityId: deal.id,
        audioObjectKey: "r2://tenant-audio/deal-voice.mp3"
      }
    });
    expect(createRes.statusCode).toBe(201);
    const jobId = createRes.json().id as string;

    const beforeConfirmCount = await prisma.dealProgressUpdate.count({
      where: { dealId: deal.id }
    });
    expect(beforeConfirmCount).toBe(0);

    const confirmRes = await app.inject({
      method: "POST",
      url: `/api/v1/voice-notes/${jobId}/confirm`,
      headers,
      payload: { summaryText: "Call summary from voice note." }
    });
    expect(confirmRes.statusCode).toBe(200);

    const afterConfirm = await prisma.dealProgressUpdate.findMany({
      where: { dealId: deal.id },
      orderBy: { createdAt: "desc" }
    });
    expect(afterConfirm).toHaveLength(1);
    expect(afterConfirm[0]?.note).toBe("Call summary from voice note.");

    await app.close();
  });

  it("blocks confirm after reject and keeps visit result unchanged", async () => {
    const app = await buildAiTestApp();
    const fixture = await createAiFixture();
    const headers = await createAuthHeader(app, fixture.tenantId, fixture.repId);

    const visit = await prisma.visit.create({
      data: {
        tenantId: fixture.tenantId,
        repId: fixture.repId,
        customerId: fixture.customerNeverSoldId,
        visitType: VisitType.PLANNED,
        status: VisitStatus.CHECKED_OUT,
        plannedAt: new Date(),
        result: "Initial result"
      }
    });

    const createRes = await app.inject({
      method: "POST",
      url: "/api/v1/voice-notes",
      headers,
      payload: {
        entityType: "VISIT",
        entityId: visit.id,
        audioObjectKey: "r2://tenant-audio/visit-voice.mp3"
      }
    });
    const jobId = createRes.json().id as string;

    const rejectRes = await app.inject({
      method: "POST",
      url: `/api/v1/voice-notes/${jobId}/reject`,
      headers
    });
    expect(rejectRes.statusCode).toBe(200);

    const confirmAfterReject = await app.inject({
      method: "POST",
      url: `/api/v1/voice-notes/${jobId}/confirm`,
      headers
    });
    expect(confirmAfterReject.statusCode).toBe(409);

    const persistedVisit = await prisma.visit.findUniqueOrThrow({
      where: { id: visit.id },
      select: { result: true }
    });
    expect(persistedVisit.result).toBe("Initial result");
    await app.close();
  });
});
