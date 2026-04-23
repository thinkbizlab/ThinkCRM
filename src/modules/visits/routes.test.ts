import { UserRole, VisitStatus, VisitType } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../../build-app.js";
import { hashPassword } from "../../lib/password.js";
import { prisma } from "../../lib/prisma.js";

type VisitFixture = {
  tenantId: string;
  repId: string;
  customerId: string;
};

async function createVisitFixture(): Promise<VisitFixture> {
  const token = randomUUID().replace(/-/g, "");
  const tenantId = `tenant_${token}`;
  const repId = `rep_${token}`;
  const paymentTermId = `term_${token}`;
  const customerId = `customer_${token}`;

  await prisma.tenant.create({
    data: {
      id: tenantId,
      name: `Tenant ${token}`,
      slug: `tenant-${token}`
    }
  });

  await prisma.user.create({
    data: {
      id: repId,
      tenantId,
      email: `${token}@example.com`,
      passwordHash: "not-used-in-test",
      fullName: "Rep Test User",
      role: UserRole.REP
    }
  });

  await prisma.paymentTerm.create({
    data: {
      id: paymentTermId,
      tenantId,
      code: `NET${token.slice(0, 6)}`,
      name: "Net Test",
      dueDays: 30
    }
  });

  await prisma.customer.create({
    data: {
      id: customerId,
      tenantId,
      ownerId: repId,
      customerCode: `CUST-${token.slice(0, 8)}`,
      name: "Customer Test",
      defaultTermId: paymentTermId,
      addresses: {
        create: {
          addressLine1: "123 Test Street",
          latitude: 13.7563,
          longitude: 100.5018,
          isDefaultBilling: true,
          isDefaultShipping: true
        }
      }
    }
  });

  return { tenantId, repId, customerId };
}

async function createAuthHeader(app: Awaited<ReturnType<typeof buildApp>>, fixture: VisitFixture) {
  const token = await app.jwt.sign({
    tenantId: fixture.tenantId,
    userId: fixture.repId,
    role: UserRole.REP,
    email: "rep.test@thinkcrm.dev"
  });
  return { authorization: `Bearer ${token}` };
}

describe("visit lifecycle", () => {
  it("enforces PLANNED -> CHECKED_IN -> CHECKED_OUT transitions", async () => {
    const app = await buildApp();
    const fixture = await createVisitFixture();
    const headers = await createAuthHeader(app, fixture);

    const createRes = await app.inject({
      method: "POST",
      url: "/api/v1/visits/planned",
      headers,
      payload: {
        customerId: fixture.customerId,
        plannedAt: new Date(Date.now() + 60_000).toISOString(),
        objective: "Planned lifecycle test"
      }
    });
    expect(createRes.statusCode).toBe(201);
    expect(createRes.json().status).toBe(VisitStatus.PLANNED);

    const visitId = createRes.json().id as string;

    const checkInRes = await app.inject({
      method: "POST",
      url: `/api/v1/visits/${visitId}/checkin`,
      headers,
      payload: {
        lat: 13.7563,
        lng: 100.5018,
        selfieUrl: "r2://tenant/selfies/visit.jpg"
      }
    });
    expect(checkInRes.statusCode).toBe(200);
    expect(checkInRes.json().status).toBe(VisitStatus.CHECKED_IN);

    const checkOutRes = await app.inject({
      method: "POST",
      url: `/api/v1/visits/${visitId}/checkout`,
      headers,
      payload: {
        lat: 13.7563,
        lng: 100.5018,
        result: "Meeting completed"
      }
    });
    expect(checkOutRes.statusCode).toBe(200);
    expect(checkOutRes.json().status).toBe(VisitStatus.CHECKED_OUT);
    expect(checkOutRes.json().checkOutAt).toBeTruthy();

    const invalidCheckInRes = await app.inject({
      method: "POST",
      url: `/api/v1/visits/${visitId}/checkin`,
      headers,
      payload: {
        lat: 13.7563,
        lng: 100.5018,
        selfieUrl: "r2://tenant/selfies/retry.jpg"
      }
    });
    expect(invalidCheckInRes.statusCode).toBe(400);
    expect(invalidCheckInRes.json().message).toContain("terminal status CHECKED_OUT");

    await app.close();
  });

  it("blocks check-in when another visit is pending checkout", async () => {
    const app = await buildApp();
    const fixture = await createVisitFixture();
    const headers = await createAuthHeader(app, fixture);

    const firstVisitRes = await app.inject({
      method: "POST",
      url: "/api/v1/visits/planned",
      headers,
      payload: {
        customerId: fixture.customerId,
        plannedAt: new Date(Date.now() + 60_000).toISOString(),
        objective: "First visit"
      }
    });
    const firstVisitId = firstVisitRes.json().id as string;

    const secondVisitRes = await app.inject({
      method: "POST",
      url: "/api/v1/visits/unplanned",
      headers,
      payload: {
        customerId: fixture.customerId,
        objective: "Second visit"
      }
    });
    expect(secondVisitRes.statusCode).toBe(201);
    expect(secondVisitRes.json().visitType).toBe(VisitType.UNPLANNED);
    const secondVisitId = secondVisitRes.json().id as string;

    const firstCheckInRes = await app.inject({
      method: "POST",
      url: `/api/v1/visits/${firstVisitId}/checkin`,
      headers,
      payload: {
        lat: 13.7563,
        lng: 100.5018,
        selfieUrl: "r2://tenant/selfies/first.jpg"
      }
    });
    expect(firstCheckInRes.statusCode).toBe(200);
    expect(firstCheckInRes.json().status).toBe(VisitStatus.CHECKED_IN);

    const blockedCheckInRes = await app.inject({
      method: "POST",
      url: `/api/v1/visits/${secondVisitId}/checkin`,
      headers,
      payload: {
        lat: 13.7563,
        lng: 100.5018,
        selfieUrl: "r2://tenant/selfies/second.jpg"
      }
    });
    expect(blockedCheckInRes.statusCode).toBe(409);
    expect(blockedCheckInRes.json().message).toContain("pending checkout");

    await app.close();
  });
});

