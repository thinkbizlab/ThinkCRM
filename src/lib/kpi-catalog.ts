/**
 * KPI Catalog — system-defined list of metrics any tenant can opt in to track.
 *
 * Each entry knows:
 *   - `key`             stable enum-like identifier stored in
 *                       `TenantKpiMetricConfig.metricKey` and
 *                       `SalesKpiTargetMetric.metricKey`.
 *   - default labels    Thai + English, used when the tenant hasn't set
 *                       a custom label on `TenantKpiMetricConfig`.
 *   - `unit`            drives the formatter at the UI / alert layer
 *                       (count → "12", currency → "฿1,234,567",
 *                       percent → "85%", minutes → "45 min").
 *   - `direction`       higher_is_better → alert when actual < target;
 *                       lower_is_better → alert when actual > target.
 *                       v1 only ships higher_is_better metrics but the
 *                       field is in place so future LOWER_IS_BETTER
 *                       metrics (e.g. AVG_RESPONSE_HOURS) don't need a
 *                       breaking change.
 *   - `group`           admin UI section header.
 *   - `compute()`       returns the rep's actual value for that metric
 *                       in the supplied month window. ONE Prisma query
 *                       per metric, so the dashboard's N-metric loop
 *                       stays N round-trips and parallelisable.
 *
 * Adding a new metric is a one-file change: append an entry below. No
 * schema migration, no UI change — the admin page reads this catalog
 * at render time and any tenant can opt the new metric in.
 */

import type { PrismaClient } from "@prisma/client";
import { prisma } from "./prisma.js";

export type KpiUnit = "count" | "currency" | "percent" | "minutes";
export type KpiDirection = "higher_is_better" | "lower_is_better";
export type KpiGroup = "activity" | "deals" | "quotations" | "prospects" | "customers";

export interface KpiComputeOpts {
  tenantId: string;
  userId: string;
  monthStart: Date;
  monthEnd: Date;   // exclusive upper bound
}

export interface KpiCatalogEntry {
  key: string;
  defaultLabelTh: string;
  defaultLabelEn: string;
  unit: KpiUnit;
  direction: KpiDirection;
  group: KpiGroup;
  /** Single Prisma read returning the rep's actual value for the month. */
  compute: (db: PrismaClient, opts: KpiComputeOpts) => Promise<number>;
}

// Type alias the function signatures so each entry stays a one-liner.
type Db = PrismaClient;

// ─── Activity ─────────────────────────────────────────────────────────────

const VISIT_PLANNED_COUNT: KpiCatalogEntry = {
  key: "VISIT_PLANNED_COUNT",
  defaultLabelTh: "เยี่ยมที่วางแผน",
  defaultLabelEn: "Planned visits",
  unit: "count",
  direction: "higher_is_better",
  group: "activity",
  compute: async (db, { tenantId, userId, monthStart, monthEnd }) =>
    db.visit.count({
      where: {
        tenantId,
        repId: userId,
        createdAt: { gte: monthStart, lt: monthEnd },
        status: "PLANNED"
      }
    })
};

const VISIT_CHECKED_IN_COUNT: KpiCatalogEntry = {
  key: "VISIT_CHECKED_IN_COUNT",
  defaultLabelTh: "จำนวนการเช็คอินเยี่ยม",
  defaultLabelEn: "Visits checked in",
  unit: "count",
  direction: "higher_is_better",
  group: "activity",
  // Mirrors the historical kpi-alert-notify computation — counts every visit
  // whose `checkInAt` falls in the month, regardless of whether it ended up
  // being checked out. This is the "VISIT_COUNT" that all existing tenants
  // are seeded with so their dashboards keep showing identical numbers.
  compute: async (db, { tenantId, userId, monthStart, monthEnd }) =>
    db.visit.count({
      where: {
        tenantId,
        repId: userId,
        checkInAt: { gte: monthStart, lt: monthEnd }
      }
    })
};

const VISIT_COMPLETED_COUNT: KpiCatalogEntry = {
  key: "VISIT_COMPLETED_COUNT",
  defaultLabelTh: "เยี่ยมเสร็จสมบูรณ์",
  defaultLabelEn: "Completed visits",
  unit: "count",
  direction: "higher_is_better",
  group: "activity",
  compute: async (db, { tenantId, userId, monthStart, monthEnd }) =>
    db.visit.count({
      where: {
        tenantId,
        repId: userId,
        checkOutAt: { gte: monthStart, lt: monthEnd }
      }
    })
};

