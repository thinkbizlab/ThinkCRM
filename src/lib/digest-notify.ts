/**
 * Weekly Digest — builds and delivers Thai-language team digest messages.
 *
 * Schedule: Every Monday at 06:00 Asia/Bangkok
 * Delivery:  Team group notification channels (LINE / Teams / Email) configured
 *            in Team Structure.
 *
 * Sales Rep message   → sent to the rep's team group channel(s)
 * Manager / Supervisor / Director message → team aggregate, sent per-team
 */

import { ChannelType, IntegrationPlatform, UserRole } from "@prisma/client";
import { prisma } from "./prisma.js";

// ── Date helpers ─────────────────────────────────────────────────────────────

/** Returns the Monday of the previous week (Bangkok local date). */
function prevWeekRange(): { from: Date; to: Date; label: string } {
  const nowBkk = new Date(
    new Date().toLocaleString("en-US", { timeZone: "Asia/Bangkok" })
  );
  const dayOfWeek = nowBkk.getDay(); // 0=Sun, 1=Mon…
  // Days since last Monday (today is Monday → 7 days back)
  const daysToLastMon = dayOfWeek === 1 ? 7 : (dayOfWeek + 6) % 7;
  const lastMon = new Date(nowBkk);
  lastMon.setDate(nowBkk.getDate() - daysToLastMon);
  lastMon.setHours(0, 0, 0, 0);

  const lastSun = new Date(lastMon);
  lastSun.setDate(lastMon.getDate() + 6);
  lastSun.setHours(23, 59, 59, 999);

  const fmt = (d: Date) =>
    d.toLocaleDateString("th-TH", {
      day: "2-digit",
      month: "2-digit",
      year: "numeric",
      timeZone: "Asia/Bangkok"
    });

  return { from: lastMon, to: lastSun, label: `${fmt(lastMon)} – ${fmt(lastSun)}` };
}

function thaiMonthShort(date: Date): string {
  return date.toLocaleDateString("th-TH", {
    month: "long",
    year: "numeric",
    timeZone: "Asia/Bangkok"
  });
}

function fmtBaht(value: number): string {
  return new Intl.NumberFormat("th-TH", { style: "decimal", minimumFractionDigits: 0, maximumFractionDigits: 0 }).format(value);
}

// ── Message builders ──────────────────────────────────────────────────────────

interface RepWeekStats {
  repName: string;
  checkins: number;     // visits checked in during the week
  planned: number;      // visits in PLANNED status during the week
  wonCount: number;
  wonValue: number;
  lostCount: number;
  overdueFollowUps: number;
  // KPI (current month) — null means no target set
  kpi: {
    visitDone: number;
    visitTarget: number;
    revenueDone: number;
    revenueTarget: number;
  } | null;
}

function buildRepDigestMessage(opts: {
  appName: string;
  weekLabel: string;
  stats: RepWeekStats;
}): string {
  const { stats, weekLabel, appName } = opts;
  const SEP = "─".repeat(30);

  const lines: string[] = [
    `📊 สรุปผลงานประจำสัปดาห์`,
    SEP,
    `🗓 ${weekLabel}`,
    `👤 คุณ ${stats.repName}`,
    ``,
    `📍 การเยี่ยมลูกค้า`,
    `• เช็คอิน    : ${stats.checkins} ครั้ง`,
    `• นัดหมาย   : ${stats.planned} ครั้ง`,
    ``,
    `💼 ดีลที่ปิด`,
    `• 🎉 ชนะ : ${stats.wonCount} ดีล${stats.wonCount > 0 ? ` (฿${fmtBaht(stats.wonValue)})` : ""}`,
    `• ❌ แพ้  : ${stats.lostCount} ดีล`,
  ];

  if (stats.overdueFollowUps > 0) {
    lines.push(``, `📌 ดีลค้างติดตาม : ${stats.overdueFollowUps} ดีล`);
  }

  if (stats.kpi) {
    const { visitDone, visitTarget, revenueDone, revenueTarget } = stats.kpi;
    const visitPct = visitTarget > 0 ? Math.round((visitDone / visitTarget) * 100) : 0;
    const revPct = revenueTarget > 0 ? Math.round((revenueDone / revenueTarget) * 100) : 0;
    lines.push(
      ``,
      `🎯 ความคืบหน้าเดือนนี้`,
      `• เยี่ยม    : ${visitDone}/${visitTarget} ครั้ง (${visitPct}%)`,
      `• ยอดขาย : ฿${fmtBaht(revenueDone)} / ฿${fmtBaht(revenueTarget)} (${revPct}%)`
    );
  }

  lines.push(SEP, `[${appName}]`);
  return lines.join("\n");
}

