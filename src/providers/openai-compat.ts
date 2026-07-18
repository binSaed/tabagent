/**
 * OpenAI-compatible provider adapter.
 *
 * One adapter covers: OpenAI, Z.AI (coding plan), Zhipu/BigModel, OpenRouter,
 * Groq, xAI, Together, DeepSeek, Fireworks, Cerebras, Moonshot, Ollama,
 * LM Studio, and any custom OpenAI-compatible endpoint. The differences are
 * pure config: baseURL, headers, auth fields, and (for Z.AI) extra body flags.
 *
 * Crush confirms this pattern: `providers/openaicompat` is a thin wrapper over
 * `providers/openai` that swaps baseURL + apiKey. We do the same here.
 *
 * Streaming: hand-rolled SSE parsing over fetch's ReadableStream. Tool-call
 * argument JSON arrives as fragmented deltas that we accumulate and emit as a
 * complete `tool_call` at the end. OpenAI does NOT stream tool-use
 * block-by-block (unlike Anthropic) -- args come as function-delta chunks
 * reassembled at the end. We model that faithfully.
 *
 * Z.AI quirks (per crush's coordinator.go):
 *   - `tool_stream: true` injected into the request body
 *   - `thinking: { type: "enabled"|"disabled" }` for reasoning models
 *   - `/models` health check tolerates 401
 *
 * Reasoning tokens: Z.AI GLM-5 / DeepSeek stream reasoning via the
 * `reasoning_content` field; we map it to reasoning_* parts.
 */

import type {
  FinishReason,
  Message,
  Model,
  StreamPart,
  TokenUsage,
  ToolCallPart,
} from "../core/types";
import type {
  ListModelsResult,
  ProviderAdapter,
  ProviderContext,
  StreamChatRequest,
  ValidateResult,
} from "./provider";

// ===========================================================================
// Adapter
// ===========================================================================

