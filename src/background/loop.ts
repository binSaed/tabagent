/**
 * The agent loop.
 *
 * A resumable state machine. Each step is checkpointed to storage before its
 * side-effect, so a SW restart (rare during a run because the attached
 * debugger keeps the SW alive, but possible on crash/pause/restart) can resume
 * correctly:
 *
 *   - mid-stream (no assistant message committed yet)   => re-send stream
 *   - mid-tool  (mutating tools may have run)           => STOP and ask the user
 *
 * Invariants (from the design doc):
 *   1. No partial assistant message is ever committed. Only completed streams.
 *   2. No mutating tool is ever auto-replayed on resume.
 *   3. Every state transition writes updatedAt + pendingStep before the side-effect.
 *   4. The debugger is attached only during a run; detached on done/paused/etc.
 */

import {
  type ContentPart,
  type FinishReason,
  type Message,
  type PlanStep,
  type QueuedMessage,
  type Session,
  type StreamPart,
  type SuggestedAction,
  type ToolCall,
  type ToolCallPart,
  type ToolResult,
  uuid,
} from "../core/types";
import { message, suggestedActionsPart, toolMessage } from "../core/messages";
import {
  deleteSession,
  loadSession,
  saveSession,
  loadSettings,
  type UserFact,
  loadMemory,
} from "../core/storage";
import { getAdapter, buildContext } from "../providers/registry";
import { getProviderDefinition } from "../providers/catalog";
import { readProviderCredentials } from "../core/storage";
import { cdpManager } from "./cdp-manager";
import { permissions } from "./permissions";
import { planService } from "./plan-service";
import { activatedSkillInstructions } from "./skills";
import {
  memoryBlock,
  REMEMBER_TOOL_INFO,
  FORGET_TOOL_INFO,
  handleRememberToolCall,
  handleForgetToolCall,
  extractFactsFromTurn,
  storeExtractedFacts,
} from "./user-memory";
import { cdp as cdpCmd } from "../tools/cdp";
import { createBrowserToolRegistry } from "../tools/browser-tools";
import type { AnnotatedTool } from "../tools/tool";

const MAX_STEPS = 200; // safety cap per run -- high enough for complex multi-page
                       // tasks, low enough to prevent infinite loops burning tokens.
/** When this many steps remain, inject a "wrap up" instruction so the agent
 *  finishes gracefully instead of dying at the hard cap. */
const WRAP_UP_REMAINING = 5;
// Cap on a single tool result's persisted content. AX-tree snapshots and
// extractText output can run hundreds of KB on dense pages; without this cap a
// handful of turns blows the 10MB chrome.storage.session quota. 20KB is enough
// for the model to reason about a page region; it can re-snapshot for more.
const MAX_PERSISTED_TOOL_RESULT = 20_000;

/** Truncate a tool result's content (middle-cut) to bound storage + context. */
function capToolResult(r: ToolResult, max: number): ToolResult {
  if (r.content.length <= max) return r;
  const half = Math.floor(max / 2);
  const dropped = r.content.length - max;
  return {
    ...r,
    content:
      r.content.slice(0, half) +
      `\n...[truncated ${dropped} chars]...\n` +
      r.content.slice(-half),
  };
}

const browserTools = createBrowserToolRegistry();

// ---------------------------------------------------------------------------
// Events to the UI
// ---------------------------------------------------------------------------

export type LoopEvent =
  | { type: "state"; session: Session }
  | { type: "stream_part"; sessionId: string; part: StreamPart }
  | { type: "assistant_committed"; sessionId: string; message: Message }
  | { type: "tool_started"; sessionId: string; name: string; input: Record<string, unknown> }
  | { type: "tool_result"; sessionId: string; name: string; content: string; isError?: boolean }
  | { type: "permission_request"; sessionId: string; toolCallId: string; name: string; input: Record<string, unknown>; reason: string; site?: string }
  | { type: "plan_proposed"; sessionId: string; planId: string; steps: PlanStep[] }
  | { type: "plan_step_update"; sessionId: string; stepId: string; status: "pending" | "progress" | "done" }
  | { type: "actions_suggested"; sessionId: string; messageId: string; actions: SuggestedAction[] }
  | { type: "queue_update"; sessionId: string; queue: QueuedMessage[] }
  | { type: "interrupted"; sessionId: string; pending: { id: string; name: string }[] }
  | { type: "memory_update"; facts: UserFact[] }
  | { type: "error"; sessionId?: string; message: string };

type LoopListener = (e: LoopEvent) => void;
const listeners = new Set<LoopListener>();

export function onLoopEvent(l: LoopListener): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}
function emit(e: LoopEvent) {
  for (const l of listeners) l(e);
}

// ---------------------------------------------------------------------------
// Run state: abort controllers + live in-memory session references
// ---------------------------------------------------------------------------

const abortControllers = new Map<string, AbortController>();

/**
 * The in-memory Session object a running loop is mutating. Set when run()
 * starts, cleared when it finishes. Used by enqueueMessage() to inject a
 * queued/steering message into the SAME object the loop reads s.history from
 * on its next turn (streamOnce reads s.history fresh each call).
 */
const liveSessions = new Map<string, Session>();

export function isBusy(session: Session): boolean {
  return !["idle", "done", "error", "paused"].includes(session.state);
}

/**
 * Enqueue a user message on a session. If the session is live (a run is in
 * progress), the message will be drained into s.history at the top of the loop's
 * next iteration -- steering the model mid-run. If the session is idle/done, the
 * caller should follow up with run() to start a fresh turn. Persists to storage
 * + updates the live in-memory reference + emits a queue_update event.
 */
export async function enqueueMessage(sessionId: string, text: string): Promise<QueuedMessage> {
  const queued: QueuedMessage = { id: uuid(), text, createdAt: Date.now() };
  // Update the live in-memory reference (the object the loop is mutating) so
  // the drain at the top of the next iteration sees it immediately.
  const live = liveSessions.get(sessionId);
  if (live) {
    live.messageQueue = [...live.messageQueue, queued];
  }
  // Persist the queue. We reload from storage in case the live ref differs.
  const s = await loadSession(sessionId);
  if (s) {
    s.messageQueue = [...s.messageQueue, queued];
    await saveSession(s);
    emit({ type: "queue_update", sessionId, queue: s.messageQueue });
  }
  return queued;
}

// ---------------------------------------------------------------------------
// Session lifecycle
// ---------------------------------------------------------------------------

