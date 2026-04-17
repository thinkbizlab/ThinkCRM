import type { FastifyPluginAsync } from "fastify";
import { CustomerType, CustomFieldDataType, EntityType, Prisma, UserRole } from "@prisma/client";
import { z } from "zod";
import { listVisibleUserIds, requireRoleAtLeast, requireTenantId, requireUserId } from "../../lib/http.js";
import { writeEntityChangelog } from "../../lib/changelog.js";
import { prisma } from "../../lib/prisma.js";
import { validateCustomFields, asRecord } from "../../lib/custom-fields.js";

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
  customerType: z.nativeEnum(CustomerType).optional(),
  taxId: z.string().max(20).optional(),
  defaultTermId: z.string().min(1),
  ownerId: z.string().optional(),
  siteLat: z.number().min(-90).max(90).optional(),
  siteLng: z.number().min(-180).max(180).optional(),
  externalRef: z.string().trim().max(100).optional(),
  customFields: customFieldValuesSchema.optional()
});
const customerUpdateSchema = customerSchema.partial().extend({
  defaultTermId: z.string().min(1).optional()
});

const itemSchema = z.object({
  itemCode: z.string().min(1).max(40),
  name: z.string().min(2).max(200),
  unitPrice: z.number().nonnegative(),
  externalRef: z.string().trim().max(100).optional(),
  customFields: customFieldValuesSchema.optional()
});
const itemUpdateSchema = itemSchema.partial();

const customerAddressSchema = z.object({
  addressLine1: z.string().min(1),
  subDistrict: z.string().max(120).optional(),
  district: z.string().max(120).optional(),
  province: z.string().max(120).optional(),
  city: z.string().optional(),
  state: z.string().optional(),
  country: z.string().optional(),
  postalCode: z.string().optional(),
  latitude: z.number().min(-90).max(90).optional(),
  longitude: z.number().min(-180).max(180).optional()
});

