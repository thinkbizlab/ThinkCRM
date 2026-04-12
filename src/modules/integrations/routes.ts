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
import { requireRoleAtLeast, requireTenantId, requireUserId } from "../../lib/http.js";
import { prisma } from "../../lib/prisma.js";
import { connectorInputContractSchema, executeConnectorRun } from "./connector-framework.js";

const sourceSchema = z.object({
  sourceName: z.string().min(2),
  sourceType: z.enum(["EXCEL", "REST", "WEBHOOK"]),
  configJson: z.record(z.string(), z.any())
});

const mappingSchema = z.object({
  mappings: z.array(
    z.object({
      entityType: z.enum(["CUSTOMER", "ITEM", "PAYMENT_TERM", "DEAL", "VISIT"]),
      sourceField: z.string(),
      targetField: z.string(),
      transformRule: z.string().optional(),
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
      throw app.httpErrors.badRequest(parsed.error.message);
    }
    const created = await prisma.integrationSource.create({
      data: {
        tenantId,
        sourceName: parsed.data.sourceName,
        sourceType: parsed.data.sourceType,
        configJson: parsed.data.configJson
      }
    });
    return reply.code(201).send(created);
  });

  app.patch("/integrations/master-data/sources/:id", async (request) => {
    requireRoleAtLeast(request, UserRole.MANAGER);
    const tenantId = requireTenantId(request);
    const params = request.params as { id: string };
    const body = request.body as { status?: "ENABLED" | "DISABLED"; configJson?: Record<string, unknown> };
    const source = await prisma.integrationSource.findFirst({
      where: { id: params.id, tenantId }
    });
    if (!source) {
      throw app.httpErrors.notFound("Source not found.");
    }
    return prisma.integrationSource.update({
      where: { id: params.id },
      data: {
        status: body.status,
        configJson: body.configJson as Prisma.InputJsonValue
      }
    });
  });

  app.put("/integrations/master-data/sources/:id/mappings", async (request) => {
    requireRoleAtLeast(request, UserRole.MANAGER);
    const tenantId = requireTenantId(request);
    const params = request.params as { id: string };
    const parsed = mappingSchema.safeParse(request.body);
    if (!parsed.success) {
      throw app.httpErrors.badRequest(parsed.error.message);
    }
    const source = await prisma.integrationSource.findFirst({
      where: { id: params.id, tenantId }
    });
    if (!source) {
      throw app.httpErrors.notFound("Source not found.");
    }
    await prisma.integrationFieldMapping.deleteMany({ where: { sourceId: params.id } });
    return prisma.integrationFieldMapping.createMany({
      data: parsed.data.mappings.map((item) => ({ ...item, sourceId: params.id }))
    });
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

    await prisma.integrationExecutionLog.create({
      data: {
        tenantId,
        executedById: userId,
        platform: IntegrationPlatform.GENERIC,
        operationType: "TEST_CONNECTION",
        direction: Direction.OUTBOUND,
        triggerType: "MANUAL",
        status: ExecutionStatus.SUCCESS,
        requestRef: source.id,
        responseSummary: "Connection test simulated as success.",
        payloadMasked: { sourceName: source.sourceName, sourceType: source.sourceType },
        completedAt: new Date()
      }
    });

    return { ok: true, message: "Connection test passed." };
  });

  app.post("/integrations/master-data/imports/excel", async (request, reply) => {
    requireRoleAtLeast(request, UserRole.MANAGER);
    const tenantId = requireTenantId(request);
    const userId = requireUserId(request);
    const parsed = excelImportSchema.safeParse(request.body);
    if (!parsed.success) {
      throw app.httpErrors.badRequest(parsed.error.message);
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
      throw app.httpErrors.badRequest(`Connector contract violation: ${contract.error.message}`);
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
      throw app.httpErrors.badRequest(parsed.error.message);
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
      orderBy: { startedAt: "desc" }
    });
  });
};
