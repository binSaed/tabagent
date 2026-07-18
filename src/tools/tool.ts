/**
 * Tool framework.
 *
 * Two methods (info + run) -- adapted directly from crush/opencode's BaseTool.
 * The permission gating is a property, not a method: the dispatcher decides
 * whether to prompt based on `requiresPermission` + the per-site grant store.
 */

import type { ToolCall, ToolInfo, ToolResult } from "../core/types";

export interface ToolContext {
  tabId: number;
  /** Run a CDP command against the attached debugger target. */
  cdp: <T = unknown>(method: string, params?: unknown) => Promise<T>;
}

export interface BaseTool {
  info(): ToolInfo;
  run(call: ToolCall, ctx: ToolContext): Promise<ToolResult>;
}

/** Tool classification used by the dispatcher for permission + ordering. */
export interface ToolMeta {
  /** Mutates page state (click, type, navigate). Forces serial execution + resnapshot. */
  mutatesPage?: boolean;
  /** Read-only (snapshot, extract, screenshot). Can batch in parallel. */
  readonly?: boolean;
  /** Always require explicit user approval. */
  requiresPermission?: boolean;
}

export interface AnnotatedTool extends BaseTool {
  meta: ToolMeta;
}

export class ToolRegistry {
  private byName = new Map<string, AnnotatedTool>();

  register(tool: AnnotatedTool): void {
    const name = tool.info().name;
    if (this.byName.has(name)) throw new Error(`duplicate tool: ${name}`);
    this.byName.set(name, tool);
  }

  get(name: string): AnnotatedTool | undefined {
    return this.byName.get(name);
  }

  list(): AnnotatedTool[] {
    return [...this.byName.values()];
  }

  /** Schemas for the provider's tool-calling API. */
  schemas(): ToolInfo[] {
    return this.list().map((t) => t.info());
  }
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

export function ok(call: ToolCall, content: string, metadata?: unknown): ToolResult {
  const r: ToolResult = { toolCallId: call.id, name: call.name, content };
  if (metadata !== undefined) r.metadata = metadata;
  return r;
}

export function err(call: ToolCall, message: string): ToolResult {
  return { toolCallId: call.id, name: call.name, content: message, isError: true };
}

/** Parse a tool call's input, returning an error result on bad JSON. */
export function parseInput(call: ToolCall): { ok: true; input: Record<string, unknown> } | { ok: false; error: string } {
  if (!call.input || Object.keys(call.input).length === 0) return { ok: true, input: {} };
  // input is already an object (parsed at the dispatcher boundary); but guard.
  if (typeof call.input === "object") return { ok: true, input: call.input };
  return { ok: false, error: "invalid input: expected object" };
}
