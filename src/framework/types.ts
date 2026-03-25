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
  enum?: string[];
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
