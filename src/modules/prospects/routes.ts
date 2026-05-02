import type { FastifyPluginAsync } from "fastify";
import { EntityType, Prisma, ProspectStatus, UserRole } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { listVisibleUserIds, requireRoleAtLeast, requireTenantId, requireUserId, zodMsg } from "../../lib/http.js";
import { writeEntityChangelog } from "../../lib/changelog.js";
import { prisma } from "../../lib/prisma.js";
import { logAuditEvent } from "../../lib/audit.js";
import { createR2PresignedUpload, createR2PresignedDownload, deleteR2Object } from "../../lib/r2-storage.js";

const prospectCreateSchema = z.object({
  displayName: z.string().trim().max(200).optional(),
  siteLat: z.number().min(-90).max(90).optional(),
  siteLng: z.number().min(-180).max(180).optional(),
  siteAddress: z.string().trim().max(500).optional(),
  contactName: z.string().trim().max(200).optional(),
  contactPhone: z.string().trim().max(50).optional(),
  notes: z.string().trim().max(4000).optional()
}).strict();

const prospectUpdateSchema = prospectCreateSchema.partial();

const identifySchema = z.object({
  customerId: z.string().min(1)
}).strict();

const convertToDraftSchema = z.object({
  // Optional override for the DRAFT customer's name; defaults to prospect.displayName
  // or contactName if displayName is missing.
  name: z.string().trim().min(2).max(200).optional()
}).strict();

const photoUploadInitSchema = z.object({
  contentType: z.string().trim().min(1).max(120)
}).strict();

const photoCommitSchema = z.object({
  objectRef: z.string().trim().min(1).max(500),
  caption: z.string().trim().max(500).optional()
}).strict();

const listQuerySchema = z.object({
  status: z.nativeEnum(ProspectStatus).optional(),
  staleSinceDays: z.coerce.number().int().min(1).max(365).optional(),
  assignedToMe: z.coerce.boolean().optional(),
  search: z.string().trim().min(1).max(120).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional().default(50),
  offset: z.coerce.number().int().min(0).optional().default(0)
}).strict();

