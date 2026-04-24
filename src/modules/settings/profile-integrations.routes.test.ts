import { UserRole } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../../build-app.js";
import { hashPassword } from "../../lib/password.js";
import { prisma } from "../../lib/prisma.js";

describe("profile integration binding routes", () => {
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
      await prisma.userExternalAccount.deleteMany({
        where: {
          user: {
            tenantId: {
              in: createdTenantIds
            }
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

  async function setupFixture() {
    const suffix = randomUUID();
    const tenant = await prisma.tenant.create({
      data: {
        name: `Profile Integration ${suffix}`,
        slug: `profile-integration-${suffix}`
      }
    });
    createdTenantIds.push(tenant.id);

    const [manager, rep] = await Promise.all([
      prisma.user.create({
        data: {
          tenantId: tenant.id,
          email: `manager-${suffix}@example.com`,
          fullName: "Manager",
          role: UserRole.MANAGER,
          passwordHash: hashPassword("Password123!")
        }
      }),
      prisma.user.create({
        data: {
          tenantId: tenant.id,
          email: `rep-${suffix}@example.com`,
          fullName: "Rep",
          role: UserRole.REP,
          passwordHash: hashPassword("Password123!")
        }
      })
    ]);

    await prisma.user.update({
      where: { id: rep.id },
      data: { managerUserId: manager.id }
    });

    const [repToken, managerToken] = await Promise.all([
      app.jwt.sign({
        tenantId: tenant.id,
        userId: rep.id,
        role: rep.role,
        email: rep.email
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
      userIds: {
        manager: manager.id,
        rep: rep.id
      },
      tokens: {
        rep: repToken,
        manager: managerToken
      }
    };
  }

  it("binds MS365, Google Calendar, and LINE accounts with sync metadata", async () => {
    const fixture = await setupFixture();

    const connectMs365 = await app.inject({
      method: "POST",
      url: `/api/v1/users/${fixture.userIds.rep}/integrations/ms365/connect`,
      headers: {
        authorization: `Bearer ${fixture.tokens.rep}`
      },
      payload: {
        externalUserId: "rep@contoso.com",
        accessTokenRef: "secret://ms365/access",
        refreshTokenRef: "secret://ms365/refresh"
      }
    });
    expect(connectMs365.statusCode).toBe(201);
    expect(connectMs365.json().provider).toBe("MS365");

    const connectGoogle = await app.inject({
      method: "POST",
      url: `/api/v1/users/${fixture.userIds.rep}/integrations/google/connect`,
      headers: {
        authorization: `Bearer ${fixture.tokens.rep}`
      },
      payload: {
        externalUserId: "rep@gmail.com",
        accessTokenRef: "secret://google/access"
      }
    });
    expect(connectGoogle.statusCode).toBe(201);
    expect(connectGoogle.json().provider).toBe("GOOGLE");

    const connectLine = await app.inject({
      method: "POST",
      url: `/api/v1/users/${fixture.userIds.rep}/integrations/line/connect`,
      headers: {
        authorization: `Bearer ${fixture.tokens.rep}`
      },
      payload: {
        externalUserId: "line-user-123"
      }
    });
    expect(connectLine.statusCode).toBe(201);
    expect(connectLine.json().provider).toBe("LINE");

    const list = await app.inject({
      method: "GET",
      url: `/api/v1/users/${fixture.userIds.rep}/integrations`,
      headers: {
        authorization: `Bearer ${fixture.tokens.rep}`
      }
    });
    expect(list.statusCode).toBe(200);
    const payload = list.json();
    expect(payload).toHaveLength(5);

    const ms365 = payload.find((item: { provider: string }) => item.provider === "MS365");
    const google = payload.find((item: { provider: string }) => item.provider === "GOOGLE");
    const line = payload.find((item: { provider: string }) => item.provider === "LINE");

    expect(ms365?.status).toBe("CONNECTED");
    expect(ms365?.lastCalendarSyncAt).toBeTruthy();
    expect(ms365?.lastNotificationSyncAt).toBeNull();
    expect(ms365?.capabilities).toEqual({
      calendarSyncEnabled: true,
      notificationsEnabled: false
    });

    expect(google?.status).toBe("CONNECTED");
    expect(google?.lastCalendarSyncAt).toBeTruthy();
    expect(google?.lastNotificationSyncAt).toBeNull();

    expect(line?.status).toBe("CONNECTED");
    expect(line?.lastCalendarSyncAt).toBeNull();
    expect(line?.lastNotificationSyncAt).toBeTruthy();
    expect(line?.capabilities).toEqual({
      calendarSyncEnabled: false,
      notificationsEnabled: true
    });
  });

  it("allows managers to connect and disconnect subordinate profile integrations", async () => {
    const fixture = await setupFixture();

    const connectLine = await app.inject({
      method: "POST",
      url: `/api/v1/users/${fixture.userIds.rep}/integrations/line/connect`,
      headers: {
        authorization: `Bearer ${fixture.tokens.manager}`
      },
      payload: {
        externalUserId: "line-subordinate"
      }
    });
    expect(connectLine.statusCode).toBe(201);

    const disconnectLine = await app.inject({
      method: "DELETE",
      url: `/api/v1/users/${fixture.userIds.rep}/integrations/line`,
      headers: {
        authorization: `Bearer ${fixture.tokens.manager}`
      }
    });
    expect(disconnectLine.statusCode).toBe(200);
    expect(disconnectLine.json().status).toBe("DISCONNECTED");
  });
});