interface TeamWeekStats {
  teamName: string;
  totalCheckins: number;
  totalPlanned: number;
  wonCount: number;
  wonValue: number;
  lostCount: number;
  repRanking: { repName: string; checkins: number }[];
}

function buildTeamDigestMessage(opts: {
  appName: string;
  weekLabel: string;
  stats: TeamWeekStats;
}): string {
  const { stats, weekLabel, appName } = opts;
  const SEP = "─".repeat(30);

  const ranking = stats.repRanking
    .filter(r => r.checkins > 0)
    .sort((a, b) => b.checkins - a.checkins)
    .slice(0, 5);

  const rankingLines =
    ranking.length > 0
      ? ranking.map((r, i) => `${i + 1}. ${r.repName} – ${r.checkins} ครั้ง`).join("\n")
      : "ยังไม่มีข้อมูลสัปดาห์นี้";

  return [
    `📊 สรุปทีม ${stats.teamName} ประจำสัปดาห์`,
    SEP,
    `🗓 ${weekLabel}`,
    ``,
    `📍 ภาพรวมการเยี่ยมลูกค้า`,
    `• เช็คอิน    : ${stats.totalCheckins} ครั้ง`,
    `• นัดหมาย   : ${stats.totalPlanned} ครั้ง`,
    ``,
    `💼 ดีลทีม`,
    `• 🎉 ชนะ : ${stats.wonCount} ดีล${stats.wonCount > 0 ? ` (฿${fmtBaht(stats.wonValue)})` : ""}`,
    `• ❌ แพ้  : ${stats.lostCount} ดีล`,
    ``,
    `🏆 อันดับการเยี่ยมประจำสัปดาห์`,
    rankingLines,
    SEP,
    `[${appName}]`
  ].join("\n");
}

// ── Data queries ──────────────────────────────────────────────────────────────

async function fetchRepStats(
  tenantId: string,
  repId: string,
  from: Date,
  to: Date
): Promise<Omit<RepWeekStats, "repName">> {
  const [visits, deals, followUps, kpiTarget] = await Promise.all([
    // Visits during the week
    prisma.visit.findMany({
      where: {
        tenantId,
        repId,
        OR: [
          { checkInAt: { gte: from, lte: to } },
          { plannedAt: { gte: from, lte: to } }
        ]
      },
      select: { status: true, checkInAt: true, plannedAt: true }
    }),

    // Deals closed during the week
    prisma.deal.findMany({
      where: {
        tenantId,
        ownerId: repId,
        closedAt: { gte: from, lte: to },
        status: { in: ["WON", "LOST"] }
      },
      select: { status: true, estimatedValue: true }
    }),

    // Overdue follow-ups (followUpAt in the past, still OPEN)
    prisma.deal.count({
      where: {
        tenantId,
        ownerId: repId,
        status: "OPEN",
        followUpAt: { lt: to }
      }
    }),

    // KPI target for current month
    prisma.salesKpiTarget.findFirst({
      where: {
        tenantId,
        userId: repId,
        targetMonth: new Date().toISOString().slice(0, 7) // YYYY-MM
      }
    })
  ]);

  const checkins = visits.filter(v => v.checkInAt && v.checkInAt >= from && v.checkInAt <= to).length;
  const planned = visits.filter(v => v.status === "PLANNED" && v.plannedAt >= from && v.plannedAt <= to).length;

  const wonDeals = deals.filter(d => d.status === "WON");
  const lostDeals = deals.filter(d => d.status === "LOST");
  const wonValue = wonDeals.reduce((sum, d) => sum + d.estimatedValue, 0);

  // Current month visit count for KPI progress
  let kpi: RepWeekStats["kpi"] = null;
  if (kpiTarget) {
    const monthStart = new Date(new Date().toISOString().slice(0, 7) + "-01T00:00:00.000Z");
    const monthEnd = new Date(monthStart);
    monthEnd.setMonth(monthEnd.getMonth() + 1);

    const [monthVisits, wonThisMonth] = await Promise.all([
      prisma.visit.count({
        where: { tenantId, repId, checkInAt: { gte: monthStart, lt: monthEnd } }
      }),
      prisma.deal.findMany({
        where: {
          tenantId,
          ownerId: repId,
          status: "WON",
          closedAt: { gte: monthStart, lt: monthEnd }
        },
        select: { estimatedValue: true }
      })
    ]);

    const revenueDone = wonThisMonth.reduce((sum, d) => sum + d.estimatedValue, 0);
    kpi = {
      visitDone: monthVisits,
      visitTarget: kpiTarget.visitTargetCount,
      revenueDone,
      revenueTarget: kpiTarget.revenueTarget
    };
  }

  return {
    checkins,
    planned,
    wonCount: wonDeals.length,
    wonValue,
    lostCount: lostDeals.length,
    overdueFollowUps: followUps,
    kpi
  };
}

