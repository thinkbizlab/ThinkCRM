import { DealStatus, PrismaClient } from "@prisma/client";
import { ids, daysFromNow } from "./shared.js";

export async function seedDeals(prisma: PrismaClient) {
  type DealInput = {
    id: string; tenantId: string; dealNo: string; dealName: string; customerId: string;
    ownerId: string; stageId: string; estimatedValue: number; status: DealStatus;
    followUpAt: Date; closedAt?: Date; createdAt: Date;
  };

  const deals: DealInput[] = [
    // rep — Opportunity / Quotation / Negotiation
    { id: ids.deal01, tenantId: ids.tenant, dealNo: "DL-2026-0001", dealName: "ตกแต่งสำนักงานใหม่ชั้น 12–15 (150 ที่นั่ง)",    customerId: ids.custAcme,     ownerId: ids.rep,  stageId: ids.stageOpportunity, estimatedValue: 980000,  status: DealStatus.OPEN, followUpAt: daysFromNow(3),   createdAt: daysFromNow(-14) },
    { id: ids.deal02, tenantId: ids.tenant, dealNo: "DL-2026-0002", dealName: "จัดซื้อโต๊ะประชุม Board Room และห้องย่อย",        customerId: ids.custSiamTech, ownerId: ids.rep,  stageId: ids.stageQuotation,   estimatedValue: 420000,  status: DealStatus.OPEN, followUpAt: daysFromNow(5),   createdAt: daysFromNow(-21) },
    { id: ids.deal03, tenantId: ids.tenant, dealNo: "DL-2026-0003", dealName: "เพิ่มพื้นที่ทำงานชั้น 9 โซน B",                  customerId: ids.custAcme,     ownerId: ids.rep,  stageId: ids.stageNegotiation, estimatedValue: 185000,  status: DealStatus.OPEN, followUpAt: daysFromNow(2),   createdAt: daysFromNow(-30) },
    { id: ids.deal04, tenantId: ids.tenant, dealNo: "DL-2026-0004", dealName: "ชุดเฟอร์นิเจอร์ผู้บริหาร สำนักงานใหม่สีลม",      customerId: ids.custSiamTech, ownerId: ids.rep,  stageId: ids.stageWon,         estimatedValue: 560000,  status: DealStatus.WON,  followUpAt: daysFromNow(-5),  closedAt: daysFromNow(-5),   createdAt: daysFromNow(-60) },
    { id: ids.deal05, tenantId: ids.tenant, dealNo: "DL-2026-0005", dealName: "เก้าอี้ Ergonomic ฝ่ายขาย 30 ตัว",               customerId: ids.custGolden,   ownerId: ids.rep,  stageId: ids.stageLost,        estimatedValue: 195000,  status: DealStatus.LOST, followUpAt: daysFromNow(-10), closedAt: daysFromNow(-10),  createdAt: daysFromNow(-45) },
    { id: ids.deal06, tenantId: ids.tenant, dealNo: "DL-2026-0006", dealName: "ชุดรับแขก Lobby และพื้นที่รอ",                    customerId: ids.custViva,     ownerId: ids.rep,  stageId: ids.stageOpportunity, estimatedValue: 130000,  status: DealStatus.OPEN, followUpAt: daysFromNow(7),   createdAt: daysFromNow(-8) },
    { id: ids.deal07, tenantId: ids.tenant, dealNo: "DL-2026-0007", dealName: "โต๊ะทำงานและตู้เก็บเอกสารแผนก Admin",            customerId: ids.custNorth,    ownerId: ids.rep,  stageId: ids.stageQuotation,   estimatedValue: 74000,   status: DealStatus.OPEN, followUpAt: daysFromNow(4),   createdAt: daysFromNow(-17) },
    // rep2
    { id: ids.deal08, tenantId: ids.tenant, dealNo: "DL-2026-0008", dealName: "รีโนเวทสำนักงานใหญ่ทั้งหลัง 3 ชั้น",              customerId: ids.custBKKFood,  ownerId: ids.rep2, stageId: ids.stageNegotiation, estimatedValue: 1850000, status: DealStatus.OPEN, followUpAt: daysFromNow(1),   createdAt: daysFromNow(-25) },
    { id: ids.deal09, tenantId: ids.tenant, dealNo: "DL-2026-0009", dealName: "ผนังกั้นห้องระบบ Modular ชั้น 4–6",               customerId: ids.custThaiSteel,ownerId: ids.rep2, stageId: ids.stageQuotation,   estimatedValue: 680000,  status: DealStatus.OPEN, followUpAt: daysFromNow(6),   createdAt: daysFromNow(-19) },
    { id: ids.deal10, tenantId: ids.tenant, dealNo: "DL-2026-0010", dealName: "เฟอร์นิเจอร์ห้องพักผ่อนพนักงาน",                 customerId: ids.custRajaPlas, ownerId: ids.rep2, stageId: ids.stageOpportunity, estimatedValue: 95000,   status: DealStatus.OPEN, followUpAt: daysFromNow(9),   createdAt: daysFromNow(-6) },
    { id: ids.deal11, tenantId: ids.tenant, dealNo: "DL-2026-0011", dealName: "โต๊ะทำงาน Acker ฝ่าย IT 20 ชุด",                  customerId: ids.custBKKFood,  ownerId: ids.rep2, stageId: ids.stageWon,         estimatedValue: 316000,  status: DealStatus.WON,  followUpAt: daysFromNow(-3),  closedAt: daysFromNow(-3),   createdAt: daysFromNow(-55) },
    { id: ids.deal12, tenantId: ids.tenant, dealNo: "DL-2026-0012", dealName: "ชุดเฟอร์นิเจอร์ห้องฝึกอบรม 2 ห้อง",              customerId: ids.custAmarin,   ownerId: ids.rep2, stageId: ids.stageNegotiation, estimatedValue: 210000,  status: DealStatus.OPEN, followUpAt: daysFromNow(2),   createdAt: daysFromNow(-28) },
    { id: ids.deal13, tenantId: ids.tenant, dealNo: "DL-2026-0013", dealName: "ตู้เก็บเอกสาร Steel จำนวนมาก",                    customerId: ids.custRajaPlas, ownerId: ids.rep2, stageId: ids.stageLost,        estimatedValue: 62400,   status: DealStatus.LOST, followUpAt: daysFromNow(-20), closedAt: daysFromNow(-20),  createdAt: daysFromNow(-50) },
    // rep3
    { id: ids.deal14, tenantId: ids.tenant, dealNo: "DL-2026-0014", dealName: "จัดเต็มทุกชั้น — Tower B 5 ชั้น 500 ที่นั่ง",     customerId: ids.custCentral,  ownerId: ids.rep3, stageId: ids.stageNegotiation, estimatedValue: 4200000, status: DealStatus.OPEN, followUpAt: daysFromNow(3),   createdAt: daysFromNow(-35) },
    { id: ids.deal15, tenantId: ids.tenant, dealNo: "DL-2026-0015", dealName: "เฟอร์นิเจอร์โซน Co-working ทั้งชั้น",             customerId: ids.custPremier,  ownerId: ids.rep3, stageId: ids.stageQuotation,   estimatedValue: 750000,  status: DealStatus.OPEN, followUpAt: daysFromNow(5),   createdAt: daysFromNow(-22) },
    { id: ids.deal16, tenantId: ids.tenant, dealNo: "DL-2026-0016", dealName: "โต๊ะผู้บริหาร Loft ชั้น 6 ทั้งชั้น",              customerId: ids.custEastAsia, ownerId: ids.rep3, stageId: ids.stageOpportunity, estimatedValue: 390000,  status: DealStatus.OPEN, followUpAt: daysFromNow(8),   createdAt: daysFromNow(-12) },
    { id: ids.deal17, tenantId: ids.tenant, dealNo: "DL-2026-0017", dealName: "ชุดเฟอร์นิเจอร์ Showroom สำนักงานใหม่",           customerId: ids.custSunrise,  ownerId: ids.rep3, stageId: ids.stageWon,         estimatedValue: 920000,  status: DealStatus.WON,  followUpAt: daysFromNow(-7),  closedAt: daysFromNow(-7),   createdAt: daysFromNow(-70) },
    { id: ids.deal18, tenantId: ids.tenant, dealNo: "DL-2026-0018", dealName: "เก้าอี้ Executive ห้องประชุมทั้งหมด 8 ห้อง",      customerId: ids.custCentral,  ownerId: ids.rep3, stageId: ids.stageWon,         estimatedValue: 475200,  status: DealStatus.WON,  followUpAt: daysFromNow(-15), closedAt: daysFromNow(-15),  createdAt: daysFromNow(-80) },
    { id: ids.deal19, tenantId: ids.tenant, dealNo: "DL-2026-0019", dealName: "Mega Project — สำนักงานใหม่ทั้งอาคาร 8 ชั้น",      customerId: ids.custOmega,    ownerId: ids.rep3, stageId: ids.stageNegotiation, estimatedValue: 6800000, status: DealStatus.OPEN, followUpAt: daysFromNow(4),   createdAt: daysFromNow(-40) },
    { id: ids.deal20, tenantId: ids.tenant, dealNo: "DL-2026-0020", dealName: "ผนังกั้นห้องชั้น 3 โซน Creative",                  customerId: ids.custMega,     ownerId: ids.rep3, stageId: ids.stageLost,        estimatedValue: 88000,   status: DealStatus.LOST, followUpAt: daysFromNow(-30), closedAt: daysFromNow(-30),  createdAt: daysFromNow(-65) },
    { id: ids.deal21, tenantId: ids.tenant, dealNo: "DL-2026-0021", dealName: "เฟสที่ 2 — ส่วนต่อขยายอาคาร C",                   customerId: ids.custOmega,    ownerId: ids.rep3, stageId: ids.stageOpportunity, estimatedValue: 3200000, status: DealStatus.OPEN, followUpAt: daysFromNow(14),  createdAt: daysFromNow(-4) },
    { id: ids.deal22, tenantId: ids.tenant, dealNo: "DL-2026-0022", dealName: "โต๊ะทำงานโซน Startup ชั้น 2",                      customerId: ids.custCentral,  ownerId: ids.rep3, stageId: ids.stageOpportunity, estimatedValue: 280000,  status: DealStatus.OPEN, followUpAt: daysFromNow(10),  createdAt: daysFromNow(-3) },
    { id: ids.deal23, tenantId: ids.tenant, dealNo: "DL-2026-0023", dealName: "โต๊ะทำงาน Acker เพิ่มเติมแผนกใหม่",               customerId: ids.custAcme,     ownerId: ids.rep,  stageId: ids.stageOpportunity, estimatedValue: 142000,  status: DealStatus.OPEN, followUpAt: daysFromNow(11),  createdAt: daysFromNow(-2) },
    { id: ids.deal24, tenantId: ids.tenant, dealNo: "DL-2026-0024", dealName: "เก้าอี้ Mesh Ergonomic ฝ่าย Call Center 80 ตัว",  customerId: ids.custBKKFood,  ownerId: ids.rep2, stageId: ids.stageOpportunity, estimatedValue: 520000,  status: DealStatus.OPEN, followUpAt: daysFromNow(12),  createdAt: daysFromNow(-1) },
    { id: ids.deal25, tenantId: ids.tenant, dealNo: "DL-2026-0025", dealName: "รีเฟรชออฟฟิศ — เปลี่ยนเก้าอี้และโต๊ะทั้งชั้น 10", customerId: ids.custSiamTech, ownerId: ids.rep,  stageId: ids.stageQuotation,   estimatedValue: 320000,  status: DealStatus.OPEN, followUpAt: daysFromNow(6),   createdAt: daysFromNow(-10) },
    // Test deals for notification testing (based on DL-2026-0003)
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
}
