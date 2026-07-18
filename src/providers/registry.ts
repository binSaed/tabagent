/**
 * Provider registry + factory.
 *
 * Maps ProviderDefinition.type -> adapter. Adding a new OpenAI-compatible
 * provider requires only a new catalog entry; adding a new adapter family
 * requires a new case here.
 */

import { NotImplementedError } from "../core/types";
import type { ProviderDefinition } from "../core/types";
import { OpenAICompatAdapter } from "./openai-compat";
import type { ProviderAdapter, ProviderContext } from "./provider";

const REGISTRY: Record<string, ProviderAdapter> = {
  "openai-compat": OpenAICompatAdapter,
  // "anthropic": AnthropicAdapter,  // future
  // "gemini":     GeminiAdapter,    // future
};

export function getAdapter(type: ProviderDefinition["type"]): ProviderAdapter {
  const a = REGISTRY[type];
  if (a) return a;
  throw new NotImplementedError(`adapter for provider type "${type}"`);
}

/**
 * Build the ProviderContext the adapter reads at request time. Credentials
 * are resolved from the session-area working copy (never the encrypted at-rest
 * envelope) and the custom provider's user-supplied baseURL is honored.
 */
export function buildContext(
  def: ProviderDefinition,
  credentials: Record<string, string>,
): ProviderContext {
  // Custom provider: baseURL comes from the user-entered field, not the catalog.
  let baseURL = def.baseURL;
  if (def.id === "custom" && credentials.baseURL) {
    baseURL = credentials.baseURL.replace(/\/+$/, "");
  }

  return {
    providerId: def.id,
    baseURL,
    credentials,
    extraHeaders: def.extraHeaders,
    extraBody: def.extraBody,
    flatRate: def.flatRate,
    seedModels: def.models,
    // Z.AI's /models endpoint returns 401 even with a valid chat key.
    tolerateStatusOnList: def.id === "zai" || def.id === "zhipu" ? [401] : [],
  };
}
