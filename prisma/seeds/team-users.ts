import { PrismaClient, UserRole } from "@prisma/client";
import { hashPassword } from "../../src/lib/password.js";
import { ids } from "./shared.js";

export async function seedTeamUsers(prisma: PrismaClient) {
  const pw = hashPassword("ThinkCRM123!");

  await prisma.team.create({
    data: { id: ids.team, tenantId: ids.tenant, teamName: "ทีมขายกรุงเทพ" }
  });

  await prisma.user.createMany({
    data: [
      { id: ids.admin,      tenantId: ids.tenant, email: "admin@thinkcrm.demo",      passwordHash: pw, fullName: "Siripong Tianpajeekul",  role: UserRole.ADMIN,       teamId: ids.team, emailVerified: true },
      { id: ids.manager,    tenantId: ids.tenant, email: "manager@thinkcrm.demo",    passwordHash: pw, fullName: "Manop Siriwong",         role: UserRole.MANAGER,     teamId: ids.team, emailVerified: true },
      { id: ids.supervisor, tenantId: ids.tenant, email: "supervisor@thinkcrm.demo", passwordHash: pw, fullName: "Supaporn Charoenwong",   role: UserRole.SUPERVISOR,  teamId: ids.team, managerUserId: ids.manager, emailVerified: true },
      { id: ids.rep,        tenantId: ids.tenant, email: "rep@thinkcrm.demo",        passwordHash: pw, fullName: "Somchai Phuttarak",      role: UserRole.REP,         teamId: ids.team, managerUserId: ids.supervisor, emailVerified: true },
      { id: ids.rep2,       tenantId: ids.tenant, email: "rep2@thinkcrm.demo",       passwordHash: pw, fullName: "Nattaporn Yodying",      role: UserRole.REP,         teamId: ids.team, managerUserId: ids.supervisor, emailVerified: true },
      { id: ids.rep3,       tenantId: ids.tenant, email: "rep3@thinkcrm.demo",       passwordHash: pw, fullName: "Pimchanok Srithai",      role: UserRole.REP,         teamId: ids.team, managerUserId: ids.manager, emailVerified: true }
    ]
  });
}
