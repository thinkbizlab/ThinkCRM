import { ExecutionStatus, SourceStatus, UserRole } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../../app.js";
import { hashPassword } from "../../lib/password.js";
import { prisma } from "../../lib/prisma.js";

describe("tenant integration credential routes", () => {
  const createdTenantIds: string[] = [];
  let app: Awaited<ReturnType<typeof buildApp>>;

  beforeAll(async () => {
    app = await buildApp();
  });

  afterAll(async () => {
    if (createdTenantIds.length > 0) {
      await prisma.integrationExecutionLog.deleteMany({
        where: {
          tenantId: {
            in: createdTenantIds
          }
        }
      });
      await prisma.tenantIntegrationCredential.deleteMany({
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

  async function setupTenantFixture() {
    const suffix = randomUUID();
    const tenant = await prisma.tenant.create({
      data: {
        name: `Integration Tenant ${suffix}`,
        slug: `integration-tenant-${suffix}`
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

    const [adminToken, managerToken] = await Promise.all([
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
      })
    ]);

    return {
      tenantId: tenant.id,
      adminToken,
      managerToken
    };
  }

  it("saves credentials, requires successful test before enabling, and then enables", async () => {
    const fixture = await setupTenantFixture();

    const initialList = await app.inject({
      method: "GET",
      url: `/api/v1/tenants/${fixture.tenantId}/integrations/credentials`,
      headers: {
        authorization: `Bearer ${fixture.managerToken}`
      }
    });
    expect(initialList.statusCode).toBe(200);
    expect(initialList.json()).toHaveLength(6);

    const saveCredentials = await app.inject({
      method: "PUT",
      url: `/api/v1/tenants/${fixture.tenantId}/integrations/credentials/MS365`,
      headers: {
        authorization: `Bearer ${fixture.adminToken}`
      },
      payload: {
        clientId: "ms365-client",
        clientSecret: "ms365-secret"
      }
    });
    expect(saveCredentials.statusCode).toBe(200);
    expect(saveCredentials.json().status).toBe(SourceStatus.DISABLED);

    const enableBeforeTest = await app.inject({
      method: "PATCH",
      url: `/api/v1/tenants/${fixture.tenantId}/integrations/credentials/MS365/enable`,
      headers: {
        authorization: `Bearer ${fixture.adminToken}`
      },
      payload: { enabled: true }
    });
    expect(enableBeforeTest.statusCode).toBe(400);

    const runTest = await app.inject({
      method: "POST",
      url: `/api/v1/tenants/${fixture.tenantId}/integrations/credentials/MS365/test`,
      headers: {
        authorization: `Bearer ${fixture.managerToken}`
      }
    });
    expect(runTest.statusCode).toBe(200);
    expect(runTest.json().ok).toBe(true);
    expect(runTest.json().credential.lastTestStatus).toBe(ExecutionStatus.SUCCESS);

    const enableAfterTest = await app.inject({
      method: "PATCH",
      url: `/api/v1/tenants/${fixture.tenantId}/integrations/credentials/MS365/enable`,
      headers: {
        authorization: `Bearer ${fixture.managerToken}`
      },
      payload: { enabled: true }
    });
    expect(enableAfterTest.statusCode).toBe(200);
    expect(enableAfterTest.json().status).toBe(SourceStatus.ENABLED);
    expect(enableAfterTest.json().isEnabled).toBe(true);
  });

  it("fails connection test with invalid values and keeps integration disabled", async () => {
    const fixture = await setupTenantFixture();

    const saveCredentials = await app.inject({
      method: "PUT",
      url: `/api/v1/tenants/${fixture.tenantId}/integrations/credentials/SLACK`,
      headers: {
        authorization: `Bearer ${fixture.managerToken}`
      },
      payload: {
        apiKey: "fail-this-token"
      }
    });
    expect(saveCredentials.statusCode).toBe(200);

    const runTest = await app.inject({
      method: "POST",
      url: `/api/v1/tenants/${fixture.tenantId}/integrations/credentials/SLACK/test`,
      headers: {
        authorization: `Bearer ${fixture.managerToken}`
      }
    });
    expect(runTest.statusCode).toBe(200);
    expect(runTest.json().ok).toBe(false);
    expect(runTest.json().credential.lastTestStatus).toBe(ExecutionStatus.FAILURE);
    expect(runTest.json().credential.status).toBe(SourceStatus.DISABLED);

    const enableAfterFailedTest = await app.inject({
      method: "PATCH",
      url: `/api/v1/tenants/${fixture.tenantId}/integrations/credentials/SLACK/enable`,
      headers: {
        authorization: `Bearer ${fixture.managerToken}`
      },
      payload: { enabled: true }
    });
    expect(enableAfterFailedTest.statusCode).toBe(400);
  });
});
