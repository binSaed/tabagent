/**
 * Service worker entry.
 *
 * Wires:
 *   - chrome.runtime.onMessage: the panel <-> SW request/response router.
 *   - chrome.alarms heartbeat: re-arms the loop if the SW was killed during a run.
 *   - chrome.runtime.onStartup / onInstalled: rehydrate sessions from the local mirror.
 *   - chrome.tabs.onRemoved / chrome.debugger.onDetach: clean teardown.
 *   - chrome.action click / commands: open the side panel.
 *
 * v1 streaming note: the OpenAI-compat adapter runs its fetch + SSE parsing in
 * the SW directly. This is safe during a run because the attached debugger
 * keeps the SW alive (Chrome 118+). The offscreen document is wired but
 * dormant -- it's the v2 home for streaming when we want to survive SW death
 * mid-stream without relying on debugger keepalive.
 */

import {
  initStorageAccess,
  listActiveSessions,
  listActiveSessionsLocal,
  loadSession,
  loadSessionLocal,
  loadSettings,
  readProviderCredentials,
  saveSettings,
  unlockCredentials,
  writeEncryptedCredentials,
  loadMemory,
  upsertFact,
  deleteFact,
  clearMemory,
} from "../core/storage";
import { BUILTIN_PROVIDERS, getProviderDefinition } from "../providers/catalog";
import { buildContext, getAdapter } from "../providers/registry";
import type { Session } from "../core/types";
import {
  cancel,
  enqueueMessage,
  isBusy,
  newSession,
  onLoopEvent,
  pause,
  removeSession,
  resumeIfInterrupted,
  run,
  resolveInterrupted,
  type LoopEvent,
} from "./loop";
import { permissions } from "./permissions";
import { planService } from "./plan-service";
import { cdpManager } from "./cdp-manager";
import { dialogHandler } from "./dialog-handler";
import { onLoopEventForNotify } from "./notify";
import type { PanelEvent, PanelRequest, SelectionAction } from "../shared/protocol";

const HEARTBEAT_ALARM = "agent-heartbeat";
const STALE_MS = 120_000;

// ---------------------------------------------------------------------------
// Selection-triggered suggestion: pending prompts awaiting panel boot.
//
// When the content-script menu fires selection_action, the SW opens the side
// panel and starts the run. Opening the panel reboots its document, so we also
// stash the prompt here: the panel, on boot, asks pop_pending_prompt and, if a
// prompt is waiting, auto-sends it. This covers the newly-opened-panel case;
// startSessionForSelection below covers the already-open-panel case.
// ---------------------------------------------------------------------------

const pendingPrompts = new Map<number, { prompt: string; at: number }>();

/** Build the prefixed prompt from a selection action + the selected text. */
function buildSelectionPrompt(action: SelectionAction, text: string): string {
  const sel = text.slice(0, 4000);
  switch (action) {
    case "explain":
      return `Explain this clearly:\n\n"""${sel}"""`;
    case "summarize":
      return `Summarize this concisely:\n\n"""${sel}"""`;
    case "translate":
      return `Translate this to English (if it's already English, translate to Spanish):\n\n"""${sel}"""`;
    case "rewrite":
      return `Rewrite this to be clearer and more concise:\n\n"""${sel}"""`;
    case "ask":
      // The content script already folded the user's question into `text`.
      return sel;
    default:
      return sel;
  }
}

/**
 * Detect a "forget everything I told you" / "wipe your memory about me" intent.
 * Matched in English and Arabic, case-insensitively. Intentionally narrow so it
 * does not fire on a normal question that merely contains the word "forget".
 * The wipe is handled in the SW (not by the model) so it is deterministic and
 * never followed by page actions.
 */
