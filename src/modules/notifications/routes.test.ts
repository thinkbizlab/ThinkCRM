// Notifications bell tests. We seed real domain rows (deals, visits,
// prospects, etc.) and verify the aggregator returns the expected counts
// and unread flags. No mocking — the bell is supposed to mirror real
// state, so the test surface mirrors that reality too.

import "../../config.js"; // ensure DATABASE_URL loads under vitest
import {
  CustomerStatus,
  DealStatus,
  ProspectStatus,
  UserRole,
  VisitStatus,
  VisitType
} from "@prisma/client";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../../build-app.js";
import { prisma } from "../../lib/prisma.js";

type Fixture = {
  tenantId: string;
  adminId: string;
  managerId: string;
  repId: string;
  customerId: string;
  stageId: string;
  paymentTermId: string;
  adminAuth:   { authorization: string };
  managerAuth: { authorization: string };
  repAuth:     { authorization: string };
};

describe("notifications routes", () => {
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
      await prisma.quotation.deleteMany({ where: scope });
      await prisma.deal.deleteMany({ where: scope });
      await prisma.dealStage.deleteMany({ where: scope });
      await prisma.visit.deleteMany({ where: scope });
      await prisma.prospect.deleteMany({ where: scope });
      await prisma.customerDuplicateCandidate.deleteMany({ where: scope });
      await prisma.integrationSyncJob.deleteMany({ where: scope });
      await prisma.integrationSource.deleteMany({ where: scope });
      await prisma.subscription.deleteMany({ where: scope });
      await prisma.customer.deleteMany({ where: scope });
      await prisma.paymentTerm.deleteMany({ where: scope });
      await prisma.userNotificationState.deleteMany({
        where: { user: { tenantId: { in: createdTenantIds } } }
      });
      await prisma.user.deleteMany({ where: scope });
      await prisma.tenant.deleteMany({ where: { id: { in: createdTenantIds } } });
    }
    await app.close();
  });

  async function setup(): Promise<Fixture> {
    const suffix = randomUUID().replace(/-/g, "").slice(0, 12);
    const tenantId  = `tenant_${suffix}`;
    const adminId   = `adm_${suffix}`;
    const managerId = `mgr_${suffix}`;
    const repId     = `rep_${suffix}`;
    createdTenantIds.push(tenantId);

    await prisma.tenant.create({
      data: { id: tenantId, name: `T ${suffix}`, slug: `t-${suffix}`, staleProspectAlertDays: 14 }
    });
    await prisma.user.createMany({
      data: [
        { id: adminId,   tenantId, email: `adm-${suffix}@example.com`, passwordHash: "x", fullName: "Admin",   role: UserRole.ADMIN },
        { id: managerId, tenantId, email: `mgr-${suffix}@example.com`, passwordHash: "x", fullName: "Manager", role: UserRole.MANAGER },
        { id: repId,     tenantId, email: `rep-${suffix}@example.com`, passwordHash: "x", fullName: "Rep",     role: UserRole.REP, managerUserId: managerId }
      ]
    });

    // Foundation rows that several groups need.
    const paymentTerm = await prisma.paymentTerm.create({
      data: { tenantId, code: `T${suffix.slice(0, 4)}`, name: "Net 30", dueDays: 30 }
    });
    const customer = await prisma.customer.create({
      data: { tenantId, ownerId: repId, name: "Test Customer", customerCode: `C-${suffix.slice(0, 6)}`, branchCode: "00000" }
    });
    const stage = await prisma.dealStage.create({
      data: { tenantId, stageName: "Open", stageOrder: 1 }
    });

    const adminToken   = await app.jwt.sign({ tenantId, userId: adminId,   role: UserRole.ADMIN,   email: `adm-${suffix}@example.com` });
    const managerToken = await app.jwt.sign({ tenantId, userId: managerId, role: UserRole.MANAGER, email: `mgr-${suffix}@example.com` });
    const repToken     = await app.jwt.sign({ tenantId, userId: repId,     role: UserRole.REP,     email: `rep-${suffix}@example.com` });
    return {
      tenantId, adminId, managerId, repId,
      customerId: customer.id,
      stageId: stage.id,
      paymentTermId: paymentTerm.id,
      adminAuth:   { authorization: `Bearer ${adminToken}` },
      managerAuth: { authorization: `Bearer ${managerToken}` },
      repAuth:     { authorization: `Bearer ${repToken}` }
    };
  }

  // ── Smoke: empty tenant returns no groups and zero unread ────────────────
  it("returns an empty payload when nothing is pending", async () => {
    const fx = await setup();
    const res = await app.inject({ method: "GET", url: "/api/v1/me/notifications", headers: fx.repAuth });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.totalUnread).toBe(0);
    expect(body.groups).toEqual([]);
    expect(body.lastSeenAt).toBeNull();
  });

  // ── pending_checkout: per-item rendering with inline action data ─────────
  it("returns pending_checkout items for the current user only", async () => {
    const fx = await setup();
    const otherRepId = `rep-other-${fx.tenantId}`;
    await prisma.user.create({
      data: { id: otherRepId, tenantId: fx.tenantId, email: `other-${fx.tenantId}@example.com`, passwordHash: "x", fullName: "Other Rep", role: UserRole.REP }
    });
    // Two visits checked-in by me, one checked-out (excluded), one by another rep (excluded).
    await prisma.visit.createMany({
      data: [
        { tenantId: fx.tenantId, repId: fx.repId,     customerId: fx.customerId, visitNo: `V-A-${fx.tenantId}`, visitType: VisitType.PLANNED,   status: VisitStatus.CHECKED_IN,  plannedAt: new Date(), checkInAt: new Date() },
        { tenantId: fx.tenantId, repId: fx.repId,     customerId: fx.customerId, visitNo: `V-B-${fx.tenantId}`, visitType: VisitType.UNPLANNED, status: VisitStatus.CHECKED_IN,  plannedAt: new Date(), checkInAt: new Date() },
        { tenantId: fx.tenantId, repId: fx.repId,     customerId: fx.customerId, visitNo: `V-C-${fx.tenantId}`, visitType: VisitType.PLANNED,   status: VisitStatus.CHECKED_OUT, plannedAt: new Date() },
        { tenantId: fx.tenantId, repId: otherRepId,    customerId: fx.customerId, visitNo: `V-D-${fx.tenantId}`, visitType: VisitType.PLANNED,   status: VisitStatus.CHECKED_IN,  plannedAt: new Date(), checkInAt: new Date() }
      ]
    });
    const res = await app.inject({ method: "GET", url: "/api/v1/me/notifications", headers: fx.repAuth });
    const body = res.json();
    const group = body.groups.find((g: { kind: string }) => g.kind === "pending_checkout");
    expect(group).toBeDefined();
    expect(group.count).toBe(2);
    expect(group.unread).toBe(2);
    expect(group.items).toHaveLength(2);
    expect(group.items[0].customerName).toBe("Test Customer");
    expect(group.items[0].visitId).toBeTruthy();
    expect(group.href).toBeNull();
  });

  // ── overdue_follow_ups: unread only for items newer than lastSeenAt ──────
  it("counts overdue follow-ups as unread relative to lastSeenAt", async () => {
    const fx = await setup();
    const oldDeal = await prisma.deal.create({
      data: { tenantId: fx.tenantId, ownerId: fx.repId, customerId: fx.customerId, stageId: fx.stageId, dealNo: `D-OLD-${fx.tenantId}`, dealName: "Old", estimatedValue: 1, followUpAt: new Date(Date.now() - 20 * 24 * 60 * 60 * 1000), status: DealStatus.OPEN }
    });
    const newDeal = await prisma.deal.create({
      data: { tenantId: fx.tenantId, ownerId: fx.repId, customerId: fx.customerId, stageId: fx.stageId, dealNo: `D-NEW-${fx.tenantId}`, dealName: "New", estimatedValue: 1, followUpAt: new Date(Date.now() - 1 * 60 * 60 * 1000), status: DealStatus.OPEN }
    });
    // Mark seen at a moment between the two deals' followUpAt timestamps.
    await prisma.userNotificationState.upsert({
      where: { userId: fx.repId },
      create: { userId: fx.repId, notifLastSeenAt: new Date(Date.now() - 12 * 60 * 60 * 1000) },
      update: { notifLastSeenAt: new Date(Date.now() - 12 * 60 * 60 * 1000) }
    });

    const res = await app.inject({ method: "GET", url: "/api/v1/me/notifications", headers: fx.repAuth });
    const group = res.json().groups.find((g: { kind: string }) => g.kind === "overdue_follow_ups");
    expect(group.count).toBe(2);
    expect(group.unread).toBe(1); // only newDeal has followUpAt > lastSeenAt
    expect(group.href).toBe("/deals?filter=overdue-mine");
    // Quiet TS unused-var warning by referencing the seeded ids
    expect(oldDeal.id).toBeTruthy();
    expect(newDeal.id).toBeTruthy();
  });

  // ── Admin-only groups: hidden from a rep ─────────────────────────────────
  it("does not surface admin-only groups (sync_failures, dedup, billing) to reps", async () => {
    const fx = await setup();
    // Seed an admin-only signal: a duplicate candidate.
    const customer2 = await prisma.customer.create({
      data: { tenantId: fx.tenantId, ownerId: fx.repId, name: "Twin", customerCode: `C2-${fx.tenantId}`, branchCode: "00000" }
    });
    await prisma.customerDuplicateCandidate.create({
      data: { tenantId: fx.tenantId, customerAId: fx.customerId, customerBId: customer2.id, signal: "TAX_ID" }
    });
    const repRes = await app.inject({ method: "GET", url: "/api/v1/me/notifications", headers: fx.repAuth });
    expect(repRes.json().groups.find((g: { kind: string }) => g.kind === "dedup_candidates")).toBeUndefined();

    const adminRes = await app.inject({ method: "GET", url: "/api/v1/me/notifications", headers: fx.adminAuth });
    const dedup = adminRes.json().groups.find((g: { kind: string }) => g.kind === "dedup_candidates");
    expect(dedup).toBeDefined();
    expect(dedup.count).toBe(1);
  });

  // ── draft_customers: manager-tier sees them, rep does not ────────────────
  it("shows draft_customers to managers but not reps", async () => {
    const fx = await setup();
    await prisma.customer.create({
      data: { tenantId: fx.tenantId, ownerId: fx.repId, name: "Draft Co.", status: CustomerStatus.DRAFT, branchCode: "00000" }
    });
    const repRes = await app.inject({ method: "GET", url: "/api/v1/me/notifications", headers: fx.repAuth });
    expect(repRes.json().groups.find((g: { kind: string }) => g.kind === "draft_customers")).toBeUndefined();

    const mgrRes = await app.inject({ method: "GET", url: "/api/v1/me/notifications", headers: fx.managerAuth });
    expect(mgrRes.json().groups.find((g: { kind: string }) => g.kind === "draft_customers").count).toBe(1);
  });

  // ── Per-tenant isolation ─────────────────────────────────────────────────
  it("never returns rows from another tenant", async () => {
    const fxA = await setup();
    const fxB = await setup();
    // Seed a stale prospect under tenant B.
    await prisma.prospect.create({
      data: { tenantId: fxB.tenantId, status: ProspectStatus.UNIDENTIFIED, displayName: "T-B prospect", createdById: fxB.repId, createdAt: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000) }
    });
    const resA = await app.inject({ method: "GET", url: "/api/v1/me/notifications", headers: fxA.repAuth });
    expect(resA.json().groups.find((g: { kind: string }) => g.kind === "stale_prospects")).toBeUndefined();
  });

  // ── POST /me/notifications/seen ──────────────────────────────────────────
  it("marks lastSeenAt on POST /seen and zeroes the unread count next read", async () => {
    const fx = await setup();
    await prisma.deal.create({
      data: { tenantId: fx.tenantId, ownerId: fx.repId, customerId: fx.customerId, stageId: fx.stageId, dealNo: `D-S-${fx.tenantId}`, dealName: "Solo", estimatedValue: 1, followUpAt: new Date(Date.now() - 2 * 60 * 60 * 1000), status: DealStatus.OPEN }
    });
    const before = await app.inject({ method: "GET", url: "/api/v1/me/notifications", headers: fx.repAuth });
    expect(before.json().totalUnread).toBeGreaterThan(0);

    const seen = await app.inject({ method: "POST", url: "/api/v1/me/notifications/seen", headers: fx.repAuth });
    expect(seen.statusCode).toBe(200);
    expect(typeof seen.json().lastSeenAt).toBe("string");

    const after = await app.inject({ method: "GET", url: "/api/v1/me/notifications", headers: fx.repAuth });
    const body = after.json();
    expect(body.lastSeenAt).toBeTruthy();
    // The deal is still listed (count) but unread should be 0 because the
    // followUpAt is now older than lastSeenAt.
    expect(body.totalUnread).toBe(0);
    const followUps = body.groups.find((g: { kind: string }) => g.kind === "overdue_follow_ups");
    expect(followUps.count).toBe(1);
    expect(followUps.unread).toBe(0);
  });
});
