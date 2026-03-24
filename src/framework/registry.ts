/**
 * OpenFunction — Tool Registry
 *
 * Manages all registered tools and provides format adapters for
 * different AI providers. Derived from ExecuFunction's ToolRegistry,
 * stripped down for simplicity.
 *
 * Key concept: you define your tools ONCE, and the registry makes them
 * available to any AI (Claude via MCP, Gemini via function calling,
 * OpenAI via tools API) without rewriting anything.
 */

import type {
  ToolDefinition,
  ToolResult,
  GeminiFunctionDeclaration,
  AnthropicTool,
  OpenAIFunction,
} from "./types.js";

export class ToolRegistry {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private tools: Map<string, ToolDefinition<any, any>> = new Map();

  // ── Registration ─────────────────────────────────────────────────────────

  /** Register a single tool */
  register(tool: ToolDefinition<any, any>): void {
    if (this.tools.has(tool.name)) {
      console.warn(
        `⚠️  Tool "${tool.name}" is already registered — overwriting.`,
      );
    }
    this.tools.set(tool.name, tool);
  }

  /** Register multiple tools at once */
  registerAll(tools: ToolDefinition<any, any>[]): void {
    for (const tool of tools) {
      this.register(tool);
    }
  }

  // ── Lookup ───────────────────────────────────────────────────────────────

  /** Get a tool by name */
  get(name: string): ToolDefinition<any, any> | undefined {
    return this.tools.get(name);
  }

  /** Get all registered tools */
  getAll(): ToolDefinition<any, any>[] {
    return Array.from(this.tools.values());
  }

  /** Get tools matching a tag */
  getByTag(tag: string): ToolDefinition<any, any>[] {
    return this.getAll().filter((t) => t.tags?.includes(tag));
  }

  /** List all tool names */
  listNames(): string[] {
    return Array.from(this.tools.keys());
  }

  // ── Execution ────────────────────────────────────────────────────────────

  /** Execute a tool by name with the given parameters */
  async execute(
    name: string,
    params: Record<string, unknown>,
  ): Promise<ToolResult> {
    const tool = this.tools.get(name);
    if (!tool) {
      return { success: false, error: `Unknown tool: "${name}"` };
    }

    const start = Date.now();
    try {
      const result = await tool.handler(params);
      const duration = Date.now() - start;
      console.log(`✅ ${name} completed in ${duration}ms`);
      return result;
    } catch (error) {
      const duration = Date.now() - start;
      const message =
        error instanceof Error ? error.message : "Unknown error";
      console.error(`❌ ${name} failed after ${duration}ms: ${message}`);
      return { success: false, error: message };
    }
  }

  // ── Provider Format Adapters ─────────────────────────────────────────────
  //
  // These convert your tool definitions into the format each AI provider
  // expects. This is the "write once, use everywhere" magic.

  /** Convert tools to Gemini function calling format */
  toGeminiFormat(): GeminiFunctionDeclaration[] {
    return this.getAll().map((tool) => ({
      name: tool.name,
      description: tool.description,
      parameters: {
        type: "object" as const,
        properties: tool.inputSchema.properties,
        required: tool.inputSchema.required,
      },
    }));
  }

  /** Convert tools to Anthropic/Claude format */
  toAnthropicFormat(): AnthropicTool[] {
    return this.getAll().map((tool) => ({
      name: tool.name,
      description: tool.description,
      input_schema: tool.inputSchema,
    }));
  }

  /** Convert tools to OpenAI format */
  toOpenAIFormat(): OpenAIFunction[] {
    return this.getAll().map((tool) => ({
      type: "function" as const,
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.inputSchema,
      },
    }));
  }
}

/** Global registry instance — import this to register and access tools */
export const registry = new ToolRegistry();
