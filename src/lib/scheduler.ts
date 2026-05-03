/**
 * Dynamic cron scheduler for ThinkCRM.
 *
 * Job configs are stored per-tenant in CronJobConfig.
 * On startup, all enabled configs are loaded and scheduled.
 * When an admin changes a config via API, call rescheduleJob() to hot-reload.
 * Manual triggers call runJobNow() which logs a MANUAL run record.
 */

import cron from "node-cron";
import type { ScheduledTask } from "node-cron";
import { CronRunStatus, CronTriggerType } from "@prisma/client";
import { prisma } from "./prisma.js";
import { hostname } from "node:os";

// Stamp RUNNING records with this tag so startup cleanup only touches our own runs (M3).
export const WORKER_TAG = `worker:${hostname()}:${process.pid}`;

// ── Job definitions ───────────────────────────────────────────────────────────

export interface JobDef {
  key: string;
  label: string;
  description: string;
  defaultCronExpr: string;
  /** Return a human-readable summary of what was done.
   *  force=true bypasses time-based guards (e.g. "last 5 days of month") for manual test runs. */
  run: (tenantId: string, force?: boolean) => Promise<string>;
}

export const JOB_DEFS: JobDef[] = [
  {
    key: "weeklyDigest",
    label: "Weekly Digest",
    description: "สรุปผลงานประจำสัปดาห์ ส่งทุกวันจันทร์ 06:00 น. เข้าช่องกลุ่มของทีม",
    // Expressed in tenant local time — node-cron interprets against config.timezone
    defaultCronExpr: "0 6 * * 1", // Monday 06:00 (tenant timezone)
    run: async (tenantId) => {
      const { runWeeklyDigestForTenant } = await import("./digest-notify.js");
      return runWeeklyDigestForTenant(tenantId);
    }
  },
  {
    key: "kpiAlert",
    label: "KPI Alert",
    description: "แจ้งเตือน KPI รายวัน 5 วันสุดท้ายของเดือน ส่งเข้าช่องส่วนตัว หรือกลุ่มหากไม่มีช่องส่วนตัว",
    defaultCronExpr: "0 7 * * *", // 07:00 (tenant timezone)
    run: async (tenantId, force) => {
      const { runKpiAlertsForTenant } = await import("./kpi-alert-notify.js");
      return runKpiAlertsForTenant(tenantId, { force });
    }
  },
  {
    key: "syncRestPull",
    label: "REST Sync Pull",
    description: "Pulls Customers / Items / Payment Terms from every ENABLED REST data source configured on Settings → Data Sync.",
    defaultCronExpr: "0 2 * * *", // 02:00 nightly (tenant timezone)
    run: async (tenantId) => {
      const { pullAllRestSourcesForTenant } = await import("../modules/sync/rest-pull.js");
      return pullAllRestSourcesForTenant(tenantId);
    }
  },
  {
    key: "syncMysqlPull",
    label: "MySQL Sync Pull",
    description: "Polls Customers / Items / Payment Terms from every ENABLED MySQL data source. Read-only — never writes back.",
    defaultCronExpr: "* * * * *", // every minute; per-source intervalMinutes throttles further
    run: async (tenantId) => {
      const { pullAllMysqlSourcesForTenant } = await import("../modules/sync/mysql-pull.js");
      return pullAllMysqlSourcesForTenant(tenantId);
    }
  },
  {
    key: "syncJobReaper",
    label: "Sync Job Reaper",
    description: "Auto-fails MySQL sync jobs stuck in RUNNING longer than SYNC_JOB_STUCK_THRESHOLD_MINUTES (default 30). Frees the per-source lock when a worker dies mid-pull.",
    defaultCronExpr: "*/15 * * * *", // every 15 min
    run: async (tenantId) => {
      const { reapStuckMysqlJobs } = await import("../modules/sync/mysql-pull.js");
      return reapStuckMysqlJobs(tenantId);
    }
  },
  {
    key: "customerDedupScan",
    label: "Customer Dedup Scan",
    description: "Scans for duplicate customers (deterministic + AI fuzzy) and notifies admins when new candidates appear since the last run.",
    defaultCronExpr: "0 3 * * *", // 03:00 tenant TZ
    run: async (tenantId) => {
      const { runCustomerDedupScanForTenant } = await import("./dedup-notify.js");
      return runCustomerDedupScanForTenant(tenantId);
    }
  },
  {
    key: "invoiceAutoSend",
    label: "Invoice Auto-Send",
    description: "Finalizes DRAFT tenant invoices whose billing period has ended and emails them to the first active tenant admin.",
    defaultCronExpr: "0 9 * * *", // 09:00 tenant TZ
    run: async (tenantId) => {
      const { runInvoiceAutoSendForTenant } = await import("../modules/billing/invoice-email.js");
      return runInvoiceAutoSendForTenant(tenantId);
    }
  }
];

export function getJobDef(jobKey: string): JobDef | undefined {
  return JOB_DEFS.find(j => j.key === jobKey);
}

