import { EntityType } from "@prisma/client";
import { prisma } from "./prisma.js";
import { buildMappedRecord } from "../modules/integrations/connector-framework.js";

export type FieldMapping = {
  sourceField: string;
  targetField: string;
  transformRule: string | null;
  isRequired: boolean;
};

/**
 * After a sync run, saves external ID → internal entity ID mappings.
 *
 * Accepts raw ERP records + the source's field mappings so it can
 * translate raw field names (e.g. `cust_no`) to CRM field names
 * (e.g. `customerCode`) before looking up internal entity IDs.
 */
export async function saveSyncExternalRefs(opts: {
  tenantId: string;
  entityType: EntityType;
  records: Record<string, unknown>[];
  externalSource: string;
  externalIdField: string;
  mappings?: FieldMapping[];
}): Promise<{ saved: number; skipped: number }> {
  const { tenantId, entityType, records, externalSource, externalIdField, mappings } = opts;
  let saved = 0;
  let skipped = 0;

  for (const record of records) {
    const externalId = record[externalIdField];
    if (typeof externalId !== "string" && typeof externalId !== "number") {
      skipped++;
      continue;
    }
    const externalIdStr = String(externalId);

    // Apply field mappings to translate raw ERP fields → CRM fields.
    // Without mappings, assume the record already uses CRM field names.
    const resolveRecord = mappings?.length
      ? buildMappedRecord(record, mappings).mapped
      : record;

    const entityId = await resolveEntityId(tenantId, entityType, resolveRecord);
    if (!entityId) {
      skipped++;
      continue;
    }

    await prisma.syncExternalRef.upsert({
      where: {
        tenantId_entityType_externalId_externalSource: {
          tenantId,
          entityType,
          externalId: externalIdStr,
          externalSource,
        },
      },
      update: { entityId, updatedAt: new Date() },
      create: {
        tenantId,
        entityType,
        entityId,
        externalId: externalIdStr,
        externalSource,
      },
    });
    saved++;
  }

  return { saved, skipped };
}

/**
 * Resolves the internal entity ID from a record's mapped fields.
 * Uses the same business key logic as the connector framework.
 */
async function resolveEntityId(
  tenantId: string,
  entityType: EntityType,
  record: Record<string, unknown>,
): Promise<string | null> {
  if (entityType === EntityType.CUSTOMER) {
    const code = record.customerCode;
    if (typeof code !== "string") return null;
    // customerCode is unique only among ACTIVE rows (partial index) — DRAFT
    // customers have NULL codes so findFirst is correct here.
    const entity = await prisma.customer.findFirst({
      where: { tenantId, customerCode: code, status: "ACTIVE" },
      select: { id: true },
    });
    return entity?.id ?? null;
  }

  if (entityType === EntityType.ITEM) {
    const code = record.itemCode;
    if (typeof code !== "string") return null;
    const entity = await prisma.item.findUnique({
      where: { tenantId_itemCode: { tenantId, itemCode: code } },
      select: { id: true },
    });
    return entity?.id ?? null;
  }

  if (entityType === EntityType.PAYMENT_TERM) {
    const code = record.code;
    if (typeof code !== "string") return null;
    const entity = await prisma.paymentTerm.findFirst({
      where: { tenantId, code },
      select: { id: true },
    });
    return entity?.id ?? null;
  }

  return null;
}

/**
 * Lookup: given an external ID + source, find the internal CRM entity ID.
 * Useful for reverse lookups when the ERP references a CRM entity.
 */
export async function lookupByExternalId(
  tenantId: string,
  entityType: EntityType,
  externalId: string,
  externalSource: string,
): Promise<string | null> {
  const ref = await prisma.syncExternalRef.findUnique({
    where: {
      tenantId_entityType_externalId_externalSource: {
        tenantId, entityType, externalId, externalSource,
      },
    },
    select: { entityId: true },
  });
  return ref?.entityId ?? null;
}
