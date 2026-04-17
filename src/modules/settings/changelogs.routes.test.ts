import { EntityType, UserRole } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../../build-app.js";
import { hashPassword } from "../../lib/password.js";
import { prisma } from "../../lib/prisma.js";

describe("hierarchy scope and changelog routes", () => {
  const createdTenantIds: string[] = [];
  let app: Awaited<ReturnType<typeof buildApp>>;

  beforeAll(async () => {
    app = await buildApp();
  });

  afterAll(async () => {
    if (createdTenantIds.length > 0) {
      await prisma.entityChangelog.deleteMany({
        where: {
          tenantId: { in: createdTenantIds }
        }
      });
      await prisma.visit.deleteMany({
        where: {
          tenantId: { in: createdTenantIds }
        }
      });
      await prisma.deal.deleteMany({
        where: {
          tenantId: { in: createdTenantIds }
        }
      });
      await prisma.dealStage.deleteMany({
        where: {
          tenantId: { in: createdTenantIds }
        }
      });
      await prisma.customer.deleteMany({
        where: {
          tenantId: { in: createdTenantIds }
        }
      });
      await prisma.item.deleteMany({
        where: {
          tenantId: { in: createdTenantIds }
        }
      });
      await prisma.paymentTerm.deleteMany({
        where: {
          tenantId: { in: createdTenantIds }
        }
      });
      await prisma.user.deleteMany({
        where: {
          tenantId: { in: createdTenantIds }
        }
      });
      await prisma.tenant.deleteMany({
        where: {
          id: { in: createdTenantIds }
        }
      });
    }
    await app.close();
  });

  it("supports manager assignment and returns scoped changelog entries", async () => {
    const suffix = randomUUID();
    const tenant = await prisma.tenant.create({
      data: {
        name: `Audit Tenant ${suffix}`,
        slug: `audit-tenant-${suffix}`
      }
    });
    createdTenantIds.push(tenant.id);

    const [admin, manager, repA, repB] = await Promise.all([
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
          email: `rep-a-${suffix}@example.com`,
          fullName: "Rep A",
          role: UserRole.REP,
          passwordHash: hashPassword("Password123!")
        }
      }),
      prisma.user.create({
        data: {
          tenantId: tenant.id,
          email: `rep-b-${suffix}@example.com`,
          fullName: "Rep B",
          role: UserRole.REP,
          passwordHash: hashPassword("Password123!")
        }
      })
    ]);

    const [term, stage] = await Promise.all([
      prisma.paymentTerm.create({
        data: {
          tenantId: tenant.id,
          code: `NET-${suffix.slice(0, 8)}`,
          name: "Net 30",
          dueDays: 30
        }
      }),
      prisma.dealStage.create({
        data: {
          tenantId: tenant.id,
          stageName: "Opportunity",
          stageOrder: 1,
          isDefault: true
        }
      })
    ]);

    const [adminToken, managerToken, repAToken, repBToken] = await Promise.all([
      app.jwt.sign({ tenantId: tenant.id, userId: admin.id, role: admin.role, email: admin.email }),
      app.jwt.sign({ tenantId: tenant.id, userId: manager.id, role: manager.role, email: manager.email }),
      app.jwt.sign({ tenantId: tenant.id, userId: repA.id, role: repA.role, email: repA.email }),
      app.jwt.sign({ tenantId: tenant.id, userId: repB.id, role: repB.role, email: repB.email })
    ]);

    const assignManager = await app.inject({
      method: "PUT",
      url: `/api/v1/users/${repA.id}/manager`,
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { managerUserId: manager.id }
    });
    expect(assignManager.statusCode).toBe(200);
    expect(assignManager.json().managerUserId).toBe(manager.id);

    const createCustomerA = await app.inject({
      method: "POST",
      url: "/api/v1/customers",
      headers: { authorization: `Bearer ${repAToken}` },
      payload: {
        customerCode: `CUSTA-${suffix.slice(0, 8)}`,
        name: "Customer A",
        defaultTermId: term.id
      }
    });
    expect(createCustomerA.statusCode).toBe(201);

    const createDealA = await app.inject({
      method: "POST",
      url: "/api/v1/deals",
      headers: { authorization: `Bearer ${repAToken}` },
      payload: {
        dealNo: `DLA-${suffix.slice(0, 8)}`,
        dealName: "Deal A",
        customerId: createCustomerA.json().id,
        stageId: stage.id,
        estimatedValue: 1000,
        followUpAt: new Date(Date.now() + 86400000).toISOString()
      }
    });
    expect(createDealA.statusCode).toBe(201);

    const createCustomerB = await app.inject({
      method: "POST",
      url: "/api/v1/customers",
      headers: { authorization: `Bearer ${repBToken}` },
      payload: {
        customerCode: `CUSTB-${suffix.slice(0, 8)}`,
        name: "Customer B",
        defaultTermId: term.id
      }
    });
    expect(createCustomerB.statusCode).toBe(201);

    const createDealB = await app.inject({
      method: "POST",
      url: "/api/v1/deals",
      headers: { authorization: `Bearer ${repBToken}` },
      payload: {
        dealNo: `DLB-${suffix.slice(0, 8)}`,
        dealName: "Deal B",
        customerId: createCustomerB.json().id,
        stageId: stage.id,
        estimatedValue: 2000,
        followUpAt: new Date(Date.now() + 86400000).toISOString()
      }
    });
    expect(createDealB.statusCode).toBe(201);

    const managerLogs = await app.inject({
      method: "GET",
      url: "/api/v1/changelogs?entityType=DEAL",
      headers: { authorization: `Bearer ${managerToken}` }
    });
    expect(managerLogs.statusCode).toBe(200);
    const scopedLogs = managerLogs.json();
    expect(
      scopedLogs.some((row: { entityType: EntityType; entityId: string }) => row.entityType === "DEAL")
    ).toBe(true);
    expect(
      scopedLogs.some((row: { entityId: string }) => row.entityId === createDealA.json().id)
    ).toBe(true);
    expect(
      scopedLogs.some((row: { entityId: string }) => row.entityId === createDealB.json().id)
    ).toBe(false);
  });
});
