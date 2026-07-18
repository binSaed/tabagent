/**
 * Side panel UI (vanilla TS).
 *
 * Single view: a chat with a header for provider/model selection + connect.
 * On first use the user picks a provider (Z.AI default), pastes their key, and
 * clicks Connect -- credentials are auto-encrypted at rest with a random
 * generated key (no passphrase). Returning users see their saved provider/model.
 *
 * The panel holds NO agent logic; it only sends requests and renders events.
 * It heartbeats the SW over a long-lived Port (every 20s) to keep it alive.
 */

import type {
  ContentPart,
  Message,
  Model,
  PlanStep,
  ProviderDefinition,
  Session,
  StreamPart,
  SuggestedAction,
} from "../core/types";
import type { PanelEvent, PanelRequest } from "../shared/protocol";
import type { UserFact, UserFactCategory } from "../core/storage";
import { messageText } from "../core/messages";
import { renderMarkdown } from "./markdown";

const $ = <T extends HTMLElement = HTMLElement>(id: string): T => document.getElementById(id) as T;

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

interface PanelState {
  providers: ProviderDefinition[];
  models: Model[];
  providerId?: string;
  modelId?: string;
  autonomyMode: "ask" | "auto";
  /** Whether notification chime + toasts are on. Default true; restored from
   *  settings on boot (undefined => on). */
  notificationsEnabled: boolean;
  /** Panel color theme. "dark" is the default (warm near-black); "light" is
   *  the warm-cream variant. Persisted via set_theme. */
  theme: "light" | "dark";
  /** Provider IDs that have stored credentials (from get_state). */
  configuredProviders: Set<string>;
  /** What the agent has learned about the user (global memory). Hydrated from
   *  get_state and updated live by memory_update events. */
  userMemory: UserFact[];
  sessionId?: string;
  tabId: number;
  streamingText: string;
  streamingReasoning: string;
  /** Whether a run is currently active (derived from session_state events). */
  isBusy: boolean;
}

const state: PanelState = {
  providers: [],
  models: [],
  autonomyMode: "ask",
  notificationsEnabled: true,
  theme: "dark",
  configuredProviders: new Set(),
  userMemory: [],
  streamingText: "",
  streamingReasoning: "",
  isBusy: false,
  tabId: 0,
};

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

async function boot(): Promise<void> {
  state.tabId = (await chrome.tabs.query({ active: true, currentWindow: true }))[0]?.id ?? 0;
  startHeartbeat();
  listenForEvents();
  await refreshProviders();
  // Restore previously-saved provider/model selection so returning users don't
  // have to reconnect each time they open the panel.
  const settings = await send<SettingsResponse>({ kind: "get_state" }).catch(() => null);
  if (settings?.settings) {
    state.providerId = settings.settings.providerId;
    state.modelId = settings.settings.modelId;
    state.autonomyMode = settings.settings.autonomyMode === "auto" ? "auto" : "ask";
    state.notificationsEnabled = settings.settings.notificationsEnabled ?? true;
    state.theme = settings.settings.theme === "light" ? "light" : "dark";
  }
  // Apply the theme attribute on <html> before any rendering so there's no
  // flash of the wrong palette on boot.
  applyTheme(state.theme);
  state.configuredProviders = new Set(settings?.configuredProviders ?? []);
  state.userMemory = settings?.userMemory ?? [];
  renderMemoryBtn();
  renderExportBtn();
  renderAutonomy();
  renderNotifyBtn();
  renderProviderChip();
  // Default Z.AI as the selected provider on first run (before any connect).
  if (!state.providerId) state.providerId = "zai";
  renderProviderSelect();
  // Models are NEVER pre-populated from a hardcoded catalog. The dropdown
  // shows a "Connect a provider" placeholder until credentials exist, then the
  // live /models API list is fetched and displayed.
  if (state.providerId && settings?.settings?.initialized) {
    setConnected(true);
    await refreshModels(state.providerId);
  } else {
    setConnected(false);
    renderModelSelect();
  }
  render();
  maybeShowEmptyState();
  // Selection-triggered suggestion: if the user clicked an action on the page
  // (Explain/Summarize/...), the SW stashed a pending prompt and opened this
  // panel. Auto-send it now that we're booted and the provider is ready. If the
  // provider isn't connected yet, the prompt lands in the composer for the user
  // to send after connecting.
  void autoSendPendingPrompt();
}

/** Check for a selection-action prompt waiting for this tab and auto-send it. */
async function autoSendPendingPrompt(): Promise<void> {
  try {
    const resp = await send<{ prompt: string | null }>({ kind: "pop_pending_prompt", tabId: state.tabId });
    const prompt = resp?.prompt;
    if (!prompt) return;
    const input = $("composer") as HTMLTextAreaElement;
    if (input) input.value = prompt;
    // Try to send; if the provider isn't configured, onSend() will surface the
    // "connect a provider" notice and leave the text in the composer.
    await onSend();
  } catch {
    // Non-fatal: the user can still type and send manually.
  }
}

/** Fetch the LIVE model list from the provider's /models API. Only meaningful
 *  once credentials are stored; unconfigured providers keep the placeholder. */
async function refreshModels(providerId: string): Promise<void> {
  try {
    const resp = await send<{ models: Model[] }>({ kind: "list_models", providerId });
    if (Array.isArray(resp?.models) && resp.models.length > 0) {
      state.models = resp.models;
      // Keep the saved selection when it's still served; else fall back to the
      // provider's preferred default IF the API actually lists it, else first.
      if (!state.modelId || !state.models.some((m) => m.id === state.modelId)) {
        const def = state.providers.find((p) => p.id === providerId);
        const preferred = def?.defaultLargeModelId;
        state.modelId =
          (preferred && state.models.some((m) => m.id === preferred) ? preferred : undefined) ??
          state.models[0]?.id;
      }
      renderModelSelect();
    }
  } catch {
    /* credentials may not be unlocked yet, or no creds stored; keep placeholder */
  }
}

interface SettingsResponse {
  settings?: {
    providerId?: string;
    modelId?: string;
    initialized?: boolean;
    autonomyMode?: "ask" | "auto";
    notificationsEnabled?: boolean;
    theme?: "light" | "dark";
  };
  configuredProviders?: string[];
  userMemory?: UserFact[];
}

function startHeartbeat(): void {
  // An open-but-idle Port does NOT keep the SW alive (Chrome 114+); only
  // messages do. So we ping periodically.
  setInterval(() => {
    chrome.runtime.sendMessage({ kind: "heartbeat" }).catch(() => {});
  }, 20_000);
}

function listenForEvents(): void {
  chrome.runtime.onMessage.addListener((msg: PanelEvent, _sender, _sendResponse) => {
    handleEvent(msg);
    return false;
  });
}

async function handleEvent(e: PanelEvent): Promise<void> {
  switch (e.kind) {
    case "session_state":
      if (e.session.tabId === state.tabId) {
        state.sessionId = e.session.sessionId;
        renderState(e.session.state);
      }
      break;
    case "stream_part":
      onStreamPart(e.part);
      break;
    case "assistant_message": {
      hideTyping();
      // Detect whether reasoning streamed live this turn BEFORE finalizing —
      // if the panel missed the stream (opened mid-run, SW restart), rebuild
      // the thinking block from the committed message so it's never lost.
      const streamedReasoning = !!document.getElementById("streaming-reasoning");
      finishStreaming();
      if (!streamedReasoning) appendReasoningFromMessage(e.message);
      appendMessage(e.message);
      break;
    }
    case "tool_call_started":
      hideTyping();
      appendToolStarted(e.name, e.input);
      break;
    case "tool_result":
      appendToolResult(e.name, e.content, e.isError);
      // The loop now goes back to the model for its next step — show the dots
      // again while we wait for it to start "talking".
      if (state.isBusy) showTyping();
      break;
    case "permission_request":
      hideTyping();
      showPermissionCard(e.toolCallId, e.name, e.reason, e.site);
      break;
    case "plan_proposed":
      showPlanCard(e.planId, e.steps);
      break;
    case "plan_step_update":
      tickPlanStep(e.stepId, e.status);
      break;
    case "actions_suggested":
      showSuggestions(e.messageId, e.actions);
      break;
    case "queue_update":
      onQueueUpdate(e.queue.length);
      break;
    case "interrupted":
      showInterruptedCard(e.sessionId, e.pendingToolCalls);
      break;
    case "memory_update":
      // The agent learned/forgot something during a run; update live so the
      // memory overlay reflects it even while a run is in progress.
      state.userMemory = e.facts;
      renderMemoryBtn();
      if (!isMemoryModalHidden()) renderMemoryList();
      break;
    case "error":
      hideTyping();
      appendError(e.message);
      break;
    case "cost_update":
      // (flatRate providers won't receive these.)
      break;
    case "providers":
      state.providers = e.providers;
      renderProviderSelect();
      break;
    case "models":
      if (e.providerId === state.providerId) {
        state.models = e.models;
        renderModelSelect();
      }
      break;
  }
}

