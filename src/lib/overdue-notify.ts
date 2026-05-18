/**
 * Overdue Reminder — daily 08:00 Asia/Bangkok ping.
 *
 * For every active rep / supervisor / manager / director with at least one
 * slipping item, we send a Thai-language LINE summary listing:
 *   - PLANNED visits whose `plannedAt` is before today's local midnight
 *     (matches the in-app "overdue" TodoBucket).
 *   - OPEN deals that are overdue on either signal:
 *       `followUpAt < now`  → tag "ติดตามค้าง"
 *       `closedAt   < now`  → tag "เลยกำหนดปิด" (closedAt on an OPEN deal
 *                              is the rep's *expected* close date,
 *                              user-editable from the Quick Update modal).
 *     A deal can carry both tags simultaneously — both are shown.
 *
 * Delivery, mirroring `kpi-alert-notify.ts`:
 *   1. Personal LINE DM via `UserExternalAccount` (provider = LINE).
 *   2. Fallback to the user's team LINE channel(s) if no personal channel.
 *   3. Additionally, post a per-team summary to each team's LINE group
 *      listing per-rep counts so supervisors see the rollup.
 *
 * Skipped:
 *   - Users with `notifPrefs.overdueReminder === false`.
 *   - Users with no overdue items (no message → no spam).
 *   - Admin users (no personal book of work).
 *
 * MS Teams / Slack / Email intentionally NOT covered in v1 — they can be
 * added later by extending the same loop, the same way `kpi-alert-notify.ts`
 * already does.
 */

import { IntegrationPlatform, UserRole } from "@prisma/client";
import { prisma } from "./prisma.js";
import { decryptCredential } from "./secrets.js";
import { fmtThaiShortDateTime, fmtBaht } from "./format.js";
import { sendLinePush } from "./line-notify.js";

// ── Time helpers ─────────────────────────────────────────────────────────────

/** Today's 00:00 in Asia/Bangkok, as a Date instance the DB can compare. */
function startOfTodayBkk(): Date {
  // Render the wall-clock date in Bangkok, then re-parse as UTC. The DB stores
  // plannedAt in UTC so a naive `new Date(year, month, 1)` would skew by the
  // server's local offset — formatting through Asia/Bangkok and back avoids that.
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Bangkok",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  });
  const parts = fmt.formatToParts(new Date()).reduce<Record<string, string>>((acc, p) => {
    acc[p.type] = p.value;
    return acc;
  }, {});
  // 00:00:00 Bangkok = (24:00 - 07:00) UTC the day before = 17:00 UTC prev day.
  // Construct as the Bangkok wall-clock midnight, expressed in UTC.
  return new Date(`${parts.year}-${parts.month}-${parts.day}T00:00:00+07:00`);
}

// ── Credential helpers (LINE-only for v1) ────────────────────────────────────

async function getLineCredential(tenantId: string): Promise<string | null> {
  const cred = decryptCredential(await prisma.tenantIntegrationCredential.findUnique({
    where: { tenantId_platform: { tenantId, platform: IntegrationPlatform.LINE } },
    select: { apiKeyRef: true }
  }));
  return cred?.apiKeyRef ?? null;
}

// ── Types ────────────────────────────────────────────────────────────────────

interface OverdueVisit {
  visitNo: string;
  plannedAt: Date;
  customerName: string | null;
}

interface OverdueDeal {
  dealNo: string;
  dealName: string;
  estimatedValue: number;
  followUpAt: Date;
  closedAt: Date | null;
  customerName: string | null;
}

interface RepOverdueBundle {
  userId: string;
  fullName: string;
  teamId: string | null;
  notifPrefs: Record<string, boolean>;
  visits: OverdueVisit[];
  deals: OverdueDeal[];
}

// ── Data ─────────────────────────────────────────────────────────────────────

async function fetchOverdueForUser(
  tenantId: string,
  userId: string,
  todayStart: Date,
  now: Date
): Promise<{ visits: OverdueVisit[]; deals: OverdueDeal[] }> {
  const [visits, deals] = await Promise.all([
    prisma.visit.findMany({
      where: {
        tenantId,
        repId: userId,
        status: "PLANNED",
        plannedAt: { lt: todayStart }
      },
      select: {
        visitNo: true,
        plannedAt: true,
        customer: { select: { name: true } }
      },
      orderBy: { plannedAt: "asc" },
      take: 20
    }),
    prisma.deal.findMany({
      where: {
        tenantId,
        ownerId: userId,
        status: "OPEN",
        // Either the next-contact date OR the expected close date has slipped.
        // Both fields are user-editable; both are independently meaningful.
        OR: [
          { followUpAt: { lt: now } },
          { closedAt:   { lt: now } }
        ]
      },
      select: {
        dealNo: true,
        dealName: true,
        estimatedValue: true,
        followUpAt: true,
        closedAt: true,
        customer: { select: { name: true } }
      },
      orderBy: { followUpAt: "asc" },
      take: 20
    })
  ]);

  return {
    visits: visits.map(v => ({
      visitNo: v.visitNo,
      plannedAt: v.plannedAt,
      customerName: v.customer?.name ?? null
    })),
    deals: deals.map(d => ({
      dealNo: d.dealNo,
      dealName: d.dealName,
      estimatedValue: d.estimatedValue,
      followUpAt: d.followUpAt,
      closedAt: d.closedAt,
      customerName: d.customer?.name ?? null
    }))
  };
}

