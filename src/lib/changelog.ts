import { EntityType, type PrismaClient, Prisma } from "@prisma/client";

type ChangelogDbClient = PrismaClient | Prisma.TransactionClient;

type WriteEntityChangelogInput = {
  db: ChangelogDbClient;
  tenantId: string;
  entityType: EntityType;
  entityId: string;
  action: "CREATE" | "UPDATE" | "DELETE";
  changedById?: string | null;
  before?: unknown;
  after?: unknown;
  context?: Record<string, unknown>;
};

function normalizeJson(
  value: unknown
): Prisma.InputJsonValue | Prisma.NullableJsonNullValueInput | undefined {
  if (value === undefined) return undefined;
  if (value === null) return Prisma.JsonNull;
  return value as Prisma.InputJsonValue;
}

export async function writeEntityChangelog(input: WriteEntityChangelogInput): Promise<void> {
  await input.db.entityChangelog.create({
    data: {
      tenantId: input.tenantId,
      entityType: input.entityType,
      entityId: input.entityId,
      action: input.action,
      changedById: input.changedById ?? null,
      beforeJson: normalizeJson(input.before),
      afterJson: normalizeJson(input.after),
      contextJson: normalizeJson(input.context)
    }
  });
}
