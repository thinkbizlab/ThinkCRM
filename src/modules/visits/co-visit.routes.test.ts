import { UserRole, VisitStatus } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../../build-app.js";
import { prisma } from "../../lib/prisma.js";

// Co-Visit fixture: builds a tenant with one rep, one supervisor (manager of
// rep), one peer rep (NOT in supervisor's subtree), one assistant manager
// who shares a team with the rep, and one team-mate AM in a different team.
// Creates a Visit owned by the rep, plus three competency templates.
type CoVisitFixture = {
  tenantId: string;
  repId: string;
  supervisorId: string;          // SUPERVISOR, manager of rep
  peerRepId: string;             // REP in same tenant, no relation to supervisor
  amSameTeamId: string;          // ASSISTANT_MANAGER, same teamId as rep
  amOtherTeamId: string;         // ASSISTANT_MANAGER, different team
  adminId: string;
  visitId: string;
  competencyIds: string[];
  teamId: string;
};

async function createCoVisitFixture(): Promise<CoVisitFixture> {
  const t = randomUUID().replace(/-/g, "").slice(0, 20);
  const tenantId = `t_${t}`;
  const teamId = `team_${t}`;
  const otherTeamId = `oteam_${t}`;
  const repId = `rep_${t}`;
  const supervisorId = `sup_${t}`;
  const peerRepId = `peer_${t}`;
  const amSameTeamId = `am1_${t}`;
  const amOtherTeamId = `am2_${t}`;
  const adminId = `adm_${t}`;
  const customerId = `cust_${t}`;
  const visitId = `vis_${t}`;

  await prisma.tenant.create({ data: { id: tenantId, name: `T ${t}`, slug: `t-${t}` } });
  await prisma.team.createMany({
    data: [
      { id: teamId, tenantId, teamName: "Team A" },
      { id: otherTeamId, tenantId, teamName: "Team B" }
    ]
  });
  await prisma.user.createMany({
    data: [
      { id: supervisorId, tenantId, email: `sup-${t}@e.com`, fullName: "Sup", role: UserRole.SUPERVISOR },
      { id: repId, tenantId, email: `rep-${t}@e.com`, fullName: "Rep", role: UserRole.REP, managerUserId: supervisorId, teamId },
      { id: peerRepId, tenantId, email: `peer-${t}@e.com`, fullName: "Peer", role: UserRole.REP, teamId: otherTeamId },
      { id: amSameTeamId, tenantId, email: `am1-${t}@e.com`, fullName: "AM same", role: UserRole.ASSISTANT_MANAGER, teamId },
      { id: amOtherTeamId, tenantId, email: `am2-${t}@e.com`, fullName: "AM other", role: UserRole.ASSISTANT_MANAGER, teamId: otherTeamId },
      { id: adminId, tenantId, email: `adm-${t}@e.com`, fullName: "Admin", role: UserRole.ADMIN }
    ]
  });
  await prisma.customer.create({
    data: { id: customerId, tenantId, ownerId: repId, customerCode: `C-${t.slice(0, 6)}`, name: "Cust" }
  });
  await prisma.visit.create({
    data: {
      id: visitId,
      tenantId,
      repId,
      customerId,
      visitNo: `V-${t.slice(0, 6)}`,
      visitType: "PLANNED",
      status: VisitStatus.PLANNED,
      plannedAt: new Date(Date.now() + 3600_000)
    }
  });
  const competencies = await Promise.all(
    ["rapport", "product", "closing"].map((code, i) =>
      prisma.competencyTemplate.create({
        data: { tenantId, code: `${code}-${t}`, name: code, sortOrder: i }
      })
    )
  );

  return {
    tenantId, repId, supervisorId, peerRepId,
    amSameTeamId, amOtherTeamId, adminId,
    visitId, teamId,
    competencyIds: competencies.map((c) => c.id)
  };
}

async function authHeader(
  app: Awaited<ReturnType<typeof buildApp>>,
  tenantId: string,
  userId: string,
  role: UserRole
) {
  const token = await app.jwt.sign({ tenantId, userId, role, email: `${userId}@t` });
  return { authorization: `Bearer ${token}` };
}

