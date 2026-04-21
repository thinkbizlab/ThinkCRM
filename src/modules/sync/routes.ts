import { EntityType, RunType, UserRole } from "@prisma/client";
import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { requireRoleAtLeast, requireTenantId, requireUserId } from "../../lib/http.js";
import { prisma } from "../../lib/prisma.js";
import { authenticateSyncApiKey, assertSyncScope, generateSyncApiKey } from "../../lib/sync-auth.js";
import { executeConnectorRun } from "../integrations/connector-framework.js";
import { saveSyncExternalRefs } from "../../lib/sync-refs.js";

// ── Schemas ──────────────────────────────────────────────────────────────────

const inboundPushSchema = z.object({
  entityType: z.nativeEnum(EntityType),
  records: z.array(z.record(z.string(), z.unknown())).min(1).max(5000),
  externalSource: z.string().min(1).max(100).optional(),
  externalIdField: z.string().min(1).max(100).optional(),
  idempotencyKey: z.string().min(1).optional(),
});

const createApiKeySchema = z.object({
  label: z.string().min(1).max(100),
  scopes: z.array(z.string().min(1)).min(1),
  expiresInDays: z.number().int().min(1).max(3650).optional(),
});

const fileImportSchema = z.object({
  entityType: z.nativeEnum(EntityType),
  sourceId: z.string().min(1),
  externalSource: z.string().min(1).max(100).optional(),
  externalIdField: z.string().min(1).max(100).optional(),
});

// ── Routes ───────────────────────────────────────────────────────────────────

