-- AlterTable
ALTER TABLE "TenantBranding"
  ADD COLUMN "themeTokens" JSONB NOT NULL DEFAULT '{}';
