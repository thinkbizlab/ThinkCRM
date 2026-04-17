import { ChannelType, UserRole } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../../build-app.js";
import { hashPassword } from "../../lib/password.js";
import { prisma } from "../../lib/prisma.js";

describe("team structure and notification channel routes", () => {
  const createdTenantIds: string[] = [];
  let app: Awaited<ReturnType<typeof buildApp>>;

  beforeAll(async () => {
    app = await buildApp();
  });

  afterAll(async () => {
    if (createdTenantIds.length > 0) {
      await prisma.teamNotificationChannel.deleteMany({
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

  async function setupTeamFixture() {
    const suffix = randomUUID();
    const tenant = await prisma.tenant.create({
      data: {
        name: `Team Tenant ${suffix}`,
        slug: `team-tenant-${suffix}`
      }
    });
    createdTenantIds.push(tenant.id);

    const [admin, manager, rep, supervisor] = await Promise.all([
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
          email: `rep-${suffix}@example.com`,
          fullName: "Rep User",
          role: UserRole.REP,
          passwordHash: hashPassword("Password123!")
        }
      }),
      prisma.user.create({
        data: {
          tenantId: tenant.id,
          email: `supervisor-${suffix}@example.com`,
          fullName: "Supervisor User",
          role: UserRole.SUPERVISOR,
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
        userId: rep.id,
        role: rep.role,
        email: rep.email
      })
    ]);

    return {
      tenantId: tenant.id,
      tokens: {
        admin: adminToken,
        manager: managerToken,
        rep: repToken
      },
      users: {
        adminId: admin.id,
        managerId: manager.id,
        repId: rep.id,
        supervisorId: supervisor.id
      }
    };
  }

  it("manages teams, assigns reps, and configures team channels", async () => {
    const fixture = await setupTeamFixture();

    const createNorth = await app.inject({
      method: "POST",
      url: "/api/v1/teams",
      headers: {
        authorization: `Bearer ${fixture.tokens.manager}`
      },
      payload: {
        teamName: "North Team"
      }
    });
    expect(createNorth.statusCode).toBe(201);
    const northTeamId = createNorth.json().id as string;

    const createSouth = await app.inject({
      method: "POST",
      url: "/api/v1/teams",
      headers: {
        authorization: `Bearer ${fixture.tokens.admin}`
      },
      payload: {
        teamName: "South Team"
      }
    });
    expect(createSouth.statusCode).toBe(201);
    const southTeamId = createSouth.json().id as string;

    const duplicateTeam = await app.inject({
      method: "POST",
      url: "/api/v1/teams",
      headers: {
        authorization: `Bearer ${fixture.tokens.manager}`
      },
      payload: {
        teamName: "North Team"
      }
    });
    expect(duplicateTeam.statusCode).toBe(409);

    const assignToSouth = await app.inject({
      method: "POST",
      url: `/api/v1/teams/${southTeamId}/members`,
      headers: {
        authorization: `Bearer ${fixture.tokens.manager}`
      },
      payload: {
        userId: fixture.users.repId
      }
    });
    expect(assignToSouth.statusCode).toBe(200);
    expect(assignToSouth.json().previousTeamId).toBeNull();
    expect(assignToSouth.json().assignedTeamId).toBe(southTeamId);

    const assignToNorth = await app.inject({
      method: "POST",
      url: `/api/v1/teams/${northTeamId}/members`,
      headers: {
        authorization: `Bearer ${fixture.tokens.manager}`
      },
      payload: {
        userId: fixture.users.repId
      }
    });
    expect(assignToNorth.statusCode).toBe(200);
    expect(assignToNorth.json().previousTeamId).toBe(southTeamId);
    expect(assignToNorth.json().member.team.id).toBe(northTeamId);

    const configureChannels = await app.inject({
      method: "PUT",
      url: `/api/v1/teams/${northTeamId}/notification-channels`,
      headers: {
        authorization: `Bearer ${fixture.tokens.admin}`
      },
      payload: {
        channels: [
          { channelType: ChannelType.MS_TEAMS, channelTarget: "teams://north-sales" },
          { channelType: ChannelType.EMAIL, channelTarget: "north-team@example.com" },
          { channelType: ChannelType.SLACK, channelTarget: "#north-team", isEnabled: true },
          { channelType: ChannelType.LINE, channelTarget: "line-group:north-team", isEnabled: false }
        ]
      }
    });
    expect(configureChannels.statusCode).toBe(200);
    expect(configureChannels.json().channels).toHaveLength(4);

    const listTeams = await app.inject({
      method: "GET",
      url: "/api/v1/teams",
      headers: {
        authorization: `Bearer ${fixture.tokens.manager}`
      }
    });
    expect(listTeams.statusCode).toBe(200);
    const teams = listTeams.json();
    const northTeam = teams.find((team: { id: string }) => team.id === northTeamId);
    expect(northTeam).toBeTruthy();
    expect(northTeam.members).toHaveLength(1);
    expect(northTeam.members[0].id).toBe(fixture.users.repId);
    expect(northTeam.channels).toHaveLength(4);

    const updateTeam = await app.inject({
      method: "PATCH",
      url: `/api/v1/teams/${northTeamId}`,
      headers: {
        authorization: `Bearer ${fixture.tokens.manager}`
      },
      payload: {
        teamName: "North Team Prime",
        isActive: false
      }
    });
    expect(updateTeam.statusCode).toBe(200);
    expect(updateTeam.json().teamName).toBe("North Team Prime");
    expect(updateTeam.json().isActive).toBe(false);
  });

  it("allows only manager-or-higher to manage team structures", async () => {
    const fixture = await setupTeamFixture();
    const createTeamByRep = await app.inject({
      method: "POST",
      url: "/api/v1/teams",
      headers: {
        authorization: `Bearer ${fixture.tokens.rep}`
      },
      payload: {
        teamName: "Blocked Team"
      }
    });
    expect(createTeamByRep.statusCode).toBe(403);
  });

  it("rejects non-rep user assignment into a sales team", async () => {
    const fixture = await setupTeamFixture();
    const createTeam = await app.inject({
      method: "POST",
      url: "/api/v1/teams",
      headers: {
        authorization: `Bearer ${fixture.tokens.manager}`
      },
      payload: {
        teamName: "Central Team"
      }
    });
    expect(createTeam.statusCode).toBe(201);

    const assignSupervisor = await app.inject({
      method: "POST",
      url: `/api/v1/teams/${createTeam.json().id as string}/members`,
      headers: {
        authorization: `Bearer ${fixture.tokens.manager}`
      },
      payload: {
        userId: fixture.users.supervisorId
      }
    });
    expect(assignSupervisor.statusCode).toBe(400);
    expect(assignSupervisor.json().message).toContain("sales rep");
  });
});
