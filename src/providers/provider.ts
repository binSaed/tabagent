/**
 * Provider abstraction.
 *
 * The contract every adapter implements. Three methods + a small surface for
 * adapter identity. The loop speaks only `streamChat` and reads `StreamPart`s;
 * it never sees provider-specific SSE shapes.
 *
 * Adapted from crush's `LanguageModel.Stream` -> `iter.Seq[StreamPart]`,
 * translated to an async generator (the JS analog of Go's range-over-func).
 */

import type {
  Message,
  Model,
  StreamPart,
  ToolInfo,
} from "../core/types";

/** Adapter-side view of a tool: just the schema the model needs. */
export interface ProviderTool extends ToolInfo {}

export interface StreamChatRequest {
  model: Model;
  messages: Message[];
  tools: ProviderTool[];
  signal: AbortSignal;
  /** True when the model should emit reasoning (if it supports it). */
  reasoning?: boolean;
  reasoningEffort?: string;
  maxTokens?: number;
  /** System prompt(s) prepended. */
  system?: string;
  /** Temperature override (omit for provider default). */
  temperature?: number;
}

export interface ListModelsResult {
  models: Model[];
}

export interface ValidateResult {
  ok: boolean;
  /** Provider-facing error message when ok=false. */
  error?: string;
}

export interface ProviderAdapter {
  /** Stable id matching the ProviderDefinition.type. */
  readonly type: "openai-compat" | "anthropic" | "gemini";

  /** Validate credentials + fetch the model catalog. */
  listModels(ctx: ProviderContext): Promise<ListModelsResult>;

  /**
   * Validate credentials with a single lightweight request. Used by the
   * connect flow to confirm a key works BEFORE persisting it. Must not throw
   * on auth failure -- returns { ok: false, error } instead.
   */
  validateCredentials(ctx: ProviderContext): Promise<ValidateResult>;

  /** Stream a chat completion. Yields StreamPart until a terminal `finish`/`error`. */
  streamChat(req: StreamChatRequest, ctx: ProviderContext): AsyncGenerator<StreamPart>;
}

/** Everything an adapter needs at request time. */
export interface ProviderContext {
  baseURL: string;
  /** keyed by AuthField.key */
  credentials: Record<string, string>;
  extraHeaders?: Record<string, string>;
  /** Per-request extra body merged in (e.g. Z.AI `tool_stream`). */
  extraBody?:
    | Record<string, unknown>
    | ((m: { model: Model; reasoning: boolean }) => Record<string, unknown>);
  /** True for subscription providers (display-only; no per-token cost). */
  flatRate?: boolean;
  /** Seed catalog used when the provider has no /models endpoint. */
  seedModels?: Model[];
  /** Tolerate these statuses on the list-models health check (Z.AI: 401). */
  tolerateStatusOnList?: number[];
  providerId: string;
}
