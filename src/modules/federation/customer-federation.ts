/**
 * Federated Customer Master — live-read attributes from a tenant's external
 * MySQL on every request, while the local Customer table holds only thin
 * shadow rows so existing FKs (Deal/Quotation/Visit → Customer) keep working.
 *
 * Architecture (see plans/this-session-will-talk-starry-toast.md):
 *   - The on/off toggle is `Tenant.customerFederationSourceId` — non-null
 *     means this tenant is federated and reads come from the pointed-at
 *     IntegrationSource (must be sourceType=MYSQL). Settings → Data Sync sets
 *     the pointer; the same checkbox is mirrored on the MySQL source edit form.
 *   - The IntegrationSource.configJson carries two federation-specific keys:
 *       - `keyColumn`     — MySQL column matching our Customer.externalRef
 *                           (default "external_ref" if omitted).
 *       - `customerTable` — MySQL table to live-read from
 *                           (default: query.table when in TABLE mode, else "customer").
 *   - The scheduled MYSQL pull keeps shadow rows in sync (tenant-configurable
 *     cadence, typically 1min) so newly created MySQL customers acquire a
 *     local Customer.id within ~1 min and become FK-targetable.
 *   - On read, we pass shadow rows through `hydrateCustomers()` which fetches
 *     fresh attributes from MySQL and merges them onto the shadow row.
 *
 * Failure handling:
 *   - 30s LRU cache + per-request dedup (AsyncLocalStorage) so a Customer-360
 *     page that triggers many internal customer reads only hits MySQL once.
 *   - On MySQL error: serve the stale shadow row + set
 *     `federationStatus: "stale"` on the returned object. The caller (a Fastify
 *     route) is expected to set the `X-Federation-Stale: true` response header.
 *   - Per-request timeout (3s) is enforced inside runFederatedSelect.
 *
 * Non-federated tenants pass straight through unchanged.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { EntityType, SourceType } from "@prisma/client";
import { prisma } from "../../lib/prisma.js";
import { buildMappedRecord } from "../integrations/connector-framework.js";
import { parseMysqlConfig, quoteTableName, type MysqlSourceConfig } from "../sync/mysql-pull.js";
import { getOrCreatePool, runFederatedSelect } from "./mysql-pool.js";

// ── Types ──────────────────────────────────────────────────────────────────

export type FederationStatus = "live" | "stale" | "down" | "local";

export type ShadowCustomer = {
  id: string;
  tenantId: string;
  externalRef: string | null;
  customerCode: string | null;
  name: string;
  parentCustomerId: string | null;
  customerGroupId: string | null;
  status: string;
  // Anything else the include shape returned — we don't strip it; we just
  // overlay live attributes on top.
  [key: string]: unknown;
};

export type HydratedCustomer = ShadowCustomer & {
  federationStatus: FederationStatus;
  // Live attributes copied from MySQL (raw column names, post-mapping is
  // handled by the call site via field-mapping-aware code paths if needed).
  liveAttrs?: Record<string, unknown> | null;
};

type FederationFieldMapping = {
  sourceField: string;
  targetField: string;
  transformRule: string | null;
  isRequired: boolean;
};

type FederationConfig = {
  sourceId: string;
  cfg: MysqlSourceConfig;
  // Column on the MySQL side that matches our Customer.externalRef.
  keyColumn: string;
  // Optional explicit table override. Defaults to the SOURCE's pull table.
  table: string;
  // Operator-defined column → CRM field mappings from the source's
  // IntegrationFieldMapping rows (Settings → Data Sync → Edit Mappings).
  // When non-empty, these win over the snake/camel convention in
  // `mapLiveToShadow`. Same shape that the scheduled pull uses.
  mappings: FederationFieldMapping[];
};

// ── Config resolution + caching ─────────────────────────────────────────────

const CONFIG_TTL_MS = 60_000;
type CachedConfig = { value: FederationConfig | null; expiresAt: number };
const tenantConfigCache = new Map<string, CachedConfig>();

const ATTR_TTL_MS = 30_000;
type AttrCacheEntry = { value: Record<string, unknown>; expiresAt: number };
// Keyed by `${tenantId}:${externalRef}`.
const attrCache = new Map<string, AttrCacheEntry>();

// Per-request dedup: a Customer-360 hit may resolve the same customer many
// times. AsyncLocalStorage stores a Map<extRef, Promise<row>> for the duration
// of the inbound request so the second resolver awaits the first's MySQL hit.
const requestStore = new AsyncLocalStorage<Map<string, Promise<Record<string, unknown> | null>>>();

export function withFederationRequestScope<T>(fn: () => Promise<T>): Promise<T> {
  return requestStore.run(new Map(), fn);
}

/**
 * Per-request scope entry for Fastify's `onRequest` hook. AsyncLocalStorage's
 * `enterWith` attaches the store to the current async context for the rest of
 * its lifetime — which for a Fastify request is until the response is sent.
 */
