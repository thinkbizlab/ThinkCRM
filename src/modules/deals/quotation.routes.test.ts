import { UserRole } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../../app.js";
import { hashPassword } from "../../lib/password.js";
import { prisma } from "../../lib/prisma.js";

describe("quotation routes", () => {
  const createdTenantIds: string[] = [];
  let app: Awaited<ReturnType<typeof buildApp>>;

  beforeAll(async () => {
    app = await buildApp();
  });

  afterAll(async () => {
    if (createdTenantIds.length > 0) {
      await prisma.quotationItem.deleteMany({
        where: {
          quotation: {
            tenantId: {
              in: createdTenantIds
            }
          }
        }
      });
      await prisma.quotation.deleteMany({
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
      await prisma.item.deleteMany({
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
      await prisma.tenantTaxConfig.deleteMany({
        where: {
          tenantId: {
            in: createdTenantIds
          }
        }
      });
      await prisma.quotationFormConfig.deleteMany({
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

  async function setupFixture() {
    const suffix = randomUUID();
    const tenant = await prisma.tenant.create({
      data: {
        name: `Quote Tenant ${suffix}`,
        slug: `quote-tenant-${suffix}`
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

    const [paymentTerm, stage, taxConfig] = await Promise.all([
      prisma.paymentTerm.create({
        data: {
          tenantId: tenant.id,
          code: `NET30-${suffix}`,
          name: "Net 30",
          dueDays: 30
        }
      }),
      prisma.dealStage.create({
        data: {
          tenantId: tenant.id,
          stageName: "Opportunity",
          stageOrder: 1,
          isDefault: true
        }
      }),
      prisma.tenantTaxConfig.create({
        data: {
          tenantId: tenant.id,
          vatEnabled: true,
          vatRatePercent: 7
        }
      })
    ]);
    void taxConfig;

    const customer = await prisma.customer.create({
      data: {
        tenantId: tenant.id,
        ownerId: rep.id,
        customerCode: `CUST-${suffix}`,
        name: "Quotation Customer",
        defaultTermId: paymentTerm.id,
        addresses: {
          create: [
            {
              addressLine1: "123 Billing Street",
              city: "Bangkok",
              isDefaultBilling: true,
              isDefaultShipping: false
            },
            {
              addressLine1: "789 Shipping Street",
              city: "Bangkok",
              isDefaultBilling: false,
              isDefaultShipping: true
            }
          ]
        }
      },
      include: { addresses: true }
    });

    const [itemA, itemB] = await Promise.all([
      prisma.item.create({
        data: {
          tenantId: tenant.id,
          itemCode: `ITEM-A-${suffix}`,
          name: "Item A",
          unitPrice: 100
        }
      }),
      prisma.item.create({
        data: {
          tenantId: tenant.id,
          itemCode: `ITEM-B-${suffix}`,
          name: "Item B",
          unitPrice: 250
        }
      })
    ]);

    const deal = await prisma.deal.create({
      data: {
        tenantId: tenant.id,
        ownerId: rep.id,
        dealNo: `DL-${suffix}`,
        dealName: "Deal for quotations",
        customerId: customer.id,
        stageId: stage.id,
        estimatedValue: 1000,
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
      itemAId: itemA.id,
      itemBId: itemB.id,
      billingAddressId: customer.addresses[0]?.id,
      shippingAddressId: customer.addresses[1]?.id,
      adminToken,
      repToken
    };
  }

  it("creates multiple quotations per deal and applies tax math", async () => {
    const fixture = await setupFixture();

    const firstQuote = await app.inject({
      method: "POST",
      url: `/api/v1/deals/${fixture.dealId}/quotations`,
      headers: {
        authorization: `Bearer ${fixture.repToken}`
      },
      payload: {
        quotationNo: "QT-001",
        customerId: fixture.customerId,
        paymentTermId: fixture.paymentTermId,
        billingAddressId: fixture.billingAddressId,
        shippingAddressId: fixture.shippingAddressId,
        validTo: new Date(Date.now() + 5 * 86400000).toISOString(),
        items: [
          {
            itemId: fixture.itemAId,
            unitPrice: 100,
            discountPercent: 10,
            quantity: 2
          }
        ]
      }
    });
    expect(firstQuote.statusCode).toBe(201);
    expect(firstQuote.json().subtotal).toBeCloseTo(180);
    expect(firstQuote.json().vatAmount).toBeCloseTo(12.6);
    expect(firstQuote.json().grandTotal).toBeCloseTo(192.6);

    const secondQuote = await app.inject({
      method: "POST",
      url: `/api/v1/deals/${fixture.dealId}/quotations`,
      headers: {
        authorization: `Bearer ${fixture.repToken}`
      },
      payload: {
        quotationNo: "QT-002",
        customerId: fixture.customerId,
        paymentTermId: fixture.paymentTermId,
        validTo: new Date(Date.now() + 10 * 86400000).toISOString(),
        items: [
          {
            itemId: fixture.itemBId,
            unitPrice: 250,
            discountPercent: 20,
            quantity: 3
          }
        ]
      }
    });
    expect(secondQuote.statusCode).toBe(201);
    expect(secondQuote.json().grandTotal).toBeCloseTo(642);

    const listQuotes = await app.inject({
      method: "GET",
      url: `/api/v1/deals/${fixture.dealId}/quotations`,
      headers: {
        authorization: `Bearer ${fixture.repToken}`
      }
    });
    expect(listQuotes.statusCode).toBe(200);
    expect(listQuotes.json().length).toBe(2);
  });

  it("updates quotation items and manages tenant quotation form layout", async () => {
    const fixture = await setupFixture();

    const createQuote = await app.inject({
      method: "POST",
      url: `/api/v1/deals/${fixture.dealId}/quotations`,
      headers: {
        authorization: `Bearer ${fixture.repToken}`
      },
      payload: {
        quotationNo: "QT-003",
        customerId: fixture.customerId,
        paymentTermId: fixture.paymentTermId,
        validTo: new Date(Date.now() + 5 * 86400000).toISOString(),
        items: [
          {
            itemId: fixture.itemAId,
            unitPrice: 100,
            discountPercent: 0,
            quantity: 1
          }
        ]
      }
    });
    expect(createQuote.statusCode).toBe(201);
    const quotationId = createQuote.json().id as string;

    const upsertItems = await app.inject({
      method: "POST",
      url: `/api/v1/quotations/${quotationId}/items`,
      headers: {
        authorization: `Bearer ${fixture.repToken}`
      },
      payload: {
        items: [
          {
            itemId: fixture.itemBId,
            unitPrice: 250,
            discountPercent: 20,
            quantity: 2
          }
        ]
      }
    });
    expect(upsertItems.statusCode).toBe(200);
    expect(upsertItems.json().subtotal).toBeCloseTo(400);
    expect(upsertItems.json().grandTotal).toBeCloseTo(428);
    expect(upsertItems.json().items.length).toBe(1);

    const getConfigDefault = await app.inject({
      method: "GET",
      url: `/api/v1/tenants/${fixture.tenantId}/quotation-form-config`,
      headers: {
        authorization: `Bearer ${fixture.repToken}`
      }
    });
    expect(getConfigDefault.statusCode).toBe(403);

    const getConfigAsAdmin = await app.inject({
      method: "GET",
      url: `/api/v1/tenants/${fixture.tenantId}/quotation-form-config`,
      headers: {
        authorization: `Bearer ${fixture.adminToken}`
      }
    });
    expect(getConfigAsAdmin.statusCode).toBe(200);
    expect(getConfigAsAdmin.json().header.length).toBeGreaterThan(0);

    const saveConfig = await app.inject({
      method: "PUT",
      url: `/api/v1/tenants/${fixture.tenantId}/quotation-form-config`,
      headers: {
        authorization: `Bearer ${fixture.adminToken}`
      },
      payload: {
        header: [
          {
            fieldKey: "customerId",
            label: "Customer",
            isVisible: true,
            isRequired: true,
            displayOrder: 1
          },
          {
            fieldKey: "validTo",
            label: "Valid To",
            isVisible: true,
            isRequired: true,
            displayOrder: 2
          }
        ],
        item: [
          {
            fieldKey: "itemId",
            label: "Item",
            isVisible: true,
            isRequired: true,
            displayOrder: 1
          },
          {
            fieldKey: "quantity",
            label: "Quantity",
            isVisible: true,
            isRequired: true,
            displayOrder: 2
          }
        ]
      }
    });
    expect(saveConfig.statusCode).toBe(200);
    expect(saveConfig.json().header[0].fieldKey).toBe("customerId");
    expect(saveConfig.json().item[1].fieldKey).toBe("quantity");
  });
});
