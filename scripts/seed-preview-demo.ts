/**
 * Seed demo data (Thai) for a specific user in the PREVIEW database.
 *
 * Usage:
 *   set -a && source /tmp/preview.env && set +a && \
 *     npx tsx scripts/seed-preview-demo.ts <email>
 *
 * Safety guards:
 * - Refuses to run if DATABASE_URL host looks like production (ep-fragrant-math).
 * - All rows are tagged isDemo=true where the column exists.
 * - User must exist — we never create the target user.
 */
import { PrismaClient, CustomerType, VisitType, VisitStatus, DealStatus } from "@prisma/client";

const prisma = new PrismaClient();

const PROD_HOST_HINT = "ep-fragrant-math";
const EMAIL = (process.argv[2] || "nichanat.c@workstationoffice.com").toLowerCase();

const TARGETS = { customers: 50, deals: 15, visits: 30 };

const THAI_COMPANY_PREFIXES = ["บริษัท", "บริษัท", "หจก.", "บริษัท"];
const THAI_COMPANY_ROOTS = [
  "ไทยพัฒนา", "กรุงเทพมหานคร", "สยามทรัพย์", "เอเชียก้าวหน้า", "ศรีอยุธยา",
  "รุ่งเรืองกิจ", "เจริญพาณิชย์", "ไทยรุ่งอุตสาหกรรม", "สุขสมบัติ", "บูรพาเทค",
  "ภาคเหนือการค้า", "แสงอรุณ", "ชัยพัฒน์", "ไพบูลย์การเกษตร", "วัฒนาพงษ์",
  "จิรพัฒน์", "ธารน้ำใจ", "ทรัพย์สมบูรณ์", "อินเตอร์เนชั่นแนล", "พลังงานไทย",
  "เกษตรก้าวหน้า", "นครสวรรค์", "ภูเก็ตมารีน", "อีสานพัฒนา", "ล้านนาอุตสาหกรรม",
  "สยามเทคโนโลยี", "กรุงศรี", "ตะวันออกแลนด์", "รัชดาพลาซ่า", "สีลมโฮลดิ้ง",
];
const THAI_COMPANY_SUFFIXES = ["จำกัด", "(มหาชน) จำกัด", "จำกัด", "กรุ๊ป จำกัด", "เทรดดิ้ง จำกัด"];

const THAI_PROVINCES = [
  "กรุงเทพมหานคร", "เชียงใหม่", "ชลบุรี", "นนทบุรี", "ภูเก็ต",
  "ปทุมธานี", "นครราชสีมา", "ขอนแก่น", "สงขลา", "ระยอง",
];

const THAI_DEAL_TOPICS = [
  "ขยายโรงงานผลิตสาขาใหม่", "ปรับปรุงระบบ ERP", "ติดตั้งระบบโซลาร์รูฟท็อป",
  "สั่งซื้อเครื่องจักรรุ่นใหม่", "สัญญาบริการรายปี", "โครงการ Digital Transformation",
  "ออกแบบระบบคลังสินค้าอัตโนมัติ", "จัดซื้ออุปกรณ์สำนักงาน", "ติดตั้งกล้อง CCTV",
  "อัปเกรดระบบเครือข่าย", "โครงการฝึกอบรมพนักงาน", "บริการที่ปรึกษาภาษี",
  "จ้างผลิตบรรจุภัณฑ์", "ขยายสาขาร้านอาหาร", "ปรับปรุงระบบบัญชี",
];

const THAI_VISIT_OBJECTIVES = [
  "นำเสนอสินค้าใหม่", "ติดตามใบเสนอราคา", "สำรวจหน้างาน",
  "พูดคุยกับฝ่ายจัดซื้อ", "ดูโรงงานและสายการผลิต", "ส่งมอบสัญญา",
  "หารือสเปคเบื้องต้น", "ปิดการขาย", "แก้ปัญหาหลังการขาย",
  "รับฟีดแบ็กลูกค้า", "ตรวจสอบพื้นที่ติดตั้ง", "อบรมการใช้งานผลิตภัณฑ์",
];

function pick<T>(arr: T[]): T { return arr[Math.floor(Math.random() * arr.length)]; }
function randInt(min: number, max: number): number { return Math.floor(Math.random() * (max - min + 1)) + min; }

function thaiCompanyName(): string {
  return `${pick(THAI_COMPANY_PREFIXES)} ${pick(THAI_COMPANY_ROOTS)} ${pick(THAI_COMPANY_SUFFIXES)}`;
}
function thaiTaxId(): string {
  // 13 digits
  let s = "";
  for (let i = 0; i < 13; i++) s += Math.floor(Math.random() * 10);
  return s;
}
function siteCoordsBangkokArea(): { lat: number; lng: number } {
  return { lat: 13.7 + (Math.random() - 0.5) * 1.2, lng: 100.5 + (Math.random() - 0.5) * 1.2 };
}
function daysFromNow(days: number): Date { return new Date(Date.now() + days * 86400 * 1000); }