// ---------------------------------------------------------------------------
// Typing indicator (waiting for the model's first output)
// ---------------------------------------------------------------------------

/** Show animated dots while we wait for the model to start responding. */
function showTyping(): void {
  if ($("typing-indicator")) return;
  const wrap = $("messages");
  if (!wrap) return;
  wrap.querySelector(".empty-state")?.remove();
  const el = document.createElement("div");
  el.id = "typing-indicator";
  el.className = "typing-indicator";
  el.innerHTML = `<span></span><span></span><span></span>`;
  wrap.appendChild(el);
  scrollMessages();
}

function hideTyping(): void {
  $("typing-indicator")?.remove();
}

// ---------------------------------------------------------------------------
// Streaming token accumulation
// ---------------------------------------------------------------------------

function onStreamPart(p: StreamPart): void {
  // The first sign of model output replaces the typing dots.
  if (p.type === "text_start" || p.type === "reasoning_start" || p.type === "tool_input_start") {
    hideTyping();
  }
  switch (p.type) {
    case "text_start":
      state.streamingText = "";
      ensureStreamingBubble("text");
      break;
    case "text_delta":
      state.streamingText += p.delta ?? "";
      updateStreamingBubble("text", state.streamingText);
      break;
    case "reasoning_start":
      state.streamingReasoning = "";
      ensureStreamingBubble("reasoning");
      break;
    case "reasoning_delta":
      state.streamingReasoning += p.delta ?? "";
      updateStreamingBubble("reasoning", state.streamingReasoning);
      break;
    case "tool_input_start":
      // During streaming the tool args build up; create the row early. The
      // name may still be EMPTY at this point (Z.AI tool_stream sends it in a
      // later delta) — appendToolStarted shows a placeholder and the committed
      // tool_call_started event fills the real name into the same row.
      appendToolStarted(p.toolCallName ?? "", {});
      break;
    case "tool_call":
      // The committed tool dispatch is surfaced via tool_call_started from the loop.
      break;
  }
}

function finishStreaming(): void {
  const text = $("streaming-text");
  if (text) text.remove();
  state.streamingText = "";

  // The reasoning block graduates from a streaming bubble to a permanent
  // collapsible block. It STAYS EXPANDED after the turn so the user can read
  // the reasoning alongside the answer; they can collapse it manually. We only
  // swap the live "thinking…" dots for a word-count summary.
  const reasoning = $("streaming-reasoning");
  if (reasoning) {
    reasoning.removeAttribute("id");
    reasoning.classList.remove("streaming");
    const dots = reasoning.querySelector(".thinking-dots");
    if (dots) dots.remove();
    const label = reasoning.querySelector(".collapse-label");
    if (label) label.textContent = "Thinking";
    // Keep it open if it had content; drop entirely if empty.
    const content = state.streamingReasoning.trim();
    if (content) {
      const meta = reasoning.querySelector(".collapse-meta");
      if (meta) meta.textContent = `${content.split(/\s+/).length} words`;
      // Belt-and-braces: guarantee the body holds the full reasoning text even
      // if a delta was dropped mid-stream — an expanded-but-empty block is
      // exactly the "I can't see the thinking" failure mode.
      const body = reasoning.querySelector(".collapse-body");
      if (body && !body.textContent?.trim()) body.textContent = content;
    } else {
      reasoning.remove();
    }
  }
  state.streamingReasoning = "";
}

/**
 * Fallback: build a thinking block from a committed assistant message's
 * reasoning parts. Used when the panel never saw the live reasoning stream
 * (opened mid-run, SW restart, provider buffered the reasoning). Rendered
 * collapsed — the turn is already over, so it's reference material.
 */
function appendReasoningFromMessage(m: Message): void {
  const text = m.parts
    .filter((p): p is Extract<ContentPart, { type: "reasoning" }> => p.type === "reasoning")
    .map((p) => p.text)
    .join("")
    .trim();
  if (!text) return;
  const wrap = $("messages");
  if (!wrap) return;
  const block = document.createElement("div");
  block.className = `collapse reasoning${blockStartsOpen(false) ? " open" : ""}`;
  block.innerHTML = `
    <div class="collapse-header">
      <svg class="chevron" viewBox="0 0 10 10"><path d="M3 2L7 5L3 8" stroke="currentColor" stroke-width="1.4" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>
      <span class="collapse-label">Thinking</span>
      <span class="collapse-meta">${text.split(/\s+/).length} words</span>
    </div>
    <div class="collapse-body"></div>`;
  const body = block.querySelector(".collapse-body");
  if (body) body.textContent = text;
  bindCollapseToggle(block);
  wrap.appendChild(block);
  scrollMessages();
}

function ensureStreamingBubble(kind: "text" | "reasoning"): void {
  const id = kind === "text" ? "streaming-text" : "streaming-reasoning";
  if ($(id)) return;
  if (kind === "text") {
    const div = document.createElement("div");
    div.id = id;
    div.className = "bubble assistant streaming";
    $("messages")?.appendChild(div);
  } else {
    // Reasoning streams into a collapsible "Thinking" block. It naturally
    // starts OPEN while streaming (so the user sees live thought) — unless the
    // user has chosen "collapse all", which sticks for new blocks too.
    const block = document.createElement("div");
    block.id = id;
    block.className = `collapse reasoning${blockStartsOpen(true) ? " open" : ""} streaming`;
    block.innerHTML = `
      <div class="collapse-header">
        <svg class="chevron" viewBox="0 0 10 10"><path d="M3 2L7 5L3 8" stroke="currentColor" stroke-width="1.4" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>
        <span class="collapse-label">Thinking<span class="thinking-dots"><span></span><span></span><span></span></span></span>
        <span class="collapse-meta"></span>
      </div>
      <div class="collapse-body"></div>`;
    bindCollapseToggle(block);
    $("messages")?.appendChild(block);
  }
  scrollMessages();
}

function updateStreamingBubble(kind: "text" | "reasoning", content: string): void {
  const id = kind === "text" ? "streaming-text" : "streaming-reasoning";
  const el = $(id);
  if (!el) return;
  if (kind === "text") {
    // Render Markdown live so the user sees formatted text as it streams,
    // not raw `**bold**` markers.
    el.innerHTML = renderMarkdown(content);
    // Per-token reveal: fade in the trailing paragraph so new text appears to
    // materialize as it streams (the signature motion of modern AI chat). The
    // animation is CSS-driven and disabled under prefers-reduced-motion, so
    // this is purely additive. We tag the last block and re-trigger its
    // animation each delta via a forced reflow.
    const last = el.lastElementChild as HTMLElement | null;
    if (last) {
      last.classList.remove("stream-token");
      // Force reflow so re-adding the class restarts the keyframe.
      void last.offsetWidth;
      last.classList.add("stream-token");
    }
  } else {
    // Update the reasoning body + the meta word-count in the header.
    const body = el.querySelector(".collapse-body");
    if (body) body.textContent = content;
    const meta = el.querySelector(".collapse-meta");
    if (meta) {
      const words = content.trim() ? content.trim().split(/\s+/).length : 0;
      meta.textContent = words > 0 ? `${words} words` : "";
    }
  }
  scrollMessages();
}

// ---------------------------------------------------------------------------
// Send / actions
// ---------------------------------------------------------------------------

