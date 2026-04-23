import { UserRole } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../../build-app.js";
import { prisma } from "../../lib/prisma.js";

type MasterFixture = {
  tenantId: string;
  managerId: string;
  repId: string;
};

describe("customer search", () => {
  const createdTenantIds: string[] = [];
  let app: Awaited<ReturnType<typeof buildApp>>;

  beforeAll(async () => {
    app = await buildApp();
  });

  afterAll(async () => {
    if (createdTenantIds.length > 0) {
      await prisma.customerAddress.deleteMany({
        where: {
          customer: {
            tenantId: {
              in: createdTenantIds
            }
          }
        }
      });
      await prisma.customer.deleteMany({
        where: {
          tenantId: {
            in: createdTenantIds
          }
        }
      });
      await prisma.paymentTerm.deleteMany({
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

  async function setupFixture(): Promise<MasterFixture> {
    const suffix = randomUUID().replace(/-/g, "");
    const tenantId = `tenant_${suffix}`;
    const managerId = `manager_${suffix}`;
    const repId = `rep_${suffix}`;
    const termId = `term_${suffix}`;

    createdTenantIds.push(tenantId);

    await prisma.tenant.create({
      data: {
        id: tenantId,
        name: `Tenant ${suffix}`,
        slug: `tenant-${suffix}`
      }
    });

    await prisma.user.createMany({
      data: [
        {
          id: managerId,
          tenantId,
          email: `manager-${suffix}@example.com`,
          passwordHash: "not-used",
          fullName: "Manager Search",
          role: UserRole.MANAGER
        },
        {
          id: repId,
          tenantId,
          email: `rep-${suffix}@example.com`,
          passwordHash: "not-used",
          fullName: "Rep Search",
          role: UserRole.REP,
          managerUserId: managerId
        }
      ]
    });

    await prisma.paymentTerm.create({
      data: {
        id: termId,
        tenantId,
        code: `NET-${suffix.slice(0, 6)}`,
        name: "Net 30",
        dueDays: 30
      }
    });

    await prisma.customer.createMany({
      data: [
        {
          tenantId,
          ownerId: managerId,
          customerCode: `CUST-M-${suffix.slice(0, 6)}`,
          name: "Acme HQ",
          defaultTermId: termId
        },
        {
          tenantId,
          ownerId: repId,
          customerCode: `CUST-R-${suffix.slice(0, 6)}`,
          name: "Acme Retail",
          defaultTermId: termId
        },
        {
          tenantId,
          ownerId: repId,
          customerCode: `CUST-D-${suffix.slice(0, 6)}`,
          name: "Acme Dormant",
          defaultTermId: termId,
          disabled: true
        }
      ]
    });

    return { tenantId, managerId, repId };
  }

  async function authHeader(fixture: MasterFixture) {
    const token = await app.jwt.sign({
      tenantId: fixture.tenantId,
      userId: fixture.managerId,
      role: UserRole.MANAGER,
      email: "manager.search@example.com"
    });
    return { authorization: `Bearer ${token}` };
  }

  it("defaults to the current user's customer scope", async () => {
    const fixture = await setupFixture();
    const headers = await authHeader(fixture);

    const res = await app.inject({
      method: "GET",
      url: "/api/v1/customers/search?q=acme",
      headers
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toHaveLength(1);
    expect(res.json()[0].name).toBe("Acme HQ");
  });

  it("supports team scope and excludes disabled customers", async () => {
    const fixture = await setupFixture();
    const headers = await authHeader(fixture);

    const res = await app.inject({
      method: "GET",
      url: "/api/v1/customers/search?q=acme&scope=team&limit=10",
      headers
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().map((customer: { name: string }) => customer.name)).toEqual([
      "Acme HQ",
      "Acme Retail"
    ]);
  });
});
