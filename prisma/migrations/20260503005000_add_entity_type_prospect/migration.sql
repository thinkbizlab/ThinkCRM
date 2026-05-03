-- Add PROSPECT to the EntityType enum.
-- Must be its own migration: Postgres rejects ALTER TYPE ... ADD VALUE
-- followed by use of the new value within the same transaction.

ALTER TYPE "EntityType" ADD VALUE IF NOT EXISTS 'PROSPECT';