// ── Task registry ─────────────────────────────────────────────────────────────

/** Key: `${tenantId}:${jobKey}` */
const activeTasks = new Map<string, ScheduledTask>();
let initialized = false;

function taskKey(tenantId: string, jobKey: string) {
  return `${tenantId}:${jobKey}`;
}

// ── Watchdog ──────────────────────────────────────────────────────────────────

/**
 * Auto-fail CronJobRun rows stuck in RUNNING past the threshold.
 *
 * On Vercel, an invocation can die mid-tick (function timeout, deploy
 * interruption, OOM) without flipping its CronJobRun row to a terminal
 * status. The next tick then hits the per-(tenantId, jobKey) overlap guard
 * in cronRoutes.runJobForAllTenants and silently skips, halting all
 * cron-driven work for that pair until the row is fixed by hand.
 *
 * Threshold is generous vs. Vercel's 5-min function budget — a real tick
 * should never approach 15 min — and the sweep is global (not per-tenant)
 * so a single call clears all stragglers in one statement.
 */
export async function reapStuckCronJobRuns(thresholdMinutes = 15): Promise<number> {
  const cutoff = new Date(Date.now() - thresholdMinutes * 60 * 1000);
  const { count } = await prisma.cronJobRun.updateMany({
    where: { status: CronRunStatus.RUNNING, startedAt: { lt: cutoff } },
    data: {
      status: CronRunStatus.FAILURE,
      completedAt: new Date(),
      summary: `Auto-failed by watchdog: stuck RUNNING for >${thresholdMinutes}min`,
    },
  });
  if (count > 0) {
    console.warn(`[scheduler] reapStuckCronJobRuns: auto-failed ${count} stuck row(s) older than ${thresholdMinutes}min`);
  }
  return count;
}

// ── Run logging ───────────────────────────────────────────────────────────────

async function executeAndLog(
  tenantId: string,
  jobKey: string,
  triggeredBy: CronTriggerType,
  existingRunId?: string,
  force?: boolean
): Promise<void> {
  const def = getJobDef(jobKey);
  if (!def) return;

  // Overlap guard for scheduled runs — manual runs are checked in runJobNow before the record is created
  if (!existingRunId) {
    const alreadyRunning = await prisma.cronJobRun.findFirst({
      where: { tenantId, jobKey, status: CronRunStatus.RUNNING }
    });
    if (alreadyRunning) {
      console.warn(`[scheduler] ${jobKey} tenant=${tenantId} skipped — run ${alreadyRunning.id} still in progress`);
      return;
    }
  }

  const runId = existingRunId ?? (await prisma.cronJobRun.create({
    data: { tenantId, jobKey, status: CronRunStatus.RUNNING, triggeredBy, startedAt: new Date(), summary: WORKER_TAG }
  })).id;

  let status: CronRunStatus = CronRunStatus.SUCCESS;
  let summary = "";

  try {
    summary = await def.run(tenantId, force);
  } catch (err) {
    status = CronRunStatus.FAILURE;
    summary = err instanceof Error ? err.message.slice(0, 500) : String(err).slice(0, 500);
    console.error(`[scheduler] ${jobKey} tenant=${tenantId} error:`, err);
  }

  await prisma.cronJobRun.update({
    where: { id: runId },
    data: { status, summary, completedAt: new Date() }
  });
}

// ── Schedule management ───────────────────────────────────────────────────────

function scheduleTask(tenantId: string, jobKey: string, cronExpr: string, timezone: string): void {
  const key = taskKey(tenantId, jobKey);

  // Cancel existing task if any
  const existing = activeTasks.get(key);
  if (existing) {
    existing.stop();
    activeTasks.delete(key);
  }

  if (!cron.validate(cronExpr)) {
    console.warn(`[scheduler] Invalid cron expression "${cronExpr}" for ${key} — skipping`);
    return;
  }

  const task = cron.schedule(cronExpr, async () => {
    await executeAndLog(tenantId, jobKey, CronTriggerType.SCHEDULED);
  }, { timezone });

  activeTasks.set(key, task);
  console.log(`[scheduler] Scheduled ${key} — "${cronExpr}" (${timezone})`);
}

