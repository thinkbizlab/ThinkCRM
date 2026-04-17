-- H1: PostgreSQL baseline migration — replaces all prior SQLite migrations.
-- Generated from schema.prisma after switching provider from sqlite → postgresql.
-- Run against a fresh PostgreSQL database with: npx prisma migrate deploy

-- Enums
CREATE TYPE "UserRole" AS ENUM ('ADMIN', 'DIRECTOR', 'MANAGER', 'SUPERVISOR', 'REP');
CREATE TYPE "BillingProvider" AS ENUM ('STRIPE');
CREATE TYPE "PricingModel" AS ENUM ('FIXED_PER_USER');
CREATE TYPE "BillingCycle" AS ENUM ('MONTHLY', 'YEARLY');
CREATE TYPE "InvoiceStatus" AS ENUM ('DRAFT', 'FINALIZED');
CREATE TYPE "SubscriptionStatus" AS ENUM ('TRIALING', 'ACTIVE', 'PAST_DUE', 'CANCELED');
CREATE TYPE "ChannelType" AS ENUM ('MS_TEAMS', 'EMAIL', 'SLACK', 'LINE');
CREATE TYPE "DealStatus" AS ENUM ('OPEN', 'WON', 'LOST');
CREATE TYPE "QuotationStatus" AS ENUM ('DRAFT', 'SENT', 'APPROVED', 'REJECTED', 'EXPIRED', 'CANCELED');
CREATE TYPE "VisitType" AS ENUM ('PLANNED', 'UNPLANNED');
CREATE TYPE "VisitStatus" AS ENUM ('PLANNED', 'CHECKED_IN', 'CHECKED_OUT');
CREATE TYPE "SourceType" AS ENUM ('EXCEL', 'REST', 'WEBHOOK');
CREATE TYPE "SourceStatus" AS ENUM ('DISABLED', 'ENABLED');
CREATE TYPE "RunType" AS ENUM ('MANUAL', 'SCHEDULED', 'WEBHOOK');
CREATE TYPE "JobStatus" AS ENUM ('PENDING', 'RUNNING', 'SUCCESS', 'FAILED');
CREATE TYPE "EntityType" AS ENUM ('CUSTOMER', 'ITEM', 'PAYMENT_TERM', 'DEAL', 'VISIT', 'QUOTATION');
CREATE TYPE "IntegrationPlatform" AS ENUM ('MS365', 'GOOGLE', 'LINE', 'LINE_LOGIN', 'MS_TEAMS', 'EMAIL', 'SLACK', 'STRIPE', 'GENERIC', 'ANTHROPIC', 'GEMINI', 'OPENAI');
CREATE TYPE "Direction" AS ENUM ('INBOUND', 'OUTBOUND');
CREATE TYPE "TriggerType" AS ENUM ('MANUAL', 'SCHEDULED', 'EVENT');
CREATE TYPE "ExecutionStatus" AS ENUM ('SUCCESS', 'FAILURE');
CREATE TYPE "AccountStatus" AS ENUM ('CONNECTED', 'DISCONNECTED');
CREATE TYPE "ThemeMode" AS ENUM ('LIGHT', 'DARK');
CREATE TYPE "AiVisitRecommendationSourceType" AS ENUM ('DEAL_FOLLOWUP', 'CUSTOMER_GAP_6M', 'CUSTOMER_GAP_12M', 'CUSTOMER_NEVER_SOLD');
CREATE TYPE "AiVisitRecommendationStatus" AS ENUM ('RECOMMENDED', 'ACCEPTED', 'REJECTED');
CREATE TYPE "CustomFieldDataType" AS ENUM ('TEXT', 'NUMBER', 'BOOLEAN', 'DATE', 'SELECT');
CREATE TYPE "CustomerType" AS ENUM ('COMPANY', 'PERSONAL');
CREATE TYPE "CustomDomainStatus" AS ENUM ('PENDING', 'VERIFIED', 'FAILED');
CREATE TYPE "CronRunStatus" AS ENUM ('RUNNING', 'SUCCESS', 'FAILURE');
CREATE TYPE "CronTriggerType" AS ENUM ('SCHEDULED', 'MANUAL');

-- Tenant
CREATE TABLE "Tenant" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "timezone" TEXT NOT NULL DEFAULT 'Asia/Bangkok',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "Tenant_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "Tenant_slug_key" ON "Tenant"("slug");