describe("sales calendar events", () => {
  it("returns combined visit/deal events with status colors", async () => {
    const app = await buildApp();
    const fixture = await createVisitFixture();
    const headers = await createAuthHeader(app, fixture);
    const now = new Date();
    const nextHour = new Date(now.getTime() + 60 * 60 * 1000);
    const twoHoursAgo = new Date(now.getTime() - 2 * 60 * 60 * 1000);
    const oneHourAgo = new Date(now.getTime() - 60 * 60 * 1000);

    const stage = await prisma.dealStage.create({
      data: {
        tenantId: fixture.tenantId,
        stageName: "Opportunity",
        stageOrder: 10
      }
    });

    const deal = await prisma.deal.create({
      data: {
        tenantId: fixture.tenantId,
        ownerId: fixture.repId,
        dealNo: `DL-${randomUUID().slice(0, 8)}`,
        dealName: "Renewal opportunity",
        customerId: fixture.customerId,
        stageId: stage.id,
        estimatedValue: 150000,
        followUpAt: oneHourAgo
      }
    });

    await prisma.visit.createMany({
      data: [
        {
          tenantId: fixture.tenantId,
          repId: fixture.repId,
          customerId: fixture.customerId,
          dealId: deal.id,
          visitType: VisitType.PLANNED,
          status: VisitStatus.CHECKED_OUT,
          plannedAt: twoHoursAgo,
          checkInAt: twoHoursAgo,
          checkOutAt: oneHourAgo
        },
        {
          tenantId: fixture.tenantId,
          repId: fixture.repId,
          customerId: fixture.customerId,
          visitType: VisitType.PLANNED,
          status: VisitStatus.CHECKED_IN,
          plannedAt: oneHourAgo,
          checkInAt: oneHourAgo
        },
        {
          tenantId: fixture.tenantId,
          repId: fixture.repId,
          customerId: fixture.customerId,
          visitType: VisitType.PLANNED,
          status: VisitStatus.PLANNED,
          plannedAt: nextHour
        }
      ]
    });

    const res = await app.inject({
      method: "GET",
      url: "/api/v1/calendar/events?view=month",
      headers
    });
    expect(res.statusCode).toBe(200);
    const payload = res.json();
    expect(payload.view).toBe("month");
    expect(payload.counts.total).toBeGreaterThanOrEqual(4);
    expect(Array.isArray(payload.events)).toBe(true);

    const visitColors = payload.events
      .filter((event: { type: string }) => event.type === "visit")
      .map((event: { color: string }) => event.color);
    expect(visitColors).toContain("green");
    expect(visitColors).toContain("yellow");
    expect(visitColors).toContain("blue");

    const overdueDeal = payload.events.find(
      (event: { type: string; entityId: string }) => event.type === "deal" && event.entityId === deal.id
    );
    expect(overdueDeal?.color).toBe("red");
    await app.close();
  });

  it("supports event type and query filters", async () => {
    const app = await buildApp();
    const fixture = await createVisitFixture();
    const headers = await createAuthHeader(app, fixture);

    const stage = await prisma.dealStage.create({
      data: {
        tenantId: fixture.tenantId,
        stageName: "Quotation",
        stageOrder: 20
      }
    });

    await prisma.deal.create({
      data: {
        tenantId: fixture.tenantId,
        ownerId: fixture.repId,
        dealNo: `DQ-${randomUUID().slice(0, 8)}`,
        dealName: "Mega upgrade",
        customerId: fixture.customerId,
        stageId: stage.id,
        estimatedValue: 20000,
        followUpAt: new Date(Date.now() + 2 * 60 * 60 * 1000)
      }
    });

    await prisma.visit.create({
      data: {
        tenantId: fixture.tenantId,
        repId: fixture.repId,
        customerId: fixture.customerId,
        visitType: VisitType.PLANNED,
        status: VisitStatus.PLANNED,
        plannedAt: new Date(Date.now() + 2 * 60 * 60 * 1000),
        objective: "Standard visit"
      }
    });

    const dealOnly = await app.inject({
      method: "GET",
      url: "/api/v1/calendar/events?eventType=deal&query=mega",
      headers
    });
    expect(dealOnly.statusCode).toBe(200);
    const payload = dealOnly.json();
    expect(payload.counts.visit).toBe(0);
    expect(payload.counts.deal).toBe(1);
    expect(payload.events[0].type).toBe("deal");

    await app.close();
  });
});

