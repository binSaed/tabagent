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
  extraHeaders: { "HTTP-Referer": "https://github.com", "X-Title": "TabAgent" },
  defaultLargeModelId: "anthropic/claude-3.5-sonnet",
  models: [], // fully dynamic via /models
  docsUrl: "https://openrouter.ai/docs",
};

// ---------------------------------------------------------------------------
// DeepSeek (api.deepseek.com)
// Config sourced from crush's catwalk catalog (internal/providers/configs/deepseek.json).
// ---------------------------------------------------------------------------

export const DEEPSEEK_PROVIDER: ProviderDefinition = {
  id: "deepseek",
  name: "DeepSeek",
  shortName: "DeepSeek",
  icon: "D",
  brandColor: "#4d6bfe",
  type: "openai-compat",
  baseURL: "https://api.deepseek.com/v1",
  modelsEndpoint: "https://api.deepseek.com/v1/models",
  authFields: [
    { key: "apiKey", label: "DeepSeek API Key", type: "password", required: true },
  ],
  defaultLargeModelId: "deepseek-v4-pro",
  defaultSmallModelId: "deepseek-v4-flash",
  models: [], // fully dynamic via /models
  docsUrl: "https://api-docs.deepseek.com",
};

// ---------------------------------------------------------------------------
// Groq (api.groq.com) -- fast inference for Llama / Mixtral / Kimi / etc.
// Config sourced from crush's catwalk catalog (internal/providers/configs/groq.json).
// Note the base URL includes /openai (not just /v1).
// ---------------------------------------------------------------------------

export const GROQ_PROVIDER: ProviderDefinition = {
  id: "groq",
  name: "Groq",
  shortName: "Groq",
  icon: "⚡",
  brandColor: "#f55036",
  type: "openai-compat",
  baseURL: "https://api.groq.com/openai/v1",
  modelsEndpoint: "https://api.groq.com/openai/v1/models",
  authFields: [
    { key: "apiKey", label: "Groq API Key", type: "password", required: true },
  ],
  defaultLargeModelId: "moonshotai/kimi-k2-instruct-0905",
  defaultSmallModelId: "qwen/qwen3-32b",
  models: [], // fully dynamic via /models
  docsUrl: "https://console.groq.com/docs",
};

// ---------------------------------------------------------------------------
// xAI / Grok (api.x.ai)
// Config sourced from crush's catwalk catalog (internal/providers/configs/xai.json).
// ---------------------------------------------------------------------------

export const XAI_PROVIDER: ProviderDefinition = {
  id: "xai",
  name: "xAI (Grok)",
  shortName: "xAI",
  icon: "𝕏",
  brandColor: "#1d1d1f",
  type: "openai-compat",
  baseURL: "https://api.x.ai/v1",
  modelsEndpoint: "https://api.x.ai/v1/models",
  authFields: [
    { key: "apiKey", label: "xAI API Key", type: "password", required: true },
  ],
  defaultLargeModelId: "grok-4.5",
  defaultSmallModelId: "grok-4.5",
  models: [], // fully dynamic via /models
  docsUrl: "https://docs.x.ai",
};

// ---------------------------------------------------------------------------
// Mistral (api.mistral.ai)
// Not in crush's catalog; standard public OpenAI-compatible config.
// ---------------------------------------------------------------------------

export const MISTRAL_PROVIDER: ProviderDefinition = {
  id: "mistral",
  name: "Mistral",
  shortName: "Mistral",
  icon: "M",
  brandColor: "#ff7000",
  type: "openai-compat",
  baseURL: "https://api.mistral.ai/v1",
  modelsEndpoint: "https://api.mistral.ai/v1/models",
  authFields: [
    { key: "apiKey", label: "Mistral API Key", type: "password", required: true },
  ],
  defaultLargeModelId: "mistral-large-latest",
  defaultSmallModelId: "mistral-small-latest",
  models: [], // fully dynamic via /models
  docsUrl: "https://docs.mistral.ai",
};

// ---------------------------------------------------------------------------
// Fireworks (api.fireworks.ai) -- serverless inference for Llama / Qwen / GLM / etc.
// Config sourced from crush's catwalk catalog (internal/providers/configs/fireworks.json).
// ---------------------------------------------------------------------------

