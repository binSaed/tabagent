/** Message construction helpers. Centralizes id/createdAt so callsites stay short. */
import type {
  ContentPart,
  Message,
  MessageRole,
  SuggestedAction,
  SuggestedActionsPart,
  ToolCall,
  ToolCallPart,
  ToolResult,
  ToolResultPart,
} from "./types";
import { uuid } from "./types";

export function message(role: MessageRole, parts: ContentPart[]): Message {
  return { id: uuid(), role, parts, createdAt: Date.now() };
}

export function systemMessage(text: string): Message {
  return message("system", [{ type: "text", text }]);
}

export function userMessage(text: string): Message {
  return message("user", [{ type: "text", text }]);
}

export function assistantText(text: string): Message {
  return message("assistant", [{ type: "text", text }]);
}

/** Build an assistant message from accumulated streamed parts. */
export function assistantFromParts(parts: ContentPart[]): Message {
  return message("assistant", parts);
}

export function toolCallPart(tc: ToolCall): ToolCallPart {
  return { type: "tool_call", id: tc.id, name: tc.name, input: JSON.stringify(tc.input) };
}

export function toolResultPart(r: ToolResult): ToolResultPart {
  const part: ToolResultPart = {
    type: "tool_result",
    toolCallId: r.toolCallId,
    name: r.name,
    content: r.content,
  };
  if (r.metadata !== undefined) part.metadata = r.metadata;
  if (r.isError) part.isError = true;
  return part;
}

export function suggestedActionsPart(actions: SuggestedAction[]): SuggestedActionsPart {
  return { type: "suggested_actions", actions };
}

/** A `tool`-role message holding one or more tool results. */
export function toolMessage(results: ToolResult[]): Message {
  return message(
    "tool",
    results.map(toolResultPart),
  );
}

/** Concatenate all text parts of a message for display. */
export function messageText(m: Message): string {
  return m.parts
    .filter((p): p is Extract<ContentPart, { type: "text" }> => p.type === "text")
    .map((p) => p.text)
    .join("");
}
