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

// CSV/MySQL/Excel often deliver booleans as 0/1 or "true"/"false". Coerce
// before validation so imports don't fail on benign type drift.
const flexibleBoolean = z.preprocess((v) => {
  if (typeof v === "boolean") return v;
  if (v === 1) return true;
  if (v === 0) return false;
  if (typeof v === "string") {
    const s = v.trim().toLowerCase();
    if (["true", "1", "yes", "y"].includes(s)) return true;
    if (["false", "0", "no", "n"].includes(s)) return false;
  }
  return v;
}, z.boolean());

const customerMappedSchema = z.object({
  customerCode: z.string().min(2).max(40),
  name: z.string().min(2).max(200),
  customerType: z.nativeEnum(CustomerType).optional(),
  taxId: z.string().max(20).optional(),
  // Thai-style branch code (e.g. "00000" = HQ). Defaults to "00000"
  // server-side when taxId is set but branchCode is missing.
  branchCode: z.string().regex(/^[0-9]{1,5}$/).optional(),
  ownerId: z.string().min(1).optional(),
  siteLat: z.number().min(-90).max(90).optional(),
  siteLng: z.number().min(-180).max(180).optional(),
  externalRef: z.string().trim().max(100).optional(),
  disabled: flexibleBoolean.optional(),
  customFields: z.record(z.string(), z.unknown()).optional()
});

const itemMappedSchema = z.object({
  itemCode: z.string().min(1),
  name: z.string().min(1),
  unitPrice: z.number().nonnegative(),
  externalRef: z.string().trim().max(100).optional(),
  isActive: flexibleBoolean.optional(),
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

export type ChunkProcessResult = {
  successCount: number;
  duplicateCount: number;
  errors: ConnectorError[];
};

export type FieldMapping = {
  sourceField: string;
  targetField: string;
  transformRule: string | null;
  isRequired: boolean;
};

/**
 * Process a chunk of records into an existing IntegrationSyncJob.
 * Used by chunked, resumable pulls (e.g. MySQL) where the job is created
 * up-front and the cron drains it in pieces. `rowOffset` is added to the
 * 1-based row index when emitting `record_ref` so error references stay
 * sensible across chunks (chunk 1 starts at 1, chunk 2 might start at 1001).
 *
 * `seenKeys` carries the in-memory dedupe set across chunks within the
 * same drain pass — it's a perf-only shortcut; the DB UNIQUE constraints
 * catch true duplicates regardless.
 */
// Per-chunk concurrency for upsertEntity. Each upsert involves 4-7 DB
// roundtrips; sequential processing is RTT-bound and gives ~50 rows/min on a
// typical Vercel→Neon link. Running 10 in parallel saturates Prisma's pool
// and lifts throughput ~5-10x with no schema or logic changes.
const UPSERT_CONCURRENCY = 10;

async function runWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await fn(items[i] as T, i);
    }
  });
  await Promise.all(workers);
  return results;
}

