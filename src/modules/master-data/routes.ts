import type { FastifyPluginAsync } from "fastify";
import { CustomFieldDataType, EntityType, Prisma, UserRole } from "@prisma/client";
import { z } from "zod";
import { listVisibleUserIds, requireRoleAtLeast, requireTenantId, requireUserId } from "../../lib/http.js";
import { writeEntityChangelog } from "../../lib/changelog.js";
import { prisma } from "../../lib/prisma.js";

const customFieldValuesSchema = z.record(z.string(), z.unknown());

const customFieldDefinitionCreateSchema = z
  .object({
    fieldKey: z
      .string()
      .min(2)
      .max(40)
      .regex(/^[a-zA-Z][a-zA-Z0-9_]*$/, "fieldKey must be snake_case/alphanumeric."),
    label: z.string().min(1).max(80),
    dataType: z.nativeEnum(CustomFieldDataType),
    isRequired: z.boolean().optional(),
    isActive: z.boolean().optional(),
    displayOrder: z.number().int().min(0).max(999).optional(),
    options: z.array(z.string().min(1).max(80)).max(30).optional(),
    placeholder: z.string().max(120).optional()
  })
  .superRefine((value, ctx) => {
    if (value.dataType === CustomFieldDataType.SELECT && !value.options?.length) {
      ctx.addIssue({
        path: ["options"],
        code: "custom",
        message: "SELECT fields require at least one option."
      });
    }
    if (value.dataType !== CustomFieldDataType.SELECT && value.options?.length) {
      ctx.addIssue({
        path: ["options"],
        code: "custom",
        message: "Options are only supported for SELECT fields."
      });
    }
  });

const customFieldDefinitionUpdateSchema = z
  .object({
    label: z.string().min(1).max(80).optional(),
    isRequired: z.boolean().optional(),
    isActive: z.boolean().optional(),
    displayOrder: z.number().int().min(0).max(999).optional(),
    options: z.array(z.string().min(1).max(80)).max(30).optional(),
    placeholder: z.string().max(120).nullable().optional()
  })
  .refine((value) => Object.keys(value).length > 0, {
    message: "At least one field is required for update."
  });

const paymentTermSchema = z.object({
  code: z.string().min(2).max(30),
  name: z.string().min(2).max(120),
  dueDays: z.number().int().min(0).max(365),
  customFields: customFieldValuesSchema.optional()
});
const paymentTermUpdateSchema = paymentTermSchema.partial().extend({
  isActive: z.boolean().optional()
});

const customerSchema = z.object({
  customerCode: z.string().min(2).max(40),
  name: z.string().min(2).max(200),
  defaultTermId: z.string().min(1),
  ownerId: z.string().optional(),
  siteLat: z.number().min(-90).max(90).optional(),
  siteLng: z.number().min(-180).max(180).optional(),
  customFields: customFieldValuesSchema.optional()
});
const customerUpdateSchema = customerSchema.partial().extend({
  defaultTermId: z.string().min(1).optional()
});

const itemSchema = z.object({
  itemCode: z.string().min(1).max(40),
  name: z.string().min(2).max(200),
  unitPrice: z.number().nonnegative(),
  customFields: customFieldValuesSchema.optional()
});
const itemUpdateSchema = itemSchema.partial();

const customerAddressSchema = z.object({
  addressLine1: z.string().min(1),
  city: z.string().optional(),
  state: z.string().optional(),
  country: z.string().optional(),
  postalCode: z.string().optional(),
  latitude: z.number().min(-90).max(90).optional(),
  longitude: z.number().min(-180).max(180).optional()
});

const customerContactSchema = z.object({
  name: z.string().min(1),
  position: z.string().min(1),
  customFields: customFieldValuesSchema.optional()
});

function resolveCustomFieldEntityType(raw: string, app: Parameters<FastifyPluginAsync>[0]): EntityType {
  const normalized = raw.trim().toLowerCase();
  if (normalized === "customer" || normalized === "customers") return EntityType.CUSTOMER;
  if (normalized === "item" || normalized === "items") return EntityType.ITEM;
  if (
    normalized === "payment-term" ||
    normalized === "payment_term" ||
    normalized === "paymentterm" ||
    normalized === "payment-terms"
  ) {
    return EntityType.PAYMENT_TERM;
  }
  throw app.httpErrors.badRequest("Unsupported entity type. Use customer, item, or payment-term.");
}

