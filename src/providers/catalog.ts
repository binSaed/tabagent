/**
 * Built-in provider catalog.
 *
 * Z.AI is the FIRST entry and the default in the connection flow (per the
 * "support the Z.AI coding plan" requirement). The Z.AI / GLM model seeds and
 * the Z.AI-specific request quirks are sourced from crush's catwalk catalog
 * (`internal/providers/configs/zai.json`) and crush's `coordinator.go`.
 */

import type { Model, ProviderDefinition } from "../core/types";

// ---------------------------------------------------------------------------
// Z.AI coding plan (api.z.ai) -- first-class, default provider
// ---------------------------------------------------------------------------

/** Z.AI request-body quirks. Replicates crush coordinator.go behavior. */
function zaiExtraBody({
  model,
  reasoning,
}: {
  model: Model;
  reasoning: boolean;
}): Record<string, unknown> {
  const body: Record<string, unknown> = { tool_stream: true };
  // GLM-5.x reasoning models accept a thinking flag.
  if (model.canReason) {
    body.thinking = { type: reasoning ? "enabled" : "disabled" };
  }
  return body;
}

// ---------------------------------------------------------------------------
// Model seeds.
//
// These are NOT the model list shown to the user. The live /models API is the
// source of truth (see mergeModels in openai-compat.ts). Seeds serve two roles:
//   1. OFFLINE FALLBACK -- shown only if the API is unreachable / returns empty.
//   2. METADATA ENRICHMENT -- /models returns just id + display_name; seeds add
//      context window, reasoning flags, vision flags, max tokens. When the API
//      lists a model that has a matching seed, the seed's richer metadata wins.
// The entries below are kept in sync with the Z.AI /models output (8 models as
// of 2026-07). Vision/flash variants that the API no longer serves were removed
// so the fallback never shows ghost models.
// ---------------------------------------------------------------------------

const zaiModels: Model[] = [
  {
    id: "glm-5.2",
    name: "GLM-5.2",
    apiName: "glm-5.2",
    provider: "zai",
    contextWindow: 1_000_000,
    defaultMaxTokens: 131_072,
    canReason: true,
    reasoningLevels: ["high", "xhigh"],
    defaultReasoningEffort: "xhigh",
    supportsAttachments: false,
    supportsTools: true,
    supportsStreaming: true,
  },
  {
    id: "glm-5.1",
    name: "GLM-5.1",
    apiName: "glm-5.1",
    provider: "zai",
    contextWindow: 204_800,
    defaultMaxTokens: 65_536,
    canReason: true,
    supportsTools: true,
    supportsStreaming: true,
  },
  {
    id: "glm-5-turbo",
    name: "GLM-5-Turbo",
    apiName: "glm-5-turbo",
    provider: "zai",
    contextWindow: 200_000,
    defaultMaxTokens: 128_000,
    canReason: true,
    supportsTools: true,
    supportsStreaming: true,
  },
  {
    id: "glm-5",
    name: "GLM-5",
    apiName: "glm-5",
    provider: "zai",
    contextWindow: 204_800,
    defaultMaxTokens: 65_536,
    canReason: true,
    supportsTools: true,
    supportsStreaming: true,
  },
  {
    id: "glm-4.7",
    name: "GLM-4.7",
    apiName: "glm-4.7",
    provider: "zai",
    contextWindow: 204_800,
    defaultMaxTokens: 98_000,
    canReason: true,
    supportsTools: true,
    supportsStreaming: true,
  },
  {
    id: "glm-4.6",
    name: "GLM-4.6",
    apiName: "glm-4.6",
    provider: "zai",
    contextWindow: 128_000,
    defaultMaxTokens: 16_384,
    supportsTools: true,
    supportsStreaming: true,
  },
  {
    id: "glm-4.5",
    name: "GLM-4.5",
    apiName: "glm-4.5",
    provider: "zai",
    contextWindow: 128_000,
    defaultMaxTokens: 16_384,
    supportsTools: true,
    supportsStreaming: true,
  },
  {
    id: "glm-4.5-air",
    name: "GLM-4.5-Air",
    apiName: "glm-4.5-air",
    provider: "zai",
    contextWindow: 128_000,
    defaultMaxTokens: 16_384,
    supportsTools: true,
    supportsStreaming: true,
  },
];

export const ZAI_PROVIDER: ProviderDefinition = {
  id: "zai",
  name: "Z.AI (Coding Plan)",
  shortName: "Z.AI",
  icon: "Z",
  brandColor: "#396afc",
  type: "openai-compat",
  baseURL: "https://api.z.ai/api/coding/paas/v4",
  modelsEndpoint: "https://api.z.ai/api/coding/paas/v4/models",
  authFields: [
    {
      key: "apiKey",
      label: "Z.AI API Key",
      type: "password",
      required: true,
      placeholder: "xxxxxxxx.xxxxxxxxxxxxxxxx",
      help: "From your Z.AI coding plan dashboard. Sent as Authorization: Bearer.",
    },
  ],
  extraBody: zaiExtraBody,
  defaultLargeModelId: "glm-5.2",
  defaultSmallModelId: "glm-5-turbo",
  flatRate: true, // coding plan is a subscription; skip per-token cost
  models: zaiModels,
  docsUrl: "https://docs.z.ai",
};

// ---------------------------------------------------------------------------
// Zhipu / BigModel (open.bigmodel.cn) -- same GLM roster, different endpoint+key
// ---------------------------------------------------------------------------

