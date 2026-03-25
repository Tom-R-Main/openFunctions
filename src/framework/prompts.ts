/**
 * OpenFunction — Composable System Prompts
 *
 * Build system prompts from reusable building blocks. Three ways to use:
 *
 * 1. Programmatic:
 *    const prompt = composePrompt({ role: "...", rules: [...], ... });
 *
 * 2. Preset files:
 *    const prompt = loadPromptPreset("study-buddy", registry);
 *
 * 3. CLI:
 *    npm run chat -- gemini --prompt study-buddy
 *
 * Patterns derived from ExecuFunction's buildPrompt() + chatPersonas,
 * OpenClaw's buildAgentSystemPrompt() + SOUL.md, and Anthropic's
 * research on section ordering and XML tag boundaries.
 */

import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { ToolRegistry } from "./registry.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PRESETS_DIR = join(__dirname, "..", "..", "system-prompts");

// ─── Types ──────────────────────────────────────────────────────────────────

export interface PromptOptions {
  /** Who the AI is — persona, expertise, tone */
  role?: string;

  /** Behavioral constraints and rules */
  rules?: string[];

  /** When/how to use tools — pass "auto" to generate from registry */
  toolGuide?: string | "auto";

  /** Situational context the AI should know */
  context?: string;

  /** Output format preferences */
  format?: string;
}

// ─── Core Composition ───────────────────────────────────────────────────────

/**
 * Compose a system prompt from building blocks.
 *
 * Sections are assembled in research-backed order:
 *   1. Role & Identity
 *   2. Rules & Constraints
 *   3. Tool Guide
 *   4. Context
 *   5. Output Format
 *
 * Each section is wrapped in XML-style tags to prevent instruction bleed.
 *
 * @example
 * ```ts
 * const prompt = composePrompt({
 *   role: "You are a friendly study assistant.",
 *   rules: ["Always use tools — never guess.", "Be concise."],
 *   toolGuide: autoToolGuide(registry),
 *   context: "The user is preparing for finals.",
 *   format: "Use bullet points. Be encouraging.",
 * });
 * ```
 */
export function composePrompt(options: PromptOptions): string {
  const sections: string[] = [];

  if (options.role) {
    sections.push(`<role>\n${options.role.trim()}\n</role>`);
  }

  if (options.rules && options.rules.length > 0) {
    const rulesList = options.rules.map((r) => `- ${r}`).join("\n");
    sections.push(`<rules>\n${rulesList}\n</rules>`);
  }

  if (options.toolGuide) {
    sections.push(
      typeof options.toolGuide === "string"
        ? `<tools>\n${options.toolGuide.trim()}\n</tools>`
        : ""
    );
  }

  if (options.context) {
    sections.push(`<context>\n${options.context.trim()}\n</context>`);
  }

  if (options.format) {
    sections.push(`<format>\n${options.format.trim()}\n</format>`);
  }

  return sections.filter(Boolean).join("\n\n");
}

// ─── Auto Tool Guide ────────────────────────────────────────────────────────

/**
 * Auto-generate tool usage guidance from the registry.
 *
 * Reads every registered tool's name and description, then creates
 * instructions telling the AI when to use each tool. Updates
 * automatically when students add new tools.
 *
 * @example
 * ```ts
 * const guide = autoToolGuide(registry);
 * // → "Available tools — use these instead of guessing:\n- create_task: ..."
 * ```
 */
export function autoToolGuide(registry: ToolRegistry): string {
  const tools = registry.getAll();
  if (tools.length === 0) return "No tools available.";

  const lines = ["Available tools — use these instead of guessing:\n"];

  for (const tool of tools) {
    // Use first sentence of description for conciseness
    const firstSentence = tool.description.split(/\.\s/)[0];
    lines.push(`- ${tool.name}: ${firstSentence}`);
  }

  lines.push(
    "\nAlways prefer using a tool over answering from memory when one is relevant."
  );

  return lines.join("\n");
}

// ─── Preset Loading ─────────────────────────────────────────────────────────

/**
 * Load a prompt preset from system-prompts/<name>.md
 *
 * Preset files use YAML frontmatter + body content.
 * The magic placeholder {{tools}} auto-expands to tool guide from registry.
 *
 * @param name - Preset name (without .md extension)
 * @param registry - Tool registry for {{tools}} expansion
 */
export function loadPromptPreset(
  name: string,
  registry: ToolRegistry,
): string {
  const filePath = join(PRESETS_DIR, `${name}.md`);

  if (!existsSync(filePath)) {
    const available = listPresets();
    throw new Error(
      `Prompt preset "${name}" not found.\n` +
        `  File: ${filePath}\n` +
        `  Available presets: ${available.length > 0 ? available.join(", ") : "(none)"}\n` +
        `  Create your own at: system-prompts/${name}.md`
    );
  }

  let content = readFileSync(filePath, "utf-8");

  // Strip YAML frontmatter
  if (content.startsWith("---")) {
    const endIdx = content.indexOf("---", 3);
    if (endIdx !== -1) {
      content = content.slice(endIdx + 3).trim();
    }
  }

  // Expand {{tools}} placeholder
  if (content.includes("{{tools}}")) {
    const guide = `<tools>\n${autoToolGuide(registry)}\n</tools>`;
    content = content.replace(/\{\{tools\}\}/g, guide);
  }

  return content;
}

/**
 * List available preset names.
 */
export function listPresets(): string[] {
  try {
    const { readdirSync } = require("node:fs");
    return readdirSync(PRESETS_DIR)
      .filter((f: string) => f.endsWith(".md"))
      .map((f: string) => f.replace(/\.md$/, ""));
  } catch {
    return [];
  }
}

// ─── Unified Resolver ───────────────────────────────────────────────────────

/**
 * Resolve a prompt from any input format:
 * - Preset name (e.g. "study-buddy") → loads from system-prompts/
 * - Inline string (e.g. "You are a pirate") → wraps in <role> tag
 * - undefined → loads "default" preset
 *
 * @param input - Preset name, inline prompt string, or undefined
 * @param registry - Tool registry for {{tools}} expansion
 */
export function resolvePrompt(
  input: string | undefined,
  registry: ToolRegistry,
): string {
  // No input → load default preset
  if (!input) {
    try {
      return loadPromptPreset("default", registry);
    } catch {
      // No default.md — fall back to auto-generated
      return composePrompt({
        role: "You are a helpful assistant with access to tools.",
        rules: [
          "Use tools when they're relevant to the user's request.",
          "If a tool fails, explain what went wrong.",
        ],
        toolGuide: autoToolGuide(registry),
      });
    }
  }

  // Check if it's a preset name (no spaces, no special chars beyond hyphens/underscores)
  if (/^[a-zA-Z][a-zA-Z0-9_-]*$/.test(input)) {
    try {
      return loadPromptPreset(input, registry);
    } catch {
      // Not a preset — treat as inline string
    }
  }

  // Inline string — wrap in role tag with auto tool guide
  return composePrompt({
    role: input,
    toolGuide: autoToolGuide(registry),
  });
}
