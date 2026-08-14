/**
 * OpenFunction — Core Types
 *
 * Simplified from ExecuFunction's production tool system.
 * These types define the universal interface for AI-callable tools.
 */

// ─── JSON Schema (subset used for tool parameters) ─────────────────────────

export interface JsonSchemaProperty {
  type: "string" | "number" | "integer" | "boolean" | "array" | "object";
  description?: string;
  /**
   * Allowed values. JSON Schema permits any primitive here, not just
   * strings — an integer field can legitimately constrain to enum: [1, 2, 3].
   */
  enum?: (string | number | boolean)[];
  items?: JsonSchemaProperty;
  properties?: Record<string, JsonSchemaProperty>;
  required?: string[];
  default?: unknown;
}

export interface InputSchema {
  type: "object";
  properties: Record<string, JsonSchemaProperty>;
  required?: string[];
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
  handler: (params: TParams) => Promise<ToolResult<TResult>>;

  /** Optional tags for grouping/filtering (e.g. "productivity", "education") */
  tags?: string[];

  /** Optional examples showing how to use this tool */
  examples?: ToolExample[];

  /** Optional test cases — run with `npm test` */
  tests?: ToolTest[];

  /** Optional execution semantics for consequential or delegated work. */
  contract?: CapabilityContract;
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
  /** Optional human-friendly message (shown to the user by the AI) */
  message?: string;
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
