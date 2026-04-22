-- Normalise empty-string externalRef to NULL before adding unique constraints
UPDATE "Customer" SET "externalRef" = NULL WHERE "externalRef" = '';
UPDATE "Item"     SET "externalRef" = NULL WHERE "externalRef" = '';

-- Collapse any accidental duplicates: keep only the most-recently-updated row with
-- a given (tenantId, externalRef); clear externalRef on older dupes.
WITH ranked AS (
  SELECT id,
         ROW_NUMBER() OVER (PARTITION BY "tenantId", "externalRef" ORDER BY "updatedAt" DESC, id DESC) AS rn
  FROM "Customer"
  WHERE "externalRef" IS NOT NULL
)
UPDATE "Customer" c SET "externalRef" = NULL
FROM ranked r
WHERE c.id = r.id AND r.rn > 1;

WITH ranked AS (
  SELECT id,
         ROW_NUMBER() OVER (PARTITION BY "tenantId", "externalRef" ORDER BY "updatedAt" DESC, id DESC) AS rn
  FROM "Item"
  WHERE "externalRef" IS NOT NULL
)
UPDATE "Item" i SET "externalRef" = NULL
FROM ranked r
WHERE i.id = r.id AND r.rn > 1;

-- Unique constraints on (tenantId, externalRef)
CREATE UNIQUE INDEX "Customer_tenantId_externalRef_key" ON "Customer"("tenantId", "externalRef");
CREATE UNIQUE INDEX "Item_tenantId_externalRef_key"     ON "Item"("tenantId", "externalRef");

-- TransformTemplate: tenant-scoped reusable transform chains
CREATE TABLE "TransformTemplate" (
  "id"          TEXT        NOT NULL,
  "tenantId"    TEXT        NOT NULL,
  "name"        TEXT        NOT NULL,
  "description" TEXT,
  "steps"       TEXT        NOT NULL,
  "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"   TIMESTAMP(3) NOT NULL,
  CONSTRAINT "TransformTemplate_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "TransformTemplate_tenantId_name_key" ON "TransformTemplate"("tenantId", "name");
CREATE INDEX "TransformTemplate_tenantId_idx" ON "TransformTemplate"("tenantId");

ALTER TABLE "TransformTemplate"
  ADD CONSTRAINT "TransformTemplate_tenantId_fkey"
  FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