describe("sales rep todo home", () => {
  it("returns pinned check-ins and grouped todo buckets with contextual actions", async () => {
    const app = await buildApp();
    const fixture = await createVisitFixture();
    const headers = await createAuthHeader(app, fixture);
    const now = new Date();

    const stage = await prisma.dealStage.create({
      data: {
        tenantId: fixture.tenantId,
        stageName: "Opportunity",
        stageOrder: 30
      }
    });

    await prisma.deal.create({
      data: {
        tenantId: fixture.tenantId,
        ownerId: fixture.repId,
        dealNo: `TD-${randomUUID().slice(0, 8)}`,
        dealName: "Renew annual contract",
        customerId: fixture.customerId,
        stageId: stage.id,
        estimatedValue: 300000,
        followUpAt: new Date(now.getTime() + 3 * 86400000)
      }
    });

    await prisma.visit.createMany({
      data: [
        {
          tenantId: fixture.tenantId,
          repId: fixture.repId,
          customerId: fixture.customerId,
          visitType: VisitType.PLANNED,
          status: VisitStatus.CHECKED_IN,
          plannedAt: new Date(now.getTime() - 2 * 60 * 60 * 1000),
          checkInAt: new Date(now.getTime() - 60 * 60 * 1000)
        },
        {
          tenantId: fixture.tenantId,
          repId: fixture.repId,
          customerId: fixture.customerId,
          visitType: VisitType.PLANNED,
          status: VisitStatus.PLANNED,
          plannedAt: new Date(now.getTime() + 2 * 60 * 60 * 1000),
          objective: "Today visit"
        },
        {
          tenantId: fixture.tenantId,
          repId: fixture.repId,
          customerId: fixture.customerId,
          visitType: VisitType.PLANNED,
          status: VisitStatus.PLANNED,
          plannedAt: new Date(now.getTime() + 26 * 60 * 60 * 1000),
          objective: "Tomorrow visit"
        },
        {
          tenantId: fixture.tenantId,
          repId: fixture.repId,
          customerId: fixture.customerId,
          visitType: VisitType.PLANNED,
          status: VisitStatus.PLANNED,
          plannedAt: new Date(now.getTime() + 12 * 86400000),
          objective: "Next month visit"
        }
      ]
    });

    const res = await app.inject({
      method: "GET",
      url: "/api/v1/todo/events",
      headers
    });

    expect(res.statusCode).toBe(200);
    const payload = res.json();

    expect(payload.pinned.checkedInWaitingCheckout.length).toBe(1);
    expect(payload.pinned.checkedInWaitingCheckout[0].nextAction.type).toBe("CHECK_OUT");
    expect(payload.pinned.checkedInWaitingCheckout[0].nextAction.label).toBe("Check-out");
    expect(payload.pinned.checkedInWaitingCheckout[0].customerId).toBe(fixture.customerId);
    expect(payload.pinned.checkedInWaitingCheckout[0].dealId).toBeNull();

    expect(payload.buckets.today.length).toBeGreaterThanOrEqual(1);
    expect(payload.buckets.tomorrow.length).toBeGreaterThanOrEqual(1);
    expect(payload.buckets.next_week.length).toBeGreaterThanOrEqual(1);
    expect(payload.buckets.next_month.length).toBeGreaterThanOrEqual(1);

    const todayVisit = payload.buckets.today.find(
      (event: { type: string; nextAction: { type: string } }) =>
        event.type === "visit" && event.nextAction.type === "CHECK_IN"
    );
    expect(todayVisit).toBeTruthy();

    const nextWeekDeal = payload.buckets.next_week.find((event: { type: string }) => event.type === "deal");
    expect(nextWeekDeal?.nextAction.type).toBe("OPEN_DEAL");

    await app.close();
  });

  it("supports todo event filters for type, priority, bucket, and status", async () => {
    const app = await buildApp();
    const fixture = await createVisitFixture();
    const headers = await createAuthHeader(app, fixture);
    const now = new Date();

    await prisma.visit.createMany({
      data: [
        {
          tenantId: fixture.tenantId,
          repId: fixture.repId,
          customerId: fixture.customerId,
          visitType: VisitType.PLANNED,
          status: VisitStatus.CHECKED_IN,
          plannedAt: new Date(now.getTime() - 2 * 60 * 60 * 1000),
          checkInAt: new Date(now.getTime() - 60 * 60 * 1000)
        },
        {
          tenantId: fixture.tenantId,
          repId: fixture.repId,
          customerId: fixture.customerId,
          visitType: VisitType.PLANNED,
          status: VisitStatus.PLANNED,
          plannedAt: new Date(now.getTime() + 2 * 60 * 60 * 1000),
          objective: "Planned call"
        }
      ]
    });

    const pinnedOnly = await app.inject({
      method: "GET",
      url: "/api/v1/todo/events?eventType=visit&priority=high&bucket=pinned&status=CHECKED_IN",
      headers
    });

    expect(pinnedOnly.statusCode).toBe(200);
    const pinnedPayload = pinnedOnly.json();
    expect(pinnedPayload.pinned.checkedInWaitingCheckout.length).toBe(1);
    expect(pinnedPayload.buckets.today.length).toBe(0);
    expect(pinnedPayload.buckets.tomorrow.length).toBe(0);
    expect(pinnedPayload.buckets.next_week.length).toBe(0);
    expect(pinnedPayload.buckets.next_month.length).toBe(0);
    expect(pinnedPayload.pinned.checkedInWaitingCheckout[0].status).toBe("CHECKED_IN");

    await app.close();
  });
});

