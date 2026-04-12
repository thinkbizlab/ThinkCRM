import { UserRole } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../../app.js";
import { hashPassword } from "../../lib/password.js";
import { prisma } from "../../lib/prisma.js";

describe("deal kanban stage management", () => {
  const createdTenantIds: string[] = [];
  let app: Awaited<ReturnType<typeof buildApp>>;

  beforeAll(async () => {
    app = await buildApp();
  });

  afterAll(async () => {
    if (createdTenantIds.length > 0) {
      await prisma.dealProgressUpdate.deleteMany({
        where: {
          deal: {
            tenantId: {
              in: createdTenantIds
            }
          }
        }
      });
      await prisma.visit.deleteMany({
        where: {
          tenantId: {
            in: createdTenantIds
          }
        }
      });
      await prisma.deal.deleteMany({
        where: {
          tenantId: {
            in: createdTenantIds
          }
        }
      });
      await prisma.dealStage.deleteMany({
        where: {
          tenantId: {
            in: createdTenantIds
          }
        }
      });
      await prisma.customerAddress.deleteMany({
        where: {
          customer: {
            tenantId: {
              in: createdTenantIds
            }
          }
        }
      });
      await prisma.customer.deleteMany({
        where: {
          tenantId: {
            in: createdTenantIds
          }
        }
      });
      await prisma.paymentTerm.deleteMany({
        where: {
          tenantId: {
            in: createdTenantIds
          }
        }
      });
      await prisma.item.deleteMany({
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

  async function setupDealFixture() {
    const suffix = randomUUID();
    const tenant = await prisma.tenant.create({
      data: {
        name: `Deal Tenant ${suffix}`,
        slug: `deal-tenant-${suffix}`
      }
    });
    createdTenantIds.push(tenant.id);

    const [admin, rep] = await Promise.all([
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
          email: `rep-${suffix}@example.com`,
          fullName: "Rep User",
          role: UserRole.REP,
          passwordHash: hashPassword("Password123!")
        }
      })
    ]);

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
        ownerId: rep.id,
        customerCode: `CUST-${suffix}`,
        name: "Kanban Customer",
        defaultTermId: paymentTerm.id,
        addresses: {
          create: {
            addressLine1: "123 Kanban Street",
            city: "Bangkok",
            isDefaultBilling: true,
            isDefaultShipping: true
          }
        }
      }
    });

    const [opportunity, quotation, won] = await Promise.all([
      prisma.dealStage.create({
        data: {
          tenantId: tenant.id,
          stageName: "Opportunity",
          stageOrder: 1,
          isDefault: true
        }
      }),
      prisma.dealStage.create({
        data: {
          tenantId: tenant.id,
          stageName: "Quotation",
          stageOrder: 2
        }
      }),
      prisma.dealStage.create({
        data: {
          tenantId: tenant.id,
          stageName: "Won",
          stageOrder: 3,
          isClosedWon: true
        }
      })
    ]);

    const deal = await prisma.deal.create({
      data: {
        tenantId: tenant.id,
        ownerId: rep.id,
        dealNo: `DL-${suffix}`,
        dealName: "Deal Kanban Test",
        customerId: customer.id,
        stageId: opportunity.id,
        estimatedValue: 50000,
        followUpAt: new Date(Date.now() + 86400000)
      }
    });

    const [adminToken, repToken] = await Promise.all([
      app.jwt.sign({
        tenantId: tenant.id,
        userId: admin.id,
        role: admin.role,
        email: admin.email
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
      dealId: deal.id,
      customerId: customer.id,
      paymentTermId: paymentTerm.id,
      stageIds: {
        opportunity: opportunity.id,
        quotation: quotation.id,
        won: won.id
      },
      adminToken,
      repToken
    };
  }

  it("enforces tenant-configurable stage transition rules", async () => {
    const fixture = await setupDealFixture();

    const skipToWon = await app.inject({
      method: "PATCH",
      url: `/api/v1/deals/${fixture.dealId}/stage`,
      headers: {
        authorization: `Bearer ${fixture.repToken}`
      },
      payload: {
        stageId: fixture.stageIds.won
      }
    });
    expect(skipToWon.statusCode).toBe(400);
    expect(skipToWon.json().message).toContain("transition rules");

    const moveToQuotation = await app.inject({
      method: "PATCH",
      url: `/api/v1/deals/${fixture.dealId}/stage`,
      headers: {
        authorization: `Bearer ${fixture.repToken}`
      },
      payload: {
        stageId: fixture.stageIds.quotation
      }
    });
    expect(moveToQuotation.statusCode).toBe(200);

    const moveBackBlocked = await app.inject({
      method: "PATCH",
      url: `/api/v1/deals/${fixture.dealId}/stage`,
      headers: {
        authorization: `Bearer ${fixture.repToken}`
      },
      payload: {
        stageId: fixture.stageIds.opportunity
      }
    });
    expect(moveBackBlocked.statusCode).toBe(400);

    const updateRule = await app.inject({
      method: "PATCH",
      url: `/api/v1/deals/stages/${fixture.stageIds.opportunity}`,
      headers: {
        authorization: `Bearer ${fixture.adminToken}`
      },
      payload: {
        allowBackwardMove: true,
        allowedSourceStageIds: [fixture.stageIds.quotation]
      }
    });
    expect(updateRule.statusCode).toBe(200);

    const moveBackAllowed = await app.inject({
      method: "PATCH",
      url: `/api/v1/deals/${fixture.dealId}/stage`,
      headers: {
        authorization: `Bearer ${fixture.repToken}`
      },
      payload: {
        stageId: fixture.stageIds.opportunity
      }
    });
    expect(moveBackAllowed.statusCode).toBe(200);
  });

  it("supports stage creation + reordering and returns normalized order", async () => {
    const fixture = await setupDealFixture();

    const createStage = await app.inject({
      method: "POST",
      url: "/api/v1/deals/stages",
      headers: {
        authorization: `Bearer ${fixture.adminToken}`
      },
      payload: {
        stageName: "Negotiation",
        insertAt: 2,
        allowStageSkip: true
      }
    });
    expect(createStage.statusCode).toBe(201);

    const stagesRes = await app.inject({
      method: "GET",
      url: "/api/v1/deals/stages",
      headers: {
        authorization: `Bearer ${fixture.repToken}`
      }
    });
    expect(stagesRes.statusCode).toBe(200);
    const stageIds = stagesRes
      .json()
      .map((stage: { id: string }) => stage.id)
      .reverse();

    const reorder = await app.inject({
      method: "PUT",
      url: "/api/v1/deals/stages/reorder",
      headers: {
        authorization: `Bearer ${fixture.adminToken}`
      },
      payload: {
        stageIds
      }
    });
    expect(reorder.statusCode).toBe(200);
    const reordered = reorder.json();
    expect(reordered[0].id).toBe(stageIds[0]);
    expect(reordered.map((stage: { stageOrder: number }) => stage.stageOrder)).toEqual(
      reordered.map((_: unknown, index: number) => index + 1)
    );
  });

  it("stores progress updates and exposes create-visit option metadata", async () => {
    const fixture = await setupDealFixture();

    const createProgress = await app.inject({
      method: "POST",
      url: `/api/v1/deals/${fixture.dealId}/progress-updates`,
      headers: {
        authorization: `Bearer ${fixture.repToken}`
      },
      payload: {
        note: "  Qualification call completed  "
      }
    });
    expect(createProgress.statusCode).toBe(201);
    expect(createProgress.json().note).toBe("Qualification call completed");
    expect(createProgress.json().create_visit_option.allowed).toBe(true);

    const listProgress = await app.inject({
      method: "GET",
      url: `/api/v1/deals/${fixture.dealId}/progress-updates`,
      headers: {
        authorization: `Bearer ${fixture.repToken}`
      }
    });
    expect(listProgress.statusCode).toBe(200);
    const rows = listProgress.json();
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0].createdBy.email).toContain("rep-");
  });

  it("schedules follow-up from progress updates and supports optional create-visit action", async () => {
    const fixture = await setupDealFixture();
    const scheduledAt = new Date(Date.now() + 2 * 86400000).toISOString();

    const createProgress = await app.inject({
      method: "POST",
      url: `/api/v1/deals/${fixture.dealId}/progress-updates`,
      headers: {
        authorization: `Bearer ${fixture.repToken}`
      },
      payload: {
        note: "Rescheduled customer review",
        followUpAt: scheduledAt
      }
    });
    expect(createProgress.statusCode).toBe(201);
    expect(createProgress.json().follow_up_scheduled_at).toBe(scheduledAt);
    expect(createProgress.json().create_visit_option.skip_allowed).toBe(true);
    expect(createProgress.json().create_visit_option.suggested_planned_at).toBe(scheduledAt);

    const createVisit = await app.inject({
      method: "POST",
      url: createProgress.json().create_visit_option.endpoint,
      headers: {
        authorization: `Bearer ${fixture.repToken}`
      },
      payload: {}
    });
    expect(createVisit.statusCode).toBe(201);
    expect(createVisit.json().dealId).toBe(fixture.dealId);
    expect(createVisit.json().customerId).toBe(fixture.customerId);
    expect(new Date(createVisit.json().plannedAt).toISOString()).toBe(scheduledAt);
  });

  it("auto-calculates deal value from quotations and blocks manual override", async () => {
    const fixture = await setupDealFixture();
    const itemCode = `ITEM-${randomUUID()}`;
    const item = await prisma.item.create({
      data: {
        tenantId: fixture.tenantId,
        itemCode,
        name: "Bundle",
        unitPrice: 2500
      }
    });

    const quoteResponse = await app.inject({
      method: "POST",
      url: `/api/v1/deals/${fixture.dealId}/quotations`,
      headers: {
        authorization: `Bearer ${fixture.repToken}`
      },
      payload: {
        quotationNo: `Q-${randomUUID()}`,
        customerId: fixture.customerId,
        paymentTermId: fixture.paymentTermId,
        validTo: new Date(Date.now() + 14 * 86400000).toISOString(),
        items: [
          {
            itemId: item.id,
            itemCode,
            unitPrice: 2500,
            discountPercent: 10,
            quantity: 2
          }
        ]
      }
    });
    expect(quoteResponse.statusCode).toBe(201);

    const dealAfterQuote = await prisma.deal.findUniqueOrThrow({ where: { id: fixture.dealId } });
    expect(dealAfterQuote.estimatedValue).toBeCloseTo(4500, 5);

    const manualPatch = await app.inject({
      method: "PATCH",
      url: `/api/v1/deals/${fixture.dealId}`,
      headers: {
        authorization: `Bearer ${fixture.repToken}`
      },
      payload: {
        estimatedValue: 1
      }
    });
    expect(manualPatch.statusCode).toBe(400);
    expect(manualPatch.json().message).toContain("auto-calculated");
  });
});