function isForgetEverythingIntent(text: string): boolean {
  const t = text.trim().toLowerCase();
  if (t.length > 120) return false; // these commands are always short
  const patterns = [
    /\bforget\s+(everything|all|everything about me|what you know about me)\b/,
    /\bclear\s+(your|the|all)\s+(memory|memories)\b/,
    /\bwipe\s+(your|the|all)\s+(memory|memories)\b/,
    /\breset\s+(your|the)\s+(memory|memories)\b/,
    /\berase\s+(your|the|all)\s+(memory|memories)\b/,
    /\bforget\s+(me|who i am|everything i told you)\b/,
    // Arabic: "انسَ / انسى / امسح كل اللي/ما تعرفه عني / ذاكرتك / كل حاجة"
    /\u0627\u0646\u0633[\u0649\u064e\u0650]/, // انس / انسى / انسَ
  ];
  if (patterns.slice(0, -1).some((re) => re.test(t))) return true;
  // Arabic compound intent: verb + (everything | about me | your memory)
  const arVerb = /\u0627\u0646\u0633[\u0649\u064e\u0650]|\u0627\u0645\u0633\u062d|\u0646\u0633\u064a\u062a/;
  const arScope = /\u0643\u0644(\u0647|\u0627|\u064a\u0646)|\u0639\u0646\u064a|\u0630\u0627\u0643\u0631\u062a\u0643|\u0627\u0644\u0644\u064a \u062a\u0639\u0631\u0641\u0647\u0627/;
  return arVerb.test(t) && arScope.test(t);
}

/**
 * Start (or enqueue into) the agent run for a selection action. Mirrors the
 * send_message handler's find-or-create + busy-routing logic, but takes the
 * prompt directly instead of from a request field.
 */
async function startSessionForSelection(tabId: number, prompt: string): Promise<void> {
  const settings = await loadSettings();
  if (!settings.providerId || !settings.modelId) {
    // Provider not connected -- leave the prompt pending for the panel; the
    // user will be prompted to connect there.
    return;
  }
  const sessions = await listActiveSessions();
  let session = sessions.find((s) => s.tabId === tabId);
  if (!session || session.state === "done" || session.state === "error") {
    session = await newSession(tabId, settings.providerId, settings.modelId);
  }
  if (isBusy(session)) {
    await enqueueMessage(session.sessionId, prompt);
  } else {
    void run(session.sessionId, prompt);
  }
}

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------

// A promise the message router awaits before serving credential-dependent
// requests. This closes the boot race: the SW can start handling messages the
// instant module evaluation finishes, which may be BEFORE bootstrap()'s
// unlockCredentials() has populated the working copy. Without this gate, a
// returning user's first list_models/connect could read empty creds.
let readyResolve: () => void;
const ready = new Promise<void>((r) => (readyResolve = r));

async function bootstrap(): Promise<void> {
  await initStorageAccess();
  await ensureAlarm();
  await ensureOffscreen();
  // Auto-unlock: decrypt any stored credentials into the session working copy
  // using the stored master key. No user interaction required.
  await unlockCredentials().catch((e) => console.error("[bootstrap] unlock failed:", e));
  readyResolve();
}

void bootstrap();

async function ensureAlarm(): Promise<void> {
  const existing = await chrome.alarms.get(HEARTBEAT_ALARM);
  if (!existing) {
    await chrome.alarms.create(HEARTBEAT_ALARM, { periodInMinutes: 0.5 }); // 30s
  }
}

async function ensureOffscreen(): Promise<void> {
  // The offscreen doc is created eagerly at boot. Its primary job today is
  // playing the notification chime (AUDIO_PLAYBACK); the WORKERS reason keeps
  // it valid for the v2 streaming path too.
  if (await hasOffscreen()) return;
  try {
    await chrome.offscreen.createDocument({
      url: "offscreen.html",
      reasons: ["AUDIO_PLAYBACK", "WORKERS"] as chrome.offscreen.Reason[],
      justification: "Plays notification sounds and hosts long-lived streaming fetches to AI providers.",
    });
  } catch {
    /* already exists */
  }
}

async function hasOffscreen(): Promise<boolean> {
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ["OFFSCREEN_DOCUMENT" as chrome.runtime.ContextType],
  });
  return contexts.length > 0;
}

// ---------------------------------------------------------------------------
// Rehydrate on startup / install
// ---------------------------------------------------------------------------

chrome.runtime.onStartup.addListener(() => void rehydrate());
chrome.runtime.onInstalled.addListener(() => void rehydrate());

