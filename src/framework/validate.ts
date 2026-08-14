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
    if (params[field] === undefined) {
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
    if (value === undefined) continue;

    const prop = schema.properties[key];
    if (!prop) {
      if (schema.additionalProperties === false) {
        errors.push({ field: key, message: `Unexpected parameter "${key}"` });
      } else if (schema.additionalProperties && typeof schema.additionalProperties === "object") {
        errors.push(...validateField(key, value, schema.additionalProperties));
      }
      continue;
    }

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

  if (schema.anyOf && schema.anyOf.some((candidate) => validateField(name, value, candidate).length === 0)) {
    return errors;
  }
  if (schema.anyOf) {
    return [{ field: name, message: `"${name}" does not match any allowed schema` }];
  }

  if (schema.oneOf) {
    const matches = schema.oneOf.filter((candidate) => validateField(name, value, candidate).length === 0);
    if (matches.length === 1) return errors;
    return [{ field: name, message: `"${name}" must match exactly one allowed schema` }];
  }

  if (schema.allOf) {
    for (const candidate of schema.allOf) {
      errors.push(...validateField(name, value, candidate));
    }
    if (errors.length > 0) return errors;
  }

  if ("const" in schema && !Object.is(value, schema.const)) {
    errors.push({
      field: name,
      message: `"${name}" must equal ${JSON.stringify(schema.const)}`,
    });
    return errors;
  }

  // Type check
  const actualType = getJsonSchemaType(value);
  const allowedTypes = schema.type
    ? (Array.isArray(schema.type) ? schema.type : [schema.type])
    : [];
  if (allowedTypes.length > 0 && !allowedTypes.includes(actualType as never)) {
    // Allow integer where number is expected
    if (allowedTypes.includes("number") && actualType === "integer") {
      // Fine — integers are valid numbers
    } else if (allowedTypes.includes("integer") && actualType === "number") {
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
        message: `"${name}" must be ${allowedTypes.join(" or ")}, got ${actualType} (${JSON.stringify(value)})`,
      });
      return errors; // Skip further checks if type is wrong
    }
  }

  // Enum check — JSON Schema enums can hold any primitive (number,
  // boolean, string), not just strings. Avoid coercing here.
  if (schema.enum && !schema.enum.some((candidate) => Object.is(candidate, value))) {
    errors.push({
      field: name,
      message: `"${name}" must be one of: ${schema.enum.join(", ")} — got "${value}"`,
    });
  }

  // Array items check
  if (allowedTypes.includes("array") && Array.isArray(value) && schema.items && !Array.isArray(schema.items)) {
    for (let i = 0; i < value.length; i++) {
      const itemErrors = validateField(`${name}[${i}]`, value[i], schema.items);
      errors.push(...itemErrors);
    }
  }

  // Nested object check
  if (
    allowedTypes.includes("object") &&
    typeof value === "object" &&
    value !== null &&
    schema.properties
  ) {
    const nestedRequired = new Set(schema.required ?? []);
    const obj = value as Record<string, unknown>;

    for (const field of nestedRequired) {
      if (obj[field] === undefined) {
        errors.push({
          field: `${name}.${field}`,
          message: `Required field "${name}.${field}" is missing`,
        });
      }
    }

    for (const [key, val] of Object.entries(obj)) {
      if (val === undefined) continue;
      const propSchema = schema.properties[key];
      if (propSchema) {
        const fieldErrors = validateField(`${name}.${key}`, val, propSchema);
        errors.push(...fieldErrors);
      } else if (schema.additionalProperties === false) {
        errors.push({ field: `${name}.${key}`, message: `Unexpected field "${name}.${key}"` });
      } else if (schema.additionalProperties && typeof schema.additionalProperties === "object") {
        errors.push(...validateField(`${name}.${key}`, val, schema.additionalProperties));
      }
    }
  }

  if (typeof value === "string") {
    if (schema.minLength !== undefined && value.length < schema.minLength) {
      errors.push({ field: name, message: `"${name}" must contain at least ${schema.minLength} characters` });
    }
    if (schema.maxLength !== undefined && value.length > schema.maxLength) {
      errors.push({ field: name, message: `"${name}" must contain at most ${schema.maxLength} characters` });
    }
    if (schema.pattern !== undefined && !new RegExp(schema.pattern).test(value)) {
      errors.push({ field: name, message: `"${name}" must match ${schema.pattern}` });
    }
  }

  if (typeof value === "number") {
    if (schema.minimum !== undefined && value < schema.minimum) errors.push({ field: name, message: `"${name}" must be at least ${schema.minimum}` });
    if (schema.maximum !== undefined && value > schema.maximum) errors.push({ field: name, message: `"${name}" must be at most ${schema.maximum}` });
    if (schema.exclusiveMinimum !== undefined && value <= schema.exclusiveMinimum) errors.push({ field: name, message: `"${name}" must be greater than ${schema.exclusiveMinimum}` });
    if (schema.exclusiveMaximum !== undefined && value >= schema.exclusiveMaximum) errors.push({ field: name, message: `"${name}" must be less than ${schema.exclusiveMaximum}` });
  }

  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) errors.push({ field: name, message: `"${name}" must contain at least ${schema.minItems} items` });
    if (schema.maxItems !== undefined && value.length > schema.maxItems) errors.push({ field: name, message: `"${name}" must contain at most ${schema.maxItems} items` });
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