describe("co-visit eligibility", () => {
  it("supervisor in subtree can join, unrelated peer cannot, rep cannot self-join", async () => {
    const app = await buildApp();
    const f = await createCoVisitFixture();

    // SUPERVISOR (manager of rep) — allowed
    const supHeaders = await authHeader(app, f.tenantId, f.supervisorId, UserRole.SUPERVISOR);
    const okRes = await app.inject({
      method: "POST",
      url: `/api/v1/visits/${f.visitId}/co-visitors`,
      headers: supHeaders
    });
    expect(okRes.statusCode).toBe(201);

    // Peer rep — REP role, never allowed
    const peerHeaders = await authHeader(app, f.tenantId, f.peerRepId, UserRole.REP);
    const denyRes = await app.inject({
      method: "POST",
      url: `/api/v1/visits/${f.visitId}/co-visitors`,
      headers: peerHeaders
    });
    expect(denyRes.statusCode).toBe(403);

    // Rep cannot co-visit own visit
    const repHeaders = await authHeader(app, f.tenantId, f.repId, UserRole.REP);
    const selfRes = await app.inject({
      method: "POST",
      url: `/api/v1/visits/${f.visitId}/co-visitors`,
      headers: repHeaders
    });
    // REP role -> 403 from canCoVisitRep before reaching the self-check
    expect(selfRes.statusCode).toBe(403);

    await app.close();
  });

  it("AM with same teamId can join; AM with different teamId cannot", async () => {
    const app = await buildApp();
    const f = await createCoVisitFixture();

    const sameHeaders = await authHeader(app, f.tenantId, f.amSameTeamId, UserRole.ASSISTANT_MANAGER);
    const sameRes = await app.inject({
      method: "POST",
      url: `/api/v1/visits/${f.visitId}/co-visitors`,
      headers: sameHeaders
    });
    expect(sameRes.statusCode).toBe(201);

    const otherHeaders = await authHeader(app, f.tenantId, f.amOtherTeamId, UserRole.ASSISTANT_MANAGER);
    const otherRes = await app.inject({
      method: "POST",
      url: `/api/v1/visits/${f.visitId}/co-visitors`,
      headers: otherHeaders
    });
    expect(otherRes.statusCode).toBe(403);

    await app.close();
  });
});

describe("co-visit multi-joiner", () => {
  it("two supervisors can join the same visit and each writes their own eval", async () => {
    const app = await buildApp();
    const f = await createCoVisitFixture();

    // Supervisor joins
    const supHeaders = await authHeader(app, f.tenantId, f.supervisorId, UserRole.SUPERVISOR);
    await app.inject({ method: "POST", url: `/api/v1/visits/${f.visitId}/co-visitors`, headers: supHeaders });

    // AM same-team joins
    const amHeaders = await authHeader(app, f.tenantId, f.amSameTeamId, UserRole.ASSISTANT_MANAGER);
    await app.inject({ method: "POST", url: `/api/v1/visits/${f.visitId}/co-visitors`, headers: amHeaders });

    // Both check in
    for (const headers of [supHeaders, amHeaders]) {
      const r = await app.inject({
        method: "POST",
        url: `/api/v1/visits/${f.visitId}/co-visitors/me/checkin`,
        headers,
        payload: { lat: 13.75, lng: 100.5, selfieUrl: "r2://test/selfie.jpg" }
      });
      expect(r.statusCode).toBe(200);
    }

    // Each writes a different score
    await app.inject({
      method: "PATCH",
      url: `/api/v1/visits/${f.visitId}/co-visitors/me/evaluation`,
      headers: supHeaders,
      payload: { score: 5, notes: "Great" }
    });
    await app.inject({
      method: "PATCH",
      url: `/api/v1/visits/${f.visitId}/co-visitors/me/evaluation`,
      headers: amHeaders,
      payload: { score: 3, notes: "Mid" }
    });

    const rows = await prisma.visitCoVisitor.findMany({
      where: { visitId: f.visitId },
      orderBy: { coVisitorUserId: "asc" }
    });
    expect(rows.length).toBe(2);
    const scores = rows.map((r) => r.evalScore).sort();
    expect(scores).toEqual([3, 5]);

    await app.close();
  });

  it("rejects duplicate join from the same supervisor", async () => {
    const app = await buildApp();
    const f = await createCoVisitFixture();
    const supHeaders = await authHeader(app, f.tenantId, f.supervisorId, UserRole.SUPERVISOR);

    const first = await app.inject({ method: "POST", url: `/api/v1/visits/${f.visitId}/co-visitors`, headers: supHeaders });
    expect(first.statusCode).toBe(201);
    const dup = await app.inject({ method: "POST", url: `/api/v1/visits/${f.visitId}/co-visitors`, headers: supHeaders });
    expect(dup.statusCode).toBe(409);

    await app.close();
  });
});