export async function newSession(tabId: number, providerId: string, modelId: string): Promise<Session> {
  const def = getProviderDefinition(providerId);
  if (!def) throw new Error(`unknown provider: ${providerId}`);
  const model = def.models.find((m) => m.id === modelId) ?? def.models[0];
  const s: Session = {
    sessionId: uuid(),
    tabId,
    providerId,
    modelId: model?.id ?? modelId,
    state: "idle",
    history: [],
    runId: "",
    stepId: 0,
    pendingStep: null,
    streamingAssistantId: null,
    usage: { input: 0, output: 0 },
    costUsd: 0,
    contextWindow: model?.contextWindow ?? 128_000,
    flatRate: !!def.flatRate,
    compactedUpTo: 0,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    abortReason: null,
    debuggerAttached: false,
    plan: null,
    planApprovedRunId: null,
    messageQueue: [],
  };
  await saveSession(s);
  return s;
}

export async function getSession(sessionId: string): Promise<Session | undefined> {
  return loadSession(sessionId);
}

// ---------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------

export async function run(sessionId: string, userText: string): Promise<void> {
  let s = await loadSession(sessionId);
  if (!s) {
    emit({ type: "error", sessionId, message: "session not found" });
    return;
  }
  // NOTE: we no longer abort a busy run. The background router routes messages
  // sent while busy to enqueueMessage() (steering/queue). run() is only called
  // when the session is idle/done/error, or auto-started from the queue.

  // Fresh run. Each new user message starts a new run, so any prior plan
  // approval is voided (planApprovedRunId will no longer match s.runId).
  s.runId = uuid();
  const myRunId = s.runId; // captured so the finally block can detect if a
                           // newer run has superseded this one.
  s.stepId = 0;
  s.pendingStep = null;
  s.abortReason = null;
  s.plan = null;
  s.planApprovedRunId = null;
  s.history = [...s.history, message("user", [{ type: "text", text: userText }])];

  const controller = new AbortController();
  abortControllers.set(sessionId, controller);
  // Register the live in-memory session so enqueueMessage() can inject
  // steering messages into the SAME object the loop reads s.history from.
  liveSessions.set(sessionId, s);

  try {
    s.state = "attaching";
    await checkpoint(s);
    await cdpManager.attachForRun(s.tabId);
    s.debuggerAttached = true;
    s.state = "running";
    await checkpoint(s);

    await loop(s, controller.signal);
  } catch (e) {
    // Don't clobber a newer run that may have started while this one wound down.
    const cur = await loadSession(sessionId);
    if (cur && cur.runId === myRunId) {
      cur.state = "error";
      cur.abortReason = (e as Error).message;
      await checkpoint(cur);
    }
    emit({ type: "error", sessionId, message: (e as Error).message });
  } finally {
    // Only THIS run's controller should be deleted. A newer run replaced the
    // map entry with its own controller; leave that one alone.
    if (abortControllers.get(sessionId) === controller) {
      abortControllers.delete(sessionId);
    }
    // Clear the live session handle if it's still ours.
    if (liveSessions.get(sessionId) === s) {
      liveSessions.delete(sessionId);
    }
    // Detach the debugger so the "being debugged" banner goes away -- but only
    // if no newer run is using it.
    const cur = await loadSession(sessionId);
    if (!cur || cur.runId === myRunId) {
      try {
        await cdpManager.detachIfIdle(s.tabId);
      } catch {
        /* ignore */
      }
      if (cur) {
        cur.debuggerAttached = false;
        if (cur.state !== "error") cur.state = "done";
        await checkpoint(cur);
      }
    }
    // Clean up any requests THIS run left parked. (A newer run has its own.)
    permissions.abortSession(sessionId);
    planService.abortSession(sessionId);
    // Auto-start the next queued message if the run finished naturally (not
    // aborted). Guarded by runId so a superseding run doesn't double-start.
    if (!controller.signal.aborted) {
      const cur2 = await loadSession(sessionId);
      if (cur2 && cur2.runId === myRunId && cur2.messageQueue.length > 0) {
        const next = cur2.messageQueue[0];
        cur2.messageQueue = cur2.messageQueue.slice(1);
        await saveSession(cur2);
        emit({ type: "queue_update", sessionId, queue: cur2.messageQueue });
        // Start the next turn from the queued message.
        void run(sessionId, next.text);
      }
    }
  }
}

