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

function normalizeCustomFieldValue(
  app: Parameters<FastifyPluginAsync>[0],
  definition: Pick<CustomFieldDefinition, "fieldKey" | "dataType" | "optionsJson">,
  value: unknown
): unknown {
  switch (definition.dataType) {
    case CustomFieldDataType.TEXT: {
      if (typeof value !== "string") {
        throw app.httpErrors.badRequest(`Custom field "${definition.fieldKey}" must be text.`);
      }
      const trimmed = value.trim();
      return trimmed.length ? trimmed : null;
    }
    case CustomFieldDataType.NUMBER: {
      const numeric =
        typeof value === "number"
          ? value
          : typeof value === "string" && value.trim().length > 0
            ? Number(value)
            : Number.NaN;
      if (!Number.isFinite(numeric)) {
        throw app.httpErrors.badRequest(`Custom field "${definition.fieldKey}" must be numeric.`);
      }
      return numeric;
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