describe("co-visit visibility (rep masking)", () => {
  it("hides unreleased co-visitors from rep, then exposes released ones with limited fields", async () => {
    const app = await buildApp();
    const f = await createCoVisitFixture();

    const supHeaders = await authHeader(app, f.tenantId, f.supervisorId, UserRole.SUPERVISOR);
    const repHeaders = await authHeader(app, f.tenantId, f.repId, UserRole.REP);

    // Supervisor joins, checks in, checks out, evaluates — but does NOT release.
    await app.inject({ method: "POST", url: `/api/v1/visits/${f.visitId}/co-visitors`, headers: supHeaders });
    await app.inject({
      method: "POST",
      url: `/api/v1/visits/${f.visitId}/co-visitors/me/checkin`,
      headers: supHeaders,
      payload: { lat: 13.75, lng: 100.5, selfieUrl: "r2://test/secret-selfie.jpg" }
    });
    await app.inject({
      method: "POST",
      url: `/api/v1/visits/${f.visitId}/co-visitors/me/checkout`,
      headers: supHeaders,
      payload: { lat: 13.75, lng: 100.5 }
    });
    await app.inject({
      method: "PATCH",
      url: `/api/v1/visits/${f.visitId}/co-visitors/me/evaluation`,
      headers: supHeaders,
      payload: { score: 4, notes: "Confidential coaching note" }
    });

    // Rep view: coVisitors must be empty (unreleased = invisible)
    const repView = await app.inject({
      method: "GET",
      url: `/api/v1/visits/${f.visitId}`,
      headers: repHeaders
    });
    expect(repView.statusCode).toBe(200);
    expect(repView.json().coVisitors).toEqual([]);

    // Supervisor view: their own row is fully visible
    const supView = await app.inject({
      method: "GET",
      url: `/api/v1/visits/${f.visitId}`,
      headers: supHeaders
    });
    const supCoVisitors = supView.json().coVisitors;
    expect(supCoVisitors.length).toBe(1);
    expect(supCoVisitors[0].evalScore).toBe(4);
    expect(supCoVisitors[0].evalNotes).toBe("Confidential coaching note");
    expect(supCoVisitors[0].checkInSelfie).toBe("r2://test/secret-selfie.jpg");

    // Release
    const releaseRes = await app.inject({
      method: "POST",
      url: `/api/v1/visits/${f.visitId}/co-visitors/me/release`,
      headers: supHeaders
    });
    expect(releaseRes.statusCode).toBe(200);

    // Rep view after release: row visible but selfie + checkInAt stripped
    const repAfter = await app.inject({
      method: "GET",
      url: `/api/v1/visits/${f.visitId}`,
      headers: repHeaders
    });
    const repCoVisitors = repAfter.json().coVisitors;
    expect(repCoVisitors.length).toBe(1);
    expect(repCoVisitors[0].evalScore).toBe(4);
    expect(repCoVisitors[0].evalNotes).toBe("Confidential coaching note");
    expect(repCoVisitors[0].evalReleasedAt).toBeTruthy();
    // Sensitive fields stripped even after release
    expect(repCoVisitors[0].checkInSelfie).toBeNull();
    expect(repCoVisitors[0].checkInAt).toBeNull();
    expect(repCoVisitors[0].checkOutAt).toBeNull();

    await app.close();
  });

  it("admin sees all coVisitor fields regardless of release", async () => {
    const app = await buildApp();
    const f = await createCoVisitFixture();
    const supHeaders = await authHeader(app, f.tenantId, f.supervisorId, UserRole.SUPERVISOR);
    const adminHeaders = await authHeader(app, f.tenantId, f.adminId, UserRole.ADMIN);

    await app.inject({ method: "POST", url: `/api/v1/visits/${f.visitId}/co-visitors`, headers: supHeaders });
    await app.inject({
      method: "POST",
      url: `/api/v1/visits/${f.visitId}/co-visitors/me/checkin`,
      headers: supHeaders,
      payload: { lat: 13.75, lng: 100.5, selfieUrl: "r2://test/admin-view.jpg" }
    });

    const adminView = await app.inject({
      method: "GET",
      url: `/api/v1/visits/${f.visitId}`,
      headers: adminHeaders
    });
    const cv = adminView.json().coVisitors;
    expect(cv.length).toBe(1);
    expect(cv[0].checkInSelfie).toBe("r2://test/admin-view.jpg");

    await app.close();
  });
});

