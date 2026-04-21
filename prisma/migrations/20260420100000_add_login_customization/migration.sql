-- AlterTable
ALTER TABLE "TenantBranding"
  ADD COLUMN "loginTaglineHeadline" TEXT,
  ADD COLUMN "loginTaglineSubtext"  TEXT,
  ADD COLUMN "loginHeroImageUrl"    TEXT,
  ADD COLUMN "loginWelcomeMessage"  TEXT,
  ADD COLUMN "loginFooterText"      TEXT,
  ADD COLUMN "loginTermsUrl"        TEXT,
  ADD COLUMN "loginPrivacyUrl"      TEXT,
  ADD COLUMN "loginSupportEmail"    TEXT,
  ADD COLUMN "loginShowSignup"      BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN "loginShowGoogle"      BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN "loginShowMicrosoft"   BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN "loginShowPasskey"     BOOLEAN NOT NULL DEFAULT true;
