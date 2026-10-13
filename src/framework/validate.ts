/** JSON Schema admission validation. Validators never mutate caller inputs. */
import { createHash } from "node:crypto";
import { Ajv, type ErrorObject, type Options, type ValidateFunction } from "ajv";
import { Ajv2020 } from "ajv/dist/2020.js";
import formatsPlugin from "ajv-formats";
import type { InputSchema } from "./types.js";

export interface ValidationError {
  field: string;
  message: string;
}

const options: Options = {
  allErrors: true,
  strictSchema: true,
  strictNumbers: true,
  strictTypes: false,
  strictTuples: false,
  strictRequired: false,
  allowUnionTypes: true,
  coerceTypes: false,
  useDefaults: false,
  removeAdditional: false,
  validateFormats: true,
  addUsedSchema: false,
  ownProperties: true,
  logger: false,
};
const draft07 = new Ajv(options);
const draft2020 = new Ajv2020(options);
// Node's ESM/CJS interop exposes the plugin's callable default at runtime.
const addFormats = formatsPlugin as unknown as typeof import("ajv-formats").default;
addFormats(draft07);
addFormats(draft2020);
const cache = new Map<string, ValidateFunction>();
const CACHE_LIMIT = 128;

/** Deterministic JSON encoding also rejects invalid schema values and cycles. */
function canonicalJson(value: unknown, parents = new Set<object>()): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
  if (typeof value !== "object" || value === null || parents.has(value)) {
    throw new Error("Non-JSON value");
  }
  const prototype = Object.getPrototypeOf(value);
  if (!Array.isArray(value) && prototype !== Object.prototype && prototype !== null) {
    throw new Error("Non-JSON object");
  }
  parents.add(value);
  try {
    if (Array.isArray(value)) {
      const entries = Array.from(value, (entry) => canonicalJson(entry, parents));
      return `[${entries.join(",")}]`;
    }
    return `{${Object.keys(value).sort().map((key) =>
      `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key], parents)}`,
    ).join(",")}}`;
  } finally {
    parents.delete(value);
  }
}

function dialectOf(schema: InputSchema): "draft07" | "2020-12" | undefined {
  if (schema.$schema === undefined) return "draft07";
  const uri = schema.$schema.endsWith("#") ? schema.$schema.slice(0, -1) : schema.$schema;
  if (uri === "http://json-schema.org/draft-07/schema") return "draft07";
  if (uri === "https://json-schema.org/draft/2020-12/schema") return "2020-12";
  return undefined;
}

/** Check annotations Ajv recognizes but cannot enforce as application contracts. */
function checkSchemaContracts(schema: unknown): void {
  if (schema === null || typeof schema !== "object" || Array.isArray(schema)) return;
  const object = schema as Record<string, unknown>;
  if (object.$async !== undefined) throw new Error("Async schemas are unsupported");
  if (object.$vocabulary && typeof object.$vocabulary === "object") {
    const supported = new Set([
      "https://json-schema.org/draft/2020-12/vocab/core",
      "https://json-schema.org/draft/2020-12/vocab/applicator",
      "https://json-schema.org/draft/2020-12/vocab/unevaluated",
      "https://json-schema.org/draft/2020-12/vocab/validation",
      "https://json-schema.org/draft/2020-12/vocab/meta-data",
      "https://json-schema.org/draft/2020-12/vocab/format-annotation",
      "https://json-schema.org/draft/2020-12/vocab/format-assertion",
      "https://json-schema.org/draft/2020-12/vocab/content",
    ]);
    for (const [uri, required] of Object.entries(object.$vocabulary)) {
      if (required === true && !supported.has(uri)) throw new Error("Unsupported required vocabulary");
    }
  }
  // Descend through schema locations only; enum/const/default are data and
  // may legitimately contain fields named $async, $ref, or $vocabulary.
  for (const key of ["$defs", "definitions", "properties", "patternProperties", "dependentSchemas", "dependencies"]) {
    const entries = object[key];
    if (entries !== null && typeof entries === "object") {
      for (const child of Object.values(entries)) checkSchemaContracts(child);
    }
  }
  for (const key of ["items", "prefixItems", "anyOf", "oneOf", "allOf", "additionalItems", "contains", "unevaluatedItems", "propertyNames", "additionalProperties", "unevaluatedProperties", "not", "if", "then", "else"]) {
    const child = object[key];
    if (Array.isArray(child)) child.forEach(checkSchemaContracts);
    else checkSchemaContracts(child);
  }
}

function pointerTokens(pointer: string): string[] {
  return pointer.split("/").slice(1).map((part) => part.replace(/~1/g, "/").replace(/~0/g, "~"));
}