describe("co-visit release preconditions", () => {
  it("blocks release when no eval score is set", async () => {
    const app = await buildApp();
    const f = await createCoVisitFixture();
    const supHeaders = await authHeader(app, f.tenantId, f.supervisorId, UserRole.SUPERVISOR);
    await app.inject({ method: "POST", url: `/api/v1/visits/${f.visitId}/co-visitors`, headers: supHeaders });
    const r = await app.inject({
      method: "POST",
      url: `/api/v1/visits/${f.visitId}/co-visitors/me/release`,
      headers: supHeaders
    });
    expect(r.statusCode).toBe(400);
    await app.close();
  });

  it("blocks double release", async () => {
    const app = await buildApp();
    const f = await createCoVisitFixture();
    const supHeaders = await authHeader(app, f.tenantId, f.supervisorId, UserRole.SUPERVISOR);
    await app.inject({ method: "POST", url: `/api/v1/visits/${f.visitId}/co-visitors`, headers: supHeaders });
    await app.inject({
      method: "PATCH",
      url: `/api/v1/visits/${f.visitId}/co-visitors/me/evaluation`,
      headers: supHeaders,
      payload: { score: 4 }
    });
    const first = await app.inject({
      method: "POST",
      url: `/api/v1/visits/${f.visitId}/co-visitors/me/release`,
      headers: supHeaders
    });
    expect(first.statusCode).toBe(200);
    const dup = await app.inject({
      method: "POST",
      url: `/api/v1/visits/${f.visitId}/co-visitors/me/release`,
      headers: supHeaders
    });
    expect(dup.statusCode).toBe(409);
    await app.close();
  });
});

describe("competency templates", () => {
  it("admin can CRUD templates; non-admin only reads", async () => {
    const app = await buildApp();
    const f = await createCoVisitFixture();
    const adminHeaders = await authHeader(app, f.tenantId, f.adminId, UserRole.ADMIN);
    const repHeaders = await authHeader(app, f.tenantId, f.repId, UserRole.REP);

    // Read — accessible to all
    const list = await app.inject({ method: "GET", url: "/api/v1/competency-templates", headers: repHeaders });
    expect(list.statusCode).toBe(200);
    expect(list.json().length).toBe(3);

    // Non-admin write blocked
    const denied = await app.inject({
      method: "POST",
      url: "/api/v1/competency-templates",
      headers: repHeaders,
      payload: { code: "REP-WRITE", name: "denied" }
    });
    expect(denied.statusCode).toBe(403);

    // Admin write
    const created = await app.inject({
      method: "POST",
      url: "/api/v1/competency-templates",
      headers: adminHeaders,
      payload: { code: "DISCOVERY", name: "Discovery questions" }
    });
    expect(created.statusCode).toBe(201);
    const id = created.json().id as string;

    // Soft delete via DELETE
    const del = await app.inject({
      method: "DELETE",
      url: `/api/v1/competency-templates/${id}`,
      headers: adminHeaders
    });
    expect(del.statusCode).toBe(204);

    // Default list excludes inactive
    const after = await app.inject({ method: "GET", url: "/api/v1/competency-templates", headers: repHeaders });
    expect(after.json().find((t: { id: string }) => t.id === id)).toBeUndefined();

    // includeInactive=true reveals it
    const all = await app.inject({
      method: "GET",
      url: "/api/v1/competency-templates?includeInactive=true",
      headers: repHeaders
    });
    expect(all.json().find((t: { id: string }) => t.id === id)?.isActive).toBe(false);

    await app.close();
  });
});