async function loop(s: Session, signal: AbortSignal): Promise<void> {
  for (let i = 0; i < MAX_STEPS; i++) {
    if (signal.aborted) return;

    // ---------- DRAIN QUEUE (steering) ----------
    // Messages enqueued while this run was active are injected into history
    // here, so the model sees them on its very next turn and can adjust course.
    if (s.messageQueue.length > 0) {
      const queued = s.messageQueue.splice(0);
      for (const q of queued) {
        s.history = [...s.history, message("user", [{ type: "text", text: q.text }])];
      }
      await checkpoint(s);
      emit({ type: "queue_update", sessionId: s.sessionId, queue: [] });
    }

    // ---------- APPROACHING STEP CAP: warn the model to wrap up ----------
    // Inject a user-role nudge when only a few steps remain, so the agent
    // summarizes progress and finishes instead of hard-stopping mid-task.
    const remaining = MAX_STEPS - i;
    if (remaining === WRAP_UP_REMAINING) {
      s.history = [
        ...s.history,
        message("user", [
          {
            type: "text",
            text: `[SYSTEM] You have ${remaining} steps remaining before the step limit. Wrap up now: finish your current action, then summarize what you've accomplished and what's left. Do NOT start new sub-tasks.`,
          },
        ]),
      ];
      await checkpoint(s);
    }

    // ---------- STEP: stream to model ----------
    s.stepId += 1;
    s.pendingStep = { stepId: s.stepId, kind: "stream" };
    s.state = "streaming";
    await checkpoint(s);

    const { assistantParts, toolCalls, finishReason, usage, userText, assistantText } = await streamOnce(
      s,
      signal,
    );
    if (signal.aborted) return;

    // Commit the assistant message (only after stream completion).
    const assistantMsg = message("assistant", assistantParts);
    s.history = [...s.history, assistantMsg];
    s.streamingAssistantId = null;
    s.usage = {
      input: s.usage.input + (usage?.input ?? 0),
      output: s.usage.output + (usage?.output ?? 0),
      cachedInput: (s.usage.cachedInput ?? 0) + (usage?.cachedInput ?? 0),
      reasoning: (s.usage.reasoning ?? 0) + (usage?.reasoning ?? 0),
    };
    s.pendingStep = null;
    await checkpoint(s);
    emit({ type: "assistant_committed", sessionId: s.sessionId, message: assistantMsg });

    // ---------- MEMORY TOOLS (remember / forget) ----------
    // Control tools, handled like suggest_actions: persist the side-effect,
    // answer the tool call so wire history stays clean, and drop them from the
    // execution batch. Multiple memory calls can arrive in one turn.
    let memoryChanged = false;
    const memoryResults: { toolCallId: string; name: string; content: string; isError?: boolean }[] = [];
    for (let mi = toolCalls.length - 1; mi >= 0; mi--) {
      const tc = toolCalls[mi];
      if (tc.name === "remember") {
        const r = await handleRememberToolCall(tc);
        memoryResults.push({
          toolCallId: r.toolCallId,
          name: r.name,
          content: r.content,
          isError: r.isError,
        });
        if (r.changed) memoryChanged = true;
        toolCalls.splice(mi, 1);
        emit({ type: "tool_result", sessionId: s.sessionId, name: r.name, content: r.content, isError: r.isError });
      } else if (tc.name === "forget") {
        const r = await handleForgetToolCall(tc);
        memoryResults.push({
          toolCallId: r.toolCallId,
          name: r.name,
          content: r.content,
          isError: r.isError,
        });
        if (r.changed) memoryChanged = true;
        toolCalls.splice(mi, 1);
        emit({ type: "tool_result", sessionId: s.sessionId, name: r.name, content: r.content, isError: r.isError });
      }
    }
    if (memoryResults.length > 0) {
      s.history = [...s.history, toolMessage(memoryResults)];
      await checkpoint(s);
    }
    if (memoryChanged) {
      const refreshed = (await loadMemory()).facts;
      emit({ type: "memory_update", facts: refreshed });
    }


    // ---------- SUGGESTED ACTIONS (model-generated) ----------
    // The model MAY call `suggest_actions` to propose clickable follow-ups. It's
    // a control tool (like propose_plan): we extract its payload, attach it as a
    // part on THIS assistant message, emit it to the panel, and answer the tool
    // call so the next request has no dangling tool_call. If it was the only
    // call this turn, the terminal check below returns and the run ends.
    const suggestCallIndex = toolCalls.findIndex((tc) => tc.name === "suggest_actions");
    let modelSuggestions: SuggestedAction[] | null = null;
    if (suggestCallIndex >= 0) {
      const suggestCall = toolCalls[suggestCallIndex];
      modelSuggestions = parseSuggestActionsCall(suggestCall);
      // Always answer the tool call (keeps wire history clean) and drop it from
      // the execution batch -- it's not a browser action.
      s.history = [
        ...s.history,
        toolMessage([
          {
            toolCallId: suggestCall.id,
            name: "suggest_actions",
            content: modelSuggestions
              ? "Suggestions surfaced to the user."
              : "Suggestions were malformed and ignored.",
            isError: !modelSuggestions,
          },
        ]),
      ];
      toolCalls.splice(suggestCallIndex, 1);
      if (modelSuggestions && modelSuggestions.length > 0) {
        attachSuggestions(s, assistantMsg, modelSuggestions);
        await checkpoint(s);
        emit({
          type: "actions_suggested",
          sessionId: s.sessionId,
          messageId: assistantMsg.id,
          actions: modelSuggestions,
        });
      }
    }

    if (finishReason !== "tool_use" || toolCalls.length === 0) {
      // ---------- SUGGESTED ACTIONS (static fallback) ----------
      // If the model didn't propose any follow-ups on this terminal turn and the
      // assistant actually said something, offer a couple of generic follow-ups
      // so the user always has a one-click next step.
      if (!modelSuggestions && assistantHasText(assistantMsg)) {
        const fallback = fallbackSuggestions(s);
        attachSuggestions(s, assistantMsg, fallback);
        await checkpoint(s);
        emit({
          type: "actions_suggested",
          sessionId: s.sessionId,
          messageId: assistantMsg.id,
          actions: fallback,
        });
      }
      // ---------- AFTER-TURN MEMORY EXTRACTION ----------
      // Fire-and-forget: learn durable facts the user revealed this turn, but
      // only if the model didn't already persist them via `remember` above.
      if (!memoryChanged) {
        void maybeExtractMemory(s, userText, assistantText);
      }
      return; // run complete
    }

    // ---------- PLAN APPROVAL GATE (ask mode) ----------
    // If the model proposed a plan, surface it and wait for the user's single
    // approval. On approve, the whole run is unlocked (planApprovedRunId is
    // matched against s.runId in the permission gate below, skipping every
    // per-action prompt). On reject, we feed "rejected" back to the model so it
    // can re-plan or stop.
    const planCallIndex = toolCalls.findIndex(
      (tc) => tc.name === "propose_plan",
    );
    if (planCallIndex >= 0) {
      const planCall = toolCalls[planCallIndex];
      const parsedPlan = parsePlanCall(planCall);
      if (parsedPlan) {
        s.plan = {
          planId: uuid(),
          steps: parsedPlan,
          approvedAt: null,
        };
        s.state = "awaiting_plan_approval";
        await checkpoint(s);
        emit({
          type: "plan_proposed",
          sessionId: s.sessionId,
          planId: s.plan.planId,
          steps: s.plan.steps,
        });
        const decision = await planService.requestApproval(s.sessionId, s.plan.planId);
        if (signal.aborted) return;
        // IMPORTANT: always push a tool result for propose_plan so the
        // assistant message (which carries the propose_plan tool call) has a
        // matching result in history. Without this, the OpenAI API sees a
        // dangling tool call and the model re-proposes the plan on every turn.
        if (decision === "reject") {
          s.history = [
            ...s.history,
            toolMessage([
              {
                toolCallId: planCall.id,
                name: "propose_plan",
                content: "Plan rejected by the user. Ask them how they'd like to proceed, or propose a revised plan.",
                isError: true,
              },
            ]),
          ];
          s.plan = null;
          await checkpoint(s);
          continue; // next stream turn -- model re-plans or stops
        }
        // Approved. Unlock this run. Push the approval result so the tool call
        // is answered, then drop propose_plan from the execution batch (it's a
        // control tool, not a browser action).
        s.plan.approvedAt = Date.now();
        s.planApprovedRunId = s.runId;
        s.history = [
          ...s.history,
          toolMessage([
            {
              toolCallId: planCall.id,
              name: "propose_plan",
              content: "Plan approved. Proceed with the actions now.",
              isError: false,
            },
          ]),
        ];
        toolCalls.splice(planCallIndex, 1);
        await checkpoint(s);
        if (toolCalls.length === 0) continue; // only the plan was proposed this turn
      }
    }

    // ---------- STEP: execute tools ----------
    s.pendingStep = { stepId: s.stepId, kind: "tool", toolCalls };
    s.state = "tool";
    await checkpoint(s);

    const results: ToolResult[] = [];
    for (const tc of toolCalls) {
      if (signal.aborted) return;
      const parsed = parseToolCall(tc);
      if ("error" in parsed) {
        results.push({ toolCallId: tc.id, name: tc.name, content: parsed.error, isError: true });
        continue;
      }
      // Permission gating. Layers:
      //   1. Autonomy mode: "auto" skips all prompts.
      //   2. "ask" mode + a plan approved THIS run (planApprovedRunId ===
      //      runId) -> the user already approved the whole plan, so run this
      //      action without a prompt.
      //   3. "ask" mode + no plan approval yet -> fall back to the per-action
      //      prompt (the original behavior). This also covers a model that
      //      skipped propose_plan and tried to act directly.
      //   4. A per-site/per-tool grant in the store auto-approves too.
      const settings = await loadSettings();
      const autonomy = settings.autonomyMode ?? "ask";
      const planUnlocked = autonomy === "ask" && s.planApprovedRunId === s.runId;
      const needsPerm =
        autonomy === "ask" && !planUnlocked && toolNeedsPermission(parsed.tool, parsed.toolName);
      if (needsPerm) {
        const site = await siteOf(s.tabId);
        s.state = "awaiting_permission";
        await checkpoint(s);
        emit({
          type: "permission_request",
          sessionId: s.sessionId,
          toolCallId: tc.id,
          name: parsed.toolName,
          input: parsed.input,
          reason: permissionReasonFor(parsed.toolName),
          site,
        });
        const decision = await permissions.request(s.sessionId, parsed.tool, permissionReasonFor(parsed.toolName), site);
        if (signal.aborted) return;
        if (decision === "deny") {
          results.push({ toolCallId: tc.id, name: parsed.toolName, content: "denied by user", isError: true });
          continue;
        }
        s.state = "tool";
        await checkpoint(s);
      }

      emit({ type: "tool_started", sessionId: s.sessionId, name: parsed.toolName, input: parsed.input });
      // Mark the next pending plan step as "in progress" BEFORE the tool runs,
      // so the checklist shows a spinner on the step currently executing.
      if (parsed.toolDef.meta.mutatesPage && s.plan) {
        const next = s.plan.steps.find((st) => st.status === "pending");
        if (next) {
          next.status = "progress";
          emit({ type: "plan_step_update", sessionId: s.sessionId, stepId: next.id, status: "progress" });
        }
      }
      const result = await runToolSafely(parsed.tool, s.tabId);
      // Mark the step done after the tool completes. Read-only tools don't tick.
      if (parsed.toolDef.meta.mutatesPage && s.plan) {
        const active = s.plan.steps.find((st) => st.status === "progress");
        if (active) {
          active.status = "done";
          emit({ type: "plan_step_update", sessionId: s.sessionId, stepId: active.id, status: "done" });
        }
      }
      const isImage = result.content.startsWith("data:image/");
      // Images are NOT capped (truncating base64 corrupts the image). The full
      // data URL goes to the MODEL (it needs it to "see" the screenshot) and to
      // the PANEL (for display). But we do NOT persist the raw bytes to storage
      // -- a full-page screenshot is often 200KB-2MB of base64, and 2-3 of them
      // blow chrome.storage.session's 10MB quota. We store a compact placeholder
      // instead (see the storage-safe copy below).
      const modelResult = isImage ? result : capToolResult(result, MAX_PERSISTED_TOOL_RESULT);
      // Emit the FULL image to the panel for display.
      emit({
        type: "tool_result",
        sessionId: s.sessionId,
        name: parsed.toolName,
        content: isImage
          ? modelResult.content
          : modelResult.content.length > 500
            ? modelResult.content.slice(0, 500) + "..."
            : modelResult.content,
        isError: modelResult.isError,
      });
      // For PERSISTED history: replace the image data URL with a tiny placeholder.
      // The model sees the full image for THIS turn; once the turn is over the
      // image is already consumed. Keeping the placeholder lets the model know a
      // screenshot was taken, without storing megabytes of base64.
      const persistResult = isImage
        ? { ...modelResult, content: "[screenshot captured — image shown in panel, not persisted]" }
        : modelResult;
      results.push(persistResult);
    }
    s.history = [...s.history, toolMessage(results)];
    s.pendingStep = null;
    await checkpoint(s);
  }
  // Hit step cap. This should be rare now (200 steps + a wrap-up warning at
  // 5 remaining). Emit as a soft stop, not a crash -- the session is done, not
  // errored.
  emit({
    type: "error",
    sessionId: s.sessionId,
    message: `Reached the ${MAX_STEPS}-step limit. The task may be incomplete — send a follow-up message to continue.`,
  });
}

