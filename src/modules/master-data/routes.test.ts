import { CustomerStatus, UserRole } from "@prisma/client";
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
          name: "Acme HQ"
        },
        {
          tenantId,
          ownerId: repId,
          customerCode: `CUST-R-${suffix.slice(0, 6)}`,
          name: "Acme Retail"
        },
        {
          tenantId,
          ownerId: repId,
          customerCode: `CUST-D-${suffix.slice(0, 6)}`,
          name: "Acme Dormant",
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

describe("draft customer workflow", () => {
  const createdTenantIds: string[] = [];
  let app: Awaited<ReturnType<typeof buildApp>>;

  beforeAll(async () => {
    app = await buildApp();
  });

  afterAll(async () => {
    if (createdTenantIds.length > 0) {
      const scope = { tenantId: { in: createdTenantIds } };
      await prisma.entityChangelog.deleteMany({ where: scope });
      await prisma.auditLog.deleteMany({ where: scope });
      await prisma.customerContact.deleteMany({
        where: { customer: { tenantId: { in: createdTenantIds } } }
      });
      await prisma.customerAddress.deleteMany({
        where: { customer: { tenantId: { in: createdTenantIds } } }
      });
      await prisma.customer.deleteMany({ where: scope });
      await prisma.paymentTerm.deleteMany({ where: scope });
      await prisma.user.deleteMany({ where: scope });
      await prisma.tenant.deleteMany({ where: { id: { in: createdTenantIds } } });
    }
    await app.close();
  });

  async function setupErpLockedTenant() {
    const suffix = randomUUID().replace(/-/g, "").slice(0, 12);
    const tenantId = `tenant_draft_${suffix}`;
    const adminId = `admin_draft_${suffix}`;
    const termId = `term_draft_${suffix}`;
    createdTenantIds.push(tenantId);

    await prisma.tenant.create({
      data: {
        id: tenantId,
        name: `Draft Tenant ${suffix}`,
        slug: `draft-tenant-${suffix}`,
        manageCustomersByApi: true
      }
    });
    await prisma.user.create({
      data: {
        id: adminId,
        tenantId,
        email: `admin-${suffix}@example.com`,
        passwordHash: "not-used",
        fullName: "Admin Draft",
        role: UserRole.ADMIN
      }
    });
    await prisma.paymentTerm.create({
      data: { id: termId, tenantId, code: `NET-${suffix}`, name: "Net 30", dueDays: 30 }
    });

    const token = await app.jwt.sign({
      tenantId, userId: adminId, role: UserRole.ADMIN, email: `admin-${suffix}@example.com`
    });
    return { tenantId, adminId, termId, auth: { authorization: `Bearer ${token}` } };
  }

  it("lets reps capture a DRAFT customer even when manageCustomersByApi is ON", async () => {
    const fixture = await setupErpLockedTenant();

    const blocked = await app.inject({
      method: "POST",
      url: "/api/v1/customers",
      headers: fixture.auth,
      payload: {
        customerCode: "CUST-SHOULD-FAIL",
        name: "Regular Create",
        customerType: "COMPANY"
      }
    });
    expect(blocked.statusCode).toBe(403);

    const draft = await app.inject({
      method: "POST",
      url: "/api/v1/customers",
      headers: fixture.auth,
      payload: {
        status: "DRAFT",
        name: "Field Prospect Co",
        customerType: "COMPANY",
        taxId: "0999999999999"
      }
    });
    expect(draft.statusCode).toBe(201);
    const created = draft.json();
    expect(created.status).toBe(CustomerStatus.DRAFT);
    expect(created.customerCode).toBeNull();
    expect(created.draftCreatedByUserId).toBe(fixture.adminId);
  });

  it("reuses an existing customer when a DRAFT is created with a matching taxId", async () => {
    const fixture = await setupErpLockedTenant();

    const original = await prisma.customer.create({
      data: {
        tenantId: fixture.tenantId,
        ownerId: fixture.adminId,
        name: "Existing ERP Customer",
        customerCode: `ERP-${randomUUID().slice(0, 8)}`,
        customerType: "COMPANY",
        taxId: "0105555123456",
        // The route's create path defaults branchCode to "00000" when taxId
        // is set, and the duplicate lookup keys on (taxId, branchCode). The
        // fixture must mirror that pair to be discoverable.
        branchCode: "00000",
        status: CustomerStatus.ACTIVE
      }
    });

    const attempt = await app.inject({
      method: "POST",
      url: "/api/v1/customers",
      headers: fixture.auth,
      payload: {
        status: "DRAFT",
        name: "Prospect that collides with ERP",
        customerType: "COMPANY",
        taxId: "0105555123456"
      }
    });

    expect(attempt.statusCode).toBe(200);
    const body = attempt.json();
    expect(body.reusedExisting).toBe(true);
    expect(body.id).toBe(original.id);
  });

  it("promotes a DRAFT to ACTIVE with a customer code", async () => {
    const fixture = await setupErpLockedTenant();

    const draft = await prisma.customer.create({
      data: {
        tenantId: fixture.tenantId,
        ownerId: fixture.adminId,
        draftCreatedByUserId: fixture.adminId,
        name: "Awaiting Promotion",
        customerType: "COMPANY",
        status: CustomerStatus.DRAFT
      }
    });

    const code = `PROMO-${randomUUID().slice(0, 8)}`;
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/customers/${draft.id}/promote`,
      headers: fixture.auth,
      payload: { customerCode: code }
    });
    expect(res.statusCode).toBe(200);
    const promoted = res.json();
    expect(promoted.status).toBe(CustomerStatus.ACTIVE);
    expect(promoted.customerCode).toBe(code);
    expect(promoted.promotedAt).toBeTruthy();
  });
});