-- User
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL DEFAULT '',
    "fullName" TEXT NOT NULL,
    "role" "UserRole" NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "mustResetPassword" BOOLEAN NOT NULL DEFAULT false,
    "managerUserId" TEXT,
    "teamId" TEXT,
    "notifPrefs" JSONB,
    "avatarUrl" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "User_tenantId_email_key" ON "User"("tenantId", "email");
CREATE INDEX "User_tenantId_isActive_role_idx" ON "User"("tenantId", "isActive", "role");

-- EntityChangelog
CREATE TABLE "EntityChangelog" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "entityType" "EntityType" NOT NULL,
    "entityId" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "beforeJson" JSONB,
    "afterJson" JSONB,
    "contextJson" JSONB,
    "changedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "EntityChangelog_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "EntityChangelog_tenantId_createdAt_idx" ON "EntityChangelog"("tenantId", "createdAt");
CREATE INDEX "EntityChangelog_tenantId_entityType_entityId_createdAt_idx" ON "EntityChangelog"("tenantId", "entityType", "entityId", "createdAt");

-- Subscription
CREATE TABLE "Subscription" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "provider" "BillingProvider" NOT NULL,
    "pricingModel" "PricingModel" NOT NULL DEFAULT 'FIXED_PER_USER',
    "status" "SubscriptionStatus" NOT NULL,
    "seatPriceCents" INTEGER NOT NULL,
    "seatCount" INTEGER NOT NULL DEFAULT 1,
    "currency" TEXT NOT NULL DEFAULT 'THB',
    "paymentMethodRef" TEXT,
    "billingCycle" "BillingCycle" NOT NULL DEFAULT 'MONTHLY',
    "billingPeriodStart" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "billingPeriodEnd" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "externalCustomerId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "Subscription_pkey" PRIMARY KEY ("id")
);

-- TenantStorageQuota
CREATE TABLE "TenantStorageQuota" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "includedBytes" BIGINT NOT NULL DEFAULT 1073741824,
    "overagePricePerGb" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "TenantStorageQuota_pkey" PRIMARY KEY ("id")
);

-- TenantStorageUsageDaily
CREATE TABLE "TenantStorageUsageDaily" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "usageDate" TEXT NOT NULL,
    "totalBytes" BIGINT NOT NULL,
    "overageBytes" BIGINT NOT NULL,
    "estimatedOverageAmount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "TenantStorageUsageDaily_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "TenantStorageUsageDaily_tenantId_usageDate_key" ON "TenantStorageUsageDaily"("tenantId", "usageDate");

-- SubscriptionProrationEvent
CREATE TABLE "SubscriptionProrationEvent" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "subscriptionId" TEXT NOT NULL,
    "oldSeatCount" INTEGER NOT NULL,
    "newSeatCount" INTEGER NOT NULL,
    "seatDelta" INTEGER NOT NULL,
    "daysRemaining" INTEGER NOT NULL,
    "totalPeriodDays" INTEGER NOT NULL,
    "proratedAmountCents" INTEGER NOT NULL,
    "effectiveAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "SubscriptionProrationEvent_pkey" PRIMARY KEY ("id")
);

-- TenantInvoice
CREATE TABLE "TenantInvoice" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "invoiceMonth" TEXT NOT NULL,
    "periodStart" TEXT NOT NULL,
    "periodEnd" TEXT NOT NULL,
    "currency" TEXT NOT NULL,
    "seatsBaseCents" INTEGER NOT NULL,
    "storageOverageCents" INTEGER NOT NULL,
    "prorationAdjustmentsCents" INTEGER NOT NULL,
    "totalDueCents" INTEGER NOT NULL,
    "status" "InvoiceStatus" NOT NULL DEFAULT 'DRAFT',
    "finalizedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "TenantInvoice_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "TenantInvoice_tenantId_invoiceMonth_key" ON "TenantInvoice"("tenantId", "invoiceMonth");

-- Team
CREATE TABLE "Team" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "teamName" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "directorId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "Team_pkey" PRIMARY KEY ("id")
);

-- TeamNotificationChannel
CREATE TABLE "TeamNotificationChannel" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "teamId" TEXT NOT NULL,
    "channelType" "ChannelType" NOT NULL,
    "channelTarget" TEXT NOT NULL,
    "isEnabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "TeamNotificationChannel_pkey" PRIMARY KEY ("id")
);