export const syncRoutes: FastifyPluginAsync = async (app) => {

  // ┌─────────────────────────────────────────────────────────────────────────┐
  // │ PUBLIC INBOUND — API key authenticated                                 │
  // └─────────────────────────────────────────────────────────────────────────┘

  /**
   * POST /sync/inbound
   * Accepts records from an external system (ERP, etc.) and upserts them.
   * Auth: X-Api-Key header (SyncApiKey).
   */
  app.post("/sync/inbound", async (request, reply) => {
    const ctx = await authenticateSyncApiKey(request);

    // B2: API key auth bypasses the global JWT-based requireActiveTenant hook.
    // Check tenant isActive explicitly so deactivated tenants can't push data.
    const tenant = await prisma.tenant.findUnique({
      where: { id: ctx.tenantId },
      select: { isActive: true },
    });
    if (!tenant?.isActive) {
      throw app.httpErrors.forbidden("Tenant is deactivated.");
    }

    const parsed = inboundPushSchema.safeParse(request.body);
    if (!parsed.success) {
      throw app.httpErrors.badRequest(parsed.error.issues[0]?.message ?? "Invalid request body.");
    }

    assertSyncScope(ctx, parsed.data.entityType, request);

    // Find the tenant's default WEBHOOK source, or create one.
    const source = await getOrCreateWebhookSource(ctx.tenantId, parsed.data.entityType);

    const result = await executeConnectorRun({
      tenantId: ctx.tenantId,
      sourceId: source.id,
      sourceType: "WEBHOOK",
      runType: RunType.WEBHOOK,
      payloadRef: `api-key:${ctx.apiKeyId}`,
      mappingVersion: "v1",
      idempotencyKey: parsed.data.idempotencyKey ?? crypto.randomUUID(),
      requestedBy: `api-key:${ctx.apiKeyId}`,
      entityType: parsed.data.entityType,
      records: parsed.data.records,
    });

    // Track external references if externalSource + externalIdField provided.
    // Pass the source's field mappings so raw ERP fields are translated to
    // CRM field names before looking up the internal entity ID.
    if (parsed.data.externalSource && parsed.data.externalIdField) {
      const mappings = await prisma.integrationFieldMapping.findMany({
        where: { sourceId: source.id, entityType: parsed.data.entityType },
        select: { sourceField: true, targetField: true, transformRule: true, isRequired: true },
      });
      await saveSyncExternalRefs({
        tenantId: ctx.tenantId,
        entityType: parsed.data.entityType,
        records: parsed.data.records,
        externalSource: parsed.data.externalSource,
        externalIdField: parsed.data.externalIdField,
        mappings,
      });
    }

    return reply.code(result.summary.status === "failed" ? 422 : 202).send({
      accepted: result.summary.status !== "failed",
      jobId: result.jobId,
      ...result.summary,
      errors: result.errors,
    });
  });

  // ┌─────────────────────────────────────────────────────────────────────────┐
  // │ ADMIN — API Key Management (JWT authenticated)                         │
  // └─────────────────────────────────────────────────────────────────────────┘

  /** List all sync API keys for the tenant. */
  app.get("/sync/api-keys", async (request) => {
    requireRoleAtLeast(request, UserRole.ADMIN);
    const tenantId = requireTenantId(request);
    return prisma.syncApiKey.findMany({
      where: { tenantId },
      select: {
        id: true, label: true, keyPrefix: true, scopes: true,
        isActive: true, lastUsedAt: true, expiresAt: true, createdAt: true,
      },
      orderBy: { createdAt: "desc" },
    });
  });

  /** Create a new sync API key. Returns the raw key (shown ONCE). */
  app.post("/sync/api-keys", async (request, reply) => {
    requireRoleAtLeast(request, UserRole.ADMIN);
    const tenantId = requireTenantId(request);
    const parsed = createApiKeySchema.safeParse(request.body);
    if (!parsed.success) {
      throw app.httpErrors.badRequest(parsed.error.issues[0]?.message ?? "Invalid request body.");
    }

    const { rawKey, keyHash, keyPrefix } = generateSyncApiKey();
    const expiresAt = parsed.data.expiresInDays
      ? new Date(Date.now() + parsed.data.expiresInDays * 86_400_000)
      : null;

    const created = await prisma.syncApiKey.create({
      data: {
        tenantId,
        label: parsed.data.label,
        keyHash,
        keyPrefix,
        scopes: parsed.data.scopes,
        expiresAt,
      },
      select: {
        id: true, label: true, keyPrefix: true, scopes: true,
        isActive: true, expiresAt: true, createdAt: true,
      },
    });

    return reply.code(201).send({ ...created, rawKey });
  });

  /** Revoke (deactivate) a sync API key. */
  app.patch("/sync/api-keys/:keyId/revoke", async (request) => {
    requireRoleAtLeast(request, UserRole.ADMIN);
    const tenantId = requireTenantId(request);
    const { keyId } = request.params as { keyId: string };

    const key = await prisma.syncApiKey.findFirst({ where: { id: keyId, tenantId } });
    if (!key) throw app.httpErrors.notFound("API key not found.");

    return prisma.syncApiKey.update({
      where: { id: keyId },
      data: { isActive: false },
      select: { id: true, label: true, isActive: true },
    });
  });

  /** Delete a sync API key permanently. */
  app.delete("/sync/api-keys/:keyId", async (request) => {
    requireRoleAtLeast(request, UserRole.ADMIN);
    const tenantId = requireTenantId(request);
    const { keyId } = request.params as { keyId: string };

    const key = await prisma.syncApiKey.findFirst({ where: { id: keyId, tenantId } });
    if (!key) throw app.httpErrors.notFound("API key not found.");

    await prisma.syncApiKey.delete({ where: { id: keyId } });
    return { deleted: true };
  });

  // ┌─────────────────────────────────────────────────────────────────────────┐
  // │ ADMIN — External Reference Lookup (JWT authenticated)                  │
  // └─────────────────────────────────────────────────────────────────────────┘

  /** Lookup external refs for an entity. */
  app.get("/sync/external-refs", async (request) => {
    requireRoleAtLeast(request, UserRole.MANAGER);
    const tenantId = requireTenantId(request);
    const query = request.query as {
      entityType?: EntityType;
      entityId?: string;
      externalSource?: string;
    };
    return prisma.syncExternalRef.findMany({
      where: {
        tenantId,
        entityType: query.entityType,
        entityId: query.entityId,
        externalSource: query.externalSource,
      },
      orderBy: { updatedAt: "desc" },
      take: 200,
    });
  });

  // ┌─────────────────────────────────────────────────────────────────────────┐
  // │ ADMIN — File Import with external ref tracking (JWT authenticated)     │
  // └─────────────────────────────────────────────────────────────────────────┘

  /** POST /sync/import — accepts JSON rows with optional external ref tracking. */
  app.post("/sync/import", async (request, reply) => {
    requireRoleAtLeast(request, UserRole.MANAGER);
    const tenantId = requireTenantId(request);
    const userId = requireUserId(request);
    const body = request.body as Record<string, unknown>;
    const parsed = fileImportSchema.safeParse(body);
    if (!parsed.success) {
      throw app.httpErrors.badRequest(parsed.error.issues[0]?.message ?? "Invalid request body.");
    }
    const rows = body.records;
    if (!Array.isArray(rows) || rows.length === 0) {
      throw app.httpErrors.badRequest("records array is required and must not be empty.");
    }

    const result = await executeConnectorRun({
      tenantId,
      sourceId: parsed.data.sourceId,
      sourceType: "EXCEL",
      runType: RunType.MANUAL,
      payloadRef: "file-import",
      mappingVersion: "v1",
      idempotencyKey: crypto.randomUUID(),
      requestedBy: userId,
      entityType: parsed.data.entityType,
      records: rows as Record<string, unknown>[],
    });

    if (parsed.data.externalSource && parsed.data.externalIdField) {
      const mappings = await prisma.integrationFieldMapping.findMany({
        where: { sourceId: parsed.data.sourceId, entityType: parsed.data.entityType },
        select: { sourceField: true, targetField: true, transformRule: true, isRequired: true },
      });
      await saveSyncExternalRefs({
        tenantId,
        entityType: parsed.data.entityType,
        records: rows as Record<string, unknown>[],
        externalSource: parsed.data.externalSource,
        externalIdField: parsed.data.externalIdField,
        mappings,
      });
    }

    return reply.code(result.summary.status === "failed" ? 422 : 201).send({
      jobId: result.jobId,
      ...result.summary,
      errors: result.errors,
    });
  });

  // ┌─────────────────────────────────────────────────────────────────────────┐
  // │ ADMIN — Sync Jobs History (JWT authenticated)                          │
  // └─────────────────────────────────────────────────────────────────────────┘

  app.get("/sync/jobs", async (request) => {
    requireRoleAtLeast(request, UserRole.MANAGER);
    const tenantId = requireTenantId(request);
    const query = request.query as { limit?: string };
    const limit = Math.min(Number(query.limit) || 50, 200);
    return prisma.integrationSyncJob.findMany({
      where: { tenantId },
      include: { source: { select: { sourceName: true, sourceType: true } } },
      orderBy: { startedAt: "desc" },
      take: limit,
    });
  });

  app.get("/sync/jobs/:jobId", async (request) => {
    requireRoleAtLeast(request, UserRole.MANAGER);
    const tenantId = requireTenantId(request);
    const { jobId } = request.params as { jobId: string };
    const job = await prisma.integrationSyncJob.findFirst({
      where: { id: jobId, tenantId },
      include: { errors: true, source: { select: { sourceName: true, sourceType: true } } },
    });
    if (!job) throw app.httpErrors.notFound("Job not found.");
    return job;
  });
};

