-- Persist reverse-geocoded check-in address parts on Visit so list/notification
-- code can show "ถนน… แขวง/ตำบล… เขต/อำเภอ…" without re-OCRing the watermarked
-- selfie. Same parts are also burned into the photo before R2 upload.
ALTER TABLE "Visit"
  ADD COLUMN "checkInRoad"        TEXT,
  ADD COLUMN "checkInSubdistrict" TEXT,
  ADD COLUMN "checkInDistrict"    TEXT,
  ADD COLUMN "checkInProvince"    TEXT;
