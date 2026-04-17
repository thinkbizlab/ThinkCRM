import { Prisma } from "@prisma/client";
import { prisma } from "./prisma.js";

export async function logAuditEvent(
  tenantId: string,
  userId: string | null,
  action: string,
  detail?: Record<string, unknown>,
  ipAddress?: string
): Promise<void> {
  try {
    await prisma.auditLog.create({
      data: {
        tenantId,
        userId,
        action,
        detail: detail !== undefined ? (detail as Prisma.InputJsonValue) : undefined,
        ipAddress: ipAddress ?? undefined
      }
    });
  } catch {
    // Audit logging must never crash the caller
  }
}
