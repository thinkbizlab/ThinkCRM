import { BillingCycle, BillingProvider, PricingModel, PrismaClient, SubscriptionStatus } from "@prisma/client";
import { ids, daysFromNow } from "./shared.js";

export async function seedTenant(prisma: PrismaClient) {
  await prisma.tenant.create({
    data: { id: ids.tenant, name: "ThinkCRM Demo Tenant", slug: "thinkcrm-demo" }
  });

  await prisma.subscription.create({
    data: {
      tenantId: ids.tenant,
      provider: BillingProvider.STRIPE,
      pricingModel: PricingModel.FIXED_PER_USER,
      status: SubscriptionStatus.ACTIVE,
      seatPriceCents: 199900,
      seatCount: 6,
      currency: "THB",
      billingCycle: BillingCycle.MONTHLY,
      billingPeriodStart: new Date(),
      billingPeriodEnd: daysFromNow(30)
    }
  });

  await prisma.tenantStorageQuota.create({
    data: { tenantId: ids.tenant, includedBytes: BigInt(5_368_709_120), overagePricePerGb: 9900 }
  });

  await prisma.tenantTaxConfig.create({
    data: { tenantId: ids.tenant, vatEnabled: true, vatRatePercent: 7 }
  });

  await prisma.tenantBranding.upsert({
    where: { tenantId: ids.tenant },
    create: { tenantId: ids.tenant, primaryColor: "#2563eb", secondaryColor: "#0f172a" },
    update: {} // preserve existing branding — colours, logo, app name set via Settings
  });

  await prisma.quotationFormConfig.create({
    data: {
      tenantId: ids.tenant,
      headerLayoutJson: [
        { fieldKey: "customerId",        label: "ลูกค้า",             isVisible: true, isRequired: true,  displayOrder: 1 },
        { fieldKey: "billingAddressId",  label: "ที่อยู่วางบิล",      isVisible: true, isRequired: true,  displayOrder: 2 },
        { fieldKey: "shippingAddressId", label: "ที่อยู่จัดส่ง",      isVisible: true, isRequired: true,  displayOrder: 3 },
        { fieldKey: "paymentTermId",     label: "เงื่อนไขการชำระเงิน", isVisible: true, isRequired: true,  displayOrder: 4 },
        { fieldKey: "validTo",           label: "ใบเสนอราคาถึงวันที่", isVisible: true, isRequired: true,  displayOrder: 5 }
      ],
      itemLayoutJson: [
        { fieldKey: "itemId",          label: "สินค้า",      isVisible: true, isRequired: true,  displayOrder: 1 },
        { fieldKey: "unitPrice",       label: "ราคาต่อหน่วย", isVisible: true, isRequired: true,  displayOrder: 2 },
        { fieldKey: "discountPercent", label: "ส่วนลด %",    isVisible: true, isRequired: false, displayOrder: 3 },
        { fieldKey: "quantity",        label: "จำนวน",       isVisible: true, isRequired: true,  displayOrder: 4 }
      ]
    }
  });
}
