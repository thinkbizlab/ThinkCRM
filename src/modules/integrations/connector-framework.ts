import {
  CustomerType,
  EntityType,
  JobStatus,
  Prisma,
  RunType,
  SourceStatus,
  SourceType
} from "@prisma/client";
import { z } from "zod";
import { prisma } from "../../lib/prisma.js";
import { validateCustomFields } from "../../lib/custom-fields.js";

/**
 * Lightweight shim so `validateCustomFields` (which expects `app.httpErrors.badRequest`)
 * works outside a Fastify request context.  Errors thrown here are caught by the
 * connector run loop and recorded as sync errors.
 */
const connectorAppShim = {
  httpErrors: {
    badRequest(msg: string) { return new Error(msg); }
  }
} as Parameters<typeof validateCustomFields>[0];

const customerMappedSchema = z.object({
  customerCode: z.string().min(2).max(40),
  name: z.string().min(2).max(200),
  customerType: z.nativeEnum(CustomerType).optional(),
  taxId: z.string().max(20).optional(),
  defaultTermId: z.string().min(1).optional(),
  defaultTermCode: z.string().min(1).optional(),
  ownerId: z.string().min(1).optional(),
  siteLat: z.number().min(-90).max(90).optional(),
  siteLng: z.number().min(-180).max(180).optional(),
  externalRef: z.string().trim().max(100).optional(),
  customFields: z.record(z.string(), z.unknown()).optional()
});

const itemMappedSchema = z.object({
  itemCode: z.string().min(1),
  name: z.string().min(1),
  unitPrice: z.number().nonnegative(),
  customFields: z.record(z.string(), z.unknown()).optional()
});

const paymentTermMappedSchema = z.object({
  code: z.string().min(1),
  name: z.string().min(1),
  dueDays: z.number().int().min(0).max(365)
});

export const connectorInputContractSchema = z.object({
  connector_id: z.string().min(1),
  tenant_id: z.string().min(1),
  entity_type: z.nativeEnum(EntityType),
  trigger_type: z.enum(["manual", "scheduled", "event"]),
  payload_ref: z.string().min(1),
  mapping_version: z.string().min(1),
  idempotency_key: z.string().min(1),
  requested_by: z.string().min(1)
});

type ConnectorRecord = Record<string, unknown>;

type ConnectorErrorCategory =
  | "validation"
  | "mapping"
  | "auth"
  | "network"
  | "rate_limit"
  | "internal";

export type ConnectorError = {
  error_code: string;
  error_message: string;
  error_category: ConnectorErrorCategory;
  record_ref: string;
  retryable: boolean;
  provider_status_code: number | null;
};

export type ConnectorSummary = {
  status: "success" | "partial_success" | "failed";
  processed_count: number;
  success_count: number;
  failure_count: number;
  duplicate_count: number;
  started_at: string;
  completed_at: string;
  duration_ms: number;
  result_ref: string;
};

export type ConnectorRunResult = {
  jobId: string;
  summary: ConnectorSummary;
  errors: ConnectorError[];
};

export type ConnectorRunInput = {
  tenantId: string;
  sourceId: string;
  sourceType: SourceType;
  runType: RunType;
  payloadRef: string;
  mappingVersion: string;
  idempotencyKey: string;
  requestedBy: string;
  entityType: EntityType;
  records: ConnectorRecord[];
};

function toRunStatus(summary: ConnectorSummary): JobStatus {
  return summary.status === "failed" ? JobStatus.FAILED : JobStatus.SUCCESS;
}

