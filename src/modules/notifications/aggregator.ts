// Pure data layer for the in-app bell. Each function in this file is a
// "group" — it asks one question of the database and returns a uniform
// shape the route layer can serialize without knowing which question was
// asked. Keep these functions side-effect-free and tenant-scoped so they
// can be reused later from cron jobs / digests / dashboards without
// surprising the caller.
//
// Architecture note: there is no Notification table. Each group is a
// derived query over real domain state (open visits, overdue deals,
// stale prospects, etc.). The unread count is computed against a single
// per-user `notifLastSeenAt` marker — see UserNotificationState.
//
// To add a new group: write a new function here, add the kind constant
// to NOTIFICATION_KINDS, and append it to the orchestrator in routes.ts.

import {
  CustomerDuplicateStatus,
  CustomerStatus,
  DealStatus,
  JobStatus,
  ProspectStatus,
  QuotationStatus,
  SubscriptionStatus,
  UserRole,
  VisitStatus
} from "@prisma/client";
import { prisma } from "../../lib/prisma.js";

export type NotificationKind =
  | "pending_checkout"
  | "overdue_follow_ups"
  | "overdue_visits"
  | "stale_prospects"
  | "expiring_quotations"
  | "draft_customers"
  | "sync_failures"
  | "dedup_candidates"
  | "billing_alerts";

export interface PendingCheckoutItem {
  visitId: string;
  customerName: string; // includes prospect display name when no customer
  checkInAt: string;     // ISO
}

export interface NotificationGroup {
  kind: NotificationKind;
  count: number;
  unread: number;
  label: string;
  href: string | null;
  icon: string;
  // Only populated for pending_checkout — frontend renders one row per item
  // with an inline "Check out" button.
  items?: PendingCheckoutItem[];
}

interface AggregatorContext {
  tenantId: string;
  userId: string;
  role: UserRole;
  now: Date;
  lastSeenAt: Date | null;
  staleProspectAlertDays: number;
}

// ── Helpers ────────────────────────────────────────────────────────────────

const startOfToday = (now: Date): Date => {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d;
};

const isAdminTier = (role: UserRole): boolean =>
  role === UserRole.ADMIN || role === UserRole.DIRECTOR;

const isManagerTier = (role: UserRole): boolean =>
  role === UserRole.ADMIN ||
  role === UserRole.DIRECTOR ||
  role === UserRole.MANAGER ||
  role === UserRole.ASSISTANT_MANAGER;

const pluralize = (n: number, one: string, many: string): string =>
  n === 1 ? one : many;

// ── Group: pending_checkout ────────────────────────────────────────────────
// Visits the user is still checked into. Highest-priority bell item — a rep
// who left the site without checking out is the "I forgot" moment we want
// to rescue. Returns per-item rows so the frontend can render inline
// "Check out" buttons (each visit needs its own action).
export async function pendingCheckoutGroup(ctx: AggregatorContext): Promise<NotificationGroup | null> {
  const visits = await prisma.visit.findMany({
    where: {
      tenantId: ctx.tenantId,
      repId: ctx.userId,
      status: VisitStatus.CHECKED_IN
    },
    select: {
      id: true,
      checkInAt: true,
      customer: { select: { name: true } },
      prospect: { select: { displayName: true } }
    },
    orderBy: { checkInAt: "asc" }
  });
  if (visits.length === 0) return null;
  const items: PendingCheckoutItem[] = visits.map((v) => ({
    visitId: v.id,
    customerName:
      v.customer?.name ||
      v.prospect?.displayName ||
      "Unidentified site",
    checkInAt: (v.checkInAt ?? ctx.now).toISOString()
  }));
  return {
    kind: "pending_checkout",
    count: visits.length,
    // Always treat as unread — the user needs to act, not just be informed.
    unread: visits.length,
    label: `${visits.length} ${pluralize(visits.length, "visit", "visits")} pending checkout`,
    href: null,
    icon: "checkout",
    items
  };
}

