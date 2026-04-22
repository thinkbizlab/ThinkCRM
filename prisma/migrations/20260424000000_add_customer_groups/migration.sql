-- Customer Groups: tenant-scoped lookup table for classifying customers by
-- organization type (e.g. "University", "Government", "Factory", "SME",
-- "Corporate"). Powers dashboard roll-ups. Each customer optionally belongs
-- to exactly one group (nullable FK, SetNull on delete).

-- Extend EntityType enum used by CustomFieldDefinition / EntityChangelog.
ALTER TYPE "EntityType" ADD VALUE IF NOT EXISTS 'CUSTOMER_GROUP';

CREATE TABLE "CustomerGroup" (
  "id"           TEXT PRIMARY KEY,
  "tenantId"     TEXT NOT NULL REFERENCES "Tenant"("id") ON DELETE CASCADE,
  "code"         TEXT NOT NULL,
  "name"         TEXT NOT NULL,
  "description"  TEXT,
  "isActive"     BOOLEAN NOT NULL DEFAULT true,
  "customFields" JSONB,
  "createdAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"    TIMESTAMP(3) NOT NULL
);
CREATE UNIQUE INDEX "CustomerGroup_tenantId_code_key" ON "CustomerGroup"("tenantId", "code");
CREATE INDEX        "CustomerGroup_tenantId_idx"      ON "CustomerGroup"("tenantId");

ALTER TABLE "Customer"
  ADD COLUMN "customerGroupId" TEXT;
ALTER TABLE "Customer"
  ADD CONSTRAINT "Customer_customerGroupId_fkey"
  FOREIGN KEY ("customerGroupId") REFERENCES "CustomerGroup"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
CREATE INDEX "Customer_tenantId_customerGroupId_idx" ON "Customer"("tenantId", "customerGroupId");

-- Per-entity API lock (matches manageCustomersByApi / manageItemsByApi /
-- managePaymentTermsByApi).
ALTER TABLE "Tenant" ADD COLUMN "manageCustomerGroupsByApi" BOOLEAN NOT NULL DEFAULT false;