export function enterFederationRequestScope(): void {
  requestStore.enterWith(new Map());
}

export async function isFederated(tenantId: string): Promise<boolean> {
  return (await getFederationConfig(tenantId)) != null;
}

export async function getFederationConfig(tenantId: string): Promise<FederationConfig | null> {
  const cached = tenantConfigCache.get(tenantId);
  if (cached && cached.expiresAt > Date.now()) return cached.value;

  const tenant = await prisma.tenant.findUnique({
    where: { id: tenantId },
    select: { customerFederationSourceId: true }
  });
  if (!tenant?.customerFederationSourceId) {
    tenantConfigCache.set(tenantId, { value: null, expiresAt: Date.now() + CONFIG_TTL_MS });
    return null;
  }
  const source = await prisma.integrationSource.findFirst({
    where: { id: tenant.customerFederationSourceId, tenantId, sourceType: SourceType.MYSQL },
    select: {
      id: true,
      configJson: true,
      mappings: {
        where: { entityType: EntityType.CUSTOMER },
        select: { sourceField: true, targetField: true, transformRule: true, isRequired: true }
      }
    }
  });
  if (!source) {
    tenantConfigCache.set(tenantId, { value: null, expiresAt: Date.now() + CONFIG_TTL_MS });
    return null;
  }
  const cfg = parseMysqlConfig(source.configJson);
  // configJson also carries federation-specific keys we tack on outside the
  // base MysqlSourceConfig schema so we read them directly here. Operators
  // configure these on the MySQL source edit form ("Customer federation"
  // sub-section); the values are validated by sanitizeSourceConfig before
  // they hit the DB so we can interpolate them into SQL identifiers safely.
  const raw = source.configJson as Record<string, unknown>;
  const keyColumn = typeof raw.keyColumn === "string" && raw.keyColumn ? raw.keyColumn : "external_ref";
  const explicitTable = typeof raw.customerTable === "string" && raw.customerTable ? raw.customerTable : null;
  const legacyTable = typeof raw.table === "string" && raw.table ? raw.table : null;
  const table = explicitTable
    ?? (cfg.query.mode === "TABLE" ? cfg.query.table : null)
    ?? legacyTable
    ?? "customer";
  const value: FederationConfig = {
    sourceId: source.id,
    cfg,
    keyColumn,
    table,
    mappings: source.mappings
  };
  tenantConfigCache.set(tenantId, { value, expiresAt: Date.now() + CONFIG_TTL_MS });
  return value;
}

/** Test-only escape hatch: drop config + attribute caches for a tenant. */
export function clearFederationCaches(tenantId?: string): void {
  if (!tenantId) {
    tenantConfigCache.clear();
    attrCache.clear();
    return;
  }
  tenantConfigCache.delete(tenantId);
  for (const k of attrCache.keys()) {
    if (k.startsWith(`${tenantId}:`)) attrCache.delete(k);
  }
}

