-- Customer branch code (Thai-style: "00000" = HQ, "00001" = branch 1) and
-- corporate parent/child link.

ALTER TABLE "Customer" ADD COLUMN "branchCode" TEXT;
ALTER TABLE "Customer" ADD COLUMN "parentCustomerId" TEXT;

-- Backfill existing rows that have a Tax ID with branchCode = "00000" (HQ).
-- Rows without Tax ID stay NULL — branch code is meaningless without one.
UPDATE "Customer" SET "branchCode" = '00000' WHERE "taxId" IS NOT NULL;

-- Replace the (tenantId, taxId) unique with (tenantId, taxId, branchCode).
-- This lets two branches of the same legal entity coexist as separate rows.
-- Prisma generates @@unique as a UNIQUE INDEX, not a CONSTRAINT, so use DROP INDEX.
DROP INDEX "Customer_tenantId_taxId_key";
CREATE UNIQUE INDEX "Customer_tenantId_taxId_branchCode_key" ON "Customer"("tenantId", "taxId", "branchCode");

-- Self-referential FK for corporate hierarchy. SetNull so deleting a parent
-- leaves children intact (just orphaned).
ALTER TABLE "Customer" ADD CONSTRAINT "Customer_parentCustomerId_fkey"
  FOREIGN KEY ("parentCustomerId") REFERENCES "Customer"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Index for "show all children of customer X" queries.
CREATE INDEX "Customer_tenantId_parentCustomerId_idx" ON "Customer"("tenantId", "parentCustomerId");
