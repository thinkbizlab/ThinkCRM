/**
 * Direct MySQL pull executor.
 *
 * A tenant configures an IntegrationSource with sourceType=MYSQL; configJson
 * shape: see `MysqlSourceConfig` below. Connection password (and optional TLS
 * CA PEM) are encrypted via `encryptField` (ENCRYPTION_KEY) — plaintext in dev.
 *
 * The executor opens a TLS connection to the client's MySQL, opens a
 * READ-ONLY transaction, runs the configured SELECT, then hands the rows
 * off to `executeConnectorRun` — which already owns mapping + upsert + job
 * history. So a scheduled MySQL pull lands in the same sync-job list as
 * an xlsx import or REST pull.
 *
 * Read-only enforcement is layered:
 *   1. Recommend a SELECT-only DB user (in setup docs / inline help).
 *   2. Every query runs inside `START TRANSACTION READ ONLY` — MySQL rejects
 *      writes at the protocol level even if the user has write privileges.
 *   3. SQL-mode statements are tokenised and rejected unless they're a
 *      single SELECT / WITH … SELECT.
 *   4. mysql2 is used with `multipleStatements: false` (default) so an
 *      injected `;` cannot smuggle a second statement.
 *   5. Table-mode synthesises the SELECT itself; admin only supplies a
 *      table name + optional WHERE / ORDER BY.
 */

import { EntityType, JobStatus, RunType, SourceType } from "@prisma/client";
import { prisma } from "../../lib/prisma.js";
import { decryptField } from "../../lib/secrets.js";
import {
  executeConnectorRun,
  processConnectorChunk,
  type ConnectorRunResult
} from "../integrations/connector-framework.js";
import { expandTemplate, parseSchedule, type SyncSchedule } from "./rest-pull.js";

type SslMode = "DISABLED" | "REQUIRED" | "VERIFY_CA";

type MysqlQueryConfig =
  | { mode: "TABLE"; table: string; where?: string; orderBy?: string }
  | { mode: "SQL"; sql: string };

export type MysqlSourceConfig = {
  entityType: EntityType;
  host: string;
  port: number;
  database: string;
  user: string;
  passwordEnc: string;
  ssl: { mode: SslMode; caPemEnc?: string };
  connectTimeoutMs: number;
  queryTimeoutMs: number;
  rowLimit: number;
  /** Per-chunk LIMIT used by the resumable drain. Defaults to 1000. */
  chunkSize: number;
  schedule: SyncSchedule;
  query: MysqlQueryConfig;
};

const ROW_LIMIT_DEFAULT = 50_000;
const ROW_LIMIT_MAX = 500_000;
const CHUNK_SIZE_DEFAULT = 1000;
const CHUNK_SIZE_MIN = 100;
const CHUNK_SIZE_MAX = 10_000;
const CONNECT_TIMEOUT_DEFAULT = 10_000;
const QUERY_TIMEOUT_DEFAULT = 60_000;
const QUERY_TIMEOUT_MAX = 5 * 60_000;

// MySQL identifier rules: letters, digits, _, $; up to 64 chars. We also accept
// `schema.table` so the admin can fully qualify. No backticks (we add them).
const TABLE_IDENT_RE = /^[A-Za-z_$][A-Za-z0-9_$]{0,63}(?:\.[A-Za-z_$][A-Za-z0-9_$]{0,63})?$/;

// Words that must never appear as bare keywords in a SELECT-only statement.
// Matched as whole tokens after string/comment stripping (case-insensitive).
const FORBIDDEN_KEYWORDS = new Set([
  "INSERT", "UPDATE", "DELETE", "REPLACE", "TRUNCATE",
  "DROP", "ALTER", "CREATE", "GRANT", "REVOKE", "RENAME",
  "LOAD", "HANDLER", "CALL", "SET", "LOCK", "UNLOCK",
  "PREPARE", "EXECUTE", "DEALLOCATE", "KILL"
]);