function asRecord(input: unknown): Record<string, unknown> {
  if (!input || Array.isArray(input) || typeof input !== "object") return {};
  return input as Record<string, unknown>;
}

function normalizeCustomFieldValue(
  app: Parameters<FastifyPluginAsync>[0],
  definition: {
    fieldKey: string;
    dataType: CustomFieldDataType;
    optionsJson: Prisma.JsonValue | null;
  },
  value: unknown
): unknown {
  switch (definition.dataType) {
    case CustomFieldDataType.TEXT: {
      if (typeof value !== "string") {
        throw app.httpErrors.badRequest(`Custom field "${definition.fieldKey}" must be text.`);
      }
      const trimmed = value.trim();
      return trimmed.length ? trimmed : null;
    }
    case CustomFieldDataType.NUMBER: {
      const numeric =
        typeof value === "number"
          ? value
          : typeof value === "string" && value.trim().length > 0
            ? Number(value)
            : Number.NaN;
      if (!Number.isFinite(numeric)) {
        throw app.httpErrors.badRequest(`Custom field "${definition.fieldKey}" must be numeric.`);
      }
      return numeric;
    }
    case CustomFieldDataType.BOOLEAN: {
      if (typeof value === "boolean") return value;
      if (typeof value === "string") {
        if (value === "true") return true;
        if (value === "false") return false;
      }
      throw app.httpErrors.badRequest(`Custom field "${definition.fieldKey}" must be boolean.`);
    }
    case CustomFieldDataType.DATE: {
      if (typeof value !== "string") {
        throw app.httpErrors.badRequest(`Custom field "${definition.fieldKey}" must be an ISO date string.`);
      }
      const parsedDate = new Date(value);
      if (Number.isNaN(parsedDate.getTime())) {
        throw app.httpErrors.badRequest(`Custom field "${definition.fieldKey}" has invalid date format.`);
      }
      return parsedDate.toISOString();
    }
    case CustomFieldDataType.SELECT: {
      if (typeof value !== "string" || !value.trim().length) {
        throw app.httpErrors.badRequest(`Custom field "${definition.fieldKey}" must be a non-empty option.`);
      }
      const options = Array.isArray(definition.optionsJson)
        ? definition.optionsJson.filter((option): option is string => typeof option === "string")
        : [];
      if (!options.includes(value)) {
        throw app.httpErrors.badRequest(
          `Custom field "${definition.fieldKey}" value must match configured options.`
        );
      }
      return value;
    }
    default:
      return value;
  }
}

function validateCustomFields(
  app: Parameters<FastifyPluginAsync>[0],
  definitions: Array<{
    fieldKey: string;
    dataType: CustomFieldDataType;
    isRequired: boolean;
    isActive: boolean;
    optionsJson: Prisma.JsonValue | null;
  }>,
  rawValues: Record<string, unknown>
): Prisma.InputJsonValue | undefined {
  const activeDefinitions = definitions.filter((definition) => definition.isActive);
  const definitionMap = new Map(activeDefinitions.map((definition) => [definition.fieldKey, definition]));
  const normalized: Record<string, unknown> = {};

  for (const [fieldKey, rawValue] of Object.entries(rawValues)) {
    const definition = definitionMap.get(fieldKey);
    if (!definition) {
      throw app.httpErrors.badRequest(`Unknown or inactive custom field "${fieldKey}".`);
    }
    const normalizedValue = normalizeCustomFieldValue(app, definition, rawValue);
    if (normalizedValue === null || normalizedValue === undefined || normalizedValue === "") continue;
    normalized[fieldKey] = normalizedValue;
  }

  for (const definition of activeDefinitions.filter((definition) => definition.isRequired)) {
    if (!Object.hasOwn(normalized, definition.fieldKey)) {
      throw app.httpErrors.badRequest(`Missing required custom field "${definition.fieldKey}".`);
    }
  }

  return Object.keys(normalized).length ? (normalized as Prisma.InputJsonValue) : undefined;
}