// ── MySQL fetch ─────────────────────────────────────────────────────────────

async function fetchOne(
  tenantId: string,
  cfg: FederationConfig,
  externalRef: string
): Promise<Record<string, unknown> | null> {
  // Per-request dedup
  const store = requestStore.getStore();
  const cacheKey = `${tenantId}:${externalRef}`;
  if (store) {
    const inflight = store.get(cacheKey);
    if (inflight) return inflight;
  }

  // 30s LRU cache
  const now = Date.now();
  const cached = attrCache.get(cacheKey);
  if (cached && cached.expiresAt > now) return cached.value;

  const promise = (async () => {
    const pool = await getOrCreatePool(cfg.sourceId, cfg.cfg);
    const sql = `SELECT * FROM ${quoteTableName(cfg.table)} WHERE \`${cfg.keyColumn.replace(/`/g, "``")}\` = ? LIMIT 1`;
    const rows = await runFederatedSelect(cfg.sourceId, pool, sql, [externalRef]);
    const row = rows[0] ?? null;
    if (row) attrCache.set(cacheKey, { value: row, expiresAt: now + ATTR_TTL_MS });
    return row;
  })();

  if (store) store.set(cacheKey, promise);
  return promise;
}

// ── Public API ──────────────────────────────────────────────────────────────

/**
 * Hydrate one or many shadow Customer rows with live MySQL attributes.
 * - Non-federated tenant → returns rows untouched with `federationStatus: "local"`.
 * - Federated, MySQL OK → overlays live attrs onto shadow + `federationStatus: "live"`.
 * - Federated, MySQL down → keeps shadow attrs + `federationStatus: "stale"`.
 *
 * Shadow rows without an `externalRef` (e.g. DRAFT customers created in our
 * UI) skip federation and stay marked `local` since they don't exist upstream.
 */
export async function hydrateCustomers<T extends ShadowCustomer | null | undefined>(
  tenantId: string,
  rows: T[]
): Promise<Array<T extends null | undefined ? T : HydratedCustomer>> {
  const cfg = await getFederationConfig(tenantId);
  if (!cfg) {
    return rows.map((r) => (r ? { ...r, federationStatus: "local" as const } : r)) as Array<T extends null | undefined ? T : HydratedCustomer>;
  }

  const out = await Promise.all(rows.map(async (r) => {
    if (!r) return r;
    if (r.status === "DRAFT" || !r.externalRef) {
      return { ...r, federationStatus: "local" as const };
    }
    try {
      const live = await fetchOne(tenantId, cfg, r.externalRef);
      if (!live) {
        // Row exists in shadow but not (any longer) in MySQL — treat as stale.
        return { ...r, federationStatus: "stale" as const, liveAttrs: null };
      }
      return { ...r, ...mapLiveToShadow(live, cfg), federationStatus: "live" as const, liveAttrs: live };
    } catch (err) {
      // Don't 500 the page on a sluggish upstream — caller will set
      // X-Federation-Stale on the response header so clients know.
      return { ...r, federationStatus: "stale" as const };
    }
  }));
  return out as unknown as Array<T extends null | undefined ? T : HydratedCustomer>;
}

export async function hydrateCustomer<T extends ShadowCustomer | null | undefined>(
  tenantId: string,
  row: T
): Promise<T extends null | undefined ? T : HydratedCustomer> {
  const [hydrated] = await hydrateCustomers(tenantId, [row]);
  return hydrated as T extends null | undefined ? T : HydratedCustomer;
}

/**
 * Search live MySQL customers by name fragment — used by the prospect-identify
 * flow so reps can pick a customer that may not be cached locally yet.
 * Returns at most `limit` matches with shape `{ externalRef, name, raw }`.
 */