/** Strip /* ... *\/, -- ... \n, # ... \n comments and 'string' / "string" literals. */
function stripStringsAndComments(sql: string): string {
  let out = "";
  let i = 0;
  while (i < sql.length) {
    const ch = sql[i];
    const next = sql[i + 1];
    if (ch === "/" && next === "*") {
      const end = sql.indexOf("*/", i + 2);
      i = end < 0 ? sql.length : end + 2;
      out += " ";
      continue;
    }
    if (ch === "-" && next === "-") {
      const end = sql.indexOf("\n", i + 2);
      i = end < 0 ? sql.length : end + 1;
      out += " ";
      continue;
    }
    if (ch === "#") {
      const end = sql.indexOf("\n", i + 1);
      i = end < 0 ? sql.length : end + 1;
      out += " ";
      continue;
    }
    if (ch === "'" || ch === '"' || ch === "`") {
      const quote = ch;
      i++;
      while (i < sql.length) {
        if (sql[i] === "\\") { i += 2; continue; }
        if (sql[i] === quote) { i++; break; }
        i++;
      }
      out += " ";
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}

/**
 * Throws if `sql` is not a single SELECT (or `WITH … SELECT`).
 * Comment- and literal-aware so `SELECT 'INSERT something'` is fine.
 */
export function validateSelectStatement(sql: string): void {
  const trimmed = sql.trim();
  if (!trimmed) throw new Error("SQL statement is empty.");
  if (trimmed.length > 20_000) throw new Error("SQL statement is too long (max 20000 characters).");

  const stripped = stripStringsAndComments(trimmed).trim();
  if (!stripped) throw new Error("SQL statement is empty after stripping comments.");

  // Trailing semicolon is fine; an internal one is not (we ban multi-statements).
  const noTrailingSemi = stripped.replace(/;+\s*$/, "");
  if (noTrailingSemi.includes(";")) {
    throw new Error("SQL must contain a single statement (no inner ';').");
  }

  const head = noTrailingSemi.toUpperCase();
  const startsWithSelect = /^SELECT\b/.test(head);
  const startsWithWith = /^WITH\b/.test(head) && /\bSELECT\b/.test(head);
  const startsWithLeadingParen = /^\(\s*SELECT\b/.test(head);
  if (!startsWithSelect && !startsWithWith && !startsWithLeadingParen) {
    throw new Error("Only SELECT or WITH … SELECT statements are allowed.");
  }

  for (const tok of head.split(/[^A-Z0-9_]+/)) {
    if (FORBIDDEN_KEYWORDS.has(tok)) {
      throw new Error(`Forbidden keyword in SQL: ${tok}.`);
    }
  }
}

export function parseMysqlConfig(raw: unknown): MysqlSourceConfig {
  if (!raw || typeof raw !== "object") throw new Error("MySQL source configJson is missing.");
  const o = raw as Record<string, unknown>;

  const entityType = typeof o.entityType === "string" ? o.entityType : "";
  if (!(entityType in EntityType)) throw new Error(`MySQL source entityType "${entityType}" is invalid.`);

  const host = typeof o.host === "string" ? o.host.trim() : "";
  if (!host) throw new Error("MySQL host is not configured.");
  if (!/^[A-Za-z0-9._-]+$/.test(host)) throw new Error("MySQL host contains invalid characters.");

  const port = typeof o.port === "number" ? o.port : parseInt(String(o.port ?? 3306), 10);
  if (!Number.isFinite(port) || port < 1 || port > 65535) {
    throw new Error("MySQL port must be between 1 and 65535.");
  }

  const database = typeof o.database === "string" ? o.database.trim() : "";
  if (!database) throw new Error("MySQL database is not configured.");

  const user = typeof o.user === "string" ? o.user.trim() : "";
  if (!user) throw new Error("MySQL user is not configured.");

  const passwordEnc = typeof o.passwordEnc === "string" ? o.passwordEnc : "";
  if (!passwordEnc) throw new Error("MySQL password is not configured.");

  // SSL: default REQUIRED (TLS without CA verification — fine for first cut,
  // VERIFY_CA upgrades it). DISABLED only as an explicit opt-out.
  const sslRaw = (o.ssl ?? {}) as Record<string, unknown>;
  const sslModeRaw = typeof sslRaw.mode === "string" ? sslRaw.mode.toUpperCase() : "REQUIRED";
  const sslMode: SslMode = sslModeRaw === "DISABLED" || sslModeRaw === "VERIFY_CA" ? sslModeRaw : "REQUIRED";
  const caPemEnc = typeof sslRaw.caPemEnc === "string" ? sslRaw.caPemEnc : undefined;
  if (sslMode === "VERIFY_CA" && !caPemEnc) {
    throw new Error("VERIFY_CA mode requires a CA certificate (caPemEnc).");
  }

  const connectTimeoutMs = clampInt(o.connectTimeoutMs, CONNECT_TIMEOUT_DEFAULT, 1000, 60_000);
  const queryTimeoutMs   = clampInt(o.queryTimeoutMs,   QUERY_TIMEOUT_DEFAULT,   1000, QUERY_TIMEOUT_MAX);
  const rowLimit         = clampInt(o.rowLimit,         ROW_LIMIT_DEFAULT,       1,    ROW_LIMIT_MAX);
  const chunkSize        = clampInt(o.chunkSize,        CHUNK_SIZE_DEFAULT,      CHUNK_SIZE_MIN, CHUNK_SIZE_MAX);

  const schedule = parseSchedule(o.schedule);
  const query = parseQueryConfig(o.query);

  return {
    entityType: entityType as EntityType,
    host,
    port,
    database,
    user,
    passwordEnc,
    ssl: { mode: sslMode, caPemEnc },
    connectTimeoutMs,
    queryTimeoutMs,
    rowLimit,
    chunkSize,
    schedule,
    query
  };
}

function clampInt(v: unknown, defaultV: number, min: number, max: number): number {
  const n = typeof v === "number" ? v : parseInt(String(v ?? ""), 10);
  if (!Number.isFinite(n)) return defaultV;
  return Math.max(min, Math.min(max, Math.trunc(n)));
}

function parseQueryConfig(raw: unknown): MysqlQueryConfig {
  if (!raw || typeof raw !== "object") {
    throw new Error("MySQL query is not configured (need mode=TABLE or mode=SQL).");
  }
  const q = raw as Record<string, unknown>;
  const mode = typeof q.mode === "string" ? q.mode.toUpperCase() : "";
  if (mode === "TABLE") {
    const table = typeof q.table === "string" ? q.table.trim() : "";
    if (!TABLE_IDENT_RE.test(table)) throw new Error("Table name is invalid (letters, digits, _ , $ only; up to 64 chars; optional schema.table).");
    const where = typeof q.where === "string" ? q.where.trim() : undefined;
    const orderBy = typeof q.orderBy === "string" ? q.orderBy.trim() : undefined;
    return { mode: "TABLE", table, where: where || undefined, orderBy: orderBy || undefined };
  }
  if (mode === "SQL") {
    const sql = typeof q.sql === "string" ? q.sql : "";
    validateSelectStatement(sql);
    return { mode: "SQL", sql };
  }
  throw new Error(`MySQL query mode "${mode}" is invalid (must be TABLE or SQL).`);
}

/** Quote a single identifier or `schema.table` with backticks. Each segment
 *  is already validated by `TABLE_IDENT_RE`, so embedded backticks are impossible. */
export function quoteTableName(table: string): string {
  return table.split(".").map(seg => `\`${seg}\``).join(".");
}

export function buildTableModeSql(cfg: MysqlSourceConfig, now: Date = new Date()): string {
  if (cfg.query.mode !== "TABLE") throw new Error("buildTableModeSql called on non-TABLE config.");
  const q = cfg.query;
  const parts: string[] = [`SELECT * FROM ${quoteTableName(q.table)}`];
  if (q.where) parts.push(`WHERE ${expandTemplate(q.where, now)}`);
  if (q.orderBy) parts.push(`ORDER BY ${expandTemplate(q.orderBy, now)}`);
  parts.push(`LIMIT ${cfg.rowLimit}`);
  return parts.join(" ");
}

export function buildSqlModeSql(cfg: MysqlSourceConfig, now: Date = new Date()): string {
  if (cfg.query.mode !== "SQL") throw new Error("buildSqlModeSql called on non-SQL config.");
  const expanded = expandTemplate(cfg.query.sql, now);
  // Re-validate after template expansion in case a template smuggles a forbidden token.
  validateSelectStatement(expanded);
  return expanded;
}

function buildPreparedSql(cfg: MysqlSourceConfig, now: Date = new Date()): string {
  return cfg.query.mode === "TABLE" ? buildTableModeSql(cfg, now) : buildSqlModeSql(cfg, now);
}

// ── Connection ──────────────────────────────────────────────────────────────

type Mysql2Connection = {
  query: (sql: string) => Promise<[unknown, unknown]>;
  end: () => Promise<void>;
};

async function connect(cfg: MysqlSourceConfig): Promise<Mysql2Connection> {
  const { createConnection } = await import("mysql2/promise");
  const password = decryptField(cfg.passwordEnc);
  if (password == null) throw new Error("MySQL password could not be decrypted.");

  const sslOption = (() => {
    if (cfg.ssl.mode === "DISABLED") return undefined;
    if (cfg.ssl.mode === "VERIFY_CA") {
      const ca = decryptField(cfg.ssl.caPemEnc);
      if (!ca) throw new Error("VERIFY_CA mode requires a decryptable CA PEM.");
      return { ca, rejectUnauthorized: true };
    }
    return { rejectUnauthorized: false };
  })();

  return createConnection({
    host: cfg.host,
    port: cfg.port,
    database: cfg.database,
    user: cfg.user,
    password,
    ssl: sslOption,
    connectTimeout: cfg.connectTimeoutMs,
    multipleStatements: false,
    dateStrings: false,
    decimalNumbers: true,
    supportBigNumbers: true,
    bigNumberStrings: true
  }) as unknown as Promise<Mysql2Connection>;
}

/** Convert mysql2 row values into JSON-friendly primitives the connector framework expects. */
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

/** Run `sql` inside a READ ONLY transaction with a hard query timeout. */
async function runReadOnlyQuery(
  conn: Mysql2Connection,
  sql: string,
  queryTimeoutMs: number
): Promise<Record<string, unknown>[]> {
  await conn.query("START TRANSACTION READ ONLY");
  try {
    // mysql2's query() doesn't accept a per-query timeout in the simple form,
    // so we race it against a manual timer that drops the connection on expiry.
    const queryPromise = conn.query(sql).then(([rows]) => rows);
    const rows = await withTimeout(queryPromise, queryTimeoutMs, () => {
      conn.end().catch(() => {});
      throw new Error(`MySQL query exceeded queryTimeoutMs (${queryTimeoutMs}ms).`);
    });
    if (!Array.isArray(rows)) throw new Error("MySQL did not return a row set (was the statement a SELECT?).");
    return (rows as unknown[]).filter((r): r is Record<string, unknown> => r != null && typeof r === "object")
      .map(normaliseRow);
  } finally {
    await conn.query("COMMIT").catch(() => {});
  }
}

function withTimeout<T>(p: Promise<T>, ms: number, onTimeout: () => never): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => { try { onTimeout(); } catch (e) { reject(e); } }, ms);
    p.then(v => { clearTimeout(t); resolve(v); }, e => { clearTimeout(t); reject(e); });
  });
}

