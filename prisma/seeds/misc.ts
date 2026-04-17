import { JobStatus, PrismaClient } from "@prisma/client";
import { ids } from "./shared.js";

export async function seedMisc(prisma: PrismaClient) {
  // ── KPI Targets ────────────────────────────────────────────────────────────
  await prisma.salesKpiTarget.createMany({
    data: [
      { tenantId: ids.tenant, userId: ids.rep,  targetMonth: "2026-04", visitTargetCount: 40, newDealValueTarget: 2000000, revenueTarget: 1500000 },
      { tenantId: ids.tenant, userId: ids.rep2, targetMonth: "2026-04", visitTargetCount: 35, newDealValueTarget: 3000000, revenueTarget: 2500000 },
      { tenantId: ids.tenant, userId: ids.rep3, targetMonth: "2026-04", visitTargetCount: 30, newDealValueTarget: 5000000, revenueTarget: 4000000 }
    ]
  });

  // ── Integration ────────────────────────────────────────────────────────────
  // Integration credentials are not seeded — configure real keys via Settings → Integrations.
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

  // ── AI Analysis ────────────────────────────────────────────────────────────
  const aiRun = await prisma.aiAnalysisRun.create({
    data: { tenantId: ids.tenant, requestedBy: ids.manager, status: JobStatus.SUCCESS, completedAt: new Date() }
  });

  await prisma.aiAnalysisFinding.createMany({
    data: [
      { runId: aiRun.id, findingType: "pattern", title: "นัดหมายช่วงบ่ายเป็นหลัก",             description: "คุณสมชายนัดหมายลูกค้าหลังเที่ยง 88% ของทุกการเยี่ยม อาจพลาดลูกค้าที่ต้องการนัดช่วงเช้า",   confidenceScore: 0.81, evidenceJson: { windowDays: 30, afterNoonPercent: 88 } },
      { runId: aiRun.id, findingType: "risk",    title: "ดีลใหญ่ค้างไม่มีความเคลื่อนไหว",       description: "ดีล DL-2026-0019 (฿6.8M) ไม่มีการอัปเดตมาแล้วกว่า 14 วัน ควรติดตามด่วน",                  confidenceScore: 0.91, evidenceJson: { dealId: ids.deal19, daysSinceUpdate: 14 } },
      { runId: aiRun.id, findingType: "insight", title: "Pimchanok — Win Rate สูงสุดไตรมาส 1",  description: "คุณพิมพ์ชนกปิดดีลได้ 2 จาก 5 ดีลในไตรมาส 1 (40%) สูงกว่าค่าเฉลี่ยทีม 28% โดยเน้นลูกค้า Segment Enterprise", confidenceScore: 0.88, evidenceJson: { repId: ids.rep3, winRate: 0.40, teamAvg: 0.28 } }
    ]
  });

  // ── Voice Note ─────────────────────────────────────────────────────────────
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
