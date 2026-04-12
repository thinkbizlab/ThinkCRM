import type { UserRole } from "@prisma/client";

declare module "@fastify/jwt" {
  interface FastifyJWT {
    payload: {
      userId: string;
      tenantId: string;
      role: UserRole;
      email: string;
    };
    user: {
      userId: string;
      tenantId: string;
      role: UserRole;
      email: string;
    };
  }
}

export {};
