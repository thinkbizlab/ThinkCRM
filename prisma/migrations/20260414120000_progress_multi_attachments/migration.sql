-- Add attachmentUrls column (JSON array stored as TEXT)
ALTER TABLE "DealProgressUpdate" ADD COLUMN "attachmentUrls" TEXT;

-- Migrate existing single attachmentUrl values into a JSON array
UPDATE "DealProgressUpdate"
SET "attachmentUrls" = json_array("attachmentUrl")
WHERE "attachmentUrl" IS NOT NULL;

-- Drop the old single-attachment column
ALTER TABLE "DealProgressUpdate" DROP COLUMN "attachmentUrl";
