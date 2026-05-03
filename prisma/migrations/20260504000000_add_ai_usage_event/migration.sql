-- CreateEnum
CREATE TYPE "AiFeature" AS ENUM ('DEDUP_INLINE', 'DEDUP_SCAN', 'VOICE_TRANSCRIBE', 'VOICE_SUMMARIZE', 'VISIT_RECOMMENDATIONS', 'ANALYSIS', 'LOST_DEALS');

-- CreateEnum
CREATE TYPE "AiProvider" AS ENUM ('ANTHROPIC', 'OPENAI', 'GEMINI');

-- CreateEnum
CREATE TYPE "AiCallStatus" AS ENUM ('SUCCESS', 'ERROR');

-- CreateTable
CREATE TABLE "AiUsageEvent" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "userId" TEXT,
    "feature" "AiFeature" NOT NULL,
    "provider" "AiProvider" NOT NULL,
    "model" TEXT NOT NULL,
    "inputTokens" INTEGER NOT NULL DEFAULT 0,
    "outputTokens" INTEGER NOT NULL DEFAULT 0,
    "durationMs" INTEGER,
    "costUsd" DECIMAL(12,6) NOT NULL,
    "status" "AiCallStatus" NOT NULL DEFAULT 'SUCCESS',
    "errorMessage" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AiUsageEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AiUsageEvent_tenantId_createdAt_idx" ON "AiUsageEvent"("tenantId", "createdAt");

-- CreateIndex
CREATE INDEX "AiUsageEvent_tenantId_feature_createdAt_idx" ON "AiUsageEvent"("tenantId", "feature", "createdAt");

-- CreateIndex
CREATE INDEX "AiUsageEvent_tenantId_userId_createdAt_idx" ON "AiUsageEvent"("tenantId", "userId", "createdAt");

-- AddForeignKey
ALTER TABLE "AiUsageEvent" ADD CONSTRAINT "AiUsageEvent_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AiUsageEvent" ADD CONSTRAINT "AiUsageEvent_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
