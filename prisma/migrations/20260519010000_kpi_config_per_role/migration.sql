-- Per-role KPI configuration: add a `role` column to TenantKpiMetricConfig so
-- a tenant can show reps a different metric set from managers / directors.
--
-- Migration strategy:
--   1. Add `role` column with default REP (gives a value to every existing row).
--   2. Drop the old (tenantId, metricKey) unique.
--   3. Fan out each REP-row into matching SUPERVISOR / MANAGER / DIRECTOR rows
--      so the previous "all roles see the same 3 metrics" behaviour is
--      preserved. Admins are intentionally NOT seeded — they never had KPIs.
--   4. Add the new (tenantId, role, metricKey) unique + supporting index.

ALTER TABLE "TenantKpiMetricConfig" ADD COLUMN "role" "UserRole" NOT NULL DEFAULT 'REP';

DROP INDEX IF EXISTS "TenantKpiMetricConfig_tenantId_metricKey_key";

INSERT INTO "TenantKpiMetricConfig"
  ("id", "tenantId", "role", "metricKey", "labelTh", "labelEn", "sortOrder", "isActive", "alertThreshold", "createdAt", "updatedAt")
SELECT
  gen_random_uuid()::text,
  c."tenantId",
  r."role"::"UserRole",
  c."metricKey",
  c."labelTh",
  c."labelEn",
  c."sortOrder",
  c."isActive",
  c."alertThreshold",
  c."createdAt",
  c."updatedAt"
FROM "TenantKpiMetricConfig" c
CROSS JOIN (VALUES ('SUPERVISOR'), ('MANAGER'), ('DIRECTOR')) AS r("role")
WHERE c."role" = 'REP'
  AND NOT EXISTS (
    SELECT 1 FROM "TenantKpiMetricConfig" x
    WHERE x."tenantId" = c."tenantId"
      AND x."role"::text = r."role"
      AND x."metricKey" = c."metricKey"
  );

DROP INDEX IF EXISTS "TenantKpiMetricConfig_tenantId_isActive_sortOrder_idx";
CREATE UNIQUE INDEX "TenantKpiMetricConfig_tenantId_role_metricKey_key"
  ON "TenantKpiMetricConfig"("tenantId", "role", "metricKey");
CREATE INDEX "TenantKpiMetricConfig_tenantId_role_isActive_sortOrder_idx"
  ON "TenantKpiMetricConfig"("tenantId", "role", "isActive", "sortOrder");
