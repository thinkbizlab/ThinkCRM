/**
 * Custom field validation helpers shared across Deal, Customer, Item, and PaymentTerm routes.
 *
 * H9/L1: Extracted from master-data/routes.ts so deals (and any future entities) can reuse
 * the same type-enforcement and required-field checks without duplicating logic.
 */

import { CustomFieldDataType, Prisma } from "@prisma/client";
import type { FastifyPluginAsync } from "fastify";

export type CustomFieldDefinition = {
  fieldKey: string;
  dataType: CustomFieldDataType;
  isRequired: boolean;
  isActive: boolean;
  optionsJson: Prisma.JsonValue | null;
};

export function asRecord(input: unknown): Record<string, unknown> {
  if (!input || Array.isArray(input) || typeof input !== "object") return {};
  return input as Record<string, unknown>;
}

export type CustomFieldDefinitionWithLabel = CustomFieldDefinition & { label: string };

/**
 * Pluck custom-field values out of an xlsx import row by matching column headers
 * (case-insensitive) against each definition's fieldKey or label. Empty cells
 * are dropped so they don't trip the "required" check.
 */
export function extractCustomFieldsFromRow(
  row: Record<string, unknown>,
  definitions: CustomFieldDefinitionWithLabel[]
): Record<string, unknown> {
  const lowerKeys = new Map<string, unknown>();
  for (const [k, v] of Object.entries(row)) {
    lowerKeys.set(k.trim().toLowerCase(), v);
  }
  const out: Record<string, unknown> = {};
  for (const def of definitions) {
    if (!def.isActive) continue;
    const candidates = [def.fieldKey, def.label]
      .filter((x): x is string => typeof x === "string" && x.length > 0)
      .map((s) => s.trim().toLowerCase());
    for (const c of candidates) {
      if (lowerKeys.has(c)) {
        const raw = lowerKeys.get(c);
        if (raw !== null && raw !== undefined && !(typeof raw === "string" && raw.trim() === "")) {
          out[def.fieldKey] = raw;
        }
        break;
      }
    }
  }
  return out;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PHONE_RE = /^[0-9+()\-\s.]{6,20}$/;

function toTrimmedString(
  app: Parameters<FastifyPluginAsync>[0],
  fieldKey: string,
  typeLabel: string,
  value: unknown
): string | null {
  if (typeof value !== "string") {
    throw app.httpErrors.badRequest(`Custom field "${fieldKey}" must be ${typeLabel}.`);
  }
  const trimmed = value.trim();
  return trimmed.length ? trimmed : null;
}

function toNumeric(
  app: Parameters<FastifyPluginAsync>[0],
  fieldKey: string,
  value: unknown
): number {
  const numeric =
    typeof value === "number"
      ? value
      : typeof value === "string" && value.trim().length > 0
        ? Number(value)
        : Number.NaN;
  if (!Number.isFinite(numeric)) {
    throw app.httpErrors.badRequest(`Custom field "${fieldKey}" must be numeric.`);
  }
  return numeric;
}

function normalizeCustomFieldValue(
  app: Parameters<FastifyPluginAsync>[0],
  definition: Pick<CustomFieldDefinition, "fieldKey" | "dataType" | "optionsJson">,
  value: unknown
): unknown {
  switch (definition.dataType) {
    case CustomFieldDataType.TEXT:
    case CustomFieldDataType.TEXTAREA:
      return toTrimmedString(app, definition.fieldKey, "text", value);
    case CustomFieldDataType.EMAIL: {
      const trimmed = toTrimmedString(app, definition.fieldKey, "email", value);
      if (!trimmed) return null;
      if (!EMAIL_RE.test(trimmed)) {
        throw app.httpErrors.badRequest(`Custom field "${definition.fieldKey}" is not a valid email.`);
      }
      return trimmed;
    }
    case CustomFieldDataType.URL: {
      const trimmed = toTrimmedString(app, definition.fieldKey, "a URL", value);
      if (!trimmed) return null;
      try {
        new URL(trimmed);
      } catch {
        throw app.httpErrors.badRequest(`Custom field "${definition.fieldKey}" is not a valid URL.`);
      }
      return trimmed;
    }
    case CustomFieldDataType.PHONE: {
      const trimmed = toTrimmedString(app, definition.fieldKey, "a phone number", value);
      if (!trimmed) return null;
      if (!PHONE_RE.test(trimmed)) {
        throw app.httpErrors.badRequest(`Custom field "${definition.fieldKey}" is not a valid phone number.`);
      }
      return trimmed;
    }
    case CustomFieldDataType.NUMBER:
      return toNumeric(app, definition.fieldKey, value);
    case CustomFieldDataType.CURRENCY: {
      const numeric = toNumeric(app, definition.fieldKey, value);
      return Math.round(numeric * 100) / 100;
    }
    case CustomFieldDataType.BOOLEAN: {
      if (typeof value === "boolean") return value;
      if (typeof value === "string") {
        if (value === "true") return true;
        if (value === "false") return false;
      }
      throw app.httpErrors.badRequest(`Custom field "${definition.fieldKey}" must be boolean.`);
    }
    case CustomFieldDataType.DATE: {
      if (typeof value !== "string") {
        throw app.httpErrors.badRequest(`Custom field "${definition.fieldKey}" must be an ISO date string.`);
      }
      const parsedDate = new Date(value);
      if (Number.isNaN(parsedDate.getTime())) {
        throw app.httpErrors.badRequest(`Custom field "${definition.fieldKey}" has invalid date format.`);
      }
      return parsedDate.toISOString();
    }
    case CustomFieldDataType.SELECT: {
      if (typeof value !== "string" || !value.trim().length) {
        throw app.httpErrors.badRequest(`Custom field "${definition.fieldKey}" must be a non-empty option.`);
      }
      const options = Array.isArray(definition.optionsJson)
        ? definition.optionsJson.filter((o): o is string => typeof o === "string")
        : [];
      if (!options.includes(value)) {
        throw app.httpErrors.badRequest(
          `Custom field "${definition.fieldKey}" value must match configured options.`
        );
      }
      return value;
    }
    case CustomFieldDataType.MULTISELECT: {
      const options = Array.isArray(definition.optionsJson)
        ? definition.optionsJson.filter((o): o is string => typeof o === "string")
        : [];
      const rawArray = Array.isArray(value)
        ? value
        : typeof value === "string" && value.trim().length
          ? value.split(/[,;\n]/).map((s) => s.trim())
          : [];
      const filtered = rawArray.filter((v): v is string => typeof v === "string" && v.length > 0);
      if (!filtered.length) return null;
      for (const v of filtered) {
        if (!options.includes(v)) {
          throw app.httpErrors.badRequest(
            `Custom field "${definition.fieldKey}" value "${v}" is not a configured option.`
          );
        }
      }
      return Array.from(new Set(filtered));
    }
    default:
      return value;
  }
}

export function validateCustomFields(
  app: Parameters<FastifyPluginAsync>[0],
  definitions: CustomFieldDefinition[],
  rawValues: Record<string, unknown>
): Prisma.InputJsonValue | undefined {
  const activeDefinitions = definitions.filter((d) => d.isActive);
  const definitionMap = new Map(activeDefinitions.map((d) => [d.fieldKey, d]));
  const normalized: Record<string, unknown> = {};

  for (const [fieldKey, rawValue] of Object.entries(rawValues)) {
    const definition = definitionMap.get(fieldKey);
    if (!definition) {
      throw app.httpErrors.badRequest(`Unknown or inactive custom field "${fieldKey}".`);
    }
    const normalizedValue = normalizeCustomFieldValue(app, definition, rawValue);
    if (normalizedValue === null || normalizedValue === undefined || normalizedValue === "") continue;
    normalized[fieldKey] = normalizedValue;
  }

  for (const definition of activeDefinitions.filter((d) => d.isRequired)) {
    if (!Object.hasOwn(normalized, definition.fieldKey)) {
      throw app.httpErrors.badRequest(`Missing required custom field "${definition.fieldKey}".`);
    }
  }

  return Object.keys(normalized).length ? (normalized as Prisma.InputJsonValue) : undefined;
}
