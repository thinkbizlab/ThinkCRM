-- Layout choice for the uploaded login hero image.
--   BACKGROUND  — fills the left hero panel (existing behaviour)
--   INLINE_LOGO — renders as a small logo above the workspace text
--
-- Default keeps every existing tenant on BACKGROUND so the migration is a
-- no-op visually.

ALTER TABLE "TenantBranding"
  ADD COLUMN "loginHeroLayout" TEXT NOT NULL DEFAULT 'BACKGROUND';
