/**
 * Re-export Prisma enums and the `Prisma` type namespace from the generated
 * client. Kept as a thin shim purely to centralise the import — the rest of
 * the codebase imports the same symbols straight from `@prisma/client`.
 *
 * Historically this file used a relative `../../node_modules/.prisma/client`
 * path to work around an old TS resolver quirk. That path broke in git
 * worktrees (node_modules lives at the main repo root, not at the worktree
 * root), so we now use the bare `@prisma/client` specifier which resolves
 * correctly from any depth via Node's upward node_modules walk.
 */
export {
  DealStatus,
  EntityType,
  VisitStatus,
  VisitType
} from "@prisma/client";

export type { Prisma } from "@prisma/client";