export const FIREWORKS_PROVIDER: ProviderDefinition = {
  id: "fireworks",
  name: "Fireworks AI",
  shortName: "Fireworks",
  icon: "✷",
  brandColor: "#5b3df5",
  type: "openai-compat",
  baseURL: "https://api.fireworks.ai/inference/v1",
  modelsEndpoint: "https://api.fireworks.ai/inference/v1/models",
  authFields: [
    { key: "apiKey", label: "Fireworks API Key", type: "password", required: true },
  ],
  defaultLargeModelId: "accounts/fireworks/models/deepseek-v4-pro",
  defaultSmallModelId: "accounts/fireworks/models/deepseek-v4-flash",
  models: [], // fully dynamic via /models
  docsUrl: "https://docs.fireworks.ai",
};

// ---------------------------------------------------------------------------
// Cerebras (api.cerebras.ai) -- fastest inference for Llama / Qwen / GLM.
// Config sourced from crush's catwalk catalog (internal/providers/configs/cerebras.json).
// ---------------------------------------------------------------------------

export const CEREBRAS_PROVIDER: ProviderDefinition = {
  id: "cerebras",
  name: "Cerebras",
  shortName: "Cerebras",
  icon: "C",
  brandColor: "#e1467f",
  type: "openai-compat",
  baseURL: "https://api.cerebras.ai/v1",
  modelsEndpoint: "https://api.cerebras.ai/v1/models",
  authFields: [
    { key: "apiKey", label: "Cerebras API Key", type: "password", required: true },
  ],
  defaultLargeModelId: "gpt-oss-120b",
  defaultSmallModelId: "zai-glm-4.7",
  models: [], // fully dynamic via /models
  docsUrl: "https://docs.cerebras.ai",
};

// ---------------------------------------------------------------------------
// Moonshot / Kimi (api.moonshot.ai) -- Kimi coding models.
// Config sourced from crush's catwalk catalog (internal/providers/configs/moonshot.json).
// (The Anthropic-format kimi.com/coding endpoint is separate and not implemented here.)
// ---------------------------------------------------------------------------

export const MOONSHOT_PROVIDER: ProviderDefinition = {
  id: "moonshot",
  name: "Moonshot (Kimi)",
  shortName: "Moonshot",
  icon: "M",
  brandColor: "#16181d",
  type: "openai-compat",
  baseURL: "https://api.moonshot.ai/v1",
  modelsEndpoint: "https://api.moonshot.ai/v1/models",
  authFields: [
    { key: "apiKey", label: "Moonshot API Key", type: "password", required: true },
  ],
  defaultLargeModelId: "kimi-k2.7-code",
  defaultSmallModelId: "kimi-k2.5",
  models: [], // fully dynamic via /models
  docsUrl: "https://platform.moonshot.ai/docs",
};

// ---------------------------------------------------------------------------
// Hugging Face router (router.huggingface.co) -- routes to many backends.
// Config sourced from crush's catwalk catalog (internal/providers/configs/huggingface.json).
// Note: model IDs use a "provider/slug:backend" convention (e.g. ":fireworks-ai").
// ---------------------------------------------------------------------------

export const HUGGINGFACE_PROVIDER: ProviderDefinition = {
  id: "huggingface",
  name: "Hugging Face",
  shortName: "HF",
  icon: "🤗",
  brandColor: "#ffcc4d",
  type: "openai-compat",
  baseURL: "https://router.huggingface.co/v1",
  modelsEndpoint: "https://router.huggingface.co/v1/models",
  authFields: [
    { key: "apiKey", label: "HF Token", type: "password", required: true },
  ],
  // OpenRouter-style attribution headers; localized to TabAgent (see OPENROUTER_PROVIDER).
  extraHeaders: { "HTTP-Referer": "https://github.com", "X-Title": "TabAgent" },
  defaultLargeModelId: "zai-org/GLM-5.2:fireworks-ai",
  defaultSmallModelId: "deepseek-ai/DeepSeek-V4-Flash:fireworks-ai",
  models: [], // fully dynamic via /models
  docsUrl: "https://huggingface.co/docs/inference-providers",
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
  DEEPSEEK_PROVIDER,
  GROQ_PROVIDER,
  XAI_PROVIDER,
  MISTRAL_PROVIDER,
  FIREWORKS_PROVIDER,
  CEREBRAS_PROVIDER,
  MOONSHOT_PROVIDER,
  HUGGINGFACE_PROVIDER,
  CUSTOM_OPENAI_COMPAT,
  ANTHROPIC_PROVIDER,
];

export function getProviderDefinition(providerId: string): ProviderDefinition | undefined {
  return BUILTIN_PROVIDERS.find((p) => p.id === providerId);
}
