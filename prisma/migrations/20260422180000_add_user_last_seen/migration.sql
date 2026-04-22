-- AlterTable
ALTER TABLE "User" ADD COLUMN "lastSeenAt" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "User_tenantId_lastSeenAt_idx" ON "User"("tenantId", "lastSeenAt");