function applyTransformRule(value: unknown, transformRule?: string | null): unknown {
  if (!transformRule) {
    return value;
  }
  const normalized = transformRule.trim().toLowerCase();
  if (normalized === "trim" && typeof value === "string") {
    return value.trim();
  }
  if (normalized === "upper" && typeof value === "string") {
    return value.toUpperCase();
  }
  if (normalized === "lower" && typeof value === "string") {
    return value.toLowerCase();
  }
  if (normalized === "number") {
    if (typeof value === "number") {
      return value;
    }
    if (typeof value === "string" && value.trim().length > 0) {
      const numeric = Number(value);
      if (!Number.isNaN(numeric)) {
        return numeric;
      }
    }
  }
  if (normalized === "boolean") {
    if (typeof value === "boolean") {
      return value;
    }
    if (typeof value === "string") {
      const lowered = value.trim().toLowerCase();
      if (["true", "1", "yes", "y"].includes(lowered)) {
        return true;
      }
      if (["false", "0", "no", "n"].includes(lowered)) {
        return false;
      }
    }
  }
  return value;
}

function readPath(input: ConnectorRecord, path: string): unknown {
  const segments = path.split(".");
  let current: unknown = input;
  for (const segment of segments) {
    if (typeof current !== "object" || current === null) {
      return undefined;
    }
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

export function buildMappedRecord(
  record: ConnectorRecord,
  mappings: Array<{
    sourceField: string;
    targetField: string;
    transformRule: string | null;
    isRequired: boolean;
  }>
): { mapped: Record<string, unknown>; issues: string[] } {
  const mapped: Record<string, unknown> = {};
  const issues: string[] = [];
  for (const mapping of mappings) {
    const raw = readPath(record, mapping.sourceField);
    if (raw === undefined || raw === null || raw === "") {
      if (mapping.isRequired) {
        issues.push(`Missing required source field "${mapping.sourceField}"`);
      }
      continue;
    }
    mapped[mapping.targetField] = applyTransformRule(raw, mapping.transformRule);
  }
  return { mapped, issues };
}

function dedupeKey(entityType: EntityType, mapped: Record<string, unknown>): string | null {
  if (entityType === EntityType.CUSTOMER) {
    const key = mapped.customerCode;
    return typeof key === "string" ? key : null;
  }
  if (entityType === EntityType.ITEM) {
    const key = mapped.itemCode;
    return typeof key === "string" ? key : null;
  }
  if (entityType === EntityType.PAYMENT_TERM) {
    const key = mapped.code;
    return typeof key === "string" ? key : null;
  }
  return null;
}

async function resolvePaymentTermId(
  tenantId: string,
  mappedCustomer: z.infer<typeof customerMappedSchema>
): Promise<string> {
  if (mappedCustomer.defaultTermId) {
    const term = await prisma.paymentTerm.findFirst({
      where: { tenantId, id: mappedCustomer.defaultTermId, isActive: true },
      select: { id: true }
    });
    if (!term) {
      throw new Error(`Payment term id "${mappedCustomer.defaultTermId}" not found.`);
    }
    return term.id;
  }

  if (mappedCustomer.defaultTermCode) {
    const term = await prisma.paymentTerm.findFirst({
      where: { tenantId, code: mappedCustomer.defaultTermCode, isActive: true },
      select: { id: true }
    });
    if (!term) {
      throw new Error(`Payment term code "${mappedCustomer.defaultTermCode}" not found.`);
    }
    return term.id;
  }

  const fallback = await prisma.paymentTerm.findFirst({
    where: { tenantId, isActive: true },
    orderBy: { createdAt: "asc" },
    select: { id: true }
  });
  if (!fallback) {
    throw new Error("No active payment term found for customer import.");
  }
  return fallback.id;
}

async function upsertEntity(
  tenantId: string,
  entityType: EntityType,
  mapped: Record<string, unknown>
): Promise<void> {
  if (entityType === EntityType.CUSTOMER) {
    const payload = customerMappedSchema.parse(mapped);
    const defaultTermId = await resolvePaymentTermId(tenantId, payload);
    let validatedCf: Prisma.InputJsonValue | undefined;
    if (payload.customFields && Object.keys(payload.customFields).length > 0) {
      const cfDefs = await prisma.customFieldDefinition.findMany({
        where: { tenantId, entityType: EntityType.CUSTOMER, isActive: true },
        select: { fieldKey: true, dataType: true, isRequired: true, isActive: true, optionsJson: true }
      });
      validatedCf = validateCustomFields(connectorAppShim, cfDefs, payload.customFields as Record<string, unknown>);
    }

    // Same uniqueness rule the create/edit form enforces.
    if (payload.taxId) {
      const taxIdDuplicate = await prisma.customer.findFirst({
        where: {
          tenantId,
          taxId: payload.taxId,
          NOT: { customerCode: payload.customerCode }
        },
        select: { customerCode: true, name: true }
      });
      if (taxIdDuplicate) {
        throw new Error(
          `Tax ID "${payload.taxId}" is already registered to customer "${taxIdDuplicate.name}" (${taxIdDuplicate.customerCode}).`
        );
      }
    }

    await prisma.customer.upsert({
      where: {
        tenantId_customerCode: {
          tenantId,
          customerCode: payload.customerCode
        }
      },
      update: {
        name: payload.name,
        customerType: payload.customerType ?? undefined,
        taxId: payload.taxId ?? undefined,
        ownerId: payload.ownerId ?? undefined,
        siteLat: payload.siteLat ?? undefined,
        siteLng: payload.siteLng ?? undefined,
        externalRef: payload.externalRef ?? undefined,
        defaultTermId,
        customFields: validatedCf ?? undefined
      },
      create: {
        tenantId,
        customerCode: payload.customerCode,
        name: payload.name,
        customerType: payload.customerType ?? undefined,
        taxId: payload.taxId ?? undefined,
        ownerId: payload.ownerId ?? undefined,
        siteLat: payload.siteLat ?? undefined,
        siteLng: payload.siteLng ?? undefined,
        externalRef: payload.externalRef ?? undefined,
        defaultTermId,
        customFields: validatedCf ?? undefined
      }
    });
    return;
  }

  if (entityType === EntityType.ITEM) {
    const payload = itemMappedSchema.parse(mapped);
    let validatedCf: Prisma.InputJsonValue | undefined;
    if (payload.customFields && Object.keys(payload.customFields).length > 0) {
      const cfDefs = await prisma.customFieldDefinition.findMany({
        where: { tenantId, entityType: EntityType.ITEM, isActive: true },
        select: { fieldKey: true, dataType: true, isRequired: true, isActive: true, optionsJson: true }
      });
      validatedCf = validateCustomFields(connectorAppShim, cfDefs, payload.customFields as Record<string, unknown>);
    }
    await prisma.item.upsert({
      where: {
        tenantId_itemCode: {
          tenantId,
          itemCode: payload.itemCode
        }
      },
      update: {
        name: payload.name,
        unitPrice: payload.unitPrice,
        customFields: validatedCf ?? undefined
      },
      create: {
        tenantId,
        itemCode: payload.itemCode,
        name: payload.name,
        unitPrice: payload.unitPrice,
        customFields: validatedCf ?? undefined
      }
    });
    return;
  }

  if (entityType === EntityType.PAYMENT_TERM) {
    const payload = paymentTermMappedSchema.parse(mapped);
    await prisma.paymentTerm.upsert({
      where: {
        tenantId_code: {
          tenantId,
          code: payload.code
        }
      },
      update: {
        name: payload.name,
        dueDays: payload.dueDays,
        isActive: true
      },
      create: {
        tenantId,
        code: payload.code,
        name: payload.name,
        dueDays: payload.dueDays,
        isActive: true
      }
    });
    return;
  }

  throw new Error(`Entity type "${entityType}" is not supported by master-data connector.`);
}

function makeError(
  rowRef: string,
  code: string,
  message: string,
  category: ConnectorErrorCategory = "validation",
  retryable = false
): ConnectorError {
  return {
    error_code: code,
    error_message: message,
    error_category: category,
    record_ref: rowRef,
    retryable,
    provider_status_code: null
  };
}

export async function executeConnectorRun(input: ConnectorRunInput): Promise<ConnectorRunResult> {
  const source = await prisma.integrationSource.findFirst({
    where: { id: input.sourceId, tenantId: input.tenantId },
    include: { mappings: true }
  });
  if (!source) {
    throw new Error("Source not found.");
  }
  if (source.sourceType !== input.sourceType) {
    throw new Error(`Source type mismatch. Expected ${source.sourceType}.`);
  }
  if (source.status !== SourceStatus.ENABLED) {
    throw new Error("Source is disabled.");
  }

  const mappings = source.mappings.filter((mapping) => mapping.entityType === input.entityType);
  if (mappings.length === 0) {
    throw new Error(`No mappings configured for entity type ${input.entityType}.`);
  }

  const startedAt = new Date();
  const job = await prisma.integrationSyncJob.create({
    data: {
      tenantId: input.tenantId,
      sourceId: input.sourceId,
      runType: input.runType,
      status: JobStatus.RUNNING,
      startedAt,
      summaryJson: {
        payload_ref: input.payloadRef,
        mapping_version: input.mappingVersion,
        idempotency_key: input.idempotencyKey,
        requested_by: input.requestedBy
      }
    }
  });

  const errors: ConnectorError[] = [];
  const seenKeys = new Set<string>();
  let successCount = 0;
  let duplicateCount = 0;

  for (let index = 0; index < input.records.length; index += 1) {
    const rowRef = String(index + 1);
    const rawRecord = input.records[index] ?? {};
    const { mapped, issues } = buildMappedRecord(rawRecord, mappings);
    if (issues.length > 0) {
      for (const issue of issues) {
        errors.push(makeError(rowRef, "MAPPING_REQUIRED_FIELD_MISSING", issue, "mapping"));
      }
      continue;
    }

    const rowDedupeKey = dedupeKey(input.entityType, mapped);
    if (rowDedupeKey && seenKeys.has(rowDedupeKey)) {
      duplicateCount += 1;
      continue;
    }
    if (rowDedupeKey) {
      seenKeys.add(rowDedupeKey);
    }

    try {
      await upsertEntity(input.tenantId, input.entityType, mapped);
      successCount += 1;
    } catch (error) {
      if (error instanceof z.ZodError) {
        errors.push(
          makeError(
            rowRef,
            "VALIDATION_FAILED",
            error.issues.map((issue) => issue.message).join(", "),
            "validation"
          )
        );
      } else if (error instanceof Error) {
        errors.push(makeError(rowRef, "UPSERT_FAILED", error.message, "internal"));
      } else {
        errors.push(makeError(rowRef, "UPSERT_FAILED", "Unknown processing error.", "internal"));
      }
    }
  }

  const completedAt = new Date();
  const failureCount = errors.length;
  const processedCount = input.records.length;
  const status: ConnectorSummary["status"] =
    failureCount === 0 ? "success" : successCount > 0 ? "partial_success" : "failed";

  if (errors.length > 0) {
    await prisma.integrationSyncError.createMany({
      data: errors.map((error) => ({
        jobId: job.id,
        entityType: input.entityType,
        rowRef: error.record_ref,
        errorCode: error.error_code,
        errorMessage: error.error_message
      }))
    });
  }

  const summary: ConnectorSummary = {
    status,
    processed_count: processedCount,
    success_count: successCount,
    failure_count: failureCount,
    duplicate_count: duplicateCount,
    started_at: startedAt.toISOString(),
    completed_at: completedAt.toISOString(),
    duration_ms: completedAt.getTime() - startedAt.getTime(),
    result_ref: `integration-jobs/${job.id}`
  };

  await prisma.integrationSyncJob.update({
    where: { id: job.id },
    data: {
      status: toRunStatus(summary),
      finishedAt: completedAt,
      summaryJson: {
        ...summary,
        payload_ref: input.payloadRef,
        mapping_version: input.mappingVersion,
        idempotency_key: input.idempotencyKey,
        requested_by: input.requestedBy
      }
    }
  });

  await prisma.integrationSource.update({
    where: { id: source.id },
    data: { lastSyncAt: completedAt }
  });

  return {
    jobId: job.id,
    summary,
    errors
  };
}
