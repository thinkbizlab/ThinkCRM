-- AlterEnum: add ASSISTANT_MANAGER and SALES_ADMIN to UserRole.
-- PostgreSQL requires ALTER TYPE ADD VALUE to run outside a transaction when
-- the new value is used in the same statement batch. We don't reference the
-- new values in this migration, so Prisma's implicit wrapper is fine on PG 12+.
ALTER TYPE "UserRole" ADD VALUE IF NOT EXISTS 'ASSISTANT_MANAGER';
ALTER TYPE "UserRole" ADD VALUE IF NOT EXISTS 'SALES_ADMIN';

-- AlterTable: add createdByUserId audit column to record tables. Nullable so
-- existing rows aren't broken; NULL means "created before the column existed"
-- or "created by a system path that didn't populate it."
ALTER TABLE "Customer" ADD COLUMN "createdByUserId" TEXT;
ALTER TABLE "Deal"     ADD COLUMN "createdByUserId" TEXT;
ALTER TABLE "Visit"    ADD COLUMN "createdByUserId" TEXT;

ALTER TABLE "Customer" ADD CONSTRAINT "Customer_createdByUserId_fkey"
  FOREIGN KEY ("createdByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Deal" ADD CONSTRAINT "Deal_createdByUserId_fkey"
  FOREIGN KEY ("createdByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Visit" ADD CONSTRAINT "Visit_createdByUserId_fkey"
  FOREIGN KEY ("createdByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- CreateTable: UserDelegation — maps delegate user -> principal user with a
-- validity window. endsAt defaults to far future so "no expiry" entries are
-- just normal rows; admins set an earlier endsAt for temp coverage.
CREATE TABLE "UserDelegation" (
  "id"              TEXT NOT NULL,
  "tenantId"        TEXT NOT NULL,
  "delegateUserId"  TEXT NOT NULL,
  "principalUserId" TEXT NOT NULL,
  "startsAt"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "endsAt"          TIMESTAMP(3) NOT NULL DEFAULT '9999-12-31 23:59:59'::timestamp,
  "createdAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"       TIMESTAMP(3) NOT NULL,
  CONSTRAINT "UserDelegation_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "UserDelegation_delegateUserId_principalUserId_key"
  ON "UserDelegation"("delegateUserId", "principalUserId");
CREATE INDEX "UserDelegation_tenantId_delegateUserId_idx"
  ON "UserDelegation"("tenantId", "delegateUserId");
CREATE INDEX "UserDelegation_tenantId_principalUserId_idx"
  ON "UserDelegation"("tenantId", "principalUserId");

ALTER TABLE "UserDelegation" ADD CONSTRAINT "UserDelegation_tenantId_fkey"
  FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "UserDelegation" ADD CONSTRAINT "UserDelegation_delegateUserId_fkey"
  FOREIGN KEY ("delegateUserId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "UserDelegation" ADD CONSTRAINT "UserDelegation_principalUserId_fkey"
  FOREIGN KEY ("principalUserId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
