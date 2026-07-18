/**
 * User memory layer.
 *
 * Builds the "About the user" block injected into the system prompt from the
 * stored facts, and provides a lightweight after-turn extractor that asks the
 * model whether the user revealed a durable fact (name, interest, preference).
 *
 * Mirrors the skills.ts pattern: a module that returns a string spliced into
 * the system prompt at request time (see loop.ts buildSystemPrompt). The facts
 * themselves live in Settings.userMemory (storage.ts).
 */

import type { Message, Model, ToolCallPart, ToolInfo } from "../core/types";
import type { UserFact, UserFactCategory } from "../core/storage";
import { addFact, clearMemory, deleteFactsByMatch, loadMemory } from "../core/storage";
import type { ProviderAdapter, ProviderContext } from "../providers/provider";

// ---------------------------------------------------------------------------
// System-prompt block
// ---------------------------------------------------------------------------

const CATEGORY_LABELS: Record<UserFactCategory, string> = {
  identity: "Identity",
  preference: "Preferences",
  interest: "Interests",
  work: "Work",
  other: "Notes",
};

/**
 * Render the stored facts as a system-prompt block. Returns "" when there are
 * no facts (no token waste on an empty header). Facts are grouped by category
 * for readability; order is fixed so the block is stable across turns.
 */
export function memoryBlock(facts: UserFact[]): string {
  if (!facts || facts.length === 0) return "";
  const order: UserFactCategory[] = ["identity", "preference", "interest", "work", "other"];
  const lines: string[] = ["\n\nABOUT THE USER (what you've learned about them -- use it to personalize your replies; greet by name when natural on the first turn of a session):"];
  for (const cat of order) {
    const items = facts.filter((f) => f.category === cat);
    if (items.length === 0) continue;
    lines.push(`\n${CATEGORY_LABELS[cat]}:`);
    for (const f of items) lines.push(`- ${f.text}`);
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Model-facing tools: remember / forget
// ---------------------------------------------------------------------------

export const REMEMBER_TOOL_INFO: ToolInfo = {
  name: "remember",
  description:
    "Save a durable fact about the user (their name, an interest, a lasting preference, their job, ...). Call this when the user mentions something personal that would be useful to recall in future conversations. Do NOT call it for task-specific or throwaway details. Each fact is one short line.",
  parameters: {
    type: "object",
    properties: {
      category: {
        type: "string",
        enum: ["identity", "preference", "interest", "work", "other"],
        description:
          "identity = name, location, language; preference = how the user likes things done; interest = hobbies, topics; work = job, tools, projects; other = anything else durable.",
      },
      text: {
        type: "string",
        description: "The fact, as a concise self-contained line. e.g. 'Name: Ahmed', 'Prefers replies in Arabic', 'Works as a backend developer'.",
      },
    },
    required: ["category", "text"],
  },
};

export const FORGET_TOOL_INFO: ToolInfo = {
  name: "forget",
  description:
    "Remove a stored fact about the user, identified by a substring of its text. Call this when the user explicitly says to forget something ('I no longer use X', 'forget that'). Use query '*' to forget everything.",
  parameters: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description: "A substring matching the fact(s) to remove (case-insensitive). Pass '*' to clear ALL memory.",
      },
    },
    required: ["query"],
  },
};

export interface RememberCall {
  category: UserFactCategory;
  text: string;
}

export interface ForgetCall {
  query: string;
}

/** Parse a remember tool call. Returns null on malformed input. */
export function parseRememberCall(tc: ToolCallPart): RememberCall | null {
  let raw: unknown;
  try {
    raw = tc.input ? JSON.parse(tc.input) : {};
  } catch {
    return null;
  }
  const r = raw as { category?: unknown; text?: unknown };
  if (typeof r.text !== "string" || !r.text.trim()) return null;
  const allowed: UserFactCategory[] = ["identity", "preference", "interest", "work", "other"];
  const category = (typeof r.category === "string" && allowed.includes(r.category as UserFactCategory)
    ? r.category
    : "other") as UserFactCategory;
  return { category, text: r.text };
}

/** Parse a forget tool call. Returns null on malformed input. */
export function parseForgetAllCall(tc: ToolCallPart): ForgetCall | null {
  let raw: unknown;
  try {
    raw = tc.input ? JSON.parse(tc.input) : {};
  } catch {
    return null;
  }
  const q = (raw as { query?: unknown }).query;
  if (typeof q !== "string" || !q.trim()) return null;
  return { query: q };
}

/**
 * Execute a remember call: persist the fact (deduped by normalized text).
 * Returns the tool-result content string for the model.
 */
export async function executeRemember(call: RememberCall): Promise<{
  content: string;
  isError: boolean;
}> {
  const fact = await addFact(call.text, call.category, "remember_tool");
  if (!fact) {
    return { content: "Nothing to remember (empty text).", isError: true };
  }
  return {
    content: `Remembered: "${fact.text}" (${fact.category}). It will be used to personalize future replies.`,
    isError: false,
  };
}

/**
 * Execute a forget call: remove matching facts. Returns the tool-result content.
 */
export async function executeForget(call: ForgetCall): Promise<{ content: string; isError: boolean }> {
  if (call.query === "*") {
    await clearMemory();
    return { content: "Cleared all memory about you.", isError: false };
  }
  const removed = await deleteFactsByMatch(call.query);
  if (removed === 0) {
    return {
      content: `No stored fact matched "${call.query}". Nothing was removed.`,
      isError: false,
    };
  }
  return {
    content: `Forgot ${removed} fact${removed === 1 ? "" : "s"} matching "${call.query}".`,
    isError: false,
  };
}