export const OpenAICompatAdapter: ProviderAdapter = {
  type: "openai-compat",

  async listModels(ctx): Promise<ListModelsResult> {
    const key = ctx.credentials.apiKey ?? ctx.credentials.key ?? "";
    const headers: Record<string, string> = { Authorization: `Bearer ${key}` };
    if (ctx.extraHeaders) Object.assign(headers, ctx.extraHeaders);

    const base = ctx.baseURL.replace(/\/+$/, "");
    const url = base + "/models";

    let resp: Response;
    try {
      resp = await fetch(url, { method: "GET", headers });
    } catch (e) {
      // Network error (CORS, offline, provider unreachable). Fall back to seed.
      if (ctx.seedModels?.length) return { models: withProvider(ctx.seedModels, ctx.providerId) };
      throw new Error(`Could not reach ${url}: ${(e as Error).message}`);
    }

    const tolerate = new Set(ctx.tolerateStatusOnList ?? []);
    if (!resp.ok && !tolerate.has(resp.status)) {
      if (ctx.seedModels?.length) return { models: withProvider(ctx.seedModels, ctx.providerId) };
      throw new Error(`listModels HTTP ${resp.status} ${resp.statusText}`);
    }

    let discovered: Model[] = [];
    if (resp.ok) {
      try {
        // Two shapes in the wild:
        //   OpenAI-compat: { data: [{ id, object: "model", created }] }
        //   Anthropic-compat (Z.AI): { data: [{ id, display_name, type:"model" }] }
        const json = (await resp.json()) as {
          data?: Array<{ id?: string; display_name?: string; created?: number }>;
        };
        discovered = (json.data ?? [])
          .filter((m) => m && typeof m.id === "string")
          .map((m) => ({
            id: m.id!,
            name: m.display_name ?? m.id!,
            apiName: m.id!,
            provider: ctx.providerId,
            // /models returns no capability metadata; defaults set here, seed overrides.
            contextWindow: 128_000,
            defaultMaxTokens: 16_384,
          }));
      } catch {
        discovered = [];
      }
    }
    return mergeModels(discovered, ctx.seedModels ?? [], ctx.providerId);
  },

  async validateCredentials(ctx): Promise<ValidateResult> {
    // Validate by sending a single-token NON-STREAMING chat completion.
    // We deliberately do NOT use /models here: several providers (notably
    // Z.AI's coding plan) return 401 on /models even with a valid chat key,
    // so /models is a false-negative for validity. A 1-token completion is the
    // actual operation the agent performs, so it's a true end-to-end check.
    const key = ctx.credentials.apiKey ?? ctx.credentials.key ?? "";
    if (!key && ctx.providerId !== "custom") {
      return { ok: false, error: "API key is required." };
    }
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Authorization: `Bearer ${key}`,
    };
    if (ctx.extraHeaders) Object.assign(headers, ctx.extraHeaders);

    const base = ctx.baseURL.replace(/\/+$/, "");
    const url = base + "/chat/completions";

    // Pick the cheapest known model for the probe. Prefer a small/flash seed,
    // else the first seed, else a generic name the provider likely accepts.
    const seeds = ctx.seedModels ?? [];
    const model =
      seeds.find((m) => /flash|mini|turbo|air/i.test(m.id))?.apiName ??
      seeds[0]?.apiName ??
      "gpt-4o-mini";

    const body: Record<string, unknown> = {
      model,
      messages: [{ role: "user", content: "ping" }],
      max_tokens: 1,
      stream: false,
    };

    let resp: Response;
    try {
      resp = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
      });
    } catch (e) {
      return {
        ok: false,
        error: `Could not reach ${url}: ${(e as Error).message}`,
      };
    }

    if (resp.ok) return { ok: true };

    // Distinguish auth errors (bad key) from server/transport errors.
    const text = await resp.text().catch(() => "");
    if (resp.status === 401 || resp.status === 403) {
      return {
        ok: false,
        error: `Authentication failed (HTTP ${resp.status}). Check that your API key is correct and has access to this provider.`,
      };
    }
    if (resp.status === 404) {
      return {
        ok: false,
        error: `Endpoint not found (HTTP 404). The base URL may be wrong: ${url}`,
      };
    }
    if (resp.status === 429) {
      // Rate-limited but the key IS valid -- treat as ok so a user isn't
      // blocked from saving a working key by a transient rate limit.
      return { ok: true };
    }
    return {
      ok: false,
      error: `HTTP ${resp.status}: ${truncate(text, 200)}`,
    };
  },

  async *streamChat(req, ctx): AsyncGenerator<StreamPart> {
    const body = buildRequestBody(req, ctx);
    const headers = buildHeaders(req, ctx);

    let resp: Response;
    try {
      resp = await fetch(chatUrl(ctx.baseURL), {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: req.signal,
      });
    } catch (e) {
      if (req.signal.aborted) {
        yield { type: "finish", finishReason: "canceled" };
        return;
      }
      yield {
        type: "error",
        error: { message: `network: ${(e as Error).message}`, retryable: true },
      };
      return;
    }

    if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      const retryable = resp.status === 429 || resp.status >= 500;
      yield {
        type: "error",
        error: {
          message: `HTTP ${resp.status} ${resp.statusText}: ${truncate(text, 500)}`,
          status: resp.status,
          retryable,
        },
      };
      return;
    }
    if (!resp.body) {
      yield { type: "error", error: { message: "no response body", retryable: false } };
      return;
    }

    yield* parseSSE(resp.body, req.signal);
  },
};

// ===========================================================================
// Request building
// ===========================================================================

function chatUrl(baseURL: string): string {
  return baseURL.replace(/\/+$/, "") + "/chat/completions";
}