// ---------------------------------------------------------------------------
// Streaming one assistant turn
// ---------------------------------------------------------------------------

interface StreamOutcome {
  assistantParts: ContentPart[];
  toolCalls: ToolCallPart[];
  finishReason: FinishReason;
  usage?: { input: number; output: number; cachedInput?: number; reasoning?: number };
  /** Latest user text this turn (for memory extraction). */
  userText: string;
  /** Assistant text this turn, reasoning excluded (for memory extraction). */
  assistantText: string;
}

async function streamOnce(s: Session, signal: AbortSignal): Promise<StreamOutcome> {
  const def = getProviderDefinition(s.providerId);
  if (!def) throw new Error("provider definition missing");
  const adapter = getAdapter(def.type);
  const creds = await readProviderCredentials(s.providerId);
  const ctx = buildContext(def, creds);
  const model = def.models.find((m) => m.id === s.modelId) ?? def.models[0];
  if (!model) throw new Error("model missing");

  // System prompt + tool list depend on autonomy mode AND plan-approval state.
  // In "ask" mode the model must propose a plan first; we offer the propose_plan
  // control tool. Once the plan is approved this run, we DROP propose_plan from
  // the tools and switch the prompt to "approved -- execute now" so the model
  // doesn't re-propose and knows it won't be interrupted.
  const settings = await loadSettings();
  const mode = settings.autonomyMode ?? "ask";
  const planApproved = mode === "ask" && s.planApprovedRunId === s.runId;
  // Preload the user memory once per turn (cheap read from storage.local) so
  // buildSystemPrompt can stay synchronous and the block is stable this turn.
  const userFacts = (await loadMemory()).facts;
  const baseTools =
    mode === "ask" && !planApproved
      ? [...browserTools.schemas(), PROPOSE_PLAN_INFO, SUGGEST_ACTIONS_INFO]
      : [...browserTools.schemas(), SUGGEST_ACTIONS_INFO];
  // remember/forget are memory tools offered in ALL modes -- the agent can
  // learn about the user regardless of autonomy.
  const tools = [...baseTools, REMEMBER_TOOL_INFO, FORGET_TOOL_INFO];

  const textParts: string[] = [];
  const reasoningParts: string[] = [];
  const toolCalls: ToolCallPart[] = [];
  let finishReason: FinishReason = "end_turn";
  let usage: StreamOutcome["usage"];

  const assistantMsgId = uuid();
  s.streamingAssistantId = assistantMsgId;

  // Extract the latest user message text so skill detectors can match against it.
  // We walk back from the end of history for the most recent role:"user" message.
  let latestUserText = "";
  for (let i = s.history.length - 1; i >= 0; i--) {
    const m = s.history[i];
    if (m.role === "user") {
      latestUserText = m.parts
        .filter((p): p is { type: "text"; text: string } => p.type === "text")
        .map((p) => p.text)
        .join(" ");
      break;
    }
  }

  const gen = adapter.streamChat(
    {
      model,
      messages: s.history,
      tools,
      signal,
      reasoning: !!model.canReason,
      reasoningEffort: model.defaultReasoningEffort,
      maxTokens: model.defaultMaxTokens || undefined,
      system: buildSystemPrompt(mode, planApproved, latestUserText, userFacts),
    },
    ctx,
  );

  for await (const part of gen) {
    emit({ type: "stream_part", sessionId: s.sessionId, part });
    switch (part.type) {
      case "text_delta":
        if (part.delta) textParts.push(part.delta);
        break;
      case "reasoning_delta":
        if (part.delta) reasoningParts.push(part.delta);
        break;
      case "tool_call":
        if (part.toolCall) toolCalls.push(part.toolCall);
        break;
      case "finish":
        if (part.finishReason) finishReason = part.finishReason;
        if (part.usage) usage = part.usage;
        break;
      case "error": {
        const retryable = part.error?.retryable;
        const msg = part.error?.message ?? "unknown stream error";
        if (!retryable) throw new Error(msg);
        // Retryable: surface as a soft error and let the loop end the turn.
        throw new Error(msg);
      }
    }
  }

  const parts: ContentPart[] = [];
  if (reasoningParts.length) parts.push({ type: "reasoning", text: reasoningParts.join("") });
  if (textParts.length) parts.push({ type: "text", text: textParts.join("") });
  if (parts.length === 0 && toolCalls.length === 0) parts.push({ type: "text", text: "" });

  return {
    assistantParts: parts,
    toolCalls,
    finishReason,
    usage,
    userText: latestUserText,
    assistantText: textParts.join(""),
  };
}

