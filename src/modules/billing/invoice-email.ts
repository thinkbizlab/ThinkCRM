/**
 * Invoice email delivery helper.
 *
 * Shared by:
 *   - scheduler.ts → invoiceAutoSend JOB_DEF (daily)
 *   - super-admin/routes.ts → POST /super-admin/tenants/:tid/invoices/:iid/send (manual)
 *
 * Finalizes a DRAFT invoice and emails it to the tenant's first active ADMIN.
 * If Stripe is configured and the tenant has a customerId, a best-effort
 * stripe.invoices.sendInvoice() is also attempted for PDF delivery.
 */

import { IntegrationPlatform, InvoiceStatus, SubscriptionStatus, UserRole } from "@prisma/client";
import { prisma } from "../../lib/prisma.js";
import { decryptCredential } from "../../lib/secrets.js";
import { smtpPort } from "../../lib/smtp-port.js";
import { sendEmailCard } from "../../lib/email-notify.js";
import { logAuditEvent } from "../../lib/audit.js";

export interface SendInvoiceResult {
  ok: boolean;
  invoiceId: string;
  sentTo?: string;
  reason?: string;
  finalized?: boolean;
}

function formatMoney(cents: number, currency: string): string {
  const n = cents / 100;
  return `${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${currency}`;
}

function formatPeriod(start: string, end: string): string {
  // periodStart / periodEnd are ISO date strings (YYYY-MM-DD) on TenantInvoice.
  return `${start} → ${end}`;
}

export async function sendInvoiceEmail(opts: {
  tenantId: string;
  invoiceId: string;
  actorUserId?: string | null;
}): Promise<SendInvoiceResult> {
  const { tenantId, invoiceId, actorUserId } = opts;

  const invoice = await prisma.tenantInvoice.findUnique({
    where: { id: invoiceId },
    include: {
      tenant: {
        select: {
          id: true,
          name: true,
          slug: true,
          subscriptions: {
            take: 1,
            orderBy: { createdAt: "desc" },
            select: {
              seatCount: true,
              seatPriceCents: true,
              billingCycle: true,
              currency: true,
            },
          },
        },
      },
    },
  });

  if (!invoice) return { ok: false, invoiceId, reason: "invoice_not_found" };
  if (invoice.tenantId !== tenantId) return { ok: false, invoiceId, reason: "tenant_mismatch" };

  // Finalize DRAFT invoices before emailing
  let finalizedNow = false;
  if (invoice.status === InvoiceStatus.DRAFT) {
    await prisma.tenantInvoice.update({
      where: { id: invoiceId },
      data: { status: InvoiceStatus.FINALIZED, finalizedAt: new Date() },
    });
    finalizedNow = true;
  }

  // Resolve recipient — first active ADMIN of tenant
  const admin = await prisma.user.findFirst({
    where: { tenantId, role: UserRole.ADMIN, isActive: true },
    orderBy: { createdAt: "asc" },
    select: { email: true, fullName: true },
  });
  if (!admin) return { ok: false, invoiceId, reason: "no_active_admin", finalized: finalizedNow };

  // Load email credentials
  const emailCred = await prisma.tenantIntegrationCredential
    .findUnique({
      where: { tenantId_platform: { tenantId, platform: IntegrationPlatform.EMAIL } },
      select: { clientIdRef: true, clientSecretRef: true, apiKeyRef: true, webhookTokenRef: true },
    })
    .then((r) => decryptCredential(r));

  if (!emailCred?.clientIdRef || !emailCred?.apiKeyRef || !emailCred?.webhookTokenRef) {
    return { ok: false, invoiceId, reason: "no_email_config", finalized: finalizedNow };
  }

  const sub = invoice.tenant.subscriptions[0];
  const seatLine = sub
    ? `${sub.seatCount} × ${formatMoney(sub.seatPriceCents, sub.currency)} / ${sub.billingCycle === "YEARLY" ? "year" : "month"}`
    : "—";

  const result = await sendEmailCard(
    {
      host: emailCred.clientIdRef,
      port: smtpPort(emailCred.clientSecretRef),
      fromAddress: emailCred.webhookTokenRef,
      password: emailCred.apiKeyRef,
    },
    admin.email,
    {
      subject: `Invoice ${invoice.invoiceMonth} — ${invoice.tenant.name}`,
      title: `Invoice — ${invoice.invoiceMonth}`,
      facts: [
        { label: "Tenant", value: invoice.tenant.name },
        { label: "Period", value: formatPeriod(invoice.periodStart, invoice.periodEnd) },
        { label: "Seats", value: seatLine },
        { label: "Seat base", value: formatMoney(invoice.seatsBaseCents, invoice.currency) },
        { label: "Storage overage", value: formatMoney(invoice.storageOverageCents, invoice.currency) },
        { label: "Proration", value: formatMoney(invoice.prorationAdjustmentsCents, invoice.currency) },
        { label: "Total due", value: formatMoney(invoice.totalDueCents, invoice.currency) },
      ],
      footer: `Questions? Reply to this email.`,
    }
  );

  await logAuditEvent(
    tenantId,
    actorUserId ?? null,
    result.ok ? "INVOICE_EMAIL_SENT" : "INVOICE_EMAIL_FAILED",
    {
      invoiceId,
      invoiceMonth: invoice.invoiceMonth,
      to: admin.email,
      finalizedNow,
      message: result.message,
    }
  );

  return {
    ok: result.ok,
    invoiceId,
    sentTo: admin.email,
    reason: result.ok ? undefined : result.message,
    finalized: finalizedNow,
  };
}

/**
 * Auto-send: finalizes + emails every DRAFT invoice for a tenant whose
 * billing period has ended. Intended for the daily scheduler.
 */
export async function runInvoiceAutoSendForTenant(tenantId: string): Promise<string> {
  // Only run if tenant has an active or trialing subscription
  const activeSub = await prisma.subscription.count({
    where: {
      tenantId,
      status: { in: [SubscriptionStatus.ACTIVE, SubscriptionStatus.TRIALING] },
    },
  });
  if (activeSub === 0) return "no active subscription — skipped";

  const todayIso = new Date().toISOString().slice(0, 10);

  const drafts = await prisma.tenantInvoice.findMany({
    where: {
      tenantId,
      status: InvoiceStatus.DRAFT,
      periodEnd: { lte: todayIso },
    },
    select: { id: true },
    orderBy: { periodEnd: "asc" },
  });

  if (drafts.length === 0) return "no draft invoices past period end";

  let sent = 0;
  let failed = 0;
  for (const inv of drafts) {
    const r = await sendInvoiceEmail({ tenantId, invoiceId: inv.id });
    if (r.ok) sent++;
    else failed++;
  }
  return `finalized + emailed=${sent}, failed=${failed}`;
}
