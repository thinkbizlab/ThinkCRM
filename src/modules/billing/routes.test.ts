import { BillingProvider, PricingModel, SubscriptionStatus, UserRole } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../../build-app.js";
import { hashPassword } from "../../lib/password.js";
import { prisma } from "../../lib/prisma.js";

describe("billing workflow validations", () => {
  const createdTenantIds: string[] = [];
  let app: Awaited<ReturnType<typeof buildApp>>;

  beforeAll(async () => {
    app = await buildApp();
  });

  afterAll(async () => {
    if (createdTenantIds.length > 0) {
      await prisma.tenantInvoice.deleteMany({
        where: { tenantId: { in: createdTenantIds } }
      });
      await prisma.subscriptionProrationEvent.deleteMany({
        where: { tenantId: { in: createdTenantIds } }
      });
      await prisma.tenantStorageUsageDaily.deleteMany({
        where: { tenantId: { in: createdTenantIds } }
      });
      await prisma.tenantStorageQuota.deleteMany({
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
    }
    await app.close();
  });

  async function setupBillingFixture() {
    const suffix = randomUUID();
    const tenant = await prisma.tenant.create({
      data: {
        name: `Billing Tenant ${suffix}`,
        slug: `billing-tenant-${suffix}`
      }
    });
    createdTenantIds.push(tenant.id);

    const [admin, manager] = await Promise.all([
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
      })
    ]);

    await prisma.subscription.create({
      data: {
        tenantId: tenant.id,
        provider: BillingProvider.STRIPE,
        pricingModel: PricingModel.FIXED_PER_USER,
        status: SubscriptionStatus.ACTIVE,
        seatPriceCents: 1000,
        seatCount: 2,
        currency: "THB",
        paymentMethodRef: "pm_seed"
      }
    });
    await prisma.tenantStorageQuota.create({
      data: {
        tenantId: tenant.id,
        includedBytes: BigInt(1073741824),
        overagePricePerGb: 100
      }
    });

    const [adminToken, managerToken] = await Promise.all([
      app.jwt.sign({ tenantId: tenant.id, userId: admin.id, role: admin.role, email: admin.email }),
      app.jwt.sign({
        tenantId: tenant.id,
        userId: manager.id,
        role: manager.role,
        email: manager.email
      })
    ]);

    return { tenantId: tenant.id, adminToken, managerToken };
  }

  it("enforces admin-only payment updates and validates invoice finalization workflow", async () => {
    const fixture = await setupBillingFixture();

    const managerCapture = await app.inject({
      method: "PUT",
      url: "/api/v1/billing/subscription/capture",
      headers: { authorization: `Bearer ${fixture.managerToken}` },
      payload: {
        seatPriceCents: 1200,
        seatCount: 3,
        currency: "THB",
        paymentMethodRef: "pm_live"
      }
    });
    expect(managerCapture.statusCode).toBe(403);

    const seatPatch = await app.inject({
      method: "PATCH",
      url: "/api/v1/billing/subscription/seats",
      headers: { authorization: `Bearer ${fixture.adminToken}` },
      payload: { seatCount: 5 }
    });
    expect(seatPatch.statusCode).toBe(200);
    expect(seatPatch.json().prorationEvent.newSeatCount).toBe(5);
    expect(seatPatch.json().prorationEvent.proratedAmountCents).toBeGreaterThanOrEqual(0);

    const finalize = await app.inject({
      method: "POST",
      url: "/api/v1/billing/invoices/finalize",
      headers: { authorization: `Bearer ${fixture.adminToken}` },
      payload: {}
    });
    expect(finalize.statusCode).toBe(200);
    expect(finalize.json().status).toBe("FINALIZED");

    const finalizeAgain = await app.inject({
      method: "POST",
      url: "/api/v1/billing/invoices/finalize",
      headers: { authorization: `Bearer ${fixture.adminToken}` },
      payload: {}
    });
    expect(finalizeAgain.statusCode).toBe(409);
    expect(finalizeAgain.json().message).toContain("already finalized");
  });
});
