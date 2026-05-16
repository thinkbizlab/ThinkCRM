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
import { seedTenantCronJobConfigs } from "../../lib/scheduler.js";
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

      // Seed CronJobConfig rows for every JOB_DEF so daily/weekly crons
      // (kpiAlert, weeklyDigest, customerDedupScan, etc.) are immediately
      // configured for this tenant — without this, runJobForAllTenants's
      // self-heal would only create them on each cron's first natural fire,
      // which for a weekly job means the new tenant waits up to 7 days.
      await seedTenantCronJobConfigs(tx, tenant.id, "Asia/Bangkok");

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

      // Seed CronJobConfig rows so daily/weekly crons are immediately
      // configured (see comment in /tenants/signup for rationale).
      await seedTenantCronJobConfigs(tx, createdTenant.id, "Asia/Bangkok");

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

    const [userCount, customerCount, dealCount, teamCount, integrationCount, domainCount, kpiTargetCount] = await Promise.all([
      prisma.user.count({ where: { tenantId } }),
      prisma.customer.count({ where: { tenantId } }),
      prisma.deal.count({ where: { tenantId } }),
      prisma.team.count({ where: { tenantId } }),
      prisma.tenantIntegrationCredential.count({ where: { tenantId } }),
      prisma.tenantCustomDomain.count({ where: { tenantId } }),
      prisma.salesKpiTarget.count({ where: { tenantId } })
    ]);

    return {
      steps: {
        teamCreated:      teamCount > 0,
        userInvited:      userCount > 1,     // more than just the admin
        kpiTargetSet:     kpiTargetCount > 0,
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

    const [
      demoCustomers, demoDeals, demoVisits, demoTeams, demoUsers,
      demoCustomerGroups, demoItems, demoProspects, demoAnnouncements,
      demoKpiTargets, demoQuotations,
      globalKeyUsage, tenantHasOwnKey
    ] = await Promise.all([
      prisma.customer.count({ where: { tenantId, isDemo: true } }),
      prisma.deal.count({ where: { tenantId, isDemo: true } }),
      prisma.visit.count({ where: { tenantId, isDemo: true } }),
      prisma.team.count({ where: { tenantId, isDemo: true } }),
      prisma.user.count({ where: { tenantId, isDemo: true } }),
      prisma.customerGroup.count({ where: { tenantId, isDemo: true } }),
      prisma.item.count({ where: { tenantId, isDemo: true } }),
      prisma.prospect.count({ where: { tenantId, isDemo: true } }),
      prisma.announcement.count({ where: { tenantId, isDemo: true } }),
      // KPI targets and quotations don't have isDemo themselves — they inherit
      // via user.isDemo / customer.isDemo respectively.
      prisma.salesKpiTarget.count({ where: { tenantId } }).then(async (total) => {
        if (total === 0) return 0;
        const demoUserIds = (await prisma.user.findMany({
          where: { tenantId, isDemo: true }, select: { id: true }
        })).map(u => u.id);
        if (!demoUserIds.length) return 0;
        return prisma.salesKpiTarget.count({ where: { tenantId, userId: { in: demoUserIds } } });
      }),
      prisma.quotation.count({ where: { tenantId, customer: { isDemo: true } } }),
      prisma.auditLog.count({ where: { tenantId, action: "DEMO_DATA_GENERATE_GLOBAL_KEY" } }),
      prisma.tenantIntegrationCredential.count({
        where: { tenantId, platform: IntegrationPlatform.ANTHROPIC, status: "ENABLED", apiKeyRef: { not: null } }
      })
    ]);

    const GLOBAL_KEY_LIMIT = 3;

    return {
      hasDemo: (
        demoCustomers + demoDeals + demoVisits + demoTeams + demoUsers
        + demoCustomerGroups + demoItems + demoProspects + demoAnnouncements
      ) > 0,
      counts: {
        customers: demoCustomers,
        deals: demoDeals,
        visits: demoVisits,
        teams: demoTeams,
        users: demoUsers,
        customerGroups: demoCustomerGroups,
        items: demoItems,
        prospects: demoProspects,
        announcements: demoAnnouncements,
        kpiTargets: demoKpiTargets,
        quotations: demoQuotations
      },
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

    // Hybrid generation: the AI generates only names/labels (Thai-flavoured),
    // every numeric/structural/date field is code-driven. This keeps the AI's
    // output JSON small and reliable, and lets us populate every entity type
    // a CRM admin would expect to see in a populated tenant.
    const client = new Anthropic({ apiKey });
    const aiResponse = await client.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 6000,
      messages: [{
        role: "user",
        content: `You are generating realistic demo content for a Thai-language sales CRM.

Industry/product: ${industry}
Number of teams: ${teamCount}
Number of sales reps: ${repCount}

Generate JSON with this EXACT shape. Only fill in names and labels — do NOT generate numbers, dates, or status fields.

{
  "teams": [{ "teamName": "..." }],
  "reps": [{ "fullName": "Thai full name", "email": "firstname.l@demo.thinkcrm.com", "teamIndex": 0 }],
  "customerGroups": [{ "name": "...", "description": "..." }],
  "customers": [
    {
      "name": "...",
      "groupIndex": 0,
      "contacts": [{ "name": "...", "position": "..." }],
      "addresses": [
        { "line1": "...", "subDistrict": "...", "district": "...", "province": "...", "postalCode": "10330" }
      ]
    }
  ],
  "items": [{ "name": "..." }],
  "deals": [{ "dealName": "...", "customerIndex": 0, "repIndex": 0 }],
  "prospects": [{ "displayName": "...", "siteAddress": "..." }],
  "announcements": [{ "title": "...", "body": "..." }]
}

Counts:
- teams: exactly ${teamCount} (names fitting "${industry}", in Thai)
- reps: exactly ${repCount} (Thai full names; emails like somchai.p@demo.thinkcrm.com; spread across teams via teamIndex 0..${teamCount - 1})
- customerGroups: exactly 3 (e.g. "ลูกค้าพรีเมียม"/"Premium", "ลูกค้าทั่วไป"/"Standard", "ตัวแทนจำหน่าย"/"Distributor")
- customers: exactly 12, each with 1–2 contacts and exactly 1 Thai address (line1 non-empty)
- items: exactly 10 (product or service names fitting the industry)
- deals: exactly 15 (dealName format like "{customerName} – {product or service}")
- prospects: exactly 4 (unidentified sites a rep drove past — construction sites, new shops, etc.)
- announcements: exactly 2 (e.g. welcome message, policy update)

Use a believable mix of Thai company / contact / item names. Respond with ONLY the JSON object, no markdown.`
      }]
    });

    const aiText = aiResponse.content[0]?.type === "text" ? aiResponse.content[0].text : "";
    const jsonMatch = aiText.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      throw app.httpErrors.internalServerError("AI failed to generate valid demo data. Please try again.");
    }

    type DemoPayload = {
      teams: { teamName: string }[];
      reps: { fullName: string; email: string; teamIndex: number }[];
      customerGroups: { name: string; description?: string }[];
      customers: {
        name: string;
        groupIndex?: number;
        contacts: { name: string; position: string }[];
        addresses: { line1: string; subDistrict?: string; district?: string; province?: string; postalCode?: string }[];
      }[];
      items: { name: string }[];
      deals: { dealName: string; customerIndex: number; repIndex: number }[];
      prospects: { displayName: string; siteAddress?: string }[];
      announcements: { title: string; body: string }[];
    };

    let demoData: DemoPayload;
    try {
      demoData = JSON.parse(jsonMatch[0]);
    } catch {
      throw app.httpErrors.internalServerError("AI returned malformed JSON. Please try again.");
    }

    // ── Code-driven structural helpers ─────────────────────────────────────
    const rand = (min: number, max: number) => Math.floor(Math.random() * (max - min + 1)) + min;
    const pick = <T,>(arr: T[]): T => arr[rand(0, arr.length - 1)]!;
    // Rough Bangkok bounding box — close enough for demo lat/lng.
    const bkkLat = () => 13.65 + Math.random() * 0.20;
    const bkkLng = () => 100.45 + Math.random() * 0.20;
    const monthKey = (offsetMonths: number) => {
      const d = new Date();
      d.setMonth(d.getMonth() + offsetMonths);
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
    };
    const PROGRESS_NOTES = [
      "Initial call — customer interested, requested proposal.",
      "Sent quotation, awaiting feedback.",
      "Customer requested follow-up next week.",
      "Negotiating final terms.",
      "Approval pending from customer's procurement team.",
      "On-site demo completed; positive reception.",
      "Sent revised quote with updated discount."
    ];
    const VISIT_OBJECTIVES = ["Demo product", "Follow-up call", "Negotiate terms", "Annual review", "New product intro"];
    const VISIT_RESULTS = ["Productive meeting, agreed on next steps", "Customer requested more info", "Closed on quotation", "Will revisit next quarter"];
    const COVISIT_NOTES = ["Rep handled objections well.", "Strong product knowledge.", "Could improve closing technique.", "Good rapport with the customer."];

    // Insert everything in a transaction — atomic, so partial failures roll back.
    const result = await prisma.$transaction(async (tx) => {
      // a) Ensure a NET30 payment term (needed by Quotation).
      let paymentTerm = await tx.paymentTerm.findFirst({ where: { tenantId } });
      if (!paymentTerm) {
        paymentTerm = await tx.paymentTerm.create({
          data: { tenantId, code: "NET30", name: "Net 30", dueDays: 30 }
        });
      }

      // b) Deal stages must already be seeded for the tenant.
      const stages = await tx.dealStage.findMany({
        where: { tenantId },
        orderBy: { stageOrder: "asc" }
      });
      if (stages.length === 0) {
        throw new Error("No deal stages configured");
      }
      const wonStage = stages.find(s => s.isClosedWon) ?? stages[stages.length - 1]!;
      const lostStage = stages.find(s => s.isClosedLost) ?? stages[stages.length - 1]!;
      const openStages = stages.filter(s => !s.isClosedWon && !s.isClosedLost);
      const fallbackOpen = openStages.length ? openStages : [stages[0]!];

      // c) Teams
      const createdTeams: { id: string; teamName: string }[] = [];
      for (const t of demoData.teams) {
        createdTeams.push(await tx.team.create({
          data: { tenantId, teamName: t.teamName, isDemo: true }
        }));
      }

      // d) Reps
      const createdReps: { id: string; fullName: string }[] = [];
      for (const r of demoData.reps) {
        const teamIdx = Math.min(Math.max(r.teamIndex ?? 0, 0), createdTeams.length - 1);
        createdReps.push(await tx.user.create({
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
        }));
      }

      // e) KPI targets — current month + previous month for every rep.
      let kpiCount = 0;
      for (const rep of createdReps) {
        for (const offset of [-1, 0]) {
          await tx.salesKpiTarget.create({
            data: {
              tenantId,
              userId: rep.id,
              targetMonth: monthKey(offset),
              visitTargetCount: rand(20, 40),
              newDealValueTarget: rand(300_000, 1_000_000),
              revenueTarget: rand(500_000, 2_000_000)
            }
          });
          kpiCount++;
        }
      }

      // f) Customer groups
      const createdGroups: { id: string }[] = [];
      for (let i = 0; i < demoData.customerGroups.length; i++) {
        const g = demoData.customerGroups[i]!;
        createdGroups.push(await tx.customerGroup.create({
          data: {
            tenantId,
            code: `DEMO-CG-${String(i + 1).padStart(2, "0")}`,
            name: g.name,
            description: g.description ?? null,
            isDemo: true
          }
        }));
      }

      // g) Customers + addresses + contacts
      const existingCustomerCount = await tx.customer.count({ where: { tenantId } });
      const createdCustomers: { id: string; name: string; addressIds: string[] }[] = [];
      for (let i = 0; i < demoData.customers.length; i++) {
        const c = demoData.customers[i]!;
        const code = `DEMO-${String(existingCustomerCount + i + 1).padStart(4, "0")}`;
        const groupId = (c.groupIndex != null && createdGroups[c.groupIndex])
          ? createdGroups[c.groupIndex]!.id
          : (createdGroups.length ? pick(createdGroups).id : null);
        const customer = await tx.customer.create({
          data: {
            tenantId,
            customerCode: code,
            name: c.name,
            customerGroupId: groupId,
            siteLat: bkkLat(),
            siteLng: bkkLng(),
            isDemo: true
          }
        });
        for (const contact of (c.contacts ?? [])) {
          await tx.customerContact.create({
            data: { customerId: customer.id, name: contact.name, position: contact.position }
          });
        }
        const addressIds: string[] = [];
        for (let aidx = 0; aidx < (c.addresses ?? []).length; aidx++) {
          const a = c.addresses[aidx]!;
          const addr = await tx.customerAddress.create({
            data: {
              customerId: customer.id,
              addressLine1: a.line1 || `${c.name} HQ`,
              subDistrict: a.subDistrict ?? null,
              district: a.district ?? null,
              province: a.province ?? "Bangkok",
              postalCode: a.postalCode ?? null,
              country: "Thailand",
              latitude: bkkLat(),
              longitude: bkkLng(),
              isDefaultBilling: aidx === 0,
              isDefaultShipping: aidx === 0
            }
          });
          addressIds.push(addr.id);
        }
        createdCustomers.push({ id: customer.id, name: customer.name, addressIds });
      }

      // h) Items
      const createdItems: { id: string; itemCode: string; unitPrice: number }[] = [];
      for (let i = 0; i < demoData.items.length; i++) {
        const it = demoData.items[i]!;
        const unitPrice = rand(5_000, 250_000);
        createdItems.push(await tx.item.create({
          data: {
            tenantId,
            itemCode: `DEMO-ITM-${String(i + 1).padStart(3, "0")}`,
            name: it.name,
            unitPrice,
            isDemo: true
          }
        }));
      }

      // i) Deals — code chooses stage / value / dates. Roughly 50% open, 30% won, 20% lost.
      const existingDealCount = await tx.deal.count({ where: { tenantId } });
      type DemoDealRow = { id: string; customerId: string; status: "OPEN" | "WON" | "LOST" };
      const createdDeals: DemoDealRow[] = [];
      for (let i = 0; i < demoData.deals.length; i++) {
        const d = demoData.deals[i]!;
        const cust = createdCustomers[Math.min(Math.max(d.customerIndex ?? 0, 0), createdCustomers.length - 1)];
        const rep = createdReps[Math.min(Math.max(d.repIndex ?? 0, 0), createdReps.length - 1)];
        if (!cust || !rep) continue;
        const roll = Math.random();
        const stage = roll < 0.5 ? pick(fallbackOpen) : roll < 0.8 ? wonStage : lostStage;
        const status: "OPEN" | "WON" | "LOST" = stage.isClosedWon ? "WON" : stage.isClosedLost ? "LOST" : "OPEN";
        const followUp = new Date();
        followUp.setDate(followUp.getDate() + rand(3, 21));
        const closedAt = status === "OPEN" ? null : new Date(Date.now() - rand(1, 30) * 86_400_000);

        const deal = await tx.deal.create({
          data: {
            tenantId,
            ownerId: rep.id,
            dealNo: `D-${String(existingDealCount + i + 1).padStart(6, "0")}`,
            dealName: d.dealName,
            customerId: cust.id,
            stageId: stage.id,
            estimatedValue: rand(50_000, 2_500_000),
            followUpAt: followUp,
            status,
            closedAt,
            isDemo: true
          }
        });
        createdDeals.push({ id: deal.id, customerId: cust.id, status });
      }

      // j) Deal progress updates — 1-3 per OPEN deal.
      let dealUpdateCount = 0;
      for (const deal of createdDeals.filter(d => d.status === "OPEN")) {
        const updates = rand(1, 3);
        for (let u = 0; u < updates; u++) {
          await tx.dealProgressUpdate.create({
            data: {
              dealId: deal.id,
              createdById: pick(createdReps).id,
              note: pick(PROGRESS_NOTES),
              createdAt: new Date(Date.now() - rand(1, 30) * 86_400_000)
            }
          });
          dealUpdateCount++;
        }
      }

      // k) Quotations + line items — every WON deal, plus 50% of OPEN deals.
      const existingQuoteCount = await tx.quotation.count({ where: { tenantId } });
      let quoteIdx = 0;
      let quoteItemCount = 0;
      for (const deal of createdDeals) {
        const needsQuote = deal.status === "WON" || (deal.status === "OPEN" && Math.random() < 0.5);
        if (!needsQuote || !createdItems.length) continue;
        const custInfo = createdCustomers.find(c => c.id === deal.customerId);
        const billingAddressId = custInfo?.addressIds[0] ?? null;
        const items = Array.from({ length: rand(2, 5) }, () => pick(createdItems));
        let subtotal = 0;
        const itemLines = items.map(it => {
          const qty = rand(1, 5);
          const discountPercent = pick([0, 0, 0, 5, 10]);
          const netPricePerUnit = it.unitPrice * (1 - discountPercent / 100);
          const totalPrice = netPricePerUnit * qty;
          subtotal += totalPrice;
          return { itemId: it.id, itemCode: it.itemCode, unitPrice: it.unitPrice, discountPercent, netPricePerUnit, quantity: qty, totalPrice };
        });
        const vatRate = 7;
        const vatAmount = subtotal * (vatRate / 100);
        const grandTotal = subtotal + vatAmount;
        const validTo = new Date();
        validTo.setDate(validTo.getDate() + 30);

        const quote = await tx.quotation.create({
          data: {
            tenantId,
            dealId: deal.id,
            quotationNo: `DEMO-Q-${String(existingQuoteCount + quoteIdx + 1).padStart(5, "0")}`,
            customerId: deal.customerId,
            paymentTermId: paymentTerm.id,
            billingAddressId,
            shippingAddressId: billingAddressId,
            validTo,
            status: deal.status === "WON" ? "APPROVED" : "SENT",
            subtotal,
            vatRate,
            vatAmount,
            grandTotal
          }
        });
        for (const ln of itemLines) {
          await tx.quotationItem.create({ data: { quotationId: quote.id, ...ln } });
          quoteItemCount++;
        }
        quoteIdx++;
      }

      // l) Visits — code-driven mix of past CHECKED_OUT and future PLANNED.
      const existingVisitCount = await tx.visit.count({ where: { tenantId } });
      const VISIT_COUNT = Math.min(25, Math.max(15, createdCustomers.length * 2));
      const visitIds: string[] = [];
      let visitsIdx = 0;
      for (let i = 0; i < VISIT_COUNT; i++) {
        const cust = pick(createdCustomers);
        const rep = pick(createdReps);
        if (!cust || !rep) continue;
        const daysFromNow = rand(-30, 14);
        const plannedAt = new Date();
        plannedAt.setDate(plannedAt.getDate() + daysFromNow);
        const isPast = daysFromNow < 0;
        const visit = await tx.visit.create({
          data: {
            tenantId,
            repId: rep.id,
            customerId: cust.id,
            visitNo: `V-${String(existingVisitCount + visitsIdx + 1).padStart(6, "0")}`,
            visitType: Math.random() < 0.8 ? "PLANNED" : "UNPLANNED",
            status: isPast ? "CHECKED_OUT" : "PLANNED",
            plannedAt,
            objective: pick(VISIT_OBJECTIVES),
            checkInAt: isPast ? new Date(plannedAt.getTime() + 5 * 60_000) : null,
            checkInLat: isPast ? bkkLat() : null,
            checkInLng: isPast ? bkkLng() : null,
            checkOutAt: isPast ? new Date(plannedAt.getTime() + 45 * 60_000) : null,
            result: isPast ? pick(VISIT_RESULTS) : null,
            isDemo: true
          }
        });
        visitIds.push(visit.id);
        visitsIdx++;
      }

      // m) Visit co-visitors — supervisor joins 30% of past visits.
      let coVisitorCount = 0;
      if (createdReps.length > 1 && visitIds.length) {
        const pastVisits = await tx.visit.findMany({
          where: { id: { in: visitIds }, status: "CHECKED_OUT" },
          select: { id: true, repId: true, checkInAt: true }
        });
        for (const v of pastVisits) {
          if (Math.random() > 0.3) continue;
          const others = createdReps.filter(r => r.id !== v.repId);
          if (!others.length) continue;
          await tx.visitCoVisitor.create({
            data: {
              tenantId,
              visitId: v.id,
              coVisitorUserId: pick(others).id,
              checkInAt: v.checkInAt,
              checkInLat: bkkLat(),
              checkInLng: bkkLng(),
              evalScore: rand(3, 5),
              evalNotes: pick(COVISIT_NOTES),
              evalReleasedAt: new Date()
            }
          });
          coVisitorCount++;
        }
      }

      // n) Prospects + one photo each.
      const createdProspects: { id: string }[] = [];
      for (let i = 0; i < demoData.prospects.length; i++) {
        const p = demoData.prospects[i]!;
        const creator = pick(createdReps);
        const prospect = await tx.prospect.create({
          data: {
            tenantId,
            status: "UNIDENTIFIED",
            displayName: p.displayName,
            siteAddress: p.siteAddress ?? null,
            siteLat: bkkLat(),
            siteLng: bkkLng(),
            createdById: creator.id,
            createdAt: new Date(Date.now() - rand(1, 14) * 86_400_000),
            isDemo: true
          }
        });
        await tx.prospectPhoto.create({
          data: {
            prospectId: prospect.id,
            tenantId,
            // objectRef is required; use a demo placeholder so the frontend's
            // image renderer can fall back to a generic icon when it can't
            // resolve a real signed URL.
            objectRef: `demo://prospect-${i + 1}-photo-1.jpg`,
            caption: "Site photo",
            uploadedById: creator.id
          }
        });
        createdProspects.push(prospect);
      }

      // o) Announcements
      let announcementCount = 0;
      const author = createdReps[0]?.id ?? null;
      for (const a of demoData.announcements) {
        await tx.announcement.create({
          data: {
            tenantId,
            title: a.title,
            body: a.body,
            roles: [],
            createdById: author,
            isDemo: true
          }
        });
        announcementCount++;
      }

      return {
        teams: createdTeams.length,
        reps: createdReps.length,
        kpiTargets: kpiCount,
        customerGroups: createdGroups.length,
        customers: createdCustomers.length,
        addresses: createdCustomers.reduce((n, c) => n + c.addressIds.length, 0),
        items: createdItems.length,
        deals: createdDeals.length,
        dealUpdates: dealUpdateCount,
        quotations: quoteIdx,
        quotationItems: quoteItemCount,
        visits: visitsIdx,
        coVisitors: coVisitorCount,
        prospects: createdProspects.length,
        announcements: announcementCount
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

    // KPI targets have no FK relation to User (just a userId string), so we
    // resolve demo user IDs up-front to scope the cleanup.
    const demoUserIds = (await prisma.user.findMany({
      where: { tenantId, isDemo: true },
      select: { id: true }
    })).map(u => u.id);

    // Order matters — every deleteMany must run BEFORE any of its onDelete:Restrict
    // parents are removed. Cascade-only children (QuotationItem, ProspectPhoto,
    // CustomerAddress, CustomerContact, AnnouncementAck) are removed implicitly
    // when their parent row is deleted, so we don't list them.
    const [
      kpiTargets,
      progressUpdates,
      coVisitors,
      quotations,
      visits,
      prospects,
      deals,
      customers,
      announcements,
      items,
      customerGroups,
      users,
      teams
    ] = await prisma.$transaction([
      prisma.salesKpiTarget.deleteMany({ where: { tenantId, userId: { in: demoUserIds } } }),
      prisma.dealProgressUpdate.deleteMany({ where: { deal: { tenantId, isDemo: true } } }),
      prisma.visitCoVisitor.deleteMany({ where: { tenantId, visit: { isDemo: true } } }),
      prisma.quotation.deleteMany({ where: { tenantId, customer: { isDemo: true } } }),
      prisma.visit.deleteMany({ where: { tenantId, isDemo: true } }),
      prisma.prospect.deleteMany({ where: { tenantId, isDemo: true } }),
      prisma.deal.deleteMany({ where: { tenantId, isDemo: true } }),
      prisma.customer.deleteMany({ where: { tenantId, isDemo: true } }),
      prisma.announcement.deleteMany({ where: { tenantId, isDemo: true } }),
      prisma.item.deleteMany({ where: { tenantId, isDemo: true } }),
      prisma.customerGroup.deleteMany({ where: { tenantId, isDemo: true } }),
      prisma.user.deleteMany({ where: { tenantId, isDemo: true } }),
      prisma.team.deleteMany({ where: { tenantId, isDemo: true } })
    ]);

    return reply.send({
      ok: true,
      message: "All demo data has been deleted.",
      deleted: {
        kpiTargets: kpiTargets.count,
        progressUpdates: progressUpdates.count,
        coVisitors: coVisitors.count,
        quotations: quotations.count,
        visits: visits.count,
        prospects: prospects.count,
        deals: deals.count,
        customers: customers.count,
        announcements: announcements.count,
        items: items.count,
        customerGroups: customerGroups.count,
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
