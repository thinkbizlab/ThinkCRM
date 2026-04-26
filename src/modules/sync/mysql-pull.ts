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

import { EntityType, RunType, SourceType } from "@prisma/client";
import { prisma } from "../../lib/prisma.js";
import { decryptField } from "../../lib/secrets.js";
import { executeConnectorRun, type ConnectorRunResult } from "../integrations/connector-framework.js";
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
  schedule: SyncSchedule;
  query: MysqlQueryConfig;
};

const ROW_LIMIT_DEFAULT = 50_000;
const ROW_LIMIT_MAX = 500_000;
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
function quoteTableName(table: string): string {
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
 */
export async function pullAllMysqlSourcesForTenant(tenantId: string): Promise<string> {
  const sources = await prisma.integrationSource.findMany({
    where: { tenantId, sourceType: SourceType.MYSQL, status: "ENABLED" },
    select: { id: true, sourceName: true, configJson: true, lastSyncAt: true }
  });
  if (sources.length === 0) return "No enabled MySQL sources.";

  const now = new Date();
  const due = sources.filter(src => {
    let cfg: MysqlSourceConfig;
    try { cfg = parseMysqlConfig(src.configJson); } catch { return false; }
    if (cfg.schedule.kind !== "MINUTES") return false;
    const intervalMs = cfg.schedule.intervalMinutes * 60_000;
    if (src.lastSyncAt && now.getTime() - src.lastSyncAt.getTime() < intervalMs - 5_000) return false;
    return true;
  });

  if (due.length === 0) return `No sources due (${sources.length} enabled).`;

  const lines: string[] = [];
  for (const src of due) {
    try {
      const result = await executeMysqlPull(tenantId, src.id, "cron:syncMysqlPull");
      const s = result.summary;
      lines.push(`${src.sourceName}: ${s.status} (${s.success_count}/${s.processed_count} ok, ${s.failure_count} failed)`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      lines.push(`${src.sourceName}: error — ${msg}`);
    }
  }
  return lines.join("; ");
}