const UNPLANNED_VISIT_COUNT: KpiCatalogEntry = {
  key: "UNPLANNED_VISIT_COUNT",
  defaultLabelTh: "เยี่ยมไม่ได้วางแผน (drop-in)",
  defaultLabelEn: "Unplanned drop-in visits",
  unit: "count",
  direction: "higher_is_better",
  group: "activity",
  compute: async (db, { tenantId, userId, monthStart, monthEnd }) =>
    db.visit.count({
      where: {
        tenantId,
        repId: userId,
        visitType: "UNPLANNED",
        checkInAt: { gte: monthStart, lt: monthEnd }
      }
    })
};

const UNIQUE_CUSTOMERS_VISITED: KpiCatalogEntry = {
  key: "UNIQUE_CUSTOMERS_VISITED",
  defaultLabelTh: "ลูกค้าที่ได้เข้าพบ (ไม่นับซ้ำ)",
  defaultLabelEn: "Unique customers visited",
  unit: "count",
  direction: "higher_is_better",
  group: "activity",
  // Prisma's `distinct` is supported on findMany but not on count, so we have
  // to issue a select and inspect length. The set is bounded by the month so
  // this is still O(rep-visits-this-month) — typically <50 rows.
  compute: async (db, { tenantId, userId, monthStart, monthEnd }) => {
    const rows = await db.visit.findMany({
      where: {
        tenantId,
        repId: userId,
        checkInAt: { gte: monthStart, lt: monthEnd },
        customerId: { not: null }
      },
      distinct: ["customerId"],
      select: { customerId: true }
    });
    return rows.length;
  }
};

// ─── Deals ────────────────────────────────────────────────────────────────

const NEW_DEAL_COUNT: KpiCatalogEntry = {
  key: "NEW_DEAL_COUNT",
  defaultLabelTh: "จำนวนดีลที่เปิดใหม่",
  defaultLabelEn: "New deals opened",
  unit: "count",
  direction: "higher_is_better",
  group: "deals",
  compute: async (db, { tenantId, userId, monthStart, monthEnd }) =>
    db.deal.count({
      where: {
        tenantId,
        ownerId: userId,
        createdAt: { gte: monthStart, lt: monthEnd }
      }
    })
};

const NEW_DEAL_VALUE: KpiCatalogEntry = {
  key: "NEW_DEAL_VALUE",
  defaultLabelTh: "มูลค่าดีลใหม่",
  defaultLabelEn: "New deal value",
  unit: "currency",
  direction: "higher_is_better",
  group: "deals",
  compute: async (db, { tenantId, userId, monthStart, monthEnd }) => {
    const agg = await db.deal.aggregate({
      where: {
        tenantId,
        ownerId: userId,
        createdAt: { gte: monthStart, lt: monthEnd }
      },
      _sum: { estimatedValue: true }
    });
    return agg._sum.estimatedValue ?? 0;
  }
};

const WON_DEAL_COUNT: KpiCatalogEntry = {
  key: "WON_DEAL_COUNT",
  defaultLabelTh: "จำนวนดีลที่ปิดได้",
  defaultLabelEn: "Won deals",
  unit: "count",
  direction: "higher_is_better",
  group: "deals",
  compute: async (db, { tenantId, userId, monthStart, monthEnd }) =>
    db.deal.count({
      where: {
        tenantId,
        ownerId: userId,
        status: "WON",
        closedAt: { gte: monthStart, lt: monthEnd }
      }
    })
};

const WON_DEAL_VALUE: KpiCatalogEntry = {
  key: "WON_DEAL_VALUE",
  defaultLabelTh: "ยอดขาย (ดีลที่ปิดได้)",
  defaultLabelEn: "Won deal value",
  unit: "currency",
  direction: "higher_is_better",
  group: "deals",
  compute: async (db, { tenantId, userId, monthStart, monthEnd }) => {
    const agg = await db.deal.aggregate({
      where: {
        tenantId,
        ownerId: userId,
        status: "WON",
        closedAt: { gte: monthStart, lt: monthEnd }
      },
      _sum: { estimatedValue: true }
    });
    return agg._sum.estimatedValue ?? 0;
  }
};