const customerContactSchema = z.object({
  name: z.string().min(1),
  position: z.string().min(1).max(120),
  tel: z.string().max(30).optional(),
  email: z.string().email().optional().or(z.literal("")),
  lineId: z.string().max(60).optional(),
  whatsapp: z.string().max(30).optional(),
  customFields: customFieldValuesSchema.optional()
}).refine(
  (d) => !!(d.tel?.trim() || d.email?.trim() || d.lineId?.trim() || d.whatsapp?.trim()),
  { message: "At least one contact channel (Tel, Email, LINE ID, or WhatsApp) is required." }
);

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
    const requesterId = requireUserId(request);
    const visibleUserIdList = [...(await listVisibleUserIds(request))];
    const query = request.query as { scope?: string };
    // scope=mine → only current user's customers (default)
    // scope=team → all visible hierarchy
    // scope=all  → same as team (further expansion for ADMIN)
    const ownerFilter =
      query.scope === "team" || query.scope === "all"
        ? { in: visibleUserIdList }
        : requesterId;
    return prisma.customer.findMany({
      where: { tenantId, ownerId: ownerFilter },
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
    const isCode = /^[A-Za-z]+-\d+$/.test(params.id);
    const where = isCode
      ? { customerCode: params.id, tenantId, ownerId: { in: visibleUserIdList } }
      : { id: params.id, tenantId, ownerId: { in: visibleUserIdList } };
    const customer = await prisma.customer.findFirst({
      where,
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

    if (parsed.data.taxId) {
      const taxIdDuplicate = await prisma.customer.findFirst({
        where: { tenantId, taxId: parsed.data.taxId },
        select: { customerCode: true, name: true }
      });
      if (taxIdDuplicate) {
        throw app.httpErrors.conflict(
          `Tax ID "${parsed.data.taxId}" is already registered to customer "${taxIdDuplicate.name}" (${taxIdDuplicate.customerCode}).`
        );
      }
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
          customerType: parsed.data.customerType ?? CustomerType.COMPANY,
          taxId: parsed.data.taxId,
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

    if (parsed.data.taxId) {
      const taxIdDuplicate = await prisma.customer.findFirst({
        where: { tenantId, taxId: parsed.data.taxId, id: { not: params.id } },
        select: { customerCode: true, name: true }
      });
      if (taxIdDuplicate) {
        throw app.httpErrors.conflict(
          `Tax ID "${parsed.data.taxId}" is already registered to customer "${taxIdDuplicate.name}" (${taxIdDuplicate.customerCode}).`
        );
      }
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
          customerType: parsed.data.customerType,
          taxId: parsed.data.taxId,
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
    const changedById = requireUserId(request);
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

    const existingCount = await prisma.customerAddress.count({
      where: { customerId: params.id }
    });

    const created = await prisma.$transaction(async (tx) => {
      const row = await tx.customerAddress.create({
        data: {
          customerId: params.id,
          addressLine1: parsed.data.addressLine1,
          subDistrict: parsed.data.subDistrict,
          district: parsed.data.district,
          province: parsed.data.province,
          city: parsed.data.city,
          state: parsed.data.state,
          country: parsed.data.country,
          postalCode: parsed.data.postalCode,
          latitude: parsed.data.latitude,
          longitude: parsed.data.longitude,
          isDefaultBilling: existingCount === 0,
          isDefaultShipping: existingCount === 0
        }
      });
      await writeEntityChangelog({
        db: tx,
        tenantId,
        entityType: EntityType.CUSTOMER,
        entityId: params.id,
        action: "CREATE",
        changedById,
        after: row
      });
      return row;
    });
    return reply.code(201).send(created);
  });

  app.post("/customers/:id/contacts", async (request, reply) => {
    const tenantId = requireTenantId(request);
    const changedById = requireUserId(request);
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

    const created = await prisma.$transaction(async (tx) => {
      const row = await tx.customerContact.create({
        data: {
          customerId: params.id,
          name: parsed.data.name,
          position: parsed.data.position,
          tel: parsed.data.tel,
          email: parsed.data.email || null,
          lineId: parsed.data.lineId,
          whatsapp: parsed.data.whatsapp,
          customFields: (parsed.data.customFields ?? undefined) as Prisma.InputJsonValue | undefined
        }
      });
      await writeEntityChangelog({
        db: tx,
        tenantId,
        entityType: EntityType.CUSTOMER,
        entityId: params.id,
        action: "CREATE",
        changedById,
        after: row
      });
      return row;
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

  // ── DBD Datawarehouse proxy ──────────────────────────────────────────────
  // Proxies requests to Thailand's DBD company registry to avoid CORS.
  // Set DBD_API_KEY env var if the target API requires one.
  app.get("/dbd/company/:taxId", async (request) => {
    requireTenantId(request);
    const { taxId } = request.params as { taxId: string };
    if (!/^\d{13}$/.test(taxId)) {
      throw app.httpErrors.badRequest("Tax ID must be exactly 13 digits.");
    }

    const baseUrl =
      process.env["DBD_API_URL"] ??
      "https://datawarehouse.dbd.go.th/api/juristic/";
    const apiKey = process.env["DBD_API_KEY"] ?? "";

    try {
      const headers: Record<string, string> = { Accept: "application/json" };
      if (apiKey) headers["api_key"] = apiKey;

      const res = await fetch(`${baseUrl}${taxId}`, { headers });
      if (!res.ok) {
        if (res.status === 404) throw app.httpErrors.notFound("Company not found in DBD registry.");
        throw app.httpErrors.badGateway(`DBD API returned ${res.status}.`);
      }
      const data = await res.json() as Record<string, unknown>;
      // Normalise the DBD response into a stable shape regardless of API version
      return {
        taxId,
        name: data["juristicName"] ?? data["name"] ?? data["juristic_name"] ?? null,
        nameEn: data["juristicNameEn"] ?? data["name_en"] ?? null,
        addressLine1: data["address"] ?? data["addressLine1"] ?? null,
        province: data["province"] ?? null,
        postalCode: data["postcode"] ?? data["postal_code"] ?? null,
        status: data["statusName"] ?? data["status"] ?? null,
        registeredCapital: data["registeredCapital"] ?? data["registered_capital"] ?? null,
        raw: data
      };
    } catch (err: unknown) {
      if (err && typeof err === "object" && "statusCode" in err) throw err;
      throw app.httpErrors.badGateway("Could not reach DBD API. Check DBD_API_URL configuration.");
    }
  });

  // ── Thai geography search ────────────────────────────────────────────────
  // Returns sub-district / district / province matches for autocomplete.
  // We load the compact dataset lazily and cache it in-process.
  let thaiGeoCache: ThaiGeoEntry[] | null = null;

  type ThaiGeoEntry = {
    sub_district: string;
    district: string;
    province: string;
    zipcode: number;
  };

  async function getThaiGeoData(): Promise<ThaiGeoEntry[]> {
    if (thaiGeoCache) return thaiGeoCache;
    const url =
      process.env["THAI_GEO_JSON_URL"] ??
      "https://raw.githubusercontent.com/kongvut/thai-province-data/master/api_tambon.json";
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Failed to load Thai geo data: ${res.status}`);
    const raw = await res.json() as Array<{
      name_th: string;
      amphure: { name_th: string; province: { name_th: string } };
      zip_code: number;
    }>;
    thaiGeoCache = raw.map((t) => ({
      sub_district: t.name_th,
      district: t.amphure?.name_th ?? "",
      province: t.amphure?.province?.name_th ?? "",
      zipcode: t.zip_code
    }));
    return thaiGeoCache;
  }

  app.get("/geo/th/search", async (request) => {
    requireTenantId(request);
    const query = request.query as { q?: string };
    const q = (query.q ?? "").trim();
    if (q.length < 2) return [];

    try {
      const data = await getThaiGeoData();
      const lower = q.toLowerCase();
      const results = data
        .filter(
          (e) =>
            e.sub_district.includes(q) ||
            e.district.includes(q) ||
            e.province.includes(q) ||
            String(e.zipcode).startsWith(q)
        )
        .slice(0, 20);
      return results;
    } catch {
      return []; // Fail gracefully — autocomplete is non-critical
    }
  });
};
