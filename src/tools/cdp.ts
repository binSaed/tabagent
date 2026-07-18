/**
 * CDP bridge over chrome.debugger.
 *
 * Attaches to a target tab and exposes typed `cdp(method, params)` calls.
 * The debugger session is what gives us:
 *   - Page.captureScreenshot       (full-page, beyond viewport)
 *   - Input.dispatch*              (trusted input -- defeats synthetic-event detection)
 *   - DOM.* / Runtime.*            (precise node refs, shadow DOM)
 *
 * As a side effect (Chrome 118+), an attached debugger session keeps the
 * service worker alive for the duration of the agent run -- this is the
 * keepalive mechanism the survival layer relies on.
 *
 * Resilience patterns (modeled after production extensions):
 *   - Per-command timeout via Promise.race. A frozen renderer previously hung
 *     the entire agent loop; now each sendCommand is bounded.
 *   - Auto-reattach: if CDP reports "not attached" / "detached while handling",
 *     we transparently re-attach and retry the command once.
 *   - Attach-in-flight dedupe: concurrent attach calls for the same tab share a
 *     single in-flight promise instead of racing.
 */

const ATTACH_TARGET = (tabId: number) => ({ tabId });

/** Per-command timeout (ms). A frozen renderer shouldn't hang the whole loop. */
const CDP_COMMAND_TIMEOUT_MS = 20_000;
/** Attach timeout (ms). DevTools being open or a crashed renderer must surface. */
const CDP_ATTACH_TIMEOUT_MS = 8_000;

export interface CdpAttached {
  tabId: number;
}

// ---------------------------------------------------------------------------
// Attach-in-flight dedupe
// ---------------------------------------------------------------------------

/** tabId -> in-flight attach promise. Prevents racing concurrent attaches. */
const attachInFlight = new Map<number, Promise<void>>();

function isAlreadyAttachedError(e: unknown): boolean {
  const msg = String((e as Error).message ?? e);
  return msg.includes("Another debugger") || msg.includes("Already attached");
}

function isNotAttachedError(e: unknown): boolean {
  const msg = String((e as Error).message ?? e).toLowerCase();
  return (
    msg.includes("debugger is not attached") ||
    msg.includes("detached while handling command") ||
    msg.includes("not attached to the target")
  );
}

/** Raw chrome.debugger.attach wrapped with a timeout. */
function rawAttach(tabId: number): Promise<void> {
  return new Promise((resolve, reject) => {
    let done = false;
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      reject(
        new Error(
          `debugger_attach_error: chrome.debugger.attach timed out after ${CDP_ATTACH_TIMEOUT_MS}ms on tab ${tabId}. DevTools may be open on this tab, or the renderer may have crashed.`,
        ),
      );
    }, CDP_ATTACH_TIMEOUT_MS);
    chrome.debugger.attach(ATTACH_TARGET(tabId), "1.3", () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      const le = chrome.runtime.lastError;
      if (le) reject(new Error(le.message));
      else resolve();
    });
  });
}

/** Attach the debugger. Idempotent + attach-in-flight dedupe. */
export async function attach(tabId: number): Promise<void> {
  const inflight = attachInFlight.get(tabId);
  if (inflight) return inflight;

  const p = (async () => {
    // Refuse chrome:// and chrome-extension:// pages up front -- the debugger
    // cannot attach to them and the error message is confusing.
    try {
      const tab = await chrome.tabs.get(tabId);
      if (tab.url) {
        let proto = "";
        try {
          proto = new URL(tab.url).protocol;
        } catch {
          /* ignore */
        }
        if (proto === "chrome:" || proto === "chrome-extension:") {
          throw new Error(
            `Cannot attach debugger to ${proto}// pages. Navigate to a regular web page (http:// or https://) first, then retry.`,
          );
        }
      }
    } catch (e) {
      // If we can't even read the tab, rethrow (it's a real error like "no tab").
      if (isAlreadyAttachedError(e)) return;
      throw e;
    }

    try {
      await rawAttach(tabId);
    } catch (e) {
      if (isAlreadyAttachedError(e)) return; // already attached is fine
      throw e;
    }
  })()
    .finally(() => {
      attachInFlight.delete(tabId);
    });

  attachInFlight.set(tabId, p);
  return p;
}

export async function detach(tabId: number): Promise<void> {
  try {
    await chrome.debugger.detach(ATTACH_TARGET(tabId));
  } catch {
    /* already detached */
  }
}

export async function isAttached(tabId: number): Promise<boolean> {
  const targets = await chrome.debugger.getTargets();
  return targets.some((t) => t.tabId === tabId && t.attached);
}

/**
 * Send a single CDP command (one attempt) wrapped in a per-command timeout.
 * Throws on CDP error or timeout. Must be called only while attached.
 */
async function sendCommandOnce<T>(
  tabId: number,
  method: string,
  params?: unknown,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let done = false;
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      reject(
        new Error(
          `CDP sendCommand "${method}" timed out after ${CDP_COMMAND_TIMEOUT_MS}ms on tab ${tabId}. The renderer may be frozen or unresponsive.`,
        ),
      );
    }, CDP_COMMAND_TIMEOUT_MS);
    chrome.debugger.sendCommand(ATTACH_TARGET(tabId), method, params as object | undefined, (result) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      const le = chrome.runtime.lastError;
      if (le) reject(new Error(le.message));
      else resolve(result as T);
    });
  });
}

/**
 * Send a CDP command and await the result. Auto-reattaches once if the
 * debugger was detached between commands (e.g. SW was idle and the target's
 * debugger session lapsed, or the user dismissed then re-shown the banner).
 */
export async function cdp<T = unknown>(tabId: number, method: string, params?: unknown): Promise<T> {
  try {
    return await sendCommandOnce<T>(tabId, method, params);
  } catch (e) {
    if (isNotAttachedError(e)) {
      // Re-attach (idempotent) and retry exactly once.
      await attach(tabId);
      await enableDomains(tabId);
      return await sendCommandOnce<T>(tabId, method, params);
    }
    throw e;
  }
}

// ---------------------------------------------------------------------------
// High-level CDP helpers used by the browser tools
// ---------------------------------------------------------------------------

/** Enable the domains we need (called once after attach). */
export async function enableDomains(tabId: number): Promise<void> {
  await Promise.all([
    cdp(tabId, "Page.enable"),
    cdp(tabId, "Runtime.enable"),
    cdp(tabId, "DOM.enable"),
  ]);
}