type SetupVisitOptions = {
  withCoordinates?: boolean;
};

describe("visit check-in/out evidence", () => {
  let app: Awaited<ReturnType<typeof buildApp>>;

  beforeAll(async () => {
    app = await buildApp();
  });

  afterAll(async () => {
    await app.close();
  });

  async function setupVisit(options: SetupVisitOptions = {}) {
    const withCoordinates = options.withCoordinates ?? true;
    const suffix = randomUUID();
    const tenant = await prisma.tenant.create({
      data: {
        name: `Tenant ${suffix}`,
        slug: `tenant-${suffix}`
      }
    });

    const rep = await prisma.user.create({
      data: {
        tenantId: tenant.id,
        email: `rep-${suffix}@example.com`,
        fullName: "Rep One",
        role: UserRole.REP,
        passwordHash: hashPassword("Password123!")
      }
    });

    const paymentTerm = await prisma.paymentTerm.create({
      data: {
        tenantId: tenant.id,
        code: `NET30-${suffix}`,
        name: "Net 30",
        dueDays: 30
      }
    });

    const customer = await prisma.customer.create({
      data: {
        tenantId: tenant.id,
        customerCode: `CUST-${suffix}`,
        name: "Acme Test",
        defaultTermId: paymentTerm.id,
        addresses: {
          create: {
            addressLine1: "123 Test Road",
            city: "Bangkok",
            latitude: withCoordinates ? 13.7563 : null,
            longitude: withCoordinates ? 100.5018 : null,
            isDefaultBilling: true,
            isDefaultShipping: true
          }
        }
      }
    });

    const visit = await prisma.visit.create({
      data: {
        tenantId: tenant.id,
        repId: rep.id,
        customerId: customer.id,
        visitType: VisitType.PLANNED,
        status: VisitStatus.PLANNED,
        plannedAt: new Date(Date.now() + 3600000),
        objective: "Demo visit"
      }
    });

    const accessToken = await app.jwt.sign({
      tenantId: tenant.id,
      userId: rep.id,
      role: rep.role,
      email: rep.email
    });

    return { accessToken, visitId: visit.id };
  }

  it("blocks check-in when current location is outside allowed site radius", async () => {
    const { accessToken, visitId } = await setupVisit();
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/visits/${visitId}/checkin`,
      headers: {
        authorization: `Bearer ${accessToken}`
      },
      payload: {
        lat: 13.7,
        lng: 100.7,
        selfieUrl: "r2://tenant/selfie.jpg"
      }
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().message).toContain("outside onsite range");
  });

  it("requires customer coordinates to perform onsite check-in validation", async () => {
    const { accessToken, visitId } = await setupVisit({ withCoordinates: false });
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/visits/${visitId}/checkin`,
      headers: {
        authorization: `Bearer ${accessToken}`
      },
      payload: {
        lat: 13.75635,
        lng: 100.50182,
        selfieUrl: "r2://tenant/selfie.jpg"
      }
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().message).toContain("Customer site coordinates are not configured");
  });

  it("rejects client-supplied checkout timestamps and stores server timestamp", async () => {
    const { accessToken, visitId } = await setupVisit();

    const checkIn = await app.inject({
      method: "POST",
      url: `/api/v1/visits/${visitId}/checkin`,
      headers: {
        authorization: `Bearer ${accessToken}`
      },
      payload: {
        lat: 13.75635,
        lng: 100.50182,
        selfieUrl: "r2://tenant/selfie.jpg"
      }
    });
    expect(checkIn.statusCode).toBe(200);

    const invalidCheckout = await app.inject({
      method: "POST",
      url: `/api/v1/visits/${visitId}/checkout`,
      headers: {
        authorization: `Bearer ${accessToken}`
      },
      payload: {
        lat: 13.75635,
        lng: 100.50182,
        result: "Completed meeting",
        checkOutAt: "1999-01-01T00:00:00.000Z"
      }
    });
    expect(invalidCheckout.statusCode).toBe(400);
    expect(invalidCheckout.json().message).toContain("Unrecognized key");

    const beforeCheckout = Date.now();
    const checkout = await app.inject({
      method: "POST",
      url: `/api/v1/visits/${visitId}/checkout`,
      headers: {
        authorization: `Bearer ${accessToken}`
      },
      payload: {
        lat: 13.75635,
        lng: 100.50182,
        result: "  Completed meeting  "
      }
    });
    const afterCheckout = Date.now();

    expect(checkout.statusCode).toBe(200);
    const payload = checkout.json();
    expect(payload.status).toBe(VisitStatus.CHECKED_OUT);
    expect(payload.result).toBe("Completed meeting");
    expect(new Date(payload.checkOutAt).getTime()).toBeGreaterThanOrEqual(beforeCheckout);
    expect(new Date(payload.checkOutAt).getTime()).toBeLessThanOrEqual(afterCheckout);
  });
});
