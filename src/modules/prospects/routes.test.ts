import { CustomerStatus, ProspectStatus, UserRole, VisitStatus, VisitType } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../../build-app.js";
import { prisma } from "../../lib/prisma.js";

type Fixture = {
  tenantId: string;
  managerId: string;
  repId: string;
  managerAuth: { authorization: string };
  repAuth:     { authorization: string };
};

describe("prospects routes", () => {
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
      await prisma.visit.deleteMany({ where: scope });
      await prisma.prospectPhoto.deleteMany({ where: scope });
      await prisma.prospect.deleteMany({ where: scope });
      await prisma.customer.deleteMany({ where: scope });
      await prisma.paymentTerm.deleteMany({ where: scope });
      await prisma.user.deleteMany({ where: scope });
      await prisma.tenant.deleteMany({ where: { id: { in: createdTenantIds } } });
    }
    await app.close();
  });

  async function setup(): Promise<Fixture> {
    const suffix = randomUUID().replace(/-/g, "").slice(0, 12);
    const tenantId  = `tenant_${suffix}`;
    const managerId = `mgr_${suffix}`;
    const repId     = `rep_${suffix}`;
    createdTenantIds.push(tenantId);

    await prisma.tenant.create({
      data: { id: tenantId, name: `T ${suffix}`, slug: `t-${suffix}` }
    });
    await prisma.user.createMany({
      data: [
        { id: managerId, tenantId, email: `mgr-${suffix}@example.com`, passwordHash: "x", fullName: "Mgr", role: UserRole.MANAGER },
        { id: repId,     tenantId, email: `rep-${suffix}@example.com`, passwordHash: "x", fullName: "Rep", role: UserRole.REP, managerUserId: managerId }
      ]
    });
    const managerToken = await app.jwt.sign({ tenantId, userId: managerId, role: UserRole.MANAGER, email: `mgr-${suffix}@example.com` });
    const repToken     = await app.jwt.sign({ tenantId, userId: repId,     role: UserRole.REP,     email: `rep-${suffix}@example.com` });
    return {
      tenantId,
      managerId,
      repId,
      managerAuth: { authorization: `Bearer ${managerToken}` },
      repAuth:     { authorization: `Bearer ${repToken}` }
    };
  }

  it("creates a prospect and lists it under UNIDENTIFIED filter", async () => {
    const fx = await setup();
    const create = await app.inject({
      method: "POST",
      url: "/api/v1/prospects",
      headers: fx.repAuth,
      payload: {
        displayName: "Construction site at Sukhumvit 21",
        siteLat: 13.7373,
        siteLng: 100.5605,
        contactName: "On-site supervisor",
        notes: "Building under construction; rep talked to foreman."
      }
    });
    expect(create.statusCode).toBe(201);
    expect(create.json().status).toBe(ProspectStatus.UNIDENTIFIED);

    const list = await app.inject({
      method: "GET",
      url: "/api/v1/prospects?status=UNIDENTIFIED",
      headers: fx.repAuth
    });
    expect(list.statusCode).toBe(200);
    const body = list.json();
    expect(body.total).toBe(1);
    expect(body.rows[0].displayName).toBe("Construction site at Sukhumvit 21");
  });

  it("auto-creates a Prospect when an unplanned visit posts with no customer/prospect", async () => {
    const fx = await setup();
    const visitRes = await app.inject({
      method: "POST",
      url: "/api/v1/visits/unplanned",
      headers: fx.repAuth,
      payload: {
        siteLat: 13.7373,
        siteLng: 100.5605,
        objective: "Drop-in"
      }
    });
    expect(visitRes.statusCode).toBe(201);
    const visit = visitRes.json();
    expect(visit.customerId).toBeNull();
    expect(visit.prospectId).toBeTruthy();

    const created = await prisma.prospect.findUniqueOrThrow({
      where: { id: visit.prospectId },
      select: { displayName: true, status: true, siteLat: true }
    });
    expect(created.status).toBe(ProspectStatus.UNIDENTIFIED);
    expect(created.displayName).toContain("Unidentified site @");
    expect(created.siteLat).toBe(13.7373);
  });

  it("identifies a prospect against an existing customer and re-points its visits", async () => {
    const fx = await setup();
    // Create a Prospect + a Visit attached to it directly via prisma.
    const prospect = await prisma.prospect.create({
      data: {
        tenantId: fx.tenantId,
        status: ProspectStatus.UNIDENTIFIED,
        displayName: "Mystery site",
        createdById: fx.repId
      }
    });
    await prisma.visit.create({
      data: {
        tenantId: fx.tenantId,
        repId: fx.repId,
        prospectId: prospect.id,
        visitNo: `V-${Date.now()}`,
        visitType: VisitType.UNPLANNED,
        status: VisitStatus.CHECKED_OUT,
        plannedAt: new Date()
      }
    });
    // Existing customer to identify against.
    const customer = await prisma.customer.create({
      data: {
        tenantId: fx.tenantId,
        ownerId: fx.repId,
        customerCode: `ID-${Date.now()}`,
        name: "Resolved Co",
        status: CustomerStatus.ACTIVE
      }
    });

    const res = await app.inject({
      method: "POST",
      url: `/api/v1/prospects/${prospect.id}/identify`,
      headers: fx.repAuth,
      payload: { customerId: customer.id }
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe(ProspectStatus.LINKED);

    const visits = await prisma.visit.findMany({
      where: { tenantId: fx.tenantId },
      select: { customerId: true, prospectId: true }
    });
    expect(visits.length).toBe(1);
    expect(visits[0]!.customerId).toBe(customer.id);
    expect(visits[0]!.prospectId).toBeNull();
  });

  it("converts a prospect into a DRAFT customer and re-points its visits", async () => {
    const fx = await setup();
    const prospect = await prisma.prospect.create({
      data: {
        tenantId: fx.tenantId,
        status: ProspectStatus.UNIDENTIFIED,
        displayName: "Draft target",
        siteLat: 13.5,
        siteLng: 100.5,
        createdById: fx.repId
      }
    });
    await prisma.visit.create({
      data: {
        tenantId: fx.tenantId,
        repId: fx.repId,
        prospectId: prospect.id,
        visitNo: `V-${Date.now()}-2`,
        visitType: VisitType.UNPLANNED,
        status: VisitStatus.CHECKED_OUT,
        plannedAt: new Date()
      }
    });

    const res = await app.inject({
      method: "POST",
      url: `/api/v1/prospects/${prospect.id}/convert-to-draft`,
      headers: fx.repAuth,
      payload: {}
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.prospect.status).toBe(ProspectStatus.LINKED);
    expect(body.draftCustomer.status).toBe(CustomerStatus.DRAFT);
    expect(body.draftCustomer.name).toBe("Draft target");
    // Coords should carry over so the new draft is geo-tagged like the prospect.
    expect(body.draftCustomer.siteLat).toBe(13.5);

    const visits = await prisma.visit.findMany({
      where: { tenantId: fx.tenantId },
      select: { customerId: true, prospectId: true }
    });
    expect(visits[0]!.customerId).toBe(body.draftCustomer.id);
    expect(visits[0]!.prospectId).toBeNull();
  });

  it("blocks archive when there is a CHECKED_IN visit on the prospect", async () => {
    const fx = await setup();
    const prospect = await prisma.prospect.create({
      data: {
        tenantId: fx.tenantId,
        status: ProspectStatus.UNIDENTIFIED,
        displayName: "Active visit site",
        createdById: fx.repId
      }
    });
    await prisma.visit.create({
      data: {
        tenantId: fx.tenantId,
        repId: fx.repId,
        prospectId: prospect.id,
        visitNo: `V-${Date.now()}-3`,
        visitType: VisitType.UNPLANNED,
        status: VisitStatus.CHECKED_IN,
        plannedAt: new Date(),
        checkInAt: new Date()
      }
    });

    const res = await app.inject({
      method: "POST",
      url: `/api/v1/prospects/${prospect.id}/archive`,
      headers: fx.repAuth
    });
    expect(res.statusCode).toBe(409);
  });

  it("rejects a visit payload that sets both customerId and prospectId", async () => {
    const fx = await setup();
    const customer = await prisma.customer.create({
      data: { tenantId: fx.tenantId, ownerId: fx.repId, customerCode: `C-${Date.now()}`, name: "C" }
    });
    const prospect = await prisma.prospect.create({
      data: { tenantId: fx.tenantId, status: ProspectStatus.UNIDENTIFIED, createdById: fx.repId }
    });
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/visits/unplanned",
      headers: fx.repAuth,
      payload: { customerId: customer.id, prospectId: prospect.id }
    });
    expect(res.statusCode).toBe(400);
  });
});