async function rehydrate(): Promise<void> {
  // storage.session is empty after a browser restart; the local mirror holds
  // the last-known session states. Mark any non-idle session for recovery.
  const mirror = await listActiveSessionsLocal();
  for (const s of mirror) {
    if (s.debuggerAttached) s.debuggerAttached = false;
    if (["idle", "done", "paused"].includes(s.state)) continue;
    // Treat as interrupted; the loop's resumeIfInterrupted will route safely.
    s.state = "resuming";
    // Re-save to session area so the loop can see it.
    const { saveSession } = await import("../core/storage");
    await saveSession(s);
    try {
      await resumeIfInterrupted(s);
    } catch (e) {
      console.error(`[rehydrate] resume failed for ${s.sessionId}:`, e);
    }
  }
}

// ---------------------------------------------------------------------------
// Heartbeat: catch SW death during a paused/resumable run.
// ---------------------------------------------------------------------------

// All top-level chrome.* event wiring is guarded. A missing API (e.g. a
// permission forgotten in the manifest) MUST NOT throw synchronously at module
// evaluation -- that fails SW registration entirely (status code 15) and masks
// the real cause. Each guard logs once so the cause is still discoverable.
chrome.alarms?.onAlarm?.addListener((alarm) => {
  if (alarm.name !== HEARTBEAT_ALARM) return;
  void heartbeat();
});

