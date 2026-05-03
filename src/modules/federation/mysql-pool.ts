/**
 * Per-tenant MySQL connection pool for federated Customer reads.
 *
 * The scheduled MYSQL pull (mysql-pull.ts) opens a fresh connection per run.
 * That's fine for an hourly batch but unworkable for live reads on every
 * Customer-360 page hit — each connect handshake adds 50-200ms. So this module
 * caches a `mysql2.createPool()` per `IntegrationSource.id` and reuses it.
 *
 * Read-only enforcement layered on top of the pool:
 *   - SELECT-only validator from mysql-pull is reused by callers.
 *   - Every query opens `START TRANSACTION READ ONLY` and COMMITs.
 *   - `multipleStatements: false` to block stacked-statement injection.
 *   - Per-query timeout caps both connect + query phases.
 *
 * Pools are evicted from the in-process map when the IntegrationSource config
 * changes (callers must call `evictPool(sourceId)` on PATCH /sources/:id).
 */

import { decryptField } from "../../lib/secrets.js";
import type { MysqlSourceConfig } from "../sync/mysql-pull.js";

type Mysql2Pool = {
  query: (sql: string, values?: unknown[]) => Promise<[unknown, unknown]>;
  getConnection: () => Promise<Mysql2PoolConnection>;
  end: () => Promise<void>;
};

type Mysql2PoolConnection = {
  query: (sql: string, values?: unknown[]) => Promise<[unknown, unknown]>;
  release: () => void;
};

// Per-(source × Vercel-function-instance) connection cap. Multiplied by the
// number of concurrent Vercel instances + the scheduled pull's own connection,
// this is the total load on the upstream MySQL. Lowered from 5 to 2 after
// observing "Too many connections" rejections from a tenant's ERPNext during
// high-concurrency federation reads — small ERP servers commonly cap at
// ~50 connections, and 5×N instances + sync overhead can exhaust that.
const POOL_CONNECTION_LIMIT = 2;
const POOL_IDLE_TIMEOUT_MS = 30_000;
// Live reads need to fail fast — never block a UI request for >3s on a sluggish
// upstream. The scheduled pull keeps its own (longer) defaults.
const LIVE_CONNECT_TIMEOUT_MS = 2_000;
const LIVE_QUERY_TIMEOUT_MS = 3_000;

// Circuit breaker — when the upstream MySQL is flapping, stop hammering it for
// 30s. Callers see thrown errors which `hydrateCustomers` already catches and
// converts to `federationStatus: "stale"` (shadow row served, header set).
const CIRCUIT_FAILURE_THRESHOLD = 5;
const CIRCUIT_FAILURE_WINDOW_MS = 60_000;
const CIRCUIT_OPEN_DURATION_MS = 30_000;

type BreakerState = {
  failureTimestamps: number[];
  openedUntil: number;
};
const breakers = new Map<string, BreakerState>();

const pools = new Map<string, Mysql2Pool>();

function getBreaker(sourceId: string): BreakerState {
  let s = breakers.get(sourceId);
  if (!s) {
    s = { failureTimestamps: [], openedUntil: 0 };
    breakers.set(sourceId, s);
  }
  return s;
}

function isCircuitOpen(sourceId: string): boolean {
  return getBreaker(sourceId).openedUntil > Date.now();
}

function recordFailure(sourceId: string): void {
  const s = getBreaker(sourceId);
  const now = Date.now();
  s.failureTimestamps = s.failureTimestamps.filter((t) => now - t < CIRCUIT_FAILURE_WINDOW_MS);
  s.failureTimestamps.push(now);
  if (s.failureTimestamps.length >= CIRCUIT_FAILURE_THRESHOLD) {
    s.openedUntil = now + CIRCUIT_OPEN_DURATION_MS;
    s.failureTimestamps = [];
  }
}

function recordSuccess(sourceId: string): void {
  const s = getBreaker(sourceId);
  s.failureTimestamps = [];
  s.openedUntil = 0;
}

