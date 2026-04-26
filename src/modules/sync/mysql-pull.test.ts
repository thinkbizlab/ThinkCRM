import { describe, expect, it } from "vitest";
import { buildTableModeSql, validateSelectStatement, type MysqlSourceConfig } from "./mysql-pull.js";
import { parseSchedule } from "./rest-pull.js";

const baseCfg = (over: Partial<MysqlSourceConfig> = {}): MysqlSourceConfig => ({
  entityType: "CUSTOMER" as never,
  host: "db.example.com",
  port: 3306,
  database: "erp",
  user: "reader",
  passwordEnc: "enc:00:00:00",
  ssl: { mode: "REQUIRED" },
  connectTimeoutMs: 10_000,
  queryTimeoutMs: 60_000,
  rowLimit: 50_000,
  schedule: { kind: "MANUAL" },
  query: { mode: "TABLE", table: "customers" },
  ...over,
});

describe("validateSelectStatement", () => {
  it("accepts a plain SELECT", () => {
    expect(() => validateSelectStatement("SELECT id, name FROM customers")).not.toThrow();
  });

  it("accepts SELECT with trailing semicolon", () => {
    expect(() => validateSelectStatement("SELECT 1;")).not.toThrow();
  });

  it("accepts a CTE: WITH ... SELECT", () => {
    expect(() => validateSelectStatement("WITH cte AS (SELECT 1 AS n) SELECT * FROM cte")).not.toThrow();
  });

  it("accepts SELECT with embedded forbidden word inside string literal", () => {
    expect(() => validateSelectStatement("SELECT 'INSERT into log' AS note")).not.toThrow();
  });

  it("accepts SELECT with line comment containing forbidden words", () => {
    expect(() => validateSelectStatement("-- comment INSERT DROP\nSELECT 1")).not.toThrow();
  });

  it("rejects empty SQL", () => {
    expect(() => validateSelectStatement("")).toThrow(/empty/i);
    expect(() => validateSelectStatement("   \n")).toThrow(/empty/i);
  });

  it("rejects multiple statements", () => {
    expect(() => validateSelectStatement("SELECT 1; SELECT 2")).toThrow(/single statement/i);
  });

  it("rejects INSERT", () => {
    expect(() => validateSelectStatement("INSERT INTO t VALUES (1)")).toThrow(/SELECT or WITH/i);
  });

  it("rejects UPDATE", () => {
    expect(() => validateSelectStatement("UPDATE t SET x=1")).toThrow(/SELECT or WITH/i);
  });

  it("rejects DELETE", () => {
    expect(() => validateSelectStatement("DELETE FROM t")).toThrow(/SELECT or WITH/i);
  });

  it("rejects DROP, TRUNCATE, ALTER, CREATE", () => {
    expect(() => validateSelectStatement("DROP TABLE t")).toThrow();
    expect(() => validateSelectStatement("TRUNCATE TABLE t")).toThrow();
    expect(() => validateSelectStatement("ALTER TABLE t ADD c INT")).toThrow();
    expect(() => validateSelectStatement("CREATE TABLE t(x INT)")).toThrow();
  });

  it("rejects SELECT containing a forbidden keyword as a real token", () => {
    expect(() => validateSelectStatement("SELECT * FROM t; DELETE FROM t")).toThrow();
    expect(() => validateSelectStatement("SELECT 1 INTO OUTFILE '/tmp/x'; LOAD DATA INFILE '/tmp/x' INTO TABLE t"))
      .toThrow();
  });

  it("rejects SET, LOCK, KILL, CALL, PREPARE, EXECUTE", () => {
    expect(() => validateSelectStatement("SET autocommit=0")).toThrow();
    expect(() => validateSelectStatement("LOCK TABLES t WRITE")).toThrow();
    expect(() => validateSelectStatement("KILL 5")).toThrow();
    expect(() => validateSelectStatement("CALL my_proc()")).toThrow();
    expect(() => validateSelectStatement("PREPARE s FROM 'SELECT 1'")).toThrow();
    expect(() => validateSelectStatement("EXECUTE s")).toThrow();
  });
});

describe("buildTableModeSql", () => {
  it("builds a basic SELECT * with LIMIT", () => {
    const sql = buildTableModeSql(baseCfg());
    expect(sql).toBe("SELECT * FROM `customers` LIMIT 50000");
  });

  it("backtick-quotes a schema-qualified table", () => {
    const sql = buildTableModeSql(baseCfg({ query: { mode: "TABLE", table: "erp.customer_master" } }));
    expect(sql).toBe("SELECT * FROM `erp`.`customer_master` LIMIT 50000");
  });

  it("includes WHERE and ORDER BY when supplied", () => {
    const sql = buildTableModeSql(baseCfg({
      query: { mode: "TABLE", table: "customers", where: "active = 1", orderBy: "id DESC" }
    }));
    expect(sql).toBe("SELECT * FROM `customers` WHERE active = 1 ORDER BY id DESC LIMIT 50000");
  });

  it("expands {{today}} templates in WHERE", () => {
    const now = new Date("2026-04-26T12:00:00.000Z");
    const sql = buildTableModeSql(
      baseCfg({ query: { mode: "TABLE", table: "customers", where: "updated_at > '{{today:YYYY-MM-DD}}'" } }),
      now
    );
    expect(sql).toContain("updated_at > '2026-04-26'");
  });

  it("respects custom rowLimit", () => {
    const sql = buildTableModeSql(baseCfg({ rowLimit: 100 }));
    expect(sql).toBe("SELECT * FROM `customers` LIMIT 100");
  });

  it("throws if called on a SQL-mode config", () => {
    expect(() => buildTableModeSql(baseCfg({ query: { mode: "SQL", sql: "SELECT 1" } })))
      .toThrow(/non-TABLE/);
  });
});

describe("parseSchedule MINUTES", () => {
  it("parses a valid MINUTES schedule", () => {
    expect(parseSchedule({ kind: "MINUTES", intervalMinutes: 5 }))
      .toEqual({ kind: "MINUTES", intervalMinutes: 5 });
  });

  it("parses every allowed interval", () => {
    for (const m of [1, 2, 5, 10, 15, 30]) {
      expect(parseSchedule({ kind: "MINUTES", intervalMinutes: m }))
        .toEqual({ kind: "MINUTES", intervalMinutes: m });
    }
  });

  it("snaps an unsupported interval back to 5", () => {
    expect(parseSchedule({ kind: "MINUTES", intervalMinutes: 7 }))
      .toEqual({ kind: "MINUTES", intervalMinutes: 5 });
    expect(parseSchedule({ kind: "MINUTES", intervalMinutes: 60 }))
      .toEqual({ kind: "MINUTES", intervalMinutes: 5 });
  });

  it("coerces string intervalMinutes", () => {
    expect(parseSchedule({ kind: "MINUTES", intervalMinutes: "10" }))
      .toEqual({ kind: "MINUTES", intervalMinutes: 10 });
  });

  it("falls back to MANUAL on missing kind", () => {
    expect(parseSchedule({})).toEqual({ kind: "MANUAL" });
  });
});