-- TenantIntegrationCredential
CREATE TABLE "TenantIntegrationCredential" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "platform" "IntegrationPlatform" NOT NULL,
    "clientIdRef" TEXT,
    "clientSecretRef" TEXT,
    "apiKeyRef" TEXT,
    "webhookTokenRef" TEXT,
    "status" "SourceStatus" NOT NULL DEFAULT 'DISABLED',
    "lastTestedAt" TIMESTAMP(3),
    "lastTestResult" TEXT,
    "lastTestStatus" "ExecutionStatus",
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "TenantIntegrationCredential_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "TenantIntegrationCredential_tenantId_platform_key" ON "TenantIntegrationCredential"("tenantId", "platform");

-- TenantBranding
CREATE TABLE "TenantBranding" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "appName" TEXT,
    "logoUrl" TEXT,
    "faviconUrl" TEXT,
    "primaryColor" TEXT NOT NULL DEFAULT '#2563eb',
    "secondaryColor" TEXT NOT NULL DEFAULT '#0f172a',
    "themeMode" "ThemeMode" NOT NULL DEFAULT 'LIGHT',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "TenantBranding_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "TenantBranding_tenantId_key" ON "TenantBranding"("tenantId");

-- TenantTaxConfig
CREATE TABLE "TenantTaxConfig" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "vatEnabled" BOOLEAN NOT NULL DEFAULT true,
    "vatRatePercent" DOUBLE PRECISION NOT NULL DEFAULT 7.0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "TenantTaxConfig_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "TenantTaxConfig_tenantId_key" ON "TenantTaxConfig"("tenantId");

-- TenantVisitConfig
CREATE TABLE "TenantVisitConfig" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "checkInMaxDistanceM" INTEGER NOT NULL DEFAULT 1000,
    "minVisitDurationMinutes" INTEGER NOT NULL DEFAULT 15,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "TenantVisitConfig_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "TenantVisitConfig_tenantId_key" ON "TenantVisitConfig"("tenantId");

-- PaymentTerm
CREATE TABLE "PaymentTerm" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "dueDays" INTEGER NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "customFields" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "PaymentTerm_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "PaymentTerm_tenantId_code_key" ON "PaymentTerm"("tenantId", "code");

-- Customer
CREATE TABLE "Customer" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "ownerId" TEXT,
    "customerCode" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "externalRef" TEXT,
    "customerType" "CustomerType" NOT NULL DEFAULT 'COMPANY',
    "taxId" TEXT,
    "defaultTermId" TEXT NOT NULL,
    "siteLat" DOUBLE PRECISION,
    "siteLng" DOUBLE PRECISION,
    "customFields" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "Customer_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "Customer_tenantId_customerCode_key" ON "Customer"("tenantId", "customerCode");
CREATE UNIQUE INDEX "Customer_tenantId_taxId_key" ON "Customer"("tenantId", "taxId");

-- CustomerAddress
CREATE TABLE "CustomerAddress" (
    "id" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "addressLine1" TEXT NOT NULL,
    "subDistrict" TEXT,
    "district" TEXT,
    "province" TEXT,
    "city" TEXT,
    "state" TEXT,
    "country" TEXT,
    "postalCode" TEXT,
    "latitude" DOUBLE PRECISION,
    "longitude" DOUBLE PRECISION,
    "isDefaultBilling" BOOLEAN NOT NULL DEFAULT false,
    "isDefaultShipping" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "CustomerAddress_pkey" PRIMARY KEY ("id")
);

-- CustomerContact
CREATE TABLE "CustomerContact" (
    "id" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "position" TEXT NOT NULL,
    "tel" TEXT,
    "email" TEXT,
    "lineId" TEXT,
    "whatsapp" TEXT,
    "customFields" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "CustomerContact_pkey" PRIMARY KEY ("id")
);

-- Item
CREATE TABLE "Item" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "itemCode" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "externalRef" TEXT,
    "unitPrice" DOUBLE PRECISION NOT NULL,
    "customFields" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "Item_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "Item_tenantId_itemCode_key" ON "Item"("tenantId", "itemCode");

-- CustomFieldDefinition
CREATE TABLE "CustomFieldDefinition" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "entityType" "EntityType" NOT NULL,
    "fieldKey" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "dataType" "CustomFieldDataType" NOT NULL,
    "isRequired" BOOLEAN NOT NULL DEFAULT false,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "displayOrder" INTEGER NOT NULL DEFAULT 0,
    "optionsJson" JSONB,
    "placeholder" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "CustomFieldDefinition_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "CustomFieldDefinition_tenantId_entityType_fieldKey_key" ON "CustomFieldDefinition"("tenantId", "entityType", "fieldKey");

