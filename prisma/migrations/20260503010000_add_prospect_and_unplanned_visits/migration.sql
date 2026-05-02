-- Add the Prospect entity for unplanned visits.
-- Visit.customerId becomes nullable; Visit.prospectId is added.
-- DB CHECK constraint enforces "exactly one of (customerId, prospectId)" at write time.

CREATE TYPE "ProspectStatus" AS ENUM ('UNIDENTIFIED', 'IDENTIFIED', 'LINKED', 'ARCHIVED');

CREATE TABLE "Prospect" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "status" "ProspectStatus" NOT NULL DEFAULT 'UNIDENTIFIED',
    "displayName" TEXT,
    "siteLat" DOUBLE PRECISION,
    "siteLng" DOUBLE PRECISION,
    "siteAddress" TEXT,
    "contactName" TEXT,
    "contactPhone" TEXT,
    "notes" TEXT,
    "linkedCustomerId" TEXT,
    "createdById" TEXT NOT NULL,
    "updatedById" TEXT,
    "archivedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Prospect_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "Prospect_tenantId_status_idx" ON "Prospect"("tenantId", "status");
CREATE INDEX "Prospect_tenantId_createdAt_idx" ON "Prospect"("tenantId", "createdAt");
CREATE INDEX "Prospect_tenantId_linkedCustomerId_idx" ON "Prospect"("tenantId", "linkedCustomerId");

ALTER TABLE "Prospect" ADD CONSTRAINT "Prospect_tenantId_fkey"
  FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Prospect" ADD CONSTRAINT "Prospect_linkedCustomerId_fkey"
  FOREIGN KEY ("linkedCustomerId") REFERENCES "Customer"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Prospect" ADD CONSTRAINT "Prospect_createdById_fkey"
  FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Prospect" ADD CONSTRAINT "Prospect_updatedById_fkey"
  FOREIGN KEY ("updatedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "ProspectPhoto" (
    "id" TEXT NOT NULL,
    "prospectId" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "objectRef" TEXT NOT NULL,
    "caption" TEXT,
    "uploadedById" TEXT NOT NULL,
    "uploadedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProspectPhoto_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "ProspectPhoto_prospectId_idx" ON "ProspectPhoto"("prospectId");
CREATE INDEX "ProspectPhoto_tenantId_uploadedAt_idx" ON "ProspectPhoto"("tenantId", "uploadedAt");

ALTER TABLE "ProspectPhoto" ADD CONSTRAINT "ProspectPhoto_prospectId_fkey"
  FOREIGN KEY ("prospectId") REFERENCES "Prospect"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ProspectPhoto" ADD CONSTRAINT "ProspectPhoto_uploadedById_fkey"
  FOREIGN KEY ("uploadedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Tenant: per-tenant threshold for the stale-prospect digest section.
ALTER TABLE "Tenant" ADD COLUMN "staleProspectAlertDays" INTEGER NOT NULL DEFAULT 14;

-- Visit: customerId becomes nullable, add prospectId, enforce exactly-one constraint.
ALTER TABLE "Visit" DROP CONSTRAINT "Visit_customerId_fkey";
ALTER TABLE "Visit" ALTER COLUMN "customerId" DROP NOT NULL;
ALTER TABLE "Visit" ADD COLUMN "prospectId" TEXT;
ALTER TABLE "Visit" ADD CONSTRAINT "Visit_customerId_fkey"
  FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Visit" ADD CONSTRAINT "Visit_prospectId_fkey"
  FOREIGN KEY ("prospectId") REFERENCES "Prospect"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Visit" ADD CONSTRAINT "Visit_one_of_customer_or_prospect"
  CHECK (("customerId" IS NOT NULL AND "prospectId" IS NULL) OR ("customerId" IS NULL AND "prospectId" IS NOT NULL));

CREATE INDEX "Visit_tenantId_prospectId_idx" ON "Visit"("tenantId", "prospectId");
