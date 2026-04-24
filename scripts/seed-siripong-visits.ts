import { PrismaClient, VisitType, VisitStatus, CustomerType } from "@prisma/client";

const prisma = new PrismaClient();

const TENANT_ID = "cmo5z81tk000ajpveft545flj";
const REP_ID = "cmo5z81uq000cjpvegivzsbji";
const EMAIL = "siripong.t@workstationoffice.com";

const daysFromNow = (d: number) => new Date(Date.now() + d * 24 * 60 * 60 * 1000);

async function main() {
  const user = await prisma.user.findUnique({ where: { id: REP_ID } });
  if (!user || user.email !== EMAIL) throw new Error("User mismatch");

  const term = await prisma.paymentTerm.findFirst({ where: { tenantId: TENANT_ID } });
  if (!term) throw new Error("No PaymentTerm for tenant");

  const customersSpec = [
    { code: "C-DEMO-001", name: "Acme Corporation",    lat: 13.7563, lng: 100.5679 },
    { code: "C-DEMO-002", name: "Siam Tech Co., Ltd.", lat: 13.7274, lng: 100.5175 },
    { code: "C-DEMO-003", name: "Bangkok Food Group",  lat: 13.7200, lng: 100.5250 },
    { code: "C-DEMO-004", name: "Central Plaza Ltd.",  lat: 13.7466, lng: 100.5393 }
  ];

  const customers = [] as { id: string; lat: number; lng: number; name: string }[];
  for (const c of customersSpec) {
    const existing = await prisma.customer.findUnique({
      where: { tenantId_customerCode: { tenantId: TENANT_ID, customerCode: c.code } }
    });
    const row = existing ?? await prisma.customer.create({
      data: {
        tenantId: TENANT_ID,
        ownerId: REP_ID,
        createdByUserId: REP_ID,
        customerCode: c.code,
        name: c.name,
        customerType: CustomerType.COMPANY,
        defaultTermId: term.id,
        siteLat: c.lat,
        siteLng: c.lng
      }
    });
    customers.push({ id: row.id, lat: c.lat, lng: c.lng, name: c.name });
  }

  const existingCount = await prisma.visit.count({ where: { tenantId: TENANT_ID } });
  const startNo = existingCount + 1;
  const pad = (n: number) => `V-${String(n).padStart(6, "0")}`;

  const visits = [
    { off: -18, type: VisitType.PLANNED,   status: VisitStatus.CHECKED_OUT, cust: 0, obj: "สำรวจพื้นที่และวัดขนาดชั้น 12–15 เพื่อวางผัง Workstation", res: "วัดพื้นที่ได้ 1,800 ตร.ม. ลูกค้าต้องการ Open Plan 150 ที่นั่ง" },
    { off: -15, type: VisitType.PLANNED,   status: VisitStatus.CHECKED_OUT, cust: 1, obj: "ประชุมกำหนดสเปคโต๊ะประชุม Board Room", res: "ห้องขนาด 12x8m โต๊ะลาย European Oak 12 ที่นั่ง ส่ง Quotation ได้" },
    { off: -12, type: VisitType.PLANNED,   status: VisitStatus.CHECKED_OUT, cust: 2, obj: "สำรวจสำนักงานใหญ่ 3 ชั้นเพื่อวางแผนรีโนเวท", res: "ชั้น 4–6 รวม 3,200 ตร.ม. ต้องเปลี่ยนเฟอร์นิเจอร์ทั้งหมด ไม่เกิน 90 วัน" },
    { off: -10, type: VisitType.PLANNED,   status: VisitStatus.CHECKED_OUT, cust: 3, obj: "นำเสนอ Concept Design ต่อคณะกรรมการโครงการ Tower B", res: "คณะกรรมการอนุมัติ Concept B ให้จัดทำ Detailed Design ต่อ" },
    { off: -7,  type: VisitType.UNPLANNED, status: VisitStatus.CHECKED_OUT, cust: 0, obj: "แวะนำเสนอ Sample Board สีใหม่", res: "ลูกค้าชอบ Warm Grey ขอส่งตัวอย่างเพิ่มเติม 3 สี" },
    { off: -5,  type: VisitType.PLANNED,   status: VisitStatus.CHECKED_OUT, cust: 1, obj: "วัดพื้นที่ชั้น 10 เพื่อเปลี่ยนโต๊ะและเก้าอี้", res: "โต๊ะ 45 ตัว เก้าอี้ 80 ตัวต้องเปลี่ยนทั้งหมด ส่งใบเสนอราคาเบื้องต้นแล้ว" },
    { off: -3,  type: VisitType.PLANNED,   status: VisitStatus.CHECKED_OUT, cust: 2, obj: "หารือ Spec โต๊ะ Canteen 120 ชุด", res: "ลูกค้าต้องการเก้าอี้กันน้ำ Spec HPL ขอตัวอย่าง 2 สีภายในสัปดาห์นี้" },
    { off: -1,  type: VisitType.UNPLANNED, status: VisitStatus.CHECKED_IN,  cust: 3, obj: "ติดตามสถานะ PO และตารางติดตั้ง", res: null },
    { off: 2,   type: VisitType.PLANNED,   status: VisitStatus.PLANNED,     cust: 0, obj: "นำเสนอ Revised Layout ชั้น 12–15 หลังรับ Feedback", res: null },
    { off: 5,   type: VisitType.PLANNED,   status: VisitStatus.PLANNED,     cust: 1, obj: "นำเสนอ Mock-up โต๊ะประชุม European Oak พร้อม Quotation ฉบับสมบูรณ์", res: null }
  ];

  const created = await prisma.$transaction(
    visits.map((v, i) => {
      const cust = customers[v.cust];
      const planned = daysFromNow(v.off);
      const isCheckedOut = v.status === VisitStatus.CHECKED_OUT;
      const isCheckedIn = v.status === VisitStatus.CHECKED_IN;
      return prisma.visit.create({
        data: {
          tenantId: TENANT_ID,
          repId: REP_ID,
          createdByUserId: REP_ID,
          customerId: cust.id,
          visitNo: pad(startNo + i),
          visitType: v.type,
          status: v.status,
          plannedAt: planned,
          objective: v.obj,
          result: v.res,
          checkInAt: (isCheckedOut || isCheckedIn) ? planned : null,
          checkInLat: (isCheckedOut || isCheckedIn) ? cust.lat : null,
          checkInLng: (isCheckedOut || isCheckedIn) ? cust.lng : null,
          checkOutAt: isCheckedOut ? new Date(planned.getTime() + 60 * 60 * 1000) : null,
          checkOutLat: isCheckedOut ? cust.lat : null,
          checkOutLng: isCheckedOut ? cust.lng : null
        }
      });
    })
  );

  console.log(`Seeded ${customers.length} customers and ${created.length} visits for ${EMAIL}`);
  console.log(`Visit numbers: ${created.map(c => c.visitNo).join(", ")}`);
}

main().finally(() => prisma.$disconnect());
