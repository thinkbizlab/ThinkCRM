/**
 * KPI Alert — daily check for last 5 days of the month.
 * Sends personal Thai-language alerts when progress is below 85%.
 *
 * Delivery order:
 *   1. Personal notification channel (LINE user ID / Teams / Slack stored in UserExternalAccount)
 *   2. Fallback: Team group channel (if personal channel not connected or disabled in prefs)
 *
 * Recipients: ALL roles (REP, SUPERVISOR, MANAGER, DIRECTOR, ADMIN)
 *   - REP → their own KPI
 *   - SUPERVISOR / MANAGER / DIRECTOR → aggregated team KPI (team they manage)
 *   - ADMIN → skipped (no direct KPI target)
 *
 * Urgency levels:
 *   ⚡ 70–85%  : moderate warning
 *   🚨 50–70%  : urgent
 *   🔴  <50%   : critical
 */

import { ChannelType, IntegrationPlatform, UserRole } from "@prisma/client";
import { prisma } from "./prisma.js";

// ── Date helpers ─────────────────────────────────────────────────────────────

/** Returns true if today is within the last 5 calendar days of the current month (Bangkok). */
export function isLastFiveDaysOfMonth(): boolean {
  const nowBkk = new Date(
    new Date().toLocaleString("en-US", { timeZone: "Asia/Bangkok" })
  );
  const lastDay = new Date(nowBkk.getFullYear(), nowBkk.getMonth() + 1, 0).getDate();
  return nowBkk.getDate() >= lastDay - 4;
}

function currentMonthKey(): string {
  return new Date().toISOString().slice(0, 7); // YYYY-MM
}

function daysLeftInMonth(): number {
  const nowBkk = new Date(
    new Date().toLocaleString("en-US", { timeZone: "Asia/Bangkok" })
  );
  const lastDay = new Date(nowBkk.getFullYear(), nowBkk.getMonth() + 1, 0).getDate();
  return lastDay - nowBkk.getDate() + 1;
}

function monthStartEnd(): { start: Date; end: Date } {
  const key = currentMonthKey();
  const start = new Date(`${key}-01T00:00:00.000Z`);
  const end = new Date(start);
  end.setMonth(end.getMonth() + 1);
  return { start, end };
}

function thaiMonthYear(): string {
  return new Date().toLocaleDateString("th-TH", {
    month: "long",
    year: "numeric",
    timeZone: "Asia/Bangkok"
  });
}

function fmtBaht(value: number): string {
  return new Intl.NumberFormat("th-TH", {
    style: "decimal",
    minimumFractionDigits: 0,
    maximumFractionDigits: 0
  }).format(value);
}

// ── Urgency ───────────────────────────────────────────────────────────────────

type Urgency = "moderate" | "urgent" | "critical";

function getUrgency(pct: number): Urgency | null {
  if (pct >= 85) return null;        // on track → no alert
  if (pct >= 70) return "moderate";  // ⚡
  if (pct >= 50) return "urgent";    // 🚨
  return "critical";                 // 🔴
}

function urgencyEmoji(level: Urgency): string {
  return level === "moderate" ? "⚡" : level === "urgent" ? "🚨" : "🔴";
}

function urgencyTitle(level: Urgency): string {
  return level === "moderate"
    ? "เตือนเป้าหมาย KPI"
    : level === "urgent"
    ? "แจ้งเตือนด่วน KPI"
    : "เร่งด่วน! KPI ต่ำมาก";
}

function motivationalMsg(level: Urgency): string {
  return level === "moderate"
    ? "💪 ยังมีเวลา เร่งมือได้เลย!"
    : level === "urgent"
    ? "🔥 ต้องเร่งด่วน! ระดมทีมตอนนี้"
    : "🆘 วิกฤต! ต้องการความช่วยเหลือทันที";
}

// ── Message builders ──────────────────────────────────────────────────────────

interface KpiProgress {
  visitDone: number;
  visitTarget: number;
  revenueDone: number;
  revenueTarget: number;
}

