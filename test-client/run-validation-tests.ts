#!/usr/bin/env tsx
/** Offline schema/dialect regression tests using Node's test runner. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { validateParams, formatValidationErrors } from "../src/framework/validate.js";
import type { InputSchema, JsonSchemaProperty } from "../src/framework/types.js";

function input(property: JsonSchemaProperty): InputSchema {
  return { type: "object", properties: { value: property }, required: ["value"] };
}
function rejects(value: unknown, property: JsonSchemaProperty): void {
  assert.notDeepEqual(validateParams({ value }, input(property)), []);
}
function accepts(value: unknown, property: JsonSchemaProperty): void {
  assert.deepEqual(validateParams({ value }, input(property)), []);
}

for (const [name, schema, valid, invalid] of [
  ["anyOf sibling numeric bound", { anyOf: [{ type: "number" }, { type: "null" }], minimum: 3 }, 3, 2],
  ["oneOf sibling string pattern", { oneOf: [{ type: "string" }, { type: "null" }], pattern: "^safe$" }, "safe", "unsafe"],
  ["allOf sibling string length", { allOf: [{ type: "string" }], minLength: 3 }, "abc", "ab"],
  ["anyOf sibling object constraints", { anyOf: [{ type: "object" }], properties: { n: { minimum: 1 } }, required: ["n"], additionalProperties: false }, { n: 1 }, { n: 0, extra: true }],
  ["union type", { type: ["integer", "null"], maximum: 3 }, null, 4],
  ["constraints without redundant type", { maxLength: 3 }, "abc", "abcd"],
  ["deep const", { const: { nested: [{ a: 1, b: 2 }] } }, { nested: [{ b: 2, a: 1 }] }, { nested: [{ a: 1, b: 3 }] }],
  ["deep enum", { enum: [{ items: [1, 2] }, null] }, { items: [1, 2] }, { items: [2, 1] }],
  ["draft07 tuple", { type: "array", items: [{ type: "string" }, { type: "integer" }], additionalItems: false }, ["a", 1], [1, "a"]],
  ["nested additional properties", { type: "object", additionalProperties: { type: "integer" } }, { a: 1 }, { a: "1" }],
  ["multipleOf", { type: "number", multipleOf: 2 }, 4, 3],
  ["uniqueItems uses structural equality", { type: "array", uniqueItems: true }, [{ a: 1 }, { a: 2 }], [{ a: 1 }, { a: 1 }]],
  ["not", { not: { const: "denied" } }, "allowed", "denied"],
  ["conditional schemas", { if: { type: "string" }, then: { pattern: "^safe$" }, else: { minimum: 3 } }, 3, "unsafe"],
  ["unicode string length", { minLength: 2 }, "😀a", "😀"],
] as const) {
  test(`validation: ${name}`, () => {
    accepts(valid, schema as JsonSchemaProperty);
    rejects(invalid, schema as JsonSchemaProperty);
  });
}

test("validation: failed union and sibling constraints both survive error projection", () => {
  const errors = validateParams({ value: "x" }, input({ anyOf: [{ type: "number" }, { type: "null" }], minLength: 3 }));
  assert.equal(errors.length, 2);
  assert.ok(errors.some(({ message }) => message.includes("allowed schema")));
  assert.ok(errors.some(({ message }) => message.includes("3 characters")));
});

test("validation: sibling regression rejects the old short-circuit behavior", () => {
  // The old validator immediately returned success after anyOf matched. This
  // negative control reproduces that admission bug using the same failing input.
  const schema: JsonSchemaProperty = { anyOf: [{ type: "number" }], minimum: 3 };
  const oldAccepted = schema.anyOf?.some((branch) => typeof branch === "object" && branch.type === typeof 2);
  assert.equal(oldAccepted, true);
  rejects(2, schema);
});

test("validation: explicit draft2020-12 prefix tuples and unevaluated properties", () => {
  const schema: InputSchema = {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    type: "object",
    properties: { value: { type: "array", prefixItems: [{ type: "string" }, { type: "integer" }], items: false } },
    unevaluatedProperties: false,
  };
  assert.deepEqual(validateParams({ value: ["a", 1] }, schema), []);
  assert.notDeepEqual(validateParams({ value: ["a", 1, 2] }, schema), []);
  assert.notDeepEqual(validateParams({ value: ["a", 1], extra: 1 }, schema), []);
  assert.notDeepEqual(validateParams({ value: [1, "a"] }, schema), []);
});

test("validation: dialects are selected explicitly, never relabeled", () => {
  for (const uri of ["http://json-schema.org/draft-07/schema", "http://json-schema.org/draft-07/schema#"]) {
    assert.deepEqual(validateParams({ value: ["a"] }, { ...input({ items: [{ type: "string" }] }), $schema: uri }), []);
  }
  const tuple = { ...input({ items: [{ type: "string" }] }), $schema: "https://json-schema.org/draft/2020-12/schema" };
  assert.equal(validateParams({ value: ["a"] }, tuple)[0].field, "$schema");
  for (const uri of ["https://example.invalid/schema", "http://json-schema.org/draft-04/schema#"]) {
    assert.equal(validateParams({}, { type: "object", properties: {}, $schema: uri })[0].field, "$schema");
  }
});

for (const [format, valid, invalid] of [
  ["uuid", "550e8400-e29b-41d4-a716-446655440000", "not-a-uuid"],
  ["date", "2024-02-29", "2025-02-29"],
  ["date-time", "2026-10-12T19:17:04Z", "2026-10-12"],
  ["uri", "https://example.test/path", "relative/path"],
] as const) {
  test(`validation: ${format} assertions`, () => {
    accepts(valid, { type: "string", format });
    rejects(invalid, { type: "string", format });
  });
}

test("validation: unsupported formats/keywords and bad schemas fail closed", () => {
  for (const property of [
    { format: "unsupported-assertion" },
    { pattern: "[" },
    { minLength: -1 },
    { anyOf: [] },
    { minimum: "1" },
    { madeUpAssertion: true },
    { $ref: "https://example.invalid/remote-schema" },
    { $ref: "#/$defs/missing" },
    { $async: true },
  ]) {
    const errors = validateParams({ value: "a" }, input(property as JsonSchemaProperty));
    assert.equal(errors[0]?.field, "$schema", JSON.stringify(property));
  }
});

test("validation: local refs resolve independently for schemas with the same $id", () => {
  const first: InputSchema = {
    $id: "https://example.test/tool",
    $defs: { value: { type: "integer", minimum: 2 } },
    type: "object",
    properties: { value: { $ref: "#/$defs/value" } },
  };
  assert.deepEqual(validateParams({ value: 2 }, first), []);
  assert.notDeepEqual(validateParams({ value: 1 }, first), []);
  const second: InputSchema = { ...first, $defs: { value: { type: "integer", maximum: 1 } } };
  assert.deepEqual(validateParams({ value: 1 }, second), []);
  assert.notDeepEqual(validateParams({ value: 2 }, second), []);
});

test("validation: schema mutations cannot reuse a stale identity-cached validator", () => {
  const schema = input({ type: "integer", minimum: 1 });
  assert.deepEqual(validateParams({ value: 2 }, schema), []);
  schema.properties.value.minimum = 3;
  assert.notDeepEqual(validateParams({ value: 2 }, schema), []);
  schema.properties.value.minimum = 1;
  assert.deepEqual(validateParams({ value: 2 }, schema), []);
});

test("validation: coercion, defaults, and removal remain disabled", () => {
  const schema: InputSchema = { type: "object", properties: { n: { type: "integer", default: 5 } }, additionalProperties: false };
  const missing = Object.freeze({});
  assert.deepEqual(validateParams(missing, schema), []);
  assert.deepEqual(missing, {});
  const original = { n: "2", extra: true };
  const before = structuredClone(original);
  assert.equal(validateParams(original, schema).length, 2);
  assert.deepEqual(original, before);
});

test("validation: all non-finite/non-JSON input values fail without disclosure", () => {
  for (const value of [NaN, Infinity, -Infinity, 1n, undefined, () => 1, new Date()]) {
    assert.notDeepEqual(validateParams({ value }, input({})), []);
  }
  const cycle: Record<string, unknown> = {};
  cycle.self = cycle;
  assert.notDeepEqual(validateParams(cycle, { type: "object", properties: {} }), []);
});

test("validation: safe deterministic paths and errors never contain input values", () => {
  const secret = "do-not-disclose-secret-value";
  const schema: InputSchema = { type: "object", properties: { payload: { type: "object", properties: { "a/b~c": { type: "array", items: { type: "integer" } } }, required: ["a/b~c"] } } };
  const errors = validateParams({ payload: { "a/b~c": [secret] } }, schema);
  assert.equal(errors[0].field, 'payload["a/b~c"][0]');
  assert.ok(!JSON.stringify(errors).includes(secret));
  assert.ok(!formatValidationErrors("tool", errors).includes(secret));
  const numericKey = validateParams({ value: { "0": secret } }, input({ type: "object", additionalProperties: { type: "integer" } }));
  assert.equal(numericKey[0].field, 'value["0"]');
});


test("validation: required unsupported vocabularies fail rather than silently weaken assertions", () => {
  const schema: InputSchema = { type: "object", properties: {}, $schema: "https://json-schema.org/draft/2020-12/schema", $vocabulary: { "https://example.invalid/assertions": true } };
  assert.equal(validateParams({}, schema)[0]?.field, "$schema");
});

test("validation: schema-shaped keys inside const are data, not executable contracts", () => {
  accepts({ $async: true, $ref: "https://example.invalid" }, { const: { $async: true, $ref: "https://example.invalid" } });
});
