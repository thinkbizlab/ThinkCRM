-- Mobile sync-queue discard analytics. When a rep manually discards a
-- permanently-failed offline action (typically 4xx from the visit check-in
-- routes after retries exhaust), the client posts a row here so admins can
-- spot patterns ("3 reps discarded check-ins, all with HTTP 410").
-- Pruned by the data-retention cron after 90 days.
CREATE TABLE "SyncDiscardEvent" (
  "id"                TEXT NOT NULL,
  "tenantId"          TEXT NOT NULL,
  "userId"            TEXT NOT NULL,
  "kind"              TEXT NOT NULL,
  "visitId"           TEXT NOT NULL,
  "retryCount"        INTEGER NOT NULL,
  "lastError"         TEXT,
  "queuedDurationMs"  INTEGER NOT NULL,
  "platform"          TEXT NOT NULL,
  "createdAt"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "SyncDiscardEvent_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "SyncDiscardEvent_tenant_createdAt_idx"      ON "SyncDiscardEvent" ("tenantId", "createdAt");
CREATE INDEX "SyncDiscardEvent_tenant_kind_createdAt_idx" ON "SyncDiscardEvent" ("tenantId", "kind", "createdAt");

ALTER TABLE "SyncDiscardEvent"
  ADD CONSTRAINT "SyncDiscardEvent_tenantId_fkey"
  FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