const LOST_DEAL_COUNT: KpiCatalogEntry = {
  key: "LOST_DEAL_COUNT",
  defaultLabelTh: "จำนวนดีลที่เสีย",
  defaultLabelEn: "Lost deals",
  unit: "count",
  direction: "higher_is_better",
  group: "deals",
  // Counter-intuitive that higher LOST is "better" — it isn't, but until we
  // wire a real lower_is_better path through alerts/UI we leave this as a
  // pure activity metric (informational; no alert).
  compute: async (db, { tenantId, userId, monthStart, monthEnd }) =>
    db.deal.count({
      where: {
        tenantId,
        ownerId: userId,
        status: "LOST",
        closedAt: { gte: monthStart, lt: monthEnd }
      }
    })
};

const WIN_RATE_PCT: KpiCatalogEntry = {
  key: "WIN_RATE_PCT",
  defaultLabelTh: "อัตราการปิดดีล (%)",
  defaultLabelEn: "Win rate",
  unit: "percent",
  direction: "higher_is_better",
  group: "deals",
  compute: async (db, opts) => {
    const [won, lost] = await Promise.all([
      WON_DEAL_COUNT.compute(db, opts),
      LOST_DEAL_COUNT.compute(db, opts)
    ]);
    const denom = won + lost;
    return denom > 0 ? (won / denom) * 100 : 0;
  }
};

const AVG_DEAL_VALUE_WON: KpiCatalogEntry = {
  key: "AVG_DEAL_VALUE_WON",
  defaultLabelTh: "มูลค่าเฉลี่ยต่อดีล",
  defaultLabelEn: "Avg won deal value",
  unit: "currency",
  direction: "higher_is_better",
  group: "deals",
  compute: async (db, { tenantId, userId, monthStart, monthEnd }) => {
    const agg = await db.deal.aggregate({
      where: {
        tenantId,
        ownerId: userId,
        status: "WON",
        closedAt: { gte: monthStart, lt: monthEnd }
      },
      _avg: { estimatedValue: true }
    });
    return agg._avg.estimatedValue ?? 0;
  }
};

const PIPELINE_PROGRESS_UPDATES: KpiCatalogEntry = {
  key: "PIPELINE_PROGRESS_UPDATES",
  defaultLabelTh: "บันทึกความคืบหน้าดีล",
  defaultLabelEn: "Deal progress updates",
  unit: "count",
  direction: "higher_is_better",
  group: "deals",
  compute: async (db, { userId, monthStart, monthEnd }) =>
    db.dealProgressUpdate.count({
      where: {
        createdById: userId,
        createdAt: { gte: monthStart, lt: monthEnd }
      }
    })
};

// ─── Quotations ───────────────────────────────────────────────────────────

const QUOTATION_SENT_COUNT: KpiCatalogEntry = {
  key: "QUOTATION_SENT_COUNT",
  defaultLabelTh: "ใบเสนอราคาที่ส่งแล้ว",
  defaultLabelEn: "Quotations sent",
  unit: "count",
  direction: "higher_is_better",
  group: "quotations",
  // Quotation has no ownerId — we attribute via the parent Deal's owner.
  compute: async (db, { tenantId, userId, monthStart, monthEnd }) =>
    db.quotation.count({
      where: {
        tenantId,
        status: "SENT",
        createdAt: { gte: monthStart, lt: monthEnd },
        deal: { ownerId: userId }
      }
    })
};

const QUOTATION_SENT_VALUE: KpiCatalogEntry = {
  key: "QUOTATION_SENT_VALUE",
  defaultLabelTh: "มูลค่าใบเสนอราคา (ส่งแล้ว)",
  defaultLabelEn: "Quotation sent value",
  unit: "currency",
  direction: "higher_is_better",
  group: "quotations",
  compute: async (db, { tenantId, userId, monthStart, monthEnd }) => {
    const agg = await db.quotation.aggregate({
      where: {
        tenantId,
        status: "SENT",
        createdAt: { gte: monthStart, lt: monthEnd },
        deal: { ownerId: userId }
      },
      _sum: { grandTotal: true }
    });
    return agg._sum.grandTotal ?? 0;
  }
};

