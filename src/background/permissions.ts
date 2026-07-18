/**
 * Permission service.
 *
 * Tools with `requiresPermission` (or any mutating tool, depending on policy)
 * call `request()` before executing. The request is surfaced to the side
 * panel; the user's decision resolves the returned Promise.
 *
 * The grant store (per-site) lives in storage.local. Two granularities:
 *   - `${site}::*`         : domain-wide -- ALL tools auto-approved on this site.
 *   - `${site}::${tool}`   : per-tool -- only the named tool auto-approved.
 * The domain-wide grant is the dominant production pattern (Claude, etc.) --
 * prompting once per domain per run, not once per action.
 */

import type { ToolCall } from "../core/types";
import { loadSettings, saveSettings } from "../core/storage";

export type Decision =
  | "allow"
  | "deny"
  | { kind: "always_allow_on_site"; site: string }
  | { kind: "always_allow_tool_on_site"; site: string; tool: string };

interface PendingRequest {
  sessionId: string;
  toolCallId: string;
  name: string;
  input: Record<string, unknown>;
  reason: string;
  resolve: (d: Decision) => void;
}

type Listener = (req: PendingRequest) => void;

/** Wildcard sentinel for domain-wide grants. */
export const SITE_WILDCARD = "*";

class PermissionService {
  private pending = new Map<string, PendingRequest>();
  private listeners = new Set<Listener>();

  onPendingChange(l: Listener): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }

  /** Ask the user. Resolves when they answer (or rejects if run aborts). */
  request(
    sessionId: string,
    call: ToolCall,
    reason: string,
    site: string,
  ): Promise<Decision> {
    // Check the grant store first: domain-wide OR per-tool.
    return this.hasGrant(site, call.name).then((granted) => {
      if (granted) return "allow" as Decision;
      return new Promise<Decision>((resolve) => {
        const req: PendingRequest = {
          sessionId,
          toolCallId: call.id,
          name: call.name,
          input: call.input,
          reason,
          resolve,
        };
        this.pending.set(call.id, req);
        for (const l of this.listeners) l(req);
      });
    });
  }

  /** Resolve a pending request from the UI. */
  resolve(toolCallId: string, decision: Decision): void {
    const req = this.pending.get(toolCallId);
    if (!req) return;
    this.pending.delete(toolCallId);
    if (typeof decision === "object") {
      if (decision.kind === "always_allow_on_site") {
        this.recordGrant(decision.site, SITE_WILDCARD).catch(() => {});
      } else if (decision.kind === "always_allow_tool_on_site") {
        this.recordGrant(decision.site, req.name).catch(() => {});
      }
    }
    req.resolve(decision);
  }

  /** Abort all pending for a session (e.g. user clicked Stop). */
  abortSession(sessionId: string): void {
    for (const [id, req] of this.pending) {
      if (req.sessionId === sessionId) {
        this.pending.delete(id);
        req.resolve("deny");
      }
    }
  }

  pendingForSession(sessionId: string): PendingRequest[] {
    return [...this.pending.values()].filter((p) => p.sessionId === sessionId);
  }

  /**
   * Is this tool granted on this site? True if either:
   *   - a domain-wide grant exists (`${site}::*`), or
   *   - a per-tool grant exists (`${site}::${tool}`).
   */
  private async hasGrant(site: string, tool: string): Promise<boolean> {
    const s = await loadSettings();
    const grants = s.permissionGrants ?? {};
    return grants[`${site}::${SITE_WILDCARD}`] === true || grants[`${site}::${tool}`] === true;
  }

  private async recordGrant(site: string, tool: string): Promise<void> {
    const s = await loadSettings();
    const grants = { ...(s.permissionGrants ?? {}) };
    grants[`${site}::${tool}`] = true;
    await saveSettings({ permissionGrants: grants });
  }
}

export const permissions = new PermissionService();