-- DealStage
CREATE TABLE "DealStage" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "stageName" TEXT NOT NULL,
    "stageOrder" INTEGER NOT NULL,
    "isClosedWon" BOOLEAN NOT NULL DEFAULT false,
    "isClosedLost" BOOLEAN NOT NULL DEFAULT false,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "allowForwardMove" BOOLEAN NOT NULL DEFAULT true,
    "allowBackwardMove" BOOLEAN NOT NULL DEFAULT false,
    "allowStageSkip" BOOLEAN NOT NULL DEFAULT false,
    "allowedSourceStageIds" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "DealStage_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "DealStage_tenantId_stageOrder_key" ON "DealStage"("tenantId", "stageOrder");

-- Deal
CREATE TABLE "Deal" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "ownerId" TEXT NOT NULL,
    "dealNo" TEXT NOT NULL,
    "dealName" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "stageId" TEXT NOT NULL,
    "estimatedValue" DOUBLE PRECISION NOT NULL,
    "followUpAt" TIMESTAMP(3) NOT NULL,
    "closedAt" TIMESTAMP(3),
    "status" "DealStatus" NOT NULL DEFAULT 'OPEN',
    "lostNote" TEXT,
    "customFields" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "Deal_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "Deal_tenantId_ownerId_status_closedAt_idx" ON "Deal"("tenantId", "ownerId", "status", "closedAt");
CREATE INDEX "Deal_tenantId_stageId_idx" ON "Deal"("tenantId", "stageId");
CREATE INDEX "Deal_tenantId_followUpAt_idx" ON "Deal"("tenantId", "followUpAt");

-- DealProgressUpdate
CREATE TABLE "DealProgressUpdate" (
    "id" TEXT NOT NULL,
    "dealId" TEXT NOT NULL,
    "createdById" TEXT NOT NULL,
    "note" TEXT NOT NULL,
    "attachmentUrls" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "DealProgressUpdate_pkey" PRIMARY KEY ("id")
);

-- Quotation
CREATE TABLE "Quotation" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "dealId" TEXT NOT NULL,
    "quotationNo" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "paymentTermId" TEXT NOT NULL,
    "billingAddressId" TEXT,
    "shippingAddressId" TEXT,
    "validTo" TIMESTAMP(3) NOT NULL,
    "status" "QuotationStatus" NOT NULL DEFAULT 'DRAFT',
    "subtotal" DOUBLE PRECISION NOT NULL,
    "vatRate" DOUBLE PRECISION NOT NULL DEFAULT 7.0,
    "vatAmount" DOUBLE PRECISION NOT NULL,
    "grandTotal" DOUBLE PRECISION NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "Quotation_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "Quotation_tenantId_quotationNo_key" ON "Quotation"("tenantId", "quotationNo");

-- TenantRoleChain
CREATE TABLE "TenantRoleChain" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "roleCode" TEXT NOT NULL,
    "roleName" TEXT NOT NULL,
    "rankOrder" INTEGER NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "TenantRoleChain_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "TenantRoleChain_tenantId_roleCode_key" ON "TenantRoleChain"("tenantId", "roleCode");
CREATE INDEX "TenantRoleChain_tenantId_rankOrder_idx" ON "TenantRoleChain"("tenantId", "rankOrder");