// ── Public API ──────────────────────────────────────────────────────────────

export type MysqlTestResult = {
  ok: boolean;
  url: string;             // host:port/database — for the UI
  sentSql: string;
  sampleRecordCount: number;
  firstRecordKeys: string[];
  firstRecord?: Record<string, unknown>;
  error?: string;
};

export async function testMysqlConnection(
  tenantId: string,
  sourceId: string
): Promise<MysqlTestResult> {
  const source = await prisma.integrationSource.findFirst({
    where: { id: sourceId, tenantId, sourceType: SourceType.MYSQL },
    select: { configJson: true }
  });
  if (!source) throw new Error("MySQL source not found.");

  const cfg = parseMysqlConfig(source.configJson);
  // For the test, cap rowLimit at 5 so we don't drag back a million rows just to confirm connectivity.
  const testCfg: MysqlSourceConfig = { ...cfg, rowLimit: Math.min(cfg.rowLimit, 5) };
  const sentSql = buildPreparedSql(testCfg);
  const url = `${cfg.host}:${cfg.port}/${cfg.database}`;

  let conn: Mysql2Connection | null = null;
  try {
    conn = await connect(cfg);
    await conn.query("SELECT 1");
    const rows = await runReadOnlyQuery(conn, sentSql, cfg.queryTimeoutMs);
    return {
      ok: true,
      url,
      sentSql,
      sampleRecordCount: rows.length,
      firstRecordKeys: rows[0] ? Object.keys(rows[0]) : [],
      firstRecord: rows[0]
    };
  } catch (err) {
    return {
      ok: false,
      url,
      sentSql,
      sampleRecordCount: 0,
      firstRecordKeys: [],
      error: err instanceof Error ? err.message : String(err)
    };
  } finally {
    if (conn) await conn.end().catch(() => {});
  }
}

