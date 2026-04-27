-- DropForeignKey
ALTER TABLE "CustomerGroup" DROP CONSTRAINT "CustomerGroup_tenantId_fkey";

-- DropForeignKey
ALTER TABLE "PasswordResetToken" DROP CONSTRAINT "PasswordResetToken_tenantId_fkey";

-- DropForeignKey
ALTER TABLE "PasswordResetToken" DROP CONSTRAINT "PasswordResetToken_userId_fkey";

-- DropIndex
DROP INDEX "Customer_ownerId_idx";

-- AlterTable
ALTER TABLE "UserDelegation" ALTER COLUMN "endsAt" SET DEFAULT '9999-12-31 23:59:59'::timestamp;

-- CreateTable
CREATE TABLE "UserPasskey" (
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
CREATE TABLE "WebAuthnChallenge" (
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
CREATE UNIQUE INDEX "UserPasskey_credentialId_key" ON "UserPasskey"("credentialId");

-- CreateIndex
CREATE INDEX "UserPasskey_userId_idx" ON "UserPasskey"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "WebAuthnChallenge_challenge_key" ON "WebAuthnChallenge"("challenge");

-- CreateIndex
CREATE INDEX "WebAuthnChallenge_expiresAt_idx" ON "WebAuthnChallenge"("expiresAt");

-- CreateIndex
CREATE INDEX "Customer_tenantId_ownerId_idx" ON "Customer"("tenantId", "ownerId");

-- CreateIndex
CREATE INDEX "Customer_tenantId_customerCode_idx" ON "Customer"("tenantId", "customerCode");

-- CreateIndex
CREATE INDEX "IntegrationSyncError_jobId_idx" ON "IntegrationSyncError"("jobId");

-- CreateIndex
CREATE INDEX "IntegrationSyncJob_tenantId_status_idx" ON "IntegrationSyncJob"("tenantId", "status");

-- CreateIndex
CREATE INDEX "IntegrationSyncJob_sourceId_status_idx" ON "IntegrationSyncJob"("sourceId", "status");

-- AddForeignKey
ALTER TABLE "CustomerGroup" ADD CONSTRAINT "CustomerGroup_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserPasskey" ADD CONSTRAINT "UserPasskey_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- RenameIndex
ALTER INDEX "CustomerDuplicateCandidate_tenantId_customerAId_customerBId_sig" RENAME TO "CustomerDuplicateCandidate_tenantId_customerAId_customerBId_key";

-- RenameIndex
ALTER INDEX "SyncExternalRef_tenantId_entityType_externalId_externalSource_k" RENAME TO "SyncExternalRef_tenantId_entityType_externalId_externalSour_key";
