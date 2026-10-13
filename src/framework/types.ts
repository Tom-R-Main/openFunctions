/**
 * OpenFunction — Core Types
 *
 * Simplified from ExecuFunction's production tool system.
 * These types define the universal interface for AI-callable tools.
 */

import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { ExecutionMode, ReplayPolicy, ToolExecutionContext } from "./execution-types.js";

// ─── JSON Schema (draft-07 and explicit draft 2020-12) ────────────────────

export type JsonSchemaType =
  | "string" | "number" | "integer" | "boolean" | "array" | "object" | "null";

/** Boolean schemas are valid wherever a subschema is accepted. */
export type JsonSchema = boolean | JsonSchemaProperty;

export interface JsonSchemaProperty {
  $schema?: string;
  $vocabulary?: Record<string, boolean>;
  $id?: string;
  $ref?: string;
  $anchor?: string;
  $dynamicAnchor?: string;
  $dynamicRef?: string;
  $defs?: Record<string, JsonSchema>;
  definitions?: Record<string, JsonSchema>;
  $comment?: string;
  title?: string;
  description?: string;
  type?: JsonSchemaType | JsonSchemaType[];
  enum?: unknown[];
  const?: unknown;
  default?: unknown;
  examples?: unknown[];
  readOnly?: boolean;
  writeOnly?: boolean;
  deprecated?: boolean;
  items?: JsonSchema | JsonSchema[];
  additionalItems?: JsonSchema;
  prefixItems?: JsonSchema[];
  contains?: JsonSchema;
  minContains?: number;
  maxContains?: number;
  unevaluatedItems?: JsonSchema;
  properties?: Record<string, JsonSchemaProperty>;
  patternProperties?: Record<string, JsonSchema>;
  propertyNames?: JsonSchema;
  required?: string[];
  additionalProperties?: JsonSchema;
  unevaluatedProperties?: JsonSchema;
  dependencies?: Record<string, JsonSchema | string[]>;
  dependentRequired?: Record<string, string[]>;
  dependentSchemas?: Record<string, JsonSchema>;
  anyOf?: JsonSchema[];
  oneOf?: JsonSchema[];
  allOf?: JsonSchema[];
  not?: JsonSchema;
  if?: JsonSchema;
  then?: JsonSchema;
  else?: JsonSchema;
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  format?: string;
  minimum?: number;
  maximum?: number;
  exclusiveMinimum?: number;
  exclusiveMaximum?: number;
  multipleOf?: number;
  minItems?: number;
  maxItems?: number;
  uniqueItems?: boolean;
  minProperties?: number;
  maxProperties?: number;
}

export interface InputSchema extends JsonSchemaProperty {
  type: "object";
  properties: Record<string, JsonSchemaProperty>;
}

// ─── Capability Contract ──────────────────────────────────────────────────

/** How consequential a capability's successful effect can be. */
export type CommitmentClass = "C0" | "C1" | "C2" | "C3" | "C4";

/** Duplicate-call behavior callers must understand before retrying. */
export type IdempotencyBehavior =
  | "idempotent"
  | "idempotent_with_key"
  | "non_idempotent";

/**
 * Optional machine-readable semantics for a tool.
 *
 * The ordinary description and JSON Schema remain the beginner path. Add a
 * contract when an agent needs to reason about authority, side effects,
 * retries, and proof instead of inferring those properties from prose.
 */
