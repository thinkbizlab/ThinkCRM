import type { FastifyPluginAsync } from "fastify";
import { CustomerDuplicateStatus, CustomerType, CustomFieldDataType, EntityType, Prisma, UserRole } from "@prisma/client";
import { z } from "zod";
import { listVisibleUserIds, requireRoleAtLeast, requireTenantId, requireUserId, zodMsg } from "../../lib/http.js";
import { writeEntityChangelog } from "../../lib/changelog.js";
import { prisma } from "../../lib/prisma.js";
import { validateCustomFields, asRecord, extractCustomFieldsFromRow } from "../../lib/custom-fields.js";
import { logAuditEvent } from "../../lib/audit.js";
import { buildMergePreview, findDuplicatesForNewCustomer, mergeCustomers, scanDuplicatesForTenant } from "./dedup.js";
import { getFederationConfig, hydrateCustomer, hydrateCustomers, searchFederatedCustomers } from "../federation/customer-federation.js";

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
    const isOptionBased =
      value.dataType === CustomFieldDataType.SELECT || value.dataType === CustomFieldDataType.MULTISELECT;
    if (isOptionBased && !value.options?.length) {
      ctx.addIssue({
        path: ["options"],
        code: "custom",
        message: "SELECT/MULTISELECT fields require at least one option."
      });
    }
    if (!isOptionBased && value.options?.length) {
      ctx.addIssue({
        path: ["options"],
        code: "custom",
        message: "Options are only supported for SELECT or MULTISELECT fields."
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

const customerGroupSchema = z.object({
  code: z.string().trim().min(1).max(50),
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().max(500).nullable().optional(),
  isActive: z.boolean().optional(),
  customFields: customFieldValuesSchema.optional()
});
const customerGroupUpdateSchema = customerGroupSchema.partial();

const customerSchemaBase = z.object({
  // customerCode is required for ACTIVE customers (real ERP code) but optional
  // for DRAFTs captured in the field before ERP sync.
  customerCode: z.string().min(2).max(40).optional(),
  name: z.string().min(2).max(200),
  customerType: z.nativeEnum(CustomerType).optional(),
  taxId: z.string().max(20).optional(),
  // Branch code only meaningful when taxId is set; defaults to "00000" (HQ)
  // server-side. Length capped to 5 to match the Thai tax-branch convention.
  branchCode: z.string().regex(/^[0-9]{1,5}$/, "branchCode must be 1–5 digits").optional(),
  // Optional corporate-group link — must be a customer in the same tenant.
  // Cycles and depth are validated in the handler, not here.
  parentCustomerId: z.string().min(1).nullable().optional(),
  customerGroupId: z.string().min(1).nullable().optional(),
  ownerId: z.string().optional(),
  siteLat: z.number().min(-90).max(90).optional(),
  siteLng: z.number().min(-180).max(180).optional(),
  externalRef: z.string().trim().max(100).optional(),
  status: z.enum(["DRAFT", "ACTIVE"]).optional(),
  customFields: customFieldValuesSchema.optional()
});
const customerSchema = customerSchemaBase.superRefine((data, ctx) => {
  const status = data.status ?? "ACTIVE";
  if (status === "ACTIVE") {
    if (!data.customerCode) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["customerCode"],
        message: "customerCode is required for ACTIVE customers."
      });
    }
  }
});
const customerUpdateSchema = customerSchemaBase.omit({ customerCode: true, status: true }).partial().extend({
  customerGroupId: z.string().min(1).nullable().optional(),
  disabled: z.boolean().optional()
});

const customerSearchQuerySchema = z.object({
  q: z.string().trim().min(2).max(120),
  limit: z.coerce.number().int().min(1).max(20).optional().default(8),
  scope: z.enum(["mine", "team", "all"]).optional().default("mine")
});