// ── Message builders ─────────────────────────────────────────────────────────

function buildDealTags(deal: OverdueDeal, now: Date): string {
  const tags: string[] = [];
  if (deal.followUpAt < now) tags.push("ติดตามค้าง");
  if (deal.closedAt && deal.closedAt < now) tags.push("เลยกำหนดปิด");
  return tags.join(", ");
}

function buildPersonalMessage(opts: {
  appName: string;
  fullName: string;
  visits: OverdueVisit[];
  deals: OverdueDeal[];
  now: Date;
}): string {
  const { appName, fullName, visits, deals, now } = opts;
  const lines: string[] = [];
  lines.push(`🌅 สวัสดี ${fullName}`);
  lines.push("");
  lines.push(`รายการที่ค้างต้องติดตามวันนี้:`);
  lines.push("");

  if (visits.length > 0) {
    lines.push(`📋 เยี่ยมค้าง (${visits.length} รายการ):`);
    for (const v of visits) {
      const who = v.customerName ?? "—";
      lines.push(`  • ${v.visitNo} — ${who} (วางแผน ${fmtThaiShortDateTime(v.plannedAt)})`);
    }
    lines.push("");
  }

  if (deals.length > 0) {
    lines.push(`💼 ดีลค้าง (${deals.length} รายการ):`);
    for (const d of deals) {
      const who = d.customerName ?? "—";
      const tags = buildDealTags(d, now);
      const tagSuffix = tags ? ` [${tags}]` : "";
      lines.push(`  • ${d.dealNo} — ${d.dealName} — ${who} — ฿${fmtBaht(d.estimatedValue)}${tagSuffix}`);
      lines.push(`    ติดตาม ${fmtThaiShortDateTime(d.followUpAt)}${d.closedAt ? ` · ปิด ${fmtThaiShortDateTime(d.closedAt)}` : ""}`);
    }
    lines.push("");
  }

  lines.push(`[${appName}]`);
  return lines.join("\n");
}

function buildTeamSummaryMessage(opts: {
  appName: string;
  teamName: string;
  bundles: RepOverdueBundle[];
}): string {
  const { appName, teamName, bundles } = opts;
  const totalVisits = bundles.reduce((s, b) => s + b.visits.length, 0);
  const totalDeals  = bundles.reduce((s, b) => s + b.deals.length,  0);
  const lines: string[] = [];
  lines.push(`🌅 สรุปงานค้างทีม ${teamName}`);
  lines.push("");
  lines.push(`รวม: ${totalVisits} เยี่ยม · ${totalDeals} ดีล`);
  lines.push("");
  for (const b of bundles) {
    lines.push(`  • ${b.fullName}: ${b.visits.length} เยี่ยม, ${b.deals.length} ดีล`);
  }
  lines.push("");
  lines.push(`[${appName}]`);
  return lines.join("\n");
}

// ── Delivery ─────────────────────────────────────────────────────────────────

/** Try every CONNECTED LINE channel on the user; returns true if at least one succeeded. */
async function deliverPersonalLine(opts: {
  tenantId: string;
  userId: string;
  message: string;
  lineToken: string | null;
}): Promise<boolean> {
  const { tenantId, userId, message, lineToken } = opts;
  if (!lineToken) return false;

  const accounts = await prisma.userExternalAccount.findMany({
    where: { userId, status: "CONNECTED", provider: IntegrationPlatform.LINE }
  });
  if (accounts.length === 0) return false;

  let sent = false;
  for (const acct of accounts) {
    try {
      const r = await sendLinePush(lineToken, acct.externalUserId, { type: "text", text: message });
      if (r.ok) sent = true;
      else console.warn(`[overdue] LINE DM failed tenant=${tenantId} user=${userId}: ${r.message}`);
    } catch (err) {
      console.error(`[overdue] LINE DM error tenant=${tenantId} user=${userId}:`, err);
    }
  }
  return sent;
}

