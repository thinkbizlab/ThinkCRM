import { DealStatus, UserRole, VisitStatus, VisitType } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { buildApp } from "../../app.js";
import { prisma } from "../../lib/prisma.js";

async function createFixture() {
  const token = randomUUID().replace(/-/g, "");
  const tenantId = `tenant_${token}`;
  const repId = `rep_${token}`;
  const paymentTermId = `term_${token}`;
  const customerId = `customer_${token}`;
  const stageId = `stage_${token}`;

  await prisma.tenant.create({
    data: {
      id: tenantId,
      name: `Tenant ${token}`,
      slug: `tenant-${token}`
    }
  });
  await prisma.user.create({
    data: {
      id: repId,
      tenantId,
      email: `${token}@example.com`,
      passwordHash: "not-used-in-test",
      fullName: "Rep Test User",
      role: UserRole.REP
    }
  });
  await prisma.paymentTerm.create({
    data: {
      id: paymentTermId,
      tenantId,
      code: `NET${token.slice(0, 6)}`,
      name: "Net Test",
      dueDays: 30
    }
  });
  await prisma.customer.create({
    data: {
      id: customerId,
      tenantId,
      ownerId: repId,
      customerCode: `CUST-${token.slice(0, 8)}`,
      name: "Customer Test",
      defaultTermId: paymentTermId
    }
  });
  await prisma.dealStage.create({
    data: {
      id: stageId,
      tenantId,
      stageName: "Opportunity",
      stageOrder: 1
    }
  });

  return { tenantId, repId, customerId, stageId };
}

async function authHeader(app: Awaited<ReturnType<typeof buildApp>>, tenantId: string, userId: string) {
  const token = await app.jwt.sign({
    tenantId,
    userId,
    role: UserRole.REP,
    email: "rep.test@thinkcrm.dev"
  });
  return { authorization: `Bearer ${token}` };
}

describe("ai analysis endpoint", () => {
  it("returns mixed pattern/anomaly/recommendation findings", async () => {
    const app = await buildApp();
    const fixture = await createFixture();
    const headers = await authHeader(app, fixture.tenantId, fixture.repId);
    const now = new Date();

    await prisma.visit.createMany({
      data: Array.from({ length: 7 }).map((_, index) => ({
        tenantId: fixture.tenantId,
        repId: fixture.repId,
        customerId: fixture.customerId,
        visitType: VisitType.PLANNED,
        status: index < 2 ? VisitStatus.CHECKED_OUT : VisitStatus.CHECKED_IN,
        plannedAt: new Date(now.getTime() - (index + 1) * 3600000),
        checkInAt: new Date(Date.UTC(2026, 0, index + 1, 14, 0, 0)),
        checkOutAt: index < 2 ? new Date(now.getTime() - (index + 1) * 3000000) : null
      }))
    });

    const wonAt = new Date(now.getTime() - 3 * 24 * 3600000);
    const lostAt = new Date(now.getTime() - 2 * 24 * 3600000);
    await prisma.deal.createMany({
      data: [
        {
          tenantId: fixture.tenantId,
          ownerId: fixture.repId,
          dealNo: `A-${randomUUID().slice(0, 8)}`,
          dealName: "Overdue one",
          customerId: fixture.customerId,
          stageId: fixture.stageId,
          estimatedValue: 1000,
          status: DealStatus.OPEN,
          followUpAt: new Date(now.getTime() - 3 * 24 * 3600000)
        },
        {
          tenantId: fixture.tenantId,
          ownerId: fixture.repId,
          dealNo: `B-${randomUUID().slice(0, 8)}`,
          dealName: "Overdue two",
          customerId: fixture.customerId,
          stageId: fixture.stageId,
          estimatedValue: 1000,
          status: DealStatus.OPEN,
          followUpAt: new Date(now.getTime() - 2 * 24 * 3600000)
        },
        {
          tenantId: fixture.tenantId,
          ownerId: fixture.repId,
          dealNo: `C-${randomUUID().slice(0, 8)}`,
          dealName: "Open current",
          customerId: fixture.customerId,
          stageId: fixture.stageId,
          estimatedValue: 1000,
          status: DealStatus.OPEN,
          followUpAt: new Date(now.getTime() + 24 * 3600000)
        },
        {
          tenantId: fixture.tenantId,
          ownerId: fixture.repId,
          dealNo: `D-${randomUUID().slice(0, 8)}`,
          dealName: "Won one",
          customerId: fixture.customerId,
          stageId: fixture.stageId,
          estimatedValue: 1000,
          status: DealStatus.WON,
          followUpAt: wonAt,
          closedAt: wonAt
        },
        {
          tenantId: fixture.tenantId,
          ownerId: fixture.repId,
          dealNo: `E-${randomUUID().slice(0, 8)}`,
          dealName: "Won two",
          customerId: fixture.customerId,
          stageId: fixture.stageId,
          estimatedValue: 1000,
          status: DealStatus.WON,
          followUpAt: wonAt,
          closedAt: new Date(wonAt.getTime() - 3600000)
        },
        {
          tenantId: fixture.tenantId,
          ownerId: fixture.repId,
          dealNo: `F-${randomUUID().slice(0, 8)}`,
          dealName: "Won three",
          customerId: fixture.customerId,
          stageId: fixture.stageId,
          estimatedValue: 1000,
          status: DealStatus.WON,
          followUpAt: wonAt,
          closedAt: new Date(wonAt.getTime() - 7200000)
        },
        {
          tenantId: fixture.tenantId,
          ownerId: fixture.repId,
          dealNo: `G-${randomUUID().slice(0, 8)}`,
          dealName: "Won four",
          customerId: fixture.customerId,
          stageId: fixture.stageId,
          estimatedValue: 1000,
          status: DealStatus.WON,
          followUpAt: wonAt,
          closedAt: new Date(wonAt.getTime() - 10800000)
        },
        {
          tenantId: fixture.tenantId,
          ownerId: fixture.repId,
          dealNo: `H-${randomUUID().slice(0, 8)}`,
          dealName: "Lost one",
          customerId: fixture.customerId,
          stageId: fixture.stageId,
          estimatedValue: 1000,
          status: DealStatus.LOST,
          followUpAt: lostAt,
          closedAt: lostAt
        }
      ]
    });

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/ai-analysis/runs",
      headers,
      payload: {
        dateFrom: new Date(now.getTime() - 14 * 24 * 3600000).toISOString(),
        dateTo: new Date(now.getTime() + 24 * 3600000).toISOString(),
        repId: fixture.repId
      }
    });
    expect(res.statusCode).toBe(201);
    const types = new Set(res.json().findings.map((f: { findingType: string }) => f.findingType));
    expect(types.has("pattern")).toBe(true);
    expect(types.has("anomaly")).toBe(true);
    expect(types.has("recommendation")).toBe(true);

    await app.close();
  });
});
