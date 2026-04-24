import { DealStatus, UserRole, VisitStatus, VisitType } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { buildApp } from "../../build-app.js";
import { prisma } from "../../lib/prisma.js";

type DashboardFixture = {
  tenantId: string;
  adminId: string;
  managerId: string;
  repId: string;
  repPeerId: string;
  month: string;
};

async function createFixture(): Promise<DashboardFixture> {
  const suffix = randomUUID().replace(/-/g, "");
  const tenantId = `tenant_${suffix}`;
  const adminId = `admin_${suffix}`;
  const managerId = `manager_${suffix}`;
  const repId = `rep_${suffix}`;
  const repPeerId = `rep_peer_${suffix}`;
  const teamId = `team_${suffix}`;
  const termId = `term_${suffix}`;
  const customerId = `customer_${suffix}`;
  const stageId = `stage_${suffix}`;
  const month = new Date().toISOString().slice(0, 7);

  await prisma.tenant.create({
    data: {
      id: tenantId,
      name: `Tenant ${suffix}`,
      slug: `tenant-${suffix}`
    }
  });

  await prisma.team.create({
    data: {
      id: teamId,
      tenantId,
      teamName: "North Team"
    }
  });

  await prisma.user.createMany({
    data: [
      {
        id: adminId,
        tenantId,
        email: `admin-${suffix}@example.com`,
        passwordHash: "not-used",
        fullName: "Admin User",
        role: UserRole.ADMIN,
        teamId
      },
      {
        id: managerId,
        tenantId,
        email: `manager-${suffix}@example.com`,
        passwordHash: "not-used",
        fullName: "Manager User",
        role: UserRole.MANAGER,
        teamId
      },
      {
        id: repId,
        tenantId,
        email: `rep-${suffix}@example.com`,
        passwordHash: "not-used",
        fullName: "Rep User",
        role: UserRole.REP,
        managerUserId: managerId,
        teamId
      },
      {
        id: repPeerId,
        tenantId,
        email: `rep-peer-${suffix}@example.com`,
        passwordHash: "not-used",
        fullName: "Rep Peer User",
        role: UserRole.REP,
        managerUserId: managerId,
        teamId
      }
    ]
  });

  await prisma.paymentTerm.create({
    data: {
      id: termId,
      tenantId,
      code: `NET-${suffix.slice(0, 5)}`,
      name: "Net 30",
      dueDays: 30
    }
  });

  await prisma.customer.create({
    data: {
      id: customerId,
      tenantId,
      ownerId: repId,
      customerCode: `CUST-${suffix.slice(0, 6)}`,
      name: "Acme",
      defaultTermId: termId,
      addresses: {
        create: {
          addressLine1: "123 Test Road",
          isDefaultBilling: true,
          isDefaultShipping: true
        }
      }
    }
  });

  await prisma.dealStage.create({
    data: {
      id: stageId,
      tenantId,
      stageName: "Opportunity",
      stageOrder: 10
    }
  });

  const withinMonth = new Date(`${month}-15T09:00:00.000Z`);
  const withinMonthClose = new Date(`${month}-18T11:00:00.000Z`);
  await prisma.deal.createMany({
    data: [
      {
        tenantId,
        ownerId: repId,
        dealNo: `DL-${suffix.slice(0, 5)}-R`,
        dealName: "Rep Deal",
        customerId,
        stageId,
        estimatedValue: 100000,
        followUpAt: withinMonth,
        status: DealStatus.WON,
        createdAt: withinMonth,
        closedAt: withinMonthClose
      },
      {
        tenantId,
        ownerId: repPeerId,
        dealNo: `DL-${suffix.slice(0, 5)}-P`,
        dealName: "Peer Deal",
        customerId,
        stageId,
        estimatedValue: 90000,
        followUpAt: withinMonth,
        status: DealStatus.WON,
        createdAt: withinMonth,
        closedAt: withinMonthClose
      }
    ]
  });

  await prisma.visit.createMany({
    data: [
      {
        tenantId,
        repId,
        customerId,
        visitNo: `V-${suffix.slice(0, 6)}-1`,
        visitType: VisitType.PLANNED,
        status: VisitStatus.CHECKED_OUT,
        plannedAt: withinMonth,
        checkInAt: withinMonth,
        checkOutAt: withinMonthClose
      },
      {
        tenantId,
        repId: repPeerId,
        customerId,
        visitNo: `V-${suffix.slice(0, 6)}-2`,
        visitType: VisitType.PLANNED,
        status: VisitStatus.CHECKED_OUT,
        plannedAt: withinMonth,
        checkInAt: withinMonth,
        checkOutAt: withinMonthClose
      }
    ]
  });

  await prisma.salesKpiTarget.createMany({
    data: [
      {
        tenantId,
        userId: repId,
        targetMonth: month,
        visitTargetCount: 8,
        newDealValueTarget: 200000,
        revenueTarget: 120000
      },
      {
        tenantId,
        userId: repPeerId,
        targetMonth: month,
        visitTargetCount: 10,
        newDealValueTarget: 180000,
        revenueTarget: 140000
      }
    ]
  });

  return { tenantId, adminId, managerId, repId, repPeerId, month };
}