export const masterDataRoutes: FastifyPluginAsync = async (app) => {
  async function findCustomerInScopeOrThrow(input: {
    tenantId: string;
    customerId: string;
    visibleUserIds: string[];
  }) {
    const customer = await prisma.customer.findFirst({
      where: {
        id: input.customerId,
        tenantId: input.tenantId,
        ownerId: { in: input.visibleUserIds }
      }
    });
    if (!customer) {
      throw app.httpErrors.notFound("Customer not found.");
    }
    return customer;
  }

  app.get("/custom-fields/:entityType", async (request) => {
    const tenantId = requireTenantId(request);
    const params = request.params as { entityType: string };
    const entityType = resolveCustomFieldEntityType(params.entityType, app);
    return prisma.customFieldDefinition.findMany({
      where: { tenantId, entityType },
      orderBy: [{ displayOrder: "asc" }, { createdAt: "asc" }]
    });
  });

  app.post("/custom-fields/:entityType", async (request, reply) => {
    requireRoleAtLeast(request, UserRole.ADMIN);
    const tenantId = requireTenantId(request);
    const params = request.params as { entityType: string };
    const entityType = resolveCustomFieldEntityType(params.entityType, app);
    const parsed = customFieldDefinitionCreateSchema.safeParse(request.body);
    if (!parsed.success) {
      throw app.httpErrors.badRequest(parsed.error.message);
    }
    const created = await prisma.customFieldDefinition.create({
      data: {
        tenantId,
        entityType,
        fieldKey: parsed.data.fieldKey,
        label: parsed.data.label,
        dataType: parsed.data.dataType,
        isRequired: parsed.data.isRequired ?? false,
        isActive: parsed.data.isActive ?? true,
        displayOrder: parsed.data.displayOrder ?? 0,
        optionsJson:
          parsed.data.dataType === CustomFieldDataType.SELECT
            ? parsed.data.options ?? []
            : Prisma.DbNull,
        placeholder: parsed.data.placeholder
      }
    });
    return reply.code(201).send(created);
  });

  app.patch("/custom-fields/:entityType/:id", async (request) => {
    requireRoleAtLeast(request, UserRole.ADMIN);
    const tenantId = requireTenantId(request);
    const params = request.params as { entityType: string; id: string };
    const entityType = resolveCustomFieldEntityType(params.entityType, app);
    const parsed = customFieldDefinitionUpdateSchema.safeParse(request.body);
    if (!parsed.success) {
      throw app.httpErrors.badRequest(parsed.error.message);
    }
    const existing = await prisma.customFieldDefinition.findFirst({
      where: { id: params.id, tenantId, entityType }
    });
    if (!existing) {
      throw app.httpErrors.notFound("Custom field definition not found.");
    }
    const nextOptions =
      parsed.data.options !== undefined
        ? existing.dataType === CustomFieldDataType.SELECT
          ? parsed.data.options
          : Prisma.DbNull
        : undefined;
    return prisma.customFieldDefinition.update({
      where: { id: params.id },
      data: {
        label: parsed.data.label,
        isRequired: parsed.data.isRequired,
        isActive: parsed.data.isActive,
        displayOrder: parsed.data.displayOrder,
        optionsJson: nextOptions,
        placeholder: parsed.data.placeholder === null ? null : parsed.data.placeholder
      }
    });
  });

  app.get("/payment-terms", async (request) => {
    const tenantId = requireTenantId(request);
    return prisma.paymentTerm.findMany({
      where: { tenantId },
      orderBy: { createdAt: "desc" }
    });
  });

  app.post("/payment-terms", async (request, reply) => {
    requireRoleAtLeast(request, UserRole.MANAGER);
    const tenantId = requireTenantId(request);
    const parsed = paymentTermSchema.safeParse(request.body);
    if (!parsed.success) {
      throw app.httpErrors.badRequest(parsed.error.message);
    }
    const definitions = await prisma.customFieldDefinition.findMany({
      where: { tenantId, entityType: EntityType.PAYMENT_TERM }
    });
    const customFields = validateCustomFields(app, definitions, parsed.data.customFields ?? {});
    const created = await prisma.paymentTerm.create({
      data: {
        tenantId,
        code: parsed.data.code,
        name: parsed.data.name,
        dueDays: parsed.data.dueDays,
        customFields
      }
    });
    return reply.code(201).send(created);
  });

  app.patch("/payment-terms/:id", async (request) => {
    requireRoleAtLeast(request, UserRole.MANAGER);
    const tenantId = requireTenantId(request);
    const params = request.params as { id: string };
    const parsed = paymentTermUpdateSchema.safeParse(request.body);
    if (!parsed.success) {
      throw app.httpErrors.badRequest(parsed.error.message);
    }
    const existing = await prisma.paymentTerm.findFirst({
      where: { id: params.id, tenantId }
    });
    if (!existing) {
      throw app.httpErrors.notFound("Payment term not found.");
    }
    let customFields: Prisma.InputJsonValue | undefined;
    if (parsed.data.customFields !== undefined) {
      const definitions = await prisma.customFieldDefinition.findMany({
        where: { tenantId, entityType: EntityType.PAYMENT_TERM }
      });
      customFields = validateCustomFields(app, definitions, {
        ...asRecord(existing.customFields),
        ...parsed.data.customFields
      });
    }
    return prisma.paymentTerm.update({
      where: { id: params.id },
      data: {
        code: parsed.data.code,
        name: parsed.data.name,
        dueDays: parsed.data.dueDays,
        isActive: parsed.data.isActive,
        customFields
      }
    });
  });

  app.get("/customers", async (request) => {
    const tenantId = requireTenantId(request);
    const visibleUserIdList = [...(await listVisibleUserIds(request))];
    return prisma.customer.findMany({
      where: { tenantId, ownerId: { in: visibleUserIdList } },
      include: {
        addresses: true,
        contacts: true,
        paymentTerm: true
      },
      orderBy: { createdAt: "desc" }
    });
  });

  app.get("/customers/:id", async (request) => {
    const tenantId = requireTenantId(request);
    const visibleUserIdList = [...(await listVisibleUserIds(request))];
    const params = request.params as { id: string };
    const customer = await prisma.customer.findFirst({
      where: { id: params.id, tenantId, ownerId: { in: visibleUserIdList } },
      include: {
        addresses: true,
        contacts: true,
        paymentTerm: true
      }
    });
    if (!customer) {
      throw app.httpErrors.notFound("Customer not found.");
    }
    return customer;
  });

  app.post("/customers", async (request, reply) => {
    const tenantId = requireTenantId(request);
    const changedById = requireUserId(request);
    const visibleUserIds = await listVisibleUserIds(request);
    const parsed = customerSchema.safeParse(request.body);
    if (!parsed.success) {
      throw app.httpErrors.badRequest(parsed.error.message);
    }
    const paymentTerm = await prisma.paymentTerm.findFirst({
      where: { id: parsed.data.defaultTermId, tenantId, isActive: true },
      select: { id: true }
    });
    if (!paymentTerm) {
      throw app.httpErrors.badRequest("defaultTermId is invalid or inactive for this tenant.");
    }

    const ownerId = parsed.data.ownerId ?? changedById;
    if (!visibleUserIds.has(ownerId)) {
      throw app.httpErrors.forbidden("customer owner must be within your hierarchy scope.");
    }

    const definitions = await prisma.customFieldDefinition.findMany({
      where: { tenantId, entityType: EntityType.CUSTOMER }
    });
    const customFields = validateCustomFields(app, definitions, parsed.data.customFields ?? {});
    const created = await prisma.$transaction(async (tx) => {
      const row = await tx.customer.create({
        data: {
          tenantId,
          customerCode: parsed.data.customerCode,
          name: parsed.data.name,
          defaultTermId: parsed.data.defaultTermId,
          ownerId,
          customFields
        }
      });
      await writeEntityChangelog({
        db: tx,
        tenantId,
        entityType: EntityType.CUSTOMER,
        entityId: row.id,
        action: "CREATE",
        changedById,
        after: row
      });
      return row;
    });
    return reply.code(201).send(created);
  });

  app.patch("/customers/:id", async (request) => {
    const tenantId = requireTenantId(request);
    const changedById = requireUserId(request);
    const visibleUserIds = await listVisibleUserIds(request);
    const visibleUserIdList = [...visibleUserIds];
    const params = request.params as { id: string };
    const parsed = customerUpdateSchema.safeParse(request.body);
    if (!parsed.success) {
      throw app.httpErrors.badRequest(parsed.error.message);
    }
    const existing = await findCustomerInScopeOrThrow({
      tenantId,
      customerId: params.id,
      visibleUserIds: visibleUserIdList
    });
    if (parsed.data.ownerId && !visibleUserIds.has(parsed.data.ownerId)) {
      throw app.httpErrors.forbidden("customer owner must be within your hierarchy scope.");
    }
    const nextDefaultTermId = parsed.data.defaultTermId ?? existing.defaultTermId;
    const paymentTerm = await prisma.paymentTerm.findFirst({
      where: { id: nextDefaultTermId, tenantId, isActive: true },
      select: { id: true }
    });
    if (!paymentTerm) {
      throw app.httpErrors.badRequest("defaultTermId is invalid or inactive for this tenant.");
    }
    let customFields: Prisma.InputJsonValue | undefined;
    if (parsed.data.customFields !== undefined) {
      const definitions = await prisma.customFieldDefinition.findMany({
        where: { tenantId, entityType: EntityType.CUSTOMER }
      });
      customFields = validateCustomFields(app, definitions, {
        ...asRecord(existing.customFields),
        ...parsed.data.customFields
      });
    }
    return prisma.$transaction(async (tx) => {
      const updated = await tx.customer.update({
        where: { id: params.id },
        data: {
          customerCode: parsed.data.customerCode,
          name: parsed.data.name,
          defaultTermId: parsed.data.defaultTermId,
          ownerId: parsed.data.ownerId,
          customFields
        }
      });
      await writeEntityChangelog({
        db: tx,
        tenantId,
        entityType: EntityType.CUSTOMER,
        entityId: updated.id,
        action: "UPDATE",
        changedById,
        before: existing,
        after: updated
      });
      return updated;
    });
  });

  app.delete("/customers/:id", async (request, reply) => {
    const tenantId = requireTenantId(request);
    const changedById = requireUserId(request);
    const visibleUserIdList = [...(await listVisibleUserIds(request))];
    const params = request.params as { id: string };
    const existing = await findCustomerInScopeOrThrow({
      tenantId,
      customerId: params.id,
      visibleUserIds: visibleUserIdList
    });
    await prisma.$transaction(async (tx) => {
      await tx.customer.delete({ where: { id: params.id } });
      await writeEntityChangelog({
        db: tx,
        tenantId,
        entityType: EntityType.CUSTOMER,
        entityId: params.id,
        action: "DELETE",
        changedById,
        before: existing
      });
    });
    return reply.code(204).send();
  });

  app.post("/customers/:id/addresses", async (request, reply) => {
    const tenantId = requireTenantId(request);
    const visibleUserIdList = [...(await listVisibleUserIds(request))];
    const params = request.params as { id: string };
    const parsed = customerAddressSchema.safeParse(request.body);
    if (!parsed.success) {
      throw app.httpErrors.badRequest(parsed.error.message);
    }

    await findCustomerInScopeOrThrow({
      tenantId,
      customerId: params.id,
      visibleUserIds: visibleUserIdList
    });

    const existing = await prisma.customerAddress.count({
      where: { customerId: params.id }
    });

    const created = await prisma.customerAddress.create({
      data: {
        customerId: params.id,
        addressLine1: parsed.data.addressLine1,
        city: parsed.data.city,
        state: parsed.data.state,
        country: parsed.data.country,
        postalCode: parsed.data.postalCode,
        latitude: parsed.data.latitude,
        longitude: parsed.data.longitude,
        isDefaultBilling: existing === 0,
        isDefaultShipping: existing === 0
      }
    });
    return reply.code(201).send(created);
  });

  app.post("/customers/:id/contacts", async (request, reply) => {
    const tenantId = requireTenantId(request);
    const visibleUserIdList = [...(await listVisibleUserIds(request))];
    const params = request.params as { id: string };
    const parsed = customerContactSchema.safeParse(request.body);
    if (!parsed.success) {
      throw app.httpErrors.badRequest(parsed.error.message);
    }
    await findCustomerInScopeOrThrow({
      tenantId,
      customerId: params.id,
      visibleUserIds: visibleUserIdList
    });

    const created = await prisma.customerContact.create({
      data: {
        customerId: params.id,
        name: parsed.data.name,
        position: parsed.data.position,
        customFields: (parsed.data.customFields ?? undefined) as Prisma.InputJsonValue | undefined
      }
    });
    return reply.code(201).send(created);
  });

  app.get("/items", async (request) => {
    const tenantId = requireTenantId(request);
    return prisma.item.findMany({ where: { tenantId }, orderBy: { createdAt: "desc" } });
  });

  app.get("/items/:id", async (request) => {
    const tenantId = requireTenantId(request);
    const params = request.params as { id: string };
    const item = await prisma.item.findFirst({
      where: { id: params.id, tenantId }
    });
    if (!item) {
      throw app.httpErrors.notFound("Item not found.");
    }
    return item;
  });

  app.post("/items", async (request, reply) => {
    requireRoleAtLeast(request, UserRole.MANAGER);
    const tenantId = requireTenantId(request);
    const changedById = requireUserId(request);
    const parsed = itemSchema.safeParse(request.body);
    if (!parsed.success) {
      throw app.httpErrors.badRequest(parsed.error.message);
    }
    const definitions = await prisma.customFieldDefinition.findMany({
      where: { tenantId, entityType: EntityType.ITEM }
    });
    const customFields = validateCustomFields(app, definitions, parsed.data.customFields ?? {});
    const created = await prisma.$transaction(async (tx) => {
      const row = await tx.item.create({
        data: {
          tenantId,
          itemCode: parsed.data.itemCode,
          name: parsed.data.name,
          unitPrice: parsed.data.unitPrice,
          customFields
        }
      });
      await writeEntityChangelog({
        db: tx,
        tenantId,
        entityType: EntityType.ITEM,
        entityId: row.id,
        action: "CREATE",
        changedById,
        after: row
      });
      return row;
    });
    return reply.code(201).send(created);
  });

  app.patch("/items/:id", async (request) => {
    requireRoleAtLeast(request, UserRole.MANAGER);
    const tenantId = requireTenantId(request);
    const changedById = requireUserId(request);
    const params = request.params as { id: string };
    const parsed = itemUpdateSchema.safeParse(request.body);
    if (!parsed.success) {
      throw app.httpErrors.badRequest(parsed.error.message);
    }
    const existing = await prisma.item.findFirst({
      where: { id: params.id, tenantId }
    });
    if (!existing) {
      throw app.httpErrors.notFound("Item not found.");
    }
    let customFields: Prisma.InputJsonValue | undefined;
    if (parsed.data.customFields !== undefined) {
      const definitions = await prisma.customFieldDefinition.findMany({
        where: { tenantId, entityType: EntityType.ITEM }
      });
      customFields = validateCustomFields(app, definitions, {
        ...asRecord(existing.customFields),
        ...parsed.data.customFields
      });
    }
    return prisma.$transaction(async (tx) => {
      const updated = await tx.item.update({
        where: { id: params.id },
        data: {
          itemCode: parsed.data.itemCode,
          name: parsed.data.name,
          unitPrice: parsed.data.unitPrice,
          customFields
        }
      });
      await writeEntityChangelog({
        db: tx,
        tenantId,
        entityType: EntityType.ITEM,
        entityId: updated.id,
        action: "UPDATE",
        changedById,
        before: existing,
        after: updated
      });
      return updated;
    });
  });

  app.delete("/items/:id", async (request, reply) => {
    requireRoleAtLeast(request, UserRole.MANAGER);
    const tenantId = requireTenantId(request);
    const changedById = requireUserId(request);
    const params = request.params as { id: string };
    const existing = await prisma.item.findFirst({
      where: { id: params.id, tenantId }
    });
    if (!existing) {
      throw app.httpErrors.notFound("Item not found.");
    }
    await prisma.$transaction(async (tx) => {
      await tx.item.delete({ where: { id: params.id } });
      await writeEntityChangelog({
        db: tx,
        tenantId,
        entityType: EntityType.ITEM,
        entityId: params.id,
        action: "DELETE",
        changedById,
        before: existing
      });
    });
    return reply.code(204).send();
  });

  app.delete("/payment-terms/:id", async (request, reply) => {
    requireRoleAtLeast(request, UserRole.MANAGER);
    const tenantId = requireTenantId(request);
    const params = request.params as { id: string };
    const existing = await prisma.paymentTerm.findFirst({
      where: { id: params.id, tenantId }
    });
    if (!existing) {
      throw app.httpErrors.notFound("Payment term not found.");
    }
    const customerUsageCount = await prisma.customer.count({
      where: { tenantId, defaultTermId: params.id }
    });
    const quotationUsageCount = await prisma.quotation.count({
      where: { tenantId, paymentTermId: params.id }
    });
    if (customerUsageCount > 0 || quotationUsageCount > 0) {
      throw app.httpErrors.conflict("Payment term is in use by customers or quotations.");
    }
    await prisma.paymentTerm.delete({ where: { id: params.id } });
    return reply.code(204).send();
  });
};