// ---------------------------------------------------------------------------
// After-turn memory extraction (fire-and-forget)
// ---------------------------------------------------------------------------
// When a turn ends naturally (no further tool calls), ask the model whether the
// user revealed any durable fact in this exchange and store what it finds. This
// is NON-BLOCKING: it never throws and never delays the user -- failures are
// swallowed. If the model already called `remember` this turn, we skip the
// extraction to avoid double work.
async function maybeExtractMemory(
  s: Session,
  userText: string,
  assistantText: string,
): Promise<void> {
  // Need a user message to learn from.
  if (!userText || !userText.trim()) return;
  try {
    const def = getProviderDefinition(s.providerId);
    if (!def) return;
    const adapter = getAdapter(def.type);
    const creds = await readProviderCredentials(s.providerId);
    const ctx = buildContext(def, creds);
    // Use the session's model; fall back to the first model. Extraction is a
    // short call (<= 300 tokens) on whatever the user has connected.
    const model = def.models.find((m) => m.id === s.modelId) ?? def.models[0];
    if (!model) return;
    const controller = new AbortController();
    // Give up after 15s so a slow provider can't hold a dangling promise.
    const timer = setTimeout(() => controller.abort(), 15_000);
    try {
      const facts = await extractFactsFromTurn(adapter, ctx, model, userText, assistantText, controller.signal);
      if (facts.length === 0) return;
      const added = await storeExtractedFacts(facts);
      if (added > 0) {
        const refreshed = (await loadMemory()).facts;
        emit({ type: "memory_update", facts: refreshed });
      }
    } finally {
      clearTimeout(timer);
    }
  } catch {
    // Fire-and-forget: never surface extraction errors to the user.
  }
}

const SYSTEM_PROMPT = `You are an AI browser agent operating inside a Chrome extension. You control the active browser tab through structured tools.

Workflow:
1. Call \`snapshot\` first to see the page as an accessibility tree. Each interactive element has a \`ref\` (e.g. s1e3) that you copy verbatim into action tools. The snapshot also reports the viewport size so you know the visible area.
2. Act using \`click\`, \`type\`, \`navigate\`, \`scroll\`, \`scroll_to\`, \`hover\`, \`press_key\`, etc., passing the \`ref\` from the most recent snapshot.
3. The tool result will reflect the new page state. Call \`snapshot\` again if you need to re-see the page after a mutation.
4. Use \`extractText\` for plain-text extraction (e.g. summarization) and \`screenshot\` only when vision is required (canvas, maps, visual cues).

Tools:
- click: click an element by ref.
- type: focus an element by ref and type text into it (clears first by default). For form fields. Supports multi-line text: embed \`\n\` for line/paragraph breaks -- each is turned into a real Enter press, so <textarea>/contenteditable fields keep their line breaks.
- set_text: overwrite the visible text of an element by ref directly in the DOM. Use this to CHANGE page content (NOT an input/textarea -- those reject set_text). The canonical use case is translating static page text (headings, paragraphs): snapshot to get refs, translate each text yourself, then set_text each element. Do NOT use set_text for <input>/<textarea>/contenteditable -- use \`type\` for those.
- navigate: go to a URL.
- scroll / scroll_to: scroll the page, or scroll a specific element (by ref) into view.
- hover: move the mouse to an element by ref (reveals tooltips, dropdowns, hover states).
- press_key: press a key or combo (Escape, Tab, Enter, ArrowDown, ctrl+a, shift+tab, ...). Use for single keys/combos; use \`type\` for text.
- screenshot: capture the page as an image (only when vision is needed).
- extractText: get the plain text of the page or a subtree.

Changing page content (e.g. translating the page):
- snapshot to get refs for the text elements (headings, paragraphs, list items).
- For each element you want to change, call set_text with its ref and the new text. You can issue multiple set_text calls in one turn.
- To translate the whole page: snapshot, identify the text-bearing elements, translate each one's text yourself, then set_text each element with the translation. Work in batches; you don't need a snapshot between every set_text (refs stay valid as long as the element isn't removed). Re-snapshot if a ref goes stale.

Rules:
- NEVER invent a ref. Only use refs you received from the most recent snapshot.
- Prefer the cheapest representation: snapshot (text) over screenshot (vision).
- If a modal dialog is blocking (the tool reports an auto-dismissed alert/confirm), proceed -- it was handled for you.
- If navigation reports it was blocked by a beforeunload handler, ask the user whether to force it; do not retry blindly.
- After completing the user's goal, stop and summarize what you did.
- If an action fails, read the error, call snapshot, and adjust.

Refs and menus:
- Refs are invalidated whenever a dropdown, menu, modal, dialog, or tab opens OR the page re-renders. After you click anything that OPENS a menu/list/dialog, immediately call \`snapshot\` and use ONLY refs from that fresh snapshot to pick an item. NEVER reuse a ref from a snapshot taken before the menu opened.
- When a click is meant to SWITCH state (language picker, tab, toggle, accordion), call \`snapshot\` afterward and CONFIRM the switch took effect before proceeding. If it didn't, do not click the same stale ref again -- re-snapshot and reselect from fresh refs.
- Do not open a menu/dropdown and then immediately close it (e.g. with Escape) without selecting anything. If you opened it to inspect options, finish the selection; closing it discards state and wastes a turn.

Identifying elements:
- Identify fields by their LABEL/name in the snapshot, not by position. A field's name is shown in quotes, e.g. \`textbox "What's New" [ref=s1e48]\`. If two fields have no name and look identical, snapshot and use hover/extractText to disambiguate before guessing.
- Do not try to memorize field order across re-renders -- always re-read the snapshot.

Text entry:
- To enter multi-line text (e.g. release notes with two paragraphs), use \`type\` and put literal \`\n\` between the lines. Do not strip line breaks from user-supplied text.
- \`set_text\` is for STATIC page content (translation of headings/paragraphs). It is REJECTED by <input>/<textarea>/contenteditable -- if it errors "use the 'type' tool instead", switch to \`type\`.

Verification and honesty:
- Before you claim a task is complete, VERIFY it against the page: re-snapshot and read back each deliverable (e.g. each filled field shows the expected text). Never mark a plan step done unless you have confirmed it on the page. If a step could not be verified, say so explicitly rather than asserting success.
- Never click "Save"/"Submit"/"Done" as part of a step unless you actually performed and verified the work it would persist.

When user input doesn't map cleanly to the page:
- If the user's input (e.g. locale or region codes like en-US, es-419, zh-HK) does not map 1:1 to the page's options -- for example one source code maps to two page locales, two codes collapse into one page option, or a target option has no supplied value -- ASK the user how to map it before filling. Do not silently decide (e.g. don't put en-US text into an en-GB primary field, or fold es-419 into es-MX, without confirming).

Efficiency:
- When repeating the same action across many similar items (fill N fields, translate N elements), work through them in order and re-snapshot only when refs may have changed (e.g. after opening a menu or a re-render), not after every single item.
- Do not re-derive planning tables, locale mappings, or to-do lists you already hold earlier in the conversation. Track progress once and update it, don't recompute it from scratch each turn.
- Avoid redundant screenshots; a snapshot already shows the structure.`;

