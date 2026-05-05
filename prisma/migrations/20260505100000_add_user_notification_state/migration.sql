-- UserNotificationState: per-user marker for the bell-icon unread dot.
-- One row per user; updated when the user opens the bell. Items whose
-- underlying timestamp is newer than notifLastSeenAt count as unread.

CREATE TABLE IF NOT EXISTS "UserNotificationState" (
    "userId" TEXT NOT NULL,
    "notifLastSeenAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "UserNotificationState_pkey" PRIMARY KEY ("userId")
);

ALTER TABLE "UserNotificationState"
    ADD CONSTRAINT "UserNotificationState_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
