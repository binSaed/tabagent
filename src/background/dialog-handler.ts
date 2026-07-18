/**
 * JavaScript dialog handler.
 *
 * Web pages can show modal JS dialogs (alert/confirm/prompt/beforeunload) that
 * block the renderer's event loop until a human dismisses them. The agent can't
 * see these dialogs, so a blocked renderer looks like a hung tool call.
 *
 * Strategy (same as production browser agents):
 *   - Page.javascriptDialogOpening fires when a modal dialog is about to show.
 *     We immediately dismiss it via Page.handleJavaScriptDialog.
 *   - For beforeunload: record the event so the navigate tool can report
 *     "navigation was blocked by an unload handler" instead of hanging.
 *
 * alert/confirm/prompt are auto-dismissed with accept=true (confirm defaults to
 * OK, prompt gets "" -- the least surprising choice for a script that's
 * mid-flow). beforeunload dialogs are NOT auto-dismissed; we record and surface.
 */

type DialogListener = (info: DialogInfo) => void;

export interface DialogInfo {
  tabId: number;
  /** "alert" | "confirm" | "prompt" | "beforeunload" */
  kind: string;
  message: string;
  /** True once we've auto-dismissed it (always false for beforeunload). */
  autoDismissed: boolean;
  at: number;
}

class DialogHandler {
  private listeners = new Set<DialogListener>();
  /** tabId -> most recent beforeunload info (for navigate() to consult). */
  private beforeunloadByTab = new Map<number, DialogInfo>();

  onDialog(l: DialogListener): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }

  /** Start listening for CDP dialog events. Call once at SW boot. */
  start(): void {
    chrome.debugger?.onEvent?.addListener((source, method, params) => {
      if (method !== "Page.javascriptDialogOpening") return;
      const tabId = source?.tabId;
      if (tabId == null) return;
      const p = (params ?? {}) as { message?: string; type?: string };
      const kind = p.type ?? "alert";
      const info: DialogInfo = {
        tabId,
        kind,
        message: p.message ?? "",
        autoDismissed: false,
        at: Date.now(),
      };

      if (kind === "beforeunload") {
        // Don't auto-dismiss -- let the navigate tool decide. Record so it can
        // report a clear error.
        this.beforeunloadByTab.set(tabId, info);
        this.emit(info);
        return;
      }

      // Auto-dismiss alert/confirm/prompt. These freeze the renderer; the agent
      // cannot interact with them and a blocked tab reads as a tool hang.
      void chrome.debugger.sendCommand(
        { tabId },
        "Page.handleJavaScriptDialog",
        { accept: true },
        () => {
          /* lastError already surfaces as a thrown tool error if relevant */
        },
      );
      info.autoDismissed = true;
      this.emit(info);
    });
  }

  /** Did a beforeunload fire on this tab since the last consume/clear? */
  pendingBeforeunload(tabId: number): DialogInfo | undefined {
    const info = this.beforeunloadByTab.get(tabId);
    // Expire stale entries (older than 30s) so a lingering record from a prior
    // navigation attempt doesn't poison a later unrelated one.
    if (info && Date.now() - info.at > 30_000) {
      this.beforeunloadByTab.delete(tabId);
      return undefined;
    }
    return info;
  }

  /** Clear the recorded beforeunload for a tab (called after a successful nav). */
  clearBeforeunload(tabId: number): void {
    this.beforeunloadByTab.delete(tabId);
  }

  private emit(info: DialogInfo): void {
    for (const l of this.listeners) l(info);
  }
}

export const dialogHandler = new DialogHandler();