export async function processConnectorChunk(params: {
  tenantId: string;
  jobId: string;
  entityType: EntityType;
  mappings: FieldMapping[];
  records: ConnectorRecord[];
  rowOffset: number;
  seenKeys: Set<string>;
}): Promise<ChunkProcessResult> {
  const { tenantId, jobId, entityType, mappings, records, rowOffset, seenKeys } = params;
  const errors: ConnectorError[] = [];
  let successCount = 0;
  let duplicateCount = 0;

  // Phase 1 (sync, fast): map + dedupe each record. Collect (rowRef, mapped)
  // pairs that survive validation + dedup so we can run their upserts
  // concurrently. Mapping failures and in-chunk duplicates are handled here
  // sequentially since they don't touch the DB.
  type Pending = { rowRef: string; mapped: Record<string, unknown> };
  const pending: Pending[] = [];
  for (let index = 0; index < records.length; index += 1) {
    const rowRef = String(rowOffset + index + 1);
    const rawRecord = records[index] ?? {};
    const { mapped, issues } = buildMappedRecord(rawRecord, mappings);
    if (issues.length > 0) {
      for (const issue of issues) {
        errors.push(makeError(rowRef, "MAPPING_REQUIRED_FIELD_MISSING", issue, "mapping"));
      }
      continue;
    }
    const rowDedupeKey = dedupeKey(entityType, mapped);
    if (rowDedupeKey && seenKeys.has(rowDedupeKey)) {
      duplicateCount += 1;
      continue;
    }
    if (rowDedupeKey) seenKeys.add(rowDedupeKey);
    pending.push({ rowRef, mapped });
  }

  // Phase 2 (DB-bound): run upserts in parallel up to UPSERT_CONCURRENCY.
  await runWithConcurrency(pending, UPSERT_CONCURRENCY, async ({ rowRef, mapped }) => {
    try {
      await upsertEntity(tenantId, entityType, mapped);
      successCount += 1;
    } catch (error) {
      if (error instanceof z.ZodError) {
        errors.push(
          makeError(
            rowRef,
            "VALIDATION_FAILED",
            error.issues
              .map((issue) => {
                const path = issue.path.length > 0 ? issue.path.join(".") : "(root)";
                return `${path}: ${issue.message}`;
              })
              .join(", "),
            "validation"
          )
        );
      } else if (error instanceof Error) {
        errors.push(makeError(rowRef, "UPSERT_FAILED", error.message, "internal"));
      } else {
        errors.push(makeError(rowRef, "UPSERT_FAILED", "Unknown processing error.", "internal"));
      }
    }
  });

  if (errors.length > 0) {
    await prisma.integrationSyncError.createMany({
      data: errors.map((error) => ({
        jobId,
        entityType,
        rowRef: error.record_ref,
        errorCode: error.error_code,
        errorMessage: error.error_message
      }))
    });
  }

  return { successCount, duplicateCount, errors };
}

function toRunStatus(summary: ConnectorSummary): JobStatus {
  return summary.status === "failed" ? JobStatus.FAILED : JobStatus.SUCCESS;
}

type TransformStep = { rule: string; args?: Record<string, unknown> };

const MAX_TRANSFORM_DEPTH = 3;

function parseTransformRule(raw: string | null | undefined): TransformStep[] {
  if (!raw) return [];
  const trimmed = raw.trim();
  if (!trimmed) return [];
  if (!trimmed.startsWith("[") && !trimmed.startsWith("{")) {
    return [{ rule: trimmed.toLowerCase() }];
  }
  try {
    const parsed = JSON.parse(trimmed);
    if (Array.isArray(parsed)) {
      return parsed.filter((s): s is TransformStep => !!s && typeof s.rule === "string");
    }
  } catch {
    /* fall through */
  }
  return [];
}

function applyTransformChain(value: unknown, raw: string | null | undefined, depth = 0): unknown {
  if (depth > MAX_TRANSFORM_DEPTH) return value;
  let out = value;
  for (const step of parseTransformRule(raw)) {
    out = applyStep(out, step, depth);
  }
  return out;
}

function safeRegex(source: string, flags: string): RegExp | null {
  if (!source || source.length > 500) return null;
  try {
    return new RegExp(source, flags);
  } catch {
    return null;
  }
}

function evalCondition(value: unknown, cond: Record<string, unknown> | undefined): boolean {
  if (!cond || typeof cond !== "object") return false;
  const op = typeof cond.op === "string" ? cond.op : "";
  const target = cond.value;
  const numCmp = (cmp: (a: number, b: number) => boolean): boolean => {
    const a = typeof value === "number" ? value : Number(value);
    const b = typeof target === "number" ? target : Number(target);
    return Number.isFinite(a) && Number.isFinite(b) && cmp(a, b);
  };
  switch (op) {
    case "equals":           return String(value ?? "") === String(target ?? "");
    case "not_equals":       return String(value ?? "") !== String(target ?? "");
    case "greater":          return numCmp((a, b) => a > b);
    case "less":             return numCmp((a, b) => a < b);
    case "greater_or_equal": return numCmp((a, b) => a >= b);
    case "less_or_equal":    return numCmp((a, b) => a <= b);
    case "empty":            return value === null || value === undefined || value === "";
    case "not_empty":        return !(value === null || value === undefined || value === "");
    case "contains":         return typeof value === "string" && value.includes(String(target ?? ""));
    case "matches": {
      const re = safeRegex(String(target ?? ""), "");
      return !!re && typeof value === "string" && re.test(value);
    }
    default: return false;
  }
}