async function heartbeat(): Promise<void> {
  const sessions = await listActiveSessions();
  const now = Date.now();
  for (const s of sessions) {
    if (["idle", "done", "paused", "awaiting_permission"].includes(s.state)) continue;
    if (now - s.updatedAt > STALE_MS) {
      // Likely a SW death the debugger-keepalive didn't cover (e.g. paused then idle).
      console.warn(`[heartbeat] stale session ${s.sessionId} (${s.state}); resuming`);
      try {
        await resumeIfInterrupted(s);
      } catch (e) {
        console.error(`[heartbeat] resume failed:`, e);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Message router: panel -> SW
// ---------------------------------------------------------------------------

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  void (async () => {
    // Wait for bootstrap (storage access + credential unlock) before serving,
    // so credential-dependent requests don't race the boot.
    await ready;
    try {
      const data = await handlePanelRequest(msg as PanelRequest, sender);
      sendResponse({ ok: true, data });
    } catch (e) {
      sendResponse({ ok: false, error: (e as Error).message });
    }
  })();
  return true; // keep the channel open for the async response
});

async function handlePanelRequest(req: PanelRequest, sender: chrome.runtime.MessageSender): Promise<unknown> {
  switch (req.kind) {
    case "list_providers":
      return { providers: BUILTIN_PROVIDERS };

    case "list_models": {
      const def = getProviderDefinition(req.providerId);
      if (!def) throw new Error("unknown provider");
      const creds = await readProviderCredentials(req.providerId);
      const ctx = buildContext(def, creds);
      const adapter = getAdapter(def.type);
      const result = await adapter.listModels(ctx);
      return { models: result.models };
    }

    case "seed_models": {
      // Return the catalog's hardcoded seed models with NO network call and NO
      // auth required. Used on boot so the model dropdown is never empty, even
      // before the user connects. (After connect, list_models merges dynamic
      // discovery on top of these.)
      const def = getProviderDefinition(req.providerId);
      if (!def) throw new Error("unknown provider");
      return { models: def.models };
    }

    case "validate_token": {
      // Validate WITHOUT persisting. The panel calls this from the connect
      // modal so the user sees a real auth check before the key is saved.
      const def = getProviderDefinition(req.providerId);
      if (!def) throw new Error("unknown provider");
      const ctx = buildContext(def, req.credentials);
      const adapter = getAdapter(def.type);
      const result = await adapter.validateCredentials(ctx);
      return result; // { ok, error? }
    }

    case "connect_provider": {
      const def = getProviderDefinition(req.providerId);
      if (!def) throw new Error("unknown provider");
      // NOTE: host-permission request is intentionally NOT here.
      // chrome.permissions.request() must run inside a user-gesture call stack,
      // and crossing a sendMessage boundary (panel -> SW) loses the gesture.
      // The panel requests the host permission BEFORE sending connect_provider.
      // Here we validate (real auth check) + persist.
      const ctx = buildContext(def, req.credentials);
      const adapter = getAdapter(def.type);
      // Validate FIRST. Don't persist a bad key.
      const validation = await adapter.validateCredentials(ctx);
      if (!validation.ok) {
        throw new Error(validation.error ?? "validation failed");
      }
      const { models } = await adapter.listModels(ctx);
      // Persist credentials (encrypted at rest with the auto-generated master key).
      const { readWorkingCredentials } = await import("../core/storage");
      const all = await readWorkingCredentials();
      all[req.providerId] = req.credentials;
      await writeEncryptedCredentials(all);
      const selectedModelId = def.defaultLargeModelId || models[0]?.id || "";
      await saveSettings({ providerId: req.providerId, modelId: selectedModelId, initialized: true });
      return { models, selectedModelId };
    }

    case "select_model":
      await saveSettings({ modelId: req.modelId });
      return { ok: true };

    case "set_autonomy":
      await saveSettings({ autonomyMode: req.mode });
      return { ok: true, mode: req.mode };

    case "set_notifications":
      await saveSettings({ notificationsEnabled: req.enabled });
      return { ok: true, enabled: req.enabled };

    case "set_theme":
      await saveSettings({ theme: req.theme });
      return { ok: true, theme: req.theme };

    case "get_memory": {
      const { facts } = await loadMemory();
      return { facts };
    }

    case "set_memory": {
      const fact = await upsertFact({ ...req.fact, source: "manual" });
      const { facts } = await loadMemory();
      return { ok: true, fact, facts };
    }

    case "delete_memory": {
      const removed = await deleteFact(req.id);
      const { facts } = await loadMemory();
      return { ok: true, removed, facts };
    }

    case "export_session": {
      // Debug export: return the full Session so the panel can download it as
      // JSON. No credentials live on Session, so this is safe to hand to the
      // user. We try every storage path so the export works even after a SW
      // restart (session area is wiped on restart -- the local mirror is the
      // crash-recovery source) and even if the panel never captured a sessionId.
      let session: Session | null = null;
      // 1. Exact sessionId the panel already tracks (live session area).
      if (req.sessionId) session = (await loadSession(req.sessionId)) ?? null;
      // 2. Exact sessionId in the local mirror (survives SW/browser restart).
      if (!session && req.sessionId) session = (await loadSessionLocal(req.sessionId)) ?? null;
      // 3. Any active session for this tab (session area).
      if (!session) {
        session = (await listActiveSessions()).find((s) => s.tabId === req.tabId) ?? null;
      }
      // 4. Any session for this tab in the local mirror (post-restart).
      if (!session) {
        session = (await listActiveSessionsLocal()).find((s) => s.tabId === req.tabId) ?? null;
      }
      return { session };
    }

    case "send_message": {
      const settings = await loadSettings();
      const providerId = settings.providerId;
      const modelId = settings.modelId;
      if (!providerId || !modelId) throw new Error("no provider/model selected");
      // Detect the destructive "forget everything" intent BEFORE entering the
      // agent loop. We never want the model to act on the page after such a
      // command, and we want the wipe + confirmation to be deterministic. The
      // command is matched in both English and Arabic.
      if (isForgetEverythingIntent(req.text)) {
        await clearMemory();
        const { facts } = await loadMemory();
        return { ok: true, cleared: true, userMemory: facts, sessionId: null };
      }
      // Find or create a session for this tab.
      const sessions = await listActiveSessions();
      let session = sessions.find((s) => s.tabId === req.tabId);
      if (!session || session.state === "done" || session.state === "error") {
        session = await newSession(req.tabId, providerId, modelId);
      }
      // If a run is already active on this session, QUEUE the message: it will
      // be steered into the model's next turn (drained at the top of the loop)
      // or auto-started after the run finishes. Idle sessions start a new run.
      if (isBusy(session)) {
        await enqueueMessage(session.sessionId, req.text);
        return { sessionId: session.sessionId, queued: true };
      }
      // Run in the background; events flow via onLoopEvent.
      void run(session.sessionId, req.text);
      return { sessionId: session.sessionId, queued: false };
    }

    case "stop":
      await cancel(req.sessionId);
      return { ok: true };

    case "pause":
      await pause(req.sessionId);
      return { ok: true };

    case "resume":
      // v1: resume means start a fresh run on the existing session.
      // (Real mid-run resume is for the recovery path only.)
      return { ok: true };

    case "permission_decision": {
      // Map the wire decision shape to the permission service's Decision type.
      if (req.decision === "allow" || req.decision === "deny") {
        permissions.resolve(req.toolCallId, req.decision);
      } else {
        permissions.resolve(req.toolCallId, req.decision);
      }
      return { ok: true };
    }

    case "plan_decision": {
      planService.resolve(req.planId, req.decision);
      return { ok: true };
    }

    case "resume_interrupted":
      await resolveInterrupted(req.sessionId, req.action);
      return { ok: true };

    case "get_state": {
      if (req.sessionId) {
        const { loadSession } = await import("../core/storage");
        return { session: await loadSession(req.sessionId) };
      }
      const sessions = await listActiveSessions();
      const settings = await loadSettings();
      // Report which providers have stored credentials so the panel can show
      // the "configured" indicator on each provider chip.
      const { readWorkingCredentials } = await import("../core/storage");
      const allCreds = await readWorkingCredentials();
      const configuredProviders: string[] = [];
      for (const def of BUILTIN_PROVIDERS) {
        const creds = allCreds[def.id];
        const hasKey = !!creds && Object.values(creds).some((v) => v && String(v).trim().length > 0);
        if (hasKey) configuredProviders.push(def.id);
      }
      // Include the global user memory so the panel can hydrate its memory
      // overlay on boot without a second round-trip.
      const { facts: userMemory } = await loadMemory();
      return { sessions, settings, configuredProviders, userMemory };
    }

    case "new_session": {
      const settings = await loadSettings();
      if (!settings.providerId || !settings.modelId) throw new Error("no provider/model selected");
      const session = await newSession(req.tabId, settings.providerId, settings.modelId);
      return { sessionId: session.sessionId };
    }

    case "open_side_panel_for_tab":
      await chrome.sidePanel.open({ tabId: req.tabId });
      await chrome.sidePanel.setOptions({
        tabId: req.tabId,
        path: "panel.html",
        enabled: true,
      });
      return { ok: true };

    case "selection_action": {
      // From the content script. The tab id is the SENDER's tab, not a field.
      const tabId = sender.tab?.id;
      if (tabId == null) throw new Error("selection_action: no sender tab");
      const prompt = buildSelectionPrompt(req.action, req.text);
      // Remember the prompt so the panel can auto-send it once it finishes
      // booting (opening the panel reboots its document).
      pendingPrompts.set(tabId, { prompt, at: Date.now() });
      // Open the side panel for this tab.
      await chrome.sidePanel.open({ tabId }).catch(() => {});
      await chrome.sidePanel
        .setOptions({ tabId, path: "panel.html", enabled: true })
        .catch(() => {});
      // Also kick off the run now -- this covers the case where the panel is
      // ALREADY open (its document won't reboot, so pop_pending_prompt won't
      // fire). If the panel is newly opened, this run still happens and the
      // panel picks up the streaming events via its existing listener.
      await startSessionForSelection(tabId, prompt);
      return { ok: true };
    }

    case "pop_pending_prompt": {
      // The panel, on boot, asks: "was there a prompt waiting for my tab?"
      const entry = pendingPrompts.get(req.tabId);
      pendingPrompts.delete(req.tabId);
      if (!entry || Date.now() - entry.at > 30_000) return { prompt: null };
      return { prompt: entry.prompt };
    }

    default:
      return { ignored: true };
  }
}

// ---------------------------------------------------------------------------
// Forward loop events to all extension pages (side panel, popup).
// ---------------------------------------------------------------------------

onLoopEvent((e) => {
  // Translate LoopEvent -> PanelEvent shape and broadcast.
  const panelEvt = loopEventToPanelEvent(e);
  if (panelEvt) {
    void broadcast(panelEvt).catch(() => {});
  }
  // Fire notification sound + toast for finish/attention transitions. Runs
  // alongside broadcast and swallows its own errors (never disturbs the loop).
  void onLoopEventForNotify(e).catch(() => {});
});

function loopEventToPanelEvent(e: LoopEvent): PanelEvent | null {
  switch (e.type) {
    case "state":
      return { kind: "session_state", session: e.session };
    case "stream_part":
      return { kind: "stream_part", sessionId: e.sessionId, part: e.part };
    case "assistant_committed":
      return { kind: "assistant_message", sessionId: e.sessionId, message: e.message };
    case "tool_started":
      return { kind: "tool_call_started", sessionId: e.sessionId, name: e.name, input: e.input };
    case "tool_result":
      return { kind: "tool_result", sessionId: e.sessionId, name: e.name, content: e.content, isError: e.isError };
    case "permission_request":
      return {
        kind: "permission_request",
        sessionId: e.sessionId,
        toolCallId: e.toolCallId,
        name: e.name,
        input: e.input,
        reason: e.reason,
        site: e.site,
      };
    case "plan_proposed":
      return {
        kind: "plan_proposed",
        sessionId: e.sessionId,
        planId: e.planId,
        steps: e.steps,
      };
    case "plan_step_update":
      return {
        kind: "plan_step_update",
        sessionId: e.sessionId,
        stepId: e.stepId,
        status: e.status,
      };
    case "actions_suggested":
      return {
        kind: "actions_suggested",
        sessionId: e.sessionId,
        messageId: e.messageId,
        actions: e.actions,
      };
    case "queue_update":
      return {
        kind: "queue_update",
        sessionId: e.sessionId,
        queue: e.queue,
      };
    case "interrupted":
      return { kind: "interrupted", sessionId: e.sessionId, pendingToolCalls: e.pending };
    case "memory_update":
      return { kind: "memory_update", facts: e.facts };
    case "error":
      return { kind: "error", sessionId: e.sessionId, message: e.message };
    default:
      return null;
  }
}

async function broadcast(evt: PanelEvent): Promise<void> {
  // runtime.sendMessage fans out to all extension contexts (panel + popup).
  try {
    await chrome.runtime.sendMessage(evt);
  } catch {
    /* no receiver */
  }
}

// ---------------------------------------------------------------------------
// Tab lifecycle
// ---------------------------------------------------------------------------

chrome.tabs?.onRemoved?.addListener((tabId) => {
  void (async () => {
    const sessions = await listActiveSessions();
    for (const s of sessions) {
      if (s.tabId === tabId) {
        await removeSession(s.sessionId);
        cdpManager.notifyDetached(tabId, "tab_closed");
      }
    }
  })();
});

// ---------------------------------------------------------------------------
// Action + commands: open the side panel
// ---------------------------------------------------------------------------

chrome.runtime.onInstalled.addListener(async () => {
  // Open the side panel on action click.
  await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
});

chrome.commands?.onCommand.addListener((command) => {
  if (command === "open-side-panel") {
    chrome.tabs.query({ active: true, currentWindow: true }).then(([tab]) => {
      if (tab?.id != null) {
        chrome.sidePanel.open({ tabId: tab.id }).catch(() => {});
      }
    });
  }
});

// Forward permission service pending requests to the panel as events.
permissions.onPendingChange((req) => {
  void chrome.runtime
    .sendMessage({
      kind: "permission_request",
      sessionId: req.sessionId,
      toolCallId: req.toolCallId,
      name: req.name,
      input: req.input,
      reason: req.reason,
    })
    .catch(() => {});
});

// Auto-dismiss JS modal dialogs (alert/confirm/prompt) the agent can't see;
// record beforeunload so navigate() can report a clear error instead of hanging.
dialogHandler.start();
dialogHandler.onDialog((info) => {
  if (!info.autoDismissed) return; // only surface auto-dismissed ones as a note
  void chrome.runtime
    .sendMessage({
      kind: "tool_result",
      sessionId: "",
      name: "system",
      content: `Auto-dismissed a ${info.kind} dialog: "${info.message.slice(0, 120)}"`,
    })
    .catch(() => {});
});

console.log("[background] service worker booted");
