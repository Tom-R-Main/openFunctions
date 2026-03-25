/**
 * OpenFunction — Parameter Validator
 *
 * Validates tool inputs against the JSON Schema defined in inputSchema
 * before the handler runs. Catches type mismatches, missing required
 * fields, and invalid enum values with clear error messages.
 *
 * This runs automatically on every tool call — students don't need
 * to add validation logic to their handlers.
 */

import type { InputSchema, JsonSchemaProperty } from "./types.js";

export interface ValidationError {
  field: string;
  message: string;
}

/**
 * Validate parameters against an inputSchema.
 * Returns an array of errors (empty = valid).
 */
export function validateParams(
  params: Record<string, unknown>,
  schema: InputSchema,
): ValidationError[] {
  const errors: ValidationError[] = [];
  const required = new Set(schema.required ?? []);

  // Check required fields
  for (const field of required) {
    if (params[field] === undefined || params[field] === null) {
      const prop = schema.properties[field];
      const desc = prop?.description ? ` (${prop.description})` : "";
      errors.push({
        field,
        message: `Required parameter "${field}" is missing${desc}`,
      });
    }
  }

  // Check types and constraints for provided fields
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null) continue;

    const prop = schema.properties[key];
    if (!prop) continue; // Extra params are fine — just ignore

    const fieldErrors = validateField(key, value, prop);
    errors.push(...fieldErrors);
  }

  return errors;
}

/**
 * Validate a single field against its schema property.
 */
function validateField(
  name: string,
  value: unknown,
  schema: JsonSchemaProperty,
): ValidationError[] {
  const errors: ValidationError[] = [];

  // Type check
  const actualType = getJsonSchemaType(value);
  if (actualType !== schema.type) {
    // Allow integer where number is expected
    if (schema.type === "number" && actualType === "integer") {
      // Fine — integers are valid numbers
    } else if (schema.type === "integer" && actualType === "number") {
      // Check if it's actually an integer
      if (!Number.isInteger(value)) {
        errors.push({
          field: name,
          message: `"${name}" must be an integer, got ${value}`,
        });
      }
    } else {
      errors.push({
        field: name,
        message: `"${name}" must be ${schema.type}, got ${actualType} (${JSON.stringify(value)})`,
      });
      return errors; // Skip further checks if type is wrong
    }
  }

  // Enum check
  if (schema.enum && !schema.enum.includes(value as string)) {
    errors.push({
      field: name,
      message: `"${name}" must be one of: ${schema.enum.join(", ")} — got "${value}"`,
    });
  }

  // Array items check
  if (schema.type === "array" && Array.isArray(value) && schema.items) {
    for (let i = 0; i < value.length; i++) {
      const itemErrors = validateField(`${name}[${i}]`, value[i], schema.items);
      errors.push(...itemErrors);
    }
  }

  // Nested object check
  if (
    schema.type === "object" &&
    typeof value === "object" &&
    value !== null &&
    schema.properties
  ) {
    const nestedRequired = new Set(schema.required ?? []);
    const obj = value as Record<string, unknown>;

    for (const field of nestedRequired) {
      if (obj[field] === undefined || obj[field] === null) {
        errors.push({
          field: `${name}.${field}`,
          message: `Required field "${name}.${field}" is missing`,
        });
      }
    }

    for (const [key, val] of Object.entries(obj)) {
      if (val === undefined || val === null) continue;
      const propSchema = schema.properties[key];
      if (propSchema) {
        const fieldErrors = validateField(`${name}.${key}`, val, propSchema);
        errors.push(...fieldErrors);
      }
    }
  }

  return errors;
}

/**
 * Map a JS value to its JSON Schema type name.
 */
function getJsonSchemaType(value: unknown): string {
  if (Array.isArray(value)) return "array";
  if (value === null) return "null";
  const t = typeof value;
  if (t === "number") return Number.isInteger(value) ? "integer" : "number";
  return t; // "string", "boolean", "object"
}

/**
 * Format validation errors into a human-readable string.
 */
export function formatValidationErrors(
  toolName: string,
  errors: ValidationError[],
): string {
  const lines = [`Parameter validation failed for "${toolName}":`];
  for (const err of errors) {
    lines.push(`  - ${err.message}`);
  }
  return lines.join("\n");
}
