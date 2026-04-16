-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Visit" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "tenantId" TEXT NOT NULL,
    "repId" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "dealId" TEXT,
    "visitNo" TEXT NOT NULL DEFAULT '',
    "siteLat" REAL,
    "siteLng" REAL,
    "visitType" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PLANNED',
    "plannedAt" DATETIME NOT NULL,
    "objective" TEXT,
    "checkInAt" DATETIME,
    "checkInLat" REAL,
    "checkInLng" REAL,
    "checkInDistanceM" REAL,
    "checkInSelfie" TEXT,
    "checkOutAt" DATETIME,
    "checkOutLat" REAL,
    "checkOutLng" REAL,
    "result" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Visit_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "Visit_repId_fkey" FOREIGN KEY ("repId") REFERENCES "User" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "Visit_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "Visit_dealId_fkey" FOREIGN KEY ("dealId") REFERENCES "Deal" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_Visit" ("checkInAt", "checkInDistanceM", "checkInLat", "checkInLng", "checkInSelfie", "checkOutAt", "checkOutLat", "checkOutLng", "createdAt", "customerId", "dealId", "id", "objective", "plannedAt", "repId", "result", "siteLat", "siteLng", "status", "tenantId", "updatedAt", "visitType") SELECT "checkInAt", "checkInDistanceM", "checkInLat", "checkInLng", "checkInSelfie", "checkOutAt", "checkOutLat", "checkOutLng", "createdAt", "customerId", "dealId", "id", "objective", "plannedAt", "repId", "result", "siteLat", "siteLng", "status", "tenantId", "updatedAt", "visitType" FROM "Visit";
DROP TABLE "Visit";
ALTER TABLE "new_Visit" RENAME TO "Visit";
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
