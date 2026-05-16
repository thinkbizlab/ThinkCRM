/**
 * Mobile-app idempotency contract: the offline-sync queue retries POSTs with
 * a stable `clientRequestId` (uuid v4) whenever the network drops the
 * response mid-flight. Without ClientRequestLog dedupe that would double-mutate
 * the visit row — these tests guard the dedupe path.
 */

import { UserRole, VisitStatus } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { buildApp } from "../../build-app.js";
import { prisma } from "../../lib/prisma.js";

type Fixture = { tenantId: string; repId: string; customerId: string };

async function createFixture(): Promise<Fixture> {
  const token = randomUUID().replace(/-/g, "");
  const tenantId = `tenant_${token}`;
  const repId = `rep_${token}`;
  const customerId = `customer_${token}`;

  await prisma.tenant.create({
    data: { id: tenantId, name: `Tenant ${token}`, slug: `tenant-${token}` }
  });
  await prisma.user.create({
    data: {
      id: repId, tenantId,
      email: `${token}@example.com`,
      passwordHash: "not-used",
      fullName: "Idempotency Test Rep",
      role: UserRole.REP
    }
  });
  await prisma.customer.create({
    data: {
      id: customerId, tenantId, ownerId: repId,
      customerCode: `CUST-${token.slice(0, 8)}`,
      name: "Customer Idempotency Test"
    }
  });
  return { tenantId, repId, customerId };
}

async function authHeader(app: Awaited<ReturnType<typeof buildApp>>, f: Fixture) {
  const token = await app.jwt.sign({
    tenantId: f.tenantId, userId: f.repId,
    role: UserRole.REP, email: "rep@idempotency.test"
  });
  return { authorization: `Bearer ${token}` };
}

async function createPlannedVisit(fixture: Fixture): Promise<string> {
  const v = await prisma.visit.create({
    data: {
      tenantId: fixture.tenantId,
      repId: fixture.repId,
      customerId: fixture.customerId,
      plannedAt: new Date(Date.now() + 60_000),
      status: VisitStatus.PLANNED,
      objective: "Idempotency test visit",
      visitType: "PLANNED"
    }
  });
  return v.id;
}

describe("check-in / check-out idempotency", () => {
  it("returns the same response when the same clientRequestId is replayed", async () => {
    const app = await buildApp();
    const fixture = await createFixture();
    const headers = await authHeader(app, fixture);
    const visitId = await createPlannedVisit(fixture);
    const clientRequestId = randomUUID();

    const first = await app.inject({
      method: "POST",
      url: `/api/v1/visits/${visitId}/checkin`,
      headers,
      payload: {
        lat: 13.7563, lng: 100.5018,
        selfieUrl: "r2://tenant/selfies/test.jpg",
        clientRequestId
      }
    });
    expect(first.statusCode).toBe(200);
    expect(first.json().visit.status).toBe(VisitStatus.CHECKED_IN);

    // Replay with the same clientRequestId — without dedupe this would 400
    // because the visit is now CHECKED_IN, not PLANNED. With dedupe the
    // server returns the cached response from the first call.
    const replay = await app.inject({
      method: "POST",
      url: `/api/v1/visits/${visitId}/checkin`,
      headers,
      payload: {
        lat: 13.7563, lng: 100.5018,
        selfieUrl: "r2://tenant/selfies/test.jpg",
        clientRequestId
      }
    });
    expect(replay.statusCode).toBe(200);
    expect(replay.json().visit.id).toBe(visitId);
    expect(replay.json().visit.status).toBe(VisitStatus.CHECKED_IN);
    // The replay must return the body of the original — the notifWarnings
    // shape and the visit object — even though the underlying mutation
    // didn't run again.

    // And the row is logged.
    const log = await prisma.clientRequestLog.findUnique({
      where: { tenantId_clientRequestId: { tenantId: fixture.tenantId, clientRequestId } }
    });
    expect(log).not.toBeNull();
    expect(log?.route).toBe("POST /visits/:id/checkin");

    await app.close();
  });

  it("treats requests without clientRequestId exactly as before", async () => {
    const app = await buildApp();
    const fixture = await createFixture();
    const headers = await authHeader(app, fixture);
    const visitId = await createPlannedVisit(fixture);

    const ok = await app.inject({
      method: "POST",
      url: `/api/v1/visits/${visitId}/checkin`,
      headers,
      payload: {
        lat: 13.7563, lng: 100.5018,
        selfieUrl: "r2://tenant/selfies/no-id.jpg"
      }
    });
    expect(ok.statusCode).toBe(200);
    // No row in the log for requests that didn't send an id.
    const count = await prisma.clientRequestLog.count({
      where: { tenantId: fixture.tenantId }
    });
    expect(count).toBe(0);

    await app.close();
  });

  it("different clientRequestIds for the same visit are independent", async () => {
    const app = await buildApp();
    const fixture = await createFixture();
    const headers = await authHeader(app, fixture);
    const visitId = await createPlannedVisit(fixture);

    const idA = randomUUID();
    const first = await app.inject({
      method: "POST",
      url: `/api/v1/visits/${visitId}/checkin`,
      headers,
      payload: {
        lat: 13.7563, lng: 100.5018,
        selfieUrl: "r2://tenant/selfies/a.jpg",
        clientRequestId: idA
      }
    });
    expect(first.statusCode).toBe(200);

    // Different clientRequestId on the same visit must NOT be deduped — it
    // must hit the normal state-machine validation and fail because the
    // visit is now CHECKED_IN.
    const idB = randomUUID();
    const second = await app.inject({
      method: "POST",
      url: `/api/v1/visits/${visitId}/checkin`,
      headers,
      payload: {
        lat: 13.7563, lng: 100.5018,
        selfieUrl: "r2://tenant/selfies/b.jpg",
        clientRequestId: idB
      }
    });
    expect(second.statusCode).toBe(400);

    await app.close();
  });
});
