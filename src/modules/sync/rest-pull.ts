/**
 * REST pull executor.
 *
 * A tenant configures an IntegrationSource with sourceType=REST; configJson
 * shape: { endpointUrl, entityType, authHeaderName?, authValueEnc?, recordsJsonPath? }.
 * authValueEnc is encrypted via encryptField (ENCRYPTION_KEY) — plaintext in dev.
 * recordsJsonPath is an optional dotted path into the response for nested
 * arrays (e.g. "data.items"); defaults to the top-level body.
 *
 * The executor fetches the endpoint, extracts the record array, then hands
 * off to executeConnectorRun — which already owns mapping + upsert + job
 * history. So a scheduled pull shows up in the same sync-job list as a
 * manual xlsx import.
 */

import { EntityType, RunType, SourceType } from "@prisma/client";
import { prisma } from "../../lib/prisma.js";
import { decryptField } from "../../lib/secrets.js";
import { executeConnectorRun, type ConnectorRunResult } from "../integrations/connector-framework.js";

type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "HEAD" | "OPTIONS";
const ALLOWED_METHODS: ReadonlySet<HttpMethod> = new Set(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]);

export type SyncSchedule =
  | { kind: "MANUAL" }
  | { kind: "INTERVAL"; intervalHours: number; anchorHourLocal: number }
  | { kind: "DAILY"; hoursLocal: number[] }
  | { kind: "WEEKLY"; dayOfWeek: number; hourLocal: number }
  | { kind: "MONTHLY"; dayOfMonth: number; hourLocal: number };

type RestSourceConfig = {
  endpointUrl: string;
  entityType: EntityType;
  method: HttpMethod;
  authHeaderName?: string;
  authValueEnc?: string;
  recordsJsonPath?: string;
  queryParams?: Record<string, string>;
  schedule: SyncSchedule;
};

function parseSchedule(raw: unknown): SyncSchedule {
  if (!raw || typeof raw !== "object") return { kind: "MANUAL" };
  const o = raw as Record<string, unknown>;
  const kind = typeof o.kind === "string" ? o.kind : "MANUAL";
  const toHour = (v: unknown) => {
    const n = typeof v === "number" ? v : parseInt(String(v), 10);
    return Number.isFinite(n) && n >= 0 && n <= 23 ? n : 0;
  };
  switch (kind) {
    case "INTERVAL": {
      const raw = typeof o.intervalHours === "number" ? o.intervalHours : parseInt(String(o.intervalHours), 10);
      const allowed = [1, 2, 3, 4, 6, 8, 12];
      const intervalHours = allowed.includes(raw) ? raw : 4;
      return { kind: "INTERVAL", intervalHours, anchorHourLocal: toHour(o.anchorHourLocal) };
    }
    case "DAILY": {
      const arr = Array.isArray(o.hoursLocal) ? o.hoursLocal : [];
      const hoursLocal = Array.from(new Set(arr.map(toHour))).sort((a, b) => a - b);
      return { kind: "DAILY", hoursLocal: hoursLocal.length ? hoursLocal : [2] };
    }
    case "WEEKLY": {
      const d = typeof o.dayOfWeek === "number" ? o.dayOfWeek : parseInt(String(o.dayOfWeek), 10);
      const dayOfWeek = Number.isFinite(d) && d >= 0 && d <= 6 ? d : 1;
      return { kind: "WEEKLY", dayOfWeek, hourLocal: toHour(o.hourLocal) };
    }
    case "MONTHLY": {
      const d = typeof o.dayOfMonth === "number" ? o.dayOfMonth : parseInt(String(o.dayOfMonth), 10);
      const dayOfMonth = Number.isFinite(d) && d >= 1 && d <= 28 ? d : 1;
      return { kind: "MONTHLY", dayOfMonth, hourLocal: toHour(o.hourLocal) };
    }
    default:
      return { kind: "MANUAL" };
  }
}

