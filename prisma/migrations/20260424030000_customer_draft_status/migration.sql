-- Field-prospect workflow: reps capture prospects as DRAFT customers before
-- ERP sync assigns a real customer code. DRAFT rows have NULL customerCode
-- and NULL defaultTermId until promotion. A DRAFT is promoted in place when
-- ERP sync imports a customer with a matching Tax ID; no row duplication,
-- no re-parenting needed because visits/deals already point at the id.

CREATE TYPE "CustomerStatus" AS ENUM ('DRAFT', 'ACTIVE');

-- DRAFT rows do not yet have a real ERP customerCode or a chosen payment term.
ALTER TABLE "Customer" ALTER COLUMN "customerCode" DROP NOT NULL;
ALTER TABLE "Customer" ALTER COLUMN "defaultTermId" DROP NOT NULL;

ALTER TABLE "Customer"
  ADD COLUMN "status" "CustomerStatus" NOT NULL DEFAULT 'ACTIVE',
  ADD COLUMN "draftCreatedByUserId" TEXT,
  ADD COLUMN "promotedAt" TIMESTAMP(3);

ALTER TABLE "Customer"
  ADD CONSTRAINT "Customer_draftCreatedByUserId_fkey"
  FOREIGN KEY ("draftCreatedByUserId") REFERENCES "User"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

-- Replace the full unique index on customerCode with a partial index that only
-- applies to ACTIVE rows. This preserves ERP code uniqueness for real customers
-- while letting many DRAFTs coexist with NULL codes.
DROP INDEX IF EXISTS "Customer_tenantId_customerCode_key";
CREATE UNIQUE INDEX "Customer_tenantId_customerCode_active_uq"
  ON "Customer" ("tenantId", "customerCode")
  WHERE "status" = 'ACTIVE';

CREATE INDEX "Customer_tenantId_status_idx" ON "Customer" ("tenantId", "status");