-- StripeWebhookDelivery
CREATE TABLE "StripeWebhookDelivery" (
    "id" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "tenantId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "StripeWebhookDelivery_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "StripeWebhookDelivery_eventId_key" ON "StripeWebhookDelivery"("eventId");
CREATE INDEX "StripeWebhookDelivery_tenantId_idx" ON "StripeWebhookDelivery"("tenantId");
ALTER TABLE "StripeWebhookDelivery" ADD CONSTRAINT "StripeWebhookDelivery_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- QuotationItem
CREATE TABLE "QuotationItem" (
    "id" TEXT NOT NULL,
    "quotationId" TEXT NOT NULL,
    "itemId" TEXT NOT NULL,
    "itemCode" TEXT NOT NULL,
    "unitPrice" DOUBLE PRECISION NOT NULL,
    "discountPercent" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "netPricePerUnit" DOUBLE PRECISION NOT NULL,
    "quantity" INTEGER NOT NULL,
    "totalPrice" DOUBLE PRECISION NOT NULL,
    CONSTRAINT "QuotationItem_pkey" PRIMARY KEY ("id")
);

-- QuotationFormConfig
CREATE TABLE "QuotationFormConfig" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "headerLayoutJson" JSONB NOT NULL,
    "itemLayoutJson" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "QuotationFormConfig_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "QuotationFormConfig_tenantId_key" ON "QuotationFormConfig"("tenantId");

-- Visit
CREATE TABLE "Visit" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "repId" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "dealId" TEXT,
    "visitNo" TEXT NOT NULL DEFAULT '',
    "siteLat" DOUBLE PRECISION,
    "siteLng" DOUBLE PRECISION,
    "visitType" "VisitType" NOT NULL,
    "status" "VisitStatus" NOT NULL DEFAULT 'PLANNED',
    "plannedAt" TIMESTAMP(3) NOT NULL,
    "objective" TEXT,
    "checkInAt" TIMESTAMP(3),
    "checkInLat" DOUBLE PRECISION,
    "checkInLng" DOUBLE PRECISION,
    "checkInDistanceM" DOUBLE PRECISION,
    "checkInSelfie" TEXT,
    "checkOutAt" TIMESTAMP(3),
    "checkOutLat" DOUBLE PRECISION,
    "checkOutLng" DOUBLE PRECISION,
    "result" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "Visit_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "Visit_tenantId_repId_checkInAt_idx" ON "Visit"("tenantId", "repId", "checkInAt");
CREATE INDEX "Visit_tenantId_status_plannedAt_idx" ON "Visit"("tenantId", "status", "plannedAt");

-- SalesKpiTarget
CREATE TABLE "SalesKpiTarget" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "targetMonth" TEXT NOT NULL,
    "visitTargetCount" INTEGER NOT NULL,
    "newDealValueTarget" DOUBLE PRECISION NOT NULL,
    "revenueTarget" DOUBLE PRECISION NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "SalesKpiTarget_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "SalesKpiTarget_tenantId_userId_targetMonth_key" ON "SalesKpiTarget"("tenantId", "userId", "targetMonth");

-- IntegrationSource
CREATE TABLE "IntegrationSource" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "sourceName" TEXT NOT NULL,
    "sourceType" "SourceType" NOT NULL,
    "configJson" JSONB NOT NULL,
    "status" "SourceStatus" NOT NULL DEFAULT 'DISABLED',
    "lastSyncAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "IntegrationSource_pkey" PRIMARY KEY ("id")
);

-- IntegrationFieldMapping
CREATE TABLE "IntegrationFieldMapping" (
    "id" TEXT NOT NULL,
    "sourceId" TEXT NOT NULL,
    "entityType" "EntityType" NOT NULL,
    "sourceField" TEXT NOT NULL,
    "targetField" TEXT NOT NULL,
    "transformRule" TEXT,
    "isRequired" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "IntegrationFieldMapping_pkey" PRIMARY KEY ("id")
);

-- IntegrationSyncJob
CREATE TABLE "IntegrationSyncJob" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "sourceId" TEXT NOT NULL,
    "runType" "RunType" NOT NULL,
    "status" "JobStatus" NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),
    "summaryJson" JSONB,
    CONSTRAINT "IntegrationSyncJob_pkey" PRIMARY KEY ("id")
);

-- IntegrationSyncError
CREATE TABLE "IntegrationSyncError" (
    "id" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "entityType" "EntityType" NOT NULL,
    "rowRef" TEXT NOT NULL,
    "errorCode" TEXT NOT NULL,
    "errorMessage" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "IntegrationSyncError_pkey" PRIMARY KEY ("id")
);

-- IntegrationExecutionLog
CREATE TABLE "IntegrationExecutionLog" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "executedById" TEXT,
    "platform" "IntegrationPlatform" NOT NULL,
    "operationType" TEXT NOT NULL,
    "direction" "Direction" NOT NULL,
    "triggerType" "TriggerType" NOT NULL,
    "status" "ExecutionStatus" NOT NULL,
    "requestRef" TEXT,
    "responseSummary" TEXT,
    "errorCode" TEXT,
    "errorMessage" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),
    "payloadMasked" JSONB,
    CONSTRAINT "IntegrationExecutionLog_pkey" PRIMARY KEY ("id")
);

-- UserExternalAccount
CREATE TABLE "UserExternalAccount" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "provider" "IntegrationPlatform" NOT NULL,
    "externalUserId" TEXT NOT NULL,
    "metadata" JSONB,
    "status" "AccountStatus" NOT NULL DEFAULT 'CONNECTED',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "UserExternalAccount_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "UserExternalAccount_userId_provider_key" ON "UserExternalAccount"("userId", "provider");

