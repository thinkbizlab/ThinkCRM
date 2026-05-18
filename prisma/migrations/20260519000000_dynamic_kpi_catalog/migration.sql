-- Dynamic per-tenant KPI metrics — introduce a per-tenant config table and a
-- per-metric target table. Backfill keeps every existing tenant's screens
-- looking the same by seeding the three legacy metrics and copying the three
-- legacy columns into rows under those keys.

-- 1) Per-tenant metric configuration ---------------------------------------
CREATE TABLE "TenantKpiMetricConfig" (
  "id"             TEXT NOT NULL,
  "tenantId"       TEXT NOT NULL,
  "metricKey"      TEXT NOT NULL,
  "labelTh"        TEXT,
  "labelEn"        TEXT,
  "sortOrder"      INTEGER NOT NULL DEFAULT 0,
  "isActive"       BOOLEAN NOT NULL DEFAULT true,
  "alertThreshold" DOUBLE PRECISION,
  "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"      TIMESTAMP(3) NOT NULL,
  CONSTRAINT "TenantKpiMetricConfig_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "TenantKpiMetricConfig_tenantId_metricKey_key"
  ON "TenantKpiMetricConfig"("tenantId", "metricKey");
CREATE INDEX "TenantKpiMetricConfig_tenantId_isActive_sortOrder_idx"
  ON "TenantKpiMetricConfig"("tenantId", "isActive", "sortOrder");

ALTER TABLE "TenantKpiMetricConfig"
  ADD CONSTRAINT "TenantKpiMetricConfig_tenantId_fkey"
  FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- 2) Per-(tenant,user,month,metric) target value ---------------------------
CREATE TABLE "SalesKpiTargetMetric" (
  "id"          TEXT NOT NULL,
  "tenantId"    TEXT NOT NULL,
  "userId"      TEXT NOT NULL,
  "targetMonth" TEXT NOT NULL,
  "metricKey"   TEXT NOT NULL,
  "targetValue" DOUBLE PRECISION NOT NULL,
  "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"   TIMESTAMP(3) NOT NULL,
  CONSTRAINT "SalesKpiTargetMetric_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "SalesKpiTargetMetric_tenantId_userId_targetMonth_metricKey_key"
  ON "SalesKpiTargetMetric"("tenantId", "userId", "targetMonth", "metricKey");
CREATE INDEX "SalesKpiTargetMetric_tenantId_userId_targetMonth_idx"
  ON "SalesKpiTargetMetric"("tenantId", "userId", "targetMonth");
CREATE INDEX "SalesKpiTargetMetric_tenantId_metricKey_idx"
  ON "SalesKpiTargetMetric"("tenantId", "metricKey");

ALTER TABLE "SalesKpiTargetMetric"
  ADD CONSTRAINT "SalesKpiTargetMetric_tenantId_fkey"
  FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- 3) Seed every existing tenant with the 3 legacy metrics ------------------
--    `gen_random_uuid()::text` is good enough for the id column — Prisma's
--    cuid() default only fires at the application layer, but the type is
--    just TEXT so we can use any unique string here.
INSERT INTO "TenantKpiMetricConfig"
  ("id", "tenantId", "metricKey", "labelTh", "labelEn", "sortOrder", "isActive", "alertThreshold", "createdAt", "updatedAt")
SELECT
  gen_random_uuid()::text,
  t."id",
  m."metricKey",
  m."labelTh",
  m."labelEn",
  m."sortOrder",
  true,
  NULL,
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
FROM "Tenant" t
CROSS JOIN (VALUES
  ('VISIT_CHECKED_IN_COUNT', 'จำนวนการเช็คอินเยี่ยม', 'Visits checked in', 0),
  ('NEW_DEAL_VALUE',         'มูลค่าดีลใหม่',         'New deal value',    1),
  ('WON_DEAL_VALUE',         'ยอดขาย (ดีลที่ปิดได้)', 'Won deal value',    2)
) AS m("metricKey", "labelTh", "labelEn", "sortOrder")
WHERE NOT EXISTS (
  SELECT 1 FROM "TenantKpiMetricConfig" c
  WHERE c."tenantId" = t."id" AND c."metricKey" = m."metricKey"
);

-- 4) Backfill every existing SalesKpiTarget row into 3 metric rows --------
INSERT INTO "SalesKpiTargetMetric"
  ("id", "tenantId", "userId", "targetMonth", "metricKey", "targetValue", "createdAt", "updatedAt")
SELECT
  gen_random_uuid()::text,
  t."tenantId",
  t."userId",
  t."targetMonth",
  m."metricKey",
  m."targetValue",
  t."createdAt",
  t."updatedAt"
FROM "SalesKpiTarget" t
CROSS JOIN LATERAL (VALUES
  ('VISIT_CHECKED_IN_COUNT', t."visitTargetCount"::double precision),
  ('NEW_DEAL_VALUE',         t."newDealValueTarget"),
  ('WON_DEAL_VALUE',         t."revenueTarget")
) AS m("metricKey", "targetValue")
WHERE NOT EXISTS (
  SELECT 1 FROM "SalesKpiTargetMetric" x
  WHERE x."tenantId" = t."tenantId"
    AND x."userId"   = t."userId"
    AND x."targetMonth" = t."targetMonth"
    AND x."metricKey" = m."metricKey"
);
