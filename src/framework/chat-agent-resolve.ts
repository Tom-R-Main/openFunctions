/**
 * ChatAgent — Config Resolution
 *
 * Centralizes adapter selection, provider resolution, prompt building,
 * and registry filtering. Extracted from scripts/chat.ts + new capabilities.
 */

import { readFileSync, existsSync } from "node:fs";
import type { AIAdapter, AdapterConfig } from "./adapters/types.js";
import { createGeminiAdapter } from "./adapters/gemini.js";
import { createOpenAIAdapter, createOpenRouterAdapter } from "./adapters/openai.js";
import { createAnthropicAdapter } from "./adapters/anthropic.js";
import { createXAIAdapter } from "./adapters/xai.js";
import type { ToolRegistry } from "./registry.js";
import { ToolRegistry as ToolRegistryClass } from "./registry.js";
import type { ContextProvider } from "./context.js";
import { composePrompt, autoToolGuide, loadPromptPreset, resolvePrompt } from "./prompts.js";
import type { PromptOptions } from "./prompts.js";
import type { ChatAgentConfig } from "./chat-agent-types.js";
import type { ToolDefinition } from "./types.js";

// ─── Adapter Resolution ────────────────────────────────────────────────────

type AdapterFactory = (config?: Partial<AdapterConfig>) => AIAdapter;

const PROVIDER_MAP: Record<string, AdapterFactory> = {
  gemini: createGeminiAdapter,
  openai: createOpenAIAdapter,
  anthropic: createAnthropicAdapter,
  claude: createAnthropicAdapter,
  openrouter: createOpenRouterAdapter,
  xai: createXAIAdapter,
  grok: createXAIAdapter,
};

const ENV_DETECTION_ORDER: Array<{ env: string; factory: AdapterFactory }> = [
  { env: "GEMINI_API_KEY", factory: createGeminiAdapter },
  { env: "OPENAI_API_KEY", factory: createOpenAIAdapter },
  { env: "ANTHROPIC_API_KEY", factory: createAnthropicAdapter },
  { env: "OPENROUTER_API_KEY", factory: createOpenRouterAdapter },
  { env: "XAI_API_KEY", factory: createXAIAdapter },
];

/**
 * Resolve an AI adapter from config. Supports explicit provider name
 * or auto-detection from environment variables.
 */
export function resolveAdapter(config: ChatAgentConfig, systemPrompt?: string): AIAdapter {
  const opts: Partial<AdapterConfig> = {};
  if (config.model) opts.model = config.model;
  if (systemPrompt) opts.systemPrompt = systemPrompt;

  // Explicit provider
  if (config.provider) {
    const factory = PROVIDER_MAP[config.provider.toLowerCase()];
    if (!factory) {
      const available = Object.keys(PROVIDER_MAP).filter(
        (k) => !["claude", "grok"].includes(k),
      );
      throw new Error(
        `Unknown provider "${config.provider}". Available: ${available.join(", ")}`,
      );
    }
    return factory(opts);
  }

  // Auto-detect from env vars
  for (const { env, factory } of ENV_DETECTION_ORDER) {
    if (process.env[env]) return factory(opts);
  }

  throw new Error(
    "No AI provider configured. Set a provider in config or set an API key:\n" +
      "  GEMINI_API_KEY, OPENAI_API_KEY, ANTHROPIC_API_KEY, OPENROUTER_API_KEY, or XAI_API_KEY",
  );
}

// ─── Context Provider Resolution ───────────────────────────────────────────

const KNOWN_PROVIDERS: Record<string, () => Promise<ContextProvider>> = {
  execufunction: async () => {
    const { createExecuFunctionProvider } = await import(
      "../providers/execufunction/index.js"
    );
    return createExecuFunctionProvider();
  },
};

/**
 * Resolve context providers from a mix of string names and ContextProvider instances.
 */
