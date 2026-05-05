-- Customer search trigram indexes
--
-- Goal: make `name ILIKE '%q%'` and `customerCode ILIKE '%q%'` index-backed
-- in /customers/search instead of seq-scanning the table. With 70k+ rows on
-- larger tenants the seq scan was the dominant cost; the existing btree
-- indexes only help prefix matches.
--
-- Two extensions are required:
--   * pg_trgm   — trigram operator class (gin_trgm_ops) so GIN can index
--                 substrings of text.
--   * btree_gin — lets GIN indexes include scalar columns (tenantId) alongside
--                 the trigram column, so the planner can satisfy the
--                 (tenantId = $1 AND name ILIKE '%q%') predicate from one
--                 index instead of intersecting two.
--
-- Both ship with Postgres core and are available on Neon.
--
-- Lock behaviour: CREATE INDEX (non-CONCURRENTLY) takes a ShareLock on the
-- table — reads keep working, writes block until the index is built. We
-- accept that briefly because (a) the federated tenant blocks Customer
-- writes from the app anyway and (b) shipping inside a normal Prisma
-- migration keeps dev/preview/prod parity. CONCURRENTLY would force a
-- separate manual deploy path.

CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS btree_gin;

CREATE INDEX IF NOT EXISTS "Customer_tenant_name_trgm_idx"
  ON "Customer" USING gin ("tenantId", "name" gin_trgm_ops);

CREATE INDEX IF NOT EXISTS "Customer_tenant_customerCode_trgm_idx"
  ON "Customer" USING gin ("tenantId", "customerCode" gin_trgm_ops);
