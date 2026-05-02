-- Federated Customer Master: Tenant.customerFederationSourceId points at the
-- IntegrationSource (sourceType=MYSQL) that backs live Customer reads.
-- When non-null, our app must NOT write Customer attributes (DRAFT excepted).
-- See src/modules/federation/customer-federation.ts.

ALTER TABLE "Tenant" ADD COLUMN "customerFederationSourceId" TEXT;

ALTER TABLE "Tenant" ADD CONSTRAINT "Tenant_customerFederationSourceId_fkey"
  FOREIGN KEY ("customerFederationSourceId") REFERENCES "IntegrationSource"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "Tenant_customerFederationSourceId_idx" ON "Tenant"("customerFederationSourceId");