// ── Group: overdue_follow_ups ──────────────────────────────────────────────
export async function overdueFollowUpsGroup(ctx: AggregatorContext): Promise<NotificationGroup | null> {
  const all = await prisma.deal.findMany({
    where: {
      tenantId: ctx.tenantId,
      ownerId: ctx.userId,
      status: DealStatus.OPEN,
      followUpAt: { lt: ctx.now }
    },
    select: { followUpAt: true }
  });
  if (all.length === 0) return null;
  const unread = ctx.lastSeenAt
    ? all.filter((d) => d.followUpAt > ctx.lastSeenAt!).length
    : all.length;
  return {
    kind: "overdue_follow_ups",
    count: all.length,
    unread,
    label: `${all.length} ${pluralize(all.length, "deal", "deals")} with overdue follow-up`,
    href: "/deals?filter=overdue-mine",
    icon: "deal"
  };
}

// ── Group: overdue_visits ──────────────────────────────────────────────────
// PLANNED visits whose date passed without check-in. Distinct from
// pending_checkout (where check-in already happened, checkout is missing).
export async function overdueVisitsGroup(ctx: AggregatorContext): Promise<NotificationGroup | null> {
  const cutoff = startOfToday(ctx.now);
  const all = await prisma.visit.findMany({
    where: {
      tenantId: ctx.tenantId,
      repId: ctx.userId,
      status: VisitStatus.PLANNED,
      plannedAt: { lt: cutoff }
    },
    select: { plannedAt: true }
  });
  if (all.length === 0) return null;
  const unread = ctx.lastSeenAt
    ? all.filter((v) => v.plannedAt > ctx.lastSeenAt!).length
    : all.length;
  return {
    kind: "overdue_visits",
    count: all.length,
    unread,
    label: `${all.length} planned ${pluralize(all.length, "visit", "visits")} overdue`,
    href: "/visits?filter=overdue-mine",
    icon: "visit"
  };
}

// ── Group: stale_prospects ─────────────────────────────────────────────────
// UNIDENTIFIED prospects you created that have been sitting >N days. Mirrors
// the digest at src/lib/digest-notify.ts but scoped to this user, not team.
export async function staleProspectsGroup(ctx: AggregatorContext): Promise<NotificationGroup | null> {
  const cutoff = new Date(
    ctx.now.getTime() - ctx.staleProspectAlertDays * 24 * 60 * 60 * 1000
  );
  const all = await prisma.prospect.findMany({
    where: {
      tenantId: ctx.tenantId,
      createdById: ctx.userId,
      status: ProspectStatus.UNIDENTIFIED,
      archivedAt: null,
      createdAt: { lt: cutoff }
    },
    select: { createdAt: true }
  });
  if (all.length === 0) return null;
  const unread = ctx.lastSeenAt
    ? all.filter((p) => p.createdAt > ctx.lastSeenAt!).length
    : all.length;
  return {
    kind: "stale_prospects",
    count: all.length,
    unread,
    label: `${all.length} stale ${pluralize(all.length, "prospect", "prospects")} (>${ctx.staleProspectAlertDays}d)`,
    href: "/prospects?filter=stale-mine",
    icon: "prospect"
  };
}

// ── Group: expiring_quotations ─────────────────────────────────────────────
// Quotations on your open deals whose validTo is within the next 7 days
// (and not already past validTo or in a terminal status).
const EXPIRING_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
export async function expiringQuotationsGroup(ctx: AggregatorContext): Promise<NotificationGroup | null> {
  const horizon = new Date(ctx.now.getTime() + EXPIRING_WINDOW_MS);
  const all = await prisma.quotation.findMany({
    where: {
      tenantId: ctx.tenantId,
      validTo: { gte: ctx.now, lte: horizon },
      status: { notIn: [QuotationStatus.EXPIRED, QuotationStatus.CANCELED, QuotationStatus.REJECTED] },
      deal: { ownerId: ctx.userId, status: DealStatus.OPEN }
    },
    select: { updatedAt: true }
  });
  if (all.length === 0) return null;
  const unread = ctx.lastSeenAt
    ? all.filter((q) => q.updatedAt > ctx.lastSeenAt!).length
    : all.length;
  return {
    kind: "expiring_quotations",
    count: all.length,
    unread,
    label: `${all.length} ${pluralize(all.length, "quotation", "quotations")} expiring within 7 days`,
    href: "/deals?filter=expiring-quotations",
    icon: "quotation"
  };
}