export async function executeMysqlPull(
  tenantId: string,
  sourceId: string,
  triggeredBy: string
): Promise<ConnectorRunResult> {
  const source = await prisma.integrationSource.findFirst({
    where: { id: sourceId, tenantId, sourceType: SourceType.MYSQL },
    select: { id: true, configJson: true, status: true }
  });
  if (!source) throw new Error("MySQL source not found.");
  if (source.status !== "ENABLED") throw new Error("MySQL source is disabled.");

  const cfg = parseMysqlConfig(source.configJson);
  const sentSql = buildPreparedSql(cfg);

  let conn: Mysql2Connection | null = null;
  let records: Record<string, unknown>[] = [];
  try {
    conn = await connect(cfg);
    records = await runReadOnlyQuery(conn, sentSql, cfg.queryTimeoutMs);
  } finally {
    if (conn) await conn.end().catch(() => {});
  }

  return executeConnectorRun({
    tenantId,
    sourceId: source.id,
    sourceType: SourceType.MYSQL,
    runType: RunType.SCHEDULED,
    payloadRef: `mysql-pull:${cfg.host}:${cfg.port}/${cfg.database}`,
    mappingVersion: "v1",
    idempotencyKey: crypto.randomUUID(),
    requestedBy: triggeredBy,
    entityType: cfg.entityType,
    records
  });
}