async function onSend(): Promise<void> {
  const input = $("composer") as HTMLTextAreaElement;
  const text = input.value.trim();
  if (!text) return;
  // Guard: require a connected provider before sending. The SW throws
  // "no provider/model selected" otherwise, which surfaces as an unhandled
  // promise rejection (the error dump showed panel.js:980).
  if (!state.configuredProviders.has(state.providerId ?? "")) {
    setNotice("Connect a provider first (click the provider chip).", true);
    openProviderPicker();
    return;
  }
  input.value = "";
  // Reset the textarea height.
  input.style.height = "auto";
  // Clear any leftover suggestion chips -- a new turn is starting.
  $("messages")?.querySelector(".suggestions-row")?.remove();
  appendMessage({ id: "u", role: "user", parts: [{ type: "text", text }], createdAt: Date.now() });
  // Sending is an explicit "I'm at the newest turn now" — always jump down,
  // even if the user had scrolled up (sticky auto-scroll won't).
  scrollMessagesToEnd();
  try {
    const resp = await send<{ sessionId: string | null; queued?: boolean; cleared?: boolean; userMemory?: UserFact[] }>(
      { kind: "send_message", tabId: state.tabId, text },
    );
    // "forget everything" short-circuit: the SW wipes memory without entering
    // the agent loop. Handle it inline instead of pretending it's a run.
    if (resp.cleared) {
      // Remove the user bubble we optimistically appended (it's not a real
      // turn) and confirm the wipe as an assistant note.
      const messages = $("messages");
      messages?.querySelector(".bubble.user:last-of-type")?.remove();
      if (resp.userMemory) state.userMemory = resp.userMemory;
      renderMemoryBtn();
      appendMessage({
        id: "mem-cleared",
        role: "assistant",
        parts: [{ type: "text", text: "Done — I've cleared everything I had learned about you." }],
        createdAt: Date.now(),
      });
      hideTyping();
      return;
    }
    state.sessionId = resp.sessionId ?? state.sessionId;
    // Show the typing dots while we wait for the model's first token. Queued
    // messages don't start a turn, so no dots for them.
    if (!resp.queued) showTyping();
    // If the message was queued (a run is active), tag the last user bubble so
    // the user sees it's waiting to be steered into the next turn.
    if (resp.queued) {
      const messages = $("messages");
      const lastUser = messages?.querySelector(".bubble.user:last-of-type");
      if (lastUser) {
        lastUser.classList.add("queued");
        const tag = document.createElement("span");
        tag.className = "queued-tag";
        tag.textContent = "Queued";
        lastUser.appendChild(tag);
      }
    }
  } catch (e) {
    // Restore the text so the user doesn't lose their input, and surface the error.
    input.value = text;
    input.style.height = "auto";
    const messages = $("messages");
    const lastUser = messages?.querySelector(".bubble.user:last-of-type");
    lastUser?.remove();
    setNotice(`Failed to send: ${(e as Error).message}`, true);
  }
}

function onStop(): void {
  if (state.sessionId) void send({ kind: "stop", sessionId: state.sessionId });
}

/** ensureHostPermission moved from here; the modal calls it directly. */

/**
 * Request host permission for a provider's API domain. MUST be called from a
 * user gesture (e.g. the connect click handler). For already-granted hosts this
 * is a no-op; for new hosts it shows the Chrome permission prompt.
 */
async function ensureHostPermission(baseURL: string): Promise<void> {
  let origin: string;
  try {
    const u = new URL(baseURL);
    origin = `${u.protocol}//${u.host}/*`;
  } catch {
    return; // can't parse -- skip (the fetch will just fail with a clear error)
  }
  const granted = await chrome.permissions.contains({ origins: [origin] });
  if (granted) return;
  const ok = await chrome.permissions.request({ origins: [origin] });
  if (!ok) throw new Error(`host permission denied for ${origin}`);
}

async function refreshProviders(): Promise<void> {
  try {
    const resp = await send<{ providers: ProviderDefinition[] }>({ kind: "list_providers" });
    // Guard: a race with another listener could hand us a non-array. Never
    // crash the render loop on a bad response -- fall back to empty.
    state.providers = Array.isArray(resp?.providers) ? resp.providers : [];
  } catch {
    /* SW may be asleep; retry on next user action */
  }
}

function setNotice(msg: string, isError = false): void {
  const el = $("notice");
  if (el) {
    el.textContent = msg;
    el.className = isError ? "notice error" : "notice";
  }
}

/** Toggle the connected (chat) state. Connection now happens via the modal. */
function setConnected(connected: boolean): void {
  const header = document.querySelector("header");
  if (header) header.classList.toggle("connected", connected);
  maybeShowEmptyState();
}

/** Show a friendly greeting when the message list is empty. */
function maybeShowEmptyState(): void {  const wrap = $("messages");
  if (!wrap) return;
  const existing = wrap.querySelector(".empty-state");
  const hasMessages = Array.from(wrap.children).some(
    (c) => !c.classList.contains("empty-state")
  );
  if (hasMessages) {
    existing?.remove();
    return;
  }
  if (existing) return;
  const empty = document.createElement("div");
  empty.className = "empty-state";
  empty.innerHTML = `
    <div class="glyph">A</div>
    <div class="title">What should I do on this page?</div>
    <div class="subtitle">Describe a task in plain language. The agent will read the page, plan, and act — asking before anything risky.</div>
    <div class="suggestions">
      <div class="suggestion" data-prompt="Summarize this page in 3 bullet points.">Summarize this page in 3 bullet points.</div>
      <div class="suggestion" data-prompt="Find the main call-to-action and tell me where it is.">Find the main call-to-action.</div>
      <div class="suggestion" data-prompt="Extract all the links on this page and group them by topic.">Extract all links and group by topic.</div>
    </div>`;
  // Clicking a suggestion fills the composer and sends.
  empty.querySelectorAll<HTMLElement>(".suggestion").forEach((s) => {
    s.addEventListener("click", () => {
      const composer = $("composer") as HTMLTextAreaElement | null;
      if (composer && s.dataset.prompt) {
        composer.value = s.dataset.prompt;
        composer.dispatchEvent(new Event("input"));
        void onSend();
      }
    });
  });
  wrap.appendChild(empty);
}

/**
 * Reflect the current autonomy mode in BOTH the segmented control below the
 * composer and the shield icon inside the composer row. The shield turns gold
 * in "auto" mode as a persistent elevated-risk cue.
 */
function renderAutonomy(): void {
  const mode = state.autonomyMode;
  const ask = $("mode-ask");
  const auto = $("mode-auto");
  if (ask) ask.classList.toggle("active", mode === "ask");
  if (auto) {
    auto.classList.toggle("active", mode === "auto");
    auto.classList.toggle("warn", mode === "auto");
  }
  const shield = $("autonomy-btn");
  if (shield) {
    shield.setAttribute("data-mode", mode);
    shield.title = mode === "auto" ? "Act without asking (no prompts)" : "Ask before acting";
  }
}

/** Switch autonomy mode and persist it to the SW. */
async function setAutonomy(mode: "ask" | "auto"): Promise<void> {
  if (state.autonomyMode === mode) return;
  state.autonomyMode = mode;
  renderAutonomy();
  try {
    await send({ kind: "set_autonomy", mode });
  } catch {
    /* SW may be asleep; the toggle is optimistic and re-syncs on next boot */
  }
}

/** Reflect the notifications toggle state on the bell button. */
function renderNotifyBtn(): void {
  const btn = $("notify-btn");
  if (!btn) return;
  btn.setAttribute("data-on", String(state.notificationsEnabled));
  btn.setAttribute("data-tip", state.notificationsEnabled ? "Notifications: on" : "Notifications: off");
}

/** Flip the chime + toast toggle and persist it. Optimistic; re-syncs on boot. */
async function setNotifications(enabled: boolean): Promise<void> {
  if (state.notificationsEnabled === enabled) return;
  state.notificationsEnabled = enabled;
  renderNotifyBtn();
  try {
    await send({ kind: "set_notifications", enabled });
  } catch {
    /* SW may be asleep; the toggle is optimistic and re-syncs on boot */
  }
}

/** Apply the color theme to <html> and reflect it on the toggle button. */
function applyTheme(theme: "light" | "dark"): void {
  document.documentElement.setAttribute("data-theme", theme);
  const btn = $("theme-btn");
  if (btn) {
    btn.setAttribute("data-theme", theme);
    btn.setAttribute(
      "data-tip",
      theme === "dark" ? "Theme: dark (click for light)" : "Theme: light (click for dark)",
    );
    btn.setAttribute("aria-label", `Switch to ${theme === "dark" ? "light" : "dark"} theme`);
  }
}

