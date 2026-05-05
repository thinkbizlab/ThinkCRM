import type { FastifyRequest } from "fastify";
import { UserRole } from "@prisma/client";
import { listVisibleUserIds, requireUserId } from "./http.js";
import { prisma } from "./prisma.js";

export type CoVisitRepShape = {
  id: string;
  managerUserId: string | null;
  teamId: string | null;
};

// Returns true when the requester is allowed to co-visit `rep`. Rules:
//   ADMIN                                       — any rep in the tenant
//   DIRECTOR / MANAGER / SUPERVISOR             — anyone in their walkSubtree
//   ASSISTANT_MANAGER / SALES_ADMIN             — same User.teamId as the rep
//   REP                                         — never
//
// AM/SA are in SELF_ONLY_ROLES (http.ts) and have no subtree, so we use the
// shared-team scope instead. Both observer and rep must have a non-null teamId
// — a missing teamId fails closed.
export async function canCoVisitRep(
  request: FastifyRequest,
  rep: CoVisitRepShape
): Promise<boolean> {
  const observerId = requireUserId(request);
  const observerRole = request.requestContext.role;
  if (!observerRole) return false;
  if (observerRole === UserRole.REP) return false;
  if (observerRole === UserRole.ADMIN) return true;

  if (
    observerRole === UserRole.ASSISTANT_MANAGER ||
    observerRole === UserRole.SALES_ADMIN
  ) {
    const observer = await prisma.user.findUnique({
      where: { id: observerId },
      select: { teamId: true }
    });
    if (!observer?.teamId || !rep.teamId) return false;
    return observer.teamId === rep.teamId;
  }

  // SUPERVISOR / MANAGER / DIRECTOR — subtree
  const visibleIds = await listVisibleUserIds(request);
  return visibleIds.has(rep.id);
}