/**
 * Pull every ENABLED MySQL source for the tenant whose `intervalMinutes`
 * has elapsed since `lastSyncAt`. Called once per minute by the scheduler.
 *
 * Backwards-compat wrapper around the new chunked drain. Kept as the
 * scheduler entry point so vercel.json + node-cron registration don't
 * have to change.
 */
export async function pullAllMysqlSourcesForTenant(tenantId: string): Promise<string> {
  return drainMysqlPullJobsForTenant(tenantId);
}

// ── Resumable drain ─────────────────────────────────────────────────────────
//
// The cron tick budget on Vercel is ~5 min, but a real ERP pull can be
// 50k–500k rows — far more than fits in one invocation. So we do the work
// in two phases:
//
//   1. enqueueMysqlPull(tenantId, sourceId, …)
//      Creates an IntegrationSyncJob with status=PENDING and a snapshot of
//      the chunked-pull state in summaryJson (cursor, success/failure
//      counters, the SQL we'll run, etc.). Returns immediately.
//
//   2. drainMysqlPullJobsForTenant(tenantId)
//      Each cron tick: for every PENDING/RUNNING job belonging to this
//      tenant's MYSQL sources, open a connection, fetch one chunk
//      (LIMIT chunkSize OFFSET cursor), upsert into Postgres, advance
//      cursor, persist progress. Stop when the per-tick deadline expires;
//      the next minute's tick picks up where we left off.
//
// For a fresh schedule due-time we enqueue first, then drain in the same
// tick — small sources finish in one minute; huge ones bleed across
// several. The frontend polls /jobs/:id to show progress.

const DRAIN_BUDGET_MS = 240_000; // leave ~60s headroom under Vercel's 300s
const PER_JOB_BUDGET_MS = 200_000;

type DrainState = {
  /** Snapshot of the parsed source config when the job was enqueued. */
  config_snapshot: MysqlSourceConfig;
  /** OFFSET into the source result set for the next chunk. */
  cursor: number;
  /** Total successfully upserted across all chunks so far. */
  success_count: number;
  /** Total mapped+upsert failures so far (errors are persisted to IntegrationSyncError). */
  failure_count: number;
  /** Records skipped as in-chunk dupes. */
  duplicate_count: number;
  /** Total rows read off MySQL so far. */
  processed_count: number;
  /** Set once the connector returns fewer rows than chunkSize. */
  finished: boolean;
  payload_ref: string;
  mapping_version: string;
  idempotency_key: string;
  requested_by: string;
  entity_type: EntityType;
};

function makeDrainState(cfg: MysqlSourceConfig, requestedBy: string): DrainState {
  return {
    config_snapshot: cfg,
    cursor: 0,
    success_count: 0,
    failure_count: 0,
    duplicate_count: 0,
    processed_count: 0,
    finished: false,
    payload_ref: `mysql-pull:${cfg.host}:${cfg.port}/${cfg.database}`,
    mapping_version: "v1",
    idempotency_key: crypto.randomUUID(),
    requested_by: requestedBy,
    entity_type: cfg.entityType
  };
}

/**
 * If a TABLE-mode source has no explicit ORDER BY, default to ORDER BY 1
 * so that LIMIT/OFFSET resumption is at least column-stable. For SQL mode
 * we trust the admin's ORDER BY (or lack thereof — they own that risk).
 */