const QUOTATION_ACCEPTED_COUNT: KpiCatalogEntry = {
  key: "QUOTATION_ACCEPTED_COUNT",
  defaultLabelTh: "ใบเสนอราคาที่ลูกค้าตอบรับ",
  defaultLabelEn: "Quotations accepted",
  unit: "count",
  direction: "higher_is_better",
  group: "quotations",
  // Quotation status enum has APPROVED, not "ACCEPTED" — see schema.
  compute: async (db, { tenantId, userId, monthStart, monthEnd }) =>
    db.quotation.count({
      where: {
        tenantId,
        status: "APPROVED",
        updatedAt: { gte: monthStart, lt: monthEnd },
        deal: { ownerId: userId }
      }
    })
};

const QUOTATION_ACCEPTED_VALUE: KpiCatalogEntry = {
  key: "QUOTATION_ACCEPTED_VALUE",
  defaultLabelTh: "มูลค่าใบเสนอราคาที่ตอบรับ",
  defaultLabelEn: "Quotation accepted value",
  unit: "currency",
  direction: "higher_is_better",
  group: "quotations",
  compute: async (db, { tenantId, userId, monthStart, monthEnd }) => {
    const agg = await db.quotation.aggregate({
      where: {
        tenantId,
        status: "APPROVED",
        updatedAt: { gte: monthStart, lt: monthEnd },
        deal: { ownerId: userId }
      },
      _sum: { grandTotal: true }
    });
    return agg._sum.grandTotal ?? 0;
  }
};

const QUOTATION_CONVERSION_RATE_PCT: KpiCatalogEntry = {
  key: "QUOTATION_CONVERSION_RATE_PCT",
  defaultLabelTh: "อัตราตอบรับใบเสนอราคา (%)",
  defaultLabelEn: "Quotation conversion rate",
  unit: "percent",
  direction: "higher_is_better",
  group: "quotations",
  compute: async (db, { tenantId, userId, monthStart, monthEnd }) => {
    const [accepted, decided] = await Promise.all([
      db.quotation.count({
        where: {
          tenantId,
          status: "APPROVED",
          updatedAt: { gte: monthStart, lt: monthEnd },
          deal: { ownerId: userId }
        }
      }),
      db.quotation.count({
        where: {
          tenantId,
          status: { in: ["APPROVED", "REJECTED", "EXPIRED"] },
          updatedAt: { gte: monthStart, lt: monthEnd },
          deal: { ownerId: userId }
        }
      })
    ]);
    return decided > 0 ? (accepted / decided) * 100 : 0;
  }
};

// ─── Prospects ────────────────────────────────────────────────────────────

const PROSPECT_CREATED_COUNT: KpiCatalogEntry = {
  key: "PROSPECT_CREATED_COUNT",
  defaultLabelTh: "ลูกค้าใหม่ที่บันทึก (Prospect)",
  defaultLabelEn: "Prospects created",
  unit: "count",
  direction: "higher_is_better",
  group: "prospects",
  compute: async (db, { tenantId, userId, monthStart, monthEnd }) =>
    db.prospect.count({
      where: {
        tenantId,
        createdById: userId,
        createdAt: { gte: monthStart, lt: monthEnd }
      }
    })
};

const PROSPECT_LINKED_COUNT: KpiCatalogEntry = {
  key: "PROSPECT_LINKED_COUNT",
  defaultLabelTh: "Prospect ที่เชื่อมเป็นลูกค้า",
  defaultLabelEn: "Prospects linked to customers",
  unit: "count",
  direction: "higher_is_better",
  group: "prospects",
  // "Linked" prospects = those whose status went to LINKED in this month and
  // whose updatedById is this user (the rep who completed the identification).
  compute: async (db, { tenantId, userId, monthStart, monthEnd }) =>
    db.prospect.count({
      where: {
        tenantId,
        status: "LINKED",
        updatedById: userId,
        updatedAt: { gte: monthStart, lt: monthEnd }
      }
    })
};

// ─── Customers ────────────────────────────────────────────────────────────

const CUSTOMER_CREATED_COUNT: KpiCatalogEntry = {
  key: "CUSTOMER_CREATED_COUNT",
  defaultLabelTh: "ลูกค้าใหม่ที่ลงทะเบียน",
  defaultLabelEn: "Customers created",
  unit: "count",
  direction: "higher_is_better",
  group: "customers",
  compute: async (db, { tenantId, userId, monthStart, monthEnd }) =>
    db.customer.count({
      where: {
        tenantId,
        createdByUserId: userId,
        createdAt: { gte: monthStart, lt: monthEnd }
      }
    })
};