export const prospectRoutes: FastifyPluginAsync = async (app) => {
  // Visibility: a rep sees prospects they created; managers and above see all
  // in their hierarchy. Mirrors the customer-scope rule.
  async function findProspectInScopeOrThrow(input: {
    tenantId: string;
    prospectId: string;
    visibleUserIds: string[];
    role: UserRole | null | undefined;
  }) {
    const isManagerTier = input.role === UserRole.ADMIN || input.role === UserRole.DIRECTOR
      || input.role === UserRole.MANAGER || input.role === UserRole.ASSISTANT_MANAGER;
    const prospect = await prisma.prospect.findFirst({
      where: {
        id: input.prospectId,
        tenantId: input.tenantId,
        ...(isManagerTier ? {} : { createdById: { in: input.visibleUserIds } })
      }
    });
    if (!prospect) throw app.httpErrors.notFound("Prospect not found.");
    return prospect;
  }

  app.get("/prospects", async (request) => {
    const tenantId = requireTenantId(request);
    const callerId = requireUserId(request);
    const role = request.requestContext.role;
    const visibleUserIds = await listVisibleUserIds(request);
    const parsed = listQuerySchema.safeParse(request.query);
    if (!parsed.success) throw app.httpErrors.badRequest(zodMsg(parsed.error));
    const q = parsed.data;
    const isManagerTier = role === UserRole.ADMIN || role === UserRole.DIRECTOR
      || role === UserRole.MANAGER || role === UserRole.ASSISTANT_MANAGER;

    const where: Prisma.ProspectWhereInput = {
      tenantId,
      ...(q.status ? { status: q.status } : {}),
      ...(q.assignedToMe ? { createdById: callerId } : (isManagerTier ? {} : { createdById: { in: [...visibleUserIds] } })),
      ...(q.staleSinceDays ? {
        status: ProspectStatus.UNIDENTIFIED,
        createdAt: { lt: new Date(Date.now() - q.staleSinceDays * 86400_000) }
      } : {}),
      ...(q.search ? {
        OR: [
          { displayName: { contains: q.search, mode: "insensitive" } },
          { siteAddress: { contains: q.search, mode: "insensitive" } },
          { contactName: { contains: q.search, mode: "insensitive" } },
          { contactPhone: { contains: q.search } }
        ]
      } : {})
    };

    const [rows, total] = await Promise.all([
      prisma.prospect.findMany({
        where,
        orderBy: [{ status: "asc" }, { createdAt: "desc" }],
        take: q.limit,
        skip: q.offset,
        include: {
          createdBy: { select: { id: true, fullName: true } },
          linkedCustomer: { select: { id: true, customerCode: true, name: true } },
          _count: { select: { visits: true, photos: true } }
        }
      }),
      prisma.prospect.count({ where })
    ]);
    return { rows, total, limit: q.limit, offset: q.offset };
  });

  app.get("/prospects/:id", async (request) => {
    const tenantId = requireTenantId(request);
    const role = request.requestContext.role;
    const visibleUserIds = await listVisibleUserIds(request);
    const params = request.params as { id: string };
    await findProspectInScopeOrThrow({
      tenantId,
      prospectId: params.id,
      visibleUserIds: [...visibleUserIds],
      role
    });

    const prospect = await prisma.prospect.findFirstOrThrow({
      where: { id: params.id, tenantId },
      include: {
        createdBy: { select: { id: true, fullName: true } },
        updatedBy: { select: { id: true, fullName: true } },
        linkedCustomer: { select: { id: true, customerCode: true, name: true, status: true } },
        photos: {
          orderBy: { uploadedAt: "asc" },
          include: { uploadedBy: { select: { id: true, fullName: true } } }
        },
        visits: {
          orderBy: { plannedAt: "desc" },
          select: { id: true, visitNo: true, status: true, plannedAt: true, checkInAt: true, checkOutAt: true }
        }
      }
    });
    return prospect;
  });

  app.post("/prospects", async (request, reply) => {
    const tenantId = requireTenantId(request);
    const callerId = requireUserId(request);
    const parsed = prospectCreateSchema.safeParse(request.body);
    if (!parsed.success) throw app.httpErrors.badRequest(zodMsg(parsed.error));

    const created = await prisma.$transaction(async (tx) => {
      const row = await tx.prospect.create({
        data: {
          tenantId,
          status: ProspectStatus.UNIDENTIFIED,
          displayName: parsed.data.displayName ?? null,
          siteLat: parsed.data.siteLat ?? null,
          siteLng: parsed.data.siteLng ?? null,
          siteAddress: parsed.data.siteAddress ?? null,
          contactName: parsed.data.contactName ?? null,
          contactPhone: parsed.data.contactPhone ?? null,
          notes: parsed.data.notes ?? null,
          createdById: callerId
        }
      });
      await writeEntityChangelog({
        db: tx,
        tenantId,
        entityType: EntityType.PROSPECT,
        entityId: row.id,
        action: "CREATE",
        changedById: callerId,
        after: row
      });
      return row;
    });
    return reply.code(201).send(created);
  });

  app.patch("/prospects/:id", async (request) => {
    const tenantId = requireTenantId(request);
    const callerId = requireUserId(request);
    const role = request.requestContext.role;
    const visibleUserIds = await listVisibleUserIds(request);
    const params = request.params as { id: string };
    const parsed = prospectUpdateSchema.safeParse(request.body);
    if (!parsed.success) throw app.httpErrors.badRequest(zodMsg(parsed.error));
    const existing = await findProspectInScopeOrThrow({
      tenantId,
      prospectId: params.id,
      visibleUserIds: [...visibleUserIds],
      role
    });

    return prisma.$transaction(async (tx) => {
      const updated = await tx.prospect.update({
        where: { id: existing.id },
        data: {
          displayName: parsed.data.displayName,
          siteLat: parsed.data.siteLat,
          siteLng: parsed.data.siteLng,
          siteAddress: parsed.data.siteAddress,
          contactName: parsed.data.contactName,
          contactPhone: parsed.data.contactPhone,
          notes: parsed.data.notes,
          updatedById: callerId
        }
      });
      await writeEntityChangelog({
        db: tx,
        tenantId,
        entityType: EntityType.PROSPECT,
        entityId: updated.id,
        action: "UPDATE",
        changedById: callerId,
        before: existing,
        after: updated
      });
      return updated;
    });
  });

  // Identify: link this prospect to an existing Customer and re-point all of its
  // visits to that Customer. The prospect itself stays as a LINKED record so
  // history (photos, notes, capture timestamp) survives.
  app.post("/prospects/:id/identify", async (request) => {
    const tenantId = requireTenantId(request);
    const callerId = requireUserId(request);
    const role = request.requestContext.role;
    const visibleUserIds = await listVisibleUserIds(request);
    const params = request.params as { id: string };
    const parsed = identifySchema.safeParse(request.body);
    if (!parsed.success) throw app.httpErrors.badRequest(zodMsg(parsed.error));
    const existing = await findProspectInScopeOrThrow({
      tenantId,
      prospectId: params.id,
      visibleUserIds: [...visibleUserIds],
      role
    });
    if (existing.status === ProspectStatus.LINKED) {
      throw app.httpErrors.badRequest("Prospect is already linked.");
    }
    if (existing.status === ProspectStatus.ARCHIVED) {
      throw app.httpErrors.badRequest("Cannot identify an archived prospect.");
    }

    const customer = await prisma.customer.findFirst({
      where: { id: parsed.data.customerId, tenantId },
      select: { id: true, name: true, disabled: true, status: true }
    });
    if (!customer) throw app.httpErrors.badRequest("customerId is invalid for this tenant.");
    if (customer.disabled) throw app.httpErrors.badRequest("Cannot link to a disabled customer.");

    return prisma.$transaction(async (tx) => {
      await tx.visit.updateMany({
        where: { prospectId: existing.id, tenantId },
        data: { prospectId: null, customerId: customer.id }
      });
      const updated = await tx.prospect.update({
        where: { id: existing.id },
        data: {
          status: ProspectStatus.LINKED,
          linkedCustomerId: customer.id,
          updatedById: callerId
        }
      });
      await writeEntityChangelog({
        db: tx,
        tenantId,
        entityType: EntityType.PROSPECT,
        entityId: existing.id,
        action: "UPDATE",
        changedById: callerId,
        before: existing,
        after: updated,
        context: { reason: "identified_as_existing_customer", customerId: customer.id }
      });
      return updated;
    });
  });

  // Convert to draft: create a DRAFT Customer from the prospect's data and link.
  // DRAFT customers stay local even for federated tenants (per the existing
  // assertMasterWritable bypass for DRAFT in master-data routes).
  app.post("/prospects/:id/convert-to-draft", async (request, reply) => {
    const tenantId = requireTenantId(request);
    const callerId = requireUserId(request);
    const role = request.requestContext.role;
    const visibleUserIds = await listVisibleUserIds(request);
    const params = request.params as { id: string };
    const parsed = convertToDraftSchema.safeParse(request.body);
    if (!parsed.success) throw app.httpErrors.badRequest(zodMsg(parsed.error));
    const existing = await findProspectInScopeOrThrow({
      tenantId,
      prospectId: params.id,
      visibleUserIds: [...visibleUserIds],
      role
    });
    if (existing.status === ProspectStatus.LINKED) {
      throw app.httpErrors.badRequest("Prospect is already linked.");
    }
    if (existing.status === ProspectStatus.ARCHIVED) {
      throw app.httpErrors.badRequest("Cannot convert an archived prospect.");
    }

    const draftName = parsed.data.name
      ?? existing.displayName
      ?? existing.contactName
      ?? "Untitled draft customer";

    const result = await prisma.$transaction(async (tx) => {
      const draft = await tx.customer.create({
        data: {
          tenantId,
          status: "DRAFT",
          name: draftName,
          ownerId: callerId,
          createdByUserId: callerId,
          draftCreatedByUserId: callerId,
          siteLat: existing.siteLat,
          siteLng: existing.siteLng
        }
      });
      await tx.visit.updateMany({
        where: { prospectId: existing.id, tenantId },
        data: { prospectId: null, customerId: draft.id }
      });
      const updated = await tx.prospect.update({
        where: { id: existing.id },
        data: {
          status: ProspectStatus.LINKED,
          linkedCustomerId: draft.id,
          updatedById: callerId
        }
      });
      await writeEntityChangelog({
        db: tx,
        tenantId,
        entityType: EntityType.PROSPECT,
        entityId: existing.id,
        action: "UPDATE",
        changedById: callerId,
        before: existing,
        after: updated,
        context: { reason: "converted_to_draft_customer", draftCustomerId: draft.id }
      });
      await writeEntityChangelog({
        db: tx,
        tenantId,
        entityType: EntityType.CUSTOMER,
        entityId: draft.id,
        action: "CREATE",
        changedById: callerId,
        after: draft,
        context: { reason: "created_from_prospect", prospectId: existing.id }
      });
      return { prospect: updated, draftCustomer: draft };
    });
    return reply.code(201).send(result);
  });

  app.post("/prospects/:id/archive", async (request) => {
    const tenantId = requireTenantId(request);
    const callerId = requireUserId(request);
    const role = request.requestContext.role;
    const visibleUserIds = await listVisibleUserIds(request);
    const params = request.params as { id: string };
    const existing = await findProspectInScopeOrThrow({
      tenantId,
      prospectId: params.id,
      visibleUserIds: [...visibleUserIds],
      role
    });
    if (existing.status === ProspectStatus.ARCHIVED) {
      throw app.httpErrors.badRequest("Prospect is already archived.");
    }
    // Cannot archive while a visit is mid-checkin.
    const openVisit = await prisma.visit.findFirst({
      where: { prospectId: existing.id, tenantId, status: "CHECKED_IN" },
      select: { id: true }
    });
    if (openVisit) {
      throw app.httpErrors.conflict("Cannot archive a prospect with a CHECKED_IN visit. Check the visit out first.");
    }

    return prisma.$transaction(async (tx) => {
      const updated = await tx.prospect.update({
        where: { id: existing.id },
        data: {
          status: ProspectStatus.ARCHIVED,
          archivedAt: new Date(),
          updatedById: callerId
        }
      });
      await writeEntityChangelog({
        db: tx,
        tenantId,
        entityType: EntityType.PROSPECT,
        entityId: existing.id,
        action: "UPDATE",
        changedById: callerId,
        before: existing,
        after: updated,
        context: { reason: "archived" }
      });
      return updated;
    });
  });

  // ── Photos ────────────────────────────────────────────────────────────────
  // Two-step: client requests a presigned URL, uploads directly to R2, then
  // commits the objectRef back. Mirrors the visit checkInSelfie pattern.
  app.post("/prospects/:id/photos/init", async (request) => {
    const tenantId = requireTenantId(request);
    const role = request.requestContext.role;
    const visibleUserIds = await listVisibleUserIds(request);
    const params = request.params as { id: string };
    const parsed = photoUploadInitSchema.safeParse(request.body);
    if (!parsed.success) throw app.httpErrors.badRequest(zodMsg(parsed.error));
    await findProspectInScopeOrThrow({
      tenantId,
      prospectId: params.id,
      visibleUserIds: [...visibleUserIds],
      role
    });
    const tenant = await prisma.tenant.findUniqueOrThrow({
      where: { id: tenantId },
      select: { slug: true }
    });
    const objectKey = `${tenant.slug}/prospects/${params.id}/${randomUUID()}`;
    return createR2PresignedUpload({
      tenantSlug: tenant.slug,
      objectKeyOrRef: objectKey,
      contentType: parsed.data.contentType
    });
  });

  app.post("/prospects/:id/photos", async (request, reply) => {
    const tenantId = requireTenantId(request);
    const callerId = requireUserId(request);
    const role = request.requestContext.role;
    const visibleUserIds = await listVisibleUserIds(request);
    const params = request.params as { id: string };
    const parsed = photoCommitSchema.safeParse(request.body);
    if (!parsed.success) throw app.httpErrors.badRequest(zodMsg(parsed.error));
    const existing = await findProspectInScopeOrThrow({
      tenantId,
      prospectId: params.id,
      visibleUserIds: [...visibleUserIds],
      role
    });
    const photo = await prisma.prospectPhoto.create({
      data: {
        tenantId,
        prospectId: existing.id,
        objectRef: parsed.data.objectRef,
        caption: parsed.data.caption ?? null,
        uploadedById: callerId
      }
    });
    return reply.code(201).send(photo);
  });

  app.get("/prospects/:id/photos/:photoId/download", async (request) => {
    const tenantId = requireTenantId(request);
    const role = request.requestContext.role;
    const visibleUserIds = await listVisibleUserIds(request);
    const params = request.params as { id: string; photoId: string };
    await findProspectInScopeOrThrow({
      tenantId,
      prospectId: params.id,
      visibleUserIds: [...visibleUserIds],
      role
    });
    const photo = await prisma.prospectPhoto.findFirst({
      where: { id: params.photoId, prospectId: params.id, tenantId },
      select: { objectRef: true }
    });
    if (!photo) throw app.httpErrors.notFound("Photo not found.");
    const tenant = await prisma.tenant.findUniqueOrThrow({
      where: { id: tenantId },
      select: { slug: true }
    });
    return createR2PresignedDownload({
      tenantSlug: tenant.slug,
      objectKeyOrRef: photo.objectRef
    });
  });

  app.delete("/prospects/:id/photos/:photoId", async (request, reply) => {
    requireRoleAtLeast(request, UserRole.REP);
    const tenantId = requireTenantId(request);
    const callerId = requireUserId(request);
    const role = request.requestContext.role;
    const visibleUserIds = await listVisibleUserIds(request);
    const params = request.params as { id: string; photoId: string };
    await findProspectInScopeOrThrow({
      tenantId,
      prospectId: params.id,
      visibleUserIds: [...visibleUserIds],
      role
    });
    const photo = await prisma.prospectPhoto.findFirst({
      where: { id: params.photoId, prospectId: params.id, tenantId },
      select: { id: true, objectRef: true }
    });
    if (!photo) throw app.httpErrors.notFound("Photo not found.");
    const tenant = await prisma.tenant.findUniqueOrThrow({
      where: { id: tenantId },
      select: { slug: true }
    });
    await prisma.prospectPhoto.delete({ where: { id: photo.id } });
    // Best-effort R2 cleanup; failure does not block the API response.
    try {
      await deleteR2Object(tenant.slug, photo.objectRef);
    } catch (err) {
      app.log.warn({ err, photoId: photo.id }, "Failed to delete prospect photo from R2");
    }
    await logAuditEvent(tenantId, callerId, "PROSPECT_PHOTO_DELETE", {
      prospectId: params.id,
      photoId: photo.id
    }, request.ip);
    return reply.code(204).send();
  });
};
