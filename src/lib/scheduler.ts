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

  const runId = existingRunId ?? (await prisma.cronJobRun.create({
    data: { tenantId, jobKey, status: CronRunStatus.RUNNING, triggeredBy, startedAt: new Date() }
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

  // Create the single run record here so we can return its ID immediately
  const runRecord = await prisma.cronJobRun.create({
    data: {
      tenantId,
      jobKey,
      status: CronRunStatus.RUNNING,
      triggeredBy: CronTriggerType.MANUAL,
      startedAt: new Date()
    }
  });

  // Execute async — force=true bypasses time-based guards for manual test runs
  executeAndLog(tenantId, jobKey, CronTriggerType.MANUAL, runRecord.id, true).catch(err => {
    console.error(`[scheduler] runJobNow ${jobKey}:`, err);
  });

  return runRecord.id;
}
