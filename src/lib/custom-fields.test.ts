/**
 * Unit tests for validateCustomFields and asRecord.
 *
 * validateCustomFields depends on a Fastify `app` instance only for
 * httpErrors.badRequest. We provide a minimal mock that throws a plain Error
 * with the message, which is sufficient to verify validation logic.
 */
import { CustomFieldDataType } from "@prisma/client";
import { describe, expect, it } from "vitest";
import {
  asRecord,
  CustomFieldDefinition,
  validateCustomFields,
} from "./custom-fields.js";

// Minimal Fastify app mock — only httpErrors.badRequest is needed.
const mockApp = {
  httpErrors: {
    badRequest: (msg: string) => new Error(msg),
  },
} as unknown as Parameters<typeof validateCustomFields>[0];

// Helper to build an active field definition.
function fieldDef(
  overrides: Partial<CustomFieldDefinition> & { fieldKey: string; dataType: CustomFieldDataType }
): CustomFieldDefinition {
  return {
    isRequired: false,
    isActive: true,
    optionsJson: null,
    ...overrides,
  };
}

// ── asRecord ─────────────────────────────────────────────────────────────────

describe("asRecord", () => {
  it("returns the object itself for a plain object", () => {
    const obj = { a: 1, b: "two" };
    expect(asRecord(obj)).toEqual(obj);
  });

  it("returns {} for null", () => {
    expect(asRecord(null)).toEqual({});
  });

  it("returns {} for undefined", () => {
    expect(asRecord(undefined)).toEqual({});
  });

  it("returns {} for an array", () => {
    expect(asRecord([1, 2, 3])).toEqual({});
  });

  it("returns {} for a primitive string", () => {
    expect(asRecord("hello")).toEqual({});
  });
});

// ── validateCustomFields ──────────────────────────────────────────────────────

describe("validateCustomFields — TEXT field", () => {
  const defs = [fieldDef({ fieldKey: "notes", dataType: CustomFieldDataType.TEXT })];

  it("accepts a valid text string", () => {
    const result = validateCustomFields(mockApp, defs, { notes: "some text" });
    expect(result).toEqual({ notes: "some text" });
  });

  it("trims whitespace from text values", () => {
    const result = validateCustomFields(mockApp, defs, { notes: "  trimmed  " });
    expect(result).toEqual({ notes: "trimmed" });
  });

  it("omits the field when the value is whitespace-only", () => {
    // whitespace-only trims to "" which is treated as null (omitted)
    const result = validateCustomFields(mockApp, defs, { notes: "   " });
    expect(result).toBeUndefined();
  });

  it("throws badRequest when value is not a string", () => {
    expect(() =>
      validateCustomFields(mockApp, defs, { notes: 42 })
    ).toThrow(/must be text/i);
  });
});

describe("validateCustomFields — NUMBER field", () => {
  const defs = [fieldDef({ fieldKey: "score", dataType: CustomFieldDataType.NUMBER })];

  it("accepts a numeric value", () => {
    expect(validateCustomFields(mockApp, defs, { score: 99 })).toEqual({ score: 99 });
  });

  it("coerces a numeric string", () => {
    expect(validateCustomFields(mockApp, defs, { score: "3.14" })).toEqual({ score: 3.14 });
  });

  it("throws for a non-numeric string", () => {
    expect(() =>
      validateCustomFields(mockApp, defs, { score: "abc" })
    ).toThrow(/must be numeric/i);
  });

  it("throws for NaN", () => {
    expect(() =>
      validateCustomFields(mockApp, defs, { score: NaN })
    ).toThrow(/must be numeric/i);
  });

  it("throws for Infinity", () => {
    expect(() =>
      validateCustomFields(mockApp, defs, { score: Infinity })
    ).toThrow(/must be numeric/i);
  });
});

