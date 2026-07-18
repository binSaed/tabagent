/**
 * Selection-triggered suggestion menu (content script).
 *
 * When the user selects text on a page, a small floating menu appears near the
 * selection offering preset actions (Explain, Summarize, Translate, Rewrite,
 * Ask…). Clicking an action messages the service worker, which opens the side
 * panel and runs the agent with a prefixed prompt built from the selection.
 *
 * Design notes:
 *   - Runs in the isolated world (content script). Cannot be touched by page JS.
 *   - The menu is rendered in a Shadow DOM attached to documentElement so page
 *     CSS never leaks in and SPA body re-renders don't blow it away.
 *   - Appended to documentElement (not body) so it survives SPAs that replace
 *     document.body wholesale.
 *   - Idempotent: guards against double-injection via a window flag.
 */

import type { SelectionAction } from "../shared/protocol";

// Guard against re-injection on SPA navigations that re-run content scripts.
// Cast through unknown because this is an ad-hoc flag not in the Window type.
const win = window as unknown as { __aiAgentSelectionInjected?: boolean };
if (!win.__aiAgentSelectionInjected) {
  win.__aiAgentSelectionInjected = true;
  init();
}

// ---------------------------------------------------------------------------
// Menu shell (Shadow DOM)
// ---------------------------------------------------------------------------

const CONTAINER_ID = "__ai-agent-selection-root__";

interface MenuElements {
  host: HTMLElement;
  root: ShadowRoot;
  box: HTMLElement;
  askInput: HTMLInputElement;
  askWrap: HTMLElement;
}

let menu: MenuElements | null = null;

function getMenu(): MenuElements {
  if (menu) return menu;
  const host = document.createElement("div");
  host.id = CONTAINER_ID;
  host.style.all = "initial"; // defeat any inherited styles
  // Appended to documentElement so SPAs that swap document.body don't drop us.
  document.documentElement.appendChild(host);
  const root = host.attachShadow({ mode: "open" });
  root.innerHTML = STYLE;
  const box = root.querySelector(".ai-box") as HTMLElement;
  const askInput = root.querySelector(".ai-ask-input") as HTMLInputElement;
  const askWrap = root.querySelector(".ai-ask-wrap") as HTMLElement;
  menu = { host, root, box, askInput, askWrap };
  wireMenu(menu);
  return menu;
}

// ---------------------------------------------------------------------------
// Event wiring
// ---------------------------------------------------------------------------

function wireMenu(m: MenuElements): void {
  // Action buttons: each carries data-action.
  m.root.querySelectorAll<HTMLButtonElement>("[data-action]").forEach((btn) => {
    btn.addEventListener("mousedown", (e) => e.preventDefault()); // keep selection
    btn.addEventListener("click", () => {
      const action = btn.dataset.action as SelectionAction | undefined;
      if (!action) return;
      if (action === "ask") {
        // Toggle the inline custom-question field.
        m.askWrap.classList.toggle("open");
        if (m.askWrap.classList.contains("open")) m.askInput.focus();
        return;
      }
      const text = currentSelectionText();
      if (text) void sendAction(action, text);
      hide();
    });
  });

  // Ask input: send on Enter, close on Escape.
  m.askInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      const q = m.askInput.value.trim();
      const text = currentSelectionText();
      if (q && text) void sendAction("ask", text + "\n\nQuestion: " + q);
      hide();
    } else if (e.key === "Escape") {
      hide();
    }
  });
}

/** Register all DOM listeners. Called once (guarded by the injection flag). */
function init(): void {
  // Show the menu only after the mouse comes up with a real selection. We
  // listen on mouseup (most common) + keyup (Shift+arrow selection).
  document.addEventListener("mouseup", () => void maybeShow(), true);
  document.addEventListener("keyup", (e) => {
    if (e.shiftKey || e.key === "Shift") void maybeShow();
  }, true);

  // Hide on any of these.
  document.addEventListener("mousedown", (e) => {
    // Click inside the menu host: let the menu's own handlers deal with it.
    if (menu && menu.host.contains(e.target as Node)) return;
    hide();
  }, true);
  window.addEventListener("blur", hide, true);
  document.addEventListener("scroll", hide, true);
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") hide();
  }, true);
}

// ---------------------------------------------------------------------------
// Show / hide logic
// ---------------------------------------------------------------------------

async function maybeShow(): Promise<void> {
  const sel = window.getSelection();
  const text = sel ? sel.toString().trim() : "";
  if (text.length < 3) {
    hide();
    return;
  }
  // Skip selections inside editable fields (inputs/textareas) -- those are the
  // user's own text being edited, not page content to explain.
  if (isSelectionInEditable(sel)) {
    hide();
    return;
  }
  const rect = selectionRect(sel);
  if (!rect || rect.width === 0 || rect.height === 0) {
    hide();
    return;
  }
  const m = getMenu();
  position(m, rect);
  m.host.style.display = "block";
  // Reset the ask field each time the menu re-shows.
  m.askWrap.classList.remove("open");
  m.askInput.value = "";
}