function buildKpiAlertMessage(opts: {
  appName: string;
  recipientName: string;
  teamName: string | null;
  monthLabel: string;
  daysLeft: number;
  progress: KpiProgress;
  urgency: Urgency;
}): string {
  const { appName, recipientName, teamName, monthLabel, daysLeft, progress, urgency } = opts;
  const emoji = urgencyEmoji(urgency);
  const title = urgencyTitle(urgency);
  const SEP = "─".repeat(30);

  const visitPct =
    progress.visitTarget > 0
      ? Math.round((progress.visitDone / progress.visitTarget) * 100)
      : 0;
  const revPct =
    progress.revenueTarget > 0
      ? Math.round((progress.revenueDone / progress.revenueTarget) * 100)
      : 0;

  const lines = [
    `${emoji} ${title}`,
    SEP,
    `👤 คุณ ${recipientName}${teamName ? ` (ทีม ${teamName})` : ""}`,
    `🗓 เดือน ${monthLabel} เหลือ ${daysLeft} วัน`,
    ``,
    `🎯 ความคืบหน้า`,
    `• เยี่ยม    : ${progress.visitDone}/${progress.visitTarget} ครั้ง (${visitPct}%)`,
    `• ยอดขาย : ฿${fmtBaht(progress.revenueDone)} / ฿${fmtBaht(progress.revenueTarget)} (${revPct}%)`,
    ``,
    motivationalMsg(urgency),
    SEP,
    `[${appName}]`
  ];
  return lines.join("\n");
}

// ── Delivery helpers ──────────────────────────────────────────────────────────

async function getLineCredential(tenantId: string): Promise<string | null> {
  const cred = await prisma.tenantIntegrationCredential.findUnique({
    where: { tenantId_platform: { tenantId, platform: IntegrationPlatform.LINE } },
    select: { apiKeyRef: true }
  });
  return cred?.apiKeyRef ?? null;
}

async function getSlackBotToken(tenantId: string): Promise<string | null> {
  const cred = await prisma.tenantIntegrationCredential.findUnique({
    where: { tenantId_platform: { tenantId, platform: IntegrationPlatform.SLACK } },
    select: { apiKeyRef: true }
  });
  return cred?.apiKeyRef ?? null;
}

interface TeamsBotCreds { appId: string; appPassword: string; tenantId: string; }

async function getTeamsBotCreds(tenantId: string): Promise<TeamsBotCreds | null> {
  const cred = await prisma.tenantIntegrationCredential.findUnique({
    where: { tenantId_platform: { tenantId, platform: IntegrationPlatform.MS_TEAMS } },
    select: { clientIdRef: true, clientSecretRef: true, webhookTokenRef: true }
  });
  if (!cred?.clientIdRef || !cred?.clientSecretRef || !cred?.webhookTokenRef) return null;
  return { appId: cred.clientIdRef, appPassword: cred.clientSecretRef, tenantId: cred.webhookTokenRef };
}

interface TeamsGraphCreds { clientId: string; clientSecret: string; tenantId: string; botAppId: string; }

async function getTeamsGraphCreds(tenantId: string): Promise<TeamsGraphCreds | null> {
  const [ms365Cred, botCred] = await Promise.all([
    prisma.tenantIntegrationCredential.findUnique({
      where: { tenantId_platform: { tenantId, platform: IntegrationPlatform.MS365 } },
      select: { clientIdRef: true, clientSecretRef: true, webhookTokenRef: true, status: true }
    }),
    prisma.tenantIntegrationCredential.findUnique({
      where: { tenantId_platform: { tenantId, platform: IntegrationPlatform.MS_TEAMS } },
      select: { clientIdRef: true, webhookTokenRef: true }
    })
  ]);
  if (!ms365Cred?.clientIdRef || !ms365Cred?.clientSecretRef) return null;
  if (ms365Cred.status !== "ENABLED") return null;
  if (!botCred?.clientIdRef) return null;
  return {
    clientId: ms365Cred.clientIdRef,
    clientSecret: ms365Cred.clientSecretRef,
    tenantId: ms365Cred.webhookTokenRef ?? botCred.webhookTokenRef ?? "",
    botAppId: botCred.clientIdRef
  };
}