function buildChunkSql(cfg: MysqlSourceConfig, offset: number, now: Date = new Date()): string {
  const limit = cfg.chunkSize;
  if (cfg.query.mode === "TABLE") {
    const q = cfg.query;
    const parts: string[] = [`SELECT * FROM ${quoteTableName(q.table)}`];
    if (q.where) parts.push(`WHERE ${expandTemplate(q.where, now)}`);
    parts.push(`ORDER BY ${q.orderBy ? expandTemplate(q.orderBy, now) : "1"}`);
    parts.push(`LIMIT ${limit} OFFSET ${offset}`);
    return parts.join(" ");
  }
  // SQL mode: wrap the user's statement so we don't have to parse-and-rewrite
  // their ORDER BY / LIMIT. mysql2 doesn't run multi-statements, but a
  // subquery is one statement. Re-validate post-expansion.
  const expanded = expandTemplate(cfg.query.sql, now);
  validateSelectStatement(expanded);
  const cleaned = expanded.replace(/;+\s*$/, "").trim();
  return `SELECT * FROM (${cleaned}) AS __mp_inner LIMIT ${limit} OFFSET ${offset}`;
}

/**
 * Enqueue a new chunked MySQL pull job. Returns the job id immediately;
 * actual upstream fetching happens on the next cron tick. If a PENDING or
 * RUNNING job already exists for this source, return its id instead of
 * stacking duplicates.
 */
export async function enqueueMysqlPull(
  tenantId: string,
  sourceId: string,
  triggeredBy: string,
  runType: RunType = RunType.MANUAL
): Promise<{ jobId: string; reused: boolean }> {
  const source = await prisma.integrationSource.findFirst({
    where: { id: sourceId, tenantId, sourceType: SourceType.MYSQL },
    select: { id: true, configJson: true, status: true }
  });
  if (!source) throw new Error("MySQL source not found.");
  if (source.status !== "ENABLED") throw new Error("MySQL source is disabled.");

  const cfg = parseMysqlConfig(source.configJson);

  const existing = await prisma.integrationSyncJob.findFirst({
    where: {
      tenantId,
      sourceId,
      status: { in: [JobStatus.PENDING, JobStatus.RUNNING] }
    },
    orderBy: { startedAt: "desc" },
    select: { id: true }
  });
  if (existing) return { jobId: existing.id, reused: true };

  const drain = makeDrainState(cfg, triggeredBy);
  const job = await prisma.integrationSyncJob.create({
    data: {
      tenantId,
      sourceId,
      runType,
      status: JobStatus.PENDING,
      startedAt: new Date(),
      summaryJson: drain as unknown as object
    }
  });
  return { jobId: job.id, reused: false };
}

/** Read the drain-state slice out of a job's summaryJson. */
function readDrainState(summaryJson: unknown): DrainState | null {
  if (!summaryJson || typeof summaryJson !== "object") return null;
  const o = summaryJson as Record<string, unknown>;
  if (!o.config_snapshot || typeof o.cursor !== "number") return null;
  return o as unknown as DrainState;
}

async function persistDrainState(jobId: string, drain: DrainState, status: JobStatus): Promise<void> {
  await prisma.integrationSyncJob.update({
    where: { id: jobId },
    data: {
      status,
      summaryJson: drain as unknown as object,
      ...(status === JobStatus.SUCCESS || status === JobStatus.FAILED
        ? { finishedAt: new Date() }
        : {})
    }
  });
}

/**
 * Drain one job's remaining chunks, up to `deadlineAt`. Opens a single
 * MySQL connection and reuses it across chunks. On deadline, leaves the
 * job in RUNNING state so the next cron tick resumes from `cursor`.
 *
 * Errors during a chunk fetch fail the job (no retry) — the source config
 * is wrong (bad SQL, dropped table, auth) and we'd rather surface that
 * than hammer it every minute.
 */