// ─── Registry ─────────────────────────────────────────────────────────────

/**
 * The order here is the default `sortOrder` used when a new tenant first opts
 * into a metric (the seed migration explicitly orders the three legacy
 * metrics, but newly-enabled metrics inherit from this list).
 */
export const KPI_CATALOG: readonly KpiCatalogEntry[] = Object.freeze([
  // activity
  VISIT_PLANNED_COUNT,
  VISIT_CHECKED_IN_COUNT,
  VISIT_COMPLETED_COUNT,
  UNPLANNED_VISIT_COUNT,
  UNIQUE_CUSTOMERS_VISITED,
  // deals
  NEW_DEAL_COUNT,
  NEW_DEAL_VALUE,
  WON_DEAL_COUNT,
  WON_DEAL_VALUE,
  LOST_DEAL_COUNT,
  WIN_RATE_PCT,
  AVG_DEAL_VALUE_WON,
  PIPELINE_PROGRESS_UPDATES,
  // quotations
  QUOTATION_SENT_COUNT,
  QUOTATION_SENT_VALUE,
  QUOTATION_ACCEPTED_COUNT,
  QUOTATION_ACCEPTED_VALUE,
  QUOTATION_CONVERSION_RATE_PCT,
  // prospects
  PROSPECT_CREATED_COUNT,
  PROSPECT_LINKED_COUNT,
  // customers
  CUSTOMER_CREATED_COUNT
]);

const CATALOG_BY_KEY: ReadonlyMap<string, KpiCatalogEntry> = new Map(
  KPI_CATALOG.map((entry) => [entry.key, entry])
);

export function getKpiCatalogEntry(key: string): KpiCatalogEntry | undefined {
  return CATALOG_BY_KEY.get(key);
}

/** True if `key` is a metric this build's catalog knows how to compute. */
export function isKnownKpiMetric(key: string): boolean {
  return CATALOG_BY_KEY.has(key);
}

// ─── Helpers ──────────────────────────────────────────────────────────────

/** Bangkok-anchored start/end (exclusive) of the calendar month `monthKey` ("YYYY-MM"). */
export function monthWindow(monthKey: string): { monthStart: Date; monthEnd: Date } {
  const [yearStr, monthStr] = monthKey.split("-");
  const year = Number(yearStr);
  const month = Number(monthStr); // 1-12
  // Anchor in Asia/Bangkok so a month boundary at 00:00 Bangkok stays
  // consistent regardless of where the cron container is running.
  const monthStart = new Date(`${yearStr}-${monthStr}-01T00:00:00+07:00`);
  const nextYear  = month === 12 ? year + 1 : year;
  const nextMonth = month === 12 ? 1 : month + 1;
  const monthEnd  = new Date(
    `${nextYear}-${String(nextMonth).padStart(2, "0")}-01T00:00:00+07:00`
  );
  return { monthStart, monthEnd };
}

/** Resolve a tenant's active metric configuration, merging catalog defaults
 *  with tenant overrides. Returned in tenant-specified `sortOrder`. */
export async function loadTenantKpiConfig(
  tenantId: string,
  db: PrismaClient = prisma
): Promise<Array<{
  entry: KpiCatalogEntry;
  labelTh: string;
  labelEn: string;
  sortOrder: number;
  alertThreshold: number;
}>> {
  const rows = await db.tenantKpiMetricConfig.findMany({
    where: { tenantId, isActive: true },
    orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }]
  });
  const out: Array<{
    entry: KpiCatalogEntry;
    labelTh: string;
    labelEn: string;
    sortOrder: number;
    alertThreshold: number;
  }> = [];
  for (const row of rows) {
    const entry = CATALOG_BY_KEY.get(row.metricKey);
    if (!entry) continue; // metric retired from catalog — silently drop
    out.push({
      entry,
      labelTh: row.labelTh ?? entry.defaultLabelTh,
      labelEn: row.labelEn ?? entry.defaultLabelEn,
      sortOrder: row.sortOrder,
      alertThreshold: row.alertThreshold ?? 85
    });
  }
  return out;
}