-- AiAnalysisRun
CREATE TABLE "AiAnalysisRun" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "requestedBy" TEXT NOT NULL,
    "filtersJson" JSONB,
    "status" "JobStatus" NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),
    CONSTRAINT "AiAnalysisRun_pkey" PRIMARY KEY ("id")
);

-- AiVisitRecommendationRun
CREATE TABLE "AiVisitRecommendationRun" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "repId" TEXT NOT NULL,
    "dateFrom" TIMESTAMP(3) NOT NULL,
    "dateTo" TIMESTAMP(3) NOT NULL,
    "generatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AiVisitRecommendationRun_pkey" PRIMARY KEY ("id")
);

-- AiVisitRecommendation
CREATE TABLE "AiVisitRecommendation" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "sourceType" "AiVisitRecommendationSourceType" NOT NULL,
    "customerId" TEXT NOT NULL,
    "dealId" TEXT,
    "score" DOUBLE PRECISION NOT NULL,
    "reason" TEXT NOT NULL,
    "proposedDate" TIMESTAMP(3) NOT NULL,
    "status" "AiVisitRecommendationStatus" NOT NULL DEFAULT 'RECOMMENDED',
    "decisionAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AiVisitRecommendation_pkey" PRIMARY KEY ("id")
);

-- AiAnalysisFinding
CREATE TABLE "AiAnalysisFinding" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "findingType" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "confidenceScore" DOUBLE PRECISION NOT NULL,
    "evidenceJson" JSONB,
    CONSTRAINT "AiAnalysisFinding_pkey" PRIMARY KEY ("id")
);

-- VoiceNoteJob
CREATE TABLE "VoiceNoteJob" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "entityType" "EntityType" NOT NULL,
    "entityId" TEXT NOT NULL,
    "audioObjectKey" TEXT NOT NULL,
    "status" "JobStatus" NOT NULL,
    "requestedById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),
    CONSTRAINT "VoiceNoteJob_pkey" PRIMARY KEY ("id")
);

-- VoiceNoteTranscript
CREATE TABLE "VoiceNoteTranscript" (
    "id" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "transcriptText" TEXT NOT NULL,
    "summaryText" TEXT NOT NULL,
    "confidenceScore" DOUBLE PRECISION NOT NULL,
    "confirmedById" TEXT,
    "confirmedAt" TIMESTAMP(3),
    "rejectedAt" TIMESTAMP(3),
    CONSTRAINT "VoiceNoteTranscript_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "VoiceNoteTranscript_jobId_key" ON "VoiceNoteTranscript"("jobId");

-- TenantCustomDomain
CREATE TABLE "TenantCustomDomain" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "domain" TEXT NOT NULL,
    "verificationToken" TEXT NOT NULL,
    "status" "CustomDomainStatus" NOT NULL DEFAULT 'PENDING',
    "verifiedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "TenantCustomDomain_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "TenantCustomDomain_tenantId_key" ON "TenantCustomDomain"("tenantId");
CREATE UNIQUE INDEX "TenantCustomDomain_domain_key" ON "TenantCustomDomain"("domain");

-- CronJobConfig
CREATE TABLE "CronJobConfig" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "jobKey" TEXT NOT NULL,
    "cronExpr" TEXT NOT NULL,
    "timezone" TEXT NOT NULL DEFAULT 'Asia/Bangkok',
    "isEnabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "CronJobConfig_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "CronJobConfig_tenantId_jobKey_key" ON "CronJobConfig"("tenantId", "jobKey");

-- CronJobRun
CREATE TABLE "CronJobRun" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "jobKey" TEXT NOT NULL,
    "status" "CronRunStatus" NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),
    "summary" TEXT,
    "triggeredBy" "CronTriggerType" NOT NULL DEFAULT 'SCHEDULED',
    CONSTRAINT "CronJobRun_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "CronJobRun_tenantId_jobKey_startedAt_idx" ON "CronJobRun"("tenantId", "jobKey", "startedAt");

-- OAuthState
CREATE TABLE "OAuthState" (
    "state" TEXT NOT NULL,
    "tenantSlug" TEXT NOT NULL,
    "userId" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "OAuthState_pkey" PRIMARY KEY ("state")
);
CREATE INDEX "OAuthState_expiresAt_idx" ON "OAuthState"("expiresAt");

