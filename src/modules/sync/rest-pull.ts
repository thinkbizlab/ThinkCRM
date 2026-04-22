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

type RestSourceConfig = {
  endpointUrl: string;
  entityType: EntityType;
  authHeaderName?: string;
  authValueEnc?: string;
  recordsJsonPath?: string;
  queryParams?: Record<string, string>;
};

function parseRestConfig(raw: unknown): RestSourceConfig {
  if (!raw || typeof raw !== "object") throw new Error("REST source configJson is missing.");
  const obj = raw as Record<string, unknown>;
  const endpointUrl = typeof obj.endpointUrl === "string" ? obj.endpointUrl.trim() : "";
  const entityType = typeof obj.entityType === "string" ? obj.entityType : "";
  if (!endpointUrl) throw new Error("REST source endpointUrl is not configured.");
  if (!/^https?:\/\//i.test(endpointUrl)) throw new Error("REST source endpointUrl must start with http:// or https://");
  if (!(entityType in EntityType)) throw new Error(`REST source entityType "${entityType}" is invalid.`);
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
    authHeaderName: typeof obj.authHeaderName === "string" ? obj.authHeaderName : undefined,
    authValueEnc:   typeof obj.authValueEnc   === "string" ? obj.authValueEnc   : undefined,
    recordsJsonPath: typeof obj.recordsJsonPath === "string" ? obj.recordsJsonPath : undefined,
    queryParams
  };
}

function buildRequest(cfg: RestSourceConfig): { url: string; headers: Record<string, string> } {
  const headers: Record<string, string> = { Accept: "application/json" };
  if (cfg.authHeaderName && cfg.authValueEnc) {
    const plain = decryptField(cfg.authValueEnc);
    if (plain) headers[cfg.authHeaderName] = plain;
  }
  let url = cfg.endpointUrl;
  if (cfg.queryParams && Object.keys(cfg.queryParams).length > 0) {
    const u = new URL(url);
    for (const [k, v] of Object.entries(cfg.queryParams)) {
      u.searchParams.set(k, v);
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
  method: "GET";
  sentHeaderNames: string[];
  sampleRecordCount: number;
  firstRecordKeys: string[];
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
  try {
    const res = await fetch(url, { method: "GET", headers });
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
      return { ok: false, status: res.status, statusText: res.statusText, url, method: "GET", sentHeaderNames, sampleRecordCount: 0, firstRecordKeys: [], responseBody, error: typeof body === "string" ? body.slice(0, 500) : `HTTP ${res.status}` };
    }
    let records: Record<string, unknown>[] = [];
    try { records = extractRecords(body, cfg.recordsJsonPath); } catch (e) {
      return { ok: false, status: res.status, statusText: res.statusText, url, method: "GET", sentHeaderNames, sampleRecordCount: 0, firstRecordKeys: [], responseBody, error: e instanceof Error ? e.message : "Could not extract records." };
    }
    const firstRecordKeys = records[0] ? Object.keys(records[0]) : [];
    return { ok: true, status: res.status, statusText: res.statusText, url, method: "GET", sentHeaderNames, sampleRecordCount: records.length, firstRecordKeys, responseBody };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, status: 0, statusText: "Network error", url, method: "GET", sentHeaderNames, sampleRecordCount: 0, firstRecordKeys: [], responseBody: "", error: msg };
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

  const res = await fetch(url, { method: "GET", headers });
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
  const sources = await prisma.integrationSource.findMany({
    where: { tenantId, sourceType: SourceType.REST, status: "ENABLED" },
    select: { id: true, sourceName: true }
  });
  if (sources.length === 0) return "No enabled REST sources.";

  const lines: string[] = [];
  for (const src of sources) {
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