/** Toggle light/dark and persist. Optimistic; re-syncs on boot. */
async function setTheme(theme: "light" | "dark"): Promise<void> {
  if (state.theme === theme) return;
  state.theme = theme;
  applyTheme(theme);
  try {
    await send({ kind: "set_theme", theme });
  } catch {
    /* SW may be asleep; the toggle is optimistic and re-syncs on boot */
  }
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function render(): void {
  renderProviderSelect();
  renderModelSelect();
}

function renderProviderSelect(): void {
  // The visible provider control is now the chip + picker. This hidden select
  // is kept in sync for any code that reads .value, but is not user-facing.
  const sel = $("provider-select") as HTMLSelectElement | null;
  if (!sel) return;
  sel.innerHTML = "";
  for (const p of state.providers) {
    const opt = document.createElement("option");
    opt.value = p.id;
    opt.textContent = p.name;
    if (p.id === state.providerId) opt.selected = true;
    sel.appendChild(opt);
  }
  renderProviderChip();
}

function renderModelSelect(): void {
  const sel = $("model-select") as HTMLSelectElement | null;
  if (!sel) return;
  sel.innerHTML = "";
  // No models yet: show WHY instead of an empty control. Models only exist
  // after a provider is configured and its /models API has answered.
  if (state.models.length === 0) {
    const opt = document.createElement("option");
    opt.value = "";
    opt.disabled = true;
    opt.selected = true;
    opt.textContent = state.configuredProviders.has(state.providerId ?? "")
      ? "Loading models…"
      : "Connect a provider first";
    sel.appendChild(opt);
    sel.disabled = true;
    return;
  }
  sel.disabled = false;
  for (const m of state.models) {
    const opt = document.createElement("option");
    opt.value = m.id;
    opt.textContent = `${m.name} (${Math.round(m.contextWindow / 1000)}K ctx${m.canReason ? ", reasoning" : ""}${m.supportsAttachments ? ", vision" : ""})`;
    if (m.id === state.modelId) opt.selected = true;
    sel.appendChild(opt);
  }
}

// ---------------------------------------------------------------------------
// Provider chip + picker + connect modal
// ---------------------------------------------------------------------------

function brandStyle(def: ProviderDefinition): string {
  return def.brandColor ? `background:${def.brandColor}` : "";
}

/** Header chip: current provider icon + name + configured dot. */
function renderProviderChip(): void {
  const chip = $("provider-chip");
  if (!chip) return;
  const def = state.providers.find((p) => p.id === state.providerId) ?? state.providers[0];
  const icon = chip.querySelector(".chip-icon") as HTMLElement | null;
  const name = chip.querySelector(".chip-name") as HTMLElement | null;
  const status = chip.querySelector(".chip-status") as HTMLElement | null;
  if (def) {
    if (icon) {
      icon.textContent = def.icon ?? def.id[0]?.toUpperCase() ?? "?";
      icon.setAttribute("style", brandStyle(def));
    }
    if (name) name.textContent = def.shortName ?? def.name;
    const configured = state.configuredProviders.has(def.id);
    if (status) status.setAttribute("data-configured", String(configured));
  }
}

/** Render the provider grid inside the picker overlay. */
function renderProviderGrid(): void {
  const grid = $("provider-grid");
  if (!grid) return;
  grid.innerHTML = "";
  for (const def of state.providers) {
    const configured = state.configuredProviders.has(def.id);
    const active = def.id === state.providerId;
    const tile = document.createElement("button");
    tile.className = `provider-tile${active ? " active" : ""}`;
    tile.innerHTML = `
      <div class="tile-top">
        <span class="tile-icon" style="${brandStyle(def)}">${def.icon ?? def.id[0]?.toUpperCase() ?? "?"}</span>
        <span>
          <div class="tile-name">${def.shortName ?? def.name}</div>
          <div class="tile-sub">${def.flatRate ? "Subscription" : "Pay per token"}</div>
        </span>
      </div>
      <span class="tile-status ${configured ? "configured" : "not-configured"}">
        <span class="dot"></span>${configured ? "Connected" : "Not set up"}
      </span>`;
    tile.addEventListener("click", () => onProviderTileClick(def.id));
    grid.appendChild(tile);
  }
}

function openProviderPicker(): void {
  renderProviderGrid();
  $("provider-picker")?.removeAttribute("hidden");
}
function closeProviderPicker(): void {
  $("provider-picker")?.setAttribute("hidden", "");
}

/** Tile click: configured -> select; unconfigured -> open the connect modal. */
function onProviderTileClick(providerId: string): void {
  if (state.configuredProviders.has(providerId)) {
    // Switch to it immediately: clear the old provider's list (placeholder
    // shows "Loading models…") and fetch the live list from its API.
    state.providerId = providerId;
    state.modelId = undefined;
    state.models = [];
    renderProviderChip();
    renderModelSelect();
    void refreshModels(providerId);
    closeProviderPicker();
  } else {
    // Open the connect modal for this provider.
    openConnectModal(providerId);
  }
}

// ---- Connect modal ----

let connectTargetId = "";

function openConnectModal(providerId: string): void {
  const def = state.providers.find((p) => p.id === providerId);
  if (!def) return;
  connectTargetId = providerId;
  // Hide the picker behind the modal.
  $("provider-picker")?.setAttribute("hidden", "");

  const title = $("connect-modal-title");
  if (title) title.textContent = `Connect to ${def.shortName ?? def.name}`;

  const body = $("connect-modal-body");
  if (!body) return;
  body.innerHTML = "";
  const wrap = document.createElement("div");
  wrap.className = "connect-body";

  for (const f of def.authFields) {
    const field = document.createElement("div");
    field.className = "field";
    const lbl = document.createElement("label");
    lbl.textContent = f.label;
    const inp = document.createElement("input");
    inp.id = `modal-auth-${f.key}`;
    inp.type = f.type;
    inp.placeholder = f.placeholder ?? "";
    if (f.required) inp.required = true;
    field.append(lbl, inp);
    if (f.help) {
      const help = document.createElement("div");
      help.className = "help";
      help.textContent = f.help;
      field.appendChild(help);
    }
    wrap.appendChild(field);
  }

  // Validation message area.
  const msg = document.createElement("div");
  msg.className = "validation-msg";
  msg.id = "validation-msg";
  wrap.appendChild(msg);

  // Actions: Validate (checks the key live) + Connect (disabled until valid).
  const actions = document.createElement("div");
  actions.className = "connect-actions";
  const validateBtn = document.createElement("button");
  validateBtn.type = "button";
  validateBtn.className = "btn-validate";
  validateBtn.textContent = "Validate";
  const connectBtn = document.createElement("button");
  connectBtn.type = "button";
  connectBtn.className = "btn-connect";
  connectBtn.textContent = "Connect";
  connectBtn.disabled = true;
  actions.append(validateBtn, connectBtn);
  wrap.appendChild(actions);

  // Docs link.
  if (def.docsUrl) {
    const link = document.createElement("div");
    link.className = "connect-footer-link";
    link.innerHTML = `Get a key: <a href="${def.docsUrl}" target="_blank" rel="noopener">${def.docsUrl}</a>`;
    wrap.appendChild(link);
  }

  validateBtn.addEventListener("click", () => void onValidate(connectTargetId, validateBtn, connectBtn, msg));
  connectBtn.addEventListener("click", () => void onConnectFromModal(connectTargetId, connectBtn, msg));

  // Enter inside any auth field acts on the modal: Connect if the key already
  // validated, otherwise Validate — so paste-key → Enter is the whole flow.
  wrap.addEventListener("keydown", (e) => {
    if (e.key !== "Enter" || !(e.target instanceof HTMLInputElement)) return;
    e.preventDefault();
    if (!connectBtn.disabled) connectBtn.click();
    else validateBtn.click();
  });

  body.appendChild(wrap);
  $("connect-modal")?.removeAttribute("hidden");
  // Focus the first auth field so the user can paste their key immediately.
  // rAF: the element must be visible (hidden removed + laid out) to take focus.
  requestAnimationFrame(() => {
    wrap.querySelector<HTMLInputElement>("input")?.focus();
  });
}

function closeConnectModal(): void {
  $("connect-modal")?.setAttribute("hidden", "");
  connectTargetId = "";
}

/** Read auth field values from whichever surface holds them (modal or header). */
function readAuthFields(def: ProviderDefinition, prefix: "modal-auth-" | "auth-"): Record<string, string> {
  const creds: Record<string, string> = {};
  for (const f of def.authFields) {
    const el = document.getElementById(`${prefix}${f.key}`) as HTMLInputElement | null;
    if (el) creds[f.key] = el.value.trim();
  }
  return creds;
}

/** Live-validate a token without persisting it. */
async function onValidate(
  providerId: string,
  validateBtn: HTMLButtonElement,
  connectBtn: HTMLButtonElement,
  msgEl: HTMLElement,
): Promise<void> {
  const def = state.providers.find((p) => p.id === providerId);
  if (!def) return;
  const credentials = readAuthFields(def, "modal-auth-");
  validateBtn.classList.add("checking");
  validateBtn.textContent = "Checking…";
  connectBtn.disabled = true;
  msgEl.className = "validation-msg";
  msgEl.innerHTML = `<span class="spinner"></span> Checking key…`;
  try {
    const res = await send<{ ok: boolean; error?: string }>({ kind: "validate_token", providerId, credentials });
    if (res.ok) {
      msgEl.className = "validation-msg ok";
      msgEl.textContent = "✓ Token is valid.";
      connectBtn.disabled = false;
    } else {
      msgEl.className = "validation-msg err";
      msgEl.textContent = `✕ ${res.error ?? "Invalid token."}`;
      connectBtn.disabled = true;
    }
  } catch (e) {
    msgEl.className = "validation-msg err";
    msgEl.textContent = `✕ ${(e as Error).message}`;
    connectBtn.disabled = true;
  } finally {
    validateBtn.classList.remove("checking");
    validateBtn.textContent = "Validate";
  }
}

/** Connect from the modal: validate again (safety) then persist + switch. */
async function onConnectFromModal(providerId: string, _connectBtn: HTMLButtonElement, msgEl: HTMLElement): Promise<void> {
  const def = state.providers.find((p) => p.id === providerId);
  if (!def) return;
  const credentials = readAuthFields(def, "modal-auth-");
  msgEl.className = "validation-msg";
  msgEl.innerHTML = `<span class="spinner"></span> Connecting…`;
  try {
    // Request host permission FIRST (must stay in this user-gesture stack).
    const baseURL = def.id === "custom" ? credentials.baseURL || def.baseURL : def.baseURL;
    await ensureHostPermission(baseURL);
    const resp = await send<{ models: Model[]; selectedModelId: string }>({
      kind: "connect_provider",
      providerId,
      credentials,
    });
    state.models = Array.isArray(resp?.models) ? resp.models : [];
    state.modelId = resp.selectedModelId || def.defaultLargeModelId || state.models[0]?.id;
    state.providerId = providerId;
    state.configuredProviders.add(providerId);
    setConnected(true);
    renderProviderChip();
    renderModelSelect();
    closeConnectModal();
    setNotice(`Connected to ${def.shortName ?? def.name}. ${state.models.length} models available.`);
    maybeShowEmptyState();
  } catch (e) {
    msgEl.className = "validation-msg err";
    msgEl.textContent = `✕ ${(e as Error).message}`;
  }
}

function appendMessage(m: Message): void {
  const wrap = $("messages");
  if (!wrap) return;
  wrap.querySelector(".empty-state")?.remove();
  const text = messageText(m);
  // A tool-only assistant turn has no text — skip the bubble entirely instead
  // of rendering an empty pill (the tool rows already tell the story).
  if (!text.trim()) return;
  const div = document.createElement("div");
  div.className = `bubble ${m.role}`;
  // Assistant output is rendered Markdown (headings, bold, lists, code).
  // User echoes stay plain text -- a user typing ** shouldn't become bold.
  if (m.role === "assistant") {
    div.innerHTML = renderMarkdown(text);
  } else {
    div.textContent = text;
  }
  wrap.appendChild(div);
  scrollMessages();
  renderExportBtn();
}

/** Compact human-readable preview of tool arguments: `key: value, …`. */
function formatToolArgs(input: Record<string, unknown>): string {
  const entries = Object.entries(input);
  if (entries.length === 0) return "";
  const s = entries
    .map(([k, v]) => `${k}: ${typeof v === "string" ? v : JSON.stringify(v)}`)
    .join(", ");
  return s.length > 120 ? s.slice(0, 120) + "…" : s;
}

/** Header label for a tool row. An empty name (still streaming) shows a
 *  placeholder rather than a bare "()" sliver. */
function toolLabel(name: string, args: string): string {
  if (!name) return "Preparing action…";
  return args ? `${name} · ${args}` : name;
}

function appendToolStarted(name: string, input: Record<string, unknown>): void {
  const wrap = $("messages");
  if (!wrap) return;
  const args = formatToolArgs(input);
  // If a pending row already exists (created by a streaming tool_input_start,
  // possibly before the tool NAME had even arrived), adopt it: update the name
  // and label in place instead of appending a duplicate. Tools execute
  // sequentially, so the pending row is always the one being dispatched.
  if (currentToolRow && currentToolRow.dataset.toolPending === "1") {
    if (name) currentToolRow.dataset.toolName = name;
    const label = currentToolRow.querySelector(".collapse-label");
    if (label) label.textContent = toolLabel(currentToolRow.dataset.toolName ?? "", args);
    return;
  }
  wrap.querySelector(".empty-state")?.remove();
  const row = document.createElement("div");
  row.className = `collapse tool pending${blockStartsOpen(false) ? " open" : ""}`;
  row.dataset.toolName = name;
  row.dataset.toolPending = "1";
  row.innerHTML = `
    <div class="collapse-header">
      <svg class="chevron" viewBox="0 0 10 10"><path d="M3 2L7 5L3 8" stroke="currentColor" stroke-width="1.4" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>
      <span class="collapse-label"></span>
      <span class="collapse-meta"><span class="mini-spinner"></span> running</span>
    </div>
    <div class="collapse-body"></div>`;
  const label = row.querySelector(".collapse-label");
  if (label) label.textContent = toolLabel(name, args);
  bindCollapseToggle(row);
  wrap.appendChild(row);
  currentToolRow = row;
  scrollMessages();
}

/** The tool row currently streaming its input / awaiting a result. */
let currentToolRow: HTMLElement | null = null;

function appendToolResult(name: string, content: string, isError?: boolean): void {
  const wrap = $("messages");
  if (!wrap) return;
  // Attach the result to the pending tool row if one exists (collapses the
  // call + its result into one expandable block). Tools run sequentially, so
  // any pending row is the call this result answers — matching by name would
  // orphan rows whose name streamed in late. Otherwise emit a standalone block.
  const row = currentToolRow && currentToolRow.dataset.toolPending === "1" ? currentToolRow : null;
  currentToolRow = null;

  // Is this content an image data URL? (screenshot tool returns these.)
  const isImage = !isError && content.startsWith("data:image/");

  const preview = isImage
    ? "screenshot captured"
    : content.length > 300
      ? content.slice(0, 300) + "…"
      : content;
  const status = isError ? "error" : isImage ? "image" : `returned ${content.length.toLocaleString()} chars`;

  if (row) {
    row.classList.remove("pending");
    delete row.dataset.toolPending;
    if (isError) row.classList.add("error");
    // If the placeholder never got its real name, fill it in now.
    if (!row.dataset.toolName && name) {
      const label = row.querySelector(".collapse-label");
      if (label) label.textContent = name;
    }
    if (isImage) row.classList.add("has-image");
    const meta = row.querySelector(".collapse-meta");
    if (meta) meta.textContent = status;
    const body = row.querySelector(".collapse-body");
    if (body) populateToolBody(body, content, isImage);
    // Screenshots naturally default to EXPANDED so the image is visible
    // immediately (respecting a sticky "collapse all").
    if (isImage && blockStartsOpen(true)) row.classList.add("open");
  } else {
    const div = document.createElement("div");
    div.className = `collapse tool${isError ? " error" : ""}${isImage ? " has-image" : ""}${blockStartsOpen(isImage) ? " open" : ""}`;
    div.innerHTML = `
      <div class="collapse-header">
        <svg class="chevron" viewBox="0 0 10 10"><path d="M3 2L7 5L3 8" stroke="currentColor" stroke-width="1.4" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>
        <span class="collapse-label">${name} → ${preview}</span>
        <span class="collapse-meta">${status}</span>
      </div>
      <div class="collapse-body"></div>`;
    const body = div.querySelector(".collapse-body");
    if (body) populateToolBody(body, content, isImage);
    bindCollapseToggle(div);
    wrap.appendChild(div);
  }
  scrollMessages();
}

/** Fill a tool-result body. Images render as <img>; everything else is text. */
function populateToolBody(body: Element, content: string, isImage: boolean): void {
  body.innerHTML = "";
  if (isImage) {
    const img = document.createElement("img");
    img.className = "tool-screenshot";
    img.src = content;
    img.alt = "Screenshot captured by the agent";
    img.addEventListener("click", () => showImageLightbox(content));
    body.appendChild(img);
  } else {
    body.textContent = content.length > 4000 ? content.slice(0, 4000) + "\n…[truncated]" : content;
  }
}

/**
 * Full-screen image viewer overlay. Reused for screenshots (Chrome blocks
 * top-frame navigation to data: URLs, so we render in-panel instead).
 */
function showImageLightbox(src: string): void {
  const overlay = document.createElement("div");
  overlay.className = "image-lightbox";
  overlay.innerHTML = `<img src="${src}" alt="Screenshot" />`;
  // Click anywhere (or Esc) to close.
  overlay.addEventListener("click", () => overlay.remove());
  document.body.appendChild(overlay);
}

/**
 * Sticky expand/collapse-all preference. Set by the header button and applied
 * to blocks that arrive LATER too — "collapse all" means the whole
 * conversation, including messages that haven't streamed in yet. null until
 * the button is first used (per-block natural defaults apply).
 */
let allCollapsePref: "open" | "closed" | null = null;

/** Resolve whether a NEW block should start open: the user's sticky
 *  preference wins; otherwise the block's natural default. */
function blockStartsOpen(naturalDefault: boolean): boolean {
  if (allCollapsePref === "open") return true;
  if (allCollapsePref === "closed") return false;
  return naturalDefault;
}

/**
 * Expand or collapse EVERY thinking/tool block at once. The action is decided
 * from the current DOM: if any block is closed, the click opens all; once all
 * are open, the click closes all. The header icon reflects the NEXT action,
 * and the choice sticks for blocks streamed in afterwards.
 */
function toggleAllCollapses(): void {
  const blocks = document.querySelectorAll<HTMLElement>("#messages .collapse");
  if (blocks.length === 0) return;
  const anyClosed = Array.from(blocks).some((b) => !b.classList.contains("open"));
  blocks.forEach((b) => b.classList.toggle("open", anyClosed));
  allCollapsePref = anyClosed ? "open" : "closed";
  updateExpandAllBtn();
}

/** Point the expand-all button at whichever action is available next. */
function updateExpandAllBtn(): void {
  const btn = $("expand-all-btn");
  if (!btn) return;
  const blocks = document.querySelectorAll<HTMLElement>("#messages .collapse");
  const anyClosed = blocks.length === 0 || Array.from(blocks).some((b) => !b.classList.contains("open"));
  btn.setAttribute("data-mode", anyClosed ? "expand" : "collapse");
  btn.setAttribute("data-tip", anyClosed ? "Expand all details" : "Collapse all details");
}

/** Wire click-to-toggle on a collapse block's header. */
function bindCollapseToggle(block: HTMLElement): void {
  const header = block.querySelector(".collapse-header");
  if (!header) return;
  header.addEventListener("click", () => {
    const opened = block.classList.toggle("open");
    // Never yank the chat to the bottom on a manual toggle — the user is
    // READING here. On expand, just make sure the revealed body isn't cut off
    // below the fold; on collapse, stay exactly where we are.
    if (opened) block.scrollIntoView({ block: "nearest", behavior: "smooth" });
    updateExpandAllBtn();
  });
  // A new block is entering the list. Callers bind BEFORE appendChild, so
  // defer one microtask — by then the block is in #messages and counted.
  queueMicrotask(updateExpandAllBtn);
}

function appendError(message: string): void {
  const wrap = $("messages");
  if (!wrap) return;
  const div = document.createElement("div");
  div.className = "bubble error";
  div.textContent = `error: ${message}`;
  wrap.appendChild(div);
  scrollMessages();
}

function showPermissionCard(toolCallId: string, name: string, reason: string, site?: string): void {
  const card = document.createElement("div");
  card.className = "card permission";
  const siteLine = site ? `<div class="card-site">${escapeHtml(site)}</div>` : "";
  card.innerHTML = `<div class="card-title">Permission: ${escapeHtml(name)}</div><div class="card-body">${escapeHtml(reason)}</div>${siteLine}`;

  const allow = document.createElement("button");
  allow.className = "allow";
  allow.textContent = "Allow once";
  allow.onclick = () => {
    void send({ kind: "permission_decision", sessionId: state.sessionId ?? "", toolCallId, decision: "allow" });
    card.remove();
  };

  const allowOnSite = document.createElement("button");
  allowOnSite.className = "allow-on-site";
  allowOnSite.textContent = site ? `Allow on ${shortSite(site)}` : "Allow on this site";
  allowOnSite.title = "Auto-approve ALL tool actions on this site in future. No more prompts here.";
  allowOnSite.onclick = () => {
    if (site) {
      void send({ kind: "permission_decision", sessionId: state.sessionId ?? "", toolCallId, decision: { kind: "always_allow_on_site", site } });
    } else {
      void send({ kind: "permission_decision", sessionId: state.sessionId ?? "", toolCallId, decision: "allow" });
    }
    card.remove();
  };

  const deny = document.createElement("button");
  deny.textContent = "Deny";
  deny.onclick = () => {
    void send({ kind: "permission_decision", sessionId: state.sessionId ?? "", toolCallId, decision: "deny" });
    card.remove();
  };

  // If we don't know the site, hide the domain-grant button (can't key a grant
  // without a hostname). The loop always passes site, but the fallback forwarder
  // may not.
  const actions = document.createElement("div");
  actions.className = "card-actions";
  actions.append(allow);
  if (site) actions.append(allowOnSite);
  actions.append(deny);
  card.append(actions);
  $("messages")?.appendChild(card);
  scrollMessages();
}

/** Escape HTML metacharacters so user-controlled strings (reasons, sites) are
 *  never injected as raw HTML. */
function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] as string));
}