-- OAuthExchangeCode
CREATE TABLE "OAuthExchangeCode" (
    "code" TEXT NOT NULL,
    "jwt" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "OAuthExchangeCode_pkey" PRIMARY KEY ("code")
);
CREATE INDEX "OAuthExchangeCode_expiresAt_idx" ON "OAuthExchangeCode"("expiresAt");

-- PasswordResetToken (H10)
CREATE TABLE "PasswordResetToken" (
    "token" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "PasswordResetToken_pkey" PRIMARY KEY ("token")
);
CREATE INDEX "PasswordResetToken_expiresAt_idx" ON "PasswordResetToken"("expiresAt");

-- Foreign keys
ALTER TABLE "User" ADD CONSTRAINT "User_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "User" ADD CONSTRAINT "User_managerUserId_fkey" FOREIGN KEY ("managerUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "User" ADD CONSTRAINT "User_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "Team"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "EntityChangelog" ADD CONSTRAINT "EntityChangelog_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "EntityChangelog" ADD CONSTRAINT "EntityChangelog_changedById_fkey" FOREIGN KEY ("changedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Subscription" ADD CONSTRAINT "Subscription_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "TenantStorageQuota" ADD CONSTRAINT "TenantStorageQuota_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "TenantStorageUsageDaily" ADD CONSTRAINT "TenantStorageUsageDaily_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "SubscriptionProrationEvent" ADD CONSTRAINT "SubscriptionProrationEvent_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "SubscriptionProrationEvent" ADD CONSTRAINT "SubscriptionProrationEvent_subscriptionId_fkey" FOREIGN KEY ("subscriptionId") REFERENCES "Subscription"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "TenantInvoice" ADD CONSTRAINT "TenantInvoice_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Team" ADD CONSTRAINT "Team_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Team" ADD CONSTRAINT "Team_directorId_fkey" FOREIGN KEY ("directorId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "TeamNotificationChannel" ADD CONSTRAINT "TeamNotificationChannel_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "TeamNotificationChannel" ADD CONSTRAINT "TeamNotificationChannel_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "Team"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "TenantIntegrationCredential" ADD CONSTRAINT "TenantIntegrationCredential_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "TenantBranding" ADD CONSTRAINT "TenantBranding_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "TenantTaxConfig" ADD CONSTRAINT "TenantTaxConfig_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "TenantVisitConfig" ADD CONSTRAINT "TenantVisitConfig_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "PaymentTerm" ADD CONSTRAINT "PaymentTerm_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Customer" ADD CONSTRAINT "Customer_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Customer" ADD CONSTRAINT "Customer_defaultTermId_fkey" FOREIGN KEY ("defaultTermId") REFERENCES "PaymentTerm"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "CustomerAddress" ADD CONSTRAINT "CustomerAddress_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CustomerContact" ADD CONSTRAINT "CustomerContact_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Item" ADD CONSTRAINT "Item_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CustomFieldDefinition" ADD CONSTRAINT "CustomFieldDefinition_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Deal" ADD CONSTRAINT "Deal_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Deal" ADD CONSTRAINT "Deal_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Deal" ADD CONSTRAINT "Deal_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Deal" ADD CONSTRAINT "Deal_stageId_fkey" FOREIGN KEY ("stageId") REFERENCES "DealStage"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "DealProgressUpdate" ADD CONSTRAINT "DealProgressUpdate_dealId_fkey" FOREIGN KEY ("dealId") REFERENCES "Deal"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "DealProgressUpdate" ADD CONSTRAINT "DealProgressUpdate_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Quotation" ADD CONSTRAINT "Quotation_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Quotation" ADD CONSTRAINT "Quotation_dealId_fkey" FOREIGN KEY ("dealId") REFERENCES "Deal"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Quotation" ADD CONSTRAINT "Quotation_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Quotation" ADD CONSTRAINT "Quotation_paymentTermId_fkey" FOREIGN KEY ("paymentTermId") REFERENCES "PaymentTerm"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Quotation" ADD CONSTRAINT "Quotation_billingAddressId_fkey" FOREIGN KEY ("billingAddressId") REFERENCES "CustomerAddress"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Quotation" ADD CONSTRAINT "Quotation_shippingAddressId_fkey" FOREIGN KEY ("shippingAddressId") REFERENCES "CustomerAddress"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "TenantRoleChain" ADD CONSTRAINT "TenantRoleChain_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "QuotationItem" ADD CONSTRAINT "QuotationItem_quotationId_fkey" FOREIGN KEY ("quotationId") REFERENCES "Quotation"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "QuotationItem" ADD CONSTRAINT "QuotationItem_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "Item"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "QuotationFormConfig" ADD CONSTRAINT "QuotationFormConfig_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Visit" ADD CONSTRAINT "Visit_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Visit" ADD CONSTRAINT "Visit_repId_fkey" FOREIGN KEY ("repId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Visit" ADD CONSTRAINT "Visit_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Visit" ADD CONSTRAINT "Visit_dealId_fkey" FOREIGN KEY ("dealId") REFERENCES "Deal"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "SalesKpiTarget" ADD CONSTRAINT "SalesKpiTarget_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "IntegrationSource" ADD CONSTRAINT "IntegrationSource_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "IntegrationFieldMapping" ADD CONSTRAINT "IntegrationFieldMapping_sourceId_fkey" FOREIGN KEY ("sourceId") REFERENCES "IntegrationSource"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "IntegrationSyncJob" ADD CONSTRAINT "IntegrationSyncJob_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "IntegrationSyncJob" ADD CONSTRAINT "IntegrationSyncJob_sourceId_fkey" FOREIGN KEY ("sourceId") REFERENCES "IntegrationSource"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "IntegrationSyncError" ADD CONSTRAINT "IntegrationSyncError_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "IntegrationSyncJob"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "IntegrationExecutionLog" ADD CONSTRAINT "IntegrationExecutionLog_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "IntegrationExecutionLog" ADD CONSTRAINT "IntegrationExecutionLog_executedById_fkey" FOREIGN KEY ("executedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "UserExternalAccount" ADD CONSTRAINT "UserExternalAccount_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AiAnalysisRun" ADD CONSTRAINT "AiAnalysisRun_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AiVisitRecommendationRun" ADD CONSTRAINT "AiVisitRecommendationRun_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AiVisitRecommendationRun" ADD CONSTRAINT "AiVisitRecommendationRun_repId_fkey" FOREIGN KEY ("repId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AiVisitRecommendation" ADD CONSTRAINT "AiVisitRecommendation_runId_fkey" FOREIGN KEY ("runId") REFERENCES "AiVisitRecommendationRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AiAnalysisFinding" ADD CONSTRAINT "AiAnalysisFinding_runId_fkey" FOREIGN KEY ("runId") REFERENCES "AiAnalysisRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "VoiceNoteJob" ADD CONSTRAINT "VoiceNoteJob_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "VoiceNoteJob" ADD CONSTRAINT "VoiceNoteJob_requestedById_fkey" FOREIGN KEY ("requestedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "VoiceNoteTranscript" ADD CONSTRAINT "VoiceNoteTranscript_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "VoiceNoteJob"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "VoiceNoteTranscript" ADD CONSTRAINT "VoiceNoteTranscript_confirmedById_fkey" FOREIGN KEY ("confirmedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "TenantCustomDomain" ADD CONSTRAINT "TenantCustomDomain_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CronJobConfig" ADD CONSTRAINT "CronJobConfig_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CronJobRun" ADD CONSTRAINT "CronJobRun_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CronJobRun" ADD CONSTRAINT "CronJobRun_tenantId_jobKey_fkey" FOREIGN KEY ("tenantId", "jobKey") REFERENCES "CronJobConfig"("tenantId", "jobKey") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "PasswordResetToken" ADD CONSTRAINT "PasswordResetToken_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "PasswordResetToken" ADD CONSTRAINT "PasswordResetToken_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AuditLog (S9)
CREATE TABLE "AuditLog" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "userId" TEXT,
    "action" TEXT NOT NULL,
    "detail" JSONB,
    "ipAddress" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "AuditLog_tenantId_createdAt_idx" ON "AuditLog"("tenantId", "createdAt");
CREATE INDEX "AuditLog_tenantId_action_idx" ON "AuditLog"("tenantId", "action");
ALTER TABLE "AuditLog" ADD CONSTRAINT "AuditLog_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- S10: Trial flow + S7: Plan limits
ALTER TABLE "Subscription" ADD COLUMN "trialEndsAt" TIMESTAMP(3);
ALTER TABLE "Subscription" ADD COLUMN "planFeatures" JSONB;

-- S6: Stripe billing
ALTER TABLE "Tenant" ADD COLUMN "stripeCustomerId" TEXT;
