/*
  Warnings:

  - You are about to alter the column `attachmentUrls` on the `DealProgressUpdate` table. The data in that column could be lost. The data in that column will be cast from `String` to `Json`.

*/
-- AlterTable
ALTER TABLE "TenantBranding" ADD COLUMN "appName" TEXT;

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_DealProgressUpdate" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "dealId" TEXT NOT NULL,
    "createdById" TEXT NOT NULL,
    "note" TEXT NOT NULL,
    "attachmentUrls" JSONB,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "DealProgressUpdate_dealId_fkey" FOREIGN KEY ("dealId") REFERENCES "Deal" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "DealProgressUpdate_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
INSERT INTO "new_DealProgressUpdate" ("attachmentUrls", "createdAt", "createdById", "dealId", "id", "note") SELECT "attachmentUrls", "createdAt", "createdById", "dealId", "id", "note" FROM "DealProgressUpdate";
DROP TABLE "DealProgressUpdate";
ALTER TABLE "new_DealProgressUpdate" RENAME TO "DealProgressUpdate";
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
