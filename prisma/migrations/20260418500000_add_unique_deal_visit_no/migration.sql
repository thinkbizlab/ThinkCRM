-- Prevent duplicate deal/visit numbers within a tenant (race condition fix)
CREATE UNIQUE INDEX "Deal_tenantId_dealNo_key" ON "Deal"("tenantId", "dealNo");
CREATE UNIQUE INDEX "Visit_tenantId_visitNo_key" ON "Visit"("tenantId", "visitNo");
