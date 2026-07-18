/**
 * Cross-context message protocol. Every message that crosses a context
 * boundary (side panel <-> service worker <-> offscreen doc) is typed here.
 *
 * Conventions:
 *   - side panel -> SW           : Request messages (user intent)
 *   - SW -> side panel           : Event messages (stream deltas, state changes)
 *   - SW -> offscreen / offscreen -> SW : stream open / chunk / close
 *
 * Messages are sent via chrome.runtime.sendMessage / Port.postMessage and carry
 * a `kind` discriminator.
 */

import type { Model, PlanStep, ProviderDefinition, QueuedMessage, Session, SessionState, StreamPart, SuggestedAction } from "../core/types";
import type { UserFact, UserFactCategory } from "../core/storage";

// ---------------------------------------------------------------------------
// side panel -> SW
// ---------------------------------------------------------------------------

export type PanelRequest =
  | { kind: "connect_provider"; providerId: string; credentials: Record<string, string> }
  | { kind: "validate_token"; providerId: string; credentials: Record<string, string> }
  | { kind: "list_providers" }
  | { kind: "list_models"; providerId: string }
  | { kind: "seed_models"; providerId: string }
  | { kind: "select_model"; modelId: string }
  | { kind: "set_autonomy"; mode: "ask" | "auto" }
  | { kind: "send_message"; tabId: number; text: string }
  | { kind: "stop"; sessionId: string }
  | { kind: "pause"; sessionId: string }
  | { kind: "resume"; sessionId: string }
  | { kind: "permission_decision"; sessionId: string; toolCallId: string; decision: PermissionDecision }
  | { kind: "plan_decision"; sessionId: string; planId: string; decision: "approve" | "reject" }
  | { kind: "resume_interrupted"; sessionId: string; action: "retry" | "skip" | "abort" }
  | { kind: "get_state"; sessionId?: string }
  | { kind: "open_side_panel_for_tab"; tabId: number }
  | { kind: "new_session"; tabId: number }
  | { kind: "selection_action"; action: SelectionAction; text: string }
  | { kind: "pop_pending_prompt"; tabId: number }
  | { kind: "set_notifications"; enabled: boolean }
  | { kind: "set_theme"; theme: "light" | "dark" }
  | { kind: "get_memory" }
  | { kind: "set_memory"; fact: { id?: string; category: UserFactCategory; text: string } }
  | { kind: "delete_memory"; id: string }
  | { kind: "export_session"; tabId: number; sessionId?: string };

/** Preset actions offered on the selection-triggered suggestion menu. */
export type SelectionAction = "explain" | "summarize" | "translate" | "rewrite" | "ask";

export type PermissionDecision =
  | "allow"
  | "deny"
  | { kind: "always_allow_on_site"; site: string }
  | { kind: "always_allow_tool_on_site"; site: string; tool: string };

// ---------------------------------------------------------------------------
// SW -> side panel (events)
// ---------------------------------------------------------------------------

export type PanelEvent =
  | { kind: "session_state"; session: Session }
  | { kind: "stream_part"; sessionId: string; part: StreamPart }
  | { kind: "assistant_message"; sessionId: string; message: Session["history"][number] }
  | { kind: "tool_call_started"; sessionId: string; name: string; input: Record<string, unknown> }
  | { kind: "tool_result"; sessionId: string; name: string; content: string; isError?: boolean }
  | { kind: "permission_request"; sessionId: string; toolCallId: string; name: string; input: Record<string, unknown>; reason: string; site?: string }
  | { kind: "plan_proposed"; sessionId: string; planId: string; steps: PlanStep[] }
  | { kind: "plan_step_update"; sessionId: string; stepId: string; status: "pending" | "progress" | "done" }
  | { kind: "actions_suggested"; sessionId: string; messageId: string; actions: SuggestedAction[] }
  | { kind: "queue_update"; sessionId: string; queue: QueuedMessage[] }
  | { kind: "interrupted"; sessionId: string; pendingToolCalls: { id: string; name: string }[] }
  | { kind: "error"; sessionId?: string; message: string }
  | { kind: "cost_update"; sessionId: string; costUsd: number; flatRate: boolean }
  | { kind: "providers"; providers: ProviderDefinition[] }
  | { kind: "models"; providerId: string; models: Model[] }
  | { kind: "memory_update"; facts: UserFact[] };

// ---------------------------------------------------------------------------
// SW -> offscreen
// ---------------------------------------------------------------------------

export type OffscreenRequest =
  | {
      kind: "open_stream";
      streamKey: string; // `${sessionId}::${runId}::${stepId}`
      url: string;
      headers: Record<string, string>;
      body: string;
    }
  | { kind: "abort_stream"; streamKey: string }
  | { kind: "peek_stream"; streamKey: string } // SW restart recovery
  | { kind: "ping" }
  | { kind: "play_sound"; volume?: number }; // notification chime (Web Audio in the offscreen doc)

// ---------------------------------------------------------------------------
// offscreen -> SW
// ---------------------------------------------------------------------------

export type OffscreenEvent =
  | { kind: "stream_part"; streamKey: string; part: StreamPart }
  | { kind: "stream_end"; streamKey: string }
  | { kind: "stream_error"; streamKey: string; error: { message: string; status?: number; retryable?: boolean } }
  | { kind: "stream_peek_result"; streamKey: string; alive: boolean }
  | { kind: "pong" };

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

export function isPanelState(s: SessionState): boolean {
  return s === "idle" || s === "done" || s === "error" || s === "paused";
}

/** Send a request and await the response (chrome.runtime.sendMessage wrapper). */
export async function send<T = unknown>(msg: unknown): Promise<T> {
  const resp = (await chrome.runtime.sendMessage(msg)) as { ok: true; data: T } | { ok: false; error: string };
  if (!resp || !resp.ok) {
    throw new Error(resp?.error ?? "no response");
  }
  return resp.data;
}
