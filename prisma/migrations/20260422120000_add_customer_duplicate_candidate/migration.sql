-- CreateEnum
CREATE TYPE "CustomerDuplicateSignal" AS ENUM ('TAX_ID', 'PHONE', 'EMAIL', 'NAME_EXACT', 'NAME_FUZZY', 'AI');

-- CreateEnum
CREATE TYPE "CustomerDuplicateStatus" AS ENUM ('OPEN', 'DISMISSED', 'MERGED');

-- CreateTable
CREATE TABLE "CustomerDuplicateCandidate" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "customerAId" TEXT NOT NULL,
    "customerBId" TEXT NOT NULL,
    "signal" "CustomerDuplicateSignal" NOT NULL,
    "confidence" DOUBLE PRECISION NOT NULL DEFAULT 1.0,
    "reasonText" TEXT,
    "status" "CustomerDuplicateStatus" NOT NULL DEFAULT 'OPEN',
    "decidedById" TEXT,
    "decidedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CustomerDuplicateCandidate_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "CustomerDuplicateCandidate_tenantId_customerAId_customerBId_signal_key" ON "CustomerDuplicateCandidate"("tenantId", "customerAId", "customerBId", "signal");

-- CreateIndex
CREATE INDEX "CustomerDuplicateCandidate_tenantId_status_createdAt_idx" ON "CustomerDuplicateCandidate"("tenantId", "status", "createdAt");

-- AddForeignKey
ALTER TABLE "CustomerDuplicateCandidate" ADD CONSTRAINT "CustomerDuplicateCandidate_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