// ── Delivery helpers ──────────────────────────────────────────────────────────

async function deliverToTeamChannels(opts: {
  tenantId: string;
  teamId: string;
  message: string;
  appName: string;
}): Promise<void> {
  const { tenantId, teamId, message, appName } = opts;

  const channels = await prisma.teamNotificationChannel.findMany({
    where: { tenantId, teamId, isEnabled: true }
  });
  if (channels.length === 0) return;

  const [lineCredential, emailCredential] = await Promise.all([
    prisma.tenantIntegrationCredential.findUnique({
      where: { tenantId_platform: { tenantId, platform: IntegrationPlatform.LINE } },
      select: { apiKeyRef: true }
    }),
    prisma.tenantIntegrationCredential.findUnique({
      where: { tenantId_platform: { tenantId, platform: IntegrationPlatform.EMAIL } },
      select: { clientIdRef: true, clientSecretRef: true, apiKeyRef: true, webhookTokenRef: true }
    })
  ]);

  for (const ch of channels) {
    try {
      if (ch.channelType === ChannelType.LINE) {
        if (!lineCredential?.apiKeyRef) continue;
        const { sendLinePush } = await import("./line-notify.js");
        await sendLinePush(lineCredential.apiKeyRef, ch.channelTarget, { type: "text", text: message });
      } else if (ch.channelType === ChannelType.MS_TEAMS) {
        const { sendTeamsCard } = await import("./teams-notify.js");
        await sendTeamsCard(ch.channelTarget, {
          title: `📊 สรุปทีมประจำสัปดาห์ — [${appName}]`,
          accentColor: "accent",
          facts: [{ title: "ข้อความ", value: message }],
          footer: `[${appName}]`
        });
      } else if (ch.channelType === ChannelType.EMAIL) {
        if (!emailCredential?.clientIdRef || !emailCredential?.apiKeyRef || !emailCredential?.webhookTokenRef) continue;
        const { sendEmailCard } = await import("./email-notify.js");
        const emailConfig = {
          host: emailCredential.clientIdRef,
          port: parseInt(emailCredential.clientSecretRef ?? "587", 10),
          fromAddress: emailCredential.webhookTokenRef,
          password: emailCredential.apiKeyRef
        };
        await sendEmailCard(emailConfig, ch.channelTarget, {
          subject: `📊 สรุปทีมประจำสัปดาห์ — [${appName}]`,
          title: `📊 สรุปทีมประจำสัปดาห์`,
          facts: [{ label: "ข้อมูล", value: message }],
          footer: `[${appName}]`
        });
      }
    } catch (err) {
      console.error(`[digest] delivery error team=${teamId} channel=${ch.channelType}:`, err);
    }
  }
}

// ── Main export ───────────────────────────────────────────────────────────────

/**
 * Runs the weekly digest for ALL tenants.
 * Called by the cron scheduler every Monday at 06:00 Bangkok.
 */
