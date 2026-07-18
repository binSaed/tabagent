/**
 * Notification dispatcher.
 *
 * Watches the agent loop's events and fires two kinds of user-facing alerts:
 *
 *   - FINISH: when a session transitions from busy -> idle/done/error/paused,
 *     i.e. an agent run just ended. Fires once per transition (the loop emits a
 *     `state` event on every checkpoint, so we dedupe against lastState).
 *
 *   - ATTENTION: when the user needs to act -- permission_request, plan_proposed,
 *     or interrupted. These surface immediately (the run is parked waiting).
 *
 * Each alert does BOTH:
 *   - playSound()      -> routes `play_sound` to the offscreen doc (owns the
 *                         AudioContext; the SW has no DOM).
 *   - showSystemToast  -> chrome.notifications.create (best-effort; no-op if the
 *                         manifest perm is ever missing).
 *
 * The whole module is best-effort: every step swallows errors so a notification
 * failure can never disturb the agent loop. The `notificationsEnabled` setting
 * gates everything (default ON -- see storage.notificationsAreEnabled).
 */

import type { LoopEvent } from "./loop";
import { isPanelState } from "../shared/protocol";
import { notificationsAreEnabled } from "../core/storage";

// Last-seen state per session, for finish-transition dedupe. Module-scoped
// because there's one SW; cleared entries fall back to "treat as fresh".
const lastState = new Map<string, string>();

/** Entry point -- called from the SW's onLoopEvent hook. Never throws. */
export async function onLoopEventForNotify(e: LoopEvent): Promise<void> {
  try {
    const enabled = await notificationsAreEnabled();
    if (!enabled) {
      // Still track state so the FIRST chime after re-enabling isn't a false
      // finish (e.g. if disabled mid-run, re-enabled after completion).
      if (e.type === "state") lastState.set(e.session.sessionId, e.session.state);
      return;
    }
    switch (e.type) {
      case "state":
        await onState(e.session.sessionId, e.session.state);
        break;
      case "permission_request":
        await notify("Permission needed", `The agent wants to run "${e.name}".`);
        break;
      case "plan_proposed":
        await notify("Plan proposed", "Approve or reject the agent's plan.");
        break;
      case "interrupted":
        await notify(
          "Run interrupted",
          e.pending.length
            ? `Pending: ${e.pending.map((p) => p.name).join(", ")}`
            : "Some actions may need review.",
        );
        break;
    }
  } catch {
    /* notifications are best-effort; never surface to the loop */
  }
}

/** Detect the busy -> terminal transition and fire a finish chime. */
async function onState(sessionId: string, next: string): Promise<void> {
  const prev = lastState.get(sessionId);
  lastState.set(sessionId, next);
  if (!prev) return; // first sighting: no transition to report
  const wasBusy = !isPanelState(prev as Parameters<typeof isPanelState>[0]);
  const isTerminal = isPanelState(next as Parameters<typeof isPanelState>[0]);
  if (wasBusy && isTerminal) {
    await notify("Agent finished", "The agent completed its task.");
  }
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

async function notify(title: string, message: string): Promise<void> {
  await Promise.allSettled([playSound(), showSystemToast(title, message)]);
}

async function playSound(): Promise<void> {
  // The offscreen doc owns the AudioContext. Ensure it exists, then ask it to
  // play. We don't import the SW's own ensureOffscreen (would couple modules);
  // the SW guarantees the doc is up before forwarding loop events.
  await chrome.runtime.sendMessage({ kind: "play_sound", volume: 0.5 }).catch(() => {
    /* doc may be mid-restart; the next event will retry */
  });
}

// 1x1 transparent PNG so chrome.notifications.create has a valid iconUrl
// without us shipping a binary icon asset. (Chrome requires iconUrl for type
// "basic"; an empty/missing value throws.)
const PIXEL_PNG_DATA_URL =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";

async function showSystemToast(title: string, message: string): Promise<void> {
  try {
    if (!chrome.notifications?.create) return; // perm missing / unsupported
    chrome.notifications.create({
      type: "basic",
      iconUrl: PIXEL_PNG_DATA_URL,
      title,
      message,
      priority: 2,
    });
  } catch {
    /* notification perm denied or API unavailable */
  }
}
