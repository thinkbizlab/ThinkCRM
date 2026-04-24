import { UserRole } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../../build-app.js";
import { hashPassword } from "../../lib/password.js";
import { prisma } from "../../lib/prisma.js";

describe("kpi target management routes", () => {
  const createdTenantIds: string[] = [];
  let app: Awaited<ReturnType<typeof buildApp>>;

  beforeAll(async () => {
    app = await buildApp();
  });

  afterAll(async () => {
    if (createdTenantIds.length > 0) {
      await prisma.salesKpiTarget.deleteMany({
        where: {
          tenantId: {
            in: createdTenantIds
          }
        }
      });
      await prisma.user.deleteMany({
        where: {
          tenantId: {
            in: createdTenantIds
          }
        }
      });
      await prisma.team.deleteMany({
        where: {
          tenantId: {
            in: createdTenantIds
          }
        }
      });
      await prisma.tenant.deleteMany({
        where: {
          id: {
            in: createdTenantIds
          }
        }
      });
    }
    await app.close();
  });

  async function setupKpiFixture() {
    const suffix = randomUUID();
    const tenant = await prisma.tenant.create({
      data: {
        name: `KPI Tenant ${suffix}`,
        slug: `kpi-tenant-${suffix}`
      }
    });
    createdTenantIds.push(tenant.id);

    const [northTeam, southTeam] = await Promise.all([
      prisma.team.create({
        data: {
          tenantId: tenant.id,
          teamName: "North Team"
        }
      }),
      prisma.team.create({
        data: {
          tenantId: tenant.id,
          teamName: "South Team"
        }
      })
    ]);

    const [admin, manager, repOne, repTwo] = await Promise.all([
      prisma.user.create({
        data: {
          tenantId: tenant.id,
          email: `admin-${suffix}@example.com`,
          fullName: "Admin User",
          role: UserRole.ADMIN,
          passwordHash: hashPassword("Password123!")
        }
      }),
      prisma.user.create({
        data: {
          tenantId: tenant.id,
          email: `manager-${suffix}@example.com`,
          fullName: "Manager User",
          role: UserRole.MANAGER,
          passwordHash: hashPassword("Password123!")
        }
      }),
      prisma.user.create({
        data: {
          tenantId: tenant.id,
          email: `rep-one-${suffix}@example.com`,
          fullName: "Rep One",
          role: UserRole.REP,
          teamId: northTeam.id,
          passwordHash: hashPassword("Password123!")
        }
      }),
      prisma.user.create({
        data: {
          tenantId: tenant.id,
          email: `rep-two-${suffix}@example.com`,
          fullName: "Rep Two",
          role: UserRole.REP,
          teamId: southTeam.id,
          passwordHash: hashPassword("Password123!")
        }
      })
    ]);

    const [adminToken, managerToken, repToken] = await Promise.all([
      app.jwt.sign({
        tenantId: tenant.id,
        userId: admin.id,
        role: admin.role,
        email: admin.email
      }),
      app.jwt.sign({
        tenantId: tenant.id,
        userId: manager.id,
        role: manager.role,
        email: manager.email
      }),
      app.jwt.sign({
        tenantId: tenant.id,
        userId: repOne.id,
        role: repOne.role,
        email: repOne.email
      })
    ]);

    return {
      tenantId: tenant.id,
      adminToken,
      managerToken,
      repToken,
      teamIds: {
        north: northTeam.id,
        south: southTeam.id
      },
      userIds: {
        admin: admin.id,
        manager: manager.id,
        repOne: repOne.id,
        repTwo: repTwo.id
      }
    };
  }

  it("allows tenant admin to create, update, and filter monthly KPI targets per rep", async () => {
    const fixture = await setupKpiFixture();

    const createRepOne = await app.inject({
      method: "POST",
      url: "/api/v1/kpi-targets",
      headers: {
        authorization: `Bearer ${fixture.adminToken}`
      },
      payload: {
        userId: fixture.userIds.repOne,
        targetMonth: "2026-04",
        visitTargetCount: 12,
        newDealValueTarget: 250000,
        revenueTarget: 150000
      }
    });
    expect(createRepOne.statusCode).toBe(201);
    expect(createRepOne.json().rep.fullName).toBe("Rep One");

    const duplicate = await app.inject({
      method: "POST",
      url: "/api/v1/kpi-targets",
      headers: {
        authorization: `Bearer ${fixture.adminToken}`
      },
      payload: {
        userId: fixture.userIds.repOne,
        targetMonth: "2026-04",
        visitTargetCount: 9,
        newDealValueTarget: 90000,
        revenueTarget: 50000
      }
    });
    expect(duplicate.statusCode).toBe(409);

    const createRepTwo = await app.inject({
      method: "POST",
      url: "/api/v1/kpi-targets",
      headers: {
        authorization: `Bearer ${fixture.adminToken}`
      },
      payload: {
        userId: fixture.userIds.repTwo,
        targetMonth: "2026-04",
        visitTargetCount: 8,
        newDealValueTarget: 200000,
        revenueTarget: 120000
      }
    });
    expect(createRepTwo.statusCode).toBe(201);

    const listByTeam = await app.inject({
      method: "GET",
      url: `/api/v1/kpi-targets?teamId=${fixture.teamIds.north}`,
      headers: {
        authorization: `Bearer ${fixture.adminToken}`
      }
    });
    expect(listByTeam.statusCode).toBe(200);
    const teamRows = listByTeam.json();
    expect(teamRows.length).toBe(1);
    expect(teamRows[0].userId).toBe(fixture.userIds.repOne);
    expect(teamRows[0].rep.team.teamName).toBe("North Team");

    const updateTarget = await app.inject({
      method: "PATCH",
      url: `/api/v1/kpi-targets/${createRepOne.json().id}`,
      headers: {
        authorization: `Bearer ${fixture.adminToken}`
      },
      payload: {
        visitTargetCount: 15,
        revenueTarget: 180000
      }
    });
    expect(updateTarget.statusCode).toBe(200);
    expect(updateTarget.json().visitTargetCount).toBe(15);
    expect(updateTarget.json().revenueTarget).toBe(180000);
  });

  it("blocks non-admin users from KPI target management endpoints", async () => {
    const fixture = await setupKpiFixture();

    const listReps = await app.inject({
      method: "GET",
      url: "/api/v1/kpi-targets/reps",
      headers: {
        authorization: `Bearer ${fixture.managerToken}`
      }
    });
    expect(listReps.statusCode).toBe(403);

    const createTarget = await app.inject({
      method: "POST",
      url: "/api/v1/kpi-targets",
      headers: {
        authorization: `Bearer ${fixture.repToken}`
      },
      payload: {
        userId: fixture.userIds.repOne,
        targetMonth: "2026-05",
        visitTargetCount: 5,
        newDealValueTarget: 50000,
        revenueTarget: 30000
      }
    });
    expect(createTarget.statusCode).toBe(403);
  });

  it("accepts KPI target only for active sales reps in tenant", async () => {
    const fixture = await setupKpiFixture();

    const createForManager = await app.inject({
      method: "POST",
      url: "/api/v1/kpi-targets",
      headers: {
        authorization: `Bearer ${fixture.adminToken}`
      },
      payload: {
        userId: fixture.userIds.manager,
        targetMonth: "2026-06",
        visitTargetCount: 10,
        newDealValueTarget: 100000,
        revenueTarget: 80000
      }
    });
    expect(createForManager.statusCode).toBe(400);
    expect(createForManager.json().message).toContain("sales rep");
  });
});