function hide(): void {
  if (!menu) return;
  menu.host.style.display = "none";
}

function position(m: MenuElements, rect: DOMRect): void {
  const margin = 8;
  // Default: below the selection, left-aligned. The box measures itself to flip
  // when it would overflow the viewport.
  m.host.style.visibility = "hidden";
  m.host.style.display = "block";
  const boxRect = m.box.getBoundingClientRect();
  const boxW = boxRect.width || 240;
  const boxH = boxRect.height || 180;

  let top = rect.bottom + margin + window.scrollY;
  let left = rect.left + window.scrollX;
  // Flip above if it would overflow the bottom.
  if (top + boxH > window.scrollY + window.innerHeight - margin) {
    const above = rect.top - margin - boxH + window.scrollY;
    if (above > window.scrollY) top = above;
  }
  // Clamp horizontally.
  if (left + boxW > window.scrollX + window.innerWidth - margin) {
    left = window.scrollX + window.innerWidth - boxW - margin;
  }
  if (left < window.scrollX + margin) left = window.scrollX + margin;

  m.host.style.top = `${top}px`;
  m.host.style.left = `${left}px`;
  m.host.style.visibility = "visible";
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function currentSelectionText(): string {
  const sel = window.getSelection();
  return sel ? sel.toString().trim().slice(0, 4000) : "";
}

function isSelectionInEditable(sel: Selection | null): boolean {
  if (!sel || sel.rangeCount === 0) return false;
  let node: Node | null = sel.getRangeAt(0).commonAncestorContainer;
  while (node) {
    if (node.nodeType === Node.ELEMENT_NODE) {
      const el = node as HTMLElement;
      const tag = el.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA") return true;
      if (el.isContentEditable) return true;
    }
    node = node.parentNode;
  }
  return false;
}

function selectionRect(sel: Selection | null): DOMRect | null {
  if (!sel || sel.rangeCount === 0) return null;
  try {
    return sel.getRangeAt(0).getBoundingClientRect();
  } catch {
    return null;
  }
}

async function sendAction(action: SelectionAction, text: string): Promise<void> {
  try {
    await chrome.runtime.sendMessage({ kind: "selection_action", action, text });
  } catch {
    // The SW may be mid-restart; silently drop. The selection is still visible.
  }
}

// ---------------------------------------------------------------------------
// Shadow DOM styles (scoped; page CSS can't reach in)
// ---------------------------------------------------------------------------

const STYLE = `
<style>
  :host, .ai-box { all: initial; }
  .ai-box {
    position: relative;
    display: block;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    font-size: 13px;
    color: #e8e8e8;
    background: #1e1e22;
    border: 1px solid #3a3a42;
    border-radius: 10px;
    box-shadow: 0 8px 24px rgba(0,0,0,0.35);
    padding: 4px;
    width: 220px;
    box-sizing: border-box;
    z-index: 2147483647;
    pointer-events: auto;
  }
  .ai-header {
    display: flex; align-items: center; gap: 6px;
    padding: 6px 8px 4px;
    font-size: 11px; font-weight: 600;
    color: #ff6b35;
    text-transform: uppercase; letter-spacing: 0.4px;
  }
  .ai-actions { display: flex; flex-direction: column; gap: 1px; }
  .ai-btn {
    all: unset;
    display: flex; align-items: center; gap: 8px;
    padding: 7px 10px;
    border-radius: 6px;
    cursor: pointer;
    font-size: 13px; color: #d4d4d8;
    transition: background 0.12s;
  }
  .ai-btn:hover { background: #2c2c34; color: #fff; }
  .ai-btn .ai-ico { width: 14px; opacity: 0.85; text-align: center; }
  .ai-ask-wrap { display: none; padding: 4px 6px 6px; }
  .ai-ask-wrap.open { display: block; }
  .ai-ask-input {
    all: unset;
    width: 100%; box-sizing: border-box;
    background: #15151a; border: 1px solid #3a3a42;
    border-radius: 6px; padding: 6px 8px;
    font-size: 13px; color: #e8e8e8;
  }
  .ai-ask-input::placeholder { color: #6b6b75; }
</style>
<div class="ai-box">
  <div class="ai-header">✨ Ask AI</div>
  <div class="ai-actions">
    <button class="ai-btn" data-action="explain"><span class="ai-ico">📖</span> Explain</button>
    <button class="ai-btn" data-action="summarize"><span class="ai-ico">📝</span> Summarize</button>
    <button class="ai-btn" data-action="translate"><span class="ai-ico">🌐</span> Translate</button>
    <button class="ai-btn" data-action="rewrite"><span class="ai-ico">✏️</span> Rewrite</button>
    <button class="ai-btn" data-action="ask"><span class="ai-ico">💬</span> Ask…</button>
  </div>
  <div class="ai-ask-wrap">
    <input class="ai-ask-input" type="text" placeholder="Ask about the selection…" />
  </div>
</div>
`;