const itemSchema = z.object({
  itemCode: z.string().min(1).max(40),
  name: z.string().min(2).max(200),
  unitPrice: z.number().nonnegative(),
  externalRef: z.string().trim().max(100).optional(),
  isActive: z.boolean().optional(),
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
  if (
    normalized === "customer-group" ||
    normalized === "customer_group" ||
    normalized === "customergroup" ||
    normalized === "customer-groups"
  ) {
    return EntityType.CUSTOMER_GROUP;
  }
  throw app.httpErrors.badRequest("Unsupported entity type. Use customer, item, payment-term, or customer-group.");
}


async function peekNextCrmCode(tenantId: string): Promise<string> {
  const rows = await prisma.customer.findMany({
    where: { tenantId, customerCode: { startsWith: "C-" } },
    select: { customerCode: true }
  });
  let maxNum = 0;
  for (const { customerCode } of rows) {
    const m = customerCode?.match(/^C-(\d+)$/i);
    if (m) maxNum = Math.max(maxNum, parseInt(m[1]!, 10));
  }
  return `C-${String(maxNum + 1).padStart(6, "0")}`;
}

// Returns true if the code looks like an auto-generated CRM code (C-NNNNNN).
// These are re-derived server-side at insert time to prevent race conditions
// when two users open the new-customer form simultaneously.
const AUTO_CODE_RE = /^C-\d+$/i;

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

  // Walk up the parent chain to enforce tenant scope, no-cycle, and depth cap.
  // `selfId` is the customer being edited (or null when creating); used to
  // detect a cycle if the proposed parent is the customer itself or a descendant.
  const PARENT_DEPTH_LIMIT = 5;
  async function assertValidParent(input: {
    tenantId: string;
    selfId: string | null;
    parentId: string;
  }) {
    if (input.selfId && input.parentId === input.selfId) {
      throw app.httpErrors.badRequest("A customer cannot be its own parent.");
    }
    let cursorId: string | null = input.parentId;
    let depth = 0;
    while (cursorId) {
      depth++;
      // depth now counts ancestors including the proposed parent. The
      // resulting customer sits at depth+1 from the root, so we cap depth
      // at LIMIT-1 to keep total levels ≤ LIMIT.
      if (depth >= PARENT_DEPTH_LIMIT) {
        throw app.httpErrors.badRequest(
          `Parent chain would exceed depth limit of ${PARENT_DEPTH_LIMIT}.`
        );
      }
      const node: { id: string; parentCustomerId: string | null } | null = await prisma.customer.findFirst({
        where: { id: cursorId, tenantId: input.tenantId },
        select: { id: true, parentCustomerId: true }
      });
      if (!node) {
        throw app.httpErrors.badRequest("parentCustomerId is invalid for this tenant.");
      }
      if (input.selfId && node.id === input.selfId) {
        throw app.httpErrors.badRequest(
          "Parent assignment would create a cycle (the proposed parent is a descendant of this customer)."
        );
      }
      cursorId = node.parentCustomerId;
    }
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

  // When a tenant enables "Manage X by API", all web-session mutations on the
  // matching master-data entity are rejected. Sync API-key routes (/sync/*)
  // go through a separate auth layer and are unaffected.
  //
  // Federated Customer Master: when Tenant.customerFederationSourceId is set,
  // Customer is also write-locked (DRAFT customers bypass since the create
  // path skips this check for drafts; drafts stay local and never hit MySQL).
  async function assertMasterWritable(
    tenantId: string,
    entity: "customer" | "item" | "paymentTerm" | "customerGroup"
  ) {
    const t = await prisma.tenant.findUnique({
      where: { id: tenantId },
      select: {
        manageCustomersByApi: true,
        manageItemsByApi: true,
        managePaymentTermsByApi: true,
        manageCustomerGroupsByApi: true,
        customerFederationSourceId: true
      }
    });
    if (!t) return;
    const customerFederated = entity === "customer" && t.customerFederationSourceId != null;
    const locked =
      (entity === "customer" && t.manageCustomersByApi) ||
      (entity === "item" && t.manageItemsByApi) ||
      (entity === "paymentTerm" && t.managePaymentTermsByApi) ||
      (entity === "customerGroup" && t.manageCustomerGroupsByApi) ||
      customerFederated;
    if (locked) {
      const label =
        entity === "customer" ? "Customer"
        : entity === "item" ? "Item"
        : entity === "paymentTerm" ? "Payment Term"
        : "Customer Group";
      const reason = customerFederated
        ? `${label} master is read live from this tenant's external MySQL. UI changes are disabled — edit in the source system.`
        : `${label} master is managed via API for this tenant. UI changes are disabled.`;
      throw app.httpErrors.forbidden(reason);
    }
  }

  app.post("/custom-fields/:entityType", async (request, reply) => {
    requireRoleAtLeast(request, UserRole.ADMIN);
    const tenantId = requireTenantId(request);
    const params = request.params as { entityType: string };
    const entityType = resolveCustomFieldEntityType(params.entityType, app);
    const parsed = customFieldDefinitionCreateSchema.safeParse(request.body);
    if (!parsed.success) {
      throw app.httpErrors.badRequest(zodMsg(parsed.error));
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
          parsed.data.dataType === CustomFieldDataType.SELECT ||
          parsed.data.dataType === CustomFieldDataType.MULTISELECT
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
      throw app.httpErrors.badRequest(zodMsg(parsed.error));
    }
    const existing = await prisma.customFieldDefinition.findFirst({
      where: { id: params.id, tenantId, entityType }
    });
    if (!existing) {
      throw app.httpErrors.notFound("Custom field definition not found.");
    }
    const nextOptions =
      parsed.data.options !== undefined
        ? existing.dataType === CustomFieldDataType.SELECT ||
          existing.dataType === CustomFieldDataType.MULTISELECT
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

  app.delete("/custom-fields/:entityType/:id", async (request, reply) => {
    requireRoleAtLeast(request, UserRole.ADMIN);
    const tenantId = requireTenantId(request);
    const params = request.params as { entityType: string; id: string };
    const entityType = resolveCustomFieldEntityType(params.entityType, app);
    const existing = await prisma.customFieldDefinition.findFirst({
      where: { id: params.id, tenantId, entityType }
    });
    if (!existing) {
      throw app.httpErrors.notFound("Custom field definition not found.");
    }
    await prisma.customFieldDefinition.delete({ where: { id: params.id } });
    return reply.code(204).send();
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
    await assertMasterWritable(tenantId, "paymentTerm");
    const parsed = paymentTermSchema.safeParse(request.body);
    if (!parsed.success) {
      throw app.httpErrors.badRequest(zodMsg(parsed.error));
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
    await assertMasterWritable(tenantId, "paymentTerm");
    const params = request.params as { id: string };
    const parsed = paymentTermUpdateSchema.safeParse(request.body);
    if (!parsed.success) {
      throw app.httpErrors.badRequest(zodMsg(parsed.error));
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

  app.get("/customers/next-crm-code", async (request) => {
    const tenantId = requireTenantId(request);
    return { code: await peekNextCrmCode(tenantId) };
  });

  app.get("/customers", async (request) => {
    const tenantId = requireTenantId(request);
    const requesterId = requireUserId(request);
    const query = request.query as { scope?: string };
    // scope=mine        → only current user's customers (default)
    // scope=team        → all visible hierarchy
    // scope=all         → same as team (further expansion for ADMIN)
    // scope=unassigned  → customers with NULL owner (ADMIN only).
    //                     Surfaces federated customers whose ERP sale_person
    //                     didn't resolve to a CRM user — typically invisible
    //                     in every owner-scoped query because NULL ∉ IN(...).
    const includeShape = {
      contacts: {
        select: {
          id: true,
          name: true,
          position: true,
          tel: true,
          email: true,
          lineId: true,
          whatsapp: true
        }
      },
      customerGroup: { select: { id: true, code: true, name: true } },
      owner: { select: { id: true, fullName: true } }
    } as const;

    // Hard cap on rows returned per list call — see PR #19. The list view
    // renders only shadow-row fields; federation overlay reserved for
    // /customers/:id detail. By default we hide disabled customers from
    // every scope: ERP-marked-inactive customers shouldn't clutter the rep's
    // working set. Caller can opt back in with ?includeDisabled=true.
    const LIST_LIMIT = 2000;
    const includeDisabled = (request.query as { includeDisabled?: string }).includeDisabled === "true";
    const disabledClause = includeDisabled ? {} : { disabled: false };

    if (query.scope === "unassigned") {
      requireRoleAtLeast(request, UserRole.ADMIN);
      return prisma.customer.findMany({
        where: { tenantId, ownerId: null, ...disabledClause },
        include: includeShape,
        orderBy: { createdAt: "desc" },
        take: LIST_LIMIT
      });
    }

    const visibleUserIdList = [...(await listVisibleUserIds(request))];
    const ownerFilter =
      query.scope === "team" || query.scope === "all"
        ? { in: visibleUserIdList }
        : requesterId;
    return prisma.customer.findMany({
      where: { tenantId, ownerId: ownerFilter, ...disabledClause },
      include: includeShape,
      orderBy: { createdAt: "desc" },
      take: LIST_LIMIT
    });
  });

  app.get("/customers/search", async (request) => {
    const tenantId = requireTenantId(request);
    const requesterId = requireUserId(request);
    const visibleUserIdList = [...(await listVisibleUserIds(request))];
    const parsed = customerSearchQuerySchema.safeParse(request.query ?? {});
    if (!parsed.success) {
      throw app.httpErrors.badRequest(zodMsg(parsed.error));
    }
    const query = parsed.data;
    const ownerFilter =
      query.scope === "team" || query.scope === "all"
        ? { in: visibleUserIdList }
        : requesterId;

    const localRows = await prisma.customer.findMany({
      where: {
        tenantId,
        ownerId: ownerFilter,
        disabled: false,
        OR: [
          { name: { contains: query.q, mode: "insensitive" } },
          { customerCode: { contains: query.q, mode: "insensitive" } }
        ]
      },
      select: {
        id: true,
        name: true,
        customerCode: true,
        status: true,
        draftCreatedByUserId: true,
        externalRef: true,
        owner: { select: { id: true, fullName: true } }
      },
      orderBy: [
        { name: "asc" },
        { createdAt: "desc" }
      ],
      take: query.limit
    });

    // Federated tenants: also surface upstream customers that haven't been
    // pulled into shadow yet (e.g. a customer the ERP team just created).
    // We resolve any new federated hit to a shadow row on the fly so the
    // returned `id` is FK-targetable for downstream actions like prospect
    // identify or visit create. Owner-scope is bypassed for federated rows
    // since federation tenants don't manage customer ownership locally.
    const federationCfg = await getFederationConfig(tenantId);
    if (!federationCfg) return localRows;

    const localExternalRefs = new Set(localRows.map((r) => r.externalRef).filter((v): v is string => !!v));
    const federatedHits = await searchFederatedCustomers(tenantId, query.q, query.limit).catch(() => []);
    // Honor the upstream's disabled flag — never surface (and never auto-create
    // a shadow row for) a customer the ERP has disabled. The disabled column
    // name is taken from the operator's mapping if present, else "disabled".
    const disabledColumn = federationCfg.mappings.find((m) => m.targetField === "disabled")?.sourceField ?? "disabled";
    const isDisabled = (raw: Record<string, unknown>): boolean => {
      const v = raw[disabledColumn];
      return v === true || v === 1 || v === "1" || v === "true" || v === "TRUE";
    };
    const newRefs = federatedHits.filter((hit) => !localExternalRefs.has(hit.externalRef) && !isDisabled(hit.raw));
    if (newRefs.length === 0) return localRows;

    const created: typeof localRows = [];
    for (const hit of newRefs) {
      // Upsert by (tenantId, externalRef) — there's a unique constraint on
      // that pair so concurrent searches won't dupe.
      const shadow = await prisma.customer.upsert({
        where: { tenantId_externalRef: { tenantId, externalRef: hit.externalRef } },
        create: {
          tenantId,
          ownerId: requesterId,
          externalRef: hit.externalRef,
          name: hit.name,
          status: "ACTIVE",
          // customerCode pulled from MySQL when present so list rows show ERP code
          customerCode: typeof hit.raw.customer_code === "string" ? hit.raw.customer_code : null
        },
        update: { name: hit.name },
        select: {
          id: true,
          name: true,
          customerCode: true,
          status: true,
          draftCreatedByUserId: true,
          externalRef: true,
          owner: { select: { id: true, fullName: true } }
        }
      });
      created.push(shadow);
    }
    return [...localRows, ...created].slice(0, query.limit);
  });

  app.get("/customers/:id", async (request, reply) => {
    const tenantId = requireTenantId(request);
    const visibleUserIdList = [...(await listVisibleUserIds(request))];
    const params = request.params as { id: string };
    const isCode = params.id.includes("-");
    const where = isCode
      ? { customerCode: params.id, tenantId, ownerId: { in: visibleUserIdList } }
      : { id: params.id, tenantId, ownerId: { in: visibleUserIdList } };
    const customer = await prisma.customer.findFirst({
      where,
      include: {
        addresses: true,
        contacts: true,
        customerGroup: { select: { id: true, code: true, name: true } }
      }
    });
    if (!customer) {
      throw app.httpErrors.notFound("Customer not found.");
    }
    const hydrated = await hydrateCustomer(tenantId, customer);
    if (hydrated && hydrated.federationStatus === "stale") {
      reply.header("X-Federation-Stale", "true");
    }
    return hydrated;
  });

  // Unified Customer 360 payload — single round-trip + single hierarchy-scope check.
  // Replaces the customer/deals/visits trio that the C360 page used to fetch separately.
  app.get("/customers/:id/360", async (request, reply) => {
    const tenantId = requireTenantId(request);
    const visibleUserIdList = [...(await listVisibleUserIds(request))];
    const params = request.params as { id: string };
    const isCode = params.id.includes("-");
    const customerWhere = isCode
      ? { customerCode: params.id, tenantId, ownerId: { in: visibleUserIdList } }
      : { id: params.id, tenantId, ownerId: { in: visibleUserIdList } };
    const customerRow = await prisma.customer.findFirst({
      where: customerWhere,
      include: {
        addresses: true,
        contacts: true,
        customerGroup: { select: { id: true, code: true, name: true } },
        parentCustomer: {
          select: { id: true, customerCode: true, name: true, branchCode: true, status: true }
        }
      }
    });
    if (!customerRow) {
      throw app.httpErrors.notFound("Customer not found.");
    }
    const customer = await hydrateCustomer(tenantId, customerRow);
    if (customer && customer.federationStatus === "stale") {
      reply.header("X-Federation-Stale", "true");
    }
    const [deals, visits, children] = await Promise.all([
      prisma.deal.findMany({
        where: { tenantId, customerId: customer.id, ownerId: { in: visibleUserIdList } },
        select: {
          id: true,
          dealNo: true,
          dealName: true,
          followUpAt: true,
          closedAt: true,
          estimatedValue: true,
          status: true,
          stage: { select: { id: true, stageName: true } }
        },
        orderBy: { createdAt: "desc" }
      }),
      prisma.visit.findMany({
        where: { tenantId, customerId: customer.id, repId: { in: visibleUserIdList } },
        select: {
          id: true,
          status: true,
          plannedAt: true,
          createdAt: true,
          rep: { select: { id: true, fullName: true } }
        },
        orderBy: { plannedAt: "desc" }
      }),
      // Direct children only — the c360 page renders a flat list of subsidiaries.
      // Children are visible regardless of owner scope so the hierarchy is intact;
      // clicking through still hits the scoped customer endpoint.
      prisma.customer.findMany({
        where: { tenantId, parentCustomerId: customer.id },
        select: {
          id: true,
          customerCode: true,
          name: true,
          branchCode: true,
          status: true
        },
        orderBy: { name: "asc" }
      })
    ]);
    return { customer, deals, visits, children };
  });

  app.post("/customers", async (request, reply) => {
    const tenantId = requireTenantId(request);
    const changedById = requireUserId(request);
    const visibleUserIds = await listVisibleUserIds(request);
    const parsed = customerSchema.safeParse(request.body);
    if (!parsed.success) {
      throw app.httpErrors.badRequest(zodMsg(parsed.error));
    }
    const isDraft = parsed.data.status === "DRAFT";
    // DRAFT creation is the one path that bypasses `manageCustomersByApi` —
    // the whole point is to let reps capture prospects before ERP sync runs.
    if (!isDraft) {
      await assertMasterWritable(tenantId, "customer");
    }

    const ownerId = parsed.data.ownerId ?? changedById;
    if (!visibleUserIds.has(ownerId)) {
      throw app.httpErrors.forbidden("customer owner must be within your hierarchy scope.");
    }

    // Default branch code to "00000" (HQ) whenever a Tax ID is supplied.
    // (taxId, branchCode) together identify the billable entity.
    const branchCode = parsed.data.taxId
      ? (parsed.data.branchCode ?? "00000")
      : null;

    if (parsed.data.taxId) {
      const taxIdDuplicate = await prisma.customer.findFirst({
        where: { tenantId, taxId: parsed.data.taxId, branchCode },
        select: { id: true, customerCode: true, name: true, status: true, branchCode: true }
      });
      if (taxIdDuplicate) {
        // DRAFT creators who hit an existing customer should land on that
        // customer instead of getting blocked — that's the point of reusing
        // the (taxId, branchCode) uniqueness as a routing mechanism.
        if (isDraft) {
          return reply.code(200).send({ ...taxIdDuplicate, reusedExisting: true });
        }
        throw app.httpErrors.conflict(
          `Tax ID "${parsed.data.taxId}" branch "${branchCode}" is already registered to customer "${taxIdDuplicate.name}" (${taxIdDuplicate.customerCode ?? "DRAFT"}).`
        );
      }
    }

    // DRAFT customers keep customerCode = null until ERP sync (or the manual
    // promote endpoint) delivers the real ERP code — auto-generating a
    // C-NNNNNN here would burn a number for a record that may never become
    // a real customer, and would diverge from the test contract that asserts
    // `customerCode` is null for a freshly captured prospect.
    const isAutoCode = !isDraft && (!parsed.data.customerCode || AUTO_CODE_RE.test(parsed.data.customerCode));

    // Only validate manually-typed codes for duplicates up front.
    // Auto-generated codes (C-NNNNNN) are re-derived inside the transaction
    // to eliminate the race condition where two users open the form at the
    // same time and both receive the same preview code.
    if (parsed.data.customerCode && !isAutoCode) {
      const codeDuplicate = await prisma.customer.findFirst({
        where: { tenantId, customerCode: parsed.data.customerCode },
        select: { id: true }
      });
      if (codeDuplicate) {
        throw app.httpErrors.conflict(
          `Customer code "${parsed.data.customerCode}" is already in use. Please enter a different code.`
        );
      }
    }

    if (parsed.data.parentCustomerId) {
      await assertValidParent({ tenantId, selfId: null, parentId: parsed.data.parentCustomerId });
    }

    if (parsed.data.customerGroupId) {
      const group = await prisma.customerGroup.findFirst({
        where: { id: parsed.data.customerGroupId, tenantId },
        select: { id: true }
      });
      if (!group) {
        throw app.httpErrors.badRequest("customerGroupId is invalid for this tenant.");
      }
    }

    const definitions = await prisma.customFieldDefinition.findMany({
      where: { tenantId, entityType: EntityType.CUSTOMER }
    });
    const customFields = validateCustomFields(app, definitions, parsed.data.customFields ?? {});

    // Retry loop for auto-code allocation: if two inserts race and collide on
    // the unique (tenantId, customerCode) index, re-derive and try again.
    const MAX_CODE_RETRIES = 5;
    let created;
    for (let attempt = 0; attempt < MAX_CODE_RETRIES; attempt++) {
      const customerCode = isAutoCode
        ? await peekNextCrmCode(tenantId)
        : (parsed.data.customerCode ?? null);
      try {
        created = await prisma.$transaction(async (tx) => {
          const row = await tx.customer.create({
            data: {
              tenantId,
              status: isDraft ? "DRAFT" : "ACTIVE",
              customerCode,
              name: parsed.data.name,
              customerType: parsed.data.customerType ?? CustomerType.COMPANY,
              taxId: parsed.data.taxId,
              branchCode,
              parentCustomerId: parsed.data.parentCustomerId ?? null,
              customerGroupId: parsed.data.customerGroupId ?? null,
              ownerId,
              createdByUserId: changedById,
              draftCreatedByUserId: isDraft ? changedById : null,
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
            after: row,
            context: isDraft ? { reason: "draft_created_in_field" } : undefined
          });
          return row;
        });
        break; // success
      } catch (err) {
        const isCodeCollision = isAutoCode &&
          err instanceof Prisma.PrismaClientKnownRequestError &&
          err.code === "P2002";
        if (!isCodeCollision || attempt === MAX_CODE_RETRIES - 1) throw err;
        // else: another insert won the race — loop and re-derive the next code
      }
    }
    return reply.code(201).send(created!);
  });

  app.patch("/customers/:id", async (request) => {
    const tenantId = requireTenantId(request);
    await assertMasterWritable(tenantId, "customer");
    const changedById = requireUserId(request);
    const visibleUserIds = await listVisibleUserIds(request);
    const visibleUserIdList = [...visibleUserIds];
    const params = request.params as { id: string };
    const parsed = customerUpdateSchema.safeParse(request.body);
    if (!parsed.success) {
      throw app.httpErrors.badRequest(zodMsg(parsed.error));
    }
    const existing = await findCustomerInScopeOrThrow({
      tenantId,
      customerId: params.id,
      visibleUserIds: visibleUserIdList
    });
    if (parsed.data.ownerId && !visibleUserIds.has(parsed.data.ownerId)) {
      throw app.httpErrors.forbidden("customer owner must be within your hierarchy scope.");
    }

    // Resolve next (taxId, branchCode) pair for the duplicate check. Either
    // can be unchanged from `existing` if the patch omits them.
    const nextTaxId = parsed.data.taxId !== undefined ? parsed.data.taxId : existing.taxId;
    const nextBranchCode = nextTaxId
      ? (parsed.data.branchCode ?? existing.branchCode ?? "00000")
      : null;

    if (nextTaxId) {
      const taxIdDuplicate = await prisma.customer.findFirst({
        where: {
          tenantId,
          taxId: nextTaxId,
          branchCode: nextBranchCode,
          id: { not: params.id }
        },
        select: { customerCode: true, name: true, branchCode: true }
      });
      if (taxIdDuplicate) {
        throw app.httpErrors.conflict(
          `Tax ID "${nextTaxId}" branch "${nextBranchCode}" is already registered to customer "${taxIdDuplicate.name}" (${taxIdDuplicate.customerCode}).`
        );
      }
    }

    if (parsed.data.parentCustomerId !== undefined && parsed.data.parentCustomerId !== null) {
      await assertValidParent({
        tenantId,
        selfId: params.id,
        parentId: parsed.data.parentCustomerId
      });
    }

    if (parsed.data.customerGroupId) {
      const group = await prisma.customerGroup.findFirst({
        where: { id: parsed.data.customerGroupId, tenantId },
        select: { id: true }
      });
      if (!group) {
        throw app.httpErrors.badRequest("customerGroupId is invalid for this tenant.");
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
          name: parsed.data.name,
          customerType: parsed.data.customerType,
          taxId: parsed.data.taxId,
          // Persist the resolved branch code only when taxId is in play; null
          // it out alongside taxId being cleared so the unique constraint
          // doesn't accidentally lock a "00000" against a non-Tax customer.
          branchCode: parsed.data.taxId !== undefined || parsed.data.branchCode !== undefined
            ? nextBranchCode
            : undefined,
          parentCustomerId:
            parsed.data.parentCustomerId === undefined ? undefined : parsed.data.parentCustomerId,
          customerGroupId:
            parsed.data.customerGroupId === undefined ? undefined : parsed.data.customerGroupId,
          ownerId: parsed.data.ownerId,
          disabled: parsed.data.disabled,
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
    await assertMasterWritable(tenantId, "customer");
    const changedById = requireUserId(request);
    const visibleUserIdList = [...(await listVisibleUserIds(request))];
    const params = request.params as { id: string };
    const existing = await findCustomerInScopeOrThrow({
      tenantId,
      customerId: params.id,
      visibleUserIds: visibleUserIdList
    });
    // Block deletion when the customer still has history that would
    // otherwise raise a FK Restrict error at the database layer. Return
    // a friendly, actionable message instead of a generic 500.
    const [dealCount, visitCount, quotationCount] = await Promise.all([
      prisma.deal.count({ where: { customerId: params.id, tenantId } }),
      prisma.visit.count({ where: { customerId: params.id, tenantId } }),
      prisma.quotation.count({ where: { customerId: params.id, tenantId } })
    ]);
    if (dealCount + visitCount + quotationCount > 0) {
      const parts: string[] = [];
      if (dealCount) parts.push(`${dealCount} deal${dealCount !== 1 ? "s" : ""}`);
      if (visitCount) parts.push(`${visitCount} visit${visitCount !== 1 ? "s" : ""}`);
      if (quotationCount) parts.push(`${quotationCount} quotation${quotationCount !== 1 ? "s" : ""}`);
      throw app.httpErrors.conflict(
        `Cannot delete this customer because it has ${parts.join(", ")}. ` +
          `Reassign or delete those first, or disable the customer instead.`
      );
    }
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

  const bulkIdsSchema = z.object({
    ids: z.array(z.string().min(1)).min(1).max(500)
  });
  const bulkReassignOwnerSchema = bulkIdsSchema.extend({
    ownerId: z.string().min(1)
  });

  app.post("/customers/bulk-reassign-owner", async (request) => {
    requireRoleAtLeast(request, UserRole.SUPERVISOR);
    const tenantId = requireTenantId(request);
    await assertMasterWritable(tenantId, "customer");
    const changedById = requireUserId(request);
    const visibleUserIds = await listVisibleUserIds(request);
    const visibleUserIdList = [...visibleUserIds];
    const parsed = bulkReassignOwnerSchema.safeParse(request.body);
    if (!parsed.success) {
      throw app.httpErrors.badRequest(zodMsg(parsed.error));
    }
    if (!visibleUserIds.has(parsed.data.ownerId)) {
      throw app.httpErrors.forbidden("New owner must be within your hierarchy scope.");
    }
    const uniqueIds = Array.from(new Set(parsed.data.ids));
    const existingRows = await prisma.customer.findMany({
      where: { id: { in: uniqueIds }, tenantId, ownerId: { in: visibleUserIdList } }
    });
    const found = new Map(existingRows.map((c) => [c.id, c]));
    const missing = uniqueIds.filter((id) => !found.has(id));
    if (missing.length > 0) {
      throw app.httpErrors.forbidden(
        `${missing.length} customer(s) are outside your scope or not found.`
      );
    }
    let updated = 0;
    await prisma.$transaction(async (tx) => {
      for (const before of existingRows) {
        if (before.ownerId === parsed.data.ownerId) continue;
        const after = await tx.customer.update({
          where: { id: before.id },
          data: { ownerId: parsed.data.ownerId }
        });
        await writeEntityChangelog({
          db: tx,
          tenantId,
          entityType: EntityType.CUSTOMER,
          entityId: before.id,
          action: "UPDATE",
          changedById,
          before,
          after
        });
        updated += 1;
      }
    });
    return { requested: uniqueIds.length, updated, unchanged: uniqueIds.length - updated };
  });

  app.post("/customers/bulk-delete", async (request) => {
    requireRoleAtLeast(request, UserRole.ADMIN);
    const tenantId = requireTenantId(request);
    await assertMasterWritable(tenantId, "customer");
    const changedById = requireUserId(request);
    const visibleUserIdList = [...(await listVisibleUserIds(request))];
    const parsed = bulkIdsSchema.safeParse(request.body);
    if (!parsed.success) {
      throw app.httpErrors.badRequest(zodMsg(parsed.error));
    }
    const uniqueIds = Array.from(new Set(parsed.data.ids));
    const existingRows = await prisma.customer.findMany({
      where: { id: { in: uniqueIds }, tenantId, ownerId: { in: visibleUserIdList } }
    });
    if (existingRows.length !== uniqueIds.length) {
      throw app.httpErrors.forbidden(
        `${uniqueIds.length - existingRows.length} customer(s) are outside your scope or not found.`
      );
    }
    await prisma.$transaction(async (tx) => {
      for (const before of existingRows) {
        await tx.customer.delete({ where: { id: before.id } });
        await writeEntityChangelog({
          db: tx,
          tenantId,
          entityType: EntityType.CUSTOMER,
          entityId: before.id,
          action: "DELETE",
          changedById,
          before
        });
      }
    });
    return { deleted: existingRows.length };
  });

  // ── Duplicate detection & merge ───────────────────────────────────────────

  // Inline pre-create check: rep is filling in the New Customer form. We compare
  // the draft against existing tenant customers (deterministic + AI fuzzy) and
  // return matches so the UI can warn or block before the row is persisted.
  // No DB write is performed by this endpoint. Available to any authenticated
  // user (everyone can create customers).
  const checkNewBodySchema = z.object({
    name: z.string().min(1).max(200),
    taxId: z.string().trim().min(0).max(20).optional().nullable(),
    branchCode: z.string().trim().min(0).max(5).optional().nullable(),
    contacts: z.array(z.object({
      tel: z.string().trim().max(40).optional().nullable(),
      email: z.string().trim().max(200).optional().nullable(),
    })).max(20).optional()
  }).strict();

  app.post("/customers/duplicates/check-new", async (request) => {
    const tenantId = requireTenantId(request);
    const userId = requireUserId(request);
    const parsed = checkNewBodySchema.safeParse(request.body);
    if (!parsed.success) throw app.httpErrors.badRequest(zodMsg(parsed.error));
    const result = await findDuplicatesForNewCustomer(tenantId, userId, {
      name: parsed.data.name,
      taxId: parsed.data.taxId ?? null,
      branchCode: parsed.data.branchCode ?? null,
      contacts: parsed.data.contacts ?? [],
    });
    await logAuditEvent(tenantId, userId, "CUSTOMER_DEDUP_PRE_CHECK", {
      draftName: parsed.data.name,
      hasTaxId: !!parsed.data.taxId,
      matchCount: result.matches.length,
      aiCallsMade: result.aiCallsMade,
      aiSkippedNoKey: result.aiSkippedNoKey,
    }, request.ip);
    return {
      matches: result.matches,
      aiEnabled: !result.aiSkippedNoKey,
      aiCallsMade: result.aiCallsMade,
    };
  });

  app.post("/customers/duplicates/scan", async (request) => {
    requireRoleAtLeast(request, UserRole.ADMIN);
    const tenantId = requireTenantId(request);
    const result = await scanDuplicatesForTenant(tenantId);
    await logAuditEvent(tenantId, requireUserId(request), "CUSTOMER_DEDUP_SCAN", result, request.ip);
    return result;
  });

  app.get("/customers/duplicates", async (request) => {
    requireRoleAtLeast(request, UserRole.ADMIN);
    const tenantId = requireTenantId(request);
    const rows = await prisma.customerDuplicateCandidate.findMany({
      where: { tenantId, status: CustomerDuplicateStatus.OPEN },
      orderBy: [{ confidence: "desc" }, { createdAt: "desc" }],
      take: 500
    });
    const ids = Array.from(new Set(rows.flatMap((r) => [r.customerAId, r.customerBId])));
    const customers = await prisma.customer.findMany({
      where: { tenantId, id: { in: ids } },
      select: {
        id: true,
        customerCode: true,
        name: true,
        taxId: true,
        ownerId: true,
        owner: { select: { id: true, fullName: true } },
        contacts: { select: { tel: true, email: true } }
      }
    });
    const byId = new Map(customers.map((c) => [c.id, c]));
    return {
      candidates: rows.map((r) => ({
        id: r.id,
        signal: r.signal,
        confidence: r.confidence,
        reasonText: r.reasonText,
        createdAt: r.createdAt,
        a: byId.get(r.customerAId) ?? null,
        b: byId.get(r.customerBId) ?? null
      }))
    };
  });

  app.post("/customers/duplicates/:id/dismiss", async (request, reply) => {
    requireRoleAtLeast(request, UserRole.ADMIN);
    const tenantId = requireTenantId(request);
    const changedById = requireUserId(request);
    const params = request.params as { id: string };
    const candidate = await prisma.customerDuplicateCandidate.findFirst({
      where: { id: params.id, tenantId }
    });
    if (!candidate) throw app.httpErrors.notFound("Duplicate candidate not found.");
    await prisma.customerDuplicateCandidate.update({
      where: { id: candidate.id },
      data: {
        status: CustomerDuplicateStatus.DISMISSED,
        decidedById: changedById,
        decidedAt: new Date()
      }
    });
    return reply.code(204).send();
  });

  const mergeBodySchema = z.object({
    loserIds: z.array(z.string().min(1)).min(1).max(20)
  });

  app.post("/customers/:keeperId/merge", async (request) => {
    const tenantId = requireTenantId(request);
    const changedById = requireUserId(request);
    const role = request.requestContext.role;
    const params = request.params as { keeperId: string };
    const query = request.query as { dryRun?: string };
    const parsed = mergeBodySchema.safeParse(request.body);
    if (!parsed.success) {
      throw app.httpErrors.badRequest(zodMsg(parsed.error));
    }
    const loserIds = Array.from(new Set(parsed.data.loserIds)).filter((id) => id !== params.keeperId);
    if (loserIds.length === 0) {
      throw app.httpErrors.badRequest("At least one loser customer is required.");
    }

    // Determine whether this is a DRAFT cleanup (rep merging their own prospect
    // into the ACTIVE customer that just arrived from ERP) or a normal admin
    // merge. DRAFT cleanups bypass both the tenant API-lock and the admin gate.
    const loserRows = await prisma.customer.findMany({
      where: { tenantId, id: { in: loserIds } },
      select: { id: true, status: true, draftCreatedByUserId: true }
    });
    if (loserRows.length !== loserIds.length) {
      throw app.httpErrors.notFound("One or more loser customers not found in this tenant.");
    }
    const allLosersAreOwnDrafts = loserRows.every(
      (r) => r.status === "DRAFT" && r.draftCreatedByUserId === changedById
    );
    const hasAdminTier = role ? (role === UserRole.ADMIN || role === UserRole.DIRECTOR || role === UserRole.MANAGER || role === UserRole.ASSISTANT_MANAGER) : false;
    if (!hasAdminTier && !allLosersAreOwnDrafts) {
      throw app.httpErrors.forbidden("Only admins/managers or the draft's creator may merge customers.");
    }
    const allLosersDraft = loserRows.every((r) => r.status === "DRAFT");
    if (!allLosersDraft) {
      await assertMasterWritable(tenantId, "customer");
    }

    if (query.dryRun === "true" || query.dryRun === "1") {
      return { dryRun: true, preview: await buildMergePreview(tenantId, params.keeperId, loserIds) };
    }
    const preview = await mergeCustomers({
      tenantId,
      keeperId: params.keeperId,
      loserIds,
      changedById
    });
    await logAuditEvent(tenantId, changedById, "CUSTOMER_MERGE", {
      keeperId: params.keeperId,
      loserIds,
      counts: preview.counts,
      draftCleanup: allLosersDraft
    }, request.ip);
    return { dryRun: false, preview };
  });

  const promoteBodySchema = z.object({
    customerCode: z.string().trim().min(2).max(40)
  });

  // Manual promotion: admin (or the rep who drafted it, for their own prospect)
  // fills in the ERP customerCode that ERP sync hasn't delivered yet, flipping
  // the DRAFT to ACTIVE in place.
  app.post("/customers/:id/promote", async (request, reply) => {
    const tenantId = requireTenantId(request);
    const changedById = requireUserId(request);
    const role = request.requestContext.role;
    const params = request.params as { id: string };
    const parsed = promoteBodySchema.safeParse(request.body);
    if (!parsed.success) {
      throw app.httpErrors.badRequest(zodMsg(parsed.error));
    }

    const draft = await prisma.customer.findFirst({
      where: { tenantId, id: params.id },
      select: {
        id: true,
        status: true,
        customerCode: true,
        name: true,
        taxId: true,
        draftCreatedByUserId: true
      }
    });
    if (!draft) throw app.httpErrors.notFound("Customer not found.");
    if (draft.status !== "DRAFT") {
      throw app.httpErrors.badRequest("Customer is already ACTIVE; nothing to promote.");
    }

    const hasAdminTier = role ? (role === UserRole.ADMIN || role === UserRole.DIRECTOR || role === UserRole.MANAGER || role === UserRole.ASSISTANT_MANAGER) : false;
    const isOwnDraft = draft.draftCreatedByUserId === changedById;
    if (!hasAdminTier && !isOwnDraft) {
      throw app.httpErrors.forbidden("Only admins/managers or the draft's creator may promote.");
    }

    // Enforce the partial-unique rule explicitly so the error is clear rather
    // than a raw constraint violation from Postgres.
    const codeClash = await prisma.customer.findFirst({
      where: { tenantId, customerCode: parsed.data.customerCode, status: "ACTIVE" },
      select: { id: true, name: true }
    });
    if (codeClash) {
      throw app.httpErrors.conflict(
        `customerCode "${parsed.data.customerCode}" already belongs to customer "${codeClash.name}".`
      );
    }

    const updated = await prisma.customer.update({
      where: { id: draft.id },
      data: {
        status: "ACTIVE",
        customerCode: parsed.data.customerCode,
        promotedAt: new Date()
      }
    });
    await writeEntityChangelog({
      db: prisma,
      tenantId,
      entityType: EntityType.CUSTOMER,
      entityId: draft.id,
      action: "UPDATE",
      changedById,
      before: draft,
      after: updated,
      context: { reason: "draft_promoted_manually" }
    });
    await logAuditEvent(tenantId, changedById, "CUSTOMER_PROMOTE", {
      customerId: draft.id,
      customerCode: parsed.data.customerCode
    }, request.ip);
    return reply.code(200).send(updated);
  });

  app.post("/customers/:id/addresses", async (request, reply) => {
    const tenantId = requireTenantId(request);
    await assertMasterWritable(tenantId, "customer");
    const changedById = requireUserId(request);
    const visibleUserIdList = [...(await listVisibleUserIds(request))];
    const params = request.params as { id: string };
    const parsed = customerAddressSchema.safeParse(request.body);
    if (!parsed.success) {
      throw app.httpErrors.badRequest(zodMsg(parsed.error));
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
    await assertMasterWritable(tenantId, "customer");
    const changedById = requireUserId(request);
    const visibleUserIdList = [...(await listVisibleUserIds(request))];
    const params = request.params as { id: string };
    const parsed = customerContactSchema.safeParse(request.body);
    if (!parsed.success) {
      throw app.httpErrors.badRequest(zodMsg(parsed.error));
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
    await assertMasterWritable(tenantId, "item");
    const changedById = requireUserId(request);
    const parsed = itemSchema.safeParse(request.body);
    if (!parsed.success) {
      throw app.httpErrors.badRequest(zodMsg(parsed.error));
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
          isActive: parsed.data.isActive ?? true,
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
    await assertMasterWritable(tenantId, "item");
    const changedById = requireUserId(request);
    const params = request.params as { id: string };
    const parsed = itemUpdateSchema.safeParse(request.body);
    if (!parsed.success) {
      throw app.httpErrors.badRequest(zodMsg(parsed.error));
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
          isActive: parsed.data.isActive,
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
    await assertMasterWritable(tenantId, "item");
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
    await assertMasterWritable(tenantId, "paymentTerm");
    const params = request.params as { id: string };
    const existing = await prisma.paymentTerm.findFirst({
      where: { id: params.id, tenantId }
    });
    if (!existing) {
      throw app.httpErrors.notFound("Payment term not found.");
    }
    const quotationUsageCount = await prisma.quotation.count({
      where: { tenantId, paymentTermId: params.id }
    });
    if (quotationUsageCount > 0) {
      throw app.httpErrors.conflict("Payment term is in use by quotations.");
    }
    await prisma.paymentTerm.delete({ where: { id: params.id } });
    return reply.code(204).send();
  });

  app.post("/payment-terms/bulk-delete", async (request) => {
    requireRoleAtLeast(request, UserRole.ADMIN);
    const tenantId = requireTenantId(request);
    await assertMasterWritable(tenantId, "paymentTerm");
    const parsed = bulkIdsSchema.safeParse(request.body);
    if (!parsed.success) {
      throw app.httpErrors.badRequest(zodMsg(parsed.error));
    }
    const uniqueIds = Array.from(new Set(parsed.data.ids));
    const existingRows = await prisma.paymentTerm.findMany({
      where: { id: { in: uniqueIds }, tenantId },
      select: { id: true, code: true, name: true }
    });
    if (existingRows.length !== uniqueIds.length) {
      throw app.httpErrors.notFound(
        `${uniqueIds.length - existingRows.length} payment term(s) not found in this tenant.`
      );
    }
    const quotationUsage = await prisma.quotation.groupBy({
      by: ["paymentTermId"],
      where: { tenantId, paymentTermId: { in: uniqueIds } },
      _count: { _all: true }
    });
    const inUse = new Set<string>(
      quotationUsage.map((r) => r.paymentTermId).filter((v): v is string => v != null)
    );
    if (inUse.size > 0) {
      const blocked = existingRows.filter((r) => inUse.has(r.id));
      const labels = blocked.map((r) => `${r.code} (${r.name})`).join(", ");
      throw app.httpErrors.conflict(
        `${blocked.length} payment term(s) in use by quotations: ${labels}.`
      );
    }
    const deleted = await prisma.paymentTerm.deleteMany({
      where: { id: { in: uniqueIds }, tenantId }
    });
    return { deleted: deleted.count };
  });

  // ── Customer Groups ─────────────────────────────────────────────────────
  app.get("/customer-groups", async (request) => {
    const tenantId = requireTenantId(request);
    return prisma.customerGroup.findMany({
      where: { tenantId },
      orderBy: { name: "asc" }
    });
  });

  app.post("/customer-groups", async (request, reply) => {
    requireRoleAtLeast(request, UserRole.MANAGER);
    const tenantId = requireTenantId(request);
    await assertMasterWritable(tenantId, "customerGroup");
    const changedById = requireUserId(request);
    const parsed = customerGroupSchema.safeParse(request.body);
    if (!parsed.success) {
      throw app.httpErrors.badRequest(zodMsg(parsed.error));
    }
    const definitions = await prisma.customFieldDefinition.findMany({
      where: { tenantId, entityType: EntityType.CUSTOMER_GROUP }
    });
    const customFields = validateCustomFields(app, definitions, parsed.data.customFields ?? {});
    const created = await prisma.$transaction(async (tx) => {
      const row = await tx.customerGroup.create({
        data: {
          tenantId,
          code: parsed.data.code,
          name: parsed.data.name,
          description: parsed.data.description ?? null,
          isActive: parsed.data.isActive ?? true,
          customFields
        }
      });
      await writeEntityChangelog({
        db: tx,
        tenantId,
        entityType: EntityType.CUSTOMER_GROUP,
        entityId: row.id,
        action: "CREATE",
        changedById,
        after: row
      });
      return row;
    });
    return reply.code(201).send(created);
  });

  app.patch("/customer-groups/:id", async (request) => {
    requireRoleAtLeast(request, UserRole.MANAGER);
    const tenantId = requireTenantId(request);
    await assertMasterWritable(tenantId, "customerGroup");
    const changedById = requireUserId(request);
    const params = request.params as { id: string };
    const parsed = customerGroupUpdateSchema.safeParse(request.body);
    if (!parsed.success) {
      throw app.httpErrors.badRequest(zodMsg(parsed.error));
    }
    const existing = await prisma.customerGroup.findFirst({
      where: { id: params.id, tenantId }
    });
    if (!existing) {
      throw app.httpErrors.notFound("Customer group not found.");
    }
    let customFields: Prisma.InputJsonValue | undefined;
    if (parsed.data.customFields !== undefined) {
      const definitions = await prisma.customFieldDefinition.findMany({
        where: { tenantId, entityType: EntityType.CUSTOMER_GROUP }
      });
      customFields = validateCustomFields(app, definitions, {
        ...asRecord(existing.customFields),
        ...parsed.data.customFields
      });
    }
    return prisma.$transaction(async (tx) => {
      const updated = await tx.customerGroup.update({
        where: { id: params.id },
        data: {
          code: parsed.data.code,
          name: parsed.data.name,
          description:
            parsed.data.description === undefined ? undefined : parsed.data.description,
          isActive: parsed.data.isActive,
          customFields
        }
      });
      await writeEntityChangelog({
        db: tx,
        tenantId,
        entityType: EntityType.CUSTOMER_GROUP,
        entityId: updated.id,
        action: "UPDATE",
        changedById,
        before: existing,
        after: updated
      });
      return updated;
    });
  });

  app.delete("/customer-groups/:id", async (request, reply) => {
    requireRoleAtLeast(request, UserRole.MANAGER);
    const tenantId = requireTenantId(request);
    await assertMasterWritable(tenantId, "customerGroup");
    const changedById = requireUserId(request);
    const params = request.params as { id: string };
    const existing = await prisma.customerGroup.findFirst({
      where: { id: params.id, tenantId }
    });
    if (!existing) {
      throw app.httpErrors.notFound("Customer group not found.");
    }
    // onDelete: SetNull on Customer.customerGroupId means no precheck needed —
    // customers simply lose their group assignment.
    await prisma.$transaction(async (tx) => {
      await tx.customerGroup.delete({ where: { id: params.id } });
      await writeEntityChangelog({
        db: tx,
        tenantId,
        entityType: EntityType.CUSTOMER_GROUP,
        entityId: params.id,
        action: "DELETE",
        changedById,
        before: existing
      });
    });
    return reply.code(204).send();
  });

  app.post("/customer-groups/bulk-delete", async (request) => {
    requireRoleAtLeast(request, UserRole.ADMIN);
    const tenantId = requireTenantId(request);
    await assertMasterWritable(tenantId, "customerGroup");
    const parsed = bulkIdsSchema.safeParse(request.body);
    if (!parsed.success) {
      throw app.httpErrors.badRequest(zodMsg(parsed.error));
    }
    const uniqueIds = Array.from(new Set(parsed.data.ids));
    const existingRows = await prisma.customerGroup.findMany({
      where: { id: { in: uniqueIds }, tenantId },
      select: { id: true }
    });
    if (existingRows.length !== uniqueIds.length) {
      throw app.httpErrors.notFound(
        `${uniqueIds.length - existingRows.length} customer group(s) not found in this tenant.`
      );
    }
    const deleted = await prisma.customerGroup.deleteMany({
      where: { id: { in: uniqueIds }, tenantId }
    });
    return { deleted: deleted.count };
  });

  // ── DBD Datawarehouse proxy ──────────────────────────────────────────────
  // Proxies requests to Thailand's DBD company registry to avoid CORS.
  // Configure with the env vars below (no silent default — the legacy public
  // path is gated and we want explicit failures rather than mysterious timeouts):
  //   DBD_API_URL  — base URL ending in `/`, taxId is appended (e.g. https://apidev.dbd.go.th/api/v3/juristic/)
  //   DBD_API_KEY  — required by most current DBD endpoints; sent as `api_key` header
  app.get("/dbd/status", async (request) => {
    requireTenantId(request);
    return { configured: Boolean(process.env["DBD_API_URL"]) };
  });

  app.get("/dbd/company/:taxId", async (request) => {
    requireTenantId(request);
    const { taxId } = request.params as { taxId: string };
    if (!/^\d{13}$/.test(taxId)) {
      throw app.httpErrors.badRequest("Tax ID must be exactly 13 digits.");
    }

    const baseUrl = process.env["DBD_API_URL"];
    const apiKey = process.env["DBD_API_KEY"] ?? "";
    if (!baseUrl) {
      throw app.httpErrors.serviceUnavailable(
        "DBD lookup is not configured. Set DBD_API_URL (and DBD_API_KEY if the upstream requires it)."
      );
    }

    try {
      const headers: Record<string, string> = { Accept: "application/json" };
      if (apiKey) headers["api_key"] = apiKey;

      const res = await fetch(`${baseUrl}${taxId}`, { headers });
      if (!res.ok) {
        if (res.status === 404) throw app.httpErrors.notFound("Company not found in DBD registry.");
        const bodySnippet = await res.text().catch(() => "");
        request.log.warn(
          { dbdStatus: res.status, dbdBody: bodySnippet.slice(0, 500), dbdUrl: baseUrl },
          "DBD upstream returned non-OK status"
        );
        if (res.status === 401 || res.status === 403) {
          throw app.httpErrors.badGateway(
            `DBD API rejected the request (${res.status}). ${apiKey ? "Verify DBD_API_KEY is valid." : "DBD_API_KEY is not set — most endpoints require one."}`
          );
        }
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
      // Surface the real cause: fetch failures usually carry a `cause` (DNS/TLS/network)
      // and the message itself often names the failure mode.
      const message = err instanceof Error ? err.message : String(err);
      const cause = err instanceof Error && err.cause ? String((err.cause as Error).message ?? err.cause) : null;
      request.log.error({ err, dbdUrl: baseUrl }, "DBD proxy failed");
      throw app.httpErrors.badGateway(
        `Could not reach DBD API: ${message}${cause ? ` (cause: ${cause})` : ""}. Check DBD_API_URL${apiKey ? "" : " and DBD_API_KEY"}.`
      );
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

  // ── Master data bulk import (xlsx-friendly) ───────────────────────────────
  // All three endpoints accept { rows: [...] } and upsert on the natural unique key.
  // Rows with validation issues are collected into errorDetails; valid rows are applied.

  const readRows = (body: unknown): unknown[] => {
    if (Array.isArray(body)) return body;
    const r = (body as Record<string, unknown>)?.rows;
    return Array.isArray(r) ? r : [];
  };

  const flexibleBooleanImport = z.preprocess((value) => {
    if (typeof value === "boolean") return value;
    if (typeof value === "number") {
      if (value === 1) return true;
      if (value === 0) return false;
    }
    if (typeof value === "string") {
      const normalized = value.trim().toLowerCase();
      if (!normalized.length) return undefined;
      if (["true", "1", "yes", "y"].includes(normalized)) return true;
      if (["false", "0", "no", "n"].includes(normalized)) return false;
    }
    return value;
  }, z.boolean().optional());

  const paymentTermImportRow = z.object({
    code: z.string().trim().min(2).max(30),
    name: z.string().trim().min(2).max(120),
    dueDays: z.coerce.number().int().min(0).max(365),
    isActive: flexibleBooleanImport.optional()
  });

  app.post("/payment-terms/import", async (request) => {
    requireRoleAtLeast(request, UserRole.MANAGER);
    const tenantId = requireTenantId(request);
    await assertMasterWritable(tenantId, "paymentTerm");
    const rawRows = readRows(request.body);
    if (!rawRows.length) throw app.httpErrors.badRequest("Expected { rows: [...] } with at least one row.");
    if (rawRows.length > 1000) throw app.httpErrors.badRequest("Maximum 1000 rows per import.");

    const paymentTermDefinitions = await prisma.customFieldDefinition.findMany({
      where: { tenantId, entityType: EntityType.PAYMENT_TERM }
    });

    const errors: { row: number; code?: string; error: string }[] = [];
    let imported = 0;
    for (let i = 0; i < rawRows.length; i++) {
      const rawRow = rawRows[i] as Record<string, unknown>;
      const parsed = paymentTermImportRow.safeParse(rawRow);
      if (!parsed.success) {
        errors.push({ row: i + 1, error: zodMsg(parsed.error) });
        continue;
      }
      const row = parsed.data;
      let customFields: Prisma.InputJsonValue | undefined;
      try {
        const cfRaw = extractCustomFieldsFromRow(rawRow, paymentTermDefinitions);
        customFields = validateCustomFields(app, paymentTermDefinitions, cfRaw);
      } catch (error) {
        errors.push({ row: i + 1, code: row.code, error: (error as Error).message });
        continue;
      }
      try {
        await prisma.paymentTerm.upsert({
          where: { tenantId_code: { tenantId, code: row.code } },
          update: {
            name: row.name,
            dueDays: row.dueDays,
            ...(row.isActive !== undefined ? { isActive: row.isActive } : {}),
            ...(customFields !== undefined ? { customFields } : {})
          },
          create: {
            tenantId,
            code: row.code,
            name: row.name,
            dueDays: row.dueDays,
            isActive: row.isActive ?? true,
            customFields
          }
        });
        imported += 1;
      } catch (error) {
        errors.push({ row: i + 1, code: row.code, error: (error as Error).message });
      }
    }

    await logAuditEvent(tenantId, requireUserId(request), "PAYMENT_TERM_IMPORT", {
      total: rawRows.length, imported, errors: errors.length, errorSample: errors.slice(0, 5)
    }, request.ip);

    return { imported, errors: errors.length, errorDetails: errors };
  });

  const itemImportRow = z.object({
    itemCode: z.string().trim().min(1).max(40),
    name: z.string().trim().min(2).max(200),
    unitPrice: z.coerce.number().nonnegative(),
    externalRef: z.string().trim().max(100).optional(),
    isActive: flexibleBooleanImport.optional()
  });

  app.post("/items/import", async (request) => {
    requireRoleAtLeast(request, UserRole.MANAGER);
    const tenantId = requireTenantId(request);
    await assertMasterWritable(tenantId, "item");
    const rawRows = readRows(request.body);
    if (!rawRows.length) throw app.httpErrors.badRequest("Expected { rows: [...] } with at least one row.");
    if (rawRows.length > 1000) throw app.httpErrors.badRequest("Maximum 1000 rows per import.");

    const itemDefinitions = await prisma.customFieldDefinition.findMany({
      where: { tenantId, entityType: EntityType.ITEM }
    });

    const errors: { row: number; itemCode?: string; error: string }[] = [];
    let imported = 0;
    for (let i = 0; i < rawRows.length; i++) {
      const rawRow = rawRows[i] as Record<string, unknown>;
      const parsed = itemImportRow.safeParse(rawRow);
      if (!parsed.success) {
        errors.push({ row: i + 1, error: zodMsg(parsed.error) });
        continue;
      }
      const row = parsed.data;
      let customFields: Prisma.InputJsonValue | undefined;
      try {
        const cfRaw = extractCustomFieldsFromRow(rawRow, itemDefinitions);
        customFields = validateCustomFields(app, itemDefinitions, cfRaw);
      } catch (error) {
        errors.push({ row: i + 1, itemCode: row.itemCode, error: (error as Error).message });
        continue;
      }
      try {
        await prisma.item.upsert({
          where: { tenantId_itemCode: { tenantId, itemCode: row.itemCode } },
          update: {
            name: row.name,
            unitPrice: row.unitPrice,
            externalRef: row.externalRef || null,
            ...(row.isActive !== undefined ? { isActive: row.isActive } : {}),
            ...(customFields !== undefined ? { customFields } : {})
          },
          create: {
            tenantId,
            itemCode: row.itemCode,
            name: row.name,
            unitPrice: row.unitPrice,
            externalRef: row.externalRef || null,
            isActive: row.isActive ?? true,
            customFields
          }
        });
        imported += 1;
      } catch (error) {
        errors.push({ row: i + 1, itemCode: row.itemCode, error: (error as Error).message });
      }
    }

    await logAuditEvent(tenantId, requireUserId(request), "ITEM_IMPORT", {
      total: rawRows.length, imported, errors: errors.length, errorSample: errors.slice(0, 5)
    }, request.ip);

    return { imported, errors: errors.length, errorDetails: errors };
  });

  const customerImportRow = z.object({
    customerCode: z.string().trim().min(2).max(40),
    name: z.string().trim().min(2).max(200),
    customerType: z.nativeEnum(CustomerType).optional(),
    customerGroupCode: z.string().trim().min(1).max(50).optional(),
    taxId: z.string().trim().max(20).optional(),
    branchCode: z.string().trim().regex(/^[0-9]{1,5}$/, "branchCode must be 1-5 digits").optional(),
    parentCustomerCode: z.string().trim().min(2).max(40).optional(),
    externalRef: z.string().trim().max(100).optional(),
    siteLat: z.coerce.number().min(-90).max(90).optional(),
    siteLng: z.coerce.number().min(-180).max(180).optional(),
    disabled: flexibleBooleanImport.optional()
  });

  app.post("/customers/import", async (request) => {
    requireRoleAtLeast(request, UserRole.MANAGER);
    const tenantId = requireTenantId(request);
    await assertMasterWritable(tenantId, "customer");
    const ownerId = requireUserId(request);
    const rawRows = readRows(request.body);
    if (!rawRows.length) throw app.httpErrors.badRequest("Expected { rows: [...] } with at least one row.");
    if (rawRows.length > 1000) throw app.httpErrors.badRequest("Maximum 1000 rows per import.");

    const groups = await prisma.customerGroup.findMany({
      where: { tenantId },
      select: { id: true, code: true }
    });
    const groupIdByCode = new Map(groups.map((g) => [g.code.toLowerCase(), g.id]));

    const parentCandidates = await prisma.customer.findMany({
      where: { tenantId, status: "ACTIVE", customerCode: { not: null } },
      select: { id: true, customerCode: true }
    });
    const parentIdByCode = new Map(
      parentCandidates
        .filter((c): c is { id: string; customerCode: string } => typeof c.customerCode === "string")
        .map((c) => [c.customerCode.toLowerCase(), c.id])
    );

    const customerDefinitions = await prisma.customFieldDefinition.findMany({
      where: { tenantId, entityType: EntityType.CUSTOMER }
    });

    const errors: { row: number; customerCode?: string; error: string }[] = [];
    let imported = 0;
    for (let i = 0; i < rawRows.length; i++) {
      const rawRow = rawRows[i] as Record<string, unknown>;
      const parsed = customerImportRow.safeParse(rawRow);
      if (!parsed.success) {
        errors.push({ row: i + 1, error: zodMsg(parsed.error) });
        continue;
      }
      const row = parsed.data;
      let customerGroupId: string | null = null;
      if (row.customerGroupCode) {
        const found = groupIdByCode.get(row.customerGroupCode.toLowerCase());
        if (!found) {
          errors.push({ row: i + 1, customerCode: row.customerCode, error: `customerGroupCode "${row.customerGroupCode}" not found.` });
          continue;
        }
        customerGroupId = found;
      }
      let parentCustomerId: string | null = null;
      if (row.parentCustomerCode) {
        const found = parentIdByCode.get(row.parentCustomerCode.toLowerCase());
        if (!found) {
          errors.push({ row: i + 1, customerCode: row.customerCode, error: `parentCustomerCode "${row.parentCustomerCode}" not found.` });
          continue;
        }
        parentCustomerId = found;
      }
      const branchCode = row.taxId ? (row.branchCode ?? "00000") : null;
      // Enforce taxId + branchCode uniqueness (same rule as the create/edit form)
      if (row.taxId) {
        const taxConflict = await prisma.customer.findFirst({
          where: { tenantId, taxId: row.taxId, branchCode, NOT: { customerCode: row.customerCode } },
          select: { id: true }
        });
        if (taxConflict) {
          errors.push({ row: i + 1, customerCode: row.customerCode, error: `taxId "${row.taxId}" branch "${branchCode}" already belongs to another customer.` });
          continue;
        }
      }
      let customFields: Prisma.InputJsonValue | undefined;
      try {
        const cfRaw = extractCustomFieldsFromRow(rawRow, customerDefinitions);
        customFields = validateCustomFields(app, customerDefinitions, cfRaw);
      } catch (error) {
        errors.push({ row: i + 1, customerCode: row.customerCode, error: (error as Error).message });
        continue;
      }
      try {
        // customerCode uniqueness is partial (ACTIVE only) so we branch instead
        // of using a compound-unique upsert.
        const existing = await prisma.customer.findFirst({
          where: { tenantId, customerCode: row.customerCode, status: "ACTIVE" },
          select: { id: true }
        });
        if (existing) {
          if (row.parentCustomerCode !== undefined && parentCustomerId) {
            await assertValidParent({ tenantId, selfId: existing.id, parentId: parentCustomerId });
          }
          await prisma.customer.update({
            where: { id: existing.id },
            data: {
              name: row.name,
              customerType: row.customerType,
              ...(row.customerGroupCode !== undefined ? { customerGroupId } : {}),
              taxId: row.taxId || null,
              branchCode,
              ...(row.parentCustomerCode !== undefined ? { parentCustomerId } : {}),
              externalRef: row.externalRef || null,
              siteLat: row.siteLat,
              siteLng: row.siteLng,
              ...(row.disabled !== undefined ? { disabled: row.disabled } : {}),
              ...(customFields !== undefined ? { customFields } : {})
            }
          });
        } else {
          if (parentCustomerId) {
            await assertValidParent({ tenantId, selfId: null, parentId: parentCustomerId });
          }
          const created = await prisma.customer.create({
            data: {
              tenantId,
              ownerId,
              customerCode: row.customerCode,
              name: row.name,
              customerGroupId,
              customerType: row.customerType ?? CustomerType.COMPANY,
              taxId: row.taxId || null,
              branchCode,
              parentCustomerId,
              externalRef: row.externalRef || null,
              siteLat: row.siteLat,
              siteLng: row.siteLng,
              disabled: row.disabled ?? false,
              customFields
            }
          });
          parentIdByCode.set(row.customerCode.toLowerCase(), created.id);
        }
        imported += 1;
      } catch (error) {
        errors.push({ row: i + 1, customerCode: row.customerCode, error: (error as Error).message });
      }
    }

    await logAuditEvent(tenantId, ownerId, "CUSTOMER_IMPORT", {
      total: rawRows.length, imported, errors: errors.length, errorSample: errors.slice(0, 5)
    }, request.ip);

    return { imported, errors: errors.length, errorDetails: errors };
  });

  const customerGroupImportRow = z.object({
    code: z.string().trim().min(1).max(50),
    name: z.string().trim().min(1).max(120),
    description: z.string().trim().max(500).optional(),
    isActive: flexibleBooleanImport.optional()
  });

  app.post("/customer-groups/import", async (request) => {
    requireRoleAtLeast(request, UserRole.MANAGER);
    const tenantId = requireTenantId(request);
    await assertMasterWritable(tenantId, "customerGroup");
    const rawRows = readRows(request.body);
    if (!rawRows.length) throw app.httpErrors.badRequest("Expected { rows: [...] } with at least one row.");
    if (rawRows.length > 1000) throw app.httpErrors.badRequest("Maximum 1000 rows per import.");

    const definitions = await prisma.customFieldDefinition.findMany({
      where: { tenantId, entityType: EntityType.CUSTOMER_GROUP }
    });

    const errors: { row: number; code?: string; error: string }[] = [];
    let imported = 0;
    const seenCodes = new Set<string>();
    for (let i = 0; i < rawRows.length; i++) {
      const rawRow = rawRows[i] as Record<string, unknown>;
      const parsed = customerGroupImportRow.safeParse(rawRow);
      if (!parsed.success) {
        errors.push({ row: i + 1, error: zodMsg(parsed.error) });
        continue;
      }
      const row = parsed.data;
      const codeKey = row.code.toLowerCase();
      if (seenCodes.has(codeKey)) {
        errors.push({ row: i + 1, code: row.code, error: `Duplicate code "${row.code}" in this import batch.` });
        continue;
      }
      seenCodes.add(codeKey);
      let customFields: Prisma.InputJsonValue | undefined;
      try {
        const cfRaw = extractCustomFieldsFromRow(rawRow, definitions);
        customFields = validateCustomFields(app, definitions, cfRaw);
      } catch (error) {
        errors.push({ row: i + 1, code: row.code, error: (error as Error).message });
        continue;
      }
      try {
        await prisma.customerGroup.upsert({
          where: { tenantId_code: { tenantId, code: row.code } },
          update: {
            name: row.name,
            description: row.description ?? null,
            ...(row.isActive !== undefined ? { isActive: row.isActive } : {}),
            ...(customFields !== undefined ? { customFields } : {})
          },
          create: {
            tenantId,
            code: row.code,
            name: row.name,
            description: row.description ?? null,
            isActive: row.isActive ?? true,
            customFields
          }
        });
        imported += 1;
      } catch (error) {
        errors.push({ row: i + 1, code: row.code, error: (error as Error).message });
      }
    }

    await logAuditEvent(tenantId, requireUserId(request), "CUSTOMER_GROUP_IMPORT", {
      total: rawRows.length, imported, errors: errors.length, errorSample: errors.slice(0, 5)
    }, request.ip);

    return { imported, errors: errors.length, errorDetails: errors };
  });
};