/** In "ask" mode the agent MUST propose a plan before acting. */
const PLAN_MODE_ADDENDUM = `

PLANNING (required):
You are running in PLANNING mode. Before taking ANY action on the page, you MUST:
1. First call \`snapshot\` to understand the page (this is always allowed).
2. Then call \`propose_plan\` with a short, concrete step-by-step plan (a todo list) of what you will do to accomplish the user's request. Each step has a short title and optional detail. Keep it to 3-7 focused steps.
3. WAIT for the user to approve the plan before proceeding. If they reject it, ask how they'd like to proceed or propose a revised plan.
4. Once approved, execute the plan: snapshot -> act -> snapshot -> act. Do NOT call propose_plan again for the same request.
You may call \`propose_plan\` in the same turn as the initial \`snapshot\`.`;

/** After plan approval, the agent is free to act -- tell it so it doesn't
 *  re-propose and knows no further prompts will interrupt it. */
const PLAN_APPROVED_ADDENDUM = `

PLANNING (approved):
Your plan was APPROVED by the user. Execute it now: snapshot -> act -> snapshot -> act. Do NOT call propose_plan again. Do not ask for further permission -- proceed directly with the action tools.`;

/**
 * Applies in ALL modes. Invites the model to propose clickable follow-ups at the
 * end of a helpful turn. This is optional and purely for UX; the loop falls back
 * to generic suggestions when the model declines.
 */
const SUGGEST_ACTIONS_ADDENDUM = `

SUGGESTED FOLLOW-UPS (optional):
When you finish a helpful answer to the user, you MAY call \`suggest_actions\` with 1-4 concise follow-up actions the user might want next. Each action has a short \`label\` (a few words, shown on a chip) and a \`prompt\` (the full message that gets sent on the user's behalf when they click the chip). Make suggestions specific to what you just did and what the user is likely to want next -- not generic. Omit the call entirely on intermediate turns where you're mid-task with nothing useful to suggest.`;

/** Build the system prompt for the current autonomy + plan-approval state. */
function buildSystemPrompt(
  mode: "ask" | "auto",
  planApproved: boolean,
  latestUserText: string,
  userFacts: UserFact[],
): string {
  const base = mode === "auto" ? SYSTEM_PROMPT : SYSTEM_PROMPT + (planApproved ? PLAN_APPROVED_ADDENDUM : PLAN_MODE_ADDENDUM);
  // The suggest_actions addendum applies in ALL modes.
  return base + SUGGEST_ACTIONS_ADDENDUM + memoryBlock(userFacts) + activatedSkillInstructions(latestUserText);
}

// ---------------------------------------------------------------------------
// Tool dispatch helpers
// ---------------------------------------------------------------------------

/** Schema for the plan-proposal control tool (offered only in "ask" mode). */
const PROPOSE_PLAN_INFO = {
  name: "propose_plan",
  description:
    "Propose a step-by-step plan to the user BEFORE taking any action. The user approves or rejects the whole plan. Always call snapshot first to understand the page, then call this with your plan. Do NOT call any action tools in the same turn as this one.",
  parameters: {
    type: "object",
    properties: {
      steps: {
        type: "array",
        description: "Ordered list of steps. Keep it 3-7 focused, concrete actions.",
        items: {
          type: "object",
          properties: {
            title: { type: "string", description: "Short imperative title, e.g. 'Click the CV button'." },
            detail: { type: "string", description: "Optional one-line explanation." },
          },
          required: ["title"],
        },
        minItems: 1,
      },
    },
    required: ["steps"],
  },
};

/**
 * Schema for the suggest_actions control tool (offered in BOTH ask & auto
 * modes). Lets the model propose clickable follow-ups at the end of a turn.
 */
const SUGGEST_ACTIONS_INFO = {
  name: "suggest_actions",
  description:
    "Propose 1-4 clickable follow-up actions the user might want next, shown as chips under your reply. Each has a short label and the full message that gets sent when the user clicks. Call this ONLY at the end of a helpful answer; omit it on intermediate steps or when there's nothing useful to suggest. Do NOT call any other tool in the same turn.",
  parameters: {
    type: "object",
    properties: {
      actions: {
        type: "array",
        description: "1-4 suggested follow-ups. Keep labels short (<= 5 words).",
        items: {
          type: "object",
          properties: {
            label: { type: "string", description: "Short chip text, e.g. 'Summarize results'." },
            prompt: { type: "string", description: "Full user message sent when the chip is clicked." },
          },
          required: ["label", "prompt"],
        },
        minItems: 1,
        maxItems: 4,
      },
    },
    required: ["actions"],
  },
};