function buildHeaders(_req: StreamChatRequest, ctx: ProviderContext): Record<string, string> {
  const key = ctx.credentials.apiKey ?? ctx.credentials.key ?? "";
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${key}`,
    Accept: "text/event-stream",
  };
  if (ctx.extraHeaders) Object.assign(headers, ctx.extraHeaders);
  return headers;
}

interface ChatCompletionBody {
  model: string;
  messages: unknown[];
  stream: boolean;
  stream_options: { include_usage: true };
  tools?: unknown[];
  tool_choice?: string;
  max_tokens?: number;
  temperature?: number;
  // Provider-specific passthrough (Z.AI tool_stream / thinking).
  [k: string]: unknown;
}

function buildRequestBody(req: StreamChatRequest, ctx: ProviderContext): ChatCompletionBody {
  const messages = expandMessages(req.system ? [systemMessage(req.system), ...req.messages] : req.messages);
  const body: ChatCompletionBody = {
    model: req.model.apiName,
    messages,
    stream: true,
    stream_options: { include_usage: true },
  };
  if (req.tools.length > 0) {
    body.tools = req.tools.map((t) => ({
      type: "function",
      function: { name: t.name, description: t.description, parameters: t.parameters },
    }));
    body.tool_choice = "auto";
  }
  if (req.maxTokens) body.max_tokens = req.maxTokens;
  if (req.temperature !== undefined) body.temperature = req.temperature;

  // Provider-specific extra body (Z.AI quirks: tool_stream / thinking).
  if (ctx.extraBody) {
    const extra =
      typeof ctx.extraBody === "function"
        ? ctx.extraBody({ model: req.model, reasoning: !!req.reasoning })
        : ctx.extraBody;
    Object.assign(body, extra);
  }
  return body;
}

function systemMessage(text: string): Message {
  return {
    id: `sys-${Math.random().toString(36).slice(2)}`,
    role: "system",
    parts: [{ type: "text", text }],
    createdAt: Date.now(),
  };
}

/**
 * Expand canonical messages to the OpenAI wire shape. Our canonical form keeps
 * N tool_result parts inside a single tool-role message; OpenAI wants one tool
 * message per tool_call_id, so we fan them out here.
 */
function expandMessages(messages: Message[]): unknown[] {
  const out: unknown[] = [];
  for (const m of messages) {
    if (m.role === "system") {
      out.push({ role: "system", content: partsText(m) });
    } else if (m.role === "user") {
      const images = m.parts.filter((p) => p.type === "image");
      const text = partsText(m);
      if (images.length > 0) {
        out.push({
          role: "user",
          content: [
            ...(text ? [{ type: "text", text }] : []),
            ...images.map((img) => ({ type: "image_url", image_url: { url: img.url } })),
          ],
        });
      } else {
        out.push({ role: "user", content: text });
      }
    } else if (m.role === "assistant") {
      const text = partsText(m);
      const toolCalls = m.parts.filter((p) => p.type === "tool_call");
      const obj: Record<string, unknown> = { role: "assistant", content: text || null };
      if (toolCalls.length > 0) {
        obj.tool_calls = toolCalls.map((tc) => ({
          id: tc.id,
          type: "function",
          function: { name: tc.name, arguments: tc.input },
        }));
      }
      out.push(obj);
    } else {
      // tool role: one wire message per result.
      for (const p of m.parts) {
        if (p.type !== "tool_result") continue;
        out.push({ role: "tool", tool_call_id: p.toolCallId, content: p.content });
      }
    }
  }
  return out;
}

function partsText(m: Message): string {
  return m.parts
    .filter((p) => p.type === "text" || p.type === "reasoning")
    .map((p) => (p.type === "text" ? p.text : ""))
    .join("");
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + "..." : s;
}

// ===========================================================================
// SSE parsing
// ===========================================================================

interface ToolAccum {
  id: string;
  name: string;
  args: string;
  started: boolean;
}

async function* parseSSE(
  body: ReadableStream<Uint8Array>,
  signal: AbortSignal,
): AsyncGenerator<StreamPart> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  const toolAccum = new Map<number, ToolAccum>();
  let textStarted = false;
  let reasoningStarted = false;
  let finishReason: FinishReason | undefined;
  let usage: TokenUsage | undefined;

  try {
    while (true) {
      if (signal.aborted) {
        yield { type: "finish", finishReason: "canceled", usage };
        return;
      }
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let sep: number;
      while ((sep = buffer.indexOf("\n\n")) !== -1) {
        const rawEvent = buffer.slice(0, sep);
        buffer = buffer.slice(sep + 2);
        for (const dataStr of parseSseDataLines(rawEvent)) {
          if (dataStr === "[DONE]") continue;
          let chunk: any;
          try {
            chunk = JSON.parse(dataStr);
          } catch {
            continue;
          }
          if (chunk.usage) {
            usage = {
              input: chunk.usage.prompt_tokens ?? 0,
              output: chunk.usage.completion_tokens ?? 0,
              cachedInput: chunk.usage.prompt_tokens_details?.cached_tokens,
              reasoning: chunk.usage.completion_tokens_details?.reasoning_tokens,
            };
          }
          for (const choice of chunk.choices ?? []) {
            const delta = choice.delta ?? {};

            if (typeof delta.content === "string" && delta.content.length > 0) {
              if (!textStarted) {
                textStarted = true;
                yield { type: "text_start" };
              }
              yield { type: "text_delta", delta: delta.content };
            }

            if (typeof delta.reasoning_content === "string" && delta.reasoning_content.length > 0) {
              if (!reasoningStarted) {
                reasoningStarted = true;
                yield { type: "reasoning_start" };
              }
              yield { type: "reasoning_delta", delta: delta.reasoning_content };
            }

            if (Array.isArray(delta.tool_calls)) {
              for (const tc of delta.tool_calls) {
                const idx: number = tc.index ?? 0;
                const fn = tc.function ?? {};
                let entry = toolAccum.get(idx);
                if (!entry) {
                  entry = {
                    id: tc.id ?? `call_${idx}_${Date.now().toString(36)}`,
                    name: fn.name ?? "",
                    args: "",
                    started: false,
                  };
                  toolAccum.set(idx, entry);
                }
                if (tc.id) entry.id = tc.id;
                if (fn.name) entry.name = fn.name;
                if (!entry.started) {
                  entry.started = true;
                  yield {
                    type: "tool_input_start",
                    toolCallId: entry.id,
                    toolCallName: entry.name,
                  };
                }
                if (typeof fn.arguments === "string" && fn.arguments.length > 0) {
                  entry.args += fn.arguments;
                  yield {
                    type: "tool_input_delta",
                    toolCallId: entry.id,
                    delta: fn.arguments,
                  };
                }
              }
            }

            if (choice.finish_reason) finishReason = mapFinish(choice.finish_reason);
          }
        }
      }
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      /* ignore */
    }
  }

  if (textStarted) yield { type: "text_end" };
  if (reasoningStarted) yield { type: "reasoning_end" };

  // Flush accumulated tool calls (OpenAI sometimes omits finish_reason on tool calls).
  for (const idx of [...toolAccum.keys()].sort((a, b) => a - b)) {
    const tc = toolAccum.get(idx)!;
    yield { type: "tool_input_end", toolCallId: tc.id, toolCallName: tc.name };
    const part: ToolCallPart = {
      type: "tool_call",
      id: tc.id,
      name: tc.name,
      input: tc.args,
    };
    yield { type: "tool_call", toolCall: part };
  }

  yield { type: "finish", finishReason: finishReason ?? "end_turn", usage };
}

function parseSseDataLines(raw: string): string[] {
  const out: string[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const t = line.trimStart();
    if (t.startsWith("data:")) out.push(t.slice(5).trimStart());
  }
  return out;
}

function mapFinish(r: string): FinishReason {
  switch (r) {
    case "stop":
      return "end_turn";
    case "length":
      return "max_tokens";
    case "tool_calls":
    case "function_call":
      return "tool_use";
    default:
      return "unknown";
  }
}

// ===========================================================================
// Catalog merge
// ===========================================================================

/**
 * Merge discovered (live API) models with the catalog seed.
 *
 * The API IS the source of truth when it returns a non-empty list: we show
 * exactly what the provider serves -- nothing stale is unioned back in. Seeds
 * are used ONLY to enrich a discovered model's metadata (context window,
 * capabilities, reasoning flags) since /models returns no capability info.
 * Seeds are the fallback ONLY when discovery fails (offline / empty).
 */
function mergeModels(discovered: Model[], seed: Model[], providerId: string): ListModelsResult {
  const seedById = new Map(seed.map((m) => [m.id, m]));
  if (discovered.length > 0) {
    // API truth: keep the discovered model, overlay any richer seed metadata.
    const out = discovered.map((d) => {
      const s = seedById.get(d.id);
      // Seed metadata wins where present (context window, canReason, etc.); the
      // discovered display_name wins as the label.
      return s ? { ...s, provider: providerId, name: d.name } : d;
    });
    return { models: out };
  }
  // Discovery empty/offline: fall back to seeds verbatim.
  return { models: seed.map((m) => ({ ...m, provider: providerId })) };
}

function withProvider(models: Model[], providerId: string): Model[] {
  return models.map((m) => ({ ...m, provider: providerId }));
}
