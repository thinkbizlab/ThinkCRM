import { IntegrationPlatform, UserRole } from "@prisma/client";
import type { FastifyPluginAsync } from "fastify";
import { randomBytes } from "node:crypto";
import { promises as dns } from "node:dns";
import { z } from "zod";
import { Anthropic } from "@anthropic-ai/sdk";
import { config } from "../../config.js";
import { assertTenantPathAccess, requireRoleAtLeast, requireSuperAdmin, zodMsg } from "../../lib/http.js";
import { sendEmailCard, type EmailConfig } from "../../lib/email-notify.js";
import { hashPassword } from "../../lib/password.js";
import { prisma } from "../../lib/prisma.js";
import { decryptField } from "../../lib/secrets.js";
import { smtpPort } from "../../lib/smtp-port.js";
import { getTenantUrl } from "../../lib/tenant-url.js";
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
    const { tenant, admin, emailVerifyToken } = await prisma.$transaction(async (tx) => {
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

      // Generate email verification token (valid 24 hours)
      const emailVerifyToken = randomBytes(32).toString("hex");
      const emailVerifyExpiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
      await tx.user.update({
        where: { id: admin.id },
        data: { emailVerifyToken, emailVerifyExpiresAt }
      });

      return { tenant, admin, emailVerifyToken };
    });

    // Send verification email (best-effort — don't fail signup on email errors)
    try {
      const baseUrl = await getTenantUrl(tenant.id, slug);
      const verifyLink = `${baseUrl}/verify-email?token=${emailVerifyToken}`;

      let emailConfig: EmailConfig | null = null;
      if (config.SMTP_HOST && config.SMTP_FROM) {
        emailConfig = {
          host: config.SMTP_HOST,
          port: config.SMTP_PORT,
          fromAddress: config.SMTP_FROM,
          password: config.SMTP_PASS ?? ""
        };
      }

      if (emailConfig) {
        await sendEmailCard(emailConfig, adminEmail, {
          subject: "Verify your email — ThinkCRM",
          title: "Welcome to ThinkCRM!",
          facts: [
            { label: "Workspace", value: companyName },
            { label: "Email", value: adminEmail },
            { label: "Expires in", value: "24 hours" }
          ],
          detailUrl: verifyLink,
          footer: "Click the button above to verify your email and activate your workspace."
        });
      } else {
        app.log.warn(`[signup] No system SMTP configured — verification email for ${adminEmail} not sent. Token: ${emailVerifyToken}`);
      }
    } catch (err) {
      app.log.error({ err }, "[signup] Failed to send verification email");
    }

    return reply.code(201).send({
      needsEmailVerification: true,
      tenantSlug: tenant.slug,
      email: adminEmail,
      message: "Workspace created! Please check your email to verify your account."
    });
  });

  // ── Admin-facing onboard endpoint (super-admin only) ──────────────────────
  app.post("/tenants/onboard", async (request, reply) => {
    requireSuperAdmin(request);
    const parsed = onboardTenantSchema.safeParse(request.body);
    if (!parsed.success) {
      throw app.httpErrors.badRequest(zodMsg(parsed.error));
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
          emailVerified: true,
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

    const [userCount, customerCount, dealCount, teamCount, integrationCount, domainCount] = await Promise.all([
      prisma.user.count({ where: { tenantId } }),
      prisma.customer.count({ where: { tenantId } }),
      prisma.deal.count({ where: { tenantId } }),
      prisma.team.count({ where: { tenantId } }),
      prisma.tenantIntegrationCredential.count({ where: { tenantId } }),
      prisma.tenantCustomDomain.count({ where: { tenantId } })
    ]);

    return {
      steps: {
        teamCreated:      teamCount > 0,
        userInvited:      userCount > 1,     // more than just the admin
        integrationSetup: integrationCount > 0,
        customerImported: customerCount > 0,
        dealCreated:      dealCount > 0,
        domainConfigured: domainCount > 0
      }
    };
  });

  // ── Demo Data — trial tenants only ──────────────────────────────────────────

  /** Check if demo data has been generated for this tenant. */
  app.get("/tenants/:tenantId/demo-data/status", async (request) => {
    const { tenantId } = request.params as { tenantId: string };
    requireRoleAtLeast(request, UserRole.ADMIN);
    assertTenantPathAccess(request, tenantId);

    const [demoCustomers, demoDeals, demoVisits, demoTeams, demoUsers, globalKeyUsage, tenantHasOwnKey] = await Promise.all([
      prisma.customer.count({ where: { tenantId, isDemo: true } }),
      prisma.deal.count({ where: { tenantId, isDemo: true } }),
      prisma.visit.count({ where: { tenantId, isDemo: true } }),
      prisma.team.count({ where: { tenantId, isDemo: true } }),
      prisma.user.count({ where: { tenantId, isDemo: true } }),
      prisma.auditLog.count({ where: { tenantId, action: "DEMO_DATA_GENERATE_GLOBAL_KEY" } }),
      prisma.tenantIntegrationCredential.count({
        where: { tenantId, platform: IntegrationPlatform.ANTHROPIC, status: "ENABLED", apiKeyRef: { not: null } }
      })
    ]);

    const GLOBAL_KEY_LIMIT = 3;

    return {
      hasDemo: demoCustomers + demoDeals + demoVisits + demoTeams + demoUsers > 0,
      counts: { customers: demoCustomers, deals: demoDeals, visits: demoVisits, teams: demoTeams, users: demoUsers },
      globalKeyUsage,
      globalKeyLimit: GLOBAL_KEY_LIMIT,
      globalKeyRemaining: Math.max(0, GLOBAL_KEY_LIMIT - globalKeyUsage),
      hasOwnKey: tenantHasOwnKey > 0
    };
  });

  const demoDataGenerateSchema = z.object({
    industry: z.string().min(2).max(200).trim(),
    teamCount: z.number().int().min(1).max(5),
    repCount: z.number().int().min(1).max(20)
  }).strict();

  /** Generate demo data — only for TRIALING tenants, ADMIN only. */
  app.post("/tenants/:tenantId/demo-data/generate", async (request, reply) => {
    const { tenantId } = request.params as { tenantId: string };
    requireRoleAtLeast(request, UserRole.ADMIN);
    assertTenantPathAccess(request, tenantId);

    // Must be trialing
    const sub = await prisma.subscription.findFirst({
      where: { tenantId },
      select: { status: true }
    });
    if (!sub || sub.status !== "TRIALING") {
      throw app.httpErrors.forbidden("Demo data generation is only available during the trial period.");
    }

    // Prevent duplicate generation
    const existingDemo = await prisma.customer.count({ where: { tenantId, isDemo: true } });
    if (existingDemo > 0) {
      throw app.httpErrors.conflict("Demo data has already been generated. Delete it first before generating new data.");
    }

    const parsed = demoDataGenerateSchema.safeParse(request.body);
    if (!parsed.success) throw app.httpErrors.badRequest(zodMsg(parsed.error));
    const { industry, teamCount, repCount } = parsed.data;

    // Resolve AI API key — tenant-specific or global with 3-use limit
    const resolved = await resolveAnthropicKeyWithSource(tenantId);
    if (!resolved) {
      throw app.httpErrors.serviceUnavailable("AI service is not configured. Please set up an Anthropic API key in Settings → Integrations.");
    }

    const GLOBAL_KEY_LIMIT = 3;
    if (resolved.isGlobal) {
      const globalUsageCount = await prisma.auditLog.count({
        where: { tenantId, action: "DEMO_DATA_GENERATE_GLOBAL_KEY" }
      });
      if (globalUsageCount >= GLOBAL_KEY_LIMIT) {
        return reply.status(403).send({
          statusCode: 403,
          error: "Forbidden",
          code: "GLOBAL_KEY_LIMIT_REACHED",
          message: `You've used all ${GLOBAL_KEY_LIMIT} free demo data generations. To continue, add your own Anthropic API key in Settings → Integrations → AI Service.`
        });
      }
    }

    const apiKey = resolved.key;

    // Ask AI to generate realistic demo data based on the industry
    const client = new Anthropic({ apiKey });
    const aiResponse = await client.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 4096,
      messages: [{
        role: "user",
        content: `You are a CRM data generator. Generate realistic demo data for a sales CRM based on this context:
- Industry/product: ${industry}
- Number of teams: ${teamCount}
- Number of sales reps: ${repCount}

Generate JSON with this exact structure:
{
  "teams": [{ "teamName": "..." }],
  "reps": [{ "fullName": "...", "email": "...", "teamIndex": 0 }],
  "customers": [
    {
      "name": "...",
      "customerCode": "...",
      "contacts": [{ "name": "...", "position": "...", "tel": "...", "email": "..." }]
    }
  ],
  "deals": [
    {
      "dealName": "...",
      "customerIndex": 0,
      "repIndex": 0,
      "estimatedValue": 50000,
      "stageOrder": 1,
      "daysUntilFollowUp": 7
    }
  ],
  "visits": [
    {
      "customerIndex": 0,
      "repIndex": 0,
      "daysFromNow": -3,
      "objective": "...",
      "visitType": "PLANNED",
      "status": "CHECKED_OUT",
      "result": "..."
    }
  ]
}

Rules:
- Generate ${teamCount} teams with names fitting the "${industry}" industry
- Generate ${repCount} reps with Thai names (mix of male/female), assign them to teams using teamIndex (0-based)
- Generate 8-15 customers relevant to the industry, with realistic Thai company names and 1-2 contacts each
- Customer codes should be like "C001", "C002", etc.
- Generate 10-20 deals across different stages (stageOrder: 1=Opportunity, 2=Quotation, 3=Won, 4=Lost)
- Generate 15-25 visits with a mix of statuses (PLANNED for future, CHECKED_OUT for past with results)
- Use realistic Thai baht values for deals (10,000 - 5,000,000)
- Rep emails should be firstname.l@demo.thinkcrm.com format
- For visits with daysFromNow < 0 (past), status should be "CHECKED_OUT" with a result
- For visits with daysFromNow >= 0 (future), status should be "PLANNED" with no result

Respond ONLY with valid JSON, no markdown or explanation.`
      }]
    });

    const aiText = aiResponse.content[0]?.type === "text" ? aiResponse.content[0].text : "";
    const jsonMatch = aiText.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      throw app.httpErrors.internalServerError("AI failed to generate valid demo data. Please try again.");
    }

    let demoData: {
      teams: Array<{ teamName: string }>;
      reps: Array<{ fullName: string; email: string; teamIndex: number }>;
      customers: Array<{ name: string; customerCode: string; contacts: Array<{ name: string; position: string; tel?: string; email?: string }> }>;
      deals: Array<{ dealName: string; customerIndex: number; repIndex: number; estimatedValue: number; stageOrder: number; daysUntilFollowUp: number }>;
      visits: Array<{ customerIndex: number; repIndex: number; daysFromNow: number; objective?: string; visitType: string; status: string; result?: string }>;
    };

    try {
      demoData = JSON.parse(jsonMatch[0]);
    } catch {
      throw app.httpErrors.internalServerError("AI returned malformed JSON. Please try again.");
    }

    // Insert everything in a transaction
    const result = await prisma.$transaction(async (tx) => {
      // 1. Get the default payment term
      let paymentTerm = await tx.paymentTerm.findFirst({ where: { tenantId } });
      if (!paymentTerm) {
        paymentTerm = await tx.paymentTerm.create({
          data: { tenantId, code: "NET30", name: "Net 30", dueDays: 30 }
        });
      }

      // 2. Create teams
      const createdTeams: Array<{ id: string; teamName: string }> = [];
      for (const t of demoData.teams) {
        const team = await tx.team.create({
          data: { tenantId, teamName: t.teamName, isDemo: true }
        });
        createdTeams.push(team);
      }

      // 3. Create rep users
      const createdReps: Array<{ id: string; fullName: string }> = [];
      for (const r of demoData.reps) {
        const teamIdx = Math.min(r.teamIndex, createdTeams.length - 1);
        const rep = await tx.user.create({
          data: {
            tenantId,
            email: r.email,
            fullName: r.fullName,
            role: "REP",
            passwordHash: "",
            isActive: true,
            isDemo: true,
            teamId: createdTeams[teamIdx]?.id ?? null
          }
        });
        createdReps.push(rep);
      }

      // 4. Create customers
      const existingCustomerCount = await tx.customer.count({ where: { tenantId } });
      const createdCustomers: Array<{ id: string; name: string }> = [];
      for (let i = 0; i < demoData.customers.length; i++) {
        const c = demoData.customers[i]!;
        const code = `DEMO-${String(existingCustomerCount + i + 1).padStart(4, "0")}`;
        const customer = await tx.customer.create({
          data: {
            tenantId,
            customerCode: code,
            name: c.name,
            defaultTermId: paymentTerm.id,
            isDemo: true
          }
        });
        for (const contact of (c.contacts ?? [])) {
          await tx.customerContact.create({
            data: {
              customerId: customer.id,
              name: contact.name,
              position: contact.position,
              tel: contact.tel ?? null,
              email: contact.email ?? null
            }
          });
        }
        createdCustomers.push(customer);
      }

      // 5. Get deal stages
      const stages = await tx.dealStage.findMany({
        where: { tenantId },
        orderBy: { stageOrder: "asc" }
      });
      if (stages.length === 0) {
        throw new Error("No deal stages configured");
      }

      // 6. Create deals
      const existingDealCount = await tx.deal.count({ where: { tenantId } });
      const createdDeals: Array<{ id: string }> = [];
      for (let i = 0; i < demoData.deals.length; i++) {
        const d = demoData.deals[i]!;
        const custIdx = Math.min(d.customerIndex, createdCustomers.length - 1);
        const repIdx = Math.min(d.repIndex, createdReps.length - 1);
        const rep = createdReps[repIdx];
        const cust = createdCustomers[custIdx];
        const stage = stages.find(s => s.stageOrder === d.stageOrder) ?? stages[0]!;
        if (!rep || !cust) continue;
        const dealNo = `D-${String(existingDealCount + i + 1).padStart(6, "0")}`;
        const followUp = new Date();
        followUp.setDate(followUp.getDate() + (d.daysUntilFollowUp ?? 7));

        const deal = await tx.deal.create({
          data: {
            tenantId,
            ownerId: rep.id,
            dealNo,
            dealName: d.dealName,
            customerId: cust.id,
            stageId: stage.id,
            estimatedValue: d.estimatedValue,
            followUpAt: followUp,
            status: stage.isClosedWon ? "WON" : stage.isClosedLost ? "LOST" : "OPEN",
            closedAt: (stage.isClosedWon || stage.isClosedLost) ? new Date() : null,
            isDemo: true
          }
        });
        createdDeals.push(deal);
      }

      // 7. Create visits
      const existingVisitCount = await tx.visit.count({ where: { tenantId } });
      let visitIdx = 0;
      for (const v of demoData.visits) {
        const custIdx = Math.min(v.customerIndex, createdCustomers.length - 1);
        const repIdx = Math.min(v.repIndex, createdReps.length - 1);
        const rep = createdReps[repIdx];
        const cust = createdCustomers[custIdx];
        if (!rep || !cust) continue;
        const visitNo = `V-${String(existingVisitCount + visitIdx + 1).padStart(6, "0")}`;
        const plannedAt = new Date();
        plannedAt.setDate(plannedAt.getDate() + (v.daysFromNow ?? 0));

        const isPast = (v.daysFromNow ?? 0) < 0;
        const visitStatus = isPast ? "CHECKED_OUT" : "PLANNED";

        await tx.visit.create({
          data: {
            tenantId,
            repId: rep.id,
            customerId: cust.id,
            visitNo,
            visitType: v.visitType === "UNPLANNED" ? "UNPLANNED" : "PLANNED",
            status: visitStatus,
            plannedAt,
            objective: v.objective ?? null,
            checkInAt: isPast ? new Date(plannedAt.getTime() + 5 * 60_000) : null,
            checkOutAt: isPast ? new Date(plannedAt.getTime() + 45 * 60_000) : null,
            result: isPast ? (v.result ?? "Completed visit") : null,
            isDemo: true
          }
        });
        visitIdx++;
      }

      return {
        teams: createdTeams.length,
        reps: createdReps.length,
        customers: createdCustomers.length,
        deals: createdDeals.length,
        visits: visitIdx
      };
    });

    // Log global key usage so we can enforce the limit
    if (resolved.isGlobal) {
      await prisma.auditLog.create({
        data: {
          tenantId,
          action: "DEMO_DATA_GENERATE_GLOBAL_KEY",
          detail: { industry, teamCount, repCount, counts: result }
        }
      });
    }

    return reply.status(201).send({
      ok: true,
      message: "Demo data generated successfully!",
      counts: result
    });
  });

  /** Delete all demo data — ADMIN only. */
  app.delete("/tenants/:tenantId/demo-data", async (request, reply) => {
    const { tenantId } = request.params as { tenantId: string };
    requireRoleAtLeast(request, UserRole.ADMIN);
    assertTenantPathAccess(request, tenantId);

    // Delete in correct order (visits → deals → customers → users → teams) to respect FK constraints
    const [visits, deals, customers, users, teams] = await prisma.$transaction([
      prisma.visit.deleteMany({ where: { tenantId, isDemo: true } }),
      prisma.deal.deleteMany({ where: { tenantId, isDemo: true } }),
      prisma.customer.deleteMany({ where: { tenantId, isDemo: true } }),
      prisma.user.deleteMany({ where: { tenantId, isDemo: true } }),
      prisma.team.deleteMany({ where: { tenantId, isDemo: true } })
    ]);

    return reply.send({
      ok: true,
      message: "All demo data has been deleted.",
      deleted: {
        visits: visits.count,
        deals: deals.count,
        customers: customers.count,
        users: users.count,
        teams: teams.count
      }
    });
  });
};

/** Resolve Anthropic API key — tenant-specific or global fallback. */
/** Resolve Anthropic API key and indicate whether it's the tenant's own or the global fallback. */
async function resolveAnthropicKeyWithSource(tenantId: string): Promise<{ key: string; isGlobal: boolean } | null> {
  const cred = await prisma.tenantIntegrationCredential.findFirst({
    where: {
      tenantId,
      platform: IntegrationPlatform.ANTHROPIC,
      status: "ENABLED",
      apiKeyRef: { not: null }
    },
    select: { apiKeyRef: true }
  });
  if (cred?.apiKeyRef) {
    const key = decryptField(cred.apiKeyRef);
    if (key) return { key, isGlobal: false };
  }
  const globalKey = config.ANTHROPIC_API_KEY ?? null;
  if (globalKey) return { key: globalKey, isGlobal: true };
  return null;
}
