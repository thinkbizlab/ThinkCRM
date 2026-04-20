-- AlterTable
ALTER TABLE "TenantBranding"
  ADD COLUMN "accentGradientEnabled" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "accentGradientColor"   TEXT    NOT NULL DEFAULT '#ec4899',
  ADD COLUMN "accentGradientAngle"   INTEGER NOT NULL DEFAULT 135;