/** Shorten a hostname for display: drop the leading www. and TLD. */
function shortSite(site: string): string {
  return site.replace(/^www\./, "").split(".")[0] || site;
}

// ---------------------------------------------------------------------------
// Plan approval card (ask mode)
// ---------------------------------------------------------------------------

/** The currently-displayed plan card, so plan_step_update can tick steps. */
let currentPlanCard: HTMLElement | null = null;

function showPlanCard(planId: string, steps: PlanStep[]): void {
  const wrap = $("messages");
  if (!wrap) return;
  wrap.querySelector(".empty-state")?.remove();
  // Replace any prior pending plan card (e.g. after a SW restart re-emit).
  currentPlanCard?.remove();

  const card = document.createElement("div");
  card.className = "card plan";
  card.dataset.planId = planId;

  const title = document.createElement("div");
  title.className = "card-title";
  title.innerHTML = `
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 11l3 3L22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/></svg>
    <span class="plan-title-text">Plan</span>
    <span class="plan-status proposed">Proposed</span>`;

  const checklist = document.createElement("div");
  checklist.className = "plan-checklist";
  steps.forEach((st) => {
    const row = document.createElement("div");
    row.className = `plan-step ${st.status}`;
    row.dataset.stepId = st.id;
    row.innerHTML = `
      <span class="step-marker"></span>
      <span class="step-text">
        <span class="step-title">${st.title}</span>
        ${st.detail ? `<span class="step-detail">${st.detail}</span>` : ""}
      </span>`;
    checklist.appendChild(row);
  });

  const actions = document.createElement("div");
  actions.className = "plan-actions";
  const approve = document.createElement("button");
  approve.className = "allow";
  approve.textContent = "Approve plan";
  approve.onclick = () => {
    void send({ kind: "plan_decision", sessionId: state.sessionId ?? "", planId, decision: "approve" });
    setPlanStatus(card, "progress");
    actions.innerHTML = `<span class="plan-running-badge"><span class="mini-spinner"></span> Running…</span>`;
  };
  const reject = document.createElement("button");
  reject.textContent = "Reject";
  reject.onclick = () => {
    void send({ kind: "plan_decision", sessionId: state.sessionId ?? "", planId, decision: "reject" });
    card.remove();
    currentPlanCard = null;
  };
  actions.append(approve, reject);

  card.append(title, checklist, actions);
  wrap.appendChild(card);
  currentPlanCard = card;
  scrollMessages();
}