/**
 * Parse a propose_plan tool call's input into PlanStep[]. Returns null if the
 * args are malformed (the loop treats null as "no plan" -- the action gate
 * then falls back to per-action prompting).
 */
function parsePlanCall(tc: ToolCallPart): PlanStep[] | null {
  let raw: unknown;
  try {
    raw = tc.input ? JSON.parse(tc.input) : {};
  } catch {
    return null;
  }
  const steps = (raw as { steps?: unknown }).steps;
  if (!Array.isArray(steps)) return null;
  return steps
    .filter((s): s is { title: string; detail?: string } =>
      !!s && typeof (s as { title?: unknown }).title === "string",
    )
    .map((s, i) => ({
      id: `p${i + 1}`,
      title: s.title,
      detail: s.detail,
      status: "pending" as const,
    }));
}

/**
 * Parse a suggest_actions tool call into SuggestedAction[]. Returns null on
 * malformed input (the loop then treats it as "no model suggestions" and falls
 * back to the static set). Caps at 4 actions and trims/normalizes each entry.
 */
function parseSuggestActionsCall(tc: ToolCallPart): SuggestedAction[] | null {
  let raw: unknown;
  try {
    raw = tc.input ? JSON.parse(tc.input) : {};
  } catch {
    return null;
  }
  const actions = (raw as { actions?: unknown }).actions;
  if (!Array.isArray(actions)) return null;
  const out: SuggestedAction[] = [];
  for (const a of actions) {
    if (!a || typeof a !== "object") continue;
    const label = (a as { label?: unknown }).label;
    const prompt = (a as { prompt?: unknown }).prompt;
    if (typeof label !== "string" || typeof prompt !== "string") continue;
    const labelT = label.trim();
    const promptT = prompt.trim();
    if (!labelT || !promptT) continue;
    out.push({ label: labelT, prompt: promptT });
    if (out.length >= 4) break;
  }
  return out.length > 0 ? out : null;
}

/** Whether an assistant message has any non-empty text part. */
function assistantHasText(m: Message): boolean {
  return m.parts.some((p) => p.type === "text" && p.text.trim().length > 0);
}

/**
 * Attach a SuggestedActionsPart to the most recently committed assistant message
 * in history. The committed message is the last entry; we append the part in
 * place. This is what persists the suggestions across SW restarts.
 */
function attachSuggestions(s: Session, assistantMsg: Message, actions: SuggestedAction[]): void {
  const last = s.history[s.history.length - 1];
  if (!last || last.id !== assistantMsg.id) return; // safety: history moved on
  last.parts = [...last.parts, suggestedActionsPart(actions)];
  assistantMsg.parts = last.parts; // keep the local ref in sync too
}

/**
 * Generic follow-ups used when the model didn't propose any. Always present so
 * the user has a one-click next step. The first is derived from the last user
 * message so "tell me more" style continuation is easy.
 */
function fallbackSuggestions(s: Session): SuggestedAction[] {
  const lastUserText = lastUserMessageText(s);
  const more = lastUserText
    ? `Tell me more about: ${lastUserText.slice(0, 120)}`
    : "Explain this in more detail.";
  return [
    { label: "Explain in more detail", prompt: more },
    { label: "Summarize what you did", prompt: "Summarize what you just did in a few bullet points." },
    { label: "Try a different approach", prompt: "Try a different approach to this." },
  ];
}

/** Return the trimmed text of the most recent user message in history, if any. */
function lastUserMessageText(s: Session): string | null {
  for (let i = s.history.length - 1; i >= 0; i--) {
    const m = s.history[i];
    if (m.role === "user") {
      const t = m.parts.find((p) => p.type === "text");
      if (t && t.type === "text") return t.text.trim();
    }
  }
  return null;
}

function parseToolCall(
  tc: ToolCallPart,
):
  | { tool: ToolCall; toolName: string; toolDef: AnnotatedTool; input: Record<string, unknown> }
  | { error: string } {
  const toolDef = browserTools.get(tc.name);
  if (!toolDef) return { error: `unknown tool: ${tc.name}` };
  let input: Record<string, unknown> = {};
  try {
    input = tc.input ? JSON.parse(tc.input) : {};
  } catch {
    return { error: `invalid JSON args for ${tc.name}: ${tc.input}` };
  }
  const tool: ToolCall = { id: tc.id, name: tc.name, input };
  return { tool, toolName: tc.name, toolDef, input };
}

/**
 * Whether a tool needs user permission before it runs in "ask" autonomy mode.
 * Any tool that can change page state (meta.mutatesPage) is gated. Read-only
 * tools (snapshot, extractText, screenshot) always run without prompting so the
 * agent can perceive the page freely. In "auto" mode the loop skips this gate
 * entirely (see the permission block in `loop()`).
 */
function toolNeedsPermission(_tool: ToolCall, name: string): boolean {
  const def = browserTools.get(name);
  // Explicit requiresPermission (e.g. navigate) OR any mutating tool.
  return !!def && (!!def.meta.requiresPermission || !!def.meta.mutatesPage);
}

function permissionReasonFor(name: string): string {
  switch (name) {
    case "navigate":
      return "The agent wants to navigate the tab to a new URL.";
    default:
      return `The agent wants to run tool "${name}".`;
  }
}

async function runToolSafely(tool: ToolCall, tabId: number): Promise<ToolResult> {
  const def = browserTools.get(tool.name);
  if (!def) return { toolCallId: tool.id, name: tool.name, content: `unknown tool`, isError: true };
  const ctx = {
    tabId,
    cdp: <T = unknown>(m: string, p?: unknown) => cdpCmd<T>(tabId, m, p),
  };
  try {
    return await def.run(tool, ctx);
  } catch (e) {
    return { toolCallId: tool.id, name: tool.name, content: `tool threw: ${(e as Error).message}`, isError: true };
  }
}

// ---------------------------------------------------------------------------
// Cancel / pause
// ---------------------------------------------------------------------------

export async function cancel(sessionId: string): Promise<void> {
  const controller = abortControllers.get(sessionId);
  if (controller) controller.abort();
  permissions.abortSession(sessionId);
  planService.abortSession(sessionId);
  const s = await loadSession(sessionId);
  if (s) {
    // Stop means stop: clear any queued messages so the finally auto-start
    // doesn't kick off the next one.
    s.messageQueue = [];
    s.state = "done";
    s.abortReason = "user_cancel";
    await checkpoint(s);
    emit({ type: "queue_update", sessionId, queue: [] });
  }
}