describe("validateCustomFields — BOOLEAN field", () => {
  const defs = [fieldDef({ fieldKey: "active", dataType: CustomFieldDataType.BOOLEAN })];

  it("accepts true", () => {
    expect(validateCustomFields(mockApp, defs, { active: true })).toEqual({ active: true });
  });

  it("accepts false", () => {
    expect(validateCustomFields(mockApp, defs, { active: false })).toEqual({ active: false });
  });

  it("coerces string 'true'", () => {
    expect(validateCustomFields(mockApp, defs, { active: "true" })).toEqual({ active: true });
  });

  it("coerces string 'false'", () => {
    expect(validateCustomFields(mockApp, defs, { active: "false" })).toEqual({ active: false });
  });

  it("throws for a non-boolean value", () => {
    expect(() =>
      validateCustomFields(mockApp, defs, { active: "yes" })
    ).toThrow(/must be boolean/i);
  });
});

describe("validateCustomFields — DATE field", () => {
  const defs = [fieldDef({ fieldKey: "dueDate", dataType: CustomFieldDataType.DATE })];

  it("accepts a valid ISO date string and normalises to ISO", () => {
    const result = validateCustomFields(mockApp, defs, { dueDate: "2025-06-15" }) as Record<string, unknown>;
    expect(result?.dueDate).toContain("2025-06-15");
  });

  it("throws for an invalid date string", () => {
    expect(() =>
      validateCustomFields(mockApp, defs, { dueDate: "not-a-date" })
    ).toThrow(/invalid date/i);
  });

  it("throws when value is not a string", () => {
    expect(() =>
      validateCustomFields(mockApp, defs, { dueDate: 20250615 })
    ).toThrow(/ISO date string/i);
  });
});

describe("validateCustomFields — SELECT field", () => {
  const defs = [
    fieldDef({
      fieldKey: "status",
      dataType: CustomFieldDataType.SELECT,
      optionsJson: ["open", "closed", "pending"],
    }),
  ];

  it("accepts a value that matches one of the options", () => {
    expect(validateCustomFields(mockApp, defs, { status: "open" })).toEqual({ status: "open" });
  });

  it("throws when value is not in the options list", () => {
    expect(() =>
      validateCustomFields(mockApp, defs, { status: "unknown" })
    ).toThrow(/must match configured options/i);
  });

  it("throws when value is empty string", () => {
    expect(() =>
      validateCustomFields(mockApp, defs, { status: "" })
    ).toThrow(/non-empty option/i);
  });
});

describe("validateCustomFields — required field enforcement", () => {
  const defs = [
    fieldDef({ fieldKey: "name", dataType: CustomFieldDataType.TEXT, isRequired: true }),
    fieldDef({ fieldKey: "notes", dataType: CustomFieldDataType.TEXT, isRequired: false }),
  ];

  it("passes when all required fields are present", () => {
    const result = validateCustomFields(mockApp, defs, { name: "Alice", notes: "hello" });
    expect(result).toEqual({ name: "Alice", notes: "hello" });
  });

  it("passes when only required fields are present (optional omitted)", () => {
    const result = validateCustomFields(mockApp, defs, { name: "Bob" });
    expect(result).toEqual({ name: "Bob" });
  });

  it("throws when a required field is missing", () => {
    expect(() =>
      validateCustomFields(mockApp, defs, { notes: "hello" })
    ).toThrow(/missing required custom field "name"/i);
  });
});

describe("validateCustomFields — unknown / inactive fields", () => {
  const defs = [
    fieldDef({ fieldKey: "active", dataType: CustomFieldDataType.TEXT, isActive: true }),
    fieldDef({ fieldKey: "hidden", dataType: CustomFieldDataType.TEXT, isActive: false }),
  ];

  it("throws for an unknown field key", () => {
    expect(() =>
      validateCustomFields(mockApp, defs, { active: "yes", nonExistent: "x" })
    ).toThrow(/unknown or inactive custom field "nonExistent"/i);
  });

  it("throws when submitting a value for an inactive field", () => {
    expect(() =>
      validateCustomFields(mockApp, defs, { hidden: "value" })
    ).toThrow(/unknown or inactive custom field "hidden"/i);
  });

  it("returns undefined when rawValues is empty and no required fields exist", () => {
    expect(validateCustomFields(mockApp, defs, {})).toBeUndefined();
  });
});