/** Parts of an absolute moment *in a given IANA timezone*. */
function localParts(now: Date, timezone: string): { hour: number; dow: number; dom: number; ymd: string } {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    hour: "2-digit", hour12: false,
    weekday: "short", day: "2-digit", month: "2-digit", year: "numeric"
  });
  const parts = Object.fromEntries(fmt.formatToParts(now).map(p => [p.type, p.value]));
  const hour = parseInt(parts.hour || "0", 10) % 24;
  const dow = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(parts.weekday || "Sun");
  const dom = parseInt(parts.day || "1", 10);
  const ymd = `${parts.year}-${parts.month}-${parts.day}`;
  return { hour, dow, dom, ymd };
}

/**
 * Does this schedule fire on the current tick (hourly cron)?
 * Called once per source per hour.
 */
export function shouldRunNow(schedule: SyncSchedule, now: Date, timezone: string): boolean {
  if (schedule.kind === "MANUAL") return false;
  const { hour, dow, dom } = localParts(now, timezone);
  switch (schedule.kind) {
    case "INTERVAL": {
      const offset = ((hour - schedule.anchorHourLocal) % schedule.intervalHours + schedule.intervalHours) % schedule.intervalHours;
      return offset === 0;
    }
    case "DAILY":  return schedule.hoursLocal.includes(hour);
    case "WEEKLY": return dow === schedule.dayOfWeek && hour === schedule.hourLocal;
    case "MONTHLY":return dom === schedule.dayOfMonth && hour === schedule.hourLocal;
  }
}

function parseRestConfig(raw: unknown): RestSourceConfig {
  if (!raw || typeof raw !== "object") throw new Error("REST source configJson is missing.");
  const obj = raw as Record<string, unknown>;
  const endpointUrl = typeof obj.endpointUrl === "string" ? obj.endpointUrl.trim() : "";
  const entityType = typeof obj.entityType === "string" ? obj.entityType : "";
  if (!endpointUrl) throw new Error("REST source endpointUrl is not configured.");
  if (!/^https?:\/\//i.test(endpointUrl)) throw new Error("REST source endpointUrl must start with http:// or https://");
  if (!(entityType in EntityType)) throw new Error(`REST source entityType "${entityType}" is invalid.`);
  const methodRaw = typeof obj.method === "string" ? obj.method.toUpperCase() : "GET";
  const method: HttpMethod = ALLOWED_METHODS.has(methodRaw as HttpMethod) ? (methodRaw as HttpMethod) : "GET";
  let queryParams: Record<string, string> | undefined;
  if (obj.queryParams && typeof obj.queryParams === "object" && !Array.isArray(obj.queryParams)) {
    queryParams = {};
    for (const [k, v] of Object.entries(obj.queryParams)) {
      if (k && (typeof v === "string" || typeof v === "number" || typeof v === "boolean")) {
        queryParams[k] = String(v);
      }
    }
    if (Object.keys(queryParams).length === 0) queryParams = undefined;
  }
  return {
    endpointUrl,
    entityType: entityType as EntityType,
    method,
    authHeaderName: typeof obj.authHeaderName === "string" ? obj.authHeaderName : undefined,
    authValueEnc:   typeof obj.authValueEnc   === "string" ? obj.authValueEnc   : undefined,
    recordsJsonPath: typeof obj.recordsJsonPath === "string" ? obj.recordsJsonPath : undefined,
    queryParams,
    schedule: parseSchedule(obj.schedule)
  };
}

/**
 * Resolve `{{token}}` placeholders in URL and query-param values.
 * Tokens:
 *   {{today}}, {{yesterday}}, {{tomorrow}}, {{monthStart}}, {{year}}
 *   {{now}}                          → ISO timestamp (default if no :fmt)
 *   {{today:YYYY-MM-DD}}             → custom format
 *   {{today-7d}} / {{today+1m:YYYYMMDD}} → offsets (d/w/m/y)
 */
export function expandTemplate(input: string, now: Date = new Date()): string {
  const TOKEN = /\{\{\s*([a-zA-Z]+)([+-]\d+[dwmy])?(?::([^}]+))?\s*\}\}/g;
  return input.replace(TOKEN, (match, baseRaw: string, offset: string | undefined, fmt: string | undefined) => {
    const base = baseRaw.toLowerCase();
    let d = new Date(now);
    let isDate = true;
    switch (base) {
      case "today":       break;
      case "yesterday":   d.setDate(d.getDate() - 1); break;
      case "tomorrow":    d.setDate(d.getDate() + 1); break;
      case "monthstart":  d = new Date(now.getFullYear(), now.getMonth(), 1); break;
      case "now":         isDate = false; break;
      case "year":        return String(now.getFullYear());
      default:            return match;
    }
    if (offset) {
      const m = offset.match(/^([+-])(\d+)([dwmy])$/);
      if (m && m[1] && m[2] && m[3]) {
        const sign = m[1] === "-" ? -1 : 1;
        const n = parseInt(m[2], 10) * sign;
        if (m[3] === "d") d.setDate(d.getDate() + n);
        if (m[3] === "w") d.setDate(d.getDate() + n * 7);
        if (m[3] === "m") d.setMonth(d.getMonth() + n);
        if (m[3] === "y") d.setFullYear(d.getFullYear() + n);
      }
    }
    if (!fmt && !isDate) return d.toISOString();
    return formatDate(d, fmt || "YYYY-MM-DD");
  });
}

