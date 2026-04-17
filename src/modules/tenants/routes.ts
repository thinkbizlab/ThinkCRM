import { UserRole } from "@prisma/client";
import type { FastifyPluginAsync } from "fastify";
import { randomBytes } from "node:crypto";
import { promises as dns } from "node:dns";
import { z } from "zod";
import { assertTenantPathAccess, requireRoleAtLeast } from "../../lib/http.js";
import { hashPassword } from "../../lib/password.js";
import { prisma } from "../../lib/prisma.js";
import { addVercelDomain, removeVercelDomain } from "../../lib/vercel-domains.js";
import { onboardTenantSchema } from "./schemas.js";

const signupSchema = z.object({
  companyName:   z.string().min(2).max(120).trim(),
  slug:          z.string().min(2).max(60).regex(/^[a-z0-9-]+$/, "Slug must be lowercase letters, numbers, and hyphens"),
  adminFullName: z.string().min(2).max(120).trim(),
  adminEmail:    z.string().email().transform(s => s.toLowerCase()),
  adminPassword: z.string().min(12, "Password must be at least 12 characters"),
});

function addDays(base: Date, days: number): Date {
  const next = new Date(base);
  next.setDate(next.getDate() + days);
  return next;
}

export const tenantRoutes: FastifyPluginAsync = async (app) => {
  // ── S3: Public self-service signup ────────────────────────────────────────

  /** Check whether a workspace slug is available (public, no auth). */
  app.get("/tenants/check-slug", async (request, reply) => {
    const { slug } = request.query as { slug?: string };
    if (!slug || !/^[a-z0-9-]{2,60}$/.test(slug)) {
      return reply.send({ available: false, reason: "invalid" });
    }
    const existing = await prisma.tenant.findUnique({ where: { slug }, select: { id: true } });
    return reply.send({ available: !existing });
  });

  /** Self-service signup — creates a tenant + admin user, returns a JWT for immediate login. */
  app.post("/tenants/signup", async (request, reply) => {
    const parsed = signupSchema.safeParse(request.body);
    if (!parsed.success) {
      throw app.httpErrors.badRequest(parsed.error.issues[0]?.message ?? "Invalid input");
    }
    const { companyName, slug, adminFullName, adminEmail, adminPassword } = parsed.data;

    const existing = await prisma.tenant.findUnique({ where: { slug }, select: { id: true } });
    if (existing) throw app.httpErrors.conflict("That workspace URL is already taken. Please choose another.");

    const periodStart = new Date();
    const { tenant, admin } = await prisma.$transaction(async (tx) => {
      const tenant = await tx.tenant.create({
        data: { name: companyName, slug }
      });

      const admin = await tx.user.create({
        data: {
          tenantId: tenant.id,
          email: adminEmail,
          passwordHash: hashPassword(adminPassword),
          fullName: adminFullName,
          role: UserRole.ADMIN
        }
      });

      // 14-day trial — no payment details required yet.
      const trialEndsAt = addDays(periodStart, 14);
      await tx.subscription.create({
        data: {
          tenantId: tenant.id,
          provider: "STRIPE",
          pricingModel: "FIXED_PER_USER",
          status: "TRIALING",
          seatPriceCents: 0,
          seatCount: 5,
          currency: "THB",
          billingCycle: "MONTHLY",
          billingPeriodStart: periodStart,
          trialEndsAt,
          billingPeriodEnd: addDays(periodStart, 30)
        }
      });

      await tx.tenantStorageQuota.create({
        data: { tenantId: tenant.id, includedBytes: BigInt(1_073_741_824), overagePricePerGb: 0 }
      });

      await tx.tenantTaxConfig.create({
        data: { tenantId: tenant.id, vatEnabled: true, vatRatePercent: 7 }
      });

      await tx.quotationFormConfig.create({
        data: {
          tenantId: tenant.id,
          headerLayoutJson: [
            { fieldKey: "customerId",        label: "Customer",        isVisible: true, isRequired: true,  displayOrder: 1 },
            { fieldKey: "billingAddressId",  label: "Billing Address", isVisible: true, isRequired: true,  displayOrder: 2 },
            { fieldKey: "shippingAddressId", label: "Shipping Address",isVisible: true, isRequired: true,  displayOrder: 3 },
            { fieldKey: "paymentTermId",     label: "Payment Term",    isVisible: true, isRequired: true,  displayOrder: 4 },
            { fieldKey: "validTo",           label: "Valid To",        isVisible: true, isRequired: true,  displayOrder: 5 }
          ],
          itemLayoutJson: [
            { fieldKey: "itemId",          label: "Item",       isVisible: true, isRequired: true,  displayOrder: 1 },
            { fieldKey: "unitPrice",       label: "Unit Price", isVisible: true, isRequired: true,  displayOrder: 2 },
            { fieldKey: "discountPercent", label: "Discount %", isVisible: true, isRequired: false, displayOrder: 3 },
            { fieldKey: "quantity",        label: "Quantity",   isVisible: true, isRequired: true,  displayOrder: 4 }
          ]
        }
      });

      await tx.paymentTerm.create({
        data: { tenantId: tenant.id, code: "NET30", name: "Net 30", dueDays: 30 }
      });

      await tx.dealStage.createMany({
        data: [
          { tenantId: tenant.id, stageName: "Opportunity", stageOrder: 1, isDefault: true },
          { tenantId: tenant.id, stageName: "Quotation",   stageOrder: 2 },
          { tenantId: tenant.id, stageName: "Won",         stageOrder: 3, isClosedWon: true },
          { tenantId: tenant.id, stageName: "Lost",        stageOrder: 4, isClosedLost: true }
        ]
      });

      return { tenant, admin };
    });

    // Sign a JWT so the new admin is immediately logged in.
    const token = app.jwt.sign(
      { tenantId: tenant.id, userId: admin.id, role: admin.role, email: admin.email },
      { expiresIn: "7d" }
    );

    return reply.code(201).send({ token, tenantSlug: tenant.slug, userId: admin.id });
  });

  // ── Admin-facing onboard endpoint (internal / super-admin use) ────────────
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

    // Auto-provision on Vercel when verification succeeds
    let vercelDomain: { added: boolean; error?: string } | undefined;
    if (verified) {
      vercelDomain = await addVercelDomain(record.domain);
    }

    return reply.send({ verified, status: updated.status, verifiedAt: updated.verifiedAt, vercelDomain });
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

    // Remove from Vercel when domain is deleted
    await removeVercelDomain(existing.domain);

    return reply.code(204).send();
  });

  // S1: Tenant deactivation — blocks all authenticated requests for the tenant immediately.
  // Only the tenant's own ADMIN can deactivate their workspace.
  app.patch("/tenants/:tenantId/deactivate", async (request, reply) => {
    const { tenantId } = request.params as { tenantId: string };
    requireRoleAtLeast(request, UserRole.ADMIN);
    assertTenantPathAccess(request, tenantId);

    const tenant = await prisma.tenant.findUnique({ where: { id: tenantId }, select: { isActive: true } });
    if (!tenant) throw app.httpErrors.notFound("Tenant not found.");
    if (!tenant.isActive) throw app.httpErrors.conflict("Tenant is already deactivated.");

    await prisma.tenant.update({
      where: { id: tenantId },
      data: { isActive: false, deactivatedAt: new Date() }
    });
    return reply.send({ ok: true, message: "Workspace deactivated. All user sessions will be rejected." });
  });

  app.patch("/tenants/:tenantId/reactivate", async (request, reply) => {
    const { tenantId } = request.params as { tenantId: string };
    requireRoleAtLeast(request, UserRole.ADMIN);
    assertTenantPathAccess(request, tenantId);

    const tenant = await prisma.tenant.findUnique({ where: { id: tenantId }, select: { isActive: true } });
    if (!tenant) throw app.httpErrors.notFound("Tenant not found.");
    if (tenant.isActive) throw app.httpErrors.conflict("Tenant is already active.");

    await prisma.tenant.update({
      where: { id: tenantId },
      data: { isActive: true, deactivatedAt: null }
    });
    return reply.send({ ok: true, message: "Workspace reactivated." });
  });

  // Trial extension — ADMIN only.
  // Allows the workspace admin (or platform team with admin access) to extend
  // the trial period during customer negotiations.
  app.patch("/tenants/:tenantId/extend-trial", async (request, reply) => {
    const { tenantId } = request.params as { tenantId: string };
    requireRoleAtLeast(request, UserRole.ADMIN);
    assertTenantPathAccess(request, tenantId);

    const body = request.body as { days?: unknown };
    const days = Number(body?.days);
    if (!Number.isInteger(days) || days < 1 || days > 90) {
      throw app.httpErrors.badRequest("days must be an integer between 1 and 90.");
    }

    const sub = await prisma.subscription.findFirst({
      where: { tenantId },
      select: { id: true, status: true, trialEndsAt: true }
    });
    if (!sub) throw app.httpErrors.notFound("Subscription not found.");
    if (sub.status !== "TRIALING") {
      throw app.httpErrors.conflict("Trial can only be extended for workspaces currently on a trial.");
    }

    // Extend from current trialEndsAt (or now if already expired), capped at 180 days from today.
    const base = sub.trialEndsAt && sub.trialEndsAt > new Date() ? sub.trialEndsAt : new Date();
    const newTrialEndsAt = addDays(base, days);
    const maxDate = addDays(new Date(), 180);
    const capped = newTrialEndsAt > maxDate ? maxDate : newTrialEndsAt;

    await prisma.subscription.update({
      where: { id: sub.id },
      data: { trialEndsAt: capped }
    });

    return reply.send({
      ok: true,
      trialEndsAt: capped,
      message: `Trial extended by ${days} day${days === 1 ? "" : "s"}. New expiry: ${capped.toISOString().slice(0, 10)}.`
    });
  });

  // S11: Onboarding status — ADMIN only
  app.get("/tenants/:tenantId/onboarding-status", async (request) => {
    const { tenantId } = request.params as { tenantId: string };
    requireRoleAtLeast(request, UserRole.ADMIN);
    assertTenantPathAccess(request, tenantId);

    const [userCount, customerCount, dealCount, teamCount, integrationCount] = await Promise.all([
      prisma.user.count({ where: { tenantId } }),
      prisma.customer.count({ where: { tenantId } }),
      prisma.deal.count({ where: { tenantId } }),
      prisma.team.count({ where: { tenantId } }),
      prisma.tenantIntegrationCredential.count({ where: { tenantId } })
    ]);

    return {
      steps: {
        teamCreated:      teamCount > 0,
        userInvited:      userCount > 1,     // more than just the admin
        integrationSetup: integrationCount > 0,
        customerImported: customerCount > 0,
        dealCreated:      dealCount > 0
      }
    };
  });
};