export const ZHIPU_PROVIDER: ProviderDefinition = {
  id: "zhipu",
  name: "Zhipu / BigModel",
  shortName: "Zhipu",
  icon: "智",
  brandColor: "#3859ff",
  type: "openai-compat",
  baseURL: "https://open.bigmodel.cn/api/paas/v4",
  modelsEndpoint: "https://open.bigmodel.cn/api/paas/v4/models",
  authFields: [
    {
      key: "apiKey",
      label: "Zhipu API Key",
      type: "password",
      required: true,
      placeholder: "xxxxxxxx.xxxxxxxxxxxxxxxx",
    },
  ],
  extraBody: zaiExtraBody, // same engine family; same quirks apply
  defaultLargeModelId: "glm-4.7",
  defaultSmallModelId: "glm-4.7-flash",
  flatRate: false,
  models: zaiModels.filter((m) => m.id !== "glm-5.2"), // glm-5.2 is Z.AI-exclusive
  docsUrl: "https://open.bigmodel.cn/dev/api",
};

// ---------------------------------------------------------------------------
// OpenAI
// ---------------------------------------------------------------------------

export const OPENAI_PROVIDER: ProviderDefinition = {
  id: "openai",
  name: "OpenAI",
  shortName: "OpenAI",
  icon: "✦",
  brandColor: "#10a37f",
  type: "openai-compat",
  baseURL: "https://api.openai.com/v1",
  modelsEndpoint: "https://api.openai.com/v1/models",
  authFields: [
    { key: "apiKey", label: "OpenAI API Key", type: "password", required: true },
  ],
  defaultLargeModelId: "gpt-4o",
  defaultSmallModelId: "gpt-4o-mini",
  models: [
    {
      id: "gpt-4o",
      name: "GPT-4o",
      apiName: "gpt-4o",
      provider: "openai",
      contextWindow: 128_000,
      defaultMaxTokens: 16_384,
      supportsAttachments: true,
      supportsTools: true,
      supportsStreaming: true,
      costPer1MIn: 2.5,
      costPer1MOut: 10,
    },
    {
      id: "gpt-4o-mini",
      name: "GPT-4o mini",
      apiName: "gpt-4o-mini",
      provider: "openai",
      contextWindow: 128_000,
      defaultMaxTokens: 16_384,
      supportsAttachments: true,
      supportsTools: true,
      supportsStreaming: true,
      costPer1MIn: 0.15,
      costPer1MOut: 0.6,
    },
  ],
  docsUrl: "https://platform.openai.com/docs",
};

// ---------------------------------------------------------------------------
// OpenRouter
// ---------------------------------------------------------------------------

export const OPENROUTER_PROVIDER: ProviderDefinition = {
  id: "openrouter",
  name: "OpenRouter",
  shortName: "OpenRouter",
  icon: "⇄",
  brandColor: "#6467f2",
  type: "openai-compat",
  baseURL: "https://openrouter.ai/api/v1",
  modelsEndpoint: "https://openrouter.ai/api/v1/models",
  authFields: [
    { key: "apiKey", label: "OpenRouter API Key", type: "password", required: true },
  ],
  extraHeaders: { "HTTP-Referer": "https://github.com", "X-Title": "AI Browser Agent" },
  defaultLargeModelId: "anthropic/claude-3.5-sonnet",
  models: [], // fully dynamic via /models
  docsUrl: "https://openrouter.ai/docs",
};

// ---------------------------------------------------------------------------
// Custom OpenAI-compatible (user supplies baseURL + key; Ollama / LM Studio / etc.)
// ---------------------------------------------------------------------------

export const CUSTOM_OPENAI_COMPAT: ProviderDefinition = {
  id: "custom",
  name: "Custom (OpenAI-compatible)",
  shortName: "Custom",
  icon: "⚙",
  brandColor: "#6b7280",
  type: "openai-compat",
  baseURL: "http://localhost:11434/v1", // Ollama default
  modelsEndpoint: "http://localhost:11434/v1/models",
  authFields: [
    { key: "baseURL", label: "Base URL", type: "url", required: true, placeholder: "http://localhost:11434/v1" },
    { key: "apiKey", label: "API Key (optional)", type: "password", required: false, placeholder: "ollama / any-string" },
  ],
  defaultLargeModelId: "",
  models: [],
  docsUrl: "https://github.com/ollama/ollama/blob/main/docs/api.md",
};

// ---------------------------------------------------------------------------
// Anthropic native (STUB)
// ---------------------------------------------------------------------------

export const ANTHROPIC_PROVIDER: ProviderDefinition = {
  id: "anthropic",
  name: "Anthropic (native -- stub)",
  shortName: "Anthropic",
  icon: "A",
  brandColor: "#d97757",
  type: "anthropic",
  baseURL: "https://api.anthropic.com/v1",
  authFields: [{ key: "apiKey", label: "Anthropic API Key", type: "password", required: true }],
  defaultLargeModelId: "claude-3-5-sonnet-20241022",
  models: [
    {
      id: "claude-3-5-sonnet-20241022",
      name: "Claude 3.5 Sonnet",
      apiName: "claude-3-5-sonnet-20241022",
      provider: "anthropic",
      contextWindow: 200_000,
      defaultMaxTokens: 8192,
      supportsAttachments: true,
      supportsTools: true,
      supportsStreaming: true,
      costPer1MIn: 3,
      costPer1MOut: 15,
    },
  ],
  docsUrl: "https://docs.anthropic.com",
};

// ---------------------------------------------------------------------------
// Ordered catalog. Z.AI first (default).
// ---------------------------------------------------------------------------

export const BUILTIN_PROVIDERS: ProviderDefinition[] = [
  ZAI_PROVIDER,
  ZHIPU_PROVIDER,
  OPENAI_PROVIDER,
  OPENROUTER_PROVIDER,
  CUSTOM_OPENAI_COMPAT,
  ANTHROPIC_PROVIDER,
];

export function getProviderDefinition(providerId: string): ProviderDefinition | undefined {
  return BUILTIN_PROVIDERS.find((p) => p.id === providerId);
}
