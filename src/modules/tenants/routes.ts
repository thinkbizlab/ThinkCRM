import { UserRole } from "@prisma/client";
import type { FastifyPluginAsync } from "fastify";
import { randomBytes } from "node:crypto";
import { assertTenantPathAccess, requireRoleAtLeast } from "../../lib/http.js";
import { hashPassword } from "../../lib/password.js";
import { prisma } from "../../lib/prisma.js";
import { onboardTenantSchema } from "./schemas.js";

function addDays(base: Date, days: number): Date {
  const next = new Date(base);
  next.setDate(next.getDate() + days);
  return next;
}

export const tenantRoutes: FastifyPluginAsync = async (app) => {
  app.post("/tenants/onboard", async (request, reply) => {
    const parsed = onboardTenantSchema.safeParse(request.body);
    if (!parsed.success) {
      throw app.httpErrors.badRequest(parsed.error.message);
    }

    const payload = parsed.data;
    const tempPassword = `ThinkCRM-${randomBytes(4).toString("hex")}!`;
    const exists = await prisma.tenant.findUnique({
      where: { slug: payload.companySlug }
    });
    if (exists) {
      throw app.httpErrors.conflict("Tenant slug is already used.");
    }

    const tenant = await prisma.$transaction(async (tx) => {
      const createdTenant = await tx.tenant.create({
        data: { name: payload.companyName, slug: payload.companySlug }
      });

      const admin = await tx.user.create({
        data: {
          tenantId: createdTenant.id,
          email: payload.admin.email,
          passwordHash: hashPassword(tempPassword),
          mustResetPassword: true,
          fullName: payload.admin.fullName,
          role: UserRole.ADMIN
        }
      });

      const periodStart = new Date();
      await tx.subscription.create({
        data: {
          tenantId: createdTenant.id,
          provider: "STRIPE",
          pricingModel: "FIXED_PER_USER",
          status: "ACTIVE",
          seatPriceCents: payload.billing.seatPriceCents,
          seatCount: payload.billing.initialSeatCount,
          currency: payload.billing.currency.toUpperCase(),
          paymentMethodRef: payload.billing.paymentMethodRef,
          billingCycle: "MONTHLY",
          billingPeriodStart: periodStart,
          billingPeriodEnd: addDays(periodStart, 30)
        }
      });

      await tx.tenantStorageQuota.create({
        data: {
          tenantId: createdTenant.id,
          includedBytes: BigInt(payload.billing.includedBytes),
          overagePricePerGb: payload.billing.overagePricePerGb
        }
      });

      await tx.tenantTaxConfig.create({
        data: { tenantId: createdTenant.id, vatEnabled: true, vatRatePercent: 7 }
      });

      await tx.quotationFormConfig.create({
        data: {
          tenantId: createdTenant.id,
          headerLayoutJson: [
            {
              fieldKey: "customerId",
              label: "Customer",
              isVisible: true,
              isRequired: true,
              displayOrder: 1
            },
            {
              fieldKey: "billingAddressId",
              label: "Billing Address",
              isVisible: true,
              isRequired: true,
              displayOrder: 2
            },
            {
              fieldKey: "shippingAddressId",
              label: "Shipping Address",
              isVisible: true,
              isRequired: true,
              displayOrder: 3
            },
            {
              fieldKey: "paymentTermId",
              label: "Payment Term",
              isVisible: true,
              isRequired: true,
              displayOrder: 4
            },
            {
              fieldKey: "validTo",
              label: "Valid To",
              isVisible: true,
              isRequired: true,
              displayOrder: 5
            }
          ],
          itemLayoutJson: [
            {
              fieldKey: "itemId",
              label: "Item",
              isVisible: true,
              isRequired: true,
              displayOrder: 1
            },
            {
              fieldKey: "unitPrice",
              label: "Unit Price",
              isVisible: true,
              isRequired: true,
              displayOrder: 2
            },
            {
              fieldKey: "discountPercent",
              label: "Discount %",
              isVisible: true,
              isRequired: false,
              displayOrder: 3
            },
            {
              fieldKey: "quantity",
              label: "Quantity",
              isVisible: true,
              isRequired: true,
              displayOrder: 4
            }
          ]
        }
      });

      const term = await tx.paymentTerm.create({
        data: {
          tenantId: createdTenant.id,
          code: "NET30",
          name: "Net 30",
          dueDays: 30
        }
      });

      await tx.dealStage.createMany({
        data: [
          {
            tenantId: createdTenant.id,
            stageName: "Opportunity",
            stageOrder: 1,
            isDefault: true
          },
          {
            tenantId: createdTenant.id,
            stageName: "Quotation",
            stageOrder: 2
          },
          {
            tenantId: createdTenant.id,
            stageName: "Won",
            stageOrder: 3,
            isClosedWon: true
          },
          {
            tenantId: createdTenant.id,
            stageName: "Lost",
            stageOrder: 4,
            isClosedLost: true
          }
        ]
      });

      return { createdTenant, admin, defaultPaymentTermId: term.id };
    });

    return reply.code(201).send({
      message: "Tenant onboarded successfully.",
      tenantId: tenant.createdTenant.id,
      adminUserId: tenant.admin.id,
      defaultPaymentTermId: tenant.defaultPaymentTermId,
      onboarding: {
        firstAdminEmail: payload.admin.email,
        temporaryPassword: tempPassword,
        billing: {
          pricingModel: "FIXED_PER_USER",
          seatPriceCents: payload.billing.seatPriceCents,
          seatCount: payload.billing.initialSeatCount,
          currency: payload.billing.currency.toUpperCase(),
          paymentMethodRef: payload.billing.paymentMethodRef,
          includedBytes: payload.billing.includedBytes,
          overagePricePerGb: payload.billing.overagePricePerGb
        }
      }
    });
  });

  app.get("/tenants/:tenantId/summary", async (request) => {
    const params = request.params as { tenantId: string };
    requireRoleAtLeast(request, UserRole.MANAGER);
    assertTenantPathAccess(request, params.tenantId);
    const tenant = await prisma.tenant.findUnique({
      where: { id: params.tenantId },
      include: {
        users: { select: { id: true, email: true, role: true, fullName: true } },
        subscriptions: true,
        storageQuotas: true,
        taxConfig: true,
        branding: true
      }
    });
    if (!tenant) {
      throw app.httpErrors.notFound("Tenant not found.");
    }
    return tenant;
  });
};