export async function resolveContextProviders(
  providers: (string | ContextProvider)[],
): Promise<ContextProvider[]> {
  const resolved: ContextProvider[] = [];

  for (const p of providers) {
    if (typeof p === "string") {
      const factory = KNOWN_PROVIDERS[p.toLowerCase()];
      if (!factory) {
        const available = Object.keys(KNOWN_PROVIDERS);
        throw new Error(
          `Unknown context provider "${p}". Available: ${available.join(", ")}`,
        );
      }
      resolved.push(await factory());
    } else {
      resolved.push(p);
    }
  }

  return resolved;
}

// ─── System Prompt Resolution ──────────────────────────────────────────────

/**
 * Build the final system prompt from config, with optional context and memory awareness.
 */
export function resolveSystemPrompt(
  config: ChatAgentConfig,
  registry: ToolRegistry,
  options?: { contextBlock?: string; memoryEnabled?: boolean },
): string {
  const { contextBlock, memoryEnabled } = options ?? {};
  let basePrompt: string;

  // Priority: preset > prompt > default
  if (config.preset) {
    basePrompt = loadPromptPreset(config.preset, registry);
  } else if (config.prompt) {
    if (typeof config.prompt === "string") {
      // Check if it's a markdown file path
      if (config.prompt.endsWith(".md") && existsSync(config.prompt)) {
        let content = readFileSync(config.prompt, "utf-8");
        // Strip YAML frontmatter
        if (content.startsWith("---")) {
          const endIdx = content.indexOf("---", 3);
          if (endIdx !== -1) content = content.slice(endIdx + 3).trim();
        }
        // Expand {{tools}} placeholder
        if (content.includes("{{tools}}")) {
          const guide = `<tools>\n${autoToolGuide(registry)}\n</tools>`;
          content = content.replace(/\{\{tools\}\}/g, guide);
        }
        basePrompt = content;
      } else {
        // Inline string or preset name — use existing resolver
        basePrompt = resolvePrompt(config.prompt, registry);
      }
    } else {
      // PromptOptions object
      const promptOpts: PromptOptions = { ...config.prompt };
      if (promptOpts.toolGuide === "auto") {
        promptOpts.toolGuide = autoToolGuide(registry);
      } else if (!promptOpts.toolGuide) {
        promptOpts.toolGuide = autoToolGuide(registry);
      }
      basePrompt = composePrompt(promptOpts);
    }
  } else {
    // No preset or prompt — use default
    basePrompt = resolvePrompt(undefined, registry);
  }

  // Append context block from providers
  if (contextBlock) {
    basePrompt += `\n\n<context>\n${contextBlock}\n</context>`;
  }

  // Append memory awareness when enabled
  if (memoryEnabled) {
    basePrompt +=
      "\n\n<memory>\n" +
      "You have access to persistent memory tools. " +
      "Use store_fact when the user shares important information you should remember across conversations. " +
      "Use recall_facts when you need to remember something from a previous conversation. " +
      "Memory persists across sessions.\n" +
      "</memory>";
  }

  return basePrompt;
}

// ─── Registry Building ─────────────────────────────────────────────────────

/**
 * Build a filtered tool registry from config.
 * Clones tools from the source registry, applying tag filters and exclusions.
 */
export function buildAgentRegistry(
  config: ChatAgentConfig,
  sourceRegistry: ToolRegistry,
): ToolRegistry {
  const agentRegistry = new ToolRegistryClass();

  // Explicit tool array — register directly
  if (Array.isArray(config.tools)) {
    agentRegistry.registerAll(config.tools as ToolDefinition<any, any>[]);
    return agentRegistry;
  }

  // Use provided registry or global
  const source = (config.tools as ToolRegistry) ?? sourceRegistry;
  const allTools = source.getAll();

  for (const tool of allTools) {
    // Exclude by name
    if (config.excludeTools?.includes(tool.name)) continue;

    // Filter by tag (if tags specified, tool must match at least one)
    if (config.toolTags && config.toolTags.length > 0) {
      const matches = config.toolTags.some((tag) => tool.tags?.includes(tag));
      if (!matches) continue;
    }

    agentRegistry.register(tool);
  }

  return agentRegistry;
}
