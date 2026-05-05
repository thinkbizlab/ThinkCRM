-- Announcements: tenant-admin broadcast shown as a modal to every user until
-- acknowledged. AnnouncementAck is the read receipt log (one row per user
-- per announcement, capturing acknowledgedAt).

CREATE TABLE "Announcement" (
  "id"          TEXT PRIMARY KEY,
  "tenantId"    TEXT NOT NULL,
  "title"       TEXT NOT NULL,
  "body"        TEXT NOT NULL,
  "createdById" TEXT,
  "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"   TIMESTAMP(3) NOT NULL,
  CONSTRAINT "Announcement_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE,
  CONSTRAINT "Announcement_createdById_fkey"
    FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL
);

CREATE INDEX "Announcement_tenantId_createdAt_idx"
  ON "Announcement" ("tenantId", "createdAt");

CREATE TABLE "AnnouncementAck" (
  "id"             TEXT PRIMARY KEY,
  "tenantId"       TEXT NOT NULL,
  "announcementId" TEXT NOT NULL,
  "userId"         TEXT NOT NULL,
  "acknowledgedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AnnouncementAck_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE,
  CONSTRAINT "AnnouncementAck_announcementId_fkey"
    FOREIGN KEY ("announcementId") REFERENCES "Announcement"("id") ON DELETE CASCADE,
  CONSTRAINT "AnnouncementAck_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE
);

CREATE UNIQUE INDEX "AnnouncementAck_announcementId_userId_key"
  ON "AnnouncementAck" ("announcementId", "userId");

CREATE INDEX "AnnouncementAck_tenantId_userId_idx"
  ON "AnnouncementAck" ("tenantId", "userId");

CREATE INDEX "AnnouncementAck_tenantId_announcementId_idx"
  ON "AnnouncementAck" ("tenantId", "announcementId");
