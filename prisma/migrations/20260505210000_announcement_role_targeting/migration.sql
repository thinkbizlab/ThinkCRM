-- Announcement role targeting: empty array = broadcast to every active user
-- (the only case before this column existed). Non-empty = only users whose
-- role is in the array see and acknowledge the announcement.
--
-- Empty-default keeps every existing row untouched in behaviour.

ALTER TABLE "Announcement"
  ADD COLUMN "roles" "UserRole"[] NOT NULL DEFAULT ARRAY[]::"UserRole"[];