/** Update the plan card's status badge (proposed / progress / done). */
function setPlanStatus(card: HTMLElement, status: "proposed" | "progress" | "done"): void {
  const badge = card.querySelector(".plan-status");
  if (!badge) return;
  badge.className = `plan-status ${status}`;
  badge.textContent = status === "progress" ? "In progress" : status === "done" ? "Completed" : "Proposed";
  // Also reflect on the card root for border-color theming.
  card.dataset.planStatus = status;
}

/** Tick a plan step as the agent works through it: pending -> progress -> done. */
function tickPlanStep(stepId: string, status: "pending" | "progress" | "done"): void {
  if (!currentPlanCard) return;
  const row = currentPlanCard.querySelector<HTMLElement>(
    `.plan-step[data-step-id="${stepId}"]`,
  );
  if (row) row.className = `plan-step ${status}`;
  // If all steps are done, flip the plan status to Completed.
  if (status === "done") {
    const remaining = currentPlanCard.querySelectorAll(".plan-step:not(.done)");
    if (remaining.length === 0) {
      setPlanStatus(currentPlanCard, "done");
      const actions = currentPlanCard.querySelector(".plan-actions");
      if (actions) actions.innerHTML = `<span class="plan-done-badge">✓ Completed</span>`;
    }
  }
  scrollMessages();
}

