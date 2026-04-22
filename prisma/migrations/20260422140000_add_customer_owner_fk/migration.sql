-- Normalize orphan ownerIds to NULL so the FK can be added cleanly.
UPDATE "Customer" c
SET    "ownerId" = NULL
WHERE  c."ownerId" IS NOT NULL
AND    NOT EXISTS (SELECT 1 FROM "User" u WHERE u.id = c."ownerId");

-- Index ownerId for the common "list by owner" query path.
CREATE INDEX IF NOT EXISTS "Customer_ownerId_idx" ON "Customer"("ownerId");

-- Foreign key: matches `owner User? @relation("CustomerOwner", onDelete: SetNull)` in schema.prisma.
ALTER TABLE "Customer"
  ADD CONSTRAINT "Customer_ownerId_fkey"
  FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
