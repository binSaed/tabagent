/**
 * CDP attach/detach manager.
 *
 * Wraps chrome.debugger with:
 *   - idempotent attach/detach
 *   - onDetach listener (user clicked "stop debugging" / tab closed)
 *   - domain enable on attach
 */

import { attach, detach, enableDomains } from "../tools/cdp";

type DetachListener = (tabId: number, reason: string) => void;

class CdpManager {
  // attach() now dedupes in-flight attaches itself; we track only the
  // high-level "this tab is under our control" flag for teardown + listeners.
  private attachedTabs = new Set<number>();
  private detachListeners = new Set<DetachListener>();

  onDetach(l: DetachListener): () => void {
    this.detachListeners.add(l);
    return () => this.detachListeners.delete(l);
  }

  isAttached(tabId: number): boolean {
    return this.attachedTabs.has(tabId);
  }

  async attachForRun(tabId: number): Promise<void> {
    if (this.attachedTabs.has(tabId)) return;
    // attach() is idempotent and dedupes concurrent calls; cdp() will re-enable
    // domains transparently on any auto-reattach, so we only enable here once.
    await attach(tabId);
    await enableDomains(tabId);
    this.attachedTabs.add(tabId);
  }

  async detachIfIdle(tabId: number): Promise<void> {
    if (!this.attachedTabs.has(tabId)) return;
    await detach(tabId);
    this.attachedTabs.delete(tabId);
  }

  /** Called when chrome.debugger.onDetach fires. */
  notifyDetached(tabId: number, reason: string): void {
    this.attachedTabs.delete(tabId);
    for (const l of this.detachListeners) l(tabId, reason);
  }
}

export const cdpManager = new CdpManager();

// Wire the chrome event once at SW init.
chrome.debugger?.onDetach?.addListener((source, reason) => {
  if (source?.tabId != null) {
    cdpManager.notifyDetached(source.tabId, reason);
  }
});
