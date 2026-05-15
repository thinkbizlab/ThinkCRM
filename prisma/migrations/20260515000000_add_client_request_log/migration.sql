-- Idempotency log for mobile-app requests. The offline-sync queue on the mobile
-- client retries failed POSTs (network drops, partial responses, etc.) using a
-- stable clientRequestId; the visit check-in / check-out routes look up
-- (tenantId, clientRequestId) and return the cached response instead of
-- mutating state again. Pruned by the data-retention cron after 24h.
CREATE TABLE "ClientRequestLog" (
  "tenantId"        TEXT NOT NULL,
  "clientRequestId" TEXT NOT NULL,
  "userId"          TEXT NOT NULL,
  "route"           TEXT NOT NULL,
  "responseStatus"  INTEGER NOT NULL,
  "responseBody"    JSONB NOT NULL,
  "createdAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ClientRequestLog_pkey" PRIMARY KEY ("tenantId", "clientRequestId")
);

CREATE INDEX "ClientRequestLog_createdAt_idx" ON "ClientRequestLog" ("createdAt");

ALTER TABLE "ClientRequestLog"
  ADD CONSTRAINT "ClientRequestLog_tenantId_fkey"
  FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
