import { UserRole } from "@prisma/client";
import type { FastifyRequest } from "fastify";
import type { ZodError } from "zod";
import { config } from "../config.js";
import { prisma } from "./prisma.js";

/** Convert a ZodError into a short, user-friendly message. */
export function zodMsg(err: ZodError): string {
  return err.issues
    .map(i => {
      const field = i.path.length ? i.path.join(".") : undefined;
      return field ? `${field}: ${i.message}` : i.message;
    })
    .join("; ");
}

const superAdminEmails: Set<string> = new Set(
  (config.SUPER_ADMIN_EMAILS ?? "").split(",").map(e => e.trim().toLowerCase()).filter(Boolean)
);

// Rank is used by requireRoleAtLeast to gate admin-ish endpoints. SALES_ADMIN
// and ASSISTANT_MANAGER share rank with the "closest" traditional role for
// CRUD purposes — their real power comes from UserDelegation rows, not rank.
// Approval authority is a SEPARATE axis (see requireApprovalAuthority) that
// excludes these two roles regardless of rank.
const roleRank: Record<UserRole, number> = {
  REP: 1,
  SALES_ADMIN: 2,       // CRUD rank = SUPERVISOR; approval blocked
  SUPERVISOR: 2,
  MANAGER: 3,
  ASSISTANT_MANAGER: 3, // CRUD rank = MANAGER; approval blocked
  DIRECTOR: 4,
  ADMIN: 5
};

// Roles that may NOT approve (deal discount above threshold, future quotation
// approvals, etc.) — they can prepare and submit on the owner's behalf but the
// approval action itself must be performed by someone with actual authority.
const NON_APPROVING_ROLES: ReadonlySet<UserRole> = new Set([
  UserRole.SALES_ADMIN,
  UserRole.ASSISTANT_MANAGER
]);

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

// Gate approval actions (deal discount override, future quotation approvals)
// so SALES_ADMIN and ASSISTANT_MANAGER — who can otherwise act on their
// principals' behalf — cannot rubber-stamp their own submissions. Must also
// pass a minimum role, since even a REP shouldn't approve a MANAGER's deal.
export function requireApprovalAuthority(
  request: FastifyRequest,
  minimumRole: UserRole = UserRole.MANAGER
): void {
  requireRoleAtLeast(request, minimumRole);
  const role = request.requestContext.role;
  if (role && NON_APPROVING_ROLES.has(role)) {
    throw request.server.httpErrors.forbidden(
      "Approval actions cannot be performed by delegate roles."
    );
  }
}

export function isSuperAdmin(request: FastifyRequest): boolean {
  if (!request.requestContext.authenticated) return false;
  const email = request.requestContext.email;
  return Boolean(email && superAdminEmails.has(email.toLowerCase()));
}

export function requireSuperAdmin(request: FastifyRequest): void {
  requireAuth(request);
  if (!isSuperAdmin(request)) {
    throw request.server.httpErrors.forbidden("Super admin access required.");
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

export type UserHierarchyNode = {
  id: string;
  managerUserId: string | null;
  role?: UserRole | null;
};

// Roles whose base visibility is "self only" — they see no one else through
// the manager tree. Delegation adds their principals' visibility on top.
const SELF_ONLY_ROLES: ReadonlySet<UserRole> = new Set([
  UserRole.REP,
  UserRole.SALES_ADMIN,
  UserRole.ASSISTANT_MANAGER
]);

function walkSubtree(rootId: string, reportsByManager: Map<string, string[]>): Set<string> {
  const visible = new Set<string>([rootId]);
  const queue = [rootId];
  while (queue.length > 0) {
    const current = queue.shift();
    if (!current) continue;
    for (const reportId of reportsByManager.get(current) ?? []) {
      if (visible.has(reportId)) continue;
      visible.add(reportId);
      queue.push(reportId);
    }
  }
  return visible;
}

export function resolveVisibleUserIds(
  users: UserHierarchyNode[],
  requesterId: string,
  requesterRole: UserRole | null | undefined,
  activePrincipalIds: ReadonlyArray<string> = []
): Set<string> {
  if (requesterRole === UserRole.ADMIN) {
    return new Set(users.map((user) => user.id));
  }

  const reportsByManager = users.reduce<Map<string, string[]>>((acc, user) => {
    if (!user.managerUserId) return acc;
    const reportIds = acc.get(user.managerUserId) ?? [];
    reportIds.push(user.id);
    acc.set(user.managerUserId, reportIds);
    return acc;
  }, new Map());

  // Base visibility from requester's own role. Self-only roles (REP,
  // SALES_ADMIN, ASSISTANT_MANAGER) see nobody; others walk their subtree.
  const base = requesterRole && SELF_ONLY_ROLES.has(requesterRole)
    ? new Set<string>([requesterId])
    : walkSubtree(requesterId, reportsByManager);

  // Each active principal contributes THEIR visibility — i.e. the subtree
  // they'd see if they were logged in. Union'd into the delegate's view.
  const userById = new Map(users.map((u) => [u.id, u]));
  for (const principalId of activePrincipalIds) {
    const principal = userById.get(principalId);
    if (!principal) continue;
    if (principal.role === UserRole.ADMIN) {
      return new Set(users.map((u) => u.id));
    }
    if (principal.role && SELF_ONLY_ROLES.has(principal.role)) {
      base.add(principalId);
      continue;
    }
    for (const id of walkSubtree(principalId, reportsByManager)) {
      base.add(id);
    }
  }

  base.add(requesterId);
  return base;
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
const activePrincipalsCache = new WeakMap<object, Set<string>>();

// Active principals = users this request's caller is currently delegated to
// act on behalf of. "Active" means now() is within [startsAt, endsAt).
export async function listActivePrincipalIds(request: FastifyRequest): Promise<Set<string>> {
  const cached = activePrincipalsCache.get(request);
  if (cached) return cached;

  const tenantId = requireTenantId(request);
  const delegateUserId = requireUserId(request);
  const now = new Date();

  const rows = await prisma.userDelegation.findMany({
    where: {
      tenantId,
      delegateUserId,
      startsAt: { lte: now },
      endsAt:   { gt:  now }
    },
    select: { principalUserId: true }
  });

  const ids = new Set(rows.map((r) => r.principalUserId));
  activePrincipalsCache.set(request, ids);
  return ids;
}

export async function listVisibleUserIds(request: FastifyRequest): Promise<Set<string>> {
  const cached = visibleIdsCache.get(request);
  if (cached) return cached;

  const tenantId = requireTenantId(request);
  const requesterId = requireUserId(request);
  const requesterRole = request.requestContext.role;
  if (!requesterRole) {
    throw request.server.httpErrors.unauthorized("Missing role context in authenticated token.");
  }

  const [users, principalIds] = await Promise.all([
    prisma.user.findMany({
      where: { tenantId, isActive: true },
      select: { id: true, managerUserId: true, role: true }
    }),
    listActivePrincipalIds(request)
  ]);

  const visible = resolveVisibleUserIds(users, requesterId, requesterRole, Array.from(principalIds));
  visibleIdsCache.set(request, visible);
  return visible;
}

// Check a delegate may act on behalf of the given principal. Returns true
// when callerId === principalUserId (acting as self) OR when there is an
// active delegation. Used by write paths that accept onBehalfOfUserId.
export async function canActOnBehalfOf(
  request: FastifyRequest,
  principalUserId: string
): Promise<boolean> {
  const callerId = requireUserId(request);
  if (callerId === principalUserId) return true;
  const active = await listActivePrincipalIds(request);
  return active.has(principalUserId);
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
