-- Performance indexes for hot tenant-scoped query paths.
-- All composites start with tenantId to co-locate rows per tenant in the index.

-- Customer name search / autocomplete.
CREATE INDEX "Customer_tenantId_name_idx" ON "Customer"("tenantId", "name");

-- Item name search (quotation line autocomplete).
CREATE INDEX "Item_tenantId_name_idx" ON "Item"("tenantId", "name");

-- Deal list filtered by customer (customer-360 deals tab, reporting).
CREATE INDEX "Deal_tenantId_customerId_idx" ON "Deal"("tenantId", "customerId");

-- Quotation list filtered by deal (deal detail -> quotations list).
CREATE INDEX "Quotation_tenantId_dealId_idx" ON "Quotation"("tenantId", "dealId");

-- Visit list filtered by customer (customer-360 visits tab).
CREATE INDEX "Visit_tenantId_customerId_idx" ON "Visit"("tenantId", "customerId");
