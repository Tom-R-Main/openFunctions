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