export async function runWeeklyDigest(): Promise<void> {
  const { from, to, label } = prevWeekRange();
  console.log(`[digest] Running weekly digest for week ${label}`);

  const tenants = await prisma.tenant.findMany({
    select: { id: true, branding: { select: { appName: true } } }
  });

  for (const tenant of tenants) {
    const appName = tenant.branding?.appName || "CRM";
    try {
      await runDigestForTenant({ tenantId: tenant.id, appName, from, to, weekLabel: label });
    } catch (err) {
      console.error(`[digest] tenant=${tenant.id} error:`, err);
    }
  }

  console.log(`[digest] Weekly digest complete.`);
}

/** Per-tenant entry point — used by the dynamic scheduler. Returns a summary string. */
export async function runWeeklyDigestForTenant(tenantId: string): Promise<string> {
  const { from, to, label } = prevWeekRange();
  const tenant = await prisma.tenant.findUnique({
    where: { id: tenantId },
    select: { branding: { select: { appName: true } } }
  });
  const appName = tenant?.branding?.appName || "CRM";
  await runDigestForTenant({ tenantId, appName, from, to, weekLabel: label });
  return `Weekly digest delivered for week ${label}`;
}

async function runDigestForTenant(opts: {
  tenantId: string;
  appName: string;
  from: Date;
  to: Date;
  weekLabel: string;
}): Promise<void> {
  const { tenantId, appName, from, to, weekLabel } = opts;

  // Load all teams with their channels and members
  const teams = await prisma.team.findMany({
    where: { tenantId, isActive: true },
    include: {
      channels: { where: { isEnabled: true } },
      users: {
        where: { isActive: true },
        select: { id: true, fullName: true, role: true, notifPrefs: true }
      }
    }
  });

  for (const team of teams) {
    if (team.channels.length === 0) continue;

    const reps = team.users.filter(u => u.role === UserRole.REP);

    // ── Team aggregate message for managers/supervisors/directors ────────────
    // Sent to the group channel if ANY manager-tier member has weeklyDigest enabled
    // (or if not explicitly disabled — default true for managers)
    const managerRoles: UserRole[] = [UserRole.MANAGER, UserRole.SUPERVISOR, UserRole.DIRECTOR, UserRole.ADMIN];
    const managerUsers = team.users.filter(u => managerRoles.includes(u.role));
    const teamDigestEnabled = managerUsers.length > 0
      ? managerUsers.some(u => {
          const prefs = (u.notifPrefs as Record<string, boolean> | null) ?? {};
          return prefs["weeklyDigest"] !== false; // default on
        })
      : false;

    if (teamDigestEnabled && reps.length > 0) {
      // Build team stats
      const repStats = await Promise.all(
        reps.map(async rep => ({
          repName: rep.fullName,
          ...(await fetchRepStats(tenantId, rep.id, from, to))
        }))
      );

      const teamStats: TeamWeekStats = {
        teamName: team.teamName,
        totalCheckins: repStats.reduce((s, r) => s + r.checkins, 0),
        totalPlanned: repStats.reduce((s, r) => s + r.planned, 0),
        wonCount: repStats.reduce((s, r) => s + r.wonCount, 0),
        wonValue: repStats.reduce((s, r) => s + r.wonValue, 0),
        lostCount: repStats.reduce((s, r) => s + r.lostCount, 0),
        repRanking: repStats.map(r => ({ repName: r.repName, checkins: r.checkins }))
      };

      const teamMsg = buildTeamDigestMessage({ appName, weekLabel, stats: teamStats });
      await deliverToTeamChannels({ tenantId, teamId: team.id, message: teamMsg, appName });
    }

    // ── Individual rep digest sent to group channel ───────────────────────────
    // Each rep whose weeklyDigest pref is not explicitly false gets their digest
    // sent to the team group channel (not personal channel) per spec.
    for (const rep of reps) {
      const prefs = (rep.notifPrefs as Record<string, boolean> | null) ?? {};
      if (prefs["weeklyDigest"] === false) continue;

      const stats = await fetchRepStats(tenantId, rep.id, from, to);
      const repMsg = buildRepDigestMessage({
        appName,
        weekLabel,
        stats: { repName: rep.fullName, ...stats }
      });
      await deliverToTeamChannels({ tenantId, teamId: team.id, message: repMsg, appName });
    }
  }
}
