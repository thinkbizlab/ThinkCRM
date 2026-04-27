-- DropForeignKey (IF EXISTS — constraint may already be absent on some branches)
ALTER TABLE "CustomerGroup" DROP CONSTRAINT IF EXISTS "CustomerGroup_tenantId_fkey";

-- DropForeignKey
ALTER TABLE "PasswordResetToken" DROP CONSTRAINT IF EXISTS "PasswordResetToken_tenantId_fkey";

-- DropForeignKey
ALTER TABLE "PasswordResetToken" DROP CONSTRAINT IF EXISTS "PasswordResetToken_userId_fkey";

-- DropIndex
DROP INDEX IF EXISTS "Customer_ownerId_idx";

-- AlterTable
ALTER TABLE "UserDelegation" ALTER COLUMN "endsAt" SET DEFAULT '9999-12-31 23:59:59'::timestamp;

-- CreateTable
CREATE TABLE IF NOT EXISTS "UserPasskey" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "credentialId" TEXT NOT NULL,
    "publicKey" BYTEA NOT NULL,
    "counter" BIGINT NOT NULL DEFAULT 0,
    "transports" TEXT[],
    "deviceName" TEXT NOT NULL DEFAULT 'Passkey',
    "aaguid" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastUsedAt" TIMESTAMP(3),

    CONSTRAINT "UserPasskey_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "WebAuthnChallenge" (
    "id" TEXT NOT NULL,
    "challenge" TEXT NOT NULL,
    "userId" TEXT,
    "tenantId" TEXT,
    "type" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WebAuthnChallenge_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "UserPasskey_credentialId_key" ON "UserPasskey"("credentialId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "UserPasskey_userId_idx" ON "UserPasskey"("userId");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "WebAuthnChallenge_challenge_key" ON "WebAuthnChallenge"("challenge");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "WebAuthnChallenge_expiresAt_idx" ON "WebAuthnChallenge"("expiresAt");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "Customer_tenantId_ownerId_idx" ON "Customer"("tenantId", "ownerId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "Customer_tenantId_customerCode_idx" ON "Customer"("tenantId", "customerCode");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "IntegrationSyncError_jobId_idx" ON "IntegrationSyncError"("jobId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "IntegrationSyncJob_tenantId_status_idx" ON "IntegrationSyncJob"("tenantId", "status");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "IntegrationSyncJob_sourceId_status_idx" ON "IntegrationSyncJob"("sourceId", "status");

-- AddForeignKey (skip if already present)
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'CustomerGroup_tenantId_fkey'
  ) THEN
    ALTER TABLE "CustomerGroup" ADD CONSTRAINT "CustomerGroup_tenantId_fkey"
      FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

-- AddForeignKey (skip if already present)
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'UserPasskey_userId_fkey'
  ) THEN
    ALTER TABLE "UserPasskey" ADD CONSTRAINT "UserPasskey_userId_fkey"
      FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

-- RenameIndex (skip if old name is gone or new name already exists)
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = 'CustomerDuplicateCandidate_tenantId_customerAId_customerBId_sig')
    AND NOT EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = 'CustomerDuplicateCandidate_tenantId_customerAId_customerBId_key')
  THEN
    ALTER INDEX "CustomerDuplicateCandidate_tenantId_customerAId_customerBId_sig"
      RENAME TO "CustomerDuplicateCandidate_tenantId_customerAId_customerBId_key";
  END IF;
END $$;

-- RenameIndex (skip if old name is gone or new name already exists)
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = 'SyncExternalRef_tenantId_entityType_externalId_externalSource_k')
    AND NOT EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = 'SyncExternalRef_tenantId_entityType_externalId_externalSour_key')
  THEN
    ALTER INDEX "SyncExternalRef_tenantId_entityType_externalId_externalSource_k"
      RENAME TO "SyncExternalRef_tenantId_entityType_externalId_externalSour_key";
  END IF;
END $$;
