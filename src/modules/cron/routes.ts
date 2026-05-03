import type { FastifyPluginAsync } from "fastify";
import { CronRunStatus, CronTriggerType } from "@prisma/client";
import { prisma } from "../../lib/prisma.js";
import { config } from "../../config.js";
import { WORKER_TAG, getJobDef, reapStuckCronJobRuns } from "../../lib/scheduler.js";

/**
 * Vercel Cron HTTP endpoints.
 *
 * On Vercel, `node-cron` timers don't persist between invocations.
 * Instead, Vercel Cron triggers these HTTP endpoints on a schedule
 * defined in vercel.json.  Each endpoint loops through all active
 * tenants and their CronJobConfig rows.
 *
 * Security: Vercel sends `Authorization: Bearer <CRON_SECRET>`.
 * We verify this header on every cron request.
 */
export const cronRoutes: FastifyPluginAsync = async (app) => {

  /** Verify the Vercel CRON_SECRET bearer token. */
  function verifyCronSecret(request: { headers: Record<string, string | string[] | undefined> }): void {
    const secret = config.CRON_SECRET;
    if (!secret) {
      // If no CRON_SECRET configured, only allow in development
      if (config.NODE_ENV === "production") {
        throw app.httpErrors.forbidden("CRON_SECRET is not configured.");
      }
      return;
    }
    const auth = request.headers.authorization;
    if (auth !== `Bearer ${secret}`) {
      throw app.httpErrors.unauthorized("Invalid cron secret.");
    }
  }

  /**
   * Run a specific job key for all active tenants that have it enabled.
   * Respects each tenant's CronJobConfig (enabled/disabled).
   */
  async function runJobForAllTenants(jobKey: string): Promise<{ tenantResults: Array<{ tenantId: string; status: string; summary: string }> }> {
    const def = getJobDef(jobKey);
    if (!def) throw new Error(`Unknown job key: ${jobKey}`);

    // Reap stuck CronJobRun rows before checking the overlap guard so a previously
    // killed invocation (function timeout, deploy mid-flight) doesn't permanently
    // block this tenant + jobKey. Runs every cron tick — at minute granularity for
    // the syncMysqlPull job — so a stuck row clears within ~16 min worst case.
    try {
      await reapStuckCronJobRuns();
    } catch (err) {
      app.log.error({ err }, "[cron] reapStuckCronJobRuns failed");
    }

    const configs = await prisma.cronJobConfig.findMany({
      where: { jobKey, isEnabled: true },
      include: { tenant: { select: { id: true, isActive: true } } },
    });

    const results: Array<{ tenantId: string; status: string; summary: string }> = [];

    for (const cfg of configs) {
      if (!cfg.tenant.isActive) continue;

      // Overlap guard — skip if already running
      const running = await prisma.cronJobRun.findFirst({
        where: { tenantId: cfg.tenantId, jobKey, status: CronRunStatus.RUNNING },
      });
      if (running) {
        results.push({ tenantId: cfg.tenantId, status: "skipped", summary: `Already running: ${running.id}` });
        continue;
      }

      const run = await prisma.cronJobRun.create({
        data: {
          tenantId: cfg.tenantId,
          jobKey,
          status: CronRunStatus.RUNNING,
          triggeredBy: CronTriggerType.SCHEDULED,
          startedAt: new Date(),
          summary: WORKER_TAG,
        },
      });

      let status: CronRunStatus = CronRunStatus.SUCCESS;
      let summary = "";

      try {
        summary = await def.run(cfg.tenantId);
      } catch (err) {
        status = CronRunStatus.FAILURE;
        summary = err instanceof Error ? err.message.slice(0, 500) : String(err).slice(0, 500);
      }

      await prisma.cronJobRun.update({
        where: { id: run.id },
        data: { status, summary, completedAt: new Date() },
      });

      results.push({ tenantId: cfg.tenantId, status, summary });
    }

    return { tenantResults: results };
  }

  // ── Weekly Digest ─────────────────────────────────────────────────────────
  app.get("/cron/weekly-digest", async (request) => {
    verifyCronSecret(request);
    return runJobForAllTenants("weeklyDigest");
  });

  // ── KPI Alert ─────────────────────────────────────────────────────────────
  app.get("/cron/kpi-alert", async (request) => {
    verifyCronSecret(request);
    return runJobForAllTenants("kpiAlert");
  });

  // ── REST Sync Pull ────────────────────────────────────────────────────────
  app.get("/cron/sync-rest-pull", async (request) => {
    verifyCronSecret(request);
    return runJobForAllTenants("syncRestPull");
  });

  // ── MySQL Sync Pull ───────────────────────────────────────────────────────
  // Reads Customers / Items / Payment Terms directly from a configured MySQL
  // ERP. Read-only — never writes back to the upstream DB. Per-tenant cron tick
  // (every minute by default); `pullAllMysqlSourcesForTenant` further throttles
  // each source by its `intervalMinutes` setting.
  app.get("/cron/sync-mysql-pull", async (request) => {
    verifyCronSecret(request);
    return runJobForAllTenants("syncMysqlPull");
  });

  // ── Sync Job Reaper ───────────────────────────────────────────────────────
  // Auto-fails MYSQL IntegrationSyncJob rows stuck in RUNNING past
  // SYNC_JOB_STUCK_THRESHOLD_MINUTES (default 30) so the per-source enqueue
  // lock is freed when a worker dies mid-pull. Companion to the
  // CronJobRun watchdog at the top of runJobForAllTenants.
  app.get("/cron/sync-job-reaper", async (request) => {
    verifyCronSecret(request);
    return runJobForAllTenants("syncJobReaper");
  });

  // ── Customer Dedup Scan ──────────────────────────────────────────────────
  // Per-tenant: scan for duplicate customers and notify admins when new
  // candidates appear since the last successful run.
  app.get("/cron/customer-dedup-scan", async (request) => {
    verifyCronSecret(request);
    return runJobForAllTenants("customerDedupScan");
  });

  // ── Invoice Auto-Send ─────────────────────────────────────────────────────
  // Finalizes DRAFT tenant invoices whose billing period has ended and emails
  // them to the first active tenant admin.
  app.get("/cron/invoice-auto-send", async (request) => {
    verifyCronSecret(request);
    return runJobForAllTenants("invoiceAutoSend");
  });

  // ── Trial Expiry (system-level, not per-tenant job) ───────────────────────
  app.get("/cron/trial-expiry", async (request) => {
    verifyCronSecret(request);

    const expired = await prisma.subscription.findMany({
      where: { status: "TRIALING", trialEndsAt: { lt: new Date() } },
      select: { tenantId: true, id: true },
    });

    const results: string[] = [];
    for (const sub of expired) {
      await prisma.$transaction([
        prisma.subscription.update({ where: { id: sub.id }, data: { status: "CANCELED" } }),
        prisma.tenant.update({ where: { id: sub.tenantId }, data: { isActive: false, deactivatedAt: new Date() } }),
      ]);
      results.push(sub.tenantId);
    }

    return { expired: results.length, tenants: results };
  });

  // ── Data Retention (system-level daily maintenance) ──────────────────────
  // Policy:
  //   - Audit logs > 12 months: anonymize (clear userId and ipAddress)
  //   - Audit logs > 24 months: delete
  //   - Expired refresh tokens: delete
  //   - Expired WebAuthn challenges: delete
  app.get("/cron/data-retention", async (request) => {
    verifyCronSecret(request);

    const now = new Date();
    const twelveMonthsAgo = new Date(now);
    twelveMonthsAgo.setMonth(twelveMonthsAgo.getMonth() - 12);
    const twentyFourMonthsAgo = new Date(now);
    twentyFourMonthsAgo.setMonth(twentyFourMonthsAgo.getMonth() - 24);

    // Delete audit logs older than 24 months
    const deleted = await prisma.auditLog.deleteMany({
      where: { createdAt: { lt: twentyFourMonthsAgo } },
    });

    // Anonymize audit logs between 12-24 months (clear PII)
    const anonymized = await prisma.auditLog.updateMany({
      where: {
        createdAt: { lt: twelveMonthsAgo, gte: twentyFourMonthsAgo },
        OR: [
          { userId: { not: null } },
          { ipAddress: { not: null } },
        ],
      },
      data: { userId: null, ipAddress: null },
    });

    // Purge expired/revoked refresh tokens older than 30 days
    const thirtyDaysAgo = new Date(now);
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
    const purgedTokens = await prisma.refreshToken.deleteMany({
      where: {
        OR: [
          { expiresAt: { lt: thirtyDaysAgo } },
          { revokedAt: { lt: thirtyDaysAgo } },
        ],
      },
    });

    // Purge expired WebAuthn challenges
    const purgedChallenges = await prisma.webAuthnChallenge.deleteMany({
      where: { expiresAt: { lt: now } },
    });

    return {
      auditLogs: { deleted: deleted.count, anonymized: anonymized.count },
      refreshTokens: { purged: purgedTokens.count },
      webAuthnChallenges: { purged: purgedChallenges.count },
    };
  });
};