function expandValueToken(template: string, value: unknown): string {
  // {{value}} substitutes the input value as a string. Allows things like
  // setting "{{value}}" (keep original) or "${{value}}" (prepend a $).
  if (!template.includes("{{value}}")) return template;
  return template.split("{{value}}").join(value === null || value === undefined ? "" : String(value));
}

function applyStep(value: unknown, step: TransformStep, depth = 0): unknown {
  switch (step.rule) {
    case "trim":        return typeof value === "string" ? value.trim() : value;
    case "trim_inner":  return typeof value === "string" ? value.replace(/\s+/g, " ") : value;
    case "upper":       return typeof value === "string" ? value.toUpperCase() : value;
    case "lower":       return typeof value === "string" ? value.toLowerCase() : value;
    case "title":       return typeof value === "string"
                          ? value.replace(/\w\S*/g, (w) => (w[0] ?? "").toUpperCase() + w.slice(1).toLowerCase())
                          : value;
    case "digits_only": return typeof value === "string" ? value.replace(/\D+/g, "") : value;
    case "alnum_only":  return typeof value === "string" ? value.replace(/[^A-Za-z0-9]+/g, "") : value;
    case "number": {
      if (typeof value === "number") return value;
      if (typeof value === "string" && value.trim().length > 0) {
        const n = Number(value);
        return Number.isNaN(n) ? value : n;
      }
      return value;
    }
    case "integer": {
      const n = typeof value === "number" ? value : Number(value);
      return Number.isFinite(n) ? Math.floor(n) : value;
    }
    case "boolean": {
      if (typeof value === "boolean") return value;
      if (value === 1) return true;
      if (value === 0) return false;
      if (typeof value === "string") {
        const s = value.trim().toLowerCase();
        if (["true", "1", "yes", "y"].includes(s)) return true;
        if (["false", "0", "no", "n"].includes(s)) return false;
      }
      return value;
    }
    case "pad_left": {
      const len = Number(step.args?.len) || 0;
      const ch = typeof step.args?.char === "string" && step.args.char.length > 0
        ? String(step.args.char)
        : "0";
      return String(value ?? "").padStart(len, ch);
    }
    case "replace": {
      const from = String(step.args?.from ?? "");
      const to = String(step.args?.to ?? "");
      if (!from) return value;
      return typeof value === "string" ? value.split(from).join(to) : value;
    }
    case "prefix": return String(step.args?.text ?? "") + String(value ?? "");
    case "suffix": return String(value ?? "") + String(step.args?.text ?? "");
    case "default": {
      const isEmpty = value === null || value === undefined || value === "";
      return isEmpty ? String(step.args?.value ?? "") : value;
    }
    case "null_if": {
      const sentinel = String(step.args?.value ?? "");
      return typeof value === "string" && value === sentinel ? null : value;
    }
    case "match": {
      const re = safeRegex(String(step.args?.pattern ?? ""), String(step.args?.flags ?? ""));
      if (!re) return value;
      if (typeof value !== "string") return value;
      return re.test(value) ? value : "";
    }
    case "extract": {
      const re = safeRegex(String(step.args?.pattern ?? ""), String(step.args?.flags ?? ""));
      if (!re) return value;
      if (typeof value !== "string") return value;
      const m = re.exec(value);
      if (!m) return "";
      const group = Number(step.args?.group);
      const idx = Number.isFinite(group) && group >= 0 ? group : 1;
      return m[idx] ?? "";
    }
    case "set": {
      // Replace the value with the configured constant (used inside if/else
      // branches). Supports `{{value}}` as a placeholder for the original
      // value — e.g. "{{value}}" alone keeps it unchanged, ">{{value}}"
      // prepends ">", etc.
      const tpl = step.args?.value;
      if (tpl === null || tpl === undefined) return "";
      return expandValueToken(String(tpl), value);
    }
    case "if": {
      if (depth >= MAX_TRANSFORM_DEPTH) return value;
      const args = (step.args ?? {}) as Record<string, unknown>;
      const cond = args.cond as Record<string, unknown> | undefined;
      const branch = evalCondition(value, cond) ? args.then : args.else;
      if (!Array.isArray(branch)) return value;
      let out = value;
      for (const s of branch) {
        if (s && typeof (s as TransformStep).rule === "string") {
          out = applyStep(out, s as TransformStep, depth + 1);
        }
      }
      return out;
    }
    default: return value;
  }
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
    mapped[mapping.targetField] = applyTransformChain(raw, mapping.transformRule);
  }
  return { mapped, issues };
}