// ── Group: draft_customers (manager+) ──────────────────────────────────────
export async function draftCustomersGroup(ctx: AggregatorContext): Promise<NotificationGroup | null> {
  if (!isManagerTier(ctx.role)) return null;
  const all = await prisma.customer.findMany({
    where: {
      tenantId: ctx.tenantId,
      status: CustomerStatus.DRAFT
    },
    select: { createdAt: true }
  });
  if (all.length === 0) return null;
  const unread = ctx.lastSeenAt
    ? all.filter((c) => c.createdAt > ctx.lastSeenAt!).length
    : all.length;
  return {
    kind: "draft_customers",
    count: all.length,
    unread,
    label: `${all.length} draft ${pluralize(all.length, "customer", "customers")} awaiting promote`,
    href: "/customers?filter=drafts",
    icon: "customer"
  };
}

// ── Group: sync_failures (admin) ───────────────────────────────────────────
const SYNC_FAILURE_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
export async function syncFailuresGroup(ctx: AggregatorContext): Promise<NotificationGroup | null> {
  if (!isAdminTier(ctx.role)) return null;
  const cutoff = new Date(ctx.now.getTime() - SYNC_FAILURE_WINDOW_MS);
  const all = await prisma.integrationSyncJob.findMany({
    where: {
      tenantId: ctx.tenantId,
      status: JobStatus.FAILED,
      startedAt: { gte: cutoff }
    },
    select: { startedAt: true }
  });
  if (all.length === 0) return null;
  const unread = ctx.lastSeenAt
    ? all.filter((j) => j.startedAt > ctx.lastSeenAt!).length
    : all.length;
  return {
    kind: "sync_failures",
    count: all.length,
    unread,
    label: `${all.length} sync ${pluralize(all.length, "job", "jobs")} failed in last 7 days`,
    href: "/settings/data-sync",
    icon: "sync-error"
  };
}

// ── Group: dedup_candidates (admin) ────────────────────────────────────────
export async function dedupCandidatesGroup(ctx: AggregatorContext): Promise<NotificationGroup | null> {
  if (!isAdminTier(ctx.role)) return null;
  const all = await prisma.customerDuplicateCandidate.findMany({
    where: {
      tenantId: ctx.tenantId,
      status: CustomerDuplicateStatus.OPEN
    },
    select: { createdAt: true }
  });
  if (all.length === 0) return null;
  const unread = ctx.lastSeenAt
    ? all.filter((c) => c.createdAt > ctx.lastSeenAt!).length
    : all.length;
  return {
    kind: "dedup_candidates",
    count: all.length,
    unread,
    label: `${all.length} new duplicate-customer ${pluralize(all.length, "candidate", "candidates")}`,
    href: "/customers/dedup",
    icon: "merge"
  };
}

// ── Group: billing_alerts (admin) ──────────────────────────────────────────
const TRIAL_WARNING_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
export async function billingAlertsGroup(ctx: AggregatorContext): Promise<NotificationGroup | null> {
  if (!isAdminTier(ctx.role)) return null;
  const trialHorizon = new Date(ctx.now.getTime() + TRIAL_WARNING_WINDOW_MS);
  const subs = await prisma.subscription.findMany({
    where: {
      tenantId: ctx.tenantId,
      OR: [
        { status: SubscriptionStatus.PAST_DUE },
        { status: SubscriptionStatus.TRIALING, trialEndsAt: { lte: trialHorizon } }
      ]
    },
    select: { status: true, trialEndsAt: true, updatedAt: true }
  });
  if (subs.length === 0) return null;
  // Always render as unread because billing requires attention even if it's
  // been pending for days.
  const label =
    subs.some((s) => s.status === SubscriptionStatus.PAST_DUE)
      ? "Billing past due"
      : "Trial ending within 7 days";
  return {
    kind: "billing_alerts",
    count: subs.length,
    unread: subs.length,
    label,
    href: "/settings/company",
    icon: "billing"
  };
}
