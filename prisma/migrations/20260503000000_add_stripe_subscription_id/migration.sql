ALTER TABLE "Subscription" ADD COLUMN "stripeSubscriptionId" TEXT;
CREATE UNIQUE INDEX "Subscription_stripeSubscriptionId_key" ON "Subscription"("stripeSubscriptionId");
