import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { UserRole } from "@prisma/client";
import {
  requireRoleAtLeast,
  requireTenantId,
  zodMsg
} from "../../lib/http.js";
import { prisma } from "../../lib/prisma.js";

const createSchema = z
  .object({
    code: z.string().trim().min(1).max(64),
    name: z.string().trim().min(1).max(120),
    description: z.string().trim().max(500).optional(),
    sortOrder: z.number().int().min(0).max(9999).optional()
  })
  .strict();

const updateSchema = z
  .object({
    code: z.string().trim().min(1).max(64).optional(),
    name: z.string().trim().min(1).max(120).optional(),
    description: z.string().trim().max(500).nullable().optional(),
    isActive: z.boolean().optional(),
    sortOrder: z.number().int().min(0).max(9999).optional()
  })
  .strict();

const listQuerySchema = z
  .object({
    includeInactive: z.preprocess(
      (v) => (typeof v === "string" ? v === "true" || v === "1" : v),
      z.boolean().optional().default(false)
    )
  })
  .strict();

export const competencyTemplateRoutes: FastifyPluginAsync = async (app) => {
  // List — any authenticated user. The eval form uses this; everyone in the
  // tenant can read it. Inactive templates are filtered out by default; the
  // admin page passes ?includeInactive=true to manage them.
  app.get("/competency-templates", async (request) => {
    const tenantId = requireTenantId(request);
    const parsed = listQuerySchema.safeParse(request.query ?? {});
    if (!parsed.success) {
      throw app.httpErrors.badRequest(zodMsg(parsed.error));
    }
    return prisma.competencyTemplate.findMany({
      where: {
        tenantId,
        ...(parsed.data.includeInactive ? {} : { isActive: true })
      },
      orderBy: [{ sortOrder: "asc" }, { name: "asc" }]
    });
  });

  app.post("/competency-templates", async (request, reply) => {
    requireRoleAtLeast(request, UserRole.ADMIN);
    const tenantId = requireTenantId(request);
    const parsed = createSchema.safeParse(request.body);
    if (!parsed.success) {
      throw app.httpErrors.badRequest(zodMsg(parsed.error));
    }
    const dup = await prisma.competencyTemplate.findUnique({
      where: { tenantId_code: { tenantId, code: parsed.data.code } }
    });
    if (dup) {
      throw app.httpErrors.conflict("Competency code already exists.");
    }
    const created = await prisma.competencyTemplate.create({
      data: {
        tenantId,
        code: parsed.data.code,
        name: parsed.data.name,
        description: parsed.data.description ?? null,
        sortOrder: parsed.data.sortOrder ?? 0
      }
    });
    return reply.code(201).send(created);
  });

  app.patch("/competency-templates/:id", async (request) => {
    requireRoleAtLeast(request, UserRole.ADMIN);
    const tenantId = requireTenantId(request);
    const params = request.params as { id: string };
    const parsed = updateSchema.safeParse(request.body);
    if (!parsed.success) {
      throw app.httpErrors.badRequest(zodMsg(parsed.error));
    }
    const existing = await prisma.competencyTemplate.findFirst({
      where: { id: params.id, tenantId }
    });
    if (!existing) {
      throw app.httpErrors.notFound("Competency template not found.");
    }
    if (parsed.data.code && parsed.data.code !== existing.code) {
      const dup = await prisma.competencyTemplate.findUnique({
        where: { tenantId_code: { tenantId, code: parsed.data.code } }
      });
      if (dup) {
        throw app.httpErrors.conflict("Competency code already exists.");
      }
    }
    return prisma.competencyTemplate.update({
      where: { id: params.id },
      data: {
        code: parsed.data.code,
        name: parsed.data.name,
        description:
          parsed.data.description === undefined ? undefined : parsed.data.description,
        isActive: parsed.data.isActive,
        sortOrder: parsed.data.sortOrder
      }
    });
  });

  // Soft delete only — historical scores keep their FK via isActive=false.
  // A hard delete would Restrict if any score references this template.
  app.delete("/competency-templates/:id", async (request, reply) => {
    requireRoleAtLeast(request, UserRole.ADMIN);
    const tenantId = requireTenantId(request);
    const params = request.params as { id: string };
    const existing = await prisma.competencyTemplate.findFirst({
      where: { id: params.id, tenantId }
    });
    if (!existing) {
      throw app.httpErrors.notFound("Competency template not found.");
    }
    await prisma.competencyTemplate.update({
      where: { id: params.id },
      data: { isActive: false }
    });
    return reply.code(204).send();
  });
};
