import {
  BillingCycle,
  BillingProvider,
  DealStatus,
  JobStatus,
  PricingModel,
  PrismaClient,
  SubscriptionStatus,
  UserRole,
  VisitStatus,
  VisitType
} from "@prisma/client";
import { hashPassword } from "../src/lib/password.js";

const prisma = new PrismaClient();

const ids = {
  tenant: "tenant_demo",
  admin: "user_admin_demo",
  manager: "user_manager_demo",
  rep: "user_rep_demo",
  team: "team_demo",
  paymentTerm: "term_net30_demo",
  customer: "customer_acme_demo",
  itemA: "item_widget_a_demo",
  itemB: "item_widget_b_demo",
  stageOpportunity: "stage_opportunity_demo",
  stageQuotation: "stage_quotation_demo",
  stageWon: "stage_won_demo",
  stageLost: "stage_lost_demo",
  deal: "deal_001_demo",
  visitPlanned: "visit_planned_demo",
  visitCheckedIn: "visit_checkedin_demo",
  source: "source_rest_demo"
};

async function resetData() {
  await prisma.voiceNoteTranscript.deleteMany();
  await prisma.voiceNoteJob.deleteMany();
  await prisma.aiAnalysisFinding.deleteMany();
  await prisma.aiAnalysisRun.deleteMany();
  await prisma.integrationExecutionLog.deleteMany();
  await prisma.tenantIntegrationCredential.deleteMany();
  await prisma.integrationSyncError.deleteMany();
  await prisma.integrationSyncJob.deleteMany();
  await prisma.integrationFieldMapping.deleteMany();
  await prisma.integrationSource.deleteMany();
  await prisma.quotationItem.deleteMany();
  await prisma.quotation.deleteMany();
  await prisma.dealProgressUpdate.deleteMany();
  await prisma.visit.deleteMany();
  await prisma.deal.deleteMany();
  await prisma.dealStage.deleteMany();
  await prisma.customerContact.deleteMany();
  await prisma.customerAddress.deleteMany();
  await prisma.customer.deleteMany();
  await prisma.item.deleteMany();
  await prisma.paymentTerm.deleteMany();
  await prisma.customFieldDefinition.deleteMany();
  await prisma.salesKpiTarget.deleteMany();
  await prisma.userExternalAccount.deleteMany();
  await prisma.teamNotificationChannel.deleteMany();
  await prisma.user.deleteMany();
  await prisma.team.deleteMany();
  await prisma.tenantTaxConfig.deleteMany();
  await prisma.quotationFormConfig.deleteMany();
  await prisma.tenantBranding.deleteMany();
  await prisma.tenantInvoice.deleteMany();
  await prisma.subscriptionProrationEvent.deleteMany();
  await prisma.tenantStorageQuota.deleteMany();
  await prisma.tenantStorageUsageDaily.deleteMany();
  await prisma.subscription.deleteMany();
  await prisma.tenant.deleteMany();
}