function showInterruptedCard(sessionId: string, pending: { id: string; name: string }[]): void {
  const card = document.createElement("div");
  card.className = "card interrupted";
  card.innerHTML = `<div class="card-title">Run was interrupted</div><div class="card-body">Some tool actions may have completed. Pending: ${pending.map((p) => p.name).join(", ") || "none"}</div>`;
  for (const action of ["retry", "skip", "abort"] as const) {
    const btn = document.createElement("button");
    btn.textContent = action;
    btn.onclick = () => {
      void send({ kind: "resume_interrupted", sessionId, action });
      card.remove();
    };
    card.appendChild(btn);
  }
  $("messages")?.appendChild(card);
  scrollMessages();
}

/**
 * Render suggested next-action chips below the last assistant message. A new
 * turn replaces the previous chips (so only one set is on screen at a time).
 * Clicking a chip fills the composer with the action's prompt and sends it --
 * mirroring the empty-state suggestion behavior.
 */
function showSuggestions(_messageId: string, actions: SuggestedAction[]): void {
  const wrap = $("messages");
  if (!wrap || actions.length === 0) return;
  // Remove any previously-shown suggestions row (one set at a time).
  wrap.querySelector(".suggestions-row")?.remove();

  const row = document.createElement("div");
  row.className = "suggestions-row";
  for (const action of actions) {
    const chip = document.createElement("button");
    chip.className = "suggestion-chip";
    chip.type = "button";
    chip.textContent = action.label;
    chip.dataset.prompt = action.prompt;
    chip.addEventListener("click", () => {
      const composer = $("composer") as HTMLTextAreaElement | null;
      if (!composer) return;
      composer.value = action.prompt;
      composer.dispatchEvent(new Event("input"));
      void onSend();
    });
    row.appendChild(chip);
  }
  wrap.appendChild(row);
  scrollMessages();
}

function renderState(s: string): void {
  state.isBusy = !["idle", "done", "error", "paused"].includes(s);
  // Run over (or paused for input) — nothing is coming, drop the dots.
  if (!state.isBusy) hideTyping();
  const el = $("session-state");
  if (el) {
    el.textContent = s;
    el.setAttribute("data-state", s);
  }
  const stop = $("stop-btn");
  if (stop) stop.style.display = s === "running" || s === "streaming" || s === "tool" ? "inline-flex" : "none";
  // Toggle a busy class on the composer so CSS can show a steering hint.
  const composerWrap = document.querySelector(".composer-wrap");
  if (composerWrap) composerWrap.classList.toggle("busy", state.isBusy);
}

/**
 * Handle a queue_update event. When the queue drains to 0, the queued messages
 * have been steered into the model's turn — remove their "Queued" tags so they
 * look like normal sent messages.
 */
function onQueueUpdate(queueLength: number): void {
  // Update the queue count badge near the composer.
  const badge = $("queue-badge");
  if (badge) {
    badge.textContent = queueLength > 0 ? `${queueLength} queued` : "";
    badge.style.display = queueLength > 0 ? "inline-block" : "none";
  }
  // When the queue is empty, any tagged-queued bubbles are now being processed
  // (steered into history or auto-started). Clear their queued styling.
  if (queueLength === 0) {
    document.querySelectorAll(".bubble.user.queued").forEach((el) => {
      el.classList.remove("queued");
      el.querySelector(".queued-tag")?.remove();
    });
  }
}

/**
 * Auto-scroll to the newest content — but ONLY if the user is already reading
 * at (or near) the bottom. If they scrolled up to re-read something, streaming
 * tokens and new rows must not yank them back down; they'll re-stick by
 * scrolling to the bottom themselves.
 */
function scrollMessages(): void {
  const m = $("messages");
  if (!m) return;
  const nearBottom = m.scrollHeight - m.scrollTop - m.clientHeight < 80;
  if (nearBottom) m.scrollTop = m.scrollHeight;
}

/** Unconditional jump to the bottom (used when the USER starts a new turn). */
function scrollMessagesToEnd(): void {
  const m = $("messages");
  if (m) m.scrollTop = m.scrollHeight;
}

// ---------------------------------------------------------------------------
// Memory overlay (what the agent knows about the user)
// ---------------------------------------------------------------------------

const MEMORY_CATEGORIES: { value: UserFactCategory; label: string }[] = [
  { value: "identity", label: "Identity" },
  { value: "preference", label: "Preference" },
  { value: "interest", label: "Interest" },
  { value: "work", label: "Work" },
  { value: "other", label: "Other" },
];

function isMemoryModalHidden(): boolean {
  const el = $("memory-modal");
  return !el || el.hasAttribute("hidden");
}

/** Reflect the memory count on the header brain icon (dim when empty). */
function renderMemoryBtn(): void {
  const btn = $("memory-btn");
  if (!btn) return;
  const n = state.userMemory.length;
  btn.setAttribute("data-empty", n === 0 ? "true" : "false");
  btn.setAttribute(
    "data-tip",
    n === 0
      ? "Memory: the agent hasn't learned anything about you yet"
      : `Memory: ${n} note${n === 1 ? "" : "s"} about you`,
  );
}

// ---------------------------------------------------------------------------
// Conversation export (debug)
// ---------------------------------------------------------------------------

/** Reflect whether there's anything to export on the header download icon. */
function renderExportBtn(): void {
  const btn = $("export-btn");
  if (!btn) return;
  const wrap = $("messages");
  const hasMessages = !!wrap && !!wrap.querySelector(".bubble");
  btn.setAttribute("data-empty", hasMessages ? "false" : "true");
}

/**
 * Download the full current Session as JSON. The panel holds no structured
 * copy of the conversation (it only renders bubbles), so we ask the SW for the
 * stored Session -- which has full debug fidelity: every message part (text,
 * reasoning, tool calls, tool results), token usage, plan/approval state, and
 * abort reasons. No credentials live on Session, so the export is safe.
 */
