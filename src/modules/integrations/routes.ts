import {
  EntityType,
  Direction,
  ExecutionStatus,
  IntegrationPlatform,
  Prisma,
  RunType,
  TriggerType,
  UserRole
} from "@prisma/client";
import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { requireRoleAtLeast, requireTenantId, requireUserId, zodMsg } from "../../lib/http.js";
import { prisma } from "../../lib/prisma.js";
import { encryptField } from "../../lib/secrets.js";
import { connectorInputContractSchema, executeConnectorRun } from "./connector-framework.js";
import { executeRestPull, testRestConnection } from "../sync/rest-pull.js";
import { enqueueMysqlPull, testMysqlConnection } from "../sync/mysql-pull.js";
import { clearFederationCaches } from "../federation/customer-federation.js";
import { evictPool } from "../federation/mysql-pool.js";

const sourceSchema = z.object({
  sourceName: z.string().min(2),
  sourceType: z.enum(["EXCEL", "REST", "WEBHOOK", "MYSQL"]),
  configJson: z.record(z.string(), z.any())
});

const mappingSchema = z.object({
  mappings: z.array(
    z.object({
      entityType: z.enum(["CUSTOMER", "ITEM", "PAYMENT_TERM", "DEAL", "VISIT"]),
      sourceField: z.string(),
      targetField: z.string(),
      transformRule: z.string().max(2000).optional(),
      isRequired: z.boolean().default(false)
    })
  )
});

const excelImportSchema = z.object({
  sourceId: z.string().min(1),
  fileObjectKey: z.string().min(1),
  entityType: z.nativeEnum(EntityType),
  rows: z.array(z.record(z.string(), z.unknown())),
  mappingVersion: z.string().min(1).default("v1"),
  idempotencyKey: z.string().min(1).default(() => crypto.randomUUID())
});

const syncRunSchema = z.object({
  connector_id: z.string().min(1),
  tenant_id: z.string().min(1),
  entity_type: z.nativeEnum(EntityType),
  trigger_type: z.enum(["manual", "scheduled", "event"]),
  payload_ref: z.string().min(1),
  mapping_version: z.string().min(1),
  idempotency_key: z.string().min(1),
  requested_by: z.string().min(1),
  records: z.array(z.record(z.string(), z.unknown())).min(1)
});

const transformTemplateSchema = z.object({
  name: z.string().trim().min(1).max(100),
  description: z.string().trim().max(500).optional(),
  steps: z.string().max(2000)
});

const webhookRunSchema = z.object({
  entityType: z.nativeEnum(EntityType),
  records: z.array(z.record(z.string(), z.unknown())).min(1),
  payloadRef: z.string().min(1).default("webhook"),
  mappingVersion: z.string().min(1).default("v1"),
  idempotencyKey: z.string().min(1).default(() => crypto.randomUUID())
});

