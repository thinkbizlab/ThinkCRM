import { UserRole } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../../build-app.js";
import { hashPassword } from "../../lib/password.js";
import { prisma } from "../../lib/prisma.js";

describe("tenant onboarding and summary", () => {
  const createdTenantIds: string[] = [];
  let app: Awaited<ReturnType<typeof buildApp>>;

  beforeAll(async () => {
    app = await buildApp();
  });

  afterAll(async () => {
    if (createdTenantIds.length > 0) {
      await prisma.tenant.deleteMany({ where: { id: { in: createdTenantIds } } });
    }
    await app.close();
  });

  function uniqueSlug() {
    return `test-co-${randomUUID().replace(/-/g, "").slice(0, 12)}`;
  }

  describe("POST /api/v1/tenants/onboard", () => {
    it("creates tenant with admin, subscription, storage quota, tax config, deal stages, and payment term", async () => {
      const slug = uniqueSlug();

      const res = await app.inject({
        method: "POST",
        url: "/api/v1/tenants/onboard",
        payload: {
          companyName: "Acme Corp",
          companySlug: slug,
          admin: { email: `admin@${slug}.com`, fullName: "Alice Admin" },
          billing: {
            seatPriceCents: 1500,
            initialSeatCount: 3,
            currency: "THB",
            paymentMethodRef: "pm_test_abc123",
            overagePricePerGb: 50,
            includedBytes: 2_147_483_648
          }
        }
      });

      expect(res.statusCode).toBe(201);
      const body = res.json();
      expect(body.tenantId).toBeTruthy();
      expect(body.adminUserId).toBeTruthy();
      expect(body.defaultPaymentTermId).toBeTruthy();
      createdTenantIds.push(body.tenantId);

      // onboarding response contains temp credentials and billing snapshot
      expect(body.onboarding.firstAdminEmail).toBe(`admin@${slug}.com`);
      expect(body.onboarding.temporaryPassword).toMatch(/^ThinkCRM-/);
      expect(body.onboarding.billing.seatPriceCents).toBe(1500);
      expect(body.onboarding.billing.seatCount).toBe(3);
      expect(body.onboarding.billing.currency).toBe("THB");
      expect(body.onboarding.billing.paymentMethodRef).toBe("pm_test_abc123");
      expect(body.onboarding.billing.includedBytes).toBe(2_147_483_648);
      expect(body.onboarding.billing.overagePricePerGb).toBe(50);

      // admin user should have mustResetPassword flag set
      const adminUser = await prisma.user.findUnique({ where: { id: body.adminUserId } });
      expect(adminUser?.role).toBe(UserRole.ADMIN);
      expect(adminUser?.mustResetPassword).toBe(true);

      // subscription should be active with correct seat config
      const subscription = await prisma.subscription.findFirst({
        where: { tenantId: body.tenantId },
        orderBy: { createdAt: "desc" }
      });
      expect(subscription?.status).toBe("ACTIVE");
      expect(subscription?.seatCount).toBe(3);
      expect(subscription?.seatPriceCents).toBe(1500);
      expect(subscription?.pricingModel).toBe("FIXED_PER_USER");
      expect(subscription?.billingPeriodEnd).toBeTruthy();

      // storage quota provisioned
      const quota = await prisma.tenantStorageQuota.findFirst({ where: { tenantId: body.tenantId } });
      expect(quota?.includedBytes.toString()).toBe("2147483648");
      expect(quota?.overagePricePerGb).toBe(50);

      // tax config provisioned
      const tax = await prisma.tenantTaxConfig.findUnique({ where: { tenantId: body.tenantId } });
      expect(tax?.vatEnabled).toBe(true);

      // deal stages seeded
      const stages = await prisma.dealStage.findMany({
        where: { tenantId: body.tenantId },
        orderBy: { stageOrder: "asc" }
      });
      expect(stages.length).toBeGreaterThanOrEqual(4);
      expect(stages.some((s) => s.isDefault)).toBe(true);
      expect(stages.some((s) => s.isClosedWon)).toBe(true);
      expect(stages.some((s) => s.isClosedLost)).toBe(true);

      // default payment term seeded
      const term = await prisma.paymentTerm.findUnique({ where: { id: body.defaultPaymentTermId } });
      expect(term?.code).toBe("NET30");
      expect(term?.dueDays).toBe(30);

      // quotation form config seeded
      const formConfig = await prisma.quotationFormConfig.findUnique({ where: { tenantId: body.tenantId } });
      expect(formConfig).toBeTruthy();
    });

    it("rejects a duplicate company slug with 409", async () => {
      const slug = uniqueSlug();

      const first = await app.inject({
        method: "POST",
        url: "/api/v1/tenants/onboard",
        payload: {
          companyName: "First Co",
          companySlug: slug,
          admin: { email: `admin@${slug}.com`, fullName: "First Admin" },
          billing: {
            seatPriceCents: 1000,
            initialSeatCount: 1,
            currency: "THB",
            paymentMethodRef: "pm_first"
          }
        }
      });
      expect(first.statusCode).toBe(201);
      createdTenantIds.push(first.json().tenantId);

      const duplicate = await app.inject({
        method: "POST",
        url: "/api/v1/tenants/onboard",
        payload: {
          companyName: "Duplicate Co",
          companySlug: slug,
          admin: { email: `other@${slug}.com`, fullName: "Other Admin" },
          billing: {
            seatPriceCents: 1000,
            initialSeatCount: 1,
            currency: "THB",
            paymentMethodRef: "pm_other"
          }
        }
      });
      expect(duplicate.statusCode).toBe(409);
    });

    it("rejects invalid input with 400", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/tenants/onboard",
        payload: {
          companyName: "X",
          companySlug: "UPPERCASE_NOT_ALLOWED",
          admin: { email: "not-an-email", fullName: "A" },
          billing: { seatPriceCents: -1, initialSeatCount: 0, currency: "XX", paymentMethodRef: "" }
        }
      });
      expect(res.statusCode).toBe(400);
    });
  });

  describe("GET /api/v1/tenants/:tenantId/summary", () => {
    async function setupTenantWithUsers() {
      const slug = uniqueSlug();
      const tenant = await prisma.tenant.create({ data: { name: "Summary Co", slug } });
      createdTenantIds.push(tenant.id);

      const [admin, manager, rep] = await Promise.all([
        prisma.user.create({
          data: {
            tenantId: tenant.id,
            email: `admin@${slug}.com`,
            fullName: "Admin",
            role: UserRole.ADMIN,
            passwordHash: hashPassword("Password1!")
          }
        }),
        prisma.user.create({
          data: {
            tenantId: tenant.id,
            email: `mgr@${slug}.com`,
            fullName: "Manager",
            role: UserRole.MANAGER,
            passwordHash: hashPassword("Password1!")
          }
        }),
        prisma.user.create({
          data: {
            tenantId: tenant.id,
            email: `rep@${slug}.com`,
            fullName: "Rep",
            role: UserRole.REP,
            passwordHash: hashPassword("Password1!")
          }
        })
      ]);

      const [adminToken, managerToken, repToken] = await Promise.all([
        app.jwt.sign({ tenantId: tenant.id, userId: admin.id, role: admin.role, email: admin.email }),
        app.jwt.sign({ tenantId: tenant.id, userId: manager.id, role: manager.role, email: manager.email }),
        app.jwt.sign({ tenantId: tenant.id, userId: rep.id, role: rep.role, email: rep.email })
      ]);

      return { tenantId: tenant.id, adminToken, managerToken, repToken };
    }

    it("returns full tenant summary for admin", async () => {
      const { tenantId, adminToken } = await setupTenantWithUsers();

      const res = await app.inject({
        method: "GET",
        url: `/api/v1/tenants/${tenantId}/summary`,
        headers: { authorization: `Bearer ${adminToken}` }
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.id).toBe(tenantId);
      expect(body.users).toBeDefined();
      expect(body.subscriptions).toBeDefined();
    });

    it("returns full tenant summary for manager", async () => {
      const { tenantId, managerToken } = await setupTenantWithUsers();

      const res = await app.inject({
        method: "GET",
        url: `/api/v1/tenants/${tenantId}/summary`,
        headers: { authorization: `Bearer ${managerToken}` }
      });

      expect(res.statusCode).toBe(200);
    });

    it("denies access to REP role with 403", async () => {
      const { tenantId, repToken } = await setupTenantWithUsers();

      const res = await app.inject({
        method: "GET",
        url: `/api/v1/tenants/${tenantId}/summary`,
        headers: { authorization: `Bearer ${repToken}` }
      });

      expect(res.statusCode).toBe(403);
    });

    it("denies cross-tenant access with 403", async () => {
      const { adminToken } = await setupTenantWithUsers();

      const otherSlug = uniqueSlug();
      const otherTenant = await prisma.tenant.create({ data: { name: "Other Co", slug: otherSlug } });
      createdTenantIds.push(otherTenant.id);

      const res = await app.inject({
        method: "GET",
        url: `/api/v1/tenants/${otherTenant.id}/summary`,
        headers: { authorization: `Bearer ${adminToken}` }
      });

      expect(res.statusCode).toBe(403);
    });

    it("returns 404 for non-existent tenant accessed by a same-tenant admin", async () => {
      const slug = uniqueSlug();
      const tenant = await prisma.tenant.create({ data: { name: "Ghost Finder", slug } });
      createdTenantIds.push(tenant.id);
      const admin = await prisma.user.create({
        data: {
          tenantId: tenant.id,
          email: `ghost@${slug}.com`,
          fullName: "Ghost Admin",
          role: UserRole.ADMIN,
          passwordHash: hashPassword("Password1!")
        }
      });
      // sign token with the non-existent tenant id so path check passes
      const fakeId = randomUUID();
      const token = await app.jwt.sign({ tenantId: fakeId, userId: admin.id, role: admin.role, email: admin.email });

      const res = await app.inject({
        method: "GET",
        url: `/api/v1/tenants/${fakeId}/summary`,
        headers: { authorization: `Bearer ${token}` }
      });

      expect(res.statusCode).toBe(404);
    });
  });
});
