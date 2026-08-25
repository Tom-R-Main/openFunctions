/**
 * OpenFunction — Tool Builder
 *
 * The `defineTool` function is the main way students create tools.
 * It validates the definition and returns a properly typed ToolDefinition.
 *
 * Derived from ExecuFunction's tool registration pattern, simplified
 * to remove auth, RLS, activity events, and other production concerns.
 */

import type { ToolDefinition, InputSchema, ToolResult } from "./types.js";

export interface NormalizedToolExecution {
  /** JSON-normalized result shared by receipts, callers, and model history. */
  result: ToolResult;
  /** Exact JSON supplied to the model. */
  modelContent: string;
  /** Effective executor outcome, including the default derived from success. */
  outcome: NonNullable<ToolResult["executionOutcome"]>;
}

function toolExecutionErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  try {
    return String(error);
  } catch {
    return "Unknown tool executor error";
  }
}

/**
 * Convert an executor failure into a model-safe receipt without claiming that
 * the underlying side effect failed. A rejection may happen after the effect.
 */
export function uncertainToolExecution(error: unknown): NormalizedToolExecution {
  const result: ToolResult = {
    success: false,
    error: `Tool execution outcome is unknown: ${toolExecutionErrorMessage(error)}`,
    executionOutcome: "unknown",
  };
  return {
    result,
    modelContent: JSON.stringify(result),
    outcome: "unknown",
  };
}

/**
 * Establish one canonical result at the executor/model boundary. JSON hooks
 * such as toJSON() are applied exactly once; every downstream decision must
 * use the normalized value returned here, never the pre-serialization object.
 */
export function normalizeToolResult(
  name: string,
  result: ToolResult,
): NormalizedToolExecution {
  try {
    const modelContent = JSON.stringify(result);
    if (modelContent === undefined) {
      throw new Error(`Tool "${name}" returned a non-serializable result`);
    }
    const parsedResult = JSON.parse(modelContent) as unknown;
    if (
      parsedResult === null
      || typeof parsedResult !== "object"
      || Array.isArray(parsedResult)
    ) {
      throw new Error(`Tool "${name}" returned an invalid result`);
    }
    const parsedRecord = parsedResult as Record<string, unknown>;
    if (typeof parsedRecord.success !== "boolean") {
      throw new Error(`Tool "${name}" returned an invalid result`);
    }
    if (
      parsedRecord.error !== undefined
      && typeof parsedRecord.error !== "string"
    ) {
      throw new Error(`Tool "${name}" returned an invalid result`);
    }
    if (
      parsedRecord.message !== undefined
      && typeof parsedRecord.message !== "string"
    ) {
      throw new Error(`Tool "${name}" returned an invalid result`);
    }
    if (
      parsedRecord.executionOutcome !== undefined
      && parsedRecord.executionOutcome !== "succeeded"
      && parsedRecord.executionOutcome !== "failed"
      && parsedRecord.executionOutcome !== "unknown"
    ) {
      throw new Error(`Tool "${name}" returned an invalid result`);
    }
    const normalizedResult = parsedResult as ToolResult;
    return {
      result: normalizedResult,
      modelContent,
      outcome: normalizedResult.executionOutcome
        ?? (normalizedResult.success ? "succeeded" : "failed"),
    };
  } catch (error) {
    return uncertainToolExecution(error);
  }
}

/**
 * Define a new tool that any AI can call.
 *
 * @example
 * ```ts
 * export default defineTool({
 *   name: 'create_task',
 *   description: 'Create a new study task',
 *   inputSchema: {
 *     type: 'object',
 *     properties: {
 *       title: { type: 'string', description: 'What needs to be done' },
 *       due:   { type: 'string', description: 'Due date (YYYY-MM-DD)' },
 *     },
 *     required: ['title'],
 *   },
 *   handler: async ({ title, due }) => {
 *     // Your logic here — call a database, an API, or just use in-memory state
 *     return { success: true, data: { title, due, completed: false } };
 *   },
 * });
 * ```
 */
export function defineTool<
  TParams = Record<string, unknown>,
  TResult = unknown,
>(
  definition: ToolDefinition<TParams, TResult>,
): ToolDefinition<TParams, TResult> {
  // ── Validate the basics ──────────────────────────────────────────────────
  if (!definition.name || !/^[a-z][a-z0-9_]*$/.test(definition.name)) {
    throw new Error(
      `Tool name "${definition.name}" must be snake_case (lowercase letters, numbers, underscores).`,
    );
  }

  if (!definition.description || definition.description.length < 5) {
    throw new Error(
      `Tool "${definition.name}" needs a description (at least 5 characters). ` +
        `This is what the AI reads to decide when to use your tool.`,
    );
  }

  if (!definition.inputSchema?.properties) {
    throw new Error(
      `Tool "${definition.name}" needs an inputSchema with properties. ` +
        `Even if your tool takes no parameters, use: { type: 'object', properties: {} }`,
    );
  }

  if (typeof definition.handler !== "function") {
    throw new Error(
      `Tool "${definition.name}" needs a handler function. ` +
        `This is the code that runs when the AI calls your tool.`,
    );
  }

  return definition;
}

/**
 * Helper to create a success result.
 */
export function ok<T>(data: T, message?: string): ToolResult<T> {
  return { success: true, data, message };
}

/**
 * Helper to create an error result.
 */
export function err(error: string): ToolResult<never> {
  return { success: false, error };
}