export async function searchFederatedCustomers(
  tenantId: string,
  query: string,
  limit = 12
): Promise<Array<{ externalRef: string; name: string; raw: Record<string, unknown> }>> {
  const cfg = await getFederationConfig(tenantId);
  if (!cfg) return [];
  const pool = await getOrCreatePool(cfg.sourceId, cfg.cfg);
  // Prefer the operator-configured source column for `name` (Settings → Data
  // Sync → Edit Mappings) so a tenant whose customer table uses `cust_name`
  // still gets searchable. Fall back to `name` for the default convention.
  const nameColumn = cfg.mappings.find((m) => m.targetField === "name")?.sourceField || "name";
  if (!/^[A-Za-z_$][A-Za-z0-9_$]{0,63}$/.test(nameColumn)) {
    // A pathological mapping (containing SQL syntax) would break the WHERE.
    // Refuse and let the caller surface it; the breaker treats this as no result.
    return [];
  }
  const sql = `SELECT * FROM ${quoteTableName(cfg.table)} WHERE \`${nameColumn}\` LIKE ? ORDER BY \`${nameColumn}\` LIMIT ${Number(limit)}`;
  const rows = await runFederatedSelect(cfg.sourceId, pool, sql, [`%${query}%`]);
  return rows.flatMap((r) => {
    const ext = r[cfg.keyColumn];
    const rawName = r[nameColumn];
    if (typeof ext !== "string" || typeof rawName !== "string") return [];
    return [{ externalRef: ext, name: rawName, raw: r }];
  });
}

// ── Mapping helpers ─────────────────────────────────────────────────────────

/**
 * Overlay MySQL columns onto our shadow Customer shape. Two paths:
 *
 *   1. If the operator has defined explicit `IntegrationFieldMapping` rows on
 *      the federation source (Settings → Data Sync → Edit Mappings), use them
 *      via `buildMappedRecord` — same logic the scheduled pull uses, including
 *      transform chains. CRM target field names match `customerMappedSchema`
 *      (`name`, `taxId`, `branchCode`, `customerCode`, etc.).
 *   2. Otherwise fall back to a snake/camel naming convention so a tenant who
 *      hasn't configured mappings still gets sensible defaults.
 *
 * The `liveAttrs` object on the hydrated row carries raw columns for callers
 * that need to surface things this overlay doesn't (e.g. addresses).
 */
function mapLiveToShadow(live: Record<string, unknown>, cfg: FederationConfig): Partial<ShadowCustomer> {
  if (cfg.mappings.length > 0) {
    const { mapped } = buildMappedRecord(live, cfg.mappings);
    const out: Partial<ShadowCustomer> = {};
    // Only let mappings touch the shadow attributes we render — they cannot
    // overwrite `id`, `tenantId`, `parentCustomerId`, `customerGroupId` etc.
    for (const k of ["name", "taxId", "branchCode", "customerCode", "customerType", "siteLat", "siteLng"] as const) {
      if (mapped[k] !== undefined) {
        // Don't blank out the FK target's name with an empty mapped value.
        if (k === "name" && (typeof mapped[k] !== "string" || !(mapped[k] as string).trim())) continue;
        (out as Record<string, unknown>)[k] = mapped[k];
      }
    }
    return out;
  }

  // Convention fallback — works for tenants whose MySQL columns happen to
  // match our snake_case or camelCase names verbatim.
  const out: Partial<ShadowCustomer> = {};
  if (typeof live.name === "string" && live.name.trim()) out.name = live.name;
  if (typeof live.tax_id === "string") out.taxId = live.tax_id;
  if (typeof live.taxId === "string") out.taxId = live.taxId;
  if (typeof live.branch_code === "string") out.branchCode = live.branch_code;
  if (typeof live.branchCode === "string") out.branchCode = live.branchCode;
  if (typeof live.customer_code === "string") out.customerCode = live.customer_code;
  if (typeof live.customerCode === "string") out.customerCode = live.customerCode;
  return out;
}
