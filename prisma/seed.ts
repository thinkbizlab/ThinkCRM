import {
  BillingCycle,
  BillingProvider,
  CustomerType,
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
  // Users
  admin:       "user_admin_demo",
  manager:     "user_manager_demo",
  supervisor:  "user_supervisor_demo",
  rep:         "user_rep_demo",
  rep2:        "user_rep2_demo",
  rep3:        "user_rep3_demo",
  // Team
  team: "team_demo",
  // Payment Terms
  termCOD:   "term_cod_demo",
  termNET15: "term_net15_demo",
  termNET30: "term_net30_demo",
  termNET60: "term_net60_demo",
  // Customers
  custAcme:     "cust_acme_demo",
  custSiamTech: "cust_siamtech_demo",
  custBKKFood:  "cust_bkkfood_demo",
  custThaiSteel:"cust_thaisteel_demo",
  custPremier:  "cust_premier_demo",
  custEastAsia: "cust_eastasia_demo",
  custGolden:   "cust_golden_demo",
  custRajaPlas: "cust_rajaplas_demo",
  custCentral:  "cust_central_demo",
  custNorth:    "cust_north_demo",
  custSunrise:  "cust_sunrise_demo",
  custMega:     "cust_mega_demo",
  custViva:     "cust_viva_demo",
  custAmarin:   "cust_amarin_demo",
  custOmega:    "cust_omega_demo",
  // Items
  itemA:  "item_a_demo",
  itemB:  "item_b_demo",
  itemC:  "item_c_demo",
  itemD:  "item_d_demo",
  itemE:  "item_e_demo",
  itemF:  "item_f_demo",
  itemG:  "item_g_demo",
  // Deal Stages
  stageOpportunity: "stage_opp_demo",
  stageQuotation:   "stage_quot_demo",
  stageNegotiation: "stage_neg_demo",
  stageWon:         "stage_won_demo",
  stageLost:        "stage_lost_demo",
  // Deals (25 deals)
  deal01: "deal_001_demo", deal02: "deal_002_demo", deal03: "deal_003_demo",
  deal04: "deal_004_demo", deal05: "deal_005_demo", deal06: "deal_006_demo",
  deal07: "deal_007_demo", deal08: "deal_008_demo", deal09: "deal_009_demo",
  deal10: "deal_010_demo", deal11: "deal_011_demo", deal12: "deal_012_demo",
  deal13: "deal_013_demo", deal14: "deal_014_demo", deal15: "deal_015_demo",
  deal16: "deal_016_demo", deal17: "deal_017_demo", deal18: "deal_018_demo",
  deal19: "deal_019_demo", deal20: "deal_020_demo", deal21: "deal_021_demo",
  deal22: "deal_022_demo", deal23: "deal_023_demo", deal24: "deal_024_demo",
  deal25: "deal_025_demo",
  // Test deals (DL-2026-0026 to DL-2026-0035) — copied from DL-2026-0003 for notification testing
  deal26: "deal_026_demo", deal27: "deal_027_demo", deal28: "deal_028_demo",
  deal29: "deal_029_demo", deal30: "deal_030_demo", deal31: "deal_031_demo",
  deal32: "deal_032_demo", deal33: "deal_033_demo", deal34: "deal_034_demo",
  deal35: "deal_035_demo",
  // Visits
  visit01: "visit_01_demo", visit02: "visit_02_demo", visit03: "visit_03_demo",
  visit04: "visit_04_demo", visit05: "visit_05_demo", visit06: "visit_06_demo",
  visit07: "visit_07_demo", visit08: "visit_08_demo",
  // Somchai extra visits
  visit09: "visit_09_demo", visit10: "visit_10_demo", visit11: "visit_11_demo",
  visit12: "visit_12_demo", visit13: "visit_13_demo", visit14: "visit_14_demo",
  visit15: "visit_15_demo", visit16: "visit_16_demo",
  // Somchai additional 10 visits
  visit17: "visit_17_demo", visit18: "visit_18_demo", visit19: "visit_19_demo",
  visit20: "visit_20_demo", visit21: "visit_21_demo", visit22: "visit_22_demo",
  visit23: "visit_23_demo", visit24: "visit_24_demo", visit25: "visit_25_demo",
  visit26: "visit_26_demo",
  // Integration
  source: "source_rest_demo"
};

function daysFromNow(n: number) {
  return new Date(Date.now() + n * 86_400_000);
}

async function resetData() {
  await prisma.voiceNoteTranscript.deleteMany();
  await prisma.voiceNoteJob.deleteMany();
  await prisma.aiAnalysisFinding.deleteMany();
  await prisma.aiAnalysisRun.deleteMany();
  await prisma.integrationExecutionLog.deleteMany();
  // tenantIntegrationCredential is intentionally NOT deleted — real API keys
  // (LINE token, Anthropic key, etc.) configured via Settings are preserved across re-seeds.
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
  // teamNotificationChannel is intentionally NOT deleted — LINE group IDs
  // configured via Settings → Team Structure are preserved across re-seeds.
  await prisma.user.deleteMany();
  await prisma.team.deleteMany();
  await prisma.tenantTaxConfig.deleteMany();
  await prisma.quotationFormConfig.deleteMany();
  // tenantBranding is intentionally NOT deleted — logo, theme colours, app name
  // configured via Settings → Branding are preserved across re-seeds.
  await prisma.tenantInvoice.deleteMany();
  await prisma.subscriptionProrationEvent.deleteMany();
  await prisma.tenantStorageQuota.deleteMany();
  await prisma.tenantStorageUsageDaily.deleteMany();
  await prisma.subscription.deleteMany();
  await prisma.tenant.deleteMany();
}