async function seedData() {
  const defaultPasswordHash = hashPassword("ThinkCRM123!");

  await prisma.tenant.create({
    data: {
      id: ids.tenant,
      name: "ThinkCRM Demo Tenant",
      slug: "thinkcrm-demo"
    }
  });

  await prisma.subscription.create({
    data: {
      tenantId: ids.tenant,
      provider: BillingProvider.STRIPE,
      pricingModel: PricingModel.FIXED_PER_USER,
      status: SubscriptionStatus.ACTIVE,
      seatPriceCents: 199900,
      seatCount: 3,
      currency: "THB",
      billingCycle: BillingCycle.MONTHLY,
      billingPeriodEnd: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000)
    }
  });

  await prisma.tenantStorageQuota.create({
    data: {
      tenantId: ids.tenant,
      includedBytes: BigInt(1_073_741_824),
      overagePricePerGb: 9900
    }
  });

  await prisma.tenantTaxConfig.create({
    data: {
      tenantId: ids.tenant,
      vatEnabled: true,
      vatRatePercent: 7
    }
  });

  await prisma.tenantBranding.create({
    data: {
      tenantId: ids.tenant,
      primaryColor: "#2563eb",
      secondaryColor: "#0f172a"
    }
  });

  await prisma.quotationFormConfig.create({
    data: {
      tenantId: ids.tenant,
      headerLayoutJson: [
        {
          fieldKey: "customerId",
          label: "Customer",
          isVisible: true,
          isRequired: true,
          displayOrder: 1
        },
        {
          fieldKey: "billingAddressId",
          label: "Billing Address",
          isVisible: true,
          isRequired: true,
          displayOrder: 2
        },
        {
          fieldKey: "shippingAddressId",
          label: "Shipping Address",
          isVisible: true,
          isRequired: true,
          displayOrder: 3
        },
        {
          fieldKey: "paymentTermId",
          label: "Payment Term",
          isVisible: true,
          isRequired: true,
          displayOrder: 4
        },
        {
          fieldKey: "validTo",
          label: "Valid To",
          isVisible: true,
          isRequired: true,
          displayOrder: 5
        }
      ],
      itemLayoutJson: [
        {
          fieldKey: "itemId",
          label: "Item",
          isVisible: true,
          isRequired: true,
          displayOrder: 1
        },
        {
          fieldKey: "unitPrice",
          label: "Unit Price",
          isVisible: true,
          isRequired: true,
          displayOrder: 2
        },
        {
          fieldKey: "discountPercent",
          label: "Discount %",
          isVisible: true,
          isRequired: false,
          displayOrder: 3
        },
        {
          fieldKey: "quantity",
          label: "Quantity",
          isVisible: true,
          isRequired: true,
          displayOrder: 4
        }
      ]
    }
  });

  await prisma.team.create({
    data: {
      id: ids.team,
      tenantId: ids.tenant,
      teamName: "Bangkok Sales"
    }
  });

  await prisma.user.createMany({
    data: [
      {
        id: ids.admin,
        tenantId: ids.tenant,
        email: "admin@thinkcrm.demo",
        passwordHash: defaultPasswordHash,
        fullName: "Admin Demo",
        role: UserRole.ADMIN,
        teamId: ids.team
      },
      {
        id: ids.manager,
        tenantId: ids.tenant,
        email: "manager@thinkcrm.demo",
        passwordHash: defaultPasswordHash,
        fullName: "Manager Demo",
        role: UserRole.MANAGER,
        teamId: ids.team
      },
      {
        id: ids.rep,
        tenantId: ids.tenant,
        email: "rep@thinkcrm.demo",
        passwordHash: defaultPasswordHash,
        fullName: "Rep Demo",
        role: UserRole.REP,
        managerUserId: ids.manager,
        teamId: ids.team
      }
    ]
  });

  await prisma.teamNotificationChannel.createMany({
    data: [
      {
        tenantId: ids.tenant,
        teamId: ids.team,
        channelType: "EMAIL",
        channelTarget: "bangkok-sales@thinkcrm.demo"
      },
      {
        tenantId: ids.tenant,
        teamId: ids.team,
        channelType: "SLACK",
        channelTarget: "#bangkok-sales"
      }
    ]
  });

  await prisma.paymentTerm.create({
    data: {
      id: ids.paymentTerm,
      tenantId: ids.tenant,
      code: "NET30",
      name: "Net 30",
      dueDays: 30,
      customFields: {
        collectionMethod: "bank-transfer"
      }
    }
  });

  await prisma.customFieldDefinition.createMany({
    data: [
      {
        tenantId: ids.tenant,
        entityType: "CUSTOMER",
        fieldKey: "customerTier",
        label: "Customer Tier",
        dataType: "SELECT",
        isRequired: true,
        displayOrder: 1,
        optionsJson: ["Gold", "Silver", "Bronze"]
      },
      {
        tenantId: ids.tenant,
        entityType: "ITEM",
        fieldKey: "warrantyMonths",
        label: "Warranty (Months)",
        dataType: "NUMBER",
        isRequired: false,
        displayOrder: 1
      },
      {
        tenantId: ids.tenant,
        entityType: "PAYMENT_TERM",
        fieldKey: "collectionMethod",
        label: "Collection Method",
        dataType: "SELECT",
        isRequired: true,
        displayOrder: 1,
        optionsJson: ["bank-transfer", "cash", "credit-card"]
      }
    ]
  });

  await prisma.customer.create({
    data: {
      id: ids.customer,
      tenantId: ids.tenant,
      ownerId: ids.rep,
      customerCode: "CUST-ACME",
      name: "Acme Manufacturing",
      defaultTermId: ids.paymentTerm,
      customFields: {
        customerTier: "Gold"
      },
      addresses: {
        create: {
          addressLine1: "123 Rama 9 Road",
          city: "Bangkok",
          country: "TH",
          postalCode: "10310",
          latitude: 13.7563,
          longitude: 100.5018,
          isDefaultBilling: true,
          isDefaultShipping: true
        }
      },
      contacts: {
        create: {
          name: "Somchai Prasert",
          position: "Procurement Manager"
        }
      }
    }
  });

  await prisma.item.createMany({
    data: [
      {
        id: ids.itemA,
        tenantId: ids.tenant,
        itemCode: "ITEM-A",
        name: "Widget A",
        unitPrice: 1200,
        customFields: {
          warrantyMonths: 12
        }
      },
      {
        id: ids.itemB,
        tenantId: ids.tenant,
        itemCode: "ITEM-B",
        name: "Widget B",
        unitPrice: 850,
        customFields: {
          warrantyMonths: 6
        }
      }
    ]
  });

  await prisma.dealStage.createMany({
    data: [
      {
        id: ids.stageOpportunity,
        tenantId: ids.tenant,
        stageName: "Opportunity",
        stageOrder: 1,
        isDefault: true
      },
      {
        id: ids.stageQuotation,
        tenantId: ids.tenant,
        stageName: "Quotation",
        stageOrder: 2
      },
      {
        id: ids.stageWon,
        tenantId: ids.tenant,
        stageName: "Won",
        stageOrder: 3,
        isClosedWon: true
      },
      {
        id: ids.stageLost,
        tenantId: ids.tenant,
        stageName: "Lost",
        stageOrder: 4,
        isClosedLost: true
      }
    ]
  });

  await prisma.deal.create({
    data: {
      id: ids.deal,
      tenantId: ids.tenant,
      ownerId: ids.rep,
      dealNo: "DL-2026-0001",
      dealName: "Factory Expansion Supply",
      customerId: ids.customer,
      stageId: ids.stageOpportunity,
      estimatedValue: 175000,
      followUpAt: new Date(Date.now() + 2 * 86400000),
      status: DealStatus.OPEN
    }
  });

  await prisma.dealProgressUpdate.create({
    data: {
      dealId: ids.deal,
      createdById: ids.rep,
      note: "Initial discovery meeting completed."
    }
  });

  await prisma.visit.createMany({
    data: [
      {
        id: ids.visitPlanned,
        tenantId: ids.tenant,
        repId: ids.rep,
        customerId: ids.customer,
        dealId: ids.deal,
        visitType: VisitType.PLANNED,
        status: VisitStatus.PLANNED,
        plannedAt: new Date(Date.now() + 86400000),
        objective: "Prepare quotation details"
      },
      {
        id: ids.visitCheckedIn,
        tenantId: ids.tenant,
        repId: ids.rep,
        customerId: ids.customer,
        visitType: VisitType.UNPLANNED,
        status: VisitStatus.CHECKED_IN,
        plannedAt: new Date(),
        checkInAt: new Date(),
        checkInLat: 13.7563,
        checkInLng: 100.5018,
        checkInSelfie: "r2://tenant_demo/selfies/checkin-demo.jpg",
        objective: "Urgent customer issue follow-up"
      }
    ]
  });

  await prisma.integrationSource.create({
    data: {
      id: ids.source,
      tenantId: ids.tenant,
      sourceName: "ERP REST Connector",
      sourceType: "REST",
      status: "ENABLED",
      configJson: {
        baseUrl: "https://legacy.example/api",
        authType: "api_key"
      },
      mappings: {
        create: [
          {
            entityType: "CUSTOMER",
            sourceField: "customer_code",
            targetField: "customerCode",
            isRequired: true
          },
          {
            entityType: "ITEM",
            sourceField: "item_code",
            targetField: "itemCode",
            isRequired: true
          }
        ]
      }
    }
  });

  await prisma.integrationExecutionLog.create({
    data: {
      tenantId: ids.tenant,
      executedById: ids.admin,
      platform: "GENERIC",
      operationType: "SEED_SETUP",
      direction: "INBOUND",
      triggerType: "MANUAL",
      status: "SUCCESS",
      responseSummary: "Demo seed log entry",
      payloadMasked: { note: "PII-safe payload snapshot" },
      completedAt: new Date()
    }
  });

  await prisma.tenantIntegrationCredential.createMany({
    data: [
      {
        tenantId: ids.tenant,
        platform: "MS365",
        clientIdRef: "ms365-client-id-demo",
        clientSecretRef: "ms365-client-secret-demo",
        status: "ENABLED",
        lastTestedAt: new Date(),
        lastTestResult: "Connection test passed.",
        lastTestStatus: "SUCCESS"
      },
      {
        tenantId: ids.tenant,
        platform: "SLACK",
        apiKeyRef: "xapp-demo-token",
        webhookTokenRef: "https://hooks.slack.demo/services/abc",
        status: "DISABLED",
        lastTestResult: "Not tested yet."
      }
    ]
  });

  await prisma.salesKpiTarget.create({
    data: {
      tenantId: ids.tenant,
      userId: ids.rep,
      targetMonth: "2026-04",
      visitTargetCount: 40,
      newDealValueTarget: 500000,
      revenueTarget: 350000
    }
  });

  const aiRun = await prisma.aiAnalysisRun.create({
    data: {
      tenantId: ids.tenant,
      requestedBy: ids.manager,
      status: JobStatus.SUCCESS,
      completedAt: new Date()
    }
  });

  await prisma.aiAnalysisFinding.create({
    data: {
      runId: aiRun.id,
      findingType: "pattern",
      title: "Afternoon-only appointments",
      description: "Rep tends to schedule appointments after noon.",
      confidenceScore: 0.81,
      evidenceJson: { windowDays: 30, afterNoonPercent: 88 }
    }
  });

  const voiceJob = await prisma.voiceNoteJob.create({
    data: {
      tenantId: ids.tenant,
      entityType: "VISIT",
      entityId: ids.visitPlanned,
      audioObjectKey: "r2://tenant_demo/voice/visit-note-001.m4a",
      status: JobStatus.SUCCESS,
      requestedById: ids.rep,
      completedAt: new Date()
    }
  });

  await prisma.voiceNoteTranscript.create({
    data: {
      jobId: voiceJob.id,
      transcriptText: "Customer requested revised proposal by Friday.",
      summaryText: "Need to send revised proposal and confirm delivery timeline.",
      confidenceScore: 0.86
    }
  });
}

async function main() {
  await resetData();
  await seedData();

  console.log("Seed completed.");
  console.log("Tenant ID:", ids.tenant);
  console.log("Admin ID:", ids.admin);
  console.log("Manager ID:", ids.manager);
  console.log("Rep ID:", ids.rep);
  console.log("Deal ID:", ids.deal);
  console.log("Visit Planned ID:", ids.visitPlanned);
  console.log("Visit Checked-In ID:", ids.visitCheckedIn);
  console.log("Login Tenant Slug:", "thinkcrm-demo");
  console.log("Login Password:", "ThinkCRM123!");
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
