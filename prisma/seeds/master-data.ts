import { PrismaClient } from "@prisma/client";
import { ids } from "./shared.js";

export async function seedMasterData(prisma: PrismaClient) {
  // ── Payment Terms ──────────────────────────────────────────────────────────
  await prisma.paymentTerm.createMany({
    data: [
      { id: ids.termCOD,   tenantId: ids.tenant, code: "COD",   name: "ชำระเงินปลายทาง", dueDays: 0,  customFields: { collectionMethod: "cash" } },
      { id: ids.termNET15, tenantId: ids.tenant, code: "NET15", name: "เครดิต 15 วัน",    dueDays: 15, customFields: { collectionMethod: "bank-transfer" } },
      { id: ids.termNET30, tenantId: ids.tenant, code: "NET30", name: "เครดิต 30 วัน",    dueDays: 30, customFields: { collectionMethod: "bank-transfer" } },
      { id: ids.termNET60, tenantId: ids.tenant, code: "NET60", name: "เครดิต 60 วัน",    dueDays: 60, customFields: { collectionMethod: "bank-transfer" } }
    ]
  });

  // ── Custom Field Definitions ───────────────────────────────────────────────
  await prisma.customFieldDefinition.createMany({
    data: [
      { tenantId: ids.tenant, entityType: "CUSTOMER",     fieldKey: "customerTier",     label: "ระดับลูกค้า",         dataType: "SELECT", isRequired: true,  displayOrder: 1, optionsJson: ["Platinum", "Gold", "Silver", "Bronze"] },
      { tenantId: ids.tenant, entityType: "ITEM",         fieldKey: "warrantyMonths",   label: "ประกัน (เดือน)",       dataType: "NUMBER", isRequired: false, displayOrder: 1 },
      { tenantId: ids.tenant, entityType: "PAYMENT_TERM", fieldKey: "collectionMethod", label: "วิธีการรับชำระเงิน",   dataType: "SELECT", isRequired: true,  displayOrder: 1, optionsJson: ["bank-transfer", "cash", "credit-card", "cheque"] }
    ]
  });

  // ── Items (Office Furniture Products) ─────────────────────────────────────
  await prisma.item.createMany({
    data: [
      { id: ids.itemA, tenantId: ids.tenant, itemCode: "26FKH151", name: "โต๊ะทำงาน Kadeem 1 ที่นั่ง 1.4m",        unitPrice: 8900,   customFields: { warrantyMonths: 12 } },
      { id: ids.itemB, tenantId: ids.tenant, itemCode: "32FOB005", name: "โต๊ะทำงาน Acker 2 ที่นั่ง 1.2m",         unitPrice: 15800,  customFields: { warrantyMonths: 12 } },
      { id: ids.itemC, tenantId: ids.tenant, itemCode: "26MKH013", name: "โต๊ะผู้บริหาร Loft พร้อมตู้ข้าง 1.6m", unitPrice: 32500,  customFields: { warrantyMonths: 24 } },
      { id: ids.itemD, tenantId: ids.tenant, itemCode: "23CHR091", name: "เก้าอี้ทำงาน Mesh Ergonomic",            unitPrice: 6500,   customFields: { warrantyMonths: 24 } },
      { id: ids.itemE, tenantId: ids.tenant, itemCode: "23CHR045", name: "เก้าอี้ Executive Premium",              unitPrice: 18900,  customFields: { warrantyMonths: 36 } },
      { id: ids.itemF, tenantId: ids.tenant, itemCode: "44STG202", name: "ตู้เอกสารเหล็ก 4 ลิ้นชัก",             unitPrice: 4200,   customFields: { warrantyMonths: 12 } },
      { id: ids.itemG, tenantId: ids.tenant, itemCode: "55MTG110", name: "โต๊ะประชุม Premium 2.4m ลายไม้ Oak",    unitPrice: 45000,  customFields: { warrantyMonths: 36 } }
    ]
  });

  // ── Deal Stages ────────────────────────────────────────────────────────────
  await prisma.dealStage.createMany({
    data: [
      { id: ids.stageOpportunity, tenantId: ids.tenant, stageName: "Opportunity",   stageOrder: 1, isDefault: true },
      { id: ids.stageQuotation,   tenantId: ids.tenant, stageName: "Quotation",     stageOrder: 2 },
      { id: ids.stageNegotiation, tenantId: ids.tenant, stageName: "Negotiation",   stageOrder: 3 },
      { id: ids.stageWon,         tenantId: ids.tenant, stageName: "Won",           stageOrder: 4, isClosedWon: true },
      { id: ids.stageLost,        tenantId: ids.tenant, stageName: "Lost",          stageOrder: 5, isClosedLost: true }
    ]
  });
}