export const integrationRoutes: FastifyPluginAsync = async (app) => {
  const runTypeByTrigger: Record<z.infer<typeof connectorInputContractSchema>["trigger_type"], RunType> =
    {
      manual: RunType.MANUAL,
      scheduled: RunType.SCHEDULED,
      event: RunType.WEBHOOK
    };

  const logTriggerByRunType: Record<RunType, TriggerType> = {
    MANUAL: TriggerType.MANUAL,
    SCHEDULED: TriggerType.SCHEDULED,
    WEBHOOK: TriggerType.EVENT
  };

  async function writeConnectorExecutionLog(input: {
    tenantId: string;
    userId: string;
    sourceId: string;
    runType: RunType;
    payloadRef: string;
    status: ExecutionStatus;
    responseSummary: string;
    errorCode?: string;
    errorMessage?: string;
  }): Promise<void> {
    await prisma.integrationExecutionLog.create({
      data: {
        tenantId: input.tenantId,
        executedById: input.userId,
        platform: IntegrationPlatform.GENERIC,
        operationType: "MASTER_DATA_SYNC",
        direction: Direction.INBOUND,
        triggerType: logTriggerByRunType[input.runType],
        status: input.status,
        requestRef: input.sourceId,
        responseSummary: input.responseSummary,
        errorCode: input.errorCode,
        errorMessage: input.errorMessage,
        payloadMasked: {
          sourceId: input.sourceId,
          payloadRef: input.payloadRef
        },
        completedAt: new Date()
      }
    });
  }

  app.get("/integrations/master-data/sources", async (request) => {
    requireRoleAtLeast(request, UserRole.MANAGER);
    const tenantId = requireTenantId(request);
    return prisma.integrationSource.findMany({
      where: { tenantId },
      include: { mappings: true },
      orderBy: { createdAt: "desc" }
    });
  });

  app.post("/integrations/master-data/sources", async (request, reply) => {
    requireRoleAtLeast(request, UserRole.MANAGER);
    const tenantId = requireTenantId(request);
    const parsed = sourceSchema.safeParse(request.body);
    if (!parsed.success) {
      throw app.httpErrors.badRequest(zodMsg(parsed.error));
    }
    let cleanConfig: Record<string, unknown>;
    try {
      cleanConfig = sanitizeSourceConfig(parsed.data.sourceType, parsed.data.configJson);
    } catch (err) {
      throw app.httpErrors.badRequest(err instanceof Error ? err.message : "Invalid source config.");
    }
    const created = await prisma.integrationSource.create({
      data: {
        tenantId,
        sourceName: parsed.data.sourceName,
        sourceType: parsed.data.sourceType,
        configJson: cleanConfig as Prisma.InputJsonValue
      }
    });
    return reply.code(201).send(created);
  });

  app.patch("/integrations/master-data/sources/:id", async (request) => {
    requireRoleAtLeast(request, UserRole.MANAGER);
    const tenantId = requireTenantId(request);
    const params = request.params as { id: string };
    const body = request.body as { status?: "ENABLED" | "DISABLED"; sourceName?: string; configJson?: Record<string, unknown> };
    const source = await prisma.integrationSource.findFirst({
      where: { id: params.id, tenantId }
    });
    if (!source) {
      throw app.httpErrors.notFound("Source not found.");
    }
    let nextConfig: Record<string, unknown> | undefined;
    if (body.configJson) {
      try {
        nextConfig = sanitizeSourceConfig(source.sourceType, body.configJson, source.configJson as Record<string, unknown>);
      } catch (err) {
        throw app.httpErrors.badRequest(err instanceof Error ? err.message : "Invalid source config.");
      }
    }
    const trimmedName = typeof body.sourceName === "string" ? body.sourceName.trim() : undefined;
    if (trimmedName !== undefined && trimmedName.length < 2) {
      throw app.httpErrors.badRequest("sourceName must be at least 2 characters.");
    }
    const updated = await prisma.integrationSource.update({
      where: { id: params.id },
      data: {
        status: body.status,
        sourceName: trimmedName,
        configJson: nextConfig as Prisma.InputJsonValue | undefined
      }
    });
    // If this source backs a federated tenant, drop the cached config + the
    // pooled connection so the next live read picks up new credentials,
    // table/keyColumn, etc. — otherwise the operator waits up to 60s for the
    // config TTL to lapse, with a stale pool open the whole time.
    if (nextConfig) {
      await evictPool(params.id);
    }
    clearFederationCaches(tenantId);
    return updated;
  });

  app.delete("/integrations/master-data/sources/:id", async (request, reply) => {
    requireRoleAtLeast(request, UserRole.ADMIN);
    const tenantId = requireTenantId(request);
    const params = request.params as { id: string };
    const source = await prisma.integrationSource.findFirst({
      where: { id: params.id, tenantId }
    });
    if (!source) throw app.httpErrors.notFound("Source not found.");
    // Schema cascades mappings + jobs + errors. SyncExternalRef rows reference
    // by externalSource string (not FK), so they survive — past correlation
    // history stays intact.
    await prisma.integrationSource.delete({ where: { id: params.id } });
    // Tenant.customerFederationSourceId FK is ON DELETE SET NULL — the next
    // hydration call will see federation disabled. Drop pool + cache for safety.
    await evictPool(params.id);
    clearFederationCaches(tenantId);
    reply.code(204).send();
  });

  /**
   * Manual trigger for a source pull (REST or MYSQL). Admin-only.
   * The scheduled cron runs the same logic for all enabled sources.
   */
  app.post("/integrations/master-data/sources/:id/pull", async (request, reply) => {
    requireRoleAtLeast(request, UserRole.ADMIN);
    const tenantId = requireTenantId(request);
    const userId = requireUserId(request);
    const { id } = request.params as { id: string };
    const source = await prisma.integrationSource.findFirst({
      where: { id, tenantId },
      select: { sourceType: true }
    });
    if (!source) throw app.httpErrors.notFound("Source not found.");
    if (source.sourceType !== "REST" && source.sourceType !== "MYSQL") {
      throw app.httpErrors.badRequest(`Manual pull is only supported for REST and MYSQL sources (got ${source.sourceType}).`);
    }
    try {
      if (source.sourceType === "MYSQL") {
        // MySQL pulls can be hundreds of thousands of rows — far more than
        // fits in a single Vercel function invocation. Enqueue a job and
        // let the cron drain it in chunks; the client polls /jobs/:id.
        const { jobId, reused } = await enqueueMysqlPull(tenantId, id, `user:${userId}`);
        return reply.code(202).send({
          jobId,
          status: reused ? "already_running" : "queued",
          message: reused
            ? "A pull is already in progress for this source. Tracking the existing job."
            : "Pull queued. The cron will drain it in chunks; poll the job for progress."
        });
      }
      const result = await executeRestPull(tenantId, id, `user:${userId}`);
      return reply.code(200).send({
        jobId: result.jobId,
        ...result.summary,
        errors: result.errors
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Pull failed.";
      throw app.httpErrors.badRequest(msg);
    }
  });

  app.put("/integrations/master-data/sources/:id/mappings", async (request) => {
    requireRoleAtLeast(request, UserRole.MANAGER);
    const tenantId = requireTenantId(request);
    const params = request.params as { id: string };
    const parsed = mappingSchema.safeParse(request.body);
    if (!parsed.success) {
      throw app.httpErrors.badRequest(zodMsg(parsed.error));
    }
    const source = await prisma.integrationSource.findFirst({
      where: { id: params.id, tenantId }
    });
    if (!source) {
      throw app.httpErrors.notFound("Source not found.");
    }
    await prisma.integrationFieldMapping.deleteMany({ where: { sourceId: params.id } });
    const result = await prisma.integrationFieldMapping.createMany({
      data: parsed.data.mappings.map((item) => ({ ...item, sourceId: params.id }))
    });
    // Federation reads cache the source's mappings for 60s — drop the cache so
    // the new column → CRM-field mapping takes effect on the next request.
    clearFederationCaches(tenantId);
    return result;
  });

  app.post("/integrations/master-data/sources/:id/test", async (request) => {
    requireRoleAtLeast(request, UserRole.MANAGER);
    const tenantId = requireTenantId(request);
    const userId = requireUserId(request);
    const params = request.params as { id: string };
    const source = await prisma.integrationSource.findFirst({
      where: { id: params.id, tenantId }
    });
    if (!source) {
      throw app.httpErrors.notFound("Source not found.");
    }

    // REST: actually hit the endpoint and report back.
    // WEBHOOK/EXCEL: config-only check (no outbound call to test).
    let result: {
      ok: boolean;
      message: string;
      responseBody?: string;
      detail?: Record<string, unknown>;
    };
    if (source.sourceType === "REST") {
      try {
        const test = await testRestConnection(tenantId, source.id);
        result = {
          ok: test.ok,
          message: test.ok
            ? `Reached endpoint: ${test.status} ${test.statusText} — ${test.sampleRecordCount} record(s) found.`
            : `Failed: ${test.error ?? `${test.status} ${test.statusText}`}`,
          responseBody: test.responseBody,
          detail: {
            url: test.url,
            method: test.method,
            sentHeaderNames: test.sentHeaderNames,
            sampleRecordCount: test.sampleRecordCount,
            firstRecordKeys: test.firstRecordKeys,
            firstRecord: test.firstRecord
          }
        };
      } catch (err) {
        result = { ok: false, message: err instanceof Error ? err.message : "Test failed." };
      }
    } else if (source.sourceType === "MYSQL") {
      try {
        const test = await testMysqlConnection(tenantId, source.id);
        result = {
          ok: test.ok,
          message: test.ok
            ? `Connected to ${test.url} — ${test.sampleRecordCount} sample record(s) returned.`
            : `Failed: ${test.error ?? "MySQL test failed"}`,
          detail: {
            url: test.url,
            sentSql: test.sentSql,
            sampleRecordCount: test.sampleRecordCount,
            firstRecordKeys: test.firstRecordKeys,
            firstRecord: test.firstRecord
          }
        };
      } catch (err) {
        result = { ok: false, message: err instanceof Error ? err.message : "MySQL test failed." };
      }
    } else {
      const cfg = (source.configJson ?? {}) as Record<string, unknown>;
      result = {
        ok: true,
        message: `${source.sourceType} source configured. No live endpoint to test.`,
        detail: { sourceType: source.sourceType, configuredKeys: Object.keys(cfg) }
      };
    }

    await prisma.integrationExecutionLog.create({
      data: {
        tenantId,
        executedById: userId,
        platform: IntegrationPlatform.GENERIC,
        operationType: "TEST_CONNECTION",
        direction: Direction.OUTBOUND,
        triggerType: "MANUAL",
        status: result.ok ? ExecutionStatus.SUCCESS : ExecutionStatus.FAILURE,
        requestRef: source.id,
        responseSummary: result.message,
        payloadMasked: { sourceName: source.sourceName, sourceType: source.sourceType, ...(result.detail ?? {}) },
        completedAt: new Date()
      }
    });

    return result;
  });

  app.post("/integrations/master-data/imports/excel", async (request, reply) => {
    requireRoleAtLeast(request, UserRole.MANAGER);
    const tenantId = requireTenantId(request);
    const userId = requireUserId(request);
    const parsed = excelImportSchema.safeParse(request.body);
    if (!parsed.success) {
      throw app.httpErrors.badRequest(zodMsg(parsed.error));
    }

    try {
      const result = await executeConnectorRun({
        tenantId,
        sourceId: parsed.data.sourceId,
        sourceType: "EXCEL",
        runType: RunType.MANUAL,
        payloadRef: parsed.data.fileObjectKey,
        mappingVersion: parsed.data.mappingVersion,
        idempotencyKey: parsed.data.idempotencyKey,
        requestedBy: userId,
        entityType: parsed.data.entityType,
        records: parsed.data.rows
      });

      await writeConnectorExecutionLog({
        tenantId,
        userId,
        sourceId: parsed.data.sourceId,
        runType: RunType.MANUAL,
        payloadRef: parsed.data.fileObjectKey,
        status:
          result.summary.status === "failed" ? ExecutionStatus.FAILURE : ExecutionStatus.SUCCESS,
        responseSummary: `Excel import ${result.summary.status} (${result.summary.success_count}/${result.summary.processed_count})`
      });

      return reply.code(201).send({
        job_id: result.jobId,
        ...result.summary,
        errors: result.errors
      });
    } catch (error) {
      await writeConnectorExecutionLog({
        tenantId,
        userId,
        sourceId: parsed.data.sourceId,
        runType: RunType.MANUAL,
        payloadRef: parsed.data.fileObjectKey,
        status: ExecutionStatus.FAILURE,
        responseSummary: "Excel import failed before processing.",
        errorCode: "CONNECTOR_EXECUTION_FAILED",
        errorMessage: error instanceof Error ? error.message : "Unknown connector error"
      });
      throw app.httpErrors.badRequest(
        error instanceof Error ? error.message : "Connector execution failed."
      );
    }
  });

  app.post("/integrations/master-data/sources/:id/sync", async (request, reply) => {
    requireRoleAtLeast(request, UserRole.MANAGER);
    const tenantId = requireTenantId(request);
    const userId = requireUserId(request);
    const params = request.params as { id: string };
    const contract = syncRunSchema.safeParse(request.body);
    if (!contract.success) {
      throw app.httpErrors.badRequest(`Connector contract violation: ${zodMsg(contract.error)}`);
    }
    if (contract.data.tenant_id !== tenantId) {
      throw app.httpErrors.forbidden("tenant_id does not match authenticated tenant.");
    }

    const runType = runTypeByTrigger[contract.data.trigger_type];
    try {
      const result = await executeConnectorRun({
        tenantId,
        sourceId: params.id,
        sourceType: "REST",
        runType,
        payloadRef: contract.data.payload_ref,
        mappingVersion: contract.data.mapping_version,
        idempotencyKey: contract.data.idempotency_key,
        requestedBy: contract.data.requested_by,
        entityType: contract.data.entity_type,
        records: contract.data.records
      });

      await writeConnectorExecutionLog({
        tenantId,
        userId,
        sourceId: params.id,
        runType,
        payloadRef: contract.data.payload_ref,
        status:
          result.summary.status === "failed" ? ExecutionStatus.FAILURE : ExecutionStatus.SUCCESS,
        responseSummary: `REST sync ${result.summary.status} (${result.summary.success_count}/${result.summary.processed_count})`
      });

      return reply.code(201).send({
        job_id: result.jobId,
        ...result.summary,
        errors: result.errors
      });
    } catch (error) {
      await writeConnectorExecutionLog({
        tenantId,
        userId,
        sourceId: params.id,
        runType,
        payloadRef: contract.data.payload_ref,
        status: ExecutionStatus.FAILURE,
        responseSummary: "REST sync failed before processing.",
        errorCode: "CONNECTOR_EXECUTION_FAILED",
        errorMessage: error instanceof Error ? error.message : "Unknown connector error"
      });
      throw app.httpErrors.badRequest(
        error instanceof Error ? error.message : "Connector execution failed."
      );
    }
  });

  app.post("/integrations/master-data/webhook/:sourceId", async (request, reply) => {
    requireRoleAtLeast(request, UserRole.MANAGER);
    const tenantId = requireTenantId(request);
    const userId = requireUserId(request);
    const sourceId = (request.params as { sourceId: string }).sourceId;
    const parsed = webhookRunSchema.safeParse(request.body);
    if (!parsed.success) {
      throw app.httpErrors.badRequest(zodMsg(parsed.error));
    }

    try {
      const result = await executeConnectorRun({
        tenantId,
        sourceId,
        sourceType: "WEBHOOK",
        runType: RunType.WEBHOOK,
        payloadRef: parsed.data.payloadRef,
        mappingVersion: parsed.data.mappingVersion,
        idempotencyKey: parsed.data.idempotencyKey,
        requestedBy: userId,
        entityType: parsed.data.entityType,
        records: parsed.data.records
      });

      await writeConnectorExecutionLog({
        tenantId,
        userId,
        sourceId,
        runType: RunType.WEBHOOK,
        payloadRef: parsed.data.payloadRef,
        status:
          result.summary.status === "failed" ? ExecutionStatus.FAILURE : ExecutionStatus.SUCCESS,
        responseSummary: `Webhook sync ${result.summary.status} (${result.summary.success_count}/${result.summary.processed_count})`
      });

      return reply.code(202).send({
        accepted: result.summary.status !== "failed",
        job_id: result.jobId,
        ...result.summary,
        errors: result.errors
      });
    } catch (error) {
      await writeConnectorExecutionLog({
        tenantId,
        userId,
        sourceId,
        runType: RunType.WEBHOOK,
        payloadRef: parsed.data.payloadRef,
        status: ExecutionStatus.FAILURE,
        responseSummary: "Webhook sync failed before processing.",
        errorCode: "CONNECTOR_EXECUTION_FAILED",
        errorMessage: error instanceof Error ? error.message : "Unknown connector error"
      });
      throw app.httpErrors.badRequest(
        error instanceof Error ? error.message : "Connector execution failed."
      );
    }
  });

  app.get("/integrations/master-data/jobs/:jobId", async (request) => {
    requireRoleAtLeast(request, UserRole.MANAGER);
    const tenantId = requireTenantId(request);
    const params = request.params as { jobId: string };
    const job = await prisma.integrationSyncJob.findFirst({
      where: { id: params.jobId, tenantId },
      include: { errors: true, source: true }
    });
    if (!job) {
      throw app.httpErrors.notFound("Job not found.");
    }
    return job;
  });

  app.get("/integrations/transform-templates", async (request) => {
    requireRoleAtLeast(request, UserRole.MANAGER);
    const tenantId = requireTenantId(request);
    return prisma.transformTemplate.findMany({
      where: { tenantId },
      orderBy: { name: "asc" }
    });
  });

  app.post("/integrations/transform-templates", async (request, reply) => {
    requireRoleAtLeast(request, UserRole.MANAGER);
    const tenantId = requireTenantId(request);
    const parsed = transformTemplateSchema.safeParse(request.body);
    if (!parsed.success) {
      throw app.httpErrors.badRequest(zodMsg(parsed.error));
    }
    const created = await prisma.transformTemplate.create({
      data: {
        tenantId,
        name: parsed.data.name,
        description: parsed.data.description ?? null,
        steps: parsed.data.steps
      }
    });
    return reply.code(201).send(created);
  });

  app.put("/integrations/transform-templates/:id", async (request) => {
    requireRoleAtLeast(request, UserRole.MANAGER);
    const tenantId = requireTenantId(request);
    const params = request.params as { id: string };
    const parsed = transformTemplateSchema.safeParse(request.body);
    if (!parsed.success) {
      throw app.httpErrors.badRequest(zodMsg(parsed.error));
    }
    const existing = await prisma.transformTemplate.findFirst({
      where: { id: params.id, tenantId },
      select: { id: true }
    });
    if (!existing) {
      throw app.httpErrors.notFound("Template not found.");
    }
    return prisma.transformTemplate.update({
      where: { id: existing.id },
      data: {
        name: parsed.data.name,
        description: parsed.data.description ?? null,
        steps: parsed.data.steps
      }
    });
  });

  app.delete("/integrations/transform-templates/:id", async (request, reply) => {
    requireRoleAtLeast(request, UserRole.MANAGER);
    const tenantId = requireTenantId(request);
    const params = request.params as { id: string };
    const existing = await prisma.transformTemplate.findFirst({
      where: { id: params.id, tenantId },
      select: { id: true }
    });
    if (!existing) {
      throw app.httpErrors.notFound("Template not found.");
    }
    await prisma.transformTemplate.delete({ where: { id: existing.id } });
    return reply.code(204).send();
  });

  app.get("/integrations/logs", async (request) => {
    requireRoleAtLeast(request, UserRole.MANAGER);
    const tenantId = requireTenantId(request);
    const query = request.query as {
      platform?: IntegrationPlatform;
      status?: ExecutionStatus;
      operationType?: string;
    };
    return prisma.integrationExecutionLog.findMany({
      where: {
        tenantId,
        platform: query.platform,
        status: query.status,
        operationType: query.operationType
      },
      orderBy: { startedAt: "desc" },
      take: 200
    });
  });
};

/**
 * Encrypts secrets before they hit the DB. PATCH requests that omit the
 * secret (or send an empty string) keep the previously-stored encrypted
 * value, so editing a non-secret field doesn't blank out the stored secret.
 */
function sanitizeSourceConfig(
  sourceType: "EXCEL" | "REST" | "WEBHOOK" | "MYSQL",
  incoming: Record<string, unknown>,
  existing?: Record<string, unknown>
): Record<string, unknown> {
  if (sourceType === "REST") {
    const out: Record<string, unknown> = { ...incoming };
    const rawAuth = typeof out.authValue === "string" ? out.authValue.trim() : "";
    delete out.authValue;
    if (rawAuth) {
      const enc = encryptField(rawAuth);
      if (enc) out.authValueEnc = enc;
    } else if (existing && typeof existing.authValueEnc === "string") {
      out.authValueEnc = existing.authValueEnc;
    }
    return out;
  }
  if (sourceType === "MYSQL") {
    const out: Record<string, unknown> = { ...incoming };
    // Password
    const rawPwd = typeof out.password === "string" ? out.password : "";
    delete out.password;
    if (rawPwd) {
      const enc = encryptField(rawPwd);
      if (enc) out.passwordEnc = enc;
    } else if (existing && typeof existing.passwordEnc === "string") {
      out.passwordEnc = existing.passwordEnc;
    }
    // SSL CA PEM (optional)
    const ssl = (out.ssl ?? {}) as Record<string, unknown>;
    const existingSsl = (existing?.ssl ?? {}) as Record<string, unknown>;
    const rawCa = typeof ssl.caPem === "string" ? ssl.caPem : "";
    delete ssl.caPem;
    if (rawCa) {
      const enc = encryptField(rawCa);
      if (enc) ssl.caPemEnc = enc;
    } else if (typeof existingSsl.caPemEnc === "string") {
      ssl.caPemEnc = existingSsl.caPemEnc;
    }
    out.ssl = ssl;
    // Customer-federation overrides (read by getFederationConfig). They're
    // interpolated as SQL identifiers in fetchOne/searchFederatedCustomers,
    // so reject anything that isn't a valid MySQL identifier here — the
    // federation code path only escapes backticks, it doesn't sanitize.
    if (typeof out.keyColumn === "string") {
      const v = out.keyColumn.trim();
      if (!v) delete out.keyColumn;
      else if (!FEDERATION_COLUMN_RE.test(v)) {
        throw new Error("Federation keyColumn must be a valid MySQL identifier (letters, digits, _ , $; up to 64 chars).");
      } else out.keyColumn = v;
    }
    if (typeof out.customerTable === "string") {
      const v = out.customerTable.trim();
      if (!v) delete out.customerTable;
      else if (!FEDERATION_TABLE_RE.test(v)) {
        throw new Error("Federation customerTable must be a valid MySQL table name (optional schema.table; letters, digits, _ , $; up to 64 chars per segment).");
      } else out.customerTable = v;
    }
    return out;
  }
  return incoming;
}

// Same identifier rules as mysql-pull's TABLE_IDENT_RE / federation column check —
// duplicated here so the routes layer doesn't depend on mysql-pull internals.
const FEDERATION_COLUMN_RE = /^[A-Za-z_$][A-Za-z0-9_$]{0,63}$/;
const FEDERATION_TABLE_RE = /^[A-Za-z_$][A-Za-z0-9_$]{0,63}(?:\.[A-Za-z_$][A-Za-z0-9_$]{0,63})?$/;
