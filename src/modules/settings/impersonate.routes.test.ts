import { UserRole } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../../build-app.js";
import { prisma } from "../../lib/prisma.js";

describe("POST /admin/impersonate/:userId", () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  const createdTenantIds: string[] = [];

  beforeAll(async () => { app = await buildApp(); });
  afterAll(async () => {
    if (createdTenantIds.length) {
      await prisma.auditLog.deleteMany({ where: { tenantId: { in: createdTenantIds } } });
      await prisma.user.deleteMany({ where: { tenantId: { in: createdTenantIds } } });
      await prisma.tenant.deleteMany({ where: { id: { in: createdTenantIds } } });
    }
    await app.close();
  });

  async function fixture() {
    const t = randomUUID().replace(/-/g, "").slice(0, 16);
    const tenantId = `t_imp_${t}`;
    createdTenantIds.push(tenantId);
    await prisma.tenant.create({ data: { id: tenantId, name: `T ${t}`, slug: `t-imp-${t}` } });
    await prisma.user.createMany({
      data: [
        { id: `adm_${t}`, tenantId, email: `adm-${t}@e.com`, fullName: "Admin", role: UserRole.ADMIN },
        { id: `mgr_${t}`, tenantId, email: `mgr-${t}@e.com`, fullName: "Manager", role: UserRole.MANAGER },
        { id: `rep_${t}`, tenantId, email: `rep-${t}@e.com`, fullName: "Rep", role: UserRole.REP },
        { id: `inactive_${t}`, tenantId, email: `inactive-${t}@e.com`, fullName: "Gone", role: UserRole.REP, isActive: false }
      ]
    });
    return { tenantId, adminId: `adm_${t}`, managerId: `mgr_${t}`, repId: `rep_${t}`, inactiveId: `inactive_${t}` };
  }

  async function tokenFor(tenantId: string, userId: string, role: UserRole) {
    return app.jwt.sign({ tenantId, userId, role, email: `${userId}@t` });
  }

  it("admin can impersonate any active user in same tenant; returns short-lived token", async () => {
    const f = await fixture();
    const token = await tokenFor(f.tenantId, f.adminId, UserRole.ADMIN);
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/admin/impersonate/${f.repId}`,
      headers: { authorization: `Bearer ${token}` }
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.token).toBeTruthy();
    expect(body.userId).toBe(f.repId);
    expect(body.expiresIn).toBe("1h");

    // Verify the issued token actually authenticates as the target user
    const me = await app.inject({
      method: "GET",
      url: "/api/v1/whoami",
      headers: { authorization: `Bearer ${body.token}` }
    });
    expect(me.statusCode).toBe(200);
    expect(me.json().userId).toBe(f.repId);
    expect(me.json().role).toBe(UserRole.REP);

    // Audit row written
    const audit = await prisma.auditLog.findFirst({
      where: { tenantId: f.tenantId, action: "TENANT_ADMIN_IMPERSONATE", userId: f.adminId }
    });
    expect(audit).not.toBeNull();
  });

  it("non-admin cannot impersonate (manager forbidden)", async () => {
    const f = await fixture();
    const token = await tokenFor(f.tenantId, f.managerId, UserRole.MANAGER);
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/admin/impersonate/${f.repId}`,
      headers: { authorization: `Bearer ${token}` }
    });
    expect(res.statusCode).toBe(403);
  });

  it("admin cannot impersonate themselves", async () => {
    const f = await fixture();
    const token = await tokenFor(f.tenantId, f.adminId, UserRole.ADMIN);
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/admin/impersonate/${f.adminId}`,
      headers: { authorization: `Bearer ${token}` }
    });
    expect(res.statusCode).toBe(400);
  });

  it("admin cannot impersonate inactive user", async () => {
    const f = await fixture();
    const token = await tokenFor(f.tenantId, f.adminId, UserRole.ADMIN);
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/admin/impersonate/${f.inactiveId}`,
      headers: { authorization: `Bearer ${token}` }
    });
    expect(res.statusCode).toBe(404);
  });

  it("admin cannot impersonate a user from a different tenant", async () => {
    const a = await fixture();
    const b = await fixture();
    const token = await tokenFor(a.tenantId, a.adminId, UserRole.ADMIN);
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/admin/impersonate/${b.repId}`,
      headers: { authorization: `Bearer ${token}` }
    });
    expect(res.statusCode).toBe(404);
  });
});