/** Send `message` to every enabled LINE channel on the team. */
async function deliverTeamLine(opts: {
  tenantId: string;
  teamId: string;
  message: string;
  lineToken: string | null;
}): Promise<number> {
  const { tenantId, teamId, message, lineToken } = opts;
  if (!lineToken) return 0;

  const channels = await prisma.teamNotificationChannel.findMany({
    where: { tenantId, teamId, isEnabled: true, channelType: "LINE" }
  });

  let sent = 0;
  for (const ch of channels) {
    try {
      const r = await sendLinePush(lineToken, ch.channelTarget, { type: "text", text: message });
      if (r.ok) sent++;
      else console.warn(`[overdue] team LINE push failed team=${teamId} target=${ch.channelTarget}: ${r.message}`);
    } catch (err) {
      console.error(`[overdue] team LINE push error team=${teamId}:`, err);
    }
  }
  return sent;
}

// ── Main per-tenant entry ────────────────────────────────────────────────────

/**
 * Per-tenant entry point — invoked by the dynamic scheduler via JOB_DEFS.
 * Returns a single human-readable summary string the cron run row stores.
 */
export async function runOverdueReminderForTenant(tenantId: string): Promise<string> {
  const tenant = await prisma.tenant.findUnique({
    where: { id: tenantId },
    select: { branding: { select: { appName: true } } }
  });
  const appName = tenant?.branding?.appName || "CRM";

  const now = new Date();
  const todayStart = startOfTodayBkk();

  // Eligible users — every active user except ADMIN. The role gate matches
  // kpi-alert-notify.ts: ADMINs don't carry a personal book of visits/deals,
  // so a per-rep reminder doesn't apply to them.
  const users = await prisma.user.findMany({
    where: { tenantId, isActive: true, role: { not: UserRole.ADMIN } },
    select: { id: true, fullName: true, teamId: true, notifPrefs: true }
  });

  // Bucket per team for the rollup pass; users with no team go to the loose pile.
  const teamBundles = new Map<string, RepOverdueBundle[]>();
  const looseBundles: RepOverdueBundle[] = [];

  let personalSent = 0;
  let personalFallbackSent = 0;
  let repsWithItems = 0;

  for (const user of users) {
    const prefs = (user.notifPrefs as Record<string, boolean> | null) ?? {};
    if (prefs["overdueReminder"] === false) continue;

    const { visits, deals } = await fetchOverdueForUser(tenantId, user.id, todayStart, now);
    if (visits.length === 0 && deals.length === 0) continue;

    repsWithItems++;
    const bundle: RepOverdueBundle = {
      userId: user.id,
      fullName: user.fullName,
      teamId: user.teamId,
      notifPrefs: prefs,
      visits,
      deals
    };
    if (user.teamId) {
      const arr = teamBundles.get(user.teamId) ?? [];
      arr.push(bundle);
      teamBundles.set(user.teamId, arr);
    } else {
      looseBundles.push(bundle);
    }
  }

  // Bail out early if nothing to send — saves a credential decrypt + DB read.
  if (repsWithItems === 0) {
    return `overdueReminder: 0 reps had overdue items — nothing sent`;
  }

  const lineToken = await getLineCredential(tenantId);

  // ── Per-rep DMs ──────────────────────────────────────────────────────────
  const allBundles = [...looseBundles, ...[...teamBundles.values()].flat()];
  for (const b of allBundles) {
    const personalMessage = buildPersonalMessage({
      appName,
      fullName: b.fullName,
      visits: b.visits,
      deals: b.deals,
      now
    });

    const sentPersonally = await deliverPersonalLine({
      tenantId,
      userId: b.userId,
      message: personalMessage,
      lineToken
    });
    if (sentPersonally) {
      personalSent++;
      continue;
    }

    // Fallback to the rep's team channel(s) — only if they belong to a team.
    if (b.teamId) {
      const n = await deliverTeamLine({
        tenantId,
        teamId: b.teamId,
        message: personalMessage,
        lineToken
      });
      if (n > 0) personalFallbackSent++;
    }
  }

  // ── Per-team summary (only teams with overdue work) ─────────────────────
  let teamSummariesSent = 0;
  for (const [teamId, bundles] of teamBundles) {
    if (bundles.length === 0) continue;
    const team = await prisma.team.findUnique({
      where: { id: teamId },
      select: { teamName: true }
    });
    if (!team) continue;
    const summary = buildTeamSummaryMessage({
      appName,
      teamName: team.teamName,
      bundles
    });
    const n = await deliverTeamLine({
      tenantId,
      teamId,
      message: summary,
      lineToken
    });
    if (n > 0) teamSummariesSent++;
  }

  return (
    `overdueReminder: ${repsWithItems} reps with items · ` +
    `${personalSent} personal DM, ` +
    `${personalFallbackSent} team-fallback, ` +
    `${teamSummariesSent} team summaries`
  );
}
