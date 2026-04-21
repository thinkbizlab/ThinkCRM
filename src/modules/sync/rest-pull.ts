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
};

function parseRestConfig(raw: unknown): RestSourceConfig {
  if (!raw || typeof raw !== "object") throw new Error("REST source configJson is missing.");
  const obj = raw as Record<string, unknown>;
  const endpointUrl = typeof obj.endpointUrl === "string" ? obj.endpointUrl.trim() : "";
  const entityType = typeof obj.entityType === "string" ? obj.entityType : "";
  if (!endpointUrl) throw new Error("REST source endpointUrl is not configured.");
  if (!/^https?:\/\//i.test(endpointUrl)) throw new Error("REST source endpointUrl must start with http:// or https://");
  if (!(entityType in EntityType)) throw new Error(`REST source entityType "${entityType}" is invalid.`);
  return {
    endpointUrl,
    entityType: entityType as EntityType,
    authHeaderName: typeof obj.authHeaderName === "string" ? obj.authHeaderName : undefined,
    authValueEnc:   typeof obj.authValueEnc   === "string" ? obj.authValueEnc   : undefined,
    recordsJsonPath: typeof obj.recordsJsonPath === "string" ? obj.recordsJsonPath : undefined
  };
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

  const headers: Record<string, string> = { Accept: "application/json" };
  if (cfg.authHeaderName && cfg.authValueEnc) {
    const plain = decryptField(cfg.authValueEnc);
    if (plain) headers[cfg.authHeaderName] = plain;
  }

  const res = await fetch(cfg.endpointUrl, { method: "GET", headers });
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