// ---------------------------------------------------------------------------
// After-turn automatic extraction
// ---------------------------------------------------------------------------

const EXTRACTION_SYSTEM = `You extract durable facts about the user from a single conversation turn. A "durable fact" is something that will still be true in future conversations: their name, location, language, occupation, long-term interests, or lasting preferences about how they like things done.

Do NOT extract:
- The current task or page content (that is throwaway).
- One-time requests ("translate this now", "click that button").
- Facts about other people.

Respond with ONLY a compact JSON object: {"facts": [{"category": "...", "text": "..."}, ...]}. category is one of: identity, preference, interest, work, other. text is a concise self-contained line. If there is nothing durable in the turn, respond with {"facts": []}.`;

interface ExtractedFact {
  category: UserFactCategory;
  text: string;
}

/**
 * Ask the model (cheap/short call) whether the user revealed durable facts in
 * the latest turn. Fire-and-forget from the loop's perspective: failures are
 * swallowed (returns []). Never throws.
 *
 * Uses the same adapter as the main loop; the caller picks the model. Designed
 * to run after an assistant message is committed.
 */
export async function extractFactsFromTurn(
  adapter: ProviderAdapter,
  ctx: ProviderContext,
  model: Model,
  userText: string,
  assistantText: string,
  signal: AbortSignal,
): Promise<ExtractedFact[]> {
  const allowed: UserFactCategory[] = ["identity", "preference", "interest", "work", "other"];
  const turnUser = (userText ?? "").slice(0, 2000);
  const turnAssistant = (assistantText ?? "").slice(0, 2000);
  const extractMsg: Message = {
    role: "user",
    id: "extract",
    parts: [
      {
        type: "text",
        text: `User said:\n"""\n${turnUser}\n"""\n\nAssistant replied:\n"""\n${turnAssistant}\n"""\n\nExtract durable facts about the user from this turn (JSON only).`,
      },
    ],
    createdAt: Date.now(),
  };
  try {
    let buf = "";
    const gen = adapter.streamChat(
      {
        model,
        messages: [extractMsg],
        tools: [],
        signal,
        reasoning: false,
        maxTokens: 300,
        system: EXTRACTION_SYSTEM,
        temperature: 0,
      },
      ctx,
    );
    for await (const part of gen) {
      if (part.type === "text_delta" && part.delta) buf += part.delta;
      if (part.type === "error") return [];
    }
    const facts = parseExtractionJson(buf);
    return facts.filter(
      (f) => typeof f.text === "string" && f.text.trim() && allowed.includes(f.category),
    );
  } catch {
    return [];
  }
}

function parseExtractionJson(raw: string): ExtractedFact[] {
  if (!raw) return [];
  // The model may wrap JSON in prose or fences; peel it out.
  let s = raw.trim();
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) s = fence[1].trim();
  const start = s.indexOf("{");
  const end = s.lastIndexOf("}");
  if (start >= 0 && end > start) s = s.slice(start, end + 1);
  try {
    const obj = JSON.parse(s) as { facts?: unknown };
    if (!Array.isArray(obj.facts)) return [];
    return obj.facts
      .filter((f): f is { category: string; text: string } =>
        !!f && typeof (f as { text?: unknown }).text === "string",
      )
      .map((f) => ({
        category: (f.category as UserFactCategory) ?? "other",
        text: f.text,
      }));
  } catch {
    return [];
  }
}

/**
 * Persist any extracted facts (deduped). Returns how many were newly stored.
 * Never throws.
 */
export async function storeExtractedFacts(facts: ExtractedFact[]): Promise<number> {
  let added = 0;
  for (const f of facts) {
    const stored = await addFact(f.text, f.category, "extracted");
    if (stored) added += 1;
  }
  return added;
}

// ---------------------------------------------------------------------------
// Shared helpers used by the loop for tool-call handling
// ---------------------------------------------------------------------------

/** Apply a remember call and return the tool result + whether memory changed. */
export async function handleRememberToolCall(tc: ToolCallPart): Promise<{
  toolCallId: string;
  name: string;
  content: string;
  isError: boolean;
  changed: boolean;
}> {
  const parsed = parseRememberCall(tc);
  if (!parsed) {
    return {
      toolCallId: tc.id,
      name: "remember",
      content: "Malformed remember call (needs {category, text}).",
      isError: true,
      changed: false,
    };
  }
  const before = await currentFactCount();
  const res = await executeRemember(parsed);
  const after = await currentFactCount();
  return { toolCallId: tc.id, name: "remember", ...res, changed: after > before };
}

/** Apply a forget call and return the tool result + whether memory changed. */
export async function handleForgetToolCall(tc: ToolCallPart): Promise<{
  toolCallId: string;
  name: string;
  content: string;
  isError: boolean;
  changed: boolean;
}> {
  const parsed = parseForgetAllCall(tc);
  if (!parsed) {
    return {
      toolCallId: tc.id,
      name: "forget",
      content: "Malformed forget call (needs {query}).",
      isError: true,
      changed: false,
    };
  }
  const before = await currentFactCount();
  const res = await executeForget(parsed);
  const after = await currentFactCount();
  return { toolCallId: tc.id, name: "forget", ...res, changed: after !== before };
}

async function currentFactCount(): Promise<number> {
  return (await loadMemory()).facts.length;
}