function formatDate(d: Date, fmt: string): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return fmt
    .replace(/YYYY/g, String(d.getFullYear()))
    .replace(/MM/g,   pad(d.getMonth() + 1))
    .replace(/DD/g,   pad(d.getDate()))
    .replace(/HH/g,   pad(d.getHours()))
    .replace(/mm/g,   pad(d.getMinutes()))
    .replace(/ss/g,   pad(d.getSeconds()));
}

function buildRequest(cfg: RestSourceConfig): { url: string; headers: Record<string, string> } {
  const now = new Date();
  const headers: Record<string, string> = { Accept: "application/json" };
  if (cfg.authHeaderName && cfg.authValueEnc) {
    const plain = decryptField(cfg.authValueEnc);
    if (plain) headers[cfg.authHeaderName] = plain;
  }
  let url = expandTemplate(cfg.endpointUrl, now);
  if (cfg.queryParams && Object.keys(cfg.queryParams).length > 0) {
    const u = new URL(url);
    for (const [k, v] of Object.entries(cfg.queryParams)) {
      u.searchParams.set(k, expandTemplate(v, now));
    }
    url = u.toString();
  }
  return { url, headers };
}

export type RestTestResult = {
  ok: boolean;
  status: number;
  statusText: string;
  url: string;
  method: HttpMethod;
  sentHeaderNames: string[];
  sampleRecordCount: number;
  firstRecordKeys: string[];
  firstRecord?: Record<string, unknown>;
  responseBody: string;
  error?: string;
};

const MAX_RESPONSE_PREVIEW = 4000;
function truncatePreview(input: string): string {
  if (input.length <= MAX_RESPONSE_PREVIEW) return input;
  return input.slice(0, MAX_RESPONSE_PREVIEW) + `\n…(truncated, ${input.length - MAX_RESPONSE_PREVIEW} more chars)`;
}

export async function testRestConnection(
  tenantId: string,
  sourceId: string
): Promise<RestTestResult> {
  const source = await prisma.integrationSource.findFirst({
    where: { id: sourceId, tenantId, sourceType: SourceType.REST },
    select: { configJson: true }
  });
  if (!source) throw new Error("REST source not found.");
  const cfg = parseRestConfig(source.configJson);
  const { url, headers } = buildRequest(cfg);
  const sentHeaderNames = Object.keys(headers);
  const method = cfg.method;
  try {
    const res = await fetch(url, { method, headers });
    const text = await res.text();
    let body: unknown;
    let prettyBody = text;
    try {
      body = JSON.parse(text);
      prettyBody = JSON.stringify(body, null, 2);
    } catch {
      body = text;
    }
    const responseBody = truncatePreview(prettyBody);
    if (!res.ok) {
      return { ok: false, status: res.status, statusText: res.statusText, url, method, sentHeaderNames, sampleRecordCount: 0, firstRecordKeys: [], responseBody, error: typeof body === "string" ? body.slice(0, 500) : `HTTP ${res.status}` };
    }
    let records: Record<string, unknown>[] = [];
    try { records = extractRecords(body, cfg.recordsJsonPath); } catch (e) {
      return { ok: false, status: res.status, statusText: res.statusText, url, method, sentHeaderNames, sampleRecordCount: 0, firstRecordKeys: [], responseBody, error: e instanceof Error ? e.message : "Could not extract records." };
    }
    const firstRecordKeys = records[0] ? Object.keys(records[0]) : [];
    const firstRecord = records[0];
    return { ok: true, status: res.status, statusText: res.statusText, url, method, sentHeaderNames, sampleRecordCount: records.length, firstRecordKeys, firstRecord, responseBody };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, status: 0, statusText: "Network error", url, method, sentHeaderNames, sampleRecordCount: 0, firstRecordKeys: [], responseBody: "", error: msg };
  }
}