export async function pause(sessionId: string): Promise<void> {
  // v1: pause == cancel-with-preserved-history. (Full pause/resume mid-run is a v2 feature.)
  await cancel(sessionId);
}

// ---------------------------------------------------------------------------
// Resume after SW restart (called from background on alarms / onStartup)
// ---------------------------------------------------------------------------

export async function resumeIfInterrupted(session: Session): Promise<void> {
  let s = session;
  // Was the SW killed while waiting for plan approval? The parked Promise is
  // gone, but the plan still lives on the session. Re-emit it so the user can
  // approve, and re-park on a fresh Promise. When they answer, the loop resumes.
  if (s.state === "awaiting_plan_approval" && s.plan) {
    emit({
      type: "plan_proposed",
      sessionId: s.sessionId,
      planId: s.plan.planId,
      steps: s.plan.steps,
    });
    const decision = await planService.requestApproval(s.sessionId, s.plan.planId);
    if (decision === "reject") {
      s.plan = null;
      s.state = "idle";
      await checkpoint(s);
      return;
    }
    s.plan.approvedAt = Date.now();
    s.planApprovedRunId = s.runId;
    s.state = "running";
    await checkpoint(s);
    // Fall through: if there's a pending stream step, resume the loop; else the
    // plan was the only thing proposed and we re-enter the loop to let the model
    // proceed.
  }
  if (!s.pendingStep) {
    // Between steps: safe to continue (but a fresh run needs a user message).
    s.state = "idle";
    await checkpoint(s);
    return;
  }
  if (s.pendingStep.kind === "stream") {
    // Re-send the stream from the snapshot. (Accepts a possible single-turn double-charge;
    // see design doc 4.3.)
    s.state = "resuming";
    await checkpoint(s);
    const controller = new AbortController();
    abortControllers.set(s.sessionId, controller);
    liveSessions.set(s.sessionId, s);
    try {
      await cdpManager.attachForRun(s.tabId);
      s.debuggerAttached = true;
      await loop(s, controller.signal);
    } finally {
      if (abortControllers.get(s.sessionId) === controller) abortControllers.delete(s.sessionId);
      if (liveSessions.get(s.sessionId) === s) liveSessions.delete(s.sessionId);
      await cdpManager.detachIfIdle(s.tabId);
    }
    return;
  }
  // Mid-tool: NEVER auto-replay mutating tools. Surface to the user.
  s.state = "error";
  s.abortReason = "interrupted_during_tool";
  await checkpoint(s);
  emit({
    type: "interrupted",
    sessionId: s.sessionId,
    pending: s.pendingStep.toolCalls.map((tc) => ({ id: tc.id, name: tc.name })),
  });
}

/** User resolved an interrupted-tool session: retry / skip / abort. */
export async function resolveInterrupted(
  sessionId: string,
  action: "retry" | "skip" | "abort",
): Promise<void> {
  let s = await loadSession(sessionId);
  if (!s || !s.pendingStep || s.pendingStep.kind !== "tool") return;
  const pending = s.pendingStep.toolCalls;
  if (action === "abort") {
    s.state = "idle";
    s.abortReason = "interrupted_aborted";
    s.pendingStep = null;
    await checkpoint(s);
    return;
  }
  if (action === "skip") {
    // Record skipped results and continue the loop with a fresh stream.
    const skipped: ToolResult[] = pending.map((tc) => ({
      toolCallId: tc.id,
      name: tc.name,
      content: "skipped after interruption",
      isError: true,
    }));
    s.history = [...s.history, toolMessage(skipped)];
    s.pendingStep = null;
    s.state = "running";
    await checkpoint(s);
    const controller = new AbortController();
    abortControllers.set(sessionId, controller);
    try {
      await cdpManager.attachForRun(s.tabId);
      s.debuggerAttached = true;
      await loop(s, controller.signal);
    } finally {
      abortControllers.delete(sessionId);
      await cdpManager.detachIfIdle(s.tabId);
    }
    return;
  }
  // retry: drop the assistant tool-call turn and let the model re-issue.
  // Easiest correct behavior: roll back history to before the assistant's
  // tool-call turn, set idle, let the user resend.
  s.history = s.history.slice(0, -1); // drop the assistant tool-call turn
  s.pendingStep = null;
  s.state = "idle";
  s.abortReason = "interrupted_retry";
  await checkpoint(s);
}

// ---------------------------------------------------------------------------
// Checkpointing
// ---------------------------------------------------------------------------

async function checkpoint(s: Session): Promise<void> {
  // Bound history size so long sessions don't blow the storage quota. We drop
  // the OLDEST completed turns (user+assistant+tool messages) while keeping a
  // recent window of at least MIN_HISTORY_MESSAGES. The system prompt is not
  // stored in history (it's re-added at request time), so trimming is safe.
  trimHistory(s);
  await saveSession(s);
  emit({ type: "state", session: s });
}

const MIN_HISTORY_MESSAGES = 12; // never trim below this
const MAX_HISTORY_BYTES = 1_500_000; // ~1.5MB; leaves headroom under the 10MB quota for the mirror + other state

/** Drop oldest completed turns until history is under the byte budget. */
function trimHistory(s: Session): void {
  if (s.history.length <= MIN_HISTORY_MESSAGES) return;
  while (s.history.length > MIN_HISTORY_MESSAGES && approxBytes(s.history) > MAX_HISTORY_BYTES) {
    // Drop the oldest message. To keep tool/assistant pairs coherent, drop in
    // batches of up to 3 (a user+assistant+tool triple). Simplest correct
    // behavior: drop one at a time from the front.
    s.history.shift();
  }
}

/** Cheap byte estimate without JSON.stringify (which would itself allocate). */
function approxBytes(history: Message[]): number {
  let total = 0;
  for (const m of history) {
    for (const p of m.parts) {
      if (p.type === "text") total += p.text.length;
      else if (p.type === "reasoning") total += p.text.length;
      else if (p.type === "tool_call") total += p.input.length + 64;
      else if (p.type === "tool_result") total += p.content.length + 64;
      else if (p.type === "suggested_actions") {
        for (const a of p.actions) total += a.label.length + a.prompt.length + 32;
      }
      // images: skip (data URLs are rare in history; vision tools live in tool results)
    }
  }
  return total;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function siteOf(tabId: number): Promise<string> {
  try {
    const tab = await chrome.tabs.get(tabId);
    if (tab.url) {
      try {
        return new URL(tab.url).hostname;
      } catch {
        return "";
      }
    }
  } catch {
    /* ignore */
  }
  return "";
}

export async function removeSession(sessionId: string): Promise<void> {
  abortControllers.get(sessionId)?.abort();
  await deleteSession(sessionId);
}

// Re-export tool registry for the panel's tool-list rendering if needed.
export { browserTools };
