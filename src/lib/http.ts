import { UserRole } from "@prisma/client";
import type { FastifyRequest } from "fastify";
import { prisma } from "./prisma.js";

const roleRank: Record<UserRole, number> = {
  REP: 1,
  SUPERVISOR: 2,
  MANAGER: 3,
  ADMIN: 4
};

export function requireAuth(request: FastifyRequest): void {
  if (!request.requestContext.authenticated) {
    throw request.server.httpErrors.unauthorized(
      "Authentication required. Use Authorization: Bearer <token>."
    );
  }
}

export function requireTenantId(request: FastifyRequest): string {
  requireAuth(request);
  const tenantId = request.requestContext.tenantId;
  if (!tenantId) {
    throw request.server.httpErrors.unauthorized(
      "Missing tenant context in authenticated token."
    );
  }
  return tenantId;
}

export function requireUserId(request: FastifyRequest): string {
  requireAuth(request);
  const userId = request.requestContext.userId;
  if (!userId) {
    throw request.server.httpErrors.unauthorized(
      "Missing user context in authenticated token."
    );
  }
  return userId;
}

export function requireRoleAtLeast(request: FastifyRequest, minimumRole: UserRole): void {
  requireAuth(request);
  const role = request.requestContext.role;
  if (!role || roleRank[role] < roleRank[minimumRole]) {
    throw request.server.httpErrors.forbidden(
      `Insufficient role. Requires ${minimumRole} or higher.`
    );
  }
}

export function assertTenantPathAccess(request: FastifyRequest, tenantIdFromPath: string): void {
  const tokenTenantId = requireTenantId(request);
  if (tenantIdFromPath !== tokenTenantId) {
    throw request.server.httpErrors.forbidden("Cross-tenant access is not allowed.");
  }
}

export async function requireSelfOrManagerAccess(
  request: FastifyRequest,
  targetUserId: string
): Promise<void> {
  const visibleUserIds = await listVisibleUserIds(request);
  if (visibleUserIds.has(targetUserId)) {
    return;
  }
  const tenantId = requireTenantId(request);
  const target = await prisma.user.findFirst({
    where: { id: targetUserId, tenantId },
    select: { id: true }
  });
  if (!target) {
    throw request.server.httpErrors.notFound("Target user not found in tenant.");
  }
  throw request.server.httpErrors.forbidden("No hierarchy access to target user.");
}

type UserHierarchyNode = {
  id: string;
  managerUserId: string | null;
};

function resolveVisibleUserIdsByHierarchy(
  users: UserHierarchyNode[],
  requesterId: string,
  requesterRole: UserRole
): Set<string> {
  if (requesterRole === UserRole.ADMIN) {
    return new Set(users.map((user) => user.id));
  }
  if (requesterRole === UserRole.REP) {
    return new Set([requesterId]);
  }

  const reportsByManager = users.reduce<Map<string, string[]>>((acc, user) => {
    if (!user.managerUserId) return acc;
    const reportIds = acc.get(user.managerUserId) ?? [];
    reportIds.push(user.id);
    acc.set(user.managerUserId, reportIds);
    return acc;
  }, new Map());

  const visible = new Set<string>([requesterId]);
  const queue = [requesterId];
  while (queue.length > 0) {
    const current = queue.shift();
    if (!current) continue;
    const reports = reportsByManager.get(current) ?? [];
    for (const reportId of reports) {
      if (visible.has(reportId)) {
        continue;
      }
      visible.add(reportId);
      queue.push(reportId);
    }
  }
  return visible;
}

export async function listVisibleUserIds(request: FastifyRequest): Promise<Set<string>> {
  const tenantId = requireTenantId(request);
  const requesterId = requireUserId(request);
  const requesterRole = request.requestContext.role;
  if (!requesterRole) {
    throw request.server.httpErrors.unauthorized("Missing role context in authenticated token.");
  }

  const users = await prisma.user.findMany({
    where: { tenantId, isActive: true },
    select: { id: true, managerUserId: true }
  });

  const visible = resolveVisibleUserIdsByHierarchy(users, requesterId, requesterRole);
  if (!visible.has(requesterId)) {
    visible.add(requesterId);
  }
  return visible;
}

export async function assertUserInHierarchyScope(
  request: FastifyRequest,
  targetUserId: string
): Promise<void> {
  const visibleUserIds = await listVisibleUserIds(request);
  if (visibleUserIds.has(targetUserId)) {
    return;
  }
  throw request.server.httpErrors.forbidden("Requested record is outside hierarchy scope.");
}
