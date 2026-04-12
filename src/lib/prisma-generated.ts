/**
 * Re-export Prisma enums and the `Prisma` type namespace from the generated client.
 * Avoids `@prisma/client` → `.prisma` re-exports that some TS setups resolve incorrectly.
 */
export {
  DealStatus,
  EntityType,
  VisitStatus,
  VisitType
} from "../../node_modules/.prisma/client/index.js";

export type { Prisma } from "../../node_modules/.prisma/client/index.js";
