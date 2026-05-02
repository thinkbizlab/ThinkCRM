/**
 * Federation read-layer tests.
 *
 * These run against a real Postgres for the Tenant + IntegrationSource setup
 * (the federation module fetches its config via prisma) but mock mysql2's
 * dynamic `import("mysql2/promise")` so we don't need a live MySQL.
 *
 * The mock is configured per-test via `mockMysqlPool.responses.push(...)` for
 * a queue of row-set responses, or `mockMysqlPool.error = new Error(...)` to
 * make the next query fail (drives the stale + circuit-breaker paths).
 */

import { SourceType } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
// Importing `config` for its side effect: it calls `dotenv.config()` at module
// load time so DATABASE_URL is available before prisma is instantiated below.
// Other tests pick this up transitively via `buildApp`; we don't.
import "../../config.js";
import { prisma } from "../../lib/prisma.js";

// ── mysql2 mock ─────────────────────────────────────────────────────────────
// `vi.mock` is hoisted; we keep a mutable harness object the test code drives.

type MockResponse = Record<string, unknown>[];
const mockHarness: {
  responses: MockResponse[];
  error: Error | null;
  callLog: Array<{ sql: string; values?: unknown[] }>;
} = { responses: [], error: null, callLog: [] };

vi.mock("mysql2/promise", () => {
  const fakeConn = {
    query: async (sql: string, values?: unknown[]) => {
      // Trim transaction-control statements: callers do START/COMMIT around
      // the real SELECT and we only care to assert/queue against SELECTs.
      if (/^\s*(START TRANSACTION|COMMIT|ROLLBACK)/i.test(sql)) return [[], []];
      mockHarness.callLog.push({ sql, values });
      if (mockHarness.error) {
        const err = mockHarness.error;
        mockHarness.error = null;
        throw err;
      }
      const next = mockHarness.responses.shift() ?? [];
      return [next, []];
    },
    release: () => {}
  };
  return {
    createPool: () => ({
      query: fakeConn.query,
      getConnection: async () => fakeConn,
      end: async () => {}
    })
  };
});

// Imports below MUST come AFTER vi.mock so the dynamic import inside mysql-pool
// resolves to our mock the first time it's awaited.
const {
  clearFederationCaches,
  hydrateCustomer,
  hydrateCustomers,
  isFederated,
  searchFederatedCustomers,
  withFederationRequestScope
} = await import("./customer-federation.js");
// Force a fresh pool between cases since the breaker state persists in-process.
const { evictPool } = await import("./mysql-pool.js");

// ── Fixtures ────────────────────────────────────────────────────────────────

type Fixture = {
  tenantId: string;
  userId: string;
  sourceId: string;
};

const createdTenants: string[] = [];

async function setupFederatedTenant(opts?: {
  mappings?: Array<{ sourceField: string; targetField: string; transformRule?: string | null; isRequired?: boolean }>;
}): Promise<Fixture> {
  const suffix = randomUUID().replace(/-/g, "").slice(0, 12);
  const tenantId = `tenant_${suffix}`;
  const userId = `user_${suffix}`;
  createdTenants.push(tenantId);

  await prisma.tenant.create({
    data: { id: tenantId, name: `T ${suffix}`, slug: `t-${suffix}` }
  });
  await prisma.user.create({
    data: {
      id: userId,
      tenantId,
      email: `u-${suffix}@example.com`,
      passwordHash: "x",
      fullName: "U",
      role: "ADMIN"
    }
  });
  const source = await prisma.integrationSource.create({
    data: {
      tenantId,
      sourceName: "Test MySQL",
      sourceType: SourceType.MYSQL,
      configJson: {
        entityType: "CUSTOMER",
        host: "localhost",
        port: 3306,
        database: "erp",
        user: "ro",
        passwordEnc: "test-password",
        ssl: { mode: "DISABLED" },
        schedule: { mode: "MANUAL" },
        query: { mode: "TABLE", table: "customer" },
        federationMode: "LIVE",
        keyColumn: "external_ref"
      },
      ...(opts?.mappings ? {
        mappings: {
          create: opts.mappings.map((m) => ({
            entityType: "CUSTOMER",
            sourceField: m.sourceField,
            targetField: m.targetField,
            transformRule: m.transformRule ?? null,
            isRequired: m.isRequired ?? false
          }))
        }
      } : {})
    }
  });
  await prisma.tenant.update({
    where: { id: tenantId },
    data: { customerFederationSourceId: source.id }
  });
  return { tenantId, userId, sourceId: source.id };
}

