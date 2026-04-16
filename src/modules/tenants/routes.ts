import { UserRole } from "@prisma/client";
import type { FastifyPluginAsync } from "fastify";
import { randomBytes } from "node:crypto";
import { promises as dns } from "node:dns";
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

  app.patch("/tenants/:tenantId", async (request, reply) => {
    const params = request.params as { tenantId: string };
    requireRoleAtLeast(request, UserRole.ADMIN);
    assertTenantPathAccess(request, params.tenantId);
    const body = request.body as { name?: string; timezone?: string };
    if (!body?.name?.trim()) {
      throw app.httpErrors.badRequest("name is required.");
    }
    const data: { name: string; timezone?: string } = { name: body.name.trim() };
    if (body.timezone?.trim()) data.timezone = body.timezone.trim();
    const updated = await prisma.tenant.update({
      where: { id: params.tenantId },
      data,
      select: { id: true, name: true, slug: true, timezone: true }
    });
    return reply.send(updated);
  });

  app.get("/tenants/:tenantId/summary", async (request) => {
    const params = request.params as { tenantId: string };
    requireRoleAtLeast(request, UserRole.MANAGER);
    assertTenantPathAccess(request, params.tenantId);
    const tenant = await prisma.tenant.findUnique({
      where: { id: params.tenantId },
      select: {
        id: true,
        name: true,
        slug: true,
        timezone: true,
        createdAt: true,
        users: { select: { id: true, email: true, role: true, fullName: true, teamId: true, managerUserId: true } }
      }
    });
    if (!tenant) {
      throw app.httpErrors.notFound("Tenant not found.");
    }
    return tenant;
  });

  // Custom domain management — ADMIN only
  app.get("/tenants/:tenantId/custom-domain", async (request, reply) => {
    const { tenantId } = request.params as { tenantId: string };
    requireRoleAtLeast(request, UserRole.ADMIN);
    assertTenantPathAccess(request, tenantId);
    const record = await prisma.tenantCustomDomain.findUnique({ where: { tenantId } });
    if (!record) {
      return reply.code(204).send();
    }
    return reply.send({
      domain: record.domain,
      status: record.status,
      verificationToken: record.verificationToken,
      verificationTxtName: `_thinkcrm-verify.${record.domain}`,
      verifiedAt: record.verifiedAt,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt
    });
  });

  app.put("/tenants/:tenantId/custom-domain", async (request, reply) => {
    const { tenantId } = request.params as { tenantId: string };
    requireRoleAtLeast(request, UserRole.ADMIN);
    assertTenantPathAccess(request, tenantId);
    const body = request.body as { domain?: string };
    const domain = body?.domain?.trim().toLowerCase();
    if (!domain) {
      throw app.httpErrors.badRequest("domain is required.");
    }
    // Basic domain format validation (no scheme, no path)
    if (!/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/.test(domain)) {
      throw app.httpErrors.badRequest("domain must be a valid hostname (e.g. crm.example.com).");
    }
    // Ensure the domain is not already claimed by another tenant
    const conflict = await prisma.tenantCustomDomain.findFirst({
      where: { domain, NOT: { tenantId } }
    });
    if (conflict) {
      throw app.httpErrors.conflict("This domain is already registered to another tenant.");
    }
    const verificationToken = `thinkcrm-verify=${randomBytes(20).toString("hex")}`;
    const record = await prisma.tenantCustomDomain.upsert({
      where: { tenantId },
      create: { tenantId, domain, verificationToken },
      update: { domain, verificationToken, status: "PENDING", verifiedAt: null }
    });
    return reply.code(200).send({
      domain: record.domain,
      status: record.status,
      verificationToken: record.verificationToken,
      verificationTxtName: `_thinkcrm-verify.${record.domain}`,
      verifiedAt: record.verifiedAt,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt
    });
  });

  app.post("/tenants/:tenantId/custom-domain/verify", async (request, reply) => {
    const { tenantId } = request.params as { tenantId: string };
    requireRoleAtLeast(request, UserRole.ADMIN);
    assertTenantPathAccess(request, tenantId);
    const record = await prisma.tenantCustomDomain.findUnique({ where: { tenantId } });
    if (!record) {
      throw app.httpErrors.notFound("No custom domain configured for this tenant.");
    }
    if (record.status === "VERIFIED") {
      return reply.send({ verified: true, status: "VERIFIED", verifiedAt: record.verifiedAt });
    }
    // DNS TXT lookup: _thinkcrm-verify.<domain>
    let verified = false;
    try {
      const txtRecords = await dns.resolveTxt(`_thinkcrm-verify.${record.domain}`);
      verified = txtRecords.flat().includes(record.verificationToken);
    } catch {
      // DNS lookup failure means record not yet present
      verified = false;
    }
    const updated = await prisma.tenantCustomDomain.update({
      where: { tenantId },
      data: {
        status: verified ? "VERIFIED" : "FAILED",
        verifiedAt: verified ? new Date() : null
      }
    });
    return reply.send({ verified, status: updated.status, verifiedAt: updated.verifiedAt });
  });

  app.delete("/tenants/:tenantId/custom-domain", async (request, reply) => {
    const { tenantId } = request.params as { tenantId: string };
    requireRoleAtLeast(request, UserRole.ADMIN);
    assertTenantPathAccess(request, tenantId);
    const existing = await prisma.tenantCustomDomain.findUnique({ where: { tenantId } });
    if (!existing) {
      throw app.httpErrors.notFound("No custom domain configured for this tenant.");
    }
    await prisma.tenantCustomDomain.delete({ where: { tenantId } });
    return reply.code(204).send();
  });
};