async function seedData() {
  const pw = hashPassword("ThinkCRM123!");

  // ── Tenant ─────────────────────────────────────────────────────────────
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

  // ── Team ───────────────────────────────────────────────────────────────
  await prisma.team.create({
    data: { id: ids.team, tenantId: ids.tenant, teamName: "ทีมขายกรุงเทพ" }
  });

  // ── Users ──────────────────────────────────────────────────────────────
  await prisma.user.createMany({
    data: [
      { id: ids.admin,      tenantId: ids.tenant, email: "admin@thinkcrm.demo",      passwordHash: pw, fullName: "Siripong Tianpajeekul",  role: UserRole.ADMIN,       teamId: ids.team },
      { id: ids.manager,    tenantId: ids.tenant, email: "manager@thinkcrm.demo",    passwordHash: pw, fullName: "Manop Siriwong",       role: UserRole.MANAGER,     teamId: ids.team },
      { id: ids.supervisor, tenantId: ids.tenant, email: "supervisor@thinkcrm.demo", passwordHash: pw, fullName: "Supaporn Charoenwong", role: UserRole.SUPERVISOR,  teamId: ids.team, managerUserId: ids.manager },
      { id: ids.rep,        tenantId: ids.tenant, email: "rep@thinkcrm.demo",        passwordHash: pw, fullName: "Somchai Phuttarak",    role: UserRole.REP,         teamId: ids.team, managerUserId: ids.supervisor },
      { id: ids.rep2,       tenantId: ids.tenant, email: "rep2@thinkcrm.demo",       passwordHash: pw, fullName: "Nattaporn Yodying",    role: UserRole.REP,         teamId: ids.team, managerUserId: ids.supervisor },
      { id: ids.rep3,       tenantId: ids.tenant, email: "rep3@thinkcrm.demo",       passwordHash: pw, fullName: "Pimchanok Srithai",    role: UserRole.REP,         teamId: ids.team, managerUserId: ids.manager }
    ]
  });


  // ── Payment Terms ──────────────────────────────────────────────────────
  await prisma.paymentTerm.createMany({
    data: [
      { id: ids.termCOD,   tenantId: ids.tenant, code: "COD",   name: "ชำระเงินปลายทาง", dueDays: 0,  customFields: { collectionMethod: "cash" } },
      { id: ids.termNET15, tenantId: ids.tenant, code: "NET15", name: "เครดิต 15 วัน",    dueDays: 15, customFields: { collectionMethod: "bank-transfer" } },
      { id: ids.termNET30, tenantId: ids.tenant, code: "NET30", name: "เครดิต 30 วัน",    dueDays: 30, customFields: { collectionMethod: "bank-transfer" } },
      { id: ids.termNET60, tenantId: ids.tenant, code: "NET60", name: "เครดิต 60 วัน",    dueDays: 60, customFields: { collectionMethod: "bank-transfer" } }
    ]
  });

  // ── Custom Field Definitions ───────────────────────────────────────────
  await prisma.customFieldDefinition.createMany({
    data: [
      { tenantId: ids.tenant, entityType: "CUSTOMER",     fieldKey: "customerTier",     label: "ระดับลูกค้า",         dataType: "SELECT", isRequired: true,  displayOrder: 1, optionsJson: ["Platinum", "Gold", "Silver", "Bronze"] },
      { tenantId: ids.tenant, entityType: "ITEM",         fieldKey: "warrantyMonths",   label: "ประกัน (เดือน)",       dataType: "NUMBER", isRequired: false, displayOrder: 1 },
      { tenantId: ids.tenant, entityType: "PAYMENT_TERM", fieldKey: "collectionMethod", label: "วิธีการรับชำระเงิน",   dataType: "SELECT", isRequired: true,  displayOrder: 1, optionsJson: ["bank-transfer", "cash", "credit-card", "cheque"] }
    ]
  });

  // ── Items (Office Furniture Products) ─────────────────────────────────
  await prisma.item.createMany({
    data: [
      { id: ids.itemA, tenantId: ids.tenant, itemCode: "26FKH151", name: "โต๊ะทำงาน Kadeem 1 ที่นั่ง 1.4m",        unitPrice: 8900,   customFields: { warrantyMonths: 12 } },
      { id: ids.itemB, tenantId: ids.tenant, itemCode: "32FOB005", name: "โต๊ะทำงาน Acker 2 ที่นั่ง 1.2m",         unitPrice: 15800,  customFields: { warrantyMonths: 12 } },
      { id: ids.itemC, tenantId: ids.tenant, itemCode: "26MKH013", name: "โต๊ะผู้บริหาร Loft พร้อมตู้ข้าง 1.6m", unitPrice: 32500,  customFields: { warrantyMonths: 24 } },
      { id: ids.itemD, tenantId: ids.tenant, itemCode: "29COB021", name: "โต๊ะประชุม European Oak 2.4m",           unitPrice: 48000,  customFields: { warrantyMonths: 24 } },
      { id: ids.itemE, tenantId: ids.tenant, itemCode: "CH-MESH",  name: "เก้าอี้ Mesh Ergonomic รุ่น Longer",    unitPrice: 6500,   customFields: { warrantyMonths: 24 } },
      { id: ids.itemF, tenantId: ids.tenant, itemCode: "CH-EXEC",  name: "เก้าอี้หนัง Executive รุ่น JL",         unitPrice: 14900,  customFields: { warrantyMonths: 12 } },
      { id: ids.itemG, tenantId: ids.tenant, itemCode: "ST-2D",    name: "ตู้เอกสาร 2 บาน สีขาว",                unitPrice: 5200,   customFields: { warrantyMonths: 12 } }
    ]
  });

  // ── Deal Stages ────────────────────────────────────────────────────────
  await prisma.dealStage.createMany({
    data: [
      { id: ids.stageOpportunity, tenantId: ids.tenant, stageName: "Opportunity",   stageOrder: 1, isDefault: true },
      { id: ids.stageQuotation,   tenantId: ids.tenant, stageName: "Quotation",     stageOrder: 2 },
      { id: ids.stageNegotiation, tenantId: ids.tenant, stageName: "Negotiation",   stageOrder: 3 },
      { id: ids.stageWon,         tenantId: ids.tenant, stageName: "Won",           stageOrder: 4, isClosedWon: true },
      { id: ids.stageLost,        tenantId: ids.tenant, stageName: "Lost",          stageOrder: 5, isClosedLost: true }
    ]
  });

  // ── Customers (15 companies + contacts + addresses) ────────────────────
  await prisma.customer.create({
    data: {
      id: ids.custAcme, tenantId: ids.tenant, ownerId: ids.rep,
      customerCode: "CUST-000001", name: "บริษัท เอ็น-เทค ดิจิทัล โซลูชั่นส์ จำกัด", taxId: "0105561123450",
      customerType: CustomerType.COMPANY, defaultTermId: ids.termNET30,
      customFields: { customerTier: "Gold" },
      addresses: { create: { addressLine1: "45/12 ถนนพระราม 9", city: "กรุงเทพมหานคร", postalCode: "10310", country: "TH", subDistrict: "ห้วยขวาง", district: "ห้วยขวาง", province: "กรุงเทพมหานคร", isDefaultBilling: true, isDefaultShipping: true, latitude: 13.7563, longitude: 100.5679 } },
      contacts: { createMany: { data: [
        { name: "ประภาส อินทรโชติ",   position: "ผู้จัดการฝ่ายจัดซื้อ",        tel: "081-234-5678", email: "prapat@ntech.co.th",    lineId: "prapat_i" },
        { name: "วารุณี เพชรดี",       position: "ผู้จัดการฝ่าย Admin",         tel: "089-876-5432", email: "warunee@ntech.co.th",   lineId: "warunee_p" }
      ]}}
    }
  });

  await prisma.customer.create({
    data: {
      id: ids.custSiamTech, tenantId: ids.tenant, ownerId: ids.rep,
      customerCode: "CUST-000002", name: "บริษัท สยามพร็อพเพอร์ตี้ กรุ๊ป จำกัด", taxId: "0105562234561",
      customerType: CustomerType.COMPANY, defaultTermId: ids.termNET15,
      customFields: { customerTier: "Platinum" },
      addresses: { create: { addressLine1: "87 ถนนสีลม ชั้น 14", city: "กรุงเทพมหานคร", postalCode: "10500", country: "TH", subDistrict: "สีลม", district: "บางรัก", province: "กรุงเทพมหานคร", isDefaultBilling: true, isDefaultShipping: true, latitude: 13.7274, longitude: 100.5175 } },
      contacts: { createMany: { data: [
        { name: "กิตติพงษ์ วงศ์สกุล",  position: "ผู้อำนวยการฝ่ายโครงการ",    tel: "085-000-1111", email: "kittipong@siamproperty.th",  lineId: "kittipong_w", whatsapp: "660850001111" },
        { name: "ดาราวรรณ รักษ์ดี",    position: "เจ้าหน้าที่จัดซื้อ",         tel: "081-999-2222", email: "darawan@siamproperty.th",    lineId: "darawan_r" }
      ]}}
    }
  });

  await prisma.customer.create({
    data: {
      id: ids.custBKKFood, tenantId: ids.tenant, ownerId: ids.rep2,
      customerCode: "CUST-000003", name: "บริษัท กรุงเทพประกันภัย (พ.ร.บ.) จำกัด มหาชน", taxId: "0107543345672",
      customerType: CustomerType.COMPANY, defaultTermId: ids.termNET60,
      customFields: { customerTier: "Gold" },
      addresses: { create: { addressLine1: "25 ถนนสาทรใต้ ชั้น 8", city: "กรุงเทพมหานคร", postalCode: "10120", country: "TH", subDistrict: "ทุ่งมหาเมฆ", district: "สาทร", province: "กรุงเทพมหานคร", isDefaultBilling: true, isDefaultShipping: true, latitude: 13.7200, longitude: 100.5250 } },
      contacts: { createMany: { data: [
        { name: "ปรีดา จันทร์แก้ว",    position: "ผู้จัดการอาคารและสถานที่",    tel: "086-555-7890", email: "preeda@bkkins.co.th",    lineId: "preeda_c" },
        { name: "สุดารัตน์ โพธิ์ทอง",  position: "เจ้าหน้าที่จัดซื้อ",         tel: "084-333-6543", email: "sudarat@bkkins.co.th" }
      ]}}
    }
  });

  await prisma.customer.create({
    data: {
      id: ids.custThaiSteel, tenantId: ids.tenant, ownerId: ids.rep2,
      customerCode: "CUST-000004", name: "บริษัท ไทยออโตโมทีฟ แมนูแฟคเจอริ่ง จำกัด", taxId: "0215554456783",
      customerType: CustomerType.COMPANY, defaultTermId: ids.termNET30,
      customFields: { customerTier: "Silver" },
      addresses: { create: { addressLine1: "88 นิคมอุตสาหกรรมอีสเทิร์นซีบอร์ด", city: "ระยอง", postalCode: "21130", country: "TH", subDistrict: "มาบตาพุด", district: "เมืองระยอง", province: "ระยอง", isDefaultBilling: true, isDefaultShipping: true, latitude: 12.7018, longitude: 101.1401 } },
      contacts: { createMany: { data: [
        { name: "วิรัตน์ แสงทอง",       position: "ผู้จัดการฝ่าย Facility",      tel: "038-601-234", email: "wirat@thaiautomotive.co.th",   lineId: "wirat_s" },
        { name: "นภาพร ศิลาทอง",        position: "เจ้าหน้าที่จัดซื้อ",         tel: "083-777-4567", email: "napaporn@thaiautomotive.co.th" }
      ]}}
    }
  });

  await prisma.customer.create({
    data: {
      id: ids.custPremier, tenantId: ids.tenant, ownerId: ids.rep3,
      customerCode: "CUST-000005", name: "โรงแรม แกรนด์ ทาวเวอร์ กรุงเทพ", taxId: "0105565567894",
      customerType: CustomerType.COMPANY, defaultTermId: ids.termNET30,
      customFields: { customerTier: "Gold" },
      addresses: { create: { addressLine1: "1011 ถนนวิภาวดีรังสิต", city: "กรุงเทพมหานคร", postalCode: "10900", country: "TH", subDistrict: "จตุจักร", district: "จตุจักร", province: "กรุงเทพมหานคร", isDefaultBilling: true, isDefaultShipping: false } },
      contacts: { createMany: { data: [
        { name: "ธีระพงษ์ เจริญสุข",    position: "ผู้อำนวยการฝ่ายจัดซื้อ",    tel: "092-100-5678", email: "teerapong@grandtower.th",   lineId: "teerapong_j", whatsapp: "66921005678" },
        { name: "ศิริลักษณ์ ดวงดี",     position: "เจ้าหน้าที่ประสานงาน",      tel: "091-200-3456", email: "sirirak@grandtower.th" }
      ]}}
    }
  });

  await prisma.customer.create({
    data: {
      id: ids.custEastAsia, tenantId: ids.tenant, ownerId: ids.rep3,
      customerCode: "CUST-000006", name: "บริษัท ฟิวเจอร์เวิร์ค สเปซ จำกัด", taxId: "0105566678905",
      customerType: CustomerType.COMPANY, defaultTermId: ids.termNET15,
      customFields: { customerTier: "Silver" },
      addresses: { create: { addressLine1: "28 ถนนเจริญนคร ชั้น 6", city: "กรุงเทพมหานคร", postalCode: "10600", country: "TH", subDistrict: "คลองสาน", district: "คลองสาน", province: "กรุงเทพมหานคร", isDefaultBilling: true, isDefaultShipping: true, latitude: 13.7200, longitude: 100.5100 } },
      contacts: { createMany: { data: [
        { name: "จิรายุ มั่นคง",         position: "กรรมการผู้จัดการ",           tel: "081-888-9900", email: "jirayu@futurework.co.th",   lineId: "jirayu_m", whatsapp: "66818889900" }
      ]}}
    }
  });

  await prisma.customer.create({
    data: {
      id: ids.custGolden, tenantId: ids.tenant, ownerId: ids.rep,
      customerCode: "CUST-000007", name: "บริษัท เดลต้า ก่อสร้างและพัฒนา จำกัด", taxId: "0105557789016",
      customerType: CustomerType.COMPANY, defaultTermId: ids.termCOD,
      customFields: { customerTier: "Bronze" },
      addresses: { create: { addressLine1: "52 ถนนเพชรบุรีตัดใหม่", city: "กรุงเทพมหานคร", postalCode: "10400", country: "TH", subDistrict: "มักกะสัน", district: "ราชเทวี", province: "กรุงเทพมหานคร", isDefaultBilling: true, isDefaultShipping: true, latitude: 13.7520, longitude: 100.5580 } },
      contacts: { createMany: { data: [
        { name: "บุญรอด กาญจนา",         position: "ผู้จัดการโครงการ",           tel: "056-201-234", email: "boonrod@delta-construction.co.th",  lineId: "boonrod_k" },
        { name: "มณีรัตน์ สุขสวัสดิ์",   position: "นักบัญชี",                   tel: "083-456-7890", email: "maneerat@delta-construction.co.th" }
      ]}}
    }
  });

  await prisma.customer.create({
    data: {
      id: ids.custRajaPlas, tenantId: ids.tenant, ownerId: ids.rep2,
      customerCode: "CUST-000008", name: "บริษัท เมดิคอล พลัส (ประเทศไทย) จำกัด", taxId: "0105568890127",
      customerType: CustomerType.COMPANY, defaultTermId: ids.termNET30,
      customFields: { customerTier: "Silver" },
      addresses: { create: { addressLine1: "14/7 ถนนบรมราชชนนี", city: "กรุงเทพมหานคร", postalCode: "10160", country: "TH", subDistrict: "บางพลัด", district: "บางพลัด", province: "กรุงเทพมหานคร", isDefaultBilling: true, isDefaultShipping: true, latitude: 13.7800, longitude: 100.4700 } },
      contacts: { createMany: { data: [
        { name: "ประเสริฐ วงศ์วิจิตร",   position: "ผู้จัดการอาคาร",             tel: "089-654-3210", email: "prasert@medicalplus.co.th",   lineId: "prasert_w" },
        { name: "อรัญญา บุษบา",          position: "ผู้จัดการฝ่ายจัดซื้อ",       tel: "081-123-6789", email: "aranya@medicalplus.co.th" }
      ]}}
    }
  });

  await prisma.customer.create({
    data: {
      id: ids.custCentral, tenantId: ids.tenant, ownerId: ids.rep3,
      customerCode: "CUST-000009", name: "บริษัท ซีพี เทรดดิ้ง อินเตอร์เนชั่นแนล จำกัด", taxId: "0107539901238",
      customerType: CustomerType.COMPANY, defaultTermId: ids.termNET60,
      customFields: { customerTier: "Platinum" },
      addresses: { create: { addressLine1: "999 ถนนพระราม 1 ชั้น 30", city: "กรุงเทพมหานคร", postalCode: "10330", country: "TH", subDistrict: "ปทุมวัน", district: "ปทุมวัน", province: "กรุงเทพมหานคร", isDefaultBilling: true, isDefaultShipping: false, latitude: 13.7466, longitude: 100.5393 } },
      contacts: { createMany: { data: [
        { name: "วิไลพร พรหมสิทธิ์",     position: "ผู้อำนวยการฝ่ายบริหารสำนักงาน", tel: "082-222-3333", email: "wilaiporn@cptrading.co.th",   lineId: "wilaiporn_p", whatsapp: "66822223333" },
        { name: "เอกลักษณ์ ดวงฤทธิ์",    position: "ผู้จัดการฝ่ายจัดซื้อ",          tel: "081-444-5555", email: "eklak@cptrading.co.th",       lineId: "eklak_d"   }
      ]}}
    }
  });

  await prisma.customer.create({
    data: {
      id: ids.custNorth, tenantId: ids.tenant, ownerId: ids.rep,
      customerCode: "CUST-000010", name: "บริษัท นอร์ทสตาร์ โลจิสติกส์ จำกัด", taxId: "0505510012349",
      customerType: CustomerType.COMPANY, defaultTermId: ids.termNET15,
      customFields: { customerTier: "Bronze" },
      addresses: { create: { addressLine1: "78 ถนนนิมมานเหมินทร์", city: "เชียงใหม่", postalCode: "50200", country: "TH", subDistrict: "สุเทพ", district: "เมืองเชียงใหม่", province: "เชียงใหม่", isDefaultBilling: true, isDefaultShipping: true, latitude: 18.8004, longitude: 98.9600 } },
      contacts: { createMany: { data: [
        { name: "รัชนีกร ธาวรัตน์",      position: "เจ้าของกิจการ",              tel: "053-211-234", email: "ratchaneekorn@northstar-logistics.co.th", lineId: "ratchaneekorn_t" }
      ]}}
    }
  });

  await prisma.customer.create({
    data: {
      id: ids.custSunrise, tenantId: ids.tenant, ownerId: ids.rep2,
      customerCode: "CUST-000011", name: "บริษัท กรีนเอิร์ธ เอนเนอร์ยี่ จำกัด", taxId: "0105571123450",
      customerType: CustomerType.COMPANY, defaultTermId: ids.termNET30,
      customFields: { customerTier: "Gold" },
      addresses: { create: { addressLine1: "500 ถนนสุขุมวิท ชั้น 22", city: "กรุงเทพมหานคร", postalCode: "10110", country: "TH", subDistrict: "คลองเตย", district: "คลองเตย", province: "กรุงเทพมหานคร", isDefaultBilling: true, isDefaultShipping: true, latitude: 13.7200, longitude: 100.5700 } },
      contacts: { createMany: { data: [
        { name: "ณัฐพล จันทรา",          position: "หัวหน้าฝ่ายจัดซื้อ",         tel: "092-888-1234", email: "nattapol@greenearth.co.th",  lineId: "nattapol_c",  whatsapp: "66928881234" },
        { name: "ปาริชาติ สุทธิพงษ์",    position: "ผู้ช่วยผู้จัดการอาคาร",     tel: "098-765-4321", email: "parichat@greenearth.co.th" }
      ]}}
    }
  });

  await prisma.customer.create({
    data: {
      id: ids.custMega, tenantId: ids.tenant, ownerId: ids.rep3,
      customerCode: "CUST-000012", name: "บริษัท โอเชี่ยน มีเดีย กรุ๊ป จำกัด", taxId: "0105572234561",
      customerType: CustomerType.COMPANY, defaultTermId: ids.termCOD,
      customFields: { customerTier: "Bronze" },
      addresses: { create: { addressLine1: "12 ถนนลาดพร้าว", city: "กรุงเทพมหานคร", postalCode: "10230", country: "TH", subDistrict: "ลาดพร้าว", district: "ลาดพร้าว", province: "กรุงเทพมหานคร", isDefaultBilling: true, isDefaultShipping: true } },
      contacts: { createMany: { data: [
        { name: "สิรินทร์ ภาสกร",         position: "กรรมการผู้จัดการ",           tel: "081-765-4321", email: "sirin@oceanmedia.co.th",  lineId: "sirin_p" }
      ]}}
    }
  });

  await prisma.customer.create({
    data: {
      id: ids.custViva, tenantId: ids.tenant, ownerId: ids.rep,
      customerCode: "CUST-000013", name: "บริษัท ริเวอร์ไซด์ เรสซิเดนซ์ ดีเวลลอปเมนต์ จำกัด", taxId: "0105563345672",
      customerType: CustomerType.COMPANY, defaultTermId: ids.termNET30,
      customFields: { customerTier: "Silver" },
      addresses: { create: { addressLine1: "301 ถนนรัชดาภิเษก", city: "กรุงเทพมหานคร", postalCode: "10320", country: "TH", subDistrict: "ดินแดง", district: "ดินแดง", province: "กรุงเทพมหานคร", isDefaultBilling: true, isDefaultShipping: true, latitude: 13.7700, longitude: 100.5600 } },
      contacts: { createMany: { data: [
        { name: "อาภาภรณ์ สุรินทราช",    position: "ผู้อำนวยการฝ่ายโครงการ",    tel: "089-123-4567", email: "apaporn@riverside-dev.co.th",  lineId: "apaporn_s" },
        { name: "กานต์ธิดา บุษรา",       position: "ผู้จัดการฝ่าย Admin",        tel: "086-234-5678", email: "kanthida@riverside-dev.co.th", whatsapp: "66862345678" }
      ]}}
    }
  });

  await prisma.customer.create({
    data: {
      id: ids.custAmarin, tenantId: ids.tenant, ownerId: ids.rep2,
      customerCode: "CUST-000014", name: "บริษัท เอเชีย ฟาร์มาซูติคอล จำกัด", taxId: "0105574456783",
      customerType: CustomerType.COMPANY, defaultTermId: ids.termNET15,
      customFields: { customerTier: "Silver" },
      addresses: { create: { addressLine1: "65/16 ถนนพระราม 6", city: "กรุงเทพมหานคร", postalCode: "10400", country: "TH", subDistrict: "พญาไท", district: "พญาไท", province: "กรุงเทพมหานคร", isDefaultBilling: true, isDefaultShipping: true } },
      contacts: { createMany: { data: [
        { name: "วิชัยชนะ อินทร์เจริญ",  position: "ผู้จัดการฝ่าย Facility",      tel: "080-111-2233", email: "wichaichana@asiapharma.co.th", lineId: "wichaichana_i" }
      ]}}
    }
  });

  await prisma.customer.create({
    data: {
      id: ids.custOmega, tenantId: ids.tenant, ownerId: ids.rep3,
      customerCode: "CUST-000015", name: "บริษัท อินฟินิตี้ เทค โซลูชั่นส์ จำกัด", taxId: "0105575567894",
      customerType: CustomerType.COMPANY, defaultTermId: ids.termNET60,
      customFields: { customerTier: "Platinum" },
      addresses: { create: { addressLine1: "888 อาคารเอ็มไพร์ ถนนสาทรเหนือ ชั้น 25", city: "กรุงเทพมหานคร", postalCode: "10120", country: "TH", subDistrict: "ยานนาวา", district: "สาทร", province: "กรุงเทพมหานคร", isDefaultBilling: true, isDefaultShipping: true, latitude: 13.7200, longitude: 100.5300 } },
      contacts: { createMany: { data: [
        { name: "ชัยภัทร รุ่งเรือง",      position: "Chief Operating Officer",     tel: "038-457-890", email: "chaiyapat@infinitytech.co.th", lineId: "chaiyapat_r",  whatsapp: "66384578901" },
        { name: "ยุพา พิมลรัตน์",         position: "ผู้จัดการฝ่ายบริหารสำนักงาน", tel: "092-567-8901", email: "yupa@infinitytech.co.th" }
      ]}}
    }
  });

  // ── Deals (25 deals across stages and reps) ────────────────────────────
  type DealInput = {
    id: string; tenantId: string; dealNo: string; dealName: string; customerId: string;
    ownerId: string; stageId: string; estimatedValue: number; status: DealStatus;
    followUpAt: Date; closedAt?: Date;
    createdAt: Date;
  };

  const deals: DealInput[] = [
    // rep - Opportunity
    { id: ids.deal01, tenantId: ids.tenant, dealNo: "DL-2026-0001", dealName: "ตกแต่งสำนักงานใหม่ชั้น 12–15 (150 ที่นั่ง)",    customerId: ids.custAcme,     ownerId: ids.rep,  stageId: ids.stageOpportunity, estimatedValue: 980000, status: DealStatus.OPEN, followUpAt: daysFromNow(3),   createdAt: daysFromNow(-14) },
    { id: ids.deal02, tenantId: ids.tenant, dealNo: "DL-2026-0002", dealName: "จัดซื้อโต๊ะประชุม Board Room และห้องย่อย",        customerId: ids.custSiamTech, ownerId: ids.rep,  stageId: ids.stageQuotation,   estimatedValue: 420000, status: DealStatus.OPEN, followUpAt: daysFromNow(5),   createdAt: daysFromNow(-21) },
    { id: ids.deal03, tenantId: ids.tenant, dealNo: "DL-2026-0003", dealName: "เพิ่มพื้นที่ทำงานชั้น 9 โซน B",                  customerId: ids.custAcme,     ownerId: ids.rep,  stageId: ids.stageNegotiation, estimatedValue: 185000, status: DealStatus.OPEN, followUpAt: daysFromNow(2),   createdAt: daysFromNow(-30) },
    { id: ids.deal04, tenantId: ids.tenant, dealNo: "DL-2026-0004", dealName: "ชุดเฟอร์นิเจอร์ผู้บริหาร สำนักงานใหม่สีลม",      customerId: ids.custSiamTech, ownerId: ids.rep,  stageId: ids.stageWon,         estimatedValue: 560000, status: DealStatus.WON,  followUpAt: daysFromNow(-5),  closedAt: daysFromNow(-5),   createdAt: daysFromNow(-60) },
    { id: ids.deal05, tenantId: ids.tenant, dealNo: "DL-2026-0005", dealName: "เก้าอี้ Ergonomic ฝ่ายขาย 30 ตัว",               customerId: ids.custGolden,   ownerId: ids.rep,  stageId: ids.stageLost,        estimatedValue: 195000, status: DealStatus.LOST, followUpAt: daysFromNow(-10), closedAt: daysFromNow(-10), createdAt: daysFromNow(-45) },
    { id: ids.deal06, tenantId: ids.tenant, dealNo: "DL-2026-0006", dealName: "ชุดรับแขก Lobby และพื้นที่รอ",                    customerId: ids.custViva,     ownerId: ids.rep,  stageId: ids.stageOpportunity, estimatedValue: 130000, status: DealStatus.OPEN, followUpAt: daysFromNow(7),   createdAt: daysFromNow(-8) },
    { id: ids.deal07, tenantId: ids.tenant, dealNo: "DL-2026-0007", dealName: "โต๊ะทำงานและตู้เก็บเอกสารแผนก Admin",            customerId: ids.custNorth,    ownerId: ids.rep,  stageId: ids.stageQuotation,   estimatedValue: 74000,  status: DealStatus.OPEN, followUpAt: daysFromNow(4),   createdAt: daysFromNow(-17) },
    // rep2 - mixed stages
    { id: ids.deal08, tenantId: ids.tenant, dealNo: "DL-2026-0008", dealName: "รีโนเวทสำนักงานใหญ่ทั้งหลัง 3 ชั้น",              customerId: ids.custBKKFood,  ownerId: ids.rep2, stageId: ids.stageNegotiation, estimatedValue: 1850000, status: DealStatus.OPEN, followUpAt: daysFromNow(1),   createdAt: daysFromNow(-25) },
    { id: ids.deal09, tenantId: ids.tenant, dealNo: "DL-2026-0009", dealName: "ผนังกั้นห้องระบบ Modular ชั้น 4–6",               customerId: ids.custThaiSteel,ownerId: ids.rep2, stageId: ids.stageQuotation,   estimatedValue: 680000, status: DealStatus.OPEN, followUpAt: daysFromNow(6),   createdAt: daysFromNow(-19) },
    { id: ids.deal10, tenantId: ids.tenant, dealNo: "DL-2026-0010", dealName: "เฟอร์นิเจอร์ห้องพักผ่อนพนักงาน",                 customerId: ids.custRajaPlas, ownerId: ids.rep2, stageId: ids.stageOpportunity, estimatedValue: 95000,  status: DealStatus.OPEN, followUpAt: daysFromNow(9),   createdAt: daysFromNow(-6) },
    { id: ids.deal11, tenantId: ids.tenant, dealNo: "DL-2026-0011", dealName: "โต๊ะทำงาน Acker ฝ่าย IT 20 ชุด",                  customerId: ids.custBKKFood,  ownerId: ids.rep2, stageId: ids.stageWon,         estimatedValue: 316000, status: DealStatus.WON,  followUpAt: daysFromNow(-3),  closedAt: daysFromNow(-3),   createdAt: daysFromNow(-55) },
    { id: ids.deal12, tenantId: ids.tenant, dealNo: "DL-2026-0012", dealName: "ชุดเฟอร์นิเจอร์ห้องฝึกอบรม 2 ห้อง",              customerId: ids.custAmarin,   ownerId: ids.rep2, stageId: ids.stageNegotiation, estimatedValue: 210000, status: DealStatus.OPEN, followUpAt: daysFromNow(2),   createdAt: daysFromNow(-28) },
    { id: ids.deal13, tenantId: ids.tenant, dealNo: "DL-2026-0013", dealName: "ตู้เก็บเอกสาร Steel จำนวนมาก",                    customerId: ids.custRajaPlas, ownerId: ids.rep2, stageId: ids.stageLost,        estimatedValue: 62400,  status: DealStatus.LOST, followUpAt: daysFromNow(-20), closedAt: daysFromNow(-20), createdAt: daysFromNow(-50) },
    // rep3 - mixed stages
    { id: ids.deal14, tenantId: ids.tenant, dealNo: "DL-2026-0014", dealName: "จัดเต็มทุกชั้น — Tower B 5 ชั้น 500 ที่นั่ง",     customerId: ids.custCentral,  ownerId: ids.rep3, stageId: ids.stageNegotiation, estimatedValue: 4200000,status: DealStatus.OPEN, followUpAt: daysFromNow(3),   createdAt: daysFromNow(-35) },
    { id: ids.deal15, tenantId: ids.tenant, dealNo: "DL-2026-0015", dealName: "เฟอร์นิเจอร์โซน Co-working ทั้งชั้น",             customerId: ids.custPremier,  ownerId: ids.rep3, stageId: ids.stageQuotation,   estimatedValue: 750000, status: DealStatus.OPEN, followUpAt: daysFromNow(5),   createdAt: daysFromNow(-22) },
    { id: ids.deal16, tenantId: ids.tenant, dealNo: "DL-2026-0016", dealName: "โต๊ะผู้บริหาร Loft ชั้น 6 ทั้งชั้น",              customerId: ids.custEastAsia, ownerId: ids.rep3, stageId: ids.stageOpportunity, estimatedValue: 390000, status: DealStatus.OPEN, followUpAt: daysFromNow(8),   createdAt: daysFromNow(-12) },
    { id: ids.deal17, tenantId: ids.tenant, dealNo: "DL-2026-0017", dealName: "ชุดเฟอร์นิเจอร์ Showroom สำนักงานใหม่",           customerId: ids.custSunrise,  ownerId: ids.rep3, stageId: ids.stageWon,         estimatedValue: 920000, status: DealStatus.WON,  followUpAt: daysFromNow(-7),  closedAt: daysFromNow(-7),   createdAt: daysFromNow(-70) },
    { id: ids.deal18, tenantId: ids.tenant, dealNo: "DL-2026-0018", dealName: "เก้าอี้ Executive ห้องประชุมทั้งหมด 8 ห้อง",      customerId: ids.custCentral,  ownerId: ids.rep3, stageId: ids.stageWon,         estimatedValue: 475200, status: DealStatus.WON,  followUpAt: daysFromNow(-15), closedAt: daysFromNow(-15),  createdAt: daysFromNow(-80) },
    { id: ids.deal19, tenantId: ids.tenant, dealNo: "DL-2026-0019", dealName: "Mega Project — สำนักงานใหม่ทั้งอาคาร 8 ชั้น",      customerId: ids.custOmega,    ownerId: ids.rep3, stageId: ids.stageNegotiation, estimatedValue: 6800000,status: DealStatus.OPEN, followUpAt: daysFromNow(4),   createdAt: daysFromNow(-40) },
    { id: ids.deal20, tenantId: ids.tenant, dealNo: "DL-2026-0020", dealName: "ผนังกั้นห้องชั้น 3 โซน Creative",                  customerId: ids.custMega,     ownerId: ids.rep3, stageId: ids.stageLost,        estimatedValue: 88000,  status: DealStatus.LOST, followUpAt: daysFromNow(-30), closedAt: daysFromNow(-30), createdAt: daysFromNow(-65) },
    // Additional deals for variety
    { id: ids.deal21, tenantId: ids.tenant, dealNo: "DL-2026-0021", dealName: "เฟสที่ 2 — ส่วนต่อขยายอาคาร C",                   customerId: ids.custOmega,    ownerId: ids.rep3, stageId: ids.stageOpportunity, estimatedValue: 3200000,status: DealStatus.OPEN, followUpAt: daysFromNow(14),  createdAt: daysFromNow(-4) },
    { id: ids.deal22, tenantId: ids.tenant, dealNo: "DL-2026-0022", dealName: "โต๊ะทำงานโซน Startup ชั้น 2",                      customerId: ids.custCentral,  ownerId: ids.rep3, stageId: ids.stageOpportunity, estimatedValue: 280000, status: DealStatus.OPEN, followUpAt: daysFromNow(10),  createdAt: daysFromNow(-3) },
    { id: ids.deal23, tenantId: ids.tenant, dealNo: "DL-2026-0023", dealName: "โต๊ะทำงาน Acker เพิ่มเติมแผนกใหม่",               customerId: ids.custAcme,     ownerId: ids.rep,  stageId: ids.stageOpportunity, estimatedValue: 142000, status: DealStatus.OPEN, followUpAt: daysFromNow(11),  createdAt: daysFromNow(-2) },
    { id: ids.deal24, tenantId: ids.tenant, dealNo: "DL-2026-0024", dealName: "เก้าอี้ Mesh Ergonomic ฝ่าย Call Center 80 ตัว",  customerId: ids.custBKKFood,  ownerId: ids.rep2, stageId: ids.stageOpportunity, estimatedValue: 520000, status: DealStatus.OPEN, followUpAt: daysFromNow(12),  createdAt: daysFromNow(-1) },
    { id: ids.deal25, tenantId: ids.tenant, dealNo: "DL-2026-0025", dealName: "รีเฟรชออฟฟิศ — เปลี่ยนเก้าอี้และโต๊ะทั้งชั้น 10", customerId: ids.custSiamTech, ownerId: ids.rep,  stageId: ids.stageQuotation,   estimatedValue: 320000, status: DealStatus.OPEN, followUpAt: daysFromNow(6),   createdAt: daysFromNow(-10) },
    // ── Test deals for notification testing (based on DL-2026-0003) ──
    { id: ids.deal26, tenantId: ids.tenant, dealNo: "DL-2026-0026", dealName: "เพิ่มพื้นที่ทำงานชั้น 9 โซน B (Test 1)",  customerId: ids.custAcme, ownerId: ids.rep, stageId: ids.stageNegotiation, estimatedValue: 185000, status: DealStatus.OPEN, followUpAt: daysFromNow(2), createdAt: daysFromNow(-1) },
    { id: ids.deal27, tenantId: ids.tenant, dealNo: "DL-2026-0027", dealName: "เพิ่มพื้นที่ทำงานชั้น 9 โซน B (Test 2)",  customerId: ids.custAcme, ownerId: ids.rep, stageId: ids.stageNegotiation, estimatedValue: 185000, status: DealStatus.OPEN, followUpAt: daysFromNow(2), createdAt: daysFromNow(-1) },
    { id: ids.deal28, tenantId: ids.tenant, dealNo: "DL-2026-0028", dealName: "เพิ่มพื้นที่ทำงานชั้น 9 โซน B (Test 3)",  customerId: ids.custAcme, ownerId: ids.rep, stageId: ids.stageNegotiation, estimatedValue: 185000, status: DealStatus.OPEN, followUpAt: daysFromNow(2), createdAt: daysFromNow(-1) },
    { id: ids.deal29, tenantId: ids.tenant, dealNo: "DL-2026-0029", dealName: "เพิ่มพื้นที่ทำงานชั้น 9 โซน B (Test 4)",  customerId: ids.custAcme, ownerId: ids.rep, stageId: ids.stageNegotiation, estimatedValue: 185000, status: DealStatus.OPEN, followUpAt: daysFromNow(2), createdAt: daysFromNow(-1) },
    { id: ids.deal30, tenantId: ids.tenant, dealNo: "DL-2026-0030", dealName: "เพิ่มพื้นที่ทำงานชั้น 9 โซน B (Test 5)",  customerId: ids.custAcme, ownerId: ids.rep, stageId: ids.stageNegotiation, estimatedValue: 185000, status: DealStatus.OPEN, followUpAt: daysFromNow(2), createdAt: daysFromNow(-1) },
    { id: ids.deal31, tenantId: ids.tenant, dealNo: "DL-2026-0031", dealName: "เพิ่มพื้นที่ทำงานชั้น 9 โซน B (Test 6)",  customerId: ids.custAcme, ownerId: ids.rep, stageId: ids.stageNegotiation, estimatedValue: 185000, status: DealStatus.OPEN, followUpAt: daysFromNow(2), createdAt: daysFromNow(-1) },
    { id: ids.deal32, tenantId: ids.tenant, dealNo: "DL-2026-0032", dealName: "เพิ่มพื้นที่ทำงานชั้น 9 โซน B (Test 7)",  customerId: ids.custAcme, ownerId: ids.rep, stageId: ids.stageNegotiation, estimatedValue: 185000, status: DealStatus.OPEN, followUpAt: daysFromNow(2), createdAt: daysFromNow(-1) },
    { id: ids.deal33, tenantId: ids.tenant, dealNo: "DL-2026-0033", dealName: "เพิ่มพื้นที่ทำงานชั้น 9 โซน B (Test 8)",  customerId: ids.custAcme, ownerId: ids.rep, stageId: ids.stageNegotiation, estimatedValue: 185000, status: DealStatus.OPEN, followUpAt: daysFromNow(2), createdAt: daysFromNow(-1) },
    { id: ids.deal34, tenantId: ids.tenant, dealNo: "DL-2026-0034", dealName: "เพิ่มพื้นที่ทำงานชั้น 9 โซน B (Test 9)",  customerId: ids.custAcme, ownerId: ids.rep, stageId: ids.stageNegotiation, estimatedValue: 185000, status: DealStatus.OPEN, followUpAt: daysFromNow(2), createdAt: daysFromNow(-1) },
    { id: ids.deal35, tenantId: ids.tenant, dealNo: "DL-2026-0035", dealName: "เพิ่มพื้นที่ทำงานชั้น 9 โซน B (Test 10)", customerId: ids.custAcme, ownerId: ids.rep, stageId: ids.stageNegotiation, estimatedValue: 185000, status: DealStatus.OPEN, followUpAt: daysFromNow(2), createdAt: daysFromNow(-1) },
  ];

  for (const d of deals) {
    await prisma.deal.create({ data: d });
  }

  // ── Deal Progress Updates ──────────────────────────────────────────────
  await prisma.dealProgressUpdate.createMany({
    data: [
      { dealId: ids.deal01, createdById: ids.rep,  note: "สำรวจพื้นที่แล้ว ชั้น 12–15 รวม 1,800 ตร.ม. ลูกค้าต้องการ Workstation รูปแบบ Open Plan",  createdAt: daysFromNow(-12) },
      { dealId: ids.deal01, createdById: ids.rep,  note: "ส่ง Mood board และตัวอย่างสีแล้ว รอฝ่าย Design ลูกค้าอนุมัติ",                                createdAt: daysFromNow(-5)  },
      { dealId: ids.deal02, createdById: ids.rep,  note: "ประชุมกับคุณกิตติพงษ์ ต้องการโต๊ะประชุม 2.4m จำนวน 3 โต๊ะ และห้องย่อย 6 ห้อง",              createdAt: daysFromNow(-19) },
      { dealId: ids.deal02, createdById: ids.rep,  note: "ส่งใบเสนอราคาแล้ว รอคณะกรรมการอาคารพิจารณา",                                                  createdAt: daysFromNow(-10) },
      { dealId: ids.deal03, createdById: ids.rep,  note: "อยู่ระหว่างต่อรองราคา ลูกค้าขอส่วนลดเพิ่ม 5% สำหรับ volume",                                  createdAt: daysFromNow(-7)  },
      { dealId: ids.deal04, createdById: ids.rep,  note: "ลงนามสัญญาแล้ว วางมัดจำ 30% แล้ว กำหนดส่งมอบภายใน 6 สัปดาห์",                               createdAt: daysFromNow(-5)  },
      { dealId: ids.deal05, createdById: ids.rep,  note: "ดีลหลุด ลูกค้าเลือกซัพพลายเออร์รายอื่นที่ราคาถูกกว่า 15% จะติดตามอีกครั้งปลายปี",           createdAt: daysFromNow(-10) },
      { dealId: ids.deal08, createdById: ids.rep2, note: "ประชุมกับทีมอาคาร เจ้าของโครงการต้องการ Turnkey ทั้ง 3 ชั้น รวม Design Fee ด้วย",             createdAt: daysFromNow(-20) },
      { dealId: ids.deal08, createdById: ids.rep2, note: "เสนอแพ็กเกจแบบแบ่งเฟส ลูกค้าพอใจ เจรจาต่อรองเงื่อนไขการชำระสุดท้าย",                       createdAt: daysFromNow(-8)  },
      { dealId: ids.deal09, createdById: ids.rep2, note: "สำรวจและวัดผนังแล้ว ระบบ Modular เหมาะกับผัง ต้องประสานงานผู้รับเหมาก่อสร้าง",               createdAt: daysFromNow(-15) },
      { dealId: ids.deal09, createdById: ids.rep2, note: "ส่ง 3D Visualization แล้ว ลูกค้าชอบ Concept ขอปรับสีใหม่อีกรอบ",                               createdAt: daysFromNow(-9)  },
      { dealId: ids.deal11, createdById: ids.rep2, note: "ลูกค้ายืนยัน PO แล้ว จัดส่งและติดตั้งภายใน 3 สัปดาห์",                                        createdAt: daysFromNow(-3)  },
      { dealId: ids.deal14, createdById: ids.rep3, note: "นำเสนอ Concept Design ต่อคณะกรรมการ 9 คน ประทับใจโซลูชันแบบ Modular ที่ขยายได้",             createdAt: daysFromNow(-25) },
      { dealId: ids.deal14, createdById: ids.rep3, note: "ฝ่ายกฎหมายตรวจสอบสัญญา ทีม Design ลูกค้าอนุมัติ Mood board ชั้น 1–3 แล้ว",                  createdAt: daysFromNow(-10) },
      { dealId: ids.deal14, createdById: ids.rep3, note: "ต่อรองราคาขั้นสุดท้าย ลูกค้าขอ Warranty 3 ปีและบริการ After-sale ฟรี 1 ปี",                  createdAt: daysFromNow(-3)  },
      { dealId: ids.deal17, createdById: ids.rep3, note: "ติดตั้งและส่งมอบสมบูรณ์แล้ว ลูกค้าพึงพอใจ 100% มีโอกาสอ้างอิงลูกค้ารายอื่น",              createdAt: daysFromNow(-7)  },
      { dealId: ids.deal19, createdById: ids.rep3, note: "ประชุม Kickoff กับคุณชัยภัทรและทีม Design ลูกค้า กำหนด Concept 3 แบบให้เลือก",                createdAt: daysFromNow(-35) },
      { dealId: ids.deal19, createdById: ids.rep3, note: "นำเสนอ 3D Walk-through แล้ว ลูกค้าประทับใจมาก เลือก Concept C และขอ Mockup จริง 1 ห้อง",   createdAt: daysFromNow(-20) },
      { dealId: ids.deal19, createdById: ids.rep3, note: "ต่อรองแผนการชำระ ลูกค้าต้องการแบ่งจ่าย 4 งวดตามความคืบหน้างาน",                              createdAt: daysFromNow(-5)  },
      { dealId: ids.deal25, createdById: ids.rep,  note: "สำรวจสภาพเก้าอี้และโต๊ะเดิมแล้ว ลูกค้าต้องการ Refresh Look ทั้งชั้น ส่งใบเสนอราคาภายในสัปดาห์", createdAt: daysFromNow(-8) },
      // ── Somchai extra progress notes ────────────────────────────────────
      { dealId: ids.deal06, createdById: ids.rep,  note: "นำตัวอย่างผ้า 3 แบบไปให้ดู ลูกค้าชอบผ้า Velvet Navy กำลังรอ BOD อนุมัติงบประมาณ",            createdAt: daysFromNow(-9) },
      { dealId: ids.deal06, createdById: ids.rep,  note: "โทรติดตาม คุณอาภาภรณ์แจ้งว่า BOD ประชุมสัปดาห์หน้า มีโอกาสสูงที่จะผ่าน",                   createdAt: daysFromNow(-4) },
      { dealId: ids.deal07, createdById: ids.rep,  note: "วัดพื้นที่ 320 ตร.ม. เสนอ Package โต๊ะ+เก้าอี้+ตู้ครบชุด พร้อมส่วนลด Volume 8%",             createdAt: daysFromNow(-16) },
      { dealId: ids.deal07, createdById: ids.rep,  note: "ส่ง Quotation แล้ว คุณรัชนีกรขอเปลี่ยนสีโต๊ะเป็น Wenge กำลังตรวจสอบ Stock รอยืนยัน",        createdAt: daysFromNow(-4) },
      { dealId: ids.deal23, createdById: ids.rep,  note: "วัดพื้นที่ชั้น 11 แล้ว 250 ตร.ม. นำเสนอ Cluster Layout 4 คนต่อกลุ่ม ลูกค้าชอบ Concept",      createdAt: daysFromNow(-3) },
      { dealId: ids.deal23, createdById: ids.rep,  note: "ลูกค้าขอเพิ่มฉากกั้น 120 ซม. กำลังปรับแบบและราคาใหม่ คาดส่งภายใน 2 วัน",                   createdAt: daysFromNow(-2) },
      { dealId: ids.deal03, createdById: ids.rep,  note: "นำ Sample Board สีใหม่ 5 แบบไปให้ดู ลูกค้าสนใจ Ash Grey และ Walnut Brown ขอรอ Revised Price",  createdAt: daysFromNow(0)  },
      { dealId: ids.deal25, createdById: ids.rep,  note: "คุณกิตติพงษ์ขอต่อรองราคาลง 7% กำลังหารือภายในทีมว่าจะ Approve ได้ไหม คาดตอบได้พรุ่งนี้",   createdAt: daysFromNow(-3) }
    ]
  });

  // ── Visits ─────────────────────────────────────────────────────────────
  await prisma.visit.createMany({
    data: [
      {
        id: ids.visit01, tenantId: ids.tenant, repId: ids.rep, customerId: ids.custAcme, dealId: ids.deal01,
        visitNo: "V-000001",
        visitType: VisitType.PLANNED, status: VisitStatus.CHECKED_OUT,
        plannedAt: daysFromNow(-12), checkInAt: daysFromNow(-12), checkOutAt: daysFromNow(-12),
        checkInLat: 13.7563, checkInLng: 100.5679,
        objective: "สำรวจพื้นที่และวัดขนาดชั้น 12–15 เพื่อวางผัง Workstation",
        result: "วัดพื้นที่ได้ 1,800 ตร.ม. ชั้นละ 450 ตร.ม. ลูกค้าต้องการ Open Plan 150 ที่นั่ง ขอเพิ่มห้องประชุมย่อย 4 ห้อง และโซนพักผ่อน 1 โซน"
      },
      {
        id: ids.visit02, tenantId: ids.tenant, repId: ids.rep, customerId: ids.custSiamTech, dealId: ids.deal02,
        visitNo: "V-000002",
        visitType: VisitType.PLANNED, status: VisitStatus.CHECKED_OUT,
        plannedAt: daysFromNow(-19), checkInAt: daysFromNow(-19), checkOutAt: daysFromNow(-19),
        checkInLat: 13.7274, checkInLng: 100.5175,
        objective: "ประชุมกับทีมอาคารเพื่อกำหนดสเปคโต๊ะประชุม Board Room",
        result: "ห้อง Board Room ขนาด 12x8m ต้องการโต๊ะ 3m ลายไม้ European Oak นั่งได้ 12 คน พร้อมตู้ข้างผนัง ส่งใบเสนอราคาได้ทันที"
      },
      {
        id: ids.visit03, tenantId: ids.tenant, repId: ids.rep2, customerId: ids.custBKKFood, dealId: ids.deal08,
        visitNo: "V-000003",
        visitType: VisitType.PLANNED, status: VisitStatus.CHECKED_OUT,
        plannedAt: daysFromNow(-20), checkInAt: daysFromNow(-20), checkOutAt: daysFromNow(-20),
        checkInLat: 13.7200, checkInLng: 100.5250,
        objective: "สำรวจสำนักงานใหญ่ 3 ชั้นเพื่อวางแผนรีโนเวท",
        result: "ตรวจสอบแล้ว ชั้น 4–6 รวม 3,200 ตร.ม. โครงสร้างเดิมดีพอ ต้องเปลี่ยนเฟอร์นิเจอร์ทั้งหมด ลูกค้าต้องการระยะเวลาดำเนินการไม่เกิน 90 วัน"
      },
      {
        id: ids.visit04, tenantId: ids.tenant, repId: ids.rep2, customerId: ids.custThaiSteel, dealId: ids.deal09,
        visitNo: "V-000004",
        visitType: VisitType.PLANNED, status: VisitStatus.CHECKED_OUT,
        plannedAt: daysFromNow(-15), checkInAt: daysFromNow(-15), checkOutAt: daysFromNow(-15),
        checkInLat: 12.7018, checkInLng: 101.1401,
        objective: "สำรวจและวัดพื้นที่ติดตั้งผนังกั้นห้อง Modular ชั้น 4–6",
        result: "วัดแนวผนังรวม 280 เมตร ชั้น 4 ต้องการระบบกระจกบานเลื่อน ชั้น 5–6 ผนังทึบ กำหนดส่งแบบ Shop Drawing ภายใน 2 สัปดาห์"
      },
      {
        id: ids.visit05, tenantId: ids.tenant, repId: ids.rep3, customerId: ids.custCentral, dealId: ids.deal14,
        visitNo: "V-000005",
        visitType: VisitType.PLANNED, status: VisitStatus.CHECKED_OUT,
        plannedAt: daysFromNow(-25), checkInAt: daysFromNow(-25), checkOutAt: daysFromNow(-25),
        checkInLat: 13.7466, checkInLng: 100.5393,
        objective: "นำเสนอ Concept Design ต่อคณะกรรมการโครงการ Tower B",
        result: "นำเสนอ 3 Concept ต่อกรรมการ 9 คน CFO ชอบ Concept B (Modular ขยายได้) ประหยัดพื้นที่ 18% อนุมัติให้จัดทำ Detailed Design ต่อ"
      },
      {
        id: ids.visit06, tenantId: ids.tenant, repId: ids.rep3, customerId: ids.custOmega, dealId: ids.deal19,
        visitNo: "V-000006",
        visitType: VisitType.PLANNED, status: VisitStatus.CHECKED_OUT,
        plannedAt: daysFromNow(-35), checkInAt: daysFromNow(-35), checkOutAt: daysFromNow(-35),
        checkInLat: 13.7200, checkInLng: 100.5300,
        objective: "ประชุม Kickoff และสำรวจอาคาร 8 ชั้นเพื่อวางแผน Mega Project",
        result: "ทำ Workshop เต็มวัน กำหนด Theme 3 แบบ ลูกค้าชอบแนวทาง Biophilic + Minimal เริ่ม Mock-up 1 ห้องที่ชั้น 3 ก่อนอนุมัติทั้งโครงการ"
      },
      {
        id: ids.visit07, tenantId: ids.tenant, repId: ids.rep, customerId: ids.custAcme, dealId: ids.deal03,
        visitNo: "V-000007",
        visitType: VisitType.UNPLANNED, status: VisitStatus.CHECKED_IN,
        plannedAt: daysFromNow(0), checkInAt: daysFromNow(0),
        checkInLat: 13.7563, checkInLng: 100.5679,
        checkInSelfie: "r2://tenant_demo/selfies/checkin-demo.jpg",
        objective: "ติดตามการต่อรองราคาและนำเสนอตัวอย่าง Sample Board สีใหม่"
      },
      {
        id: ids.visit08, tenantId: ids.tenant, repId: ids.rep2, customerId: ids.custBKKFood, dealId: ids.deal08,
        visitNo: "V-000008",
        visitType: VisitType.PLANNED, status: VisitStatus.PLANNED,
        plannedAt: daysFromNow(1),
        objective: "นำเสนอข้อเสนอแบบแบ่งเฟสและเงื่อนไขการชำระเงินขั้นสุดท้าย"
      },
      // ── Somchai extra visits ──────────────────────────────────────────────
      {
        id: ids.visit09, tenantId: ids.tenant, repId: ids.rep, customerId: ids.custViva, dealId: ids.deal06,
        visitNo: "V-000009",
        visitType: VisitType.PLANNED, status: VisitStatus.CHECKED_OUT,
        plannedAt: daysFromNow(-9), checkInAt: daysFromNow(-9), checkOutAt: daysFromNow(-9),
        checkInLat: 13.7700, checkInLng: 100.5600,
        objective: "นำเสนอตัวอย่างชุดรับแขก Lobby และสีผ้าตกแต่ง",
        result: "ลูกค้าชอบผ้า Velvet สีน้ำเงินเข้ม กำลังรออนุมัติงบประมาณจากคณะกรรมการบริษัท คาดว่าได้คำตอบภายใน 2 สัปดาห์"
      },
      {
        id: ids.visit10, tenantId: ids.tenant, repId: ids.rep, customerId: ids.custNorth, dealId: ids.deal07,
        visitNo: "V-000010",
        visitType: VisitType.PLANNED, status: VisitStatus.CHECKED_OUT,
        plannedAt: daysFromNow(-16), checkInAt: daysFromNow(-16), checkOutAt: daysFromNow(-16),
        checkInLat: 18.8004, checkInLng: 98.9600,
        objective: "ประชุมเพื่อวัดขนาดห้องและกำหนด Layout โต๊ะทำงานและตู้เก็บเอกสาร",
        result: "พื้นที่สำนักงาน 320 ตร.ม. ต้องการโต๊ะ Kadeem 18 ตัว เก้าอี้ Mesh 18 ตัว และตู้เอกสาร 2 บาน 10 ใบ ลูกค้าชอบ Layout แบบ L-shape"
      },
      {
        id: ids.visit11, tenantId: ids.tenant, repId: ids.rep, customerId: ids.custSiamTech, dealId: ids.deal25,
        visitNo: "V-000011",
        visitType: VisitType.PLANNED, status: VisitStatus.CHECKED_OUT,
        plannedAt: daysFromNow(-10), checkInAt: daysFromNow(-10), checkOutAt: daysFromNow(-10),
        checkInLat: 13.7274, checkInLng: 100.5175,
        objective: "สำรวจสภาพเก้าอี้และโต๊ะเดิมชั้น 10 เพื่อประเมินของที่จะเปลี่ยน",
        result: "ตรวจสอบแล้ว โต๊ะ 45 ตัวและเก้าอี้ 80 ตัวต้องเปลี่ยนทั้งหมด เฟอร์นิเจอร์เก่าอายุกว่า 8 ปีสภาพไม่ดี ส่งใบเสนอราคาเบื้องต้นแล้ว"
      },
      {
        id: ids.visit12, tenantId: ids.tenant, repId: ids.rep, customerId: ids.custGolden,
        visitNo: "V-000012",
        visitType: VisitType.UNPLANNED, status: VisitStatus.CHECKED_OUT,
        plannedAt: daysFromNow(-6), checkInAt: daysFromNow(-6), checkOutAt: daysFromNow(-6),
        checkInLat: 13.7520, checkInLng: 100.5580,
        objective: "แวะเยี่ยมเยียนและอัพเดทโครงการที่กำลังจะเปิดตัวใหม่",
        result: "คุยกับคุณบุญรอด พบว่ามีโครงการ Phase 2 กำลังจะเริ่ม ต้องการเฟอร์นิเจอร์สำนักงานไซต์งานชั่วคราว 20 ชุด จะส่ง Quotation ภายในสัปดาห์นี้"
      },
      {
        id: ids.visit13, tenantId: ids.tenant, repId: ids.rep, customerId: ids.custAcme, dealId: ids.deal23,
        visitNo: "V-000013",
        visitType: VisitType.PLANNED, status: VisitStatus.CHECKED_OUT,
        plannedAt: daysFromNow(-3), checkInAt: daysFromNow(-3), checkOutAt: daysFromNow(-3),
        checkInLat: 13.7563, checkInLng: 100.5679,
        objective: "วัดพื้นที่แผนกใหม่และนำเสนอ Layout โต๊ะทำงาน Acker",
        result: "แผนกใหม่ชั้น 11 ขนาด 250 ตร.ม. ต้องการ Workstation 20 ชุดในแบบ Cluster 4 คน ลูกค้าขอเพิ่มฉากกั้นความสูง 120 ซม. ส่งแบบ Revised ใหม่ภายใน 3 วัน"
      },
      {
        id: ids.visit14, tenantId: ids.tenant, repId: ids.rep, customerId: ids.custAcme, dealId: ids.deal01,
        visitNo: "V-000014",
        visitType: VisitType.PLANNED, status: VisitStatus.PLANNED,
        plannedAt: daysFromNow(2),
        objective: "นำเสนอ Revised Layout ชั้น 12–15 หลังรับ Feedback จาก Design Team ลูกค้า"
      },
      {
        id: ids.visit15, tenantId: ids.tenant, repId: ids.rep, customerId: ids.custSiamTech, dealId: ids.deal02,
        visitNo: "V-000015",
        visitType: VisitType.PLANNED, status: VisitStatus.PLANNED,
        plannedAt: daysFromNow(5),
        objective: "นำเสนอตัวอย่าง Mock-up โต๊ะประชุม European Oak พร้อม Quotation ฉบับสมบูรณ์"
      },
      {
        id: ids.visit16, tenantId: ids.tenant, repId: ids.rep, customerId: ids.custViva, dealId: ids.deal06,
        visitNo: "V-000016",
        visitType: VisitType.PLANNED, status: VisitStatus.PLANNED,
        plannedAt: daysFromNow(8),
        objective: "ติดตามผลอนุมัติงบประมาณจากคณะกรรมการและปิดดีลชุดรับแขก Lobby"
      },
      // ── Somchai additional 10 visits ──────────────────────────────────────
      {
        id: ids.visit17, tenantId: ids.tenant, repId: ids.rep, customerId: ids.custMega, dealId: ids.deal10,
        visitNo: "V-000017",
        visitType: VisitType.PLANNED, status: VisitStatus.CHECKED_OUT,
        plannedAt: daysFromNow(-25), checkInAt: daysFromNow(-25), checkOutAt: daysFromNow(-25),
        checkInLat: 13.8100, checkInLng: 100.5450,
        objective: "นำเสนอโซลูชัน Workstation แบบ Modular สำหรับแผนกวิศวกรรม 40 คน",
        result: "ลูกค้าสนใจรุ่น Acker Flex สูงสุด ขอตัวอย่างวัสดุและเปรียบเทียบสี Warm Grey vs Charcoal จะตอบกลับภายใน 1 สัปดาห์"
      },
      {
        id: ids.visit18, tenantId: ids.tenant, repId: ids.rep, customerId: ids.custThaiSteel, dealId: ids.deal11,
        visitNo: "V-000018",
        visitType: VisitType.PLANNED, status: VisitStatus.CHECKED_OUT,
        plannedAt: daysFromNow(-22), checkInAt: daysFromNow(-22), checkOutAt: daysFromNow(-22),
        checkInLat: 13.6100, checkInLng: 100.8200,
        objective: "ประเมินความต้องการเฟอร์นิเจอร์โรงงานและห้องควบคุมผลิต",
        result: "ต้องการโต๊ะทำงานทนทานรุ่น Heavy-Duty 30 ตัว เก้าอี้ Anti-Static 30 ตัว และ Locker 60 ล็อก ลูกค้าขอ Delivery แบบแยก 2 งวด"
      },
      {
        id: ids.visit19, tenantId: ids.tenant, repId: ids.rep, customerId: ids.custEastAsia,
        visitNo: "V-000019",
        visitType: VisitType.UNPLANNED, status: VisitStatus.CHECKED_OUT,
        plannedAt: daysFromNow(-18), checkInAt: daysFromNow(-18), checkOutAt: daysFromNow(-18),
        checkInLat: 13.7350, checkInLng: 100.5950,
        objective: "แวะเยี่ยมเยียนหลังส่งมอบงานเฟส 1 เพื่อรับ Feedback",
        result: "ลูกค้าพอใจงานติดตั้งมาก ขอให้เสนอราคาเฟส 2 ห้องประชุมชั้น 7–9 รวม 6 ห้อง คาดงบประมาณ 1.2M–1.5M บาท"
      },
      {
        id: ids.visit20, tenantId: ids.tenant, repId: ids.rep, customerId: ids.custPremier, dealId: ids.deal12,
        visitNo: "V-000020",
        visitType: VisitType.PLANNED, status: VisitStatus.CHECKED_OUT,
        plannedAt: daysFromNow(-14), checkInAt: daysFromNow(-14), checkOutAt: daysFromNow(-14),
        checkInLat: 13.7160, checkInLng: 100.5330,
        objective: "นำเสนอ Quotation ฉบับแก้ไขหลังปรับ Spec เก้าอี้ Executive และโต๊ะ Conference",
        result: "ลูกค้าอนุมัติ Spec ใหม่แล้ว รอลายเซ็น PO จากกรรมการผู้จัดการ คาดได้ภายใน 3 วันทำการ"
      },
      {
        id: ids.visit21, tenantId: ids.tenant, repId: ids.rep, customerId: ids.custRajaPlas, dealId: ids.deal13,
        visitNo: "V-000021",
        visitType: VisitType.PLANNED, status: VisitStatus.CHECKED_OUT,
        plannedAt: daysFromNow(-11), checkInAt: daysFromNow(-11), checkOutAt: daysFromNow(-11),
        checkInLat: 14.0100, checkInLng: 100.6200,
        objective: "สำรวจพื้นที่คลังสินค้าและออฟฟิศในนิคมอุตสาหกรรมเพื่อวางแผนจัดวาง",
        result: "ออฟฟิศ 180 ตร.ม. ต้องการ Workstation 15 ชุด ห้องประชุม 1 ห้อง และ Break Area ลูกค้าต้องการ Delivery ก่อนเปิดไลน์ผลิตวันที่ 1 มิถุนายน"
      },
      {
        id: ids.visit22, tenantId: ids.tenant, repId: ids.rep, customerId: ids.custCentral, dealId: ids.deal14,
        visitNo: "V-000022",
        visitType: VisitType.PLANNED, status: VisitStatus.CHECKED_OUT,
        plannedAt: daysFromNow(-7), checkInAt: daysFromNow(-7), checkOutAt: daysFromNow(-7),
        checkInLat: 13.7480, checkInLng: 100.5350,
        objective: "ติดตาม PO และหารือเรื่องตารางติดตั้งเฟอร์นิเจอร์สำนักงานกลาง",
        result: "ได้รับ PO เรียบร้อย มูลค่า 2.3M บาท นัดติดตั้งวันที่ 20–25 พ.ค. ประสานงานกับทีม Logistics แล้ว"
      },
      {
        id: ids.visit23, tenantId: ids.tenant, repId: ids.rep, customerId: ids.custOmega,
        visitNo: "V-000023",
        visitType: VisitType.UNPLANNED, status: VisitStatus.CHECKED_OUT,
        plannedAt: daysFromNow(-4), checkInAt: daysFromNow(-4), checkOutAt: daysFromNow(-4),
        checkInLat: 13.7600, checkInLng: 100.6000,
        objective: "ติดตามการแก้ไขเก้าอี้ที่มีปัญหาหลังติดตั้ง",
        result: "ตรวจสอบ 5 ตัวที่ลูกค้าแจ้ง พบกลไกปรับความสูงชำรุด 2 ตัว ประสานทีมช่างเข้าเปลี่ยนภายใน 3 วัน ลูกค้าพอใจการดูแลหลังการขาย"
      },
      {
        id: ids.visit24, tenantId: ids.tenant, repId: ids.rep, customerId: ids.custAmarin, dealId: ids.deal15,
        visitNo: "V-000024",
        visitType: VisitType.PLANNED, status: VisitStatus.PLANNED,
        plannedAt: daysFromNow(3),
        objective: "นำเสนอ Concept Design ห้องสมุดและพื้นที่อ่านหนังสือโรงแรมบูติก"
      },
      {
        id: ids.visit25, tenantId: ids.tenant, repId: ids.rep, customerId: ids.custBKKFood, dealId: ids.deal16,
        visitNo: "V-000025",
        visitType: VisitType.PLANNED, status: VisitStatus.PLANNED,
        plannedAt: daysFromNow(6),
        objective: "หารือ Spec โต๊ะ Canteen และเก้าอี้กันน้ำ 120 ชุดสำหรับโรงอาหารพนักงาน"
      },
      {
        id: ids.visit26, tenantId: ids.tenant, repId: ids.rep, customerId: ids.custMega, dealId: ids.deal10,
        visitNo: "V-000026",
        visitType: VisitType.PLANNED, status: VisitStatus.PLANNED,
        plannedAt: daysFromNow(10),
        objective: "นำตัวอย่าง Workstation Modular ไปให้ทีมวิศวกรทดลองใช้ก่อนตัดสินใจ"
      }
    ]
  });

  // ── KPI Targets ────────────────────────────────────────────────────────
  await prisma.salesKpiTarget.createMany({
    data: [
      { tenantId: ids.tenant, userId: ids.rep,  targetMonth: "2026-04", visitTargetCount: 40, newDealValueTarget: 2000000, revenueTarget: 1500000 },
      { tenantId: ids.tenant, userId: ids.rep2, targetMonth: "2026-04", visitTargetCount: 35, newDealValueTarget: 3000000, revenueTarget: 2500000 },
      { tenantId: ids.tenant, userId: ids.rep3, targetMonth: "2026-04", visitTargetCount: 30, newDealValueTarget: 5000000, revenueTarget: 4000000 }
    ]
  });

  // ── Integration ────────────────────────────────────────────────────────
  await prisma.integrationSource.create({
    data: {
      id: ids.source, tenantId: ids.tenant, sourceName: "ERP REST Connector",
      sourceType: "REST", status: "ENABLED",
      configJson: { baseUrl: "https://legacy.example/api", authType: "api_key" },
      mappings: {
        create: [
          { entityType: "CUSTOMER", sourceField: "customer_code", targetField: "customerCode", isRequired: true },
          { entityType: "ITEM",     sourceField: "item_code",     targetField: "itemCode",     isRequired: true }
        ]
      }
    }
  });

  await prisma.integrationExecutionLog.create({
    data: {
      tenantId: ids.tenant, executedById: ids.admin, platform: "GENERIC",
      operationType: "SEED_SETUP", direction: "INBOUND", triggerType: "MANUAL",
      status: "SUCCESS", responseSummary: "Demo seed log entry",
      payloadMasked: { note: "PII-safe payload snapshot" }, completedAt: new Date()
    }
  });

  // Integration credentials are not seeded — configure real keys via Settings → Integrations.

  // ── AI Analysis ────────────────────────────────────────────────────────
  const aiRun = await prisma.aiAnalysisRun.create({
    data: { tenantId: ids.tenant, requestedBy: ids.manager, status: JobStatus.SUCCESS, completedAt: new Date() }
  });

  await prisma.aiAnalysisFinding.createMany({
    data: [
      { runId: aiRun.id, findingType: "pattern", title: "นัดหมายช่วงบ่ายเป็นหลัก",          description: "คุณสมชายนัดหมายลูกค้าหลังเที่ยง 88% ของทุกการเยี่ยม อาจพลาดลูกค้าที่ต้องการนัดช่วงเช้า",   confidenceScore: 0.81, evidenceJson: { windowDays: 30, afterNoonPercent: 88 } },
      { runId: aiRun.id, findingType: "risk",    title: "ดีลใหญ่ค้างไม่มีความเคลื่อนไหว",  description: "ดีล DL-2026-0019 (฿6.8M) ไม่มีการอัปเดตมาแล้วกว่า 14 วัน ควรติดตามด่วน",                  confidenceScore: 0.91, evidenceJson: { dealId: ids.deal19, daysSinceUpdate: 14 } },
      { runId: aiRun.id, findingType: "insight", title: "Pimchanok — Win Rate สูงสุดไตรมาส 1", description: "คุณพิมพ์ชนกปิดดีลได้ 2 จาก 5 ดีลในไตรมาส 1 (40%) สูงกว่าค่าเฉลี่ยทีม 28% โดยเน้นลูกค้า Segment Enterprise", confidenceScore: 0.88, evidenceJson: { repId: ids.rep3, winRate: 0.40, teamAvg: 0.28 } }
    ]
  });

  // ── Voice Note ─────────────────────────────────────────────────────────
  const voiceJob = await prisma.voiceNoteJob.create({
    data: {
      tenantId: ids.tenant, entityType: "VISIT", entityId: ids.visit01,
      audioObjectKey: "r2://tenant_demo/voice/visit-note-001.m4a",
      status: JobStatus.SUCCESS, requestedById: ids.rep, completedAt: new Date()
    }
  });

  await prisma.voiceNoteTranscript.create({
    data: {
      jobId: voiceJob.id,
      transcriptText: "ลูกค้ายืนยันต้องการ Workstation 150 ที่นั่ง แบบ Open Plan คุณประภาสบอกว่างบประมาณผ่านแล้ว ขอ Mockup 1 Zone ก่อนอนุมัติทั้งโปรเจกต์ กำหนดส่งใบเสนอราคาภายในอาทิตย์หน้า",
      summaryText: "ยืนยัน 150 ที่นั่ง Open Plan งบผ่านแล้ว ขอ Mockup 1 Zone ส่งใบเสนอราคาภายในอาทิตย์หน้า",
      confidenceScore: 0.93
    }
  });
}

async function main() {
  await resetData();
  await seedData();

  console.log("─────────────────────────────────────────");
  console.log("Seed completed.");
  console.log("Tenant slug : thinkcrm-demo");
  console.log("Password    : ThinkCRM123!");
  console.log("");
  console.log("Users:");
  console.log("  admin@thinkcrm.demo       (ADMIN)");
  console.log("  manager@thinkcrm.demo     (MANAGER)");
  console.log("  supervisor@thinkcrm.demo  (SUPERVISOR)");
  console.log("  rep@thinkcrm.demo         (REP)");
  console.log("  rep2@thinkcrm.demo        (REP)");
  console.log("  rep3@thinkcrm.demo        (REP)");
  console.log("");
  console.log("Data: 15 customers · 35 deals · 26 visits · 7 items · 4 payment terms");
  console.log("─────────────────────────────────────────");
}

main()
  .catch((error) => { console.error(error); process.exit(1); })
  .finally(() => prisma.$disconnect());
