import type { UserRole } from "@prisma/client";

declare module "fastify" {
  interface FastifyRequest {
    requestContext: {
      tenantId: string | null;
      userId: string | null;
      role: UserRole | null;
      email: string | null;
      authenticated: boolean;
    };
  }
}

export {};
