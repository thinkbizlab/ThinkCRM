import fp from "fastify-plugin";
import { UserRole } from "@prisma/client";

export const requestContextPlugin = fp(async (app) => {
  app.addHook("onRequest", async (request) => {
    // S2: Only accept identity from a verified JWT — never from raw headers.
    // The previous x-tenant-id / x-user-id / x-user-role header fallback was
    // removed because any unauthenticated caller could set those headers and
    // impersonate any user in any tenant (critical auth bypass).
    const authHeader = request.headers.authorization;
    if (typeof authHeader === "string" && authHeader.startsWith("Bearer ")) {
      const token = authHeader.slice("Bearer ".length).trim();
      try {
        const payload = await app.jwt.verify<{
          tenantId: string;
          userId: string;
          role: UserRole;
          email?: string;
        }>(token);
        request.requestContext = {
          tenantId: payload.tenantId,
          userId: payload.userId,
          role: payload.role,
          email: payload.email ?? null,
          authenticated: true
        };
        return;
      } catch {
        // Invalid or expired token — treat as unauthenticated.
      }
    }

    request.requestContext = {
      tenantId: null,
      userId: null,
      role: null,
      email: null,
      authenticated: false
    };
  });
});