function dedupeKey(entityType: EntityType, mapped: Record<string, unknown>): string | null {
  if (entityType === EntityType.CUSTOMER) {
    const ext = mapped.externalRef;
    if (typeof ext === "string" && ext.length > 0) return `ext:${ext}`;
    const key = mapped.customerCode;
    return typeof key === "string" ? key : null;
  }
  if (entityType === EntityType.ITEM) {
    const ext = mapped.externalRef;
    if (typeof ext === "string" && ext.length > 0) return `ext:${ext}`;
    const key = mapped.itemCode;
    return typeof key === "string" ? key : null;
  }
  if (entityType === EntityType.PAYMENT_TERM) {
    const key = mapped.code;
    return typeof key === "string" ? key : null;
  }
  return null;
}

async function resolveOwnerId(tenantId: string, raw: string | undefined): Promise<string | undefined> {
  if (!raw) return undefined;
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  const byId = await prisma.user.findFirst({
    where: { tenantId, id: trimmed },
    select: { id: true }
  });
  if (byId) return byId.id;
  const byEmail = await prisma.user.findFirst({
    where: { tenantId, email: trimmed.toLowerCase() },
    select: { id: true }
  });
  if (byEmail) return byEmail.id;
  return undefined;
}

async function upsertEntity(
  tenantId: string,
  entityType: EntityType,
  mapped: Record<string, unknown>
): Promise<void> {
  if (entityType === EntityType.CUSTOMER) {
    // Federated tenants: this scheduled pull is allowed to keep shadow rows
    // populated (so FKs from Deal/Quotation/Visit have a target) but it must
    // NOT overwrite attributes that are read live from the upstream MySQL.
    // Strip everything outside the shadow allowlist before upserting.
    const tenant = await prisma.tenant.findUnique({
      where: { id: tenantId },
      select: { customerFederationSourceId: true }
    });
    if (tenant?.customerFederationSourceId) {
      const SHADOW_FIELDS = new Set([
        "customerCode",
        "name",
        "externalRef",
        "customerType",
        // `disabled` is enforced locally — assertCustomerBelongsToTenant +
        // createVisitRecord both reject disabled customers — so we MUST
        // persist it on the shadow row to honor the upstream's flag.
        "disabled",
        // `ownerId` is a FK to User.id used by /customers list, kanban, and
        // dashboard team filters. Persist so the operator-defined mapping
        // (e.g. ERPNext's `sale_person` → User email) actually drives CRM
        // ownership. Without this, federated customers stay NULL-owner and
        // are invisible in every owner-scoped query.
        "ownerId"
      ]);
      mapped = Object.fromEntries(
        Object.entries(mapped).filter(([k]) => SHADOW_FIELDS.has(k))
      );
    }
    const payload = customerMappedSchema.parse(mapped);
    const resolvedOwnerId = await resolveOwnerId(tenantId, payload.ownerId);
    let validatedCf: Prisma.InputJsonValue | undefined;
    if (payload.customFields && Object.keys(payload.customFields).length > 0) {
      const cfDefs = await prisma.customFieldDefinition.findMany({
        where: { tenantId, entityType: EntityType.CUSTOMER, isActive: true },
        select: { fieldKey: true, dataType: true, isRequired: true, isActive: true, optionsJson: true }
      });
      validatedCf = validateCustomFields(connectorAppShim, cfDefs, payload.customFields as Record<string, unknown>);
    }

    // Default branch code to "00000" (HQ) whenever a Tax ID is present.
    const incomingBranchCode = payload.taxId
      ? (payload.branchCode ?? "00000")
      : null;

    // Field-prospect auto-promotion: if a rep previously created a DRAFT for
    // this prospect with the same (Tax ID, branchCode), ERP is now confirming
    // it. Fill in the missing code/term/ref and flip to ACTIVE instead of
    // inserting a new row — visits and deals already point at this id.
    if (payload.taxId) {
      const draftMatch = await prisma.customer.findFirst({
        where: {
          tenantId,
          taxId: payload.taxId,
          branchCode: incomingBranchCode,
          status: "DRAFT"
        },
        select: {
          id: true,
          customerCode: true,
          name: true,
          status: true,
          externalRef: true,
          customerType: true
        }
      });
      if (draftMatch) {
        await prisma.customer.update({
          where: { id: draftMatch.id },
          data: {
            status: "ACTIVE",
            promotedAt: new Date(),
            customerCode: payload.customerCode,
            name: payload.name,
            customerType: payload.customerType ?? undefined,
            branchCode: incomingBranchCode,
            ownerId: resolvedOwnerId,
            siteLat: payload.siteLat ?? undefined,
            siteLng: payload.siteLng ?? undefined,
            externalRef: payload.externalRef ?? undefined,
            disabled: payload.disabled ?? undefined,
            customFields: validatedCf ?? undefined
          }
        });
        await prisma.entityChangelog.create({
          data: {
            tenantId,
            entityType: EntityType.CUSTOMER,
            entityId: draftMatch.id,
            action: "UPDATE",
            beforeJson: draftMatch as unknown as Prisma.InputJsonValue,
            afterJson: {
              status: "ACTIVE",
              customerCode: payload.customerCode,
              name: payload.name,
              branchCode: incomingBranchCode
            } as Prisma.InputJsonValue,
            contextJson: {
              reason: "promoted_via_sync",
              taxId: payload.taxId,
              branchCode: incomingBranchCode
            } as Prisma.InputJsonValue
          }
        });
        return;
      }

      // No DRAFT match — look for an ACTIVE customer with the same
      // (Tax ID, branchCode). If its code is a CRM-internal placeholder
      // (C-NNNNNN, generated when a rep created the customer in CRM before
      // ERP sync ran), rename it to the ERP's customerCode and update its
      // fields. This is the inverse of the DRAFT-promotion path: the row
      // already exists ACTIVE, we're just adopting the ERP-issued code.
      const activeTaxIdDuplicate = await prisma.customer.findFirst({
        where: {
          tenantId,
          taxId: payload.taxId,
          branchCode: incomingBranchCode,
          status: "ACTIVE",
          NOT: { customerCode: payload.customerCode }
        },
        select: {
          id: true, customerCode: true, name: true, branchCode: true,
          status: true, externalRef: true, customerType: true
        }
      });
      if (activeTaxIdDuplicate) {
        const isCrmInternalCode = /^C-\d+$/i.test(activeTaxIdDuplicate.customerCode ?? "");
        if (isCrmInternalCode) {
          await prisma.customer.update({
            where: { id: activeTaxIdDuplicate.id },
            data: {
              customerCode: payload.customerCode,
              name: payload.name,
              customerType: payload.customerType ?? undefined,
              branchCode: incomingBranchCode,
              ownerId: resolvedOwnerId,
              siteLat: payload.siteLat ?? undefined,
              siteLng: payload.siteLng ?? undefined,
              externalRef: payload.externalRef ?? undefined,
              disabled: payload.disabled ?? undefined,
              customFields: validatedCf ?? undefined
            }
          });
          await prisma.entityChangelog.create({
            data: {
              tenantId,
              entityType: EntityType.CUSTOMER,
              entityId: activeTaxIdDuplicate.id,
              action: "UPDATE",
              beforeJson: activeTaxIdDuplicate as unknown as Prisma.InputJsonValue,
              afterJson: {
                customerCode: payload.customerCode,
                name: payload.name,
                branchCode: incomingBranchCode
              } as Prisma.InputJsonValue,
              contextJson: {
                reason: "renamed_crm_internal_code_via_sync",
                previousCode: activeTaxIdDuplicate.customerCode,
                taxId: payload.taxId,
                branchCode: incomingBranchCode
              } as Prisma.InputJsonValue
            }
          });
          return;
        }
        throw new Error(
          `Tax ID "${payload.taxId}" branch "${incomingBranchCode}" is already registered to customer "${activeTaxIdDuplicate.name}" (${activeTaxIdDuplicate.customerCode}).`
        );
      }
    }

    if (payload.externalRef) {
      const existing = await prisma.customer.findFirst({
        where: { tenantId, externalRef: payload.externalRef },
        select: { id: true }
      });
      if (existing) {
        await prisma.customer.update({
          where: { id: existing.id },
          data: {
            status: "ACTIVE",
            customerCode: payload.customerCode,
            name: payload.name,
            customerType: payload.customerType ?? undefined,
            taxId: payload.taxId ?? undefined,
            branchCode: incomingBranchCode,
            ownerId: resolvedOwnerId,
            siteLat: payload.siteLat ?? undefined,
            siteLng: payload.siteLng ?? undefined,
            disabled: payload.disabled ?? undefined,
            customFields: validatedCf ?? undefined
          }
        });
        return;
      }
    }

    // customerCode uniqueness is now a partial index on ACTIVE rows, so an
    // upsert against a compound unique no longer fits — use findFirst + branch.
    const existingByCode = await prisma.customer.findFirst({
      where: { tenantId, customerCode: payload.customerCode, status: "ACTIVE" },
      select: { id: true }
    });
    if (existingByCode) {
      await prisma.customer.update({
        where: { id: existingByCode.id },
        data: {
          name: payload.name,
          customerType: payload.customerType ?? undefined,
          taxId: payload.taxId ?? undefined,
          branchCode: incomingBranchCode,
          ownerId: resolvedOwnerId,
          siteLat: payload.siteLat ?? undefined,
          siteLng: payload.siteLng ?? undefined,
          externalRef: payload.externalRef ?? undefined,
          disabled: payload.disabled ?? undefined,
          customFields: validatedCf ?? undefined
        }
      });
    } else {
      await prisma.customer.create({
        data: {
          tenantId,
          status: "ACTIVE",
          customerCode: payload.customerCode,
          name: payload.name,
          customerType: payload.customerType ?? undefined,
          taxId: payload.taxId ?? undefined,
          branchCode: incomingBranchCode,
          ownerId: resolvedOwnerId,
          siteLat: payload.siteLat ?? undefined,
          siteLng: payload.siteLng ?? undefined,
          externalRef: payload.externalRef ?? undefined,
          disabled: payload.disabled ?? false,
          customFields: validatedCf ?? undefined
        }
      });
    }
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
    if (payload.externalRef) {
      const existing = await prisma.item.findFirst({
        where: { tenantId, externalRef: payload.externalRef },
        select: { id: true }
      });
      if (existing) {
        await prisma.item.update({
          where: { id: existing.id },
          data: {
            itemCode: payload.itemCode,
            name: payload.name,
            unitPrice: payload.unitPrice,
            isActive: payload.isActive ?? undefined,
            customFields: validatedCf ?? undefined
          }
        });
        return;
      }
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
        externalRef: payload.externalRef ?? undefined,
        isActive: payload.isActive ?? undefined,
        customFields: validatedCf ?? undefined
      },
      create: {
        tenantId,
        itemCode: payload.itemCode,
        name: payload.name,
        unitPrice: payload.unitPrice,
        externalRef: payload.externalRef ?? undefined,
        isActive: payload.isActive ?? true,
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
            error.issues
              .map((issue) => {
                const path = issue.path.length > 0 ? issue.path.join(".") : "(root)";
                return `${path}: ${issue.message}`;
              })
              .join(", "),
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
