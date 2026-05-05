import { UserRole } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../../build-app.js";
import { prisma } from "../../lib/prisma.js";

describe("DELETE /users/pending-invites/:id", () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  const createdTenantIds: string[] = [];

  beforeAll(async () => { app = await buildApp(); });
  afterAll(async () => {
    if (createdTenantIds.length) {
      await prisma.userInvite.deleteMany({ where: { tenantId: { in: createdTenantIds } } });
      await prisma.auditLog.deleteMany({ where: { tenantId: { in: createdTenantIds } } });
      await prisma.user.deleteMany({ where: { tenantId: { in: createdTenantIds } } });
      await prisma.tenant.deleteMany({ where: { id: { in: createdTenantIds } } });
    }
    await app.close();
  });

  async function fixture() {
    const t = randomUUID().replace(/-/g, "").slice(0, 16);
    const tenantId = `t_rev_${t}`;
    createdTenantIds.push(tenantId);
    await prisma.tenant.create({ data: { id: tenantId, name: `T ${t}`, slug: `t-rev-${t}` } });
    await prisma.user.createMany({
      data: [
        { id: `adm_${t}`, tenantId, email: `adm-${t}@e.com`, fullName: "Admin", role: UserRole.ADMIN },
        { id: `mgr_${t}`, tenantId, email: `mgr-${t}@e.com`, fullName: "Manager", role: UserRole.MANAGER }
      ]
    });
    const pending = await prisma.userInvite.create({
      data: {
        tenantId,
        email: `newhire-${t}@e.com`,
        role: UserRole.REP,
        token: `tok_pending_${t}`,
        expiresAt: new Date(Date.now() + 86400_000)
      }
    });
    const accepted = await prisma.userInvite.create({
      data: {
        tenantId,
        email: `joined-${t}@e.com`,
        role: UserRole.REP,
        token: `tok_accepted_${t}`,
        expiresAt: new Date(Date.now() + 86400_000),
        acceptedAt: new Date()
      }
    });
    return { tenantId, adminId: `adm_${t}`, managerId: `mgr_${t}`, pendingId: pending.id, acceptedId: accepted.id };
  }

  async function tokenFor(tenantId: string, userId: string, role: UserRole) {
    return app.jwt.sign({ tenantId, userId, role, email: `${userId}@t` });
  }

  it("admin revokes a pending invite; row is hard-deleted and audit row written", async () => {
    const f = await fixture();
    const token = await tokenFor(f.tenantId, f.adminId, UserRole.ADMIN);
    const res = await app.inject({
      method: "DELETE",
      url: `/api/v1/users/pending-invites/${f.pendingId}`,
      headers: { authorization: `Bearer ${token}` }
    });
    expect(res.statusCode).toBe(204);
    const stillThere = await prisma.userInvite.findUnique({ where: { id: f.pendingId } });
    expect(stillThere).toBeNull();
    const audit = await prisma.auditLog.findFirst({
      where: { tenantId: f.tenantId, action: "USER_INVITE_REVOKED", userId: f.adminId }
    });
    expect(audit).not.toBeNull();
  });

  it("non-admin cannot revoke (manager forbidden)", async () => {
    const f = await fixture();
    const token = await tokenFor(f.tenantId, f.managerId, UserRole.MANAGER);
    const res = await app.inject({
      method: "DELETE",
      url: `/api/v1/users/pending-invites/${f.pendingId}`,
      headers: { authorization: `Bearer ${token}` }
    });
    expect(res.statusCode).toBe(403);
  });

  it("refuses to revoke an already-accepted invite", async () => {
    const f = await fixture();
    const token = await tokenFor(f.tenantId, f.adminId, UserRole.ADMIN);
    const res = await app.inject({
      method: "DELETE",
      url: `/api/v1/users/pending-invites/${f.acceptedId}`,
      headers: { authorization: `Bearer ${token}` }
    });
    expect(res.statusCode).toBe(409);
  });

  it("returns 404 for cross-tenant invite", async () => {
    const a = await fixture();
    const b = await fixture();
    const token = await tokenFor(a.tenantId, a.adminId, UserRole.ADMIN);
    const res = await app.inject({
      method: "DELETE",
      url: `/api/v1/users/pending-invites/${b.pendingId}`,
      headers: { authorization: `Bearer ${token}` }
    });
    expect(res.statusCode).toBe(404);
  });
});