async function exportConversation(): Promise<void> {
  const res = await send<{ session: Session | null }>({
    kind: "export_session",
    tabId: state.tabId,
    sessionId: state.sessionId,
  }).catch(() => null);
  const session = res?.session;
  if (!session) {
    setNotice("No conversation to export yet.", true);
    return;
  }
  const payload = {
    schema: "agent-session/v1",
    exportedAt: new Date().toISOString(),
    extension: "agent-browser-extension",
    session,
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const date = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
  const a = document.createElement("a");
  a.href = url;
  a.download = `conversation-${session.sessionId}-${date}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Release the blob once the download has started.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}



/** Render the editable list of memory notes inside the modal. */
function renderMemoryList(): void {
  const list = $("memory-list");
  if (!list) return;
  list.innerHTML = "";
  if (state.userMemory.length === 0) {
    const empty = document.createElement("div");
    empty.className = "memory-empty";
    empty.textContent = "Nothing yet. As you chat, the agent will remember your name, interests, and preferences here.";
    list.appendChild(empty);
    return;
  }
  // Group by category, in a fixed order.
  for (const cat of MEMORY_CATEGORIES) {
    const items = state.userMemory.filter((f) => f.category === cat.value);
    if (items.length === 0) continue;
    const group = document.createElement("div");
    group.className = "memory-group";
    const head = document.createElement("div");
    head.className = "memory-group-title";
    head.textContent = cat.label;
    group.appendChild(head);
    for (const fact of items) {
      group.appendChild(buildMemoryRow(fact));
    }
    list.appendChild(group);
  }
}

function buildMemoryRow(fact: UserFact): HTMLElement {
  const row = document.createElement("div");
  row.className = "memory-row";
  row.dataset.id = fact.id;

  const text = document.createElement("input");
  text.className = "memory-input memory-row-text";
  text.type = "text";
  text.dir = "auto";
  text.value = fact.text;
  text.title = fact.text;

  const cat = document.createElement("select");
  cat.className = "memory-select memory-row-cat";
  for (const c of MEMORY_CATEGORIES) {
    const opt = document.createElement("option");
    opt.value = c.value;
    opt.textContent = c.label;
    if (c.value === fact.category) opt.selected = true;
    cat.appendChild(opt);
  }

  const del = document.createElement("button");
  del.className = "memory-row-del icon-btn";
  del.title = "Forget this";
  del.innerHTML = `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/></svg>`;

  // Save on blur (only if something changed).
  const commit = () => {
    const newText = text.value.trim();
    const newCat = cat.value as UserFactCategory;
    if (!newText) {
      // Empty -> delete.
      void deleteMemoryFact(fact.id);
      return;
    }
    if (newText === fact.text && newCat === fact.category) return;
    void upsertMemoryFact({ id: fact.id, category: newCat, text: newText });
  };
  text.addEventListener("blur", commit);
  cat.addEventListener("change", commit);
  del.addEventListener("click", () => void deleteMemoryFact(fact.id));

  row.appendChild(text);
  row.appendChild(cat);
  row.appendChild(del);
  return row;
}

function openMemoryModal(): void {
  const el = $("memory-modal");
  if (!el) return;
  el.removeAttribute("hidden");
  renderMemoryList();
  const addInput = $("memory-new-text") as HTMLInputElement | null;
  if (addInput) addInput.focus();
}

function closeMemoryModal(): void {
  $("memory-modal")?.setAttribute("hidden", "");
}

async function upsertMemoryFact(input: {
  id?: string;
  category: UserFactCategory;
  text: string;
}): Promise<void> {
  const res = await send<{ facts: UserFact[] }>({ kind: "set_memory", fact: input }).catch(() => null);
  if (res?.facts) {
    state.userMemory = res.facts;
    renderMemoryBtn();
    renderMemoryList();
  }
}

async function deleteMemoryFact(id: string): Promise<void> {
  const res = await send<{ facts: UserFact[] }>({ kind: "delete_memory", id }).catch(() => null);
  if (res?.facts) {
    state.userMemory = res.facts;
    renderMemoryBtn();
    renderMemoryList();
  }
}

async function clearAllMemory(): Promise<void> {
  // Confirm before wiping -- this is destructive.
  if (!confirm("Forget everything the agent has learned about you? This cannot be undone.")) {
    return;
  }
  // Reuse the send_message fast-path the SW already handles (it short-circuits
  // a memory wipe without entering the agent loop).
  const res = await send<{ userMemory?: UserFact[] }>({
    kind: "send_message",
    tabId: state.tabId,
    text: "forget everything",
  }).catch(() => null);
  // The fast-path returns { cleared, userMemory, sessionId }. If the shape
  // doesn't match (older SW), fall back to per-id deletion.
  const facts = (res as { userMemory?: UserFact[] } | null)?.userMemory;
  if (facts) {
    state.userMemory = facts;
  } else {
    await Promise.all(state.userMemory.map((f) => send({ kind: "delete_memory", id: f.id }).catch(() => {})));
    state.userMemory = [];
  }
  renderMemoryBtn();
  renderMemoryList();
}



document.addEventListener("DOMContentLoaded", () => {
  void boot();
  $("send-btn")?.addEventListener("click", () => void onSend());
  $("stop-btn")?.addEventListener("click", () => onStop());
  // Provider chip -> open picker.
  $("provider-chip")?.addEventListener("click", () => openProviderPicker());
  $("picker-close")?.addEventListener("click", () => closeProviderPicker());
  // Clicking the backdrop closes the picker.
  $("provider-picker")?.addEventListener("click", (e) => {
    if (e.target === e.currentTarget) closeProviderPicker();
  });
  // Connect modal close.
  $("connect-close")?.addEventListener("click", () => closeConnectModal());
  $("connect-modal")?.addEventListener("click", (e) => {
    if (e.target === e.currentTarget) closeConnectModal();
  });
  $("model-select")?.addEventListener("change", (e) => {
    const value = (e.target as HTMLSelectElement).value;
    if (!value) return; // placeholder row — nothing to select
    state.modelId = value;
    void send({ kind: "select_model", modelId: value });
  });
  $("composer")?.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void onSend();
    }
  });
  // Auto-grow the composer up to a max height.
  const composer = $("composer") as HTMLTextAreaElement | null;
  if (composer) {
    composer.addEventListener("input", () => {
      composer.style.height = "auto";
      composer.style.height = Math.min(composer.scrollHeight, 160) + "px";
    });
  }
  // Autonomy mode toggle. The shield icon in the composer row mirrors the
  // segmented control below it; either control can change the mode.
  $("mode-ask")?.addEventListener("click", () => void setAutonomy("ask"));
  $("mode-auto")?.addEventListener("click", () => void setAutonomy("auto"));
  $("autonomy-btn")?.addEventListener("click", () => {
    void setAutonomy(state.autonomyMode === "ask" ? "auto" : "ask");
  });
  // Notification bell toggle in the header.
  $("notify-btn")?.addEventListener("click", () => {
    void setNotifications(!state.notificationsEnabled);
  });
  // Theme (light/dark) toggle in the header.
  $("theme-btn")?.addEventListener("click", () => {
    void setTheme(state.theme === "dark" ? "light" : "dark");
  });
  // Expand/collapse ALL thinking + tool detail blocks.
  $("expand-all-btn")?.addEventListener("click", () => toggleAllCollapses());
  // Memory overlay (what the agent knows about the user).
  $("memory-btn")?.addEventListener("click", () => openMemoryModal());
  // Export the current conversation as JSON (debug).
  $("export-btn")?.addEventListener("click", () => void exportConversation());
  $("memory-close")?.addEventListener("click", () => closeMemoryModal());
  $("memory-modal")?.addEventListener("click", (e) => {
    if (e.target === e.currentTarget) closeMemoryModal();
  });
  $("memory-add-btn")?.addEventListener("click", () => void onMemoryAdd());
  $("memory-new-text")?.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      void onMemoryAdd();
    }
  });
  $("memory-clear")?.addEventListener("click", () => void clearAllMemory());
  // Esc closes any open overlay.
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      closeConnectModal();
      closeProviderPicker();
      closeMemoryModal();
    }
  });
});

/** Handle the "Add" button in the memory overlay. */
async function onMemoryAdd(): Promise<void> {
  const input = $("memory-new-text") as HTMLInputElement | null;
  const catSel = $("memory-new-cat") as HTMLSelectElement | null;
  if (!input || !catSel) return;
  const text = input.value.trim();
  if (!text) return;
  const category = catSel.value as UserFactCategory;
  await upsertMemoryFact({ category, text });
  input.value = "";
  input.focus();
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function send<T = unknown>(req: PanelRequest): Promise<T> {
  const resp = (await chrome.runtime.sendMessage(req)) as
    | { ok: true; data: T }
    | { ok: false; error: string };
  if (!resp || !resp.ok) throw new Error(resp?.error ?? "no response");
  return resp.data;
}