async function main() {
  const url = process.env.DATABASE_URL || "";
  if (url.includes(PROD_HOST_HINT)) {
    throw new Error(`Refusing to seed — DATABASE_URL points at production (${PROD_HOST_HINT}).`);
  }
  console.log(`DB host: ${url.split("@")[1]?.split("/")[0] || "?"}`);

  const user = await prisma.user.findFirst({
    where: { email: EMAIL },
    select: { id: true, tenantId: true, fullName: true }
  });
  if (!user) throw new Error(`User not found: ${EMAIL}`);
  const { id: userId, tenantId } = user;
  console.log(`User: ${user.fullName} (${userId}) · tenant ${tenantId}`);

  // Default payment term — create one if none exists.
  let term = await prisma.paymentTerm.findFirst({ where: { tenantId, isActive: true }, orderBy: { createdAt: "asc" } });
  if (!term) {
    term = await prisma.paymentTerm.create({ data: { tenantId, code: "NET30", name: "เครดิต 30 วัน", dueDays: 30 } });
    console.log(`Created payment term ${term.code}`);
  }

  // Default deal stage — prefer the one marked isDefault.
  let stage = await prisma.dealStage.findFirst({ where: { tenantId, isDefault: true } })
         || await prisma.dealStage.findFirst({ where: { tenantId }, orderBy: { stageOrder: "asc" } });
  if (!stage) {
    stage = await prisma.dealStage.create({
      data: { tenantId, stageName: "ใหม่", stageOrder: 1, isDefault: true }
    });
    console.log(`Created deal stage ${stage.stageName}`);
  }

  // Counter for codes — find current max so we don't collide with existing.
  const existingCust = await prisma.customer.count({ where: { tenantId } });
  const existingDeal = await prisma.deal.count({ where: { tenantId } });
  const existingVisit = await prisma.visit.count({ where: { tenantId } });

  // ── Customers ───────────────────────────────────────────────────────────
  const customerIds: string[] = [];
  for (let i = 0; i < TARGETS.customers; i++) {
    const n = existingCust + i + 1;
    const code = `CUST-DEMO-${String(n).padStart(4, "0")}`;
    const { lat, lng } = siteCoordsBangkokArea();
    const row = await prisma.customer.create({
      data: {
        tenantId,
        customerCode: code,
        name: thaiCompanyName(),
        customerType: CustomerType.COMPANY,
        taxId: thaiTaxId(),
        defaultTermId: term.id,
        ownerId: userId,
        createdByUserId: userId,
        siteLat: lat,
        siteLng: lng,
        isDemo: true,
        addresses: {
          create: {
            addressLine1: `${randInt(1, 999)}/${randInt(1, 99)} ถนน${pick(["พระราม 9", "สุขุมวิท", "รัชดาภิเษก", "พหลโยธิน", "วิภาวดี"])}`,
            district: pick(["ห้วยขวาง", "บางนา", "วัฒนา", "จตุจักร", "บางรัก"]),
            province: pick(THAI_PROVINCES),
            postalCode: String(10000 + randInt(0, 900)),
            country: "ไทย",
            isDefaultBilling: true,
            isDefaultShipping: true,
          }
        }
      }
    });
    customerIds.push(row.id);
  }
  console.log(`Customers created: ${customerIds.length}`);

  // ── Deals ───────────────────────────────────────────────────────────────
  const dealIds: string[] = [];
  for (let i = 0; i < TARGETS.deals; i++) {
    const n = existingDeal + i + 1;
    const custId = pick(customerIds);
    const row = await prisma.deal.create({
      data: {
        tenantId,
        ownerId: userId,
        createdByUserId: userId,
        dealNo: `D-DEMO-${String(n).padStart(5, "0")}`,
        dealName: pick(THAI_DEAL_TOPICS),
        customerId: custId,
        stageId: stage.id,
        estimatedValue: randInt(50_000, 3_000_000),
        followUpAt: daysFromNow(randInt(1, 45)),
        status: DealStatus.OPEN,
        isDemo: true,
      }
    });
    dealIds.push(row.id);
  }
  console.log(`Deals created: ${dealIds.length}`);

  // ── Visits ──────────────────────────────────────────────────────────────
  let visitCount = 0;
  for (let i = 0; i < TARGETS.visits; i++) {
    const n = existingVisit + i + 1;
    const custId = pick(customerIds);
    const linkDeal = Math.random() < 0.6;
    const pastOrFuture = Math.random() < 0.5; // half already happened
    const plannedAt = pastOrFuture ? daysFromNow(-randInt(1, 30)) : daysFromNow(randInt(1, 30));
    const { lat, lng } = siteCoordsBangkokArea();
    await prisma.visit.create({
      data: {
        tenantId,
        repId: userId,
        createdByUserId: userId,
        customerId: custId,
        dealId: linkDeal ? pick(dealIds) : null,
        visitNo: `V-DEMO-${String(n).padStart(5, "0")}`,
        visitType: pick([VisitType.PLANNED, VisitType.UNPLANNED]),
        status: pastOrFuture
          ? pick([VisitStatus.CHECKED_IN, VisitStatus.CHECKED_OUT])
          : VisitStatus.PLANNED,
        plannedAt,
        objective: pick(THAI_VISIT_OBJECTIVES),
        siteLat: lat,
        siteLng: lng,
        checkInAt: pastOrFuture ? plannedAt : null,
        checkInLat: pastOrFuture ? lat : null,
        checkInLng: pastOrFuture ? lng : null,
        isDemo: true,
      }
    });
    visitCount++;
  }
  console.log(`Visits created: ${visitCount}`);

  console.log("Done.");
}

main().catch((e) => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());
