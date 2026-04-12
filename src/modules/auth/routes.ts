import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { requireAuth, requireTenantId, requireUserId } from "../../lib/http.js";
import { hashPassword, verifyPassword } from "../../lib/password.js";
import { prisma } from "../../lib/prisma.js";

const loginSchema = z.object({
  tenantSlug: z.string().min(2),
  email: z.string().email(),
  password: z.string().min(8)
});

const firstLoginResetSchema = z.object({
  tenantSlug: z.string().min(2),
  email: z.string().email(),
  currentPassword: z.string().min(8),
  newPassword: z.string().min(8)
});

export const authRoutes: FastifyPluginAsync = async (app) => {
  app.post("/auth/login", async (request) => {
    const parsed = loginSchema.safeParse(request.body);
    if (!parsed.success) {
      throw app.httpErrors.badRequest(parsed.error.message);
    }

    const tenant = await prisma.tenant.findUnique({
      where: { slug: parsed.data.tenantSlug },
      select: { id: true, slug: true, name: true }
    });
    if (!tenant) {
      throw app.httpErrors.unauthorized("Invalid tenant or credentials.");
    }

    const user = await prisma.user.findFirst({
      where: {
        tenantId: tenant.id,
        email: parsed.data.email,
        isActive: true
      }
    });
    if (!user || !verifyPassword(parsed.data.password, user.passwordHash)) {
      throw app.httpErrors.unauthorized("Invalid tenant or credentials.");
    }
    if (user.mustResetPassword) {
      throw app.httpErrors.forbidden("First login password reset required.");
    }

    const accessToken = await app.jwt.sign({
      userId: user.id,
      tenantId: tenant.id,
      role: user.role,
      email: user.email
    });

    return {
      accessToken,
      tokenType: "Bearer",
      user: {
        id: user.id,
        tenantId: tenant.id,
        role: user.role,
        email: user.email,
        fullName: user.fullName
      }
    };
  });

  app.post("/auth/first-login-reset", async (request) => {
    const parsed = firstLoginResetSchema.safeParse(request.body);
    if (!parsed.success) {
      throw app.httpErrors.badRequest(parsed.error.message);
    }
    if (parsed.data.currentPassword === parsed.data.newPassword) {
      throw app.httpErrors.badRequest("New password must be different from current password.");
    }

    const tenant = await prisma.tenant.findUnique({
      where: { slug: parsed.data.tenantSlug },
      select: { id: true }
    });
    if (!tenant) {
      throw app.httpErrors.unauthorized("Invalid tenant or credentials.");
    }

    const user = await prisma.user.findFirst({
      where: {
        tenantId: tenant.id,
        email: parsed.data.email,
        isActive: true
      }
    });
    if (!user || !verifyPassword(parsed.data.currentPassword, user.passwordHash)) {
      throw app.httpErrors.unauthorized("Invalid tenant or credentials.");
    }
    if (!user.mustResetPassword) {
      throw app.httpErrors.badRequest("Password reset is not required for this account.");
    }

    await prisma.user.update({
      where: { id: user.id },
      data: {
        passwordHash: hashPassword(parsed.data.newPassword),
        mustResetPassword: false
      }
    });

    return { message: "Password reset completed. Please login again." };
  });

  app.get("/auth/me", async (request) => {
    requireAuth(request);
    const tenantId = requireTenantId(request);
    const userId = requireUserId(request);
    const user = await prisma.user.findFirst({
      where: { id: userId, tenantId },
      select: {
        id: true,
        email: true,
        fullName: true,
        role: true,
        mustResetPassword: true,
        tenantId: true,
        managerUserId: true,
        teamId: true
      }
    });
    if (!user) {
      throw app.httpErrors.notFound("Authenticated user not found.");
    }
    return user;
  });
};
