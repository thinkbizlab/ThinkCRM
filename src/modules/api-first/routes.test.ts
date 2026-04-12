import { UserRole } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../../app.js";
import { hashPassword } from "../../lib/password.js";
import { prisma } from "../../lib/prisma.js";

describe("api-first contract routes", () => {
  const createdTenantIds: string[] = [];
  let app: Awaited<ReturnType<typeof buildApp>>;

  beforeAll(async () => {
    app = await buildApp();
  });

  afterAll(async () => {
    if (createdTenantIds.length > 0) {
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

  async function setupFixture() {
    const suffix = randomUUID();
    const tenant = await prisma.tenant.create({
      data: {
        name: `API First ${suffix}`,
        slug: `api-first-${suffix}`
      }
    });
    createdTenantIds.push(tenant.id);

    const [admin, manager] = await Promise.all([
      prisma.user.create({
        data: {
          tenantId: tenant.id,
          email: `admin-${suffix}@example.com`,
          fullName: "Admin",
          role: UserRole.ADMIN,
          passwordHash: hashPassword("Password123!")
        }
      }),
      prisma.user.create({
        data: {
          tenantId: tenant.id,
          email: `manager-${suffix}@example.com`,
          fullName: "Manager",
          role: UserRole.MANAGER,
          passwordHash: hashPassword("Password123!")
        }
      })
    ]);

    await prisma.subscription.create({
      data: {
        tenantId: tenant.id,
        provider: "STRIPE",
        pricingModel: "FIXED_PER_USER",
        status: "ACTIVE",
        seatPriceCents: 100000,
        seatCount: 2,
        currency: "THB",
        paymentMethodRef: "pm_seeded"
      }
    });

    await prisma.tenantStorageQuota.create({
      data: {
        tenantId: tenant.id,
        includedBytes: BigInt(1_073_741_824),
        overagePricePerGb: 3000
      }
    });

    const adminToken = await app.jwt.sign({
      tenantId: tenant.id,
      userId: admin.id,
      role: admin.role,
      email: admin.email
    });
    const managerToken = await app.jwt.sign({
      tenantId: tenant.id,
      userId: manager.id,
      role: manager.role,
      email: manager.email
    });

    return { tenant, admin, manager, adminToken, managerToken };
  }

  it("supports plan contract tenant signup endpoint", async () => {
    const slug = `signup-${randomUUID()}`;
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/tenants/signup",
      payload: {
        companyName: "Signup Tenant",
        companySlug: slug,
        admin: {
          email: `admin-${slug}@example.com`,
          fullName: "Signup Admin"
        },
        billing: {
          seatPriceCents: 150000,
          initialSeatCount: 3,
          currency: "THB",
          paymentMethodRef: "pm_signup",
          overagePricePerGb: 2900,
          includedBytes: 1_073_741_824
        }
      }
    });

    expect(response.statusCode).toBe(201);
    const body = response.json() as { tenantId: string };
    createdTenantIds.push(body.tenantId);
  });

  it("returns dashboard summary and subscription aliases", async () => {
    const fixture = await setupFixture();
    const [summaryResponse, subscriptionResponse] = await Promise.all([
      app.inject({
        method: "GET",
        url: "/api/v1/dashboard/summary?month=2026-04",
        headers: {
          authorization: `Bearer ${fixture.managerToken}`
        }
      }),
      app.inject({
        method: "GET",
        url: `/api/v1/tenants/${fixture.tenant.id}/subscription`,
        headers: {
          authorization: `Bearer ${fixture.managerToken}`
        }
      })
    ]);

    expect(summaryResponse.statusCode).toBe(200);
    expect(subscriptionResponse.statusCode).toBe(200);
  });

  it("supports invite and hierarchy scope endpoints", async () => {
    const fixture = await setupFixture();
    const inviteResponse = await app.inject({
      method: "POST",
      url: "/api/v1/users/invite",
      headers: {
        authorization: `Bearer ${fixture.adminToken}`
      },
      payload: {
        email: `rep-${randomUUID()}@example.com`,
        fullName: "Invited Rep",
        role: "REP",
        managerUserId: fixture.manager.id
      }
    });

    expect(inviteResponse.statusCode).toBe(201);
    const invited = inviteResponse.json() as { id: string };

    const scopeResponse = await app.inject({
      method: "GET",
      url: `/api/v1/users/${fixture.manager.id}/scope`,
      headers: {
        authorization: `Bearer ${fixture.adminToken}`
      }
    });

    expect(scopeResponse.statusCode).toBe(200);
    expect((scopeResponse.json() as { scopeUserIds: string[] }).scopeUserIds).toContain(invited.id);
  });
});
