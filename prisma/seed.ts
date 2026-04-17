/**
 * Demo data seed coordinator.
 *
 * Domain logic lives in prisma/seeds/ — one file per domain.
 * This file owns: PrismaClient lifecycle, reset sequence, and orchestration order.
 *
 * Run: npx prisma db seed
 */

import { PrismaClient } from "@prisma/client";
import { seedTenant }     from "./seeds/tenant.js";
import { seedTeamUsers }  from "./seeds/team-users.js";
import { seedMasterData } from "./seeds/master-data.js";
import { seedCustomers }  from "./seeds/customers.js";
import { seedDeals }      from "./seeds/deals.js";
import { seedVisits }     from "./seeds/visits.js";
import { seedMisc }       from "./seeds/misc.js";

const prisma = new PrismaClient();

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

async function main() {
  await resetData();

  // Seed in dependency order — each domain builds on the previous.
  await seedTenant(prisma);
  await seedTeamUsers(prisma);
  await seedMasterData(prisma);
  await seedCustomers(prisma);
  await seedDeals(prisma);
  await seedVisits(prisma);
  await seedMisc(prisma);

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
