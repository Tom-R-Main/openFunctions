/**
 * Role-based model policy.
 *
 * Model names are operational defaults, not durable business semantics. Keep
 * them in one decay-aware catalog, resolve them for each run, and persist the
 * exact result in the run manifest.
 */

import type { ReasoningEffort } from "./adapters/types.js";

export const MODEL_POLICY_VERSION = "2026-08-13" as const;

export const MODEL_ROLES = [
  "instant",
  "expert",
  "frontier",
  "background",
] as const;

export type ModelRole = (typeof MODEL_ROLES)[number];

export const MODEL_PROVIDERS = [
  "openai",
  "gemini",
  "anthropic",
  "xai",
  "openrouter",
] as const;

export type ModelProvider = (typeof MODEL_PROVIDERS)[number];

export interface ModelDefault {
  model: string;
  reasoningEffort: ReasoningEffort;
}

export interface ModelSelection extends ModelDefault {
  provider: ModelProvider | string;
  role: ModelRole;
  policyVersion: string;
  resolution: "policy" | "model_override" | "custom_adapter";
}

type ProviderDefaults = Record<ModelRole, ModelDefault>;

/**
 * Defaults grounded in the current Siftable role split and provider catalogs.
 * Provider-specific adapters keep working independently: selecting a provider
 * never silently routes the request to another provider.
 */
export const PROVIDER_MODEL_DEFAULTS: Record<ModelProvider, ProviderDefaults> = {
  openai: {
    instant: { model: "gpt-5.6-luna", reasoningEffort: "low" },
    expert: { model: "gpt-5.6-terra", reasoningEffort: "medium" },
    frontier: { model: "gpt-5.6-sol", reasoningEffort: "low" },
    background: { model: "gpt-5.6-luna", reasoningEffort: "low" },
  },
  gemini: {
    instant: { model: "gemini-3.7-flash", reasoningEffort: "low" },
    expert: { model: "gemini-3.7-flash", reasoningEffort: "medium" },
    frontier: { model: "gemini-3.7-flash", reasoningEffort: "high" },
    background: { model: "gemini-3.7-flash", reasoningEffort: "minimal" },
  },
  openrouter: {
    instant: { model: "google/gemini-3.7-flash", reasoningEffort: "low" },
    expert: { model: "openai/gpt-5.6-terra", reasoningEffort: "medium" },
    frontier: { model: "openai/gpt-5.6-sol", reasoningEffort: "low" },
    background: {
      model: "deepseek/deepseek-v4-flash-0731",
      reasoningEffort: "low",
    },
  },
  anthropic: {
    instant: { model: "claude-haiku-4-5-20251001", reasoningEffort: "none" },
    expert: { model: "claude-sonnet-5", reasoningEffort: "medium" },
    frontier: { model: "claude-opus-5", reasoningEffort: "high" },
    background: { model: "claude-haiku-4-5-20251001", reasoningEffort: "none" },
  },
  xai: {
    instant: { model: "grok-4.5", reasoningEffort: "low" },
    expert: { model: "grok-4.5", reasoningEffort: "medium" },
    frontier: { model: "grok-4.5", reasoningEffort: "high" },
    background: { model: "grok-4.5", reasoningEffort: "low" },
  },
};

const PROVIDER_ALIASES: Record<string, ModelProvider> = {
  openai: "openai",
  gemini: "gemini",
  google: "gemini",
  anthropic: "anthropic",
  claude: "anthropic",
  xai: "xai",
  grok: "xai",
  openrouter: "openrouter",
};

export interface ResolveModelSelectionOptions {
  role?: ModelRole;
  model?: string;
  reasoningEffort?: ReasoningEffort;
}

export function normalizeModelProvider(provider: string): ModelProvider {
  const normalized = PROVIDER_ALIASES[provider.toLowerCase()];
  if (!normalized) {
    throw new Error(
      `Unknown model provider "${provider}". Available: ${MODEL_PROVIDERS.join(", ")}`,
    );
  }
  return normalized;
}

/** Resolve the exact model configuration that must be recorded for a run. */
export function resolveModelSelection(
  provider: string,
  options: ResolveModelSelectionOptions = {},
): ModelSelection {
  const normalizedProvider = normalizeModelProvider(provider);
  const role = options.role ?? "expert";
  const defaults = PROVIDER_MODEL_DEFAULTS[normalizedProvider][role];
  const hasModelOverride = Boolean(options.model?.trim());
  const requestedEffort = options.reasoningEffort ?? defaults.reasoningEffort;

  return {
    provider: normalizedProvider,
    role,
    model: options.model?.trim() || defaults.model,
    reasoningEffort: normalizeProviderEffort(normalizedProvider, requestedEffort),
    policyVersion: MODEL_POLICY_VERSION,
    resolution: hasModelOverride ? "model_override" : "policy",
  };
}

function normalizeProviderEffort(
  provider: ModelProvider,
  effort: ReasoningEffort,
): ReasoningEffort {
  if (provider === "openai" && effort === "minimal") return "none";
  if (provider === "gemini") {
    if (effort === "none") return "minimal";
    if (effort === "xhigh" || effort === "max") return "high";
  }
  if (provider === "xai") {
    if (effort === "none" || effort === "minimal") return "low";
    if (effort === "xhigh" || effort === "max") return "high";
  }
  return effort;
}

/** Describe an injected adapter without pretending it came from this policy. */
export function customAdapterSelection(
  provider: string,
  model: string,
  role: ModelRole = "expert",
): ModelSelection {
  return {
    provider,
    role,
    model,
    reasoningEffort: "none",
    policyVersion: MODEL_POLICY_VERSION,
    resolution: "custom_adapter",
  };
}