// ── Helpers ──────────────────────────────────────────────────────────────────

// Default passthrough mappings so the inbound endpoint works out-of-the-box
// when the ERP sends records using CRM field names.
const DEFAULT_PASSTHROUGH_MAPPINGS: Array<{ entityType: EntityType; sourceField: string; targetField: string; isRequired: boolean }> = [
  { entityType: EntityType.CUSTOMER, sourceField: "customerCode",    targetField: "customerCode",    isRequired: true },
  { entityType: EntityType.CUSTOMER, sourceField: "name",            targetField: "name",            isRequired: true },
  { entityType: EntityType.CUSTOMER, sourceField: "customerType",    targetField: "customerType",    isRequired: false },
  { entityType: EntityType.CUSTOMER, sourceField: "taxId",           targetField: "taxId",           isRequired: false },
  { entityType: EntityType.CUSTOMER, sourceField: "defaultTermCode", targetField: "defaultTermCode", isRequired: false },
  { entityType: EntityType.CUSTOMER, sourceField: "ownerId",         targetField: "ownerId",         isRequired: false },
  { entityType: EntityType.CUSTOMER, sourceField: "siteLat",         targetField: "siteLat",         isRequired: false },
  { entityType: EntityType.CUSTOMER, sourceField: "siteLng",         targetField: "siteLng",         isRequired: false },
  { entityType: EntityType.CUSTOMER, sourceField: "externalRef",     targetField: "externalRef",     isRequired: false },
  { entityType: EntityType.ITEM,     sourceField: "itemCode",     targetField: "itemCode",     isRequired: true },
  { entityType: EntityType.ITEM,     sourceField: "name",         targetField: "name",         isRequired: true },
  { entityType: EntityType.ITEM,     sourceField: "unitPrice",    targetField: "unitPrice",    isRequired: true },
  { entityType: EntityType.PAYMENT_TERM, sourceField: "code",     targetField: "code",         isRequired: true },
  { entityType: EntityType.PAYMENT_TERM, sourceField: "name",     targetField: "name",         isRequired: true },
  { entityType: EntityType.PAYMENT_TERM, sourceField: "dueDays",  targetField: "dueDays",      isRequired: true },
];

async function getOrCreateWebhookSource(tenantId: string, entityType: EntityType) {
  const existing = await prisma.integrationSource.findFirst({
    where: { tenantId, sourceType: "WEBHOOK", sourceName: "API Sync" },
    include: { mappings: true },
  });

  if (existing) {
    // Ensure passthrough mappings exist for the requested entity type.
    const hasEntityMappings = existing.mappings.some(m => m.entityType === entityType);
    if (!hasEntityMappings) {
      const defaults = DEFAULT_PASSTHROUGH_MAPPINGS.filter(m => m.entityType === entityType);
      if (defaults.length > 0) {
        await prisma.integrationFieldMapping.createMany({
          data: defaults.map(m => ({ sourceId: existing.id, ...m })),
        });
      }
    }
    return existing;
  }

  // L2: Race condition guard — if two requests arrive simultaneously,
  // the second create will fail. Catch and re-fetch.
  try {
    const created = await prisma.integrationSource.create({
      data: {
        tenantId,
        sourceName: "API Sync",
        sourceType: "WEBHOOK",
        configJson: {},
        status: "ENABLED",
      },
    });

    // Seed default passthrough mappings for all entity types.
    await prisma.integrationFieldMapping.createMany({
      data: DEFAULT_PASSTHROUGH_MAPPINGS.map(m => ({ sourceId: created.id, ...m })),
    });

    return created;
  } catch {
    // Another request created the source concurrently — fetch it.
    const fallback = await prisma.integrationSource.findFirst({
      where: { tenantId, sourceType: "WEBHOOK", sourceName: "API Sync" },
    });
    if (fallback) return fallback;
    throw new Error("Failed to create API Sync source.");
  }
}
