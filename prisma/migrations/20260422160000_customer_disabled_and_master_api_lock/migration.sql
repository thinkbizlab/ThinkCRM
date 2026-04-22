-- Customer.disabled: when true, the customer cannot be referenced by new
-- deals / visits / quotations. Existing references are preserved.
ALTER TABLE "Customer" ADD COLUMN "disabled" BOOLEAN NOT NULL DEFAULT false;

-- Per-entity "Manage via API only" locks. When true, web-session mutations on
-- the corresponding master-data routes are rejected; sync API keys are
-- unaffected. Each entity has its own flag so a tenant can, e.g., lock only
-- customers while still editing items in the UI.
ALTER TABLE "Tenant" ADD COLUMN "manageCustomersByApi"   BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Tenant" ADD COLUMN "manageItemsByApi"       BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Tenant" ADD COLUMN "managePaymentTermsByApi" BOOLEAN NOT NULL DEFAULT false;
