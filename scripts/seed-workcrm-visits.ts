import { PrismaClient, VisitType, VisitStatus, CustomerStatus } from "@prisma/client";

const prisma = new PrismaClient();

async function main() {
  const TENANT_SLUG = "workcrm";
  const REP_EMAIL = "siripong.t@workstationoffice.com";

  const tenant = await prisma.tenant.findUnique({ where: { slug: TENANT_SLUG }, select: { id: true, name: true } });
  if (!tenant) throw new Error(`Tenant slug "${TENANT_SLUG}" not found.`);

  const rep = await prisma.user.findFirst({
    where: { tenantId: tenant.id, email: REP_EMAIL },
    select: { id: true, fullName: true, email: true },
  });
  if (!rep) throw new Error(`User "${REP_EMAIL}" not found in tenant "${TENANT_SLUG}".`);

  console.log(`Tenant: ${tenant.name} (${tenant.id})`);
  console.log(`Rep:    ${rep.fullName} <${rep.email}> (${rep.id})`);

  const stamp = Date.now().toString(36).toUpperCase();
  const newCustomers = await Promise.all([
    prisma.customer.create({
      data: {
        tenantId: tenant.id,
        ownerId: rep.id,
        name: "Acme Sample Co., Ltd.",
        customerCode: `SEED-${stamp}-A`,
        customerType: "COMPANY",
        status: CustomerStatus.ACTIVE,
        siteLat: 13.7563,
        siteLng: 100.5018,
        createdByUserId: rep.id,
      },
      select: { id: true, name: true, customerCode: true, siteLat: true, siteLng: true },
    }),
    prisma.customer.create({
      data: {
        tenantId: tenant.id,
        ownerId: rep.id,
        name: "Bangkok Retail Partner",
        customerCode: `SEED-${stamp}-B`,
        customerType: "COMPANY",
        status: CustomerStatus.ACTIVE,
        siteLat: 13.7460,
        siteLng: 100.5350,
        createdByUserId: rep.id,
      },
      select: { id: true, name: true, customerCode: true, siteLat: true, siteLng: true },
    }),
  ]);
  console.log("Customers created:");
  for (const c of newCustomers) console.log(`  ${c.customerCode}  ${c.name}  (${c.id})`);

  const baseCount = await prisma.visit.count({ where: { tenantId: tenant.id } });

  const objectives = [
    "Introductory site visit",
    "Quarterly check-in",
    "Demo product line",
    "Discuss renewal terms",
    "Resolve outstanding follow-up",
    "Catalog walkthrough",
    "Pricing discussion",
    "Stock review",
    "Order confirmation",
    "Relationship touchpoint",
  ];

  // 10 visits across the next 7 days: days 0..6 once, then 3 more on days 1,3,5 in the afternoon.
  const slots: Array<{ dayOffset: number; hour: number }> = [
    { dayOffset: 0, hour: 9 },
    { dayOffset: 1, hour: 10 },
    { dayOffset: 2, hour: 9 },
    { dayOffset: 3, hour: 11 },
    { dayOffset: 4, hour: 9 },
    { dayOffset: 5, hour: 10 },
    { dayOffset: 6, hour: 9 },
    { dayOffset: 1, hour: 14 },
    { dayOffset: 3, hour: 15 },
    { dayOffset: 5, hour: 14 },
  ];

  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const visits = [];
  for (let i = 0; i < slots.length; i++) {
    const { dayOffset, hour } = slots[i];
    const planned = new Date(today);
    planned.setDate(today.getDate() + dayOffset);
    planned.setHours(hour, 0, 0, 0);

    const customer = newCustomers[i % newCustomers.length];
    const visitNo = `V-${String(baseCount + i + 1).padStart(6, "0")}`;

    visits.push(
      await prisma.visit.create({
        data: {
          tenantId: tenant.id,
          repId: rep.id,
          customerId: customer.id,
          visitNo,
          plannedAt: planned,
          objective: objectives[i] ?? "Site visit",
          visitType: VisitType.PLANNED,
          status: VisitStatus.PLANNED,
          createdByUserId: rep.id,
          siteLat: customer.siteLat,
          siteLng: customer.siteLng,
        },
        select: { id: true, visitNo: true, plannedAt: true, customerId: true },
      })
    );
  }
  console.log(`Created ${visits.length} PLANNED visits:`);
  for (const v of visits) {
    console.log(`  ${v.visitNo}  ${v.plannedAt.toISOString()}  customer=${v.customerId}`);
  }
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