async function createPool(cfg: MysqlSourceConfig): Promise<Mysql2Pool> {
  const mod = await import("mysql2/promise");
  const password = decryptField(cfg.passwordEnc);
  if (password == null) {
    throw new Error("Federation MySQL password could not be decrypted.");
  }

  const sslOption = (() => {
    if (cfg.ssl.mode === "DISABLED") return undefined;
    if (cfg.ssl.mode === "VERIFY_CA") {
      const ca = decryptField(cfg.ssl.caPemEnc);
      if (!ca) throw new Error("VERIFY_CA mode requires a decryptable CA PEM.");
      return { ca, rejectUnauthorized: true };
    }
    return { rejectUnauthorized: false };
  })();

  return mod.createPool({
    host: cfg.host,
    port: cfg.port,
    database: cfg.database,
    user: cfg.user,
    password,
    ssl: sslOption,
    connectTimeout: LIVE_CONNECT_TIMEOUT_MS,
    multipleStatements: false,
    dateStrings: false,
    decimalNumbers: true,
    supportBigNumbers: true,
    bigNumberStrings: true,
    waitForConnections: true,
    connectionLimit: POOL_CONNECTION_LIMIT,
    idleTimeout: POOL_IDLE_TIMEOUT_MS,
    queueLimit: 0
  }) as unknown as Mysql2Pool;
}

export async function getOrCreatePool(sourceId: string, cfg: MysqlSourceConfig): Promise<Mysql2Pool> {
  if (isCircuitOpen(sourceId)) {
    throw new Error(`Federation circuit open for source ${sourceId}; refusing new connections for now.`);
  }
  const existing = pools.get(sourceId);
  if (existing) return existing;
  const pool = await createPool(cfg);
  pools.set(sourceId, pool);
  return pool;
}

export async function evictPool(sourceId: string): Promise<void> {
  const pool = pools.get(sourceId);
  if (!pool) return;
  pools.delete(sourceId);
  try { await pool.end(); } catch { /* swallow */ }
}

export function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => {
      reject(new Error(`${label} exceeded ${ms}ms timeout.`));
    }, ms);
    p.then(
      (v) => { clearTimeout(t); resolve(v); },
      (e) => { clearTimeout(t); reject(e); }
    );
  });
}

/**
 * Run `sql` (with optional bound values) inside a READ ONLY transaction on a
 * pooled connection. Always releases the connection back to the pool.
 *
 * Tracks success/failure against the per-source circuit breaker so a flapping
 * upstream MySQL doesn't get hammered for the next 30s.
 */
export async function runFederatedSelect(
  sourceId: string,
  pool: Mysql2Pool,
  sql: string,
  values?: unknown[]
): Promise<Record<string, unknown>[]> {
  try {
    const conn = await withTimeout(pool.getConnection(), LIVE_CONNECT_TIMEOUT_MS, "Federation MySQL connection");
    try {
      await conn.query("START TRANSACTION READ ONLY");
      try {
        const queryPromise = conn.query(sql, values).then(([rows]) => rows);
        const rows = await withTimeout(queryPromise, LIVE_QUERY_TIMEOUT_MS, "Federation MySQL query");
        if (!Array.isArray(rows)) {
          throw new Error("Federation MySQL did not return a row set (was the statement a SELECT?).");
        }
        const normalised = (rows as unknown[])
          .filter((r): r is Record<string, unknown> => r != null && typeof r === "object")
          .map(normaliseRow);
        recordSuccess(sourceId);
        return normalised;
      } finally {
        await conn.query("COMMIT").catch(() => { /* swallow — connection may already be dead */ });
      }
    } finally {
      conn.release();
    }
  } catch (err) {
    recordFailure(sourceId);
    throw err;
  }
}

function normaliseRow(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) {
    if (v == null) { out[k] = null; continue; }
    if (v instanceof Date) { out[k] = v.toISOString(); continue; }
    if (Buffer.isBuffer(v)) { out[k] = v.toString("utf8"); continue; }
    out[k] = v;
  }
  return out;
}
