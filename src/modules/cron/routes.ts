import type { FastifyPluginAsync } from "fastify";
import { CronRunStatus, CronTriggerType } from "@prisma/client";
import { prisma } from "../../lib/prisma.js";
import { config } from "../../config.js";
import { WORKER_TAG, getJobDef } from "../../lib/scheduler.js";

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
};