async function drainOneJob(jobId: string, deadlineAt: number): Promise<string> {
  const job = await prisma.integrationSyncJob.findUnique({
    where: { id: jobId },
    include: { source: { include: { mappings: true } } }
  });
  if (!job) return `${jobId}: not found`;
  if (job.status !== JobStatus.PENDING && job.status !== JobStatus.RUNNING) {
    return `${jobId}: skipped (status=${job.status})`;
  }
  const drain = readDrainState(job.summaryJson);
  if (!drain) {
    await persistDrainState(jobId, makeFailedDrainShim(job.summaryJson, "Drain state missing from summaryJson."), JobStatus.FAILED);
    return `${jobId}: failed (no drain state)`;
  }

  const mappings = job.source.mappings.filter(m => m.entityType === drain.entity_type);
  if (mappings.length === 0) {
    await persistDrainState(jobId, drain, JobStatus.FAILED);
    return `${jobId}: failed (no mappings for ${drain.entity_type})`;
  }

  // Mark RUNNING on first drain pass so the UI can distinguish waiting from active.
  if (job.status === JobStatus.PENDING) {
    await persistDrainState(jobId, drain, JobStatus.RUNNING);
  }

  const cfg = drain.config_snapshot;
  const seenKeys = new Set<string>(); // chunk-local dedupe; DB unique catches the rest
  let conn: Mysql2Connection | null = null;
  try {
    conn = await connect(cfg);
    const jobBudgetUntil = Math.min(deadlineAt, Date.now() + PER_JOB_BUDGET_MS);
    while (Date.now() < jobBudgetUntil && !drain.finished) {
      const sql = buildChunkSql(cfg, drain.cursor);
      const rows = await runReadOnlyQuery(conn, sql, cfg.queryTimeoutMs);
      if (rows.length === 0) {
        drain.finished = true;
        break;
      }

      const result = await processConnectorChunk({
        tenantId: job.tenantId,
        jobId: job.id,
        entityType: drain.entity_type,
        mappings,
        records: rows,
        rowOffset: drain.cursor,
        seenKeys
      });
      drain.success_count += result.successCount;
      drain.duplicate_count += result.duplicateCount;
      drain.failure_count += result.errors.length;
      drain.processed_count += rows.length;
      drain.cursor += rows.length;

      // Persist progress after each chunk so the UI sees movement and a
      // mid-tick crash doesn't lose the cursor.
      await persistDrainState(jobId, drain, JobStatus.RUNNING);

      // Short-circuit if the source returned a partial chunk (we've reached the end).
      if (rows.length < cfg.chunkSize) {
        drain.finished = true;
      }

      // Also stop if the source's hard rowLimit cap is reached.
      if (drain.cursor >= cfg.rowLimit) {
        drain.finished = true;
      }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await prisma.integrationSyncError.create({
      data: {
        jobId: job.id,
        entityType: drain.entity_type,
        rowRef: `chunk@${drain.cursor}`,
        errorCode: "CHUNK_FETCH_FAILED",
        errorMessage: msg.slice(0, 500)
      }
    });
    drain.failure_count += 1;
    await persistDrainState(jobId, drain, JobStatus.FAILED);
    await prisma.integrationSource.update({
      where: { id: job.sourceId },
      data: { lastSyncAt: new Date() }
    });
    return `${jobId}: chunk error — ${msg}`;
  } finally {
    if (conn) await conn.end().catch(() => {});
  }

  if (drain.finished) {
    const finalStatus = drain.failure_count > 0 && drain.success_count === 0
      ? JobStatus.FAILED
      : JobStatus.SUCCESS;
    await persistDrainState(jobId, drain, finalStatus);
    await prisma.integrationSource.update({
      where: { id: job.sourceId },
      data: { lastSyncAt: new Date() }
    });
    return `${jobId}: done (${drain.success_count}/${drain.processed_count} ok, ${drain.failure_count} failed)`;
  }
  return `${jobId}: paused at cursor=${drain.cursor} (${drain.success_count}/${drain.processed_count} so far)`;
}

function makeFailedDrainShim(summaryJson: unknown, _reason: string): DrainState {
  // Best-effort: keep whatever metadata we have so the UI shows something.
  // Used only when a job's summaryJson is missing the drain-state fields.
  const base = (summaryJson && typeof summaryJson === "object" ? summaryJson : {}) as Record<string, unknown>;
  return {
    config_snapshot: (base.config_snapshot as MysqlSourceConfig) ?? ({} as MysqlSourceConfig),
    cursor: typeof base.cursor === "number" ? base.cursor : 0,
    success_count: typeof base.success_count === "number" ? base.success_count : 0,
    failure_count: (typeof base.failure_count === "number" ? base.failure_count : 0) + 1,
    duplicate_count: typeof base.duplicate_count === "number" ? base.duplicate_count : 0,
    processed_count: typeof base.processed_count === "number" ? base.processed_count : 0,
    finished: true,
    payload_ref: typeof base.payload_ref === "string" ? base.payload_ref : "mysql-pull:unknown",
    mapping_version: typeof base.mapping_version === "string" ? base.mapping_version : "v1",
    idempotency_key: typeof base.idempotency_key === "string" ? base.idempotency_key : crypto.randomUUID(),
    requested_by: typeof base.requested_by === "string" ? base.requested_by : "system",
    entity_type: (typeof base.entity_type === "string" ? base.entity_type : EntityType.CUSTOMER) as EntityType
  };
}

/**
 * Auto-fail MYSQL sync jobs that have been stuck in RUNNING for longer than
 * the configured threshold. The chunked drain persists progress after every
 * chunk, so a job that hasn't moved in `>thresholdMinutes` is almost
 * certainly orphaned (function timeout, OOM, deploy mid-flight) and the
 * lock-out blocks every subsequent enqueue for the same source.
 *
 * Threshold: SYNC_JOB_STUCK_THRESHOLD_MINUTES env var; default 30.
 * The longest legit per-chunk pull observed is single-digit minutes.
 */
export async function reapStuckMysqlJobs(tenantId: string): Promise<string> {
  const raw = parseInt(process.env.SYNC_JOB_STUCK_THRESHOLD_MINUTES ?? "", 10);
  const thresholdMinutes = Number.isFinite(raw) && raw >= 1 ? raw : 30;
  const message = `Auto-failed: stuck RUNNING for >${thresholdMinutes} min`;
  const reaped = await prisma.$executeRaw`
    UPDATE "IntegrationSyncJob" AS j
    SET status = 'FAILED',
        "finishedAt" = NOW(),
        "summaryJson" = COALESCE(j."summaryJson", '{}'::jsonb)
          || jsonb_build_object('errorMessage', ${message}, 'reapedAt', NOW())
    FROM "IntegrationSource" AS s
    WHERE j."sourceId" = s.id
      AND j."tenantId" = ${tenantId}
      AND s."sourceType" = 'MYSQL'
      AND j.status = 'RUNNING'
      AND j."startedAt" < NOW() - (${thresholdMinutes}::int * INTERVAL '1 minute')
  `;
  return `Reaped ${reaped} stuck MySQL job(s) older than ${thresholdMinutes} min.`;
}

/**
 * Per-tenant drain entry point. Steps:
 *   1. Auto-enqueue jobs for any ENABLED source whose schedule is due
 *      (and that doesn't already have a PENDING/RUNNING job).
 *   2. Drain PENDING/RUNNING jobs (oldest first) until the per-tick budget
 *      is exhausted.
 */
export async function drainMysqlPullJobsForTenant(tenantId: string): Promise<string> {
  const deadlineAt = Date.now() + DRAIN_BUDGET_MS;

  const sources = await prisma.integrationSource.findMany({
    where: { tenantId, sourceType: SourceType.MYSQL, status: "ENABLED" },
    select: { id: true, sourceName: true, configJson: true, lastSyncAt: true }
  });

  // Auto-enqueue scheduled sources that are due.
  const now = new Date();
  for (const src of sources) {
    let cfg: MysqlSourceConfig;
    try { cfg = parseMysqlConfig(src.configJson); } catch { continue; }
    if (cfg.schedule.kind !== "MINUTES") continue;
    const intervalMs = cfg.schedule.intervalMinutes * 60_000;
    if (src.lastSyncAt && now.getTime() - src.lastSyncAt.getTime() < intervalMs - 5_000) continue;
    try {
      await enqueueMysqlPull(tenantId, src.id, "cron:syncMysqlPull", RunType.SCHEDULED);
    } catch {
      // ignore — disabled-after-load, etc.
    }
  }

  const queued = await prisma.integrationSyncJob.findMany({
    where: {
      tenantId,
      source: { sourceType: SourceType.MYSQL },
      status: { in: [JobStatus.PENDING, JobStatus.RUNNING] }
    },
    orderBy: { startedAt: "asc" },
    select: { id: true }
  });
  if (queued.length === 0) return `No MySQL jobs queued (${sources.length} enabled).`;

  const lines: string[] = [];
  for (const { id } of queued) {
    if (Date.now() >= deadlineAt) {
      lines.push(`${id}: deferred (deadline reached)`);
      continue;
    }
    try {
      lines.push(await drainOneJob(id, deadlineAt));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      lines.push(`${id}: drain error — ${msg}`);
    }
  }
  return lines.join("; ");
}
