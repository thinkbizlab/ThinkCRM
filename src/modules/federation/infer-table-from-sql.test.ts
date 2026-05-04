import { describe, expect, it } from "vitest";
import { inferTableFromSql } from "./customer-federation.js";

describe("inferTableFromSql", () => {
  it("extracts the simple FROM target", () => {
    expect(inferTableFromSql("SELECT * FROM customer")).toBe("customer");
  });

  it("handles backticks", () => {
    expect(inferTableFromSql("SELECT * FROM `tabCustomer`")).toBe("tabCustomer");
  });

  it("handles AS alias", () => {
    expect(inferTableFromSql("SELECT C.name FROM tabCustomer AS C ORDER BY C.name")).toBe("tabCustomer");
  });

  it("handles bare alias without AS", () => {
    expect(inferTableFromSql("SELECT c.id FROM customer c WHERE c.disabled = 0")).toBe("customer");
  });

  it("ignores leading line comments", () => {
    expect(inferTableFromSql("-- some comment\nSELECT * FROM tabCustomer")).toBe("tabCustomer");
  });

  it("returns null when there is no FROM", () => {
    expect(inferTableFromSql("SELECT 1")).toBeNull();
  });

  it("returns null for an empty / null / undefined input", () => {
    expect(inferTableFromSql("")).toBeNull();
    expect(inferTableFromSql(null)).toBeNull();
    expect(inferTableFromSql(undefined)).toBeNull();
  });

  it("returns the first table when there are JOINs", () => {
    expect(inferTableFromSql("SELECT * FROM tabCustomer JOIN tabAddress ON ...")).toBe("tabCustomer");
  });
});
