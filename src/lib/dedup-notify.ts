/**
 * Customer-dedup scheduled scan + admin notification.
 *
 * Wraps scanDuplicatesForTenant with a delta computation: counts only candidates
 * that became OPEN since the previous successful run of this job, and notifies
 * tenant admins (LINE personal push, then email fallback) when delta > 0.
 *
 * Recipients: role=ADMIN, isActive=true. Dedup is admin-gated everywhere else,
 * so notifications follow the same scope.
 */

import { CronRunStatus, IntegrationPlatform, UserRole } from "@prisma/client";
import { prisma } from "./prisma.js";
import { decryptCredential } from "./secrets.js";
import { smtpPort } from "./smtp-port.js";
import { scanDuplicatesForTenant } from "../modules/master-data/dedup.js";

const JOB_KEY = "customerDedupScan";

async function getLineCredential(tenantId: string): Promise<string | null> {
  const cred = decryptCredential(await prisma.tenantIntegrationCredential.findUnique({
    where: { tenantId_platform: { tenantId, platform: IntegrationPlatform.LINE } },
    select: { apiKeyRef: true },
  }));
  return cred?.apiKeyRef ?? null;
}

async function getEmailCredential(tenantId: string) {
  const cred = decryptCredential(await prisma.tenantIntegrationCredential.findUnique({
    where: { tenantId_platform: { tenantId, platform: IntegrationPlatform.EMAIL } },
    select: { clientIdRef: true, clientSecretRef: true, apiKeyRef: true, webhookTokenRef: true },
  }));
  if (!cred?.clientIdRef || !cred.apiKeyRef || !cred.webhookTokenRef) return null;
  return {
    host: cred.clientIdRef,
    port: smtpPort(cred.clientSecretRef),
    fromAddress: cred.webhookTokenRef,
    username: cred.webhookTokenRef,
    password: cred.apiKeyRef,
  };
}

async function getTenantAppName(tenantId: string): Promise<string> {
  const t = await prisma.tenant.findUnique({ where: { id: tenantId }, select: { name: true } });
  return t?.name ?? "ThinkCRM";
}

async function previousRunStartedAt(tenantId: string): Promise<Date | null> {
  const prior = await prisma.cronJobRun.findFirst({
    where: { tenantId, jobKey: JOB_KEY, status: CronRunStatus.SUCCESS },
    orderBy: { startedAt: "desc" },
    select: { startedAt: true },
  });
  return prior?.startedAt ?? null;
}

async function notifyAdmins(tenantId: string, delta: number, totalOpen: number): Promise<number> {
  const admins = await prisma.user.findMany({
    where: { tenantId, role: UserRole.ADMIN, isActive: true },
    select: { id: true, email: true, externalAccounts: { where: { status: "CONNECTED" } } },
  });
  if (admins.length === 0) return 0;

  const appName = await getTenantAppName(tenantId);
  const message = `[${appName}] Customer dedup scan: ${delta} new duplicate candidate${delta === 1 ? "" : "s"} found (${totalOpen} open total). Review at /customers/duplicates`;

  const lineToken = await getLineCredential(tenantId);
  const emailCfg = await getEmailCredential(tenantId);

  let delivered = 0;
  for (const admin of admins) {
    let sentToThisAdmin = false;
    if (lineToken) {
      const lineAcct = admin.externalAccounts.find((a) => a.provider === IntegrationPlatform.LINE);
      if (lineAcct) {
        try {
          const { sendLinePush } = await import("./line-notify.js");
          const r = await sendLinePush(lineToken, lineAcct.externalUserId, { type: "text", text: message });
          if (r.ok) sentToThisAdmin = true;
        } catch (err) {
          console.warn(`[dedup-notify] LINE push failed admin=${admin.id}:`, err);
        }
      }
    }
    if (!sentToThisAdmin && emailCfg && admin.email) {
      try {
        const { sendEmailCard } = await import("./email-notify.js");
        const r = await sendEmailCard(emailCfg, admin.email, {
          subject: `🔍 ${delta} new duplicate customer${delta === 1 ? "" : "s"} — [${appName}]`,
          title: `Duplicate customers detected`,
          facts: [
            { label: "New candidates", value: String(delta) },
            { label: "Total open", value: String(totalOpen) },
          ],
          footer: `[${appName}] · Review at /customers/duplicates`,
        });
        if (r.ok) sentToThisAdmin = true;
      } catch (err) {
        console.warn(`[dedup-notify] Email failed admin=${admin.id}:`, err);
      }
    }
    if (sentToThisAdmin) delivered++;
  }
  return delivered;
}

/**
 * Run the dedup scan and notify admins of any new candidates.
 * Returns a one-line summary suitable for the CronJobRun record.
 */
export async function runCustomerDedupScanForTenant(tenantId: string): Promise<string> {
  const cutoff = await previousRunStartedAt(tenantId);
  const result = await scanDuplicatesForTenant(tenantId);

  const newCandidatesSinceLastRun = cutoff
    ? await prisma.customerDuplicateCandidate.count({
        where: { tenantId, status: "OPEN", createdAt: { gt: cutoff } },
      })
    : result.openCandidates;

  let delivered = 0;
  if (newCandidatesSinceLastRun > 0) {
    delivered = await notifyAdmins(tenantId, newCandidatesSinceLastRun, result.openCandidates);
  }

  return `Scanned ${result.scannedCustomers} customers; ${newCandidatesSinceLastRun} new candidate(s) since ${cutoff?.toISOString() ?? "first-run"}; ${delivered} admin(s) notified.`;
}