/** Identifier paths remain readable; other property names are escaped literals. */
function fieldPath(tokens: string[], params: unknown): string {
  let current = params;
  let field = "";
  for (const token of tokens) {
    if (Array.isArray(current) && /^(0|[1-9][0-9]*)$/.test(token)) field += `[${token}]`;
    else if (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(token)) field += `${field ? "." : ""}${token}`;
    else field += `[${JSON.stringify(token)}]`;
    current = current !== null && typeof current === "object"
      ? (current as Record<string, unknown>)[token] : undefined;
  }
  return field || "$";
}

function schemaAt(schema: InputSchema, pointer: string): Record<string, unknown> | undefined {
  let current: unknown = schema;
  for (const token of pointerTokens(pointer.replace(/^#/, ""))) {
    current = current !== null && typeof current === "object"
      ? (current as Record<string, unknown>)[token] : undefined;
  }
  return current !== null && typeof current === "object" ? current as Record<string, unknown> : undefined;
}

function mapError(error: ErrorObject, params: unknown, schema: InputSchema): ValidationError {
  const tokens = pointerTokens(error.instancePath);
  if (error.keyword === "required") tokens.push(String(error.params.missingProperty));
  if (error.keyword === "additionalProperties") tokens.push(String(error.params.additionalProperty));
  if (error.keyword === "unevaluatedProperties") tokens.push(String(error.params.unevaluatedProperty));
  const field = fieldPath(tokens, params);
  const quoted = JSON.stringify(field);
  let message: string;
  switch (error.keyword) {
    case "required": {
      const parent = schemaAt(schema, error.schemaPath.slice(0, -"/required".length));
      const properties = parent?.properties as Record<string, unknown> | undefined;
      const property = properties?.[String(error.params.missingProperty)] as Record<string, unknown> | undefined;
      const description = typeof property?.description === "string" ? ` (${property.description})` : "";
      message = `Required parameter ${quoted} is missing${description}`;
      break;
    }
    case "type":
      message = `${quoted} must be ${error.params.type === "integer" ? "an integer" : error.params.type}`;
      break;
    case "enum": {
      const allowed = error.params.allowedValues as unknown[];
      message = `${quoted} must be one of: ${allowed.map((value) => typeof value === "string" ? value : JSON.stringify(value)).join(", ")}`;
      break;
    }
    case "additionalProperties": case "unevaluatedProperties":
      message = `Unexpected parameter ${quoted}`; break;
    case "const": message = `${quoted} must equal its declared constant`; break;
    case "anyOf": message = `${quoted} does not match any allowed schema`; break;
    case "oneOf": message = `${quoted} must match exactly one allowed schema`; break;
    default:
      // Ajv's message describes the constraint, never the failing instance.
      message = `${quoted} ${error.message ?? "does not satisfy the schema"}`;
  }
  return { field, message };
}

/** Returns all validation errors; invalid/unsupported schemas fail closed. */
export function validateParams(params: Record<string, unknown>, schema: InputSchema): ValidationError[] {
  let validate: ValidateFunction;
  try {
    const dialect = dialectOf(schema);
    if (!dialect) return [{ field: "$schema", message: "Unsupported JSON Schema dialect" }];
    const canonical = canonicalJson(schema);
    checkSchemaContracts(schema);
    const key = `${dialect}:${createHash("sha256").update(canonical).digest("hex")}`;
    const cached = cache.get(key);
    if (cached) {
      cache.delete(key);
      cache.set(key, cached);
      validate = cached;
    } else {
      // Compile a detached canonical schema: Ajv identity caches cannot retain
      // a stale validator if a caller subsequently edits the original object.
      const ajv = dialect === "draft07" ? draft07 : draft2020;
      const detached = JSON.parse(canonical);
      validate = ajv.compile(detached);
      ajv.removeSchema(detached);
      if ("$async" in validate && validate.$async) throw new Error("Asynchronous validation is unsupported");
      cache.set(key, validate);
      if (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value!);
    }
  } catch {
    return [{ field: "$schema", message: "Invalid JSON Schema or unsupported keyword, format, or reference" }];
  }
  try {
    canonicalJson(params);
  } catch {
    return [{ field: "$", message: "Parameters must contain only finite JSON values" }];
  }
  if (validate(params)) return [];
  const errors = validate.errors ?? [];
  // Report a failed union once instead of printing each alternative's errors.
  // Sibling constraints retain their own errors and are never short-circuited.
  const unions = errors.filter((error) => error.keyword === "anyOf" || error.keyword === "oneOf");
  return errors.filter((error) => !unions.some((union) =>
    error !== union && error.schemaPath.startsWith(`${union.schemaPath}/`),
  )).map((error) => mapError(error, params, schema));
}

export function formatValidationErrors(toolName: string, errors: ValidationError[]): string {
  return [`Parameter validation failed for ${JSON.stringify(toolName)}:`,
    ...errors.map((error) => `  - ${error.message}`)].join("\n");
}
