-- Sync API Keys — per-tenant API keys for machine-to-machine inbound sync
CREATE TABLE "SyncApiKey" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "keyHash" TEXT NOT NULL,
    "keyPrefix" TEXT NOT NULL,
    "scopes" TEXT[],
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "lastUsedAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "SyncApiKey_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "SyncApiKey_keyHash_key" ON "SyncApiKey"("keyHash");
CREATE INDEX "SyncApiKey_tenantId_idx" ON "SyncApiKey"("tenantId");
ALTER TABLE "SyncApiKey" ADD CONSTRAINT "SyncApiKey_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Sync External Refs — maps external system IDs to internal CRM entity IDs
CREATE TABLE "SyncExternalRef" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "entityType" "EntityType" NOT NULL,
    "entityId" TEXT NOT NULL,
    "externalId" TEXT NOT NULL,
    "externalSource" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "SyncExternalRef_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "SyncExternalRef_tenantId_entityType_externalId_externalSource_key" ON "SyncExternalRef"("tenantId", "entityType", "externalId", "externalSource");
CREATE INDEX "SyncExternalRef_tenantId_entityType_entityId_idx" ON "SyncExternalRef"("tenantId", "entityType", "entityId");
ALTER TABLE "SyncExternalRef" ADD CONSTRAINT "SyncExternalRef_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