export interface CapabilityContract {
  /** Version of this capability contract, independent of package version. */
  version: string;
  /** Situations in which selecting this capability is appropriate. */
  useWhen: string[];
  /** Decision boundaries that should select a different capability or stop. */
  doNotUseWhen: string[];
  /** Externally observable effects, or an empty array for a read-only tool. */
  sideEffects: string[];
  /** Preconditions that must hold before invocation. */
  preconditions?: string[];
  /** Whether this capability can mutate state. */
  mutation?: boolean;
  /** Highest commitment this capability can make. */
  commitmentClass: CommitmentClass;
  /** What a duplicate request means. */
  idempotency: IdempotencyBehavior;
  /** Input field used as the idempotency key, when applicable. */
  idempotencyKeyField?: string;
  /** Observable response to an exact duplicate. */
  duplicateBehavior?: string;
  /** How effects can be recovered when execution must be undone. */
  reversibility?: "read_only" | "reversible" | "compensatable" | "irreversible";
  /** Whether the capability supports a non-committing preview. */
  dryRunSupported?: boolean;
  /** Named limits such as timeouts, retry ceilings, or quantity caps. */
  bounds?: Record<string, number | string | boolean>;
  /** Optimistic-concurrency and fencing requirements. */
  concurrency?: {
    revisionField?: string;
    leaseRequired?: boolean;
    fencingRequired?: boolean;
  };
  /** Whether an explicit authority grant is required before execution. */
  requiresAuthority?: boolean;
  /** Verification methods required after a successful effect. */
  requiredVerification?: string[];
}

// ─── Tool Definition ────────────────────────────────────────────────────────

export interface ToolDefinition<
  TParams = Record<string, unknown>,
  TResult = unknown,
> {
  /** Unique snake_case name — this is how the AI refers to the tool */
  name: string;

  /** Human-readable description — the AI reads this to decide when to use it */
  description: string;

  /** JSON Schema describing the parameters the tool accepts */
  inputSchema: InputSchema;

  /** The function that runs when the tool is called */
  handler: (params: TParams, context?: ToolExecutionContext) => Promise<ToolResult<TResult>>;

  /** Optional tags for grouping/filtering (e.g. "productivity", "education") */
  tags?: string[];

  /** Optional examples showing how to use this tool */
  examples?: ToolExample[];

  /** Optional test cases — run with `npm test` */
  tests?: ToolTest[];

  /** Optional execution semantics for consequential or delegated work. */
  contract?: CapabilityContract;
  /** Discovery hints only; these do not confer authority. */
  annotations?: {
    title?: string;
    readOnlyHint?: boolean;
    destructiveHint?: boolean;
    idempotentHint?: boolean;
    openWorldHint?: boolean;
  };
  outputSchema?: InputSchema;
  /** A trusted classifier; absent, invalid, or throwing means exclusive. */
  executionMode?: ExecutionMode | ((params: Readonly<Record<string, unknown>>) => ExecutionMode);
  replayPolicy?: ReplayPolicy;
  /** Provider discovery metadata. Never a grant or replay guarantee. */
  _meta?: Record<string, unknown>;
}

// ─── Tool Test ─────────────────────────────────────────────────────────────

export interface ToolTest {
  /** Short name for this test case (e.g. "creates a task") */
  name: string;

  /** Input parameters to pass to the handler */
  input: Record<string, unknown>;

  /** What to check on the result */
  expect: {
    /** Should the tool succeed or fail? */
    success: boolean;

    /** Optional: check that specific fields exist in result.data */
    data?: Record<string, unknown>;

    /** Optional: check that the error message contains this string */
    errorContains?: string;
  };
}

// ─── Tool Result ────────────────────────────────────────────────────────────

export interface ToolResult<T = unknown> {
  success: boolean;
  data?: T;
  error?: string;
  /** Executor certainty. Handler throws are unknown because effects may have occurred. */
  executionOutcome?: "succeeded" | "failed" | "unknown";
  /** Optional human-friendly message (shown to the user by the AI) */
  message?: string;
  content?: CallToolResult["content"];
  structuredContent?: Record<string, unknown>;
  _meta?: Record<string, unknown>;
}

// ─── Tool Example ───────────────────────────────────────────────────────────

export interface ToolExample {
  description: string;
  input: Record<string, unknown>;
  output: ToolResult;
}

// ─── Provider Formats (for multi-model support) ─────────────────────────────

export interface GeminiFunctionDeclaration {
  name: string;
  description: string;
  parameters: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
  };
}

export interface AnthropicTool {
  name: string;
  description: string;
  input_schema: InputSchema;
}

export interface OpenAIFunction {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: InputSchema;
  };
}