async function getEmailCredential(tenantId: string) {
  const cred = await prisma.tenantIntegrationCredential.findUnique({
    where: { tenantId_platform: { tenantId, platform: IntegrationPlatform.EMAIL } },
    select: { clientIdRef: true, clientSecretRef: true, apiKeyRef: true, webhookTokenRef: true }
  });
  if (!cred?.clientIdRef || !cred.apiKeyRef || !cred.webhookTokenRef) return null;
  return {
    host: cred.clientIdRef,
    port: parseInt(cred.clientSecretRef ?? "587", 10),
    fromAddress: cred.webhookTokenRef,
    password: cred.apiKeyRef
  };
}

/** Deliver text message to ALL of a user's personal connected channels. Returns true if at least one succeeded.
 *
 *  NOTE: MS_TEAMS is intentionally skipped here. The externalUserId stored is an AAD Object ID
 *  (8:orgid:…) which is a Bot Framework user reference — you cannot POST to it as a webhook URL.
 *  Personal Teams DMs require a registered Azure Bot. Teams users receive alerts via their
 *  team's group Incoming Webhook (configured in Team Structure → Group Notifications) instead.
 */
async function deliverPersonal(opts: {
  tenantId: string;
  userId: string;
  message: string;
  appName: string;
}): Promise<boolean> {
  const { tenantId, userId, message, appName } = opts;

  const accounts = await prisma.userExternalAccount.findMany({
    where: { userId, status: "CONNECTED" }
  });

  let sent = false;

  for (const acct of accounts) {
    try {
      if (acct.provider === IntegrationPlatform.LINE) {
        const token = await getLineCredential(tenantId);
        if (!token) continue;
        const { sendLinePush } = await import("./line-notify.js");
        const r = await sendLinePush(token, acct.externalUserId, { type: "text", text: message });
        if (r.ok) sent = true;
      } else if (acct.provider === IntegrationPlatform.MS_TEAMS) {
        const { sendTeamsDmViaGraph, sendTeamsDirectMessage } = await import("./teams-notify.js");
        const meta = acct.metadata as { serviceUrl?: string; conversationId?: string; chatId?: string } | null;

        // ── Try Graph API first (avoids Bot Framework pairwise ID issues) ────
        const graphCreds = await getTeamsGraphCreds(tenantId);
        if (graphCreds) {
          const aadObjectId = acct.externalUserId.replace(/^8:orgid:/, "").replace(/^29:/, "");
          const r = await sendTeamsDmViaGraph(aadObjectId, graphCreds, message, meta?.chatId);
          if (r.ok) {
            sent = true;
            // Cache chatId for future fast-path sends
            if (r.chatId && r.chatId !== meta?.chatId) {
              await prisma.userExternalAccount.update({
                where: { id: acct.id },
                data: { metadata: { ...meta, chatId: r.chatId } }
              }).catch(e => console.warn(`[kpi-alert] Failed to cache chatId: ${e}`));
            }
            continue;
          }
          console.warn(`[kpi-alert] Graph DM failed user=${userId}: ${r.message} — trying Bot Framework`);
        }

        // ── Fallback: Bot Framework with stored convRef ──────────────────────
        const botCreds = await getTeamsBotCreds(tenantId);
        if (!botCreds) {
          console.log(`[kpi-alert] Skipping MS_TEAMS personal DM for user=${userId} — no credentials available`);
          continue;
        }
        const convRef = meta?.serviceUrl && meta?.conversationId
          ? { serviceUrl: meta.serviceUrl, conversationId: meta.conversationId }
          : undefined;
        const r = await sendTeamsDirectMessage(acct.externalUserId, botCreds, message, convRef);
        if (r.ok) sent = true;
        else console.warn(`[kpi-alert] MS_TEAMS DM failed user=${userId}: ${r.message}`);
      } else if (acct.provider === IntegrationPlatform.SLACK) {
        // Slack personal DM via Bot Token + chat.postMessage
        const slackToken = await getSlackBotToken(tenantId);
        if (!slackToken) continue;
        const r = await fetch("https://slack.com/api/chat.postMessage", {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${slackToken}` },
          body: JSON.stringify({ channel: acct.externalUserId, text: message })
        });
        const body = await r.json() as { ok: boolean };
        if (body.ok) sent = true;
      } else if (acct.provider === IntegrationPlatform.EMAIL) {
        const emailCfg = await getEmailCredential(tenantId);
        if (!emailCfg) continue;
        const { sendEmailCard } = await import("./email-notify.js");
        const r = await sendEmailCard(emailCfg, acct.externalUserId, {
          subject: `🎯 แจ้งเตือน KPI — [${appName}]`,
          title: `🎯 แจ้งเตือน KPI`,
          facts: [{ label: "ข้อมูล", value: message }],
          footer: `[${appName}]`
        });
        if (r.ok) sent = true;
      }
    } catch (err) {
      console.error(`[kpi-alert] personal delivery error user=${userId} provider=${acct.provider}:`, err);
    }
  }

  return sent;
}

/** Fallback: deliver to the user's team group channels. */
async function deliverToTeamChannelsFallback(opts: {
  tenantId: string;
  teamId: string | null;
  message: string;
  appName: string;
}): Promise<void> {
  const { tenantId, teamId, message, appName } = opts;
  if (!teamId) return;

  const channels = await prisma.teamNotificationChannel.findMany({
    where: { tenantId, teamId, isEnabled: true }
  });
  if (channels.length === 0) return;

  const lineToken = await getLineCredential(tenantId);
  const emailCfg = await getEmailCredential(tenantId);

  for (const ch of channels) {
    try {
      if (ch.channelType === ChannelType.LINE) {
        if (!lineToken) continue;
        const { sendLinePush } = await import("./line-notify.js");
        await sendLinePush(lineToken, ch.channelTarget, { type: "text", text: message });
      } else if (ch.channelType === ChannelType.MS_TEAMS) {
        const { sendTeamsCard } = await import("./teams-notify.js");
        await sendTeamsCard(ch.channelTarget, {
          title: `🎯 แจ้งเตือน KPI — [${appName}]`,
          accentColor: "warning",
          facts: [{ title: "ข้อความ", value: message }],
          footer: `[${appName}]`
        });
      } else if (ch.channelType === ChannelType.EMAIL && emailCfg) {
        const { sendEmailCard } = await import("./email-notify.js");
        await sendEmailCard(emailCfg, ch.channelTarget, {
          subject: `🎯 แจ้งเตือน KPI — [${appName}]`,
          title: `🎯 แจ้งเตือน KPI`,
          facts: [{ label: "ข้อมูล", value: message }],
          footer: `[${appName}]`
        });
      }
    } catch (err) {
      console.error(`[kpi-alert] group fallback error team=${teamId} ch=${ch.channelType}:`, err);
    }
  }
}

// ── KPI data ──────────────────────────────────────────────────────────────────

async function fetchUserKpiProgress(
  tenantId: string,
  userId: string
): Promise<KpiProgress | null> {
  const monthKey = currentMonthKey();
  const target = await prisma.salesKpiTarget.findFirst({
    where: { tenantId, userId, targetMonth: monthKey }
  });
  if (!target) return null;

  const { start, end } = monthStartEnd();

  const [visitsDone, wonDeals] = await Promise.all([
    prisma.visit.count({
      where: { tenantId, repId: userId, checkInAt: { gte: start, lt: end } }
    }),
    prisma.deal.findMany({
      where: { tenantId, ownerId: userId, status: "WON", closedAt: { gte: start, lt: end } },
      select: { estimatedValue: true }
    })
  ]);

  const revenueDone = wonDeals.reduce((s, d) => s + d.estimatedValue, 0);
  return {
    visitDone: visitsDone,
    visitTarget: target.visitTargetCount,
    revenueDone,
    revenueTarget: target.revenueTarget
  };
}

/** Overall progress pct = average of visit pct and revenue pct */
function overallPct(p: KpiProgress): number {
  const vPct = p.visitTarget > 0 ? (p.visitDone / p.visitTarget) * 100 : 100;
  const rPct = p.revenueTarget > 0 ? (p.revenueDone / p.revenueTarget) * 100 : 100;
  return Math.round((vPct + rPct) / 2);
}

// ── Main export ───────────────────────────────────────────────────────────────

/**
 * Runs the KPI alert check for ALL tenants.
 * Called daily by the scheduler; internally checks if we're in the last 5 days.
 */
export async function runKpiAlerts(): Promise<void> {
  if (!isLastFiveDaysOfMonth()) return;

  const daysLeft = daysLeftInMonth();
  const monthLabel = thaiMonthYear();
  console.log(`[kpi-alert] Running KPI alerts — ${monthLabel}, ${daysLeft} days left`);

  const tenants = await prisma.tenant.findMany({
    select: { id: true, branding: { select: { appName: true } } }
  });

  for (const tenant of tenants) {
    const appName = tenant.branding?.appName || "CRM";
    try {
      await runKpiAlertsForTenant_({ tenantId: tenant.id, appName, daysLeft, monthLabel });
    } catch (err) {
      console.error(`[kpi-alert] tenant=${tenant.id} error:`, err);
    }
  }

  console.log(`[kpi-alert] Done.`);
}

/** Per-tenant entry point — used by the dynamic scheduler. Returns a summary string.
 *  Pass { force: true } to bypass the "last 5 days of month" guard (for manual test runs). */
export async function runKpiAlertsForTenant(tenantId: string, opts?: { force?: boolean }): Promise<string> {
  if (!opts?.force && !isLastFiveDaysOfMonth()) return "Skipped — not in last 5 days of month";
  const daysLeft = daysLeftInMonth();
  const monthLabel = thaiMonthYear();
  const tenant = await prisma.tenant.findUnique({
    where: { id: tenantId },
    select: { branding: { select: { appName: true } } }
  });
  const appName = tenant?.branding?.appName || "CRM";
  await runKpiAlertsForTenant_({ tenantId, appName, daysLeft, monthLabel });
  return `KPI alerts sent for ${monthLabel}, ${daysLeft} days left`;
}

async function runKpiAlertsForTenant_(opts: {
  tenantId: string;
  appName: string;
  daysLeft: number;
  monthLabel: string;
}): Promise<void> {
  const { tenantId, appName, daysLeft, monthLabel } = opts;

  // Load all active users (all roles except ADMIN have KPI alert eligibility)
  const users = await prisma.user.findMany({
    where: { tenantId, isActive: true, role: { not: UserRole.ADMIN } },
    select: { id: true, fullName: true, role: true, teamId: true, notifPrefs: true }
  });

  for (const user of users) {
    const prefs = (user.notifPrefs as Record<string, boolean> | null) ?? {};
    // Skip if user explicitly disabled kpiAlert
    if (prefs["kpiAlert"] === false) continue;

    try {
      const progress = await fetchUserKpiProgress(tenantId, user.id);
      if (!progress) continue; // no target set → no alert

      const pct = overallPct(progress);
      const urgency = getUrgency(pct);
      if (!urgency) continue; // on track → no alert

      // Get team name for context
      let teamName: string | null = null;
      if (user.teamId) {
        const team = await prisma.team.findUnique({
          where: { id: user.teamId },
          select: { teamName: true }
        });
        teamName = team?.teamName ?? null;
      }

      const message = buildKpiAlertMessage({
        appName,
        recipientName: user.fullName,
        teamName,
        monthLabel,
        daysLeft,
        progress,
        urgency
      });

      // Try personal channel first
      const sentPersonally = await deliverPersonal({ tenantId, userId: user.id, message, appName });

      // Fallback to group channel if personal delivery failed
      if (!sentPersonally) {
        await deliverToTeamChannelsFallback({
          tenantId,
          teamId: user.teamId,
          message,
          appName
        });
      }
    } catch (err) {
      console.error(`[kpi-alert] user=${user.id} error:`, err);
    }
  }
}