async function setupNonFederatedTenant(): Promise<Pick<Fixture, "tenantId">> {
  const suffix = randomUUID().replace(/-/g, "").slice(0, 12);
  const tenantId = `tenant_${suffix}`;
  createdTenants.push(tenantId);
  await prisma.tenant.create({
    data: { id: tenantId, name: `T ${suffix}`, slug: `t-${suffix}` }
  });
  return { tenantId };
}

describe("customer federation", () => {
  beforeAll(() => {
    // Some tests may have run earlier — start each suite with a clean cache.
    clearFederationCaches();
  });

  afterEach(async () => {
    mockHarness.responses = [];
    mockHarness.error = null;
    mockHarness.callLog = [];
    clearFederationCaches();
    // Drop any pool we created so the breaker state doesn't carry over.
    const sources = await prisma.integrationSource.findMany({
      where: { tenantId: { in: createdTenants } },
      select: { id: true }
    });
    for (const s of sources) await evictPool(s.id);
  });

  afterAll(async () => {
    if (createdTenants.length > 0) {
      const scope = { tenantId: { in: createdTenants } };
      // Detach the federation FK first so we can delete the IntegrationSource.
      await prisma.tenant.updateMany({
        where: { id: { in: createdTenants } },
        data: { customerFederationSourceId: null }
      });
      await prisma.integrationFieldMapping.deleteMany({
        where: { source: { tenantId: { in: createdTenants } } }
      });
      await prisma.integrationSource.deleteMany({ where: scope });
      await prisma.user.deleteMany({ where: scope });
      await prisma.tenant.deleteMany({ where: { id: { in: createdTenants } } });
    }
  });

  it("isFederated is false on tenants without a configured source", async () => {
    const { tenantId } = await setupNonFederatedTenant();
    expect(await isFederated(tenantId)).toBe(false);
  });

  it("isFederated is true once the source is set", async () => {
    const { tenantId } = await setupFederatedTenant();
    expect(await isFederated(tenantId)).toBe(true);
  });

  it("hydrateCustomer overlays live attrs and marks status=live on success", async () => {
    const { tenantId } = await setupFederatedTenant();
    mockHarness.responses.push([{
      external_ref: "ERP-1",
      name: "Live Co Updated",
      tax_id: "0105555000001",
      branch_code: "00000"
    }]);
    const result = await hydrateCustomer(tenantId, {
      id: "local-1",
      tenantId,
      externalRef: "ERP-1",
      customerCode: "ERP-1",
      name: "Stale Local Name",
      parentCustomerId: null,
      customerGroupId: null,
      status: "ACTIVE"
    });
    expect(result?.federationStatus).toBe("live");
    expect(result?.name).toBe("Live Co Updated");
    expect((result as Record<string, unknown>).taxId).toBe("0105555000001");
    expect((result as Record<string, unknown>).branchCode).toBe("00000");
  });

  it("hydrateCustomer marks status=stale and keeps shadow attrs when MySQL throws", async () => {
    const { tenantId } = await setupFederatedTenant();
    mockHarness.error = new Error("connection refused");
    const result = await hydrateCustomer(tenantId, {
      id: "local-1",
      tenantId,
      externalRef: "ERP-1",
      customerCode: "ERP-1",
      name: "Cached Name",
      parentCustomerId: null,
      customerGroupId: null,
      status: "ACTIVE"
    });
    expect(result?.federationStatus).toBe("stale");
    expect(result?.name).toBe("Cached Name");
  });

  it("hydrateCustomer leaves DRAFT customers as local without hitting MySQL", async () => {
    const { tenantId } = await setupFederatedTenant();
    const result = await hydrateCustomer(tenantId, {
      id: "draft-1",
      tenantId,
      externalRef: null,
      customerCode: null,
      name: "Draft from drop-in visit",
      parentCustomerId: null,
      customerGroupId: null,
      status: "DRAFT"
    });
    expect(result?.federationStatus).toBe("local");
    expect(mockHarness.callLog).toHaveLength(0);
  });

  it("non-federated tenants pass through with status=local", async () => {
    const { tenantId } = await setupNonFederatedTenant();
    const result = await hydrateCustomer(tenantId, {
      id: "local-1",
      tenantId,
      externalRef: "ERP-1",
      customerCode: "ERP-1",
      name: "Local Name",
      parentCustomerId: null,
      customerGroupId: null,
      status: "ACTIVE"
    });
    expect(result?.federationStatus).toBe("local");
    expect(mockHarness.callLog).toHaveLength(0);
  });

  it("per-request scope dedups concurrent reads of the same externalRef", async () => {
    const { tenantId } = await setupFederatedTenant();
    mockHarness.responses.push([{ external_ref: "ERP-1", name: "Live" }]);
    await withFederationRequestScope(async () => {
      const rows = [
        { id: "a", tenantId, externalRef: "ERP-1", customerCode: "ERP-1", name: "x", parentCustomerId: null, customerGroupId: null, status: "ACTIVE" },
        { id: "b", tenantId, externalRef: "ERP-1", customerCode: "ERP-1", name: "y", parentCustomerId: null, customerGroupId: null, status: "ACTIVE" },
        { id: "c", tenantId, externalRef: "ERP-1", customerCode: "ERP-1", name: "z", parentCustomerId: null, customerGroupId: null, status: "ACTIVE" }
      ];
      await hydrateCustomers(tenantId, rows);
    });
    expect(mockHarness.callLog).toHaveLength(1);
  });

  it("searchFederatedCustomers returns mapped {externalRef, name, raw} hits", async () => {
    const { tenantId } = await setupFederatedTenant();
    mockHarness.responses.push([
      { external_ref: "ERP-9", name: "Acme HQ", tax_id: "999" },
      { external_ref: "ERP-10", name: "Acme Retail", tax_id: "1000" }
    ]);
    const hits = await searchFederatedCustomers(tenantId, "Acme", 10);
    expect(hits.map((h) => h.externalRef)).toEqual(["ERP-9", "ERP-10"]);
    expect(hits[0]!.name).toBe("Acme HQ");
    // Bound parameter is `%Acme%` (LIKE wildcards).
    expect(mockHarness.callLog[0]!.values).toEqual(["%Acme%"]);
  });

  it("uses IntegrationFieldMapping when present (overrides snake/camel convention)", async () => {
    // Tenant whose MySQL columns are `cust_name` and `tin` instead of `name` / `tax_id`.
    const { tenantId } = await setupFederatedTenant({
      mappings: [
        { sourceField: "cust_name", targetField: "name" },
        { sourceField: "tin",       targetField: "taxId", transformRule: '[{"rule":"trim"}]' }
      ]
    });
    mockHarness.responses.push([{
      external_ref: "ERP-1",
      cust_name: "Mapped Co",
      tin: "  0105555000999  "
    }]);
    const result = await hydrateCustomer(tenantId, {
      id: "local-1",
      tenantId,
      externalRef: "ERP-1",
      customerCode: "ERP-1",
      name: "Stale",
      parentCustomerId: null,
      customerGroupId: null,
      status: "ACTIVE"
    });
    expect(result?.federationStatus).toBe("live");
    expect(result?.name).toBe("Mapped Co");
    // Transform chain trimmed the tin value.
    expect((result as Record<string, unknown>).taxId).toBe("0105555000999");
  });

  it("searchFederatedCustomers searches the mapped name column when configured", async () => {
    const { tenantId } = await setupFederatedTenant({
      mappings: [{ sourceField: "cust_name", targetField: "name" }]
    });
    mockHarness.responses.push([
      { external_ref: "ERP-9", cust_name: "Acme HQ" }
    ]);
    const hits = await searchFederatedCustomers(tenantId, "Acme", 10);
    expect(hits).toHaveLength(1);
    expect(hits[0]!.name).toBe("Acme HQ");
    // The SQL must reference the mapped column, not `name`.
    expect(mockHarness.callLog[0]!.sql).toContain("`cust_name`");
  });

  it("circuit breaker opens after 5 consecutive failures", async () => {
    const { tenantId } = await setupFederatedTenant();
    // Five rapid failures should trip the breaker. The 6th call must
    // short-circuit (no new mysql2 call) and return stale.
    for (let i = 0; i < 5; i++) {
      mockHarness.error = new Error(`fail ${i}`);
      const result = await hydrateCustomer(tenantId, {
        id: `local-${i}`,
        tenantId,
        externalRef: `ERP-${i}`,
        customerCode: `ERP-${i}`,
        name: `n${i}`,
        parentCustomerId: null,
        customerGroupId: null,
        status: "ACTIVE"
      });
      expect(result?.federationStatus).toBe("stale");
    }
    const callsBeforeBreaker = mockHarness.callLog.length;
    expect(callsBeforeBreaker).toBe(5);

    // Breaker is now open. Even though we didn't queue an error, the breaker
    // refuses new connections so the call short-circuits in the pool layer.
    const result = await hydrateCustomer(tenantId, {
      id: "local-after",
      tenantId,
      externalRef: "ERP-after",
      customerCode: "ERP-after",
      name: "after",
      parentCustomerId: null,
      customerGroupId: null,
      status: "ACTIVE"
    });
    expect(result?.federationStatus).toBe("stale");
    // Crucially, no new SELECT was issued — the breaker absorbed it.
    expect(mockHarness.callLog).toHaveLength(callsBeforeBreaker);
  });
});