function extractRecords(body: unknown, path: string | undefined): Record<string, unknown>[] {
  let cursor: unknown = body;
  if (path) {
    for (const seg of path.split(".").filter(Boolean)) {
      if (!cursor || typeof cursor !== "object") {
        throw new Error(`recordsJsonPath "${path}" could not be resolved on the response.`);
      }
      cursor = (cursor as Record<string, unknown>)[seg];
    }
  }
  if (!Array.isArray(cursor)) {
    throw new Error("REST response did not yield an array of records.");
  }
  return cursor.filter((r): r is Record<string, unknown> => r != null && typeof r === "object");
}

export async function executeRestPull(
  tenantId: string,
  sourceId: string,
  triggeredBy: string
): Promise<ConnectorRunResult> {
  const source = await prisma.integrationSource.findFirst({
    where: { id: sourceId, tenantId, sourceType: SourceType.REST },
    select: { id: true, configJson: true, status: true }
  });
  if (!source) throw new Error("REST source not found.");
  if (source.status !== "ENABLED") throw new Error("REST source is disabled.");

  const cfg = parseRestConfig(source.configJson);
  const { url, headers } = buildRequest(cfg);

  const res = await fetch(url, { method: cfg.method, headers });
  if (!res.ok) {
    throw new Error(`REST endpoint returned ${res.status} ${res.statusText}`);
  }
  const body: unknown = await res.json().catch(() => {
    throw new Error("REST endpoint returned a non-JSON body.");
  });
  const records = extractRecords(body, cfg.recordsJsonPath);

  return executeConnectorRun({
    tenantId,
    sourceId: source.id,
    sourceType: SourceType.REST,
    runType: RunType.SCHEDULED,
    payloadRef: `rest-pull:${cfg.endpointUrl}`,
    mappingVersion: "v1",
    idempotencyKey: crypto.randomUUID(),
    requestedBy: triggeredBy,
    entityType: cfg.entityType,
    records
  });
}

/**
 * Pull every ENABLED REST source for the tenant.
 * Returns a summary string for the cron run log.
 */
export async function pullAllRestSourcesForTenant(tenantId: string): Promise<string> {
  const tenant = await prisma.tenant.findUnique({
    where: { id: tenantId },
    select: { timezone: true }
  });
  const timezone = tenant?.timezone || "Asia/Bangkok";
  const now = new Date();

  const sources = await prisma.integrationSource.findMany({
    where: { tenantId, sourceType: SourceType.REST, status: "ENABLED" },
    select: { id: true, sourceName: true, configJson: true, lastSyncAt: true }
  });
  if (sources.length === 0) return "No enabled REST sources.";

  const due = sources.filter(src => {
    let schedule: SyncSchedule = { kind: "MANUAL" };
    try { schedule = parseRestConfig(src.configJson).schedule; } catch { return false; }
    if (!shouldRunNow(schedule, now, timezone)) return false;
    if (src.lastSyncAt && now.getTime() - src.lastSyncAt.getTime() < 50 * 60 * 1000) return false;
    return true;
  });

  if (due.length === 0) return `No sources due this hour (${sources.length} enabled).`;

  const lines: string[] = [];
  for (const src of due) {
    try {
      const result = await executeRestPull(tenantId, src.id, "cron:syncRestPull");
      const s = result.summary;
      lines.push(`${src.sourceName}: ${s.status} (${s.success_count}/${s.processed_count} ok, ${s.failure_count} failed)`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      lines.push(`${src.sourceName}: error — ${msg}`);
    }
  }
  return lines.join("; ");
}
