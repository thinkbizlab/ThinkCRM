-- AlterTable: add email verification fields to User
ALTER TABLE "User" ADD COLUMN "emailVerified" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "User" ADD COLUMN "emailVerifyToken" TEXT;
ALTER TABLE "User" ADD COLUMN "emailVerifyExpiresAt" TIMESTAMP(3);

-- CreateIndex: unique constraint on verification token
CREATE UNIQUE INDEX "User_emailVerifyToken_key" ON "User"("emailVerifyToken");

-- Backfill: mark all existing users as verified (they signed up before this feature)
UPDATE "User" SET "emailVerified" = true;
