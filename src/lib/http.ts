import { UserRole } from "@prisma/client";
import type { FastifyRequest } from "fastify";
import { prisma } from "./prisma.js";

const roleRank: Record<UserRole, number> = {
  REP: 1,
  SUPERVISOR: 2,
  MANAGER: 3,
  DIRECTOR: 4,  // M6: was 3 (same as MANAGER) — requireRoleAtLeast(DIRECTOR) now correctly excludes MANAGERs
  ADMIN: 5
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

// S1: Per-request cache for tenant isActive check — avoids a DB hit on every call.
const tenantActiveCache = new WeakMap<object, boolean>();

/**
 * Checks that the tenant in the JWT is still active.
 * Throws 403 if the tenant has been deactivated.
 * No-op on unauthenticated requests (public routes).
 * Called once per request via a global preHandler hook in app.ts.
 */
export async function requireActiveTenant(request: FastifyRequest): Promise<void> {
  if (!request.requestContext.authenticated) return;
  const tenantId = request.requestContext.tenantId;
  if (!tenantId) return;

  const cached = tenantActiveCache.get(request);
  if (cached !== undefined) {
    if (!cached) throw request.server.httpErrors.forbidden("This workspace has been deactivated. Contact your administrator.");
    return;
  }

  const tenant = await prisma.tenant.findUnique({ where: { id: tenantId }, select: { isActive: true } });
  const active = tenant?.isActive ?? false;
  tenantActiveCache.set(request, active);
  if (!active) throw request.server.httpErrors.forbidden("This workspace has been deactivated. Contact your administrator.");
}

// H4: Per-request memo so hierarchy is computed only once per request even when
// multiple permission checks call listVisibleUserIds() on the same request object.
const visibleIdsCache = new WeakMap<object, Set<string>>();

export async function listVisibleUserIds(request: FastifyRequest): Promise<Set<string>> {
  const cached = visibleIdsCache.get(request);
  if (cached) return cached;

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
  visibleIdsCache.set(request, visible);
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
