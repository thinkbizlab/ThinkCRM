import fp from "fastify-plugin";
import { UserRole } from "@prisma/client";

const roleSet = new Set<string>(Object.values(UserRole));

export const requestContextPlugin = fp(async (app) => {
  app.addHook("onRequest", async (request) => {
    const authHeader = request.headers.authorization;
    if (typeof authHeader === "string" && authHeader.startsWith("Bearer ")) {
      const token = authHeader.slice("Bearer ".length).trim();
      try {
        const payload = await app.jwt.verify<{
          tenantId: string;
          userId: string;
          role: UserRole;
        }>(token);
        request.requestContext = {
          tenantId: payload.tenantId,
          userId: payload.userId,
          role: payload.role,
          authenticated: true
        };
        return;
      } catch {
        request.requestContext = {
          tenantId: null,
          userId: null,
          role: null,
          authenticated: false
        };
        return;
      }
    }

    const tenantId = request.headers["x-tenant-id"];
    const userId = request.headers["x-user-id"];
    const role = request.headers["x-user-role"];

    const parsedRole =
      typeof role === "string" && roleSet.has(role) ? (role as UserRole) : null;

    request.requestContext = {
      tenantId: typeof tenantId === "string" ? tenantId : null,
      userId: typeof userId === "string" ? userId : null,
      role: parsedRole,
      authenticated: false
    };
  });
});