async function authHeader(app: Awaited<ReturnType<typeof buildApp>>, fixture: DashboardFixture, role: UserRole, userId: string) {
  const token = await app.jwt.sign({
    tenantId: fixture.tenantId,
    userId,
    role,
    email: `${userId}@example.com`
  });
  return { authorization: `Bearer ${token}` };
}

describe("dashboard overview", () => {
  it("returns KPI, target progress, gamification and team metrics", async () => {
    const app = await buildApp();
    const fixture = await createFixture();
    const headers = await authHeader(app, fixture, UserRole.ADMIN, fixture.adminId);

    const res = await app.inject({
      method: "GET",
      url: `/api/v1/dashboard/overview?month=${fixture.month}`,
      headers
    });

    expect(res.statusCode).toBe(200);
    const payload = res.json();
    expect(payload.period.month).toBe(fixture.month);
    expect(payload.kpis).toHaveProperty("activeDeals");
    expect(payload.kpis).toHaveProperty("usersInScope");
    expect(Array.isArray(payload.targetVsActual)).toBe(true);
    expect(payload.targetVsActual.length).toBe(2);
    expect(payload.targetVsActual[0]).toHaveProperty("actual");
    expect(payload.targetVsActual[0]).toHaveProperty("progress");
    expect(Array.isArray(payload.gamification)).toBe(true);
    expect(payload.gamification.length).toBe(2);
    expect(payload.gamification[0]).toHaveProperty("badge");
    expect(Array.isArray(payload.teamPerformance)).toBe(true);
    expect(payload.teamPerformance[0]).toHaveProperty("memberCount");

    await app.close();
  });

  it("scopes REP visibility to own metrics only", async () => {
    const app = await buildApp();
    const fixture = await createFixture();
    const headers = await authHeader(app, fixture, UserRole.REP, fixture.repId);

    const res = await app.inject({
      method: "GET",
      url: `/api/v1/dashboard/overview?month=${fixture.month}`,
      headers
    });

    expect(res.statusCode).toBe(200);
    const payload = res.json();
    expect(payload.kpis.usersInScope).toBe(1);
    expect(payload.targetVsActual.length).toBe(1);
    expect(payload.targetVsActual[0].userId).toBe(fixture.repId);
    expect(payload.gamification.length).toBe(1);
    expect(payload.gamification[0].userId).toBe(fixture.repId);
    expect(payload.teamPerformance.length).toBe(1);
    expect(payload.teamPerformance[0].memberCount).toBe(1);

    await app.close();
  });

  it("supports narrowing admin overview to a specific rep", async () => {
    const app = await buildApp();
    const fixture = await createFixture();
    const headers = await authHeader(app, fixture, UserRole.ADMIN, fixture.adminId);

    const res = await app.inject({
      method: "GET",
      url: `/api/v1/dashboard/overview?month=${fixture.month}&repId=${fixture.repId}`,
      headers
    });

    expect(res.statusCode).toBe(200);
    const payload = res.json();
    expect(payload.kpis.usersInScope).toBe(1);
    expect(payload.kpis.wonValue).toBe(100000);
    expect(payload.targetVsActual.length).toBe(1);
    expect(payload.targetVsActual[0].userId).toBe(fixture.repId);
    expect(payload.teamPerformance.length).toBe(1);
    expect(payload.teamPerformance[0].memberCount).toBe(1);

    await app.close();
  });
});