/** Load (or create with defaults) all configs for a tenant and schedule their tasks. */
async function loadAndScheduleTenant(tenantId: string): Promise<void> {
  // Read the tenant's timezone setting to use as default
  const tenant = await prisma.tenant.findUnique({
    where: { id: tenantId },
    select: { timezone: true }
  });
  const tenantTz = tenant?.timezone || "Asia/Bangkok";

  for (const def of JOB_DEFS) {
    // Upsert with defaults so every tenant always has a config row
    const config = await prisma.cronJobConfig.upsert({
      where: { tenantId_jobKey: { tenantId, jobKey: def.key } },
      update: {},
      create: {
        tenantId,
        jobKey: def.key,
        cronExpr: def.defaultCronExpr,
        timezone: tenantTz,
        isEnabled: true
      }
    });

    if (config.isEnabled) {
      scheduleTask(tenantId, def.key, config.cronExpr, config.timezone);
    }
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Called once on server start.
 * Loads all tenant configs from DB and registers scheduled tasks.
 */
export async function startScheduler(): Promise<void> {
  if (initialized) return;
  initialized = true;

  const tenants = await prisma.tenant.findMany({ select: { id: true } });
  for (const tenant of tenants) {
    await loadAndScheduleTenant(tenant.id);
  }

  // S10: System-level daily job — expire trials that have passed their trialEndsAt date.
  // Runs once a day at 00:05 server time (not tenant-specific, no CronJobConfig row needed).
  cron.schedule("5 0 * * *", async () => {
    try {
      const expired = await prisma.subscription.findMany({
        where: { status: "TRIALING", trialEndsAt: { lt: new Date() } },
        select: { tenantId: true, id: true }
      });
      for (const sub of expired) {
        await prisma.$transaction([
          prisma.subscription.update({ where: { id: sub.id },       data: { status: "CANCELED" } }),
          prisma.tenant.update(      { where: { id: sub.tenantId }, data: { isActive: false, deactivatedAt: new Date() } })
        ]);
        console.log(`[scheduler] Trial expired — tenant=${sub.tenantId}`);
      }
    } catch (err) {
      console.error("[scheduler] trial-expiry job error", err);
    }
  });

  // Data retention — anonymize old audit logs, purge expired tokens/challenges.
  // Runs daily at 00:15 server time.
  cron.schedule("15 0 * * *", async () => {
    try {
      const now = new Date();
      const twelveMonthsAgo = new Date(now);
      twelveMonthsAgo.setMonth(twelveMonthsAgo.getMonth() - 12);
      const twentyFourMonthsAgo = new Date(now);
      twentyFourMonthsAgo.setMonth(twentyFourMonthsAgo.getMonth() - 24);

      const deleted = await prisma.auditLog.deleteMany({
        where: { createdAt: { lt: twentyFourMonthsAgo } },
      });
      const anonymized = await prisma.auditLog.updateMany({
        where: {
          createdAt: { lt: twelveMonthsAgo, gte: twentyFourMonthsAgo },
          OR: [{ userId: { not: null } }, { ipAddress: { not: null } }],
        },
        data: { userId: null, ipAddress: null },
      });

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
      const purgedChallenges = await prisma.webAuthnChallenge.deleteMany({
        where: { expiresAt: { lt: now } },
      });

      console.log(`[scheduler] data-retention: audit deleted=${deleted.count} anonymized=${anonymized.count}, tokens purged=${purgedTokens.count}, challenges purged=${purgedChallenges.count}`);
    } catch (err) {
      console.error("[scheduler] data-retention job error", err);
    }
  });

  console.log(`[scheduler] Started — ${activeTasks.size} active tasks across ${tenants.length} tenants`);
}

/**
 * Called after an admin updates a cron config.
 * Re-reads the DB record and reschedules (or cancels) the task.
 */
export async function rescheduleJob(tenantId: string, jobKey: string): Promise<void> {
  const config = await prisma.cronJobConfig.findUnique({
    where: { tenantId_jobKey: { tenantId, jobKey } }
  });
  if (!config) return;

  const key = taskKey(tenantId, jobKey);
  const existing = activeTasks.get(key);
  if (existing) { existing.stop(); activeTasks.delete(key); }

  if (config.isEnabled) {
    scheduleTask(tenantId, jobKey, config.cronExpr, config.timezone);
  }
}

/**
 * Manually trigger a job immediately and log it as MANUAL.
 * Returns the run record id.
 */
export async function runJobNow(tenantId: string, jobKey: string): Promise<string> {
  if (!getJobDef(jobKey)) throw new Error(`Unknown job key: ${jobKey}`);

  // Overlap guard — prevent duplicate manual triggers while a run is in progress
  const alreadyRunning = await prisma.cronJobRun.findFirst({
    where: { tenantId, jobKey, status: CronRunStatus.RUNNING }
  });
  if (alreadyRunning) {
    throw new Error(`Job "${jobKey}" is already running (runId=${alreadyRunning.id}). Wait for it to finish before triggering again.`);
  }

  // Create the single run record here so we can return its ID immediately
  const runRecord = await prisma.cronJobRun.create({
    data: {
      tenantId,
      jobKey,
      status: CronRunStatus.RUNNING,
      triggeredBy: CronTriggerType.MANUAL,
      startedAt: new Date(),
      summary: WORKER_TAG
    }
  });

  // Execute async — force=true bypasses time-based guards for manual test runs
  executeAndLog(tenantId, jobKey, CronTriggerType.MANUAL, runRecord.id, true).catch(err => {
    console.error(`[scheduler] runJobNow ${jobKey}:`, err);
  });

  return runRecord.id;
}
