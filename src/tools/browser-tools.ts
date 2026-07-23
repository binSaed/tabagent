/**
 * Browser tools (CDP-backed).
 *
 * The core tool set the agent uses to control the active tab. Each tool is a
 * thin wrapper over a CDP command. Element targeting uses `ref` strings from
 * the most recent snapshot.
 *
 * REF STRATEGY: the snapshot injects a walker that builds a ref store on
 * `window` using WeakRef + a reverse WeakMap:
 *
 *   window.__agentRefMap        // ref -> WeakRef<HTMLElement>
 *   window.__agentRefReverse    // HTMLElement -> ref (WeakMap, GC-friendly)
 *
 * This is GC-safe (dead elements don't leak), invisible to the page (no DOM
 * mutation -> no broken tests / MutationObserver storms), and collision-free.
 * Action tools resolve a ref by deref() + document.contains() check.
 */

import type { ToolCall, ToolResult } from "../core/types";
import { renderDomWalk, type DomWalkNode } from "../core/format";
import { err, ok, parseInput, type AnnotatedTool, type ToolContext } from "./tool";
import { dialogHandler } from "../background/dialog-handler";

// ===========================================================================
// snapshot -- the page-state representation the LLM reasons over
// ===========================================================================

const SNAPSHOT_INFO = {
  name: "snapshot",
  description:
    "Capture a snapshot of the current page's interactive elements. Returns a YAML list; each interactive element has a `ref` (e.g. s1e3) you copy verbatim into click/type/select. Call this FIRST to see the page, and again after any action that changes page state.",
  parameters: { type: "object", properties: {} },
};

// Selector for elements we treat as interactive. Kept broad on purpose --
// missing a clickable element is worse than a little noise.
const INTERACTIVE_SELECTOR = [
  "a[href]",
  "button",
  "input",
  "textarea",
  "select",
  "summary",
  "[role='button']",
  "[role='link']",
  "[role='checkbox']",
  "[role='radio']",
  "[role='menuitem']",
  "[role='menuitemcheckbox']",
  "[role='menuitemradio']",
  "[role='combobox']",
  "[role='listbox']",
  "[role='option']",
  "[role='tab']",
  "[role='switch']",
  "[role='slider']",
  "[role='spinbutton']",
  "[role='treeitem']",
  "[contenteditable='true']",
  "[contenteditable='']",
  "[onclick]",
  "[tabindex]",
].join(",");

// Injected into the page. Builds/maintains the WeakRef ref-store and walks the
// DOM for interactive elements + headings. Runs in PAGE context, so it must be
// self-contained (no closures over outer variables).
//
// The walker maintains a STABLE ref store: elements seen before keep their ref
// across snapshots (the reverse WeakMap is the source of truth), only new
// elements get fresh refs. This means a snapshot after a click still resolves
// pre-click refs correctly for elements that survived.
const WALKER_JS = String.raw`
(function () {
  // ---- ref store init (idempotent across snapshots) ----
  if (!window.__agentRefMap)     window.__agentRefMap     = Object.create(null);
  if (!window.__agentRefReverse) window.__agentRefReverse = new WeakMap();
  if (!window.__agentRefCounter) window.__agentRefCounter = 0;

  // ---- helpers ----
  var SELECTOR = ${JSON.stringify(INTERACTIVE_SELECTOR)};

  function isVisible(el) {
    var s = window.getComputedStyle(el);
    if (s.display === "none" || s.visibility === "hidden" || s.opacity === "0") return false;
    return el.offsetWidth > 0 && el.offsetHeight > 0;
  }

  function isInteractive(el) {
    try { return el.matches && el.matches(SELECTOR); } catch (e) { return false; }
  }

  function isSensitive(el) {
    var t = (el.getAttribute && el.getAttribute("type") || "").toLowerCase();
    if (t === "password" || t === "hidden") return true;
    return false;
  }

  // Short strings that are obviously not a field label (they belong to generic
  // helper/icon elements sitting next to a field). Used by the adjacent-text
  // heuristic below so we don't mislabel a textbox as "More information".
  var NON_LABEL = /^(more information|\?|required|optional|\*|close|×|x)$/i;

  function nameOf(el) {
    var aria = el.getAttribute && el.getAttribute("aria-label");
    if (aria && aria.trim()) return aria.trim().slice(0, 120);
    var labelledBy = el.getAttribute && el.getAttribute("aria-labelledby");
    if (labelledBy) {
      var t = document.getElementById(labelledBy);
      if (t && t.textContent && t.textContent.trim()) return t.textContent.replace(/\s+/g, " ").trim().slice(0, 120);
    }
    var ph = el.placeholder;
    if (ph && ph.trim()) return ph.trim().slice(0, 120);
    if (el.title && el.title.trim()) return el.title.trim().slice(0, 120);
    var tag = el.tagName.toLowerCase();
    var isField = tag === "input" || tag === "textarea" || tag === "select" || el.isContentEditable;

    // Form controls frequently have a real LABEL element wired up via the
    // "for" attribute or by wrapping the control. .labels exposes those.
    if (isField && el.labels && el.labels.length) {
      for (var i = 0; i < el.labels.length; i++) {
        var lt = (el.labels[i].textContent || "").replace(/\s+/g, " ").trim();
        if (lt && !NON_LABEL.test(lt)) return lt.slice(0, 120);
      }
    }

    // Adjacent-text heuristic: many apps (e.g. App Store Connect) put a plain
    // text label as a sibling or parent-child text node next to an otherwise
    // unlabeled control. Scan the nearest preceding siblings (then the parent's
    // leading children) for a short text node that looks like a label. This is
    // what lets the model see "What's New" / "Promotional Text" instead of
    // guessing by field order.
    if (isField) {
      var adj = adjacentLabel(el);
      if (adj) return adj;
    }

    if (tag === "input" && el.type) return el.type + " field";
    var txt = (el.innerText || el.textContent || "").replace(/\s+/g, " ").trim();
    if (txt) return txt.slice(0, 120);
    return "";
  }

  // Find a short text label near a form control that has no LABEL element.
  // Looks at up to 3 previous siblings, then up to 3 leading children of the
  // parent, returning the first plausible label text. Returns "" if none.
  function adjacentLabel(el) {
    function clean(node) {
      if (!node) return "";
      // text node
      if (node.nodeType === 3) return (node.nodeValue || "").replace(/\s+/g, " ").trim();
      // element node -- use its own direct text, not descendants, so we don't
      // grab a whole section's worth of content.
      if (node.nodeType === 1) {
        var direct = "";
        for (var i = 0; i < node.childNodes.length; i++) {
          var c = node.childNodes[i];
          if (c.nodeType === 3) direct += c.nodeValue;
        }
        return direct.replace(/\s+/g, " ").trim();
      }
      return "";
    }
    var sib = el.previousSibling;
    var seen = 0;
    while (sib && seen < 3) {
      var t = clean(sib);
      if (t && t.length <= 120 && !NON_LABEL.test(t)) return t.slice(0, 120);
      sib = sib.previousSibling;
      seen++;
    }
    // Fall back to the parent's leading text children.
    var p = el.parentElement;
    if (p) {
      var kids = p.childNodes;
      for (var j = 0; j < kids.length && j < 3; j++) {
        var pt = clean(kids[j]);
        if (pt && pt.length <= 120 && !NON_LABEL.test(pt) && !el.contains(kids[j])) return pt.slice(0, 120);
      }
    }
    return "";
  }

  function roleOf(el) {
    var r = el.getAttribute && el.getAttribute("role");
    if (r) return r;
    var t = el.tagName.toLowerCase();
    if (t === "a") return "link";
    if (t === "button") return "button";
    if (t === "input") {
      var tp = (el.type || "text").toLowerCase();
      if (tp === "checkbox") return "checkbox";
      if (tp === "radio") return "radio";
      if (tp === "submit" || tp === "button" || tp === "reset") return "button";
      return "textbox";
    }
    if (t === "textarea") return "textbox";
    if (t === "select") return "combobox";
    if (t === "summary") return "button";
    if (el.isContentEditable) return "textbox";
    return "generic";
  }

  function depthOf(el) {
    var d = 0, p = el.parentElement;
    while (p && p !== document.body) { d++; p = p.parentElement; }
    return Math.min(d, 6);
  }

  // ---- assign (or reuse) a ref for an element ----
  function refFor(el) {
    var existing = window.__agentRefReverse.get(el);
    if (existing) {
      // Confirm the WeakRef still resolves to this element.
      var w = window.__agentRefMap[existing];
      if (w && w.deref() === el) return existing;
      // Stale: fall through and assign fresh.
    }
    var ref = "s1e" + (++window.__agentRefCounter);
    window.__agentRefMap[ref] = new WeakRef(el);
    window.__agentRefReverse.set(el, ref);
    return ref;
  }

  // ---- walk ----
  var out = [];
  var MAX = 10000; // hard cap, like production walkers

  // 1) Headings for structural context (no ref).
  try {
    document.querySelectorAll("h1,h2,h3,h4,h5,h6").forEach(function (h) {
      if (out.length >= MAX) return;
      var name = nameOf(h);
      if (!name) return;
      out.push({
        role: "heading",
        name: name,
        level: Number(h.tagName.substring(1)),
        depth: depthOf(h)
      });
    });
  } catch (e) {}

  // 2) Interactive elements (light DOM + open shadow roots).
  function walkInteractive(root) {
    var list;
    try {
      list = Array.prototype.slice.call(root.querySelectorAll("*"));
      // Include the root itself if it qualifies (shadow root hosts pass a child).
      if (root.matches && root.matches(SELECTOR)) list.unshift(root);
    } catch (e) { list = []; }
    for (var i = 0; i < list.length; i++) {
      if (out.length >= MAX) break;
      var node = list[i];
      if (!isInteractive(node)) continue;
      // Skip hidden / disabled.
      if (!isVisible(node)) continue;
      if (node.disabled) continue;

      var ref = refFor(node);
      var entry = {
        role: roleOf(node),
        name: nameOf(node),
        ref: ref,
        depth: depthOf(node)
      };
      if (node.tagName === "A" && node.href) entry.url = node.href;
      if ((node.tagName === "INPUT" || node.tagName === "TEXTAREA") && !isSensitive(node)) {
        if (node.value) entry.value = String(node.value).slice(0, 80);
      }
      out.push(entry);
    }
  }

  walkInteractive(document);
  // Open shadow roots of custom elements.
  try {
    document.querySelectorAll("*").forEach(function (el) {
      if (el.shadowRoot && el.shadowRoot.mode === "open") {
        try { walkInteractive(el.shadowRoot); } catch (e) {}
      }
    });
  } catch (e) {}

  // ---- sweep stale WeakRefs ----
  var keys = Object.keys(window.__agentRefMap);
  for (var k = 0; k < keys.length; k++) {
    var key = keys[k];
    if (!window.__agentRefMap[key].deref()) delete window.__agentRefMap[key];
  }

  return { nodes: out, viewport: { width: window.innerWidth, height: window.innerHeight } };
})();
`;

class SnapshotTool implements AnnotatedTool {
  meta = { readonly: true } as const;
  info() {
    return SNAPSHOT_INFO;
  }
  async run(_call: ToolCall, ctx: ToolContext): Promise<ToolResult> {
    try {
      const urlRes = await ctx.cdp<{ result: { value: string } }>("Runtime.evaluate", {
        expression: "location.href",
        returnByValue: true,
      });
      const titleRes = await ctx.cdp<{ result: { value: string } }>("Runtime.evaluate", {
        expression: "document.title",
        returnByValue: true,
      });
      const url = urlRes?.result?.value ?? "";
      const title = titleRes?.result?.value ?? "";

      const walkRes = await ctx.cdp<{ result: { value: { nodes: DomWalkNode[]; viewport: { width: number; height: number } } } }>("Runtime.evaluate", {
        expression: WALKER_JS,
        returnByValue: true,
        awaitPromise: false,
      });
      const walkValue = walkRes?.result?.value;
      if (!walkValue || !Array.isArray(walkValue.nodes)) {
        return err(_call, "snapshot failed: DOM walk returned no nodes (the page may be still loading)");
      }
      const yaml = renderDomWalk(walkValue.nodes, url, title, walkValue.viewport);
      // Refs now live in window.__agentRefMap (WeakRef store); no backend map.
      return ok(_call, yaml, { nodeCount: walkValue.nodes.length });
    } catch (e) {
      return err(_call, `snapshot failed: ${(e as Error).message}`);
    }
  }
}

// ===========================================================================
// click -- dispatch a trusted mouse event at the element's center
// ===========================================================================

const CLICK_INFO = {
  name: "click",
  description:
    "Click an element identified by its snapshot `ref` (e.g. s1e3). Resolves the ref to the element via the last snapshot, scrolls it into view, and dispatches a trusted mouse press at its center.",
  parameters: {
    type: "object",
    properties: {
      ref: { type: "string", description: "The snapshot ref of the element to click." },
      button: { type: "string", enum: ["left", "right", "middle"], description: "Default left." },
      doubleClick: { type: "boolean", description: "Default false." },
    },
    required: ["ref"],
  },
};

class ClickTool implements AnnotatedTool {
  meta = { mutatesPage: true } as const;
  info() {
    return CLICK_INFO;
  }
  async run(call: ToolCall, ctx: ToolContext): Promise<ToolResult> {
    const parsed = parseInput(call);
    if (!parsed.ok) return err(call, parsed.error);
    const ref = String((parsed.input as Record<string, unknown>).ref ?? "");
    const button = (String((parsed.input as Record<string, unknown>).button ?? "left")) as "left" | "right" | "middle";
    const doubleClick = Boolean((parsed.input as Record<string, unknown>).doubleClick);

    if (!ref) return err(call, "missing required parameter: ref");

    // Resolve target center, then VERIFY the target is actually under that
    // point before dispatching. In virtualized menus/overlays the element's
    // rect can be read correctly but a DIFFERENT element renders at that point
    // by the time we click (click-coordinate desync), so the click silently
    // hits the wrong item. We guard twice:
    //   (1) pointHitsTarget: the element under the point must BE the target
    //       (or an ancestor/descendant of it) -- catches positional drift.
    //   (2) pointLabelsMatch: the element under the point must have the SAME
    //       accessible name as the target -- catches content-drift, where a
    //       virtualized slot is recycled to render a different item while the
    //       registered node itself hasn't moved (e.g. the language dropdown
    //       showing a different language at the same coordinate).
    // On either failure: settle (wait for repaint), re-resolve, re-check once.
    // If it still fails, surface a precise error so the caller re-snapshots
    // rather than mis-selecting.
    let box = await resolveCenter(ctx, ref);
    if ("error" in box) return err(call, box.error);
    let hits = await pointHitsTarget(ctx, ref, box.cx, box.cy);
    let labelsOk = hits ? await pointLabelsMatch(ctx, ref, box.cx, box.cy) : false;
    if (!hits || !labelsOk) {
      await waitForRepaint(ctx);
      box = await resolveCenter(ctx, ref);
      if ("error" in box) return err(call, box.error);
      hits = await pointHitsTarget(ctx, ref, box.cx, box.cy);
      labelsOk = hits ? await pointLabelsMatch(ctx, ref, box.cx, box.cy) : false;
    }
    if (!hits || !labelsOk) {
      return err(
        call,
        `ref "${ref}" drifted before the click: the element under its resolved ` +
          `click point is not the intended target (the page re-rendered after ` +
          `scroll, e.g. a virtualized menu whose items recycled). The click would ` +
          `hit the wrong element, so it was aborted. Call snapshot() to get fresh ` +
          `refs, then retry.`,
      );
    }

    try {
      // Move the mouse to the target first so :hover/focus-on-mousedown apply.
      // This matches real user behavior and is required by many custom controls.
      await ctx.cdp("Input.dispatchMouseEvent", {
        type: "mouseMoved",
        x: box.cx,
        y: box.cy,
      });
      const clickCount = doubleClick ? 2 : 1;
      for (let i = 1; i <= clickCount; i++) {
        await ctx.cdp("Input.dispatchMouseEvent", {
          type: "mousePressed",
          x: box.cx,
          y: box.cy,
          button,
          clickCount: i,
        });
        await ctx.cdp("Input.dispatchMouseEvent", {
          type: "mouseReleased",
          x: box.cx,
          y: box.cy,
          button,
          clickCount: i,
        });
      }
      return ok(call, `clicked ${ref} at (${Math.round(box.cx)}, ${Math.round(box.cy)})`);
    } catch (e) {
      return err(call, `click failed: ${(e as Error).message}`);
    }
  }
}

// ===========================================================================
// type -- focus an element by ref and type text into it
// ===========================================================================

const TYPE_INFO = {
  name: "type",
  description:
    "Focus the element identified by snapshot `ref` and type `text` into it. Clears the field first by default (clearFirst: true). Multi-line text is supported: embed '\\n' for line/paragraph breaks -- each is translated to a real Enter press, so <textarea>/contenteditable fields keep their line breaks. For static page content (e.g. translation), use set_text instead.",
  parameters: {
    type: "object",
    properties: {
      ref: { type: "string" },
      text: { type: "string" },
      clearFirst: { type: "boolean", description: "Default true." },
      submit: { type: "boolean", description: "Press Enter after typing. Default false." },
    },
    required: ["ref", "text"],
  },
};

class TypeTool implements AnnotatedTool {
  meta = { mutatesPage: true } as const;
  info() {
    return TYPE_INFO;
  }
  async run(call: ToolCall, ctx: ToolContext): Promise<ToolResult> {
    const parsed = parseInput(call);
    if (!parsed.ok) return err(call, parsed.error);
    const ref = String((parsed.input as Record<string, unknown>).ref ?? "");
    const text = String((parsed.input as Record<string, unknown>).text ?? "");
    const clearFirst = ((parsed.input as Record<string, unknown>).clearFirst ?? true) as boolean;
    const submit = Boolean((parsed.input as Record<string, unknown>).submit);
    if (!ref) return err(call, "missing required parameter: ref");

    const focused = await focusByRef(ctx, ref, clearFirst);
    if (!focused.ok) return err(call, focused.error);

    try {
      // Prefer the NATIVE VALUE SETTER for <input>/<textarea>. This is the
      // reliable way to enter text that contains newlines into React/Vue/etc.
      // controlled components: assigning el.value = text directly often gets
      // reverted by the framework's reconciliation, but going through the
      // prototype descriptor setter (the trick Playwright uses) bypasses the
      // framework's value tracker so the subsequent `input` event sticks, and
      // it preserves literal '\n' characters (which keystroke-based typing
      // routinely loses in rich editors -- the failure that corrupted every
      // entry in a prior run, collapsing two paragraphs into one line).
      const setRes = await setValueNative(ctx, ref, text);
      if (!setRes.ok) {
        // Not a value-bearing control (e.g. contenteditable). Fall back to
        // keystroke dispatch, splitting on '\n' and translating each newline
        // into a real Enter press so multi-line text keeps its breaks.
        const runs = text.split("\n");
        for (let i = 0; i < runs.length; i++) {
          if (i > 0) {
            await ctx.cdp("Input.dispatchKeyEvent", { type: "rawKeyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
            await ctx.cdp("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
          }
          const run = runs[i];
          if (run.length === 0) continue;
          try {
            await ctx.cdp("Input.insertText", { text: run });
          } catch {
            for (const ch of run) {
              await ctx.cdp("Input.dispatchKeyEvent", { type: "char", text: ch });
            }
          }
        }
      }
      if (submit) {
        await ctx.cdp("Input.dispatchKeyEvent", { type: "rawKeyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
        await ctx.cdp("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
      }

      // VERIFY: re-read the field value. If the text contained newlines but
      // the field does not, the multi-line content was lost (the exact failure
      // that previously corrupted release notes). Surface a WARNING so the
      // model can recover instead of asserting success on a malformed entry.
      const wantNewlines = text.includes("\n");
      const got = await readValue(ctx, ref);
      const newlineLost = wantNewlines && typeof got === "string" && !got.includes("\n");
      let content = `typed ${text.length} chars into ${ref}${submit ? " + Enter" : ""}`;
      if (newlineLost) {
        content +=
          `\nWARNING: the text contained line breaks but the field value now ` +
          `has none ("${got.replace(/\s+/g, " ").slice(0, 80)}..."). Multi-line ` +
          `content was NOT preserved. Try clearFirst:false and re-type, or split ` +
          `the entry into separate fields. Do NOT report this step as complete.`;
      } else if (typeof got === "string" && got.trim() && !textEndsWith(got, text)) {
        content += `\nWARNING: the field value does not match the text you typed. Verify before continuing.`;
      }
      return ok(call, content);
    } catch (e) {
      return err(call, `type failed: ${(e as Error).message}`);
    }
  }
}

// ===========================================================================
// navigate -- change the page URL
// ===========================================================================

const NAVIGATE_INFO = {
  name: "navigate",
  description: "Navigate the active tab to a URL.",
  parameters: {
    type: "object",
    properties: { url: { type: "string", description: "Absolute URL." } },
    required: ["url"],
  },
};

class NavigateTool implements AnnotatedTool {
  meta = { mutatesPage: true, requiresPermission: true } as const;
  info() {
    return NAVIGATE_INFO;
  }
  async run(call: ToolCall, ctx: ToolContext): Promise<ToolResult> {
    const parsed = parseInput(call);
    if (!parsed.ok) return err(call, parsed.error);
    const url = String((parsed.input as Record<string, unknown>).url ?? "");
    if (!url) return err(call, "missing required parameter: url");
    try {
      const res = await ctx.cdp<{ errorText?: string }>("Page.navigate", { url });
      // CDP returns errorText when navigation is blocked (beforeunload, invalid
      // URL, etc.). The beforeunload case reads as "navigation was blocked" --
      // surface a clear, actionable error so the model can inform the user.
      if (res?.errorText) {
        return err(call, `navigation blocked: ${res.errorText}. The page may have unsaved changes (beforeunload). Ask the user whether to force it.`);
      }
      // Clear any stale beforeunload record now that nav succeeded.
      dialogHandler.clearBeforeunload(ctx.tabId);
      return ok(call, `navigated to ${url}`);
    } catch (e) {
      return err(call, `navigate failed: ${(e as Error).message}`);
    }
  }
}

// ===========================================================================
// scroll -- scroll the page by an amount in a direction
// ===========================================================================

const SCROLL_INFO = {
  name: "scroll",
  description:
    "Scroll the page up/down/left/right by a number of pixels (approximate; one scroll notch is about 100px). Useful for reaching off-screen elements before snapshotting. Prefer scroll_to when you have a target ref.",
  parameters: {
    type: "object",
    properties: {
      direction: { type: "string", enum: ["up", "down", "left", "right"], description: "Default down." },
      amount: { type: "number", description: "Pixels to scroll. Default 400." },
    },
  },
};

class ScrollTool implements AnnotatedTool {
  meta = { mutatesPage: true } as const;
  info() {
    return SCROLL_INFO;
  }
  async run(call: ToolCall, ctx: ToolContext): Promise<ToolResult> {
    const parsed = parseInput(call);
    if (!parsed.ok) return err(call, parsed.error);
    const direction = (String((parsed.input as Record<string, unknown>).direction ?? "down")) as "up" | "down" | "left" | "right";
    const amount = Number((parsed.input as Record<string, unknown>).amount ?? 400);
    let deltaX = 0, deltaY = 0;
    switch (direction) {
      case "up": deltaY = -amount; break;
      case "down": deltaY = amount; break;
      case "left": deltaX = -amount; break;
      case "right": deltaX = amount; break;
    }
    try {
      // mouseWheel is the most reliable scroll primitive -- it dispatches a real
      // wheel event that infinite-scroll and lazy-load listeners respond to,
      // unlike window.scrollTo. The cursor x/y just need to be inside the
      // viewport; center is a safe choice.
      await ctx.cdp("Input.dispatchMouseEvent", {
        type: "mouseWheel",
        x: 400,
        y: 400,
        deltaX,
        deltaY,
      });
      return ok(call, `scrolled ${direction} by ${amount}px`);
    } catch (e) {
      return err(call, `scroll failed: ${(e as Error).message}`);
    }
  }
}

// ===========================================================================
// scroll_to -- scroll an element (by ref) into view
// ===========================================================================

const SCROLL_TO_INFO = {
  name: "scroll_to",
  description:
    "Scroll the element identified by snapshot `ref` into view (centered). Use this when an element exists in the snapshot but is off-screen and click/type need it visible first.",
  parameters: {
    type: "object",
    properties: { ref: { type: "string", description: "The snapshot ref to scroll to." } },
    required: ["ref"],
  },
};

class ScrollToTool implements AnnotatedTool {
  meta = { mutatesPage: true } as const;
  info() {
    return SCROLL_TO_INFO;
  }
  async run(call: ToolCall, ctx: ToolContext): Promise<ToolResult> {
    const parsed = parseInput(call);
    if (!parsed.ok) return err(call, parsed.error);
    const ref = String((parsed.input as Record<string, unknown>).ref ?? "");
    if (!ref) return err(call, "missing required parameter: ref");
    const res = await scrollRefIntoView(ctx, ref);
    if ("error" in res) return err(call, res.error);
    return ok(call, `scrolled ${ref} into view`);
  }
}

// ===========================================================================
// hover -- move the mouse to an element without clicking
// ===========================================================================

const HOVER_INFO = {
  name: "hover",
  description:
    "Move the mouse cursor to the element identified by snapshot `ref` without clicking. Reveals tooltips, dropdown menus, and triggers :hover states. Resolves the ref and dispatches a mouseMoved event at its center.",
  parameters: {
    type: "object",
    properties: { ref: { type: "string", description: "The snapshot ref to hover." } },
    required: ["ref"],
  },
};

class HoverTool implements AnnotatedTool {
  meta = { mutatesPage: true } as const;
  info() {
    return HOVER_INFO;
  }
  async run(call: ToolCall, ctx: ToolContext): Promise<ToolResult> {
    const parsed = parseInput(call);
    if (!parsed.ok) return err(call, parsed.error);
    const ref = String((parsed.input as Record<string, unknown>).ref ?? "");
    if (!ref) return err(call, "missing required parameter: ref");
    const box = await resolveCenter(ctx, ref);
    if ("error" in box) return err(call, box.error);
    try {
      await ctx.cdp("Input.dispatchMouseEvent", { type: "mouseMoved", x: box.cx, y: box.cy });
      return ok(call, `hovered ${ref} at (${Math.round(box.cx)}, ${Math.round(box.cy)})`);
    } catch (e) {
      return err(call, `hover failed: ${(e as Error).message}`);
    }
  }
}

// ===========================================================================
// press_key -- press a keyboard key or key combo
// ===========================================================================

// Keys that don't produce a character and need a code/vkeyCode. Maps a friendly
// name the model can use to the CDP key fields.
const KEY_MAP: Record<string, { key: string; code: string; keyCode: number; shift?: boolean }> = {
  enter: { key: "Enter", code: "Enter", keyCode: 13 },
  tab: { key: "Tab", code: "Tab", keyCode: 9 },
  escape: { key: "Escape", code: "Escape", keyCode: 27 },
  backspace: { key: "Backspace", code: "Backspace", keyCode: 8 },
  delete: { key: "Delete", code: "Delete", keyCode: 46 },
  space: { key: " ", code: "Space", keyCode: 32 },
  arrowup: { key: "ArrowUp", code: "ArrowUp", keyCode: 38 },
  arrowdown: { key: "ArrowDown", code: "ArrowDown", keyCode: 40 },
  arrowleft: { key: "ArrowLeft", code: "ArrowLeft", keyCode: 37 },
  arrowright: { key: "ArrowRight", code: "ArrowRight", keyCode: 39 },
  home: { key: "Home", code: "Home", keyCode: 36 },
  end: { key: "End", code: "End", keyCode: 35 },
  pageup: { key: "PageUp", code: "PageUp", keyCode: 33 },
  pagedown: { key: "PageDown", code: "PageDown", keyCode: 34 },
};

const PRESS_KEY_INFO = {
  name: "press_key",
  description:
    "Press a keyboard key (e.g. Escape to close a modal, Tab to move focus, ArrowDown to navigate a dropdown, Enter to submit). Supports modifier combos with '+' (e.g. 'ctrl+a', 'shift+tab'). Use `type` for typing text; use this for single keys/combos.",
  parameters: {
    type: "object",
    properties: {
      key: {
        type: "string",
        description: "Key name. Special: enter, tab, escape, backspace, delete, space, arrowup/down/left/right, home, end, pageup, pagedown. Single letters a-z. Combos with +: 'ctrl+a', 'shift+tab', 'ctrl+enter'.",
      },
    },
    required: ["key"],
  },
};

class PressKeyTool implements AnnotatedTool {
  meta = { mutatesPage: true } as const;
  info() {
    return PRESS_KEY_INFO;
  }
  async run(call: ToolCall, ctx: ToolContext): Promise<ToolResult> {
    const parsed = parseInput(call);
    if (!parsed.ok) return err(call, parsed.error);
    const raw = String((parsed.input as Record<string, unknown>).key ?? "").trim();
    if (!raw) return err(call, "missing required parameter: key");

    // Parse modifier combos: ctrl+a, shift+tab, etc.
    const parts = raw.toLowerCase().split("+").map((s) => s.trim());
    const keyName = parts[parts.length - 1];
    const mods = parts.slice(0, -1);
    const ctrl = mods.includes("ctrl");
    const meta = mods.includes("cmd") || mods.includes("meta");
    const shift = mods.includes("shift");
    const alt = mods.includes("alt");
    // CDP modifier bitmask: 1=alt, 2=ctrl, 4=meta/cmd, 8=shift
    const modifier = (alt ? 1 : 0) + (ctrl ? 2 : 0) + (meta ? 4 : 0) + (shift ? 8 : 0);

    try {
      const mapped = KEY_MAP[keyName];
      if (mapped) {
        // Non-character key: full keydown/keyup with code + keyCode.
        await ctx.cdp("Input.dispatchKeyEvent", {
          type: "rawKeyDown",
          key: mapped.key,
          code: mapped.code,
          windowsVirtualKeyCode: mapped.keyCode,
          modifiers: modifier,
        });
        await ctx.cdp("Input.dispatchKeyEvent", {
          type: "keyUp",
          key: mapped.key,
          code: mapped.code,
          windowsVirtualKeyCode: mapped.keyCode,
          modifiers: modifier,
        });
      } else if (keyName.length === 1) {
        // Single character: use char event so the keystroke types.
        const ch = shift ? keyName.toUpperCase() : keyName;
        await ctx.cdp("Input.dispatchKeyEvent", { type: "char", text: ch, modifiers: modifier });
      } else {
        return err(call, `unknown key "${keyName}". Supported: ${Object.keys(KEY_MAP).join(", ")}, or a single character.`);
      }
      return ok(call, `pressed ${raw}`);
    } catch (e) {
      return err(call, `press_key failed: ${(e as Error).message}`);
    }
  }
}

// ===========================================================================
// screenshot -- JPEG, adaptive quality + token-budget resize
//
// Full-page PNGs were corrupting our history and blowing the storage.session
// quota. The strategy now:
//   1. Capture as JPEG quality 80 (5-10x smaller than PNG).
//   2. If the result is within budget, return it directly.
//   3. Otherwise hand the base64 to a content script that resizes on a token
//      budget (28px/token, 1568 token cap) and adaptively steps JPEG quality
//      down (0.75 -> 0.10 in 0.05 steps) until under the byte budget.
// ===========================================================================

// 1.4MB base64 ceiling ≈ 1MB decoded. Keeps well under storage.session quota
// even with several screenshots in history.
const MAX_BASE64_CHARS = 1_398_100;
const INITIAL_JPEG_QUALITY = 0.75;
const JPEG_QUALITY_STEP = 0.05;
const MIN_JPEG_QUALITY = 0.1;

const SCREENSHOT_INFO = {
  name: "screenshot",
  description:
    "Capture a screenshot of the current page (full scrollable area by default). Returns a data: URL. Use this only when vision is needed (canvas, maps, visual cues); prefer `snapshot` for normal interaction.",
  parameters: {
    type: "object",
    properties: {
      clip: {
        type: "object",
        description: "Optional {x,y,width,height} in CSS pixels to capture a region.",
        properties: {
          x: { type: "number" },
          y: { type: "number" },
          width: { type: "number" },
          height: { type: "number" },
        },
      },
    },
  },
};

class ScreenshotTool implements AnnotatedTool {
  meta = { readonly: true } as const;
  info() {
    return SCREENSHOT_INFO;
  }
  async run(call: ToolCall, ctx: ToolContext): Promise<ToolResult> {
    const parsed = parseInput(call);
    if (!parsed.ok) return err(call, parsed.error);
    const clip = (parsed.input as Record<string, unknown>).clip as
      | { x: number; y: number; width: number; height: number }
      | undefined;
    try {
      // Capture at quality 80 first. If under budget, return as-is -- this is
      // the common case for region/viewport captures.
      const params: Record<string, unknown> = { format: "jpeg", quality: 80 };
      if (clip) params.clip = { ...clip, scale: 1 };
      else params.captureBeyondViewport = true;
      const res = await ctx.cdp<{ data: string }>("Page.captureScreenshot", params);
      const dataUrl = `data:image/jpeg;base64,${res.data}`;

      // Within budget -> done.
      if (res.data.length <= MAX_BASE64_CHARS) return ok(call, dataUrl);

      // Over budget (huge full-page capture). Resize via a content script
      // using chrome.scripting (the script runs in the tab, with DOM access
      // to <canvas>, which the service worker lacks).
      const shrunk = await resizeScreenshot(ctx.tabId, res.data, "jpeg");
      if (shrunk) return ok(call, `data:image/jpeg;base64,${shrunk}`);
      // Resize failed -- return the original rather than nothing; the model
      // can still see it, just at the cost of history size.
      return ok(call, dataUrl);
    } catch (e) {
      return err(call, `screenshot failed: ${(e as Error).message}`);
    }
  }
}

// ===========================================================================
// extractText -- visible text of the page or a region
// ===========================================================================

const EXTRACT_TEXT_INFO = {
  name: "extractText",
  description:
    "Extract the visible text content of the page (or a region by ref). Returns plain text, useful for summarization or when a full snapshot is overkill.",
  parameters: {
    type: "object",
    properties: {
      ref: { type: "string", description: "Optional snapshot ref to scope to a subtree." },
      maxChars: { type: "number", description: "Truncate to this length. Default 20000." },
    },
  },
};

class ExtractTextTool implements AnnotatedTool {
  meta = { readonly: true } as const;
  info() {
    return EXTRACT_TEXT_INFO;
  }
  async run(call: ToolCall, ctx: ToolContext): Promise<ToolResult> {
    const parsed = parseInput(call);
    if (!parsed.ok) return err(call, parsed.error);
    const ref = (parsed.input as Record<string, unknown>).ref as string | undefined;
    const maxChars = ((parsed.input as Record<string, unknown>).maxChars ?? 20000) as number;

    try {
      // Resolve ref -> element via the WeakRef store, then read innerText.
      let expression: string;
      if (ref) {
        expression =
          "(() => { const w = window.__agentRefMap && window.__agentRefMap[" +
          JSON.stringify(ref) +
          "]; const el = w && w.deref(); if (!el || !document.contains(el)) return null; " +
          "return el.innerText || el.textContent || ''; })()";
      } else {
        expression = "document.body ? document.body.innerText : ''";
      }
      const res = await ctx.cdp<{ result: { value: string | null } }>("Runtime.evaluate", {
        expression,
        returnByValue: true,
      });
      let text = res?.result?.value ?? "";
      if (!text && ref) {
        return err(call, `ref "${ref}" is no longer on the page. Call snapshot() to refresh refs.`);
      }
      if (text.length > maxChars) {
        const head = text.slice(0, maxChars / 2);
        const tail = text.slice(-maxChars / 2);
        text = `${head}\n...[truncated ${text.length - maxChars} chars]...\n${tail}`;
      }
      return ok(call, text);
    } catch (e) {
      return err(call, `extractText failed: ${(e as Error).message}`);
    }
  }
}

// ===========================================================================
// set_text -- rewrite an element's visible text directly in the DOM
//
// Unlike `type` (which simulates keystrokes into a focused field), this tool
// overwrites an element's text content in place. It's the tool to use for
// page-content edits that don't go through an input -- chiefly TRANSLATION:
// "translate this page to X" means rewriting <p>/<h1>/etc. text nodes, not
// typing into a field.
//
// Works by resolving the ref to a live element via the WeakRef store, then
// replacing its visible text while preserving the element's tag/attributes.
// For a batch (e.g. all paragraphs), call once per ref.
// ===========================================================================

const SET_TEXT_INFO = {
  name: "set_text",
  description:
    "Rewrite the visible text of an element identified by snapshot `ref` directly in the page DOM. Use this to CHANGE page content -- the canonical use case is translating the page: snapshot to get refs, translate the text yourself, then call set_text for each element with its translated text. Unlike `type`, this does NOT need a focused input field; it overwrites the element's text content in place. Preserves the element's tag and structure. Direction (LTR/RTL) is set automatically from the text -- Arabic/Hebrew/Persian/Urdu text flips the element to right-to-left, so you do NOT need to manage direction yourself.",
  parameters: {
    type: "object",
    properties: {
      ref: { type: "string", description: "The snapshot ref of the element whose text to replace." },
      text: { type: "string", description: "The new text content for the element." },
    },
    required: ["ref", "text"],
  },
};

class SetTextTool implements AnnotatedTool {
  meta = { mutatesPage: true } as const;
  info() {
    return SET_TEXT_INFO;
  }
  async run(call: ToolCall, ctx: ToolContext): Promise<ToolResult> {
    const parsed = parseInput(call);
    if (!parsed.ok) return err(call, parsed.error);
    const ref = String((parsed.input as Record<string, unknown>).ref ?? "");
    const text = String((parsed.input as Record<string, unknown>).text ?? "");
    if (!ref) return err(call, "missing required parameter: ref");

    const res = await setElementText(ctx, ref, text);
    if (!res.ok) return err(call, res.error);
    return ok(call, `updated text of ${ref} (${text.length} chars)`);
  }
}

// ===========================================================================
// Ref resolution helpers
//
// Refs live in window.__agentRefMap as WeakRef<HTMLElement> + a reverse
// WeakMap. Action tools deref + document.contains() check, scroll into view,
// force a reflow, then read getBoundingClientRect for fresh coordinates.
// ===========================================================================

/**
 * Re-query the element via the WeakRef store and compute its center in viewport
 * coordinates, scrolling it into view first. Returns null if the element is
 * gone/unreachable (page navigated, element removed, ref never assigned).
 */
async function resolveCenter(
  ctx: ToolContext,
  ref: string,
): Promise<{ cx: number; cy: number } | { error: string }> {
  // Single round-trip: lookup -> scrollIntoView -> offsetHeight (force reflow)
  // -> getBoundingClientRect. The offsetHeight read is critical: without it the
  // rect can reflect the PRE-scroll position.
  const js = String.raw`
(function (ref) {
  var w = window.__agentRefMap && window.__agentRefMap[ref];
  if (!w) return null;
  var el = w.deref();
  if (!el || !document.contains(el)) {
    if (window.__agentRefMap) delete window.__agentRefMap[ref];
    return null;
  }
  el.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
  // Force layout so getBoundingClientRect reflects the post-scroll position.
  if (el instanceof HTMLElement) el.offsetHeight;
  var r = el.getBoundingClientRect();
  if (r.width === 0 || r.height === 0) return { error: "element has zero size (hidden or collapsed)" };
  return { cx: r.left + r.width / 2, cy: r.top + r.height / 2 };
})`;
  try {
    const res = await ctx.cdp<{ result: { value: { cx: number; cy: number } | { error: string } | null } }>(
      "Runtime.evaluate",
      {
        expression: `${js}(${JSON.stringify(ref)})`,
        returnByValue: true,
      },
    );
    const val = res?.result?.value;
    if (!val) {
      return {
        error:
          `ref "${ref}" is no longer on the page (it was removed or the page ` +
          `navigated). Call snapshot() to get fresh refs, then retry.`,
      };
    }
    if ("error" in val) return { error: val.error };
    return { cx: val.cx, cy: val.cy };
  } catch (e) {
    return { error: `could not resolve ref "${ref}": ${(e as Error).message}` };
  }
}

/**
 * Verify that the element identified by `ref` is actually under the given
 * viewport point (cx, cy). This catches the "click-coordinate desync" failure
 * mode: in virtualized menus/overlays (e.g. App Store Connect's language
 * dropdown), an element can be scrolled into view and its rect read, but the
 * DOM under that point at click time is a DIFFERENT element (e.g. the row that
 * happens to render at that fixed Y), so the click lands on the wrong target.
 *
 * Match policy: the element under the point (or its ancestor chain, or its
 * descendant subtree) must contain the target element. Returns true on match.
 */
async function pointHitsTarget(
  ctx: ToolContext,
  ref: string,
  cx: number,
  cy: number,
): Promise<boolean> {
  const js = String.raw`
(function (ref, x, y) {
  var w = window.__agentRefMap && window.__agentRefMap[ref];
  if (!w) return false;
  var el = w.deref();
  if (!el || !document.contains(el)) return false;
  var hit = document.elementFromPoint(x, y);
  if (!hit) return false;
  if (hit === el) return true;
  // The clicked point may land on a descendant/child (icon, span) of the target.
  if (el.contains(hit)) return true;
  // Or the target may be nested inside the element occupying the point (wrapper).
  if (hit.contains(el)) return true;
  return false;
})`;
  try {
    const res = await ctx.cdp<{ result: { value: boolean } }>("Runtime.evaluate", {
      expression: `${js}(${JSON.stringify(ref)}, ${JSON.stringify(cx)}, ${JSON.stringify(cy)})`,
      returnByValue: true,
    });
    return Boolean(res?.result?.value);
  } catch {
    return false;
  }
}

/**
 * Catch CONTENT-DRIFT in virtualized menus: a position check (pointHitsTarget)
 * passes when the registered node is still physically under the point, but in a
 * virtualized list the SAME DOM slot can be recycled to render a different item
 * (e.g. the language dropdown's row at Y=522 shows "English (U.S.)" when the ref
 * is captured, then "Italian" by click time). This compares the accessible name
 * of the element actually under the point with the target element's own name;
 * a mismatch means the slot now represents a different item, so the click would
 * land on the wrong target.
 *
 * Returns true when names match OR when the point element is a descendant/
 * wrapper of the target (icons/labels inside a menuitem). Returns false on a
 * genuine name mismatch.
 */
async function pointLabelsMatch(
  ctx: ToolContext,
  ref: string,
  cx: number,
  cy: number,
): Promise<boolean> {
  const js = String.raw`
(function (ref, x, y) {
  function nameOf(el) {
    if (!el || !el.getAttribute) return "";
    var a = el.getAttribute("aria-label");
    if (a && a.trim()) return a.trim();
    var lb = el.getAttribute("aria-labelledby");
    if (lb) { var t = document.getElementById(lb); if (t) return (t.textContent||"").trim(); }
    return (el.textContent || "").replace(/\s+/g, " ").trim();
  }
  var w = window.__agentRefMap && window.__agentRefMap[ref];
  if (!w) return true; // can't check; don't block
  var el = w.deref();
  if (!el || !document.contains(el)) return true;
  var hit = document.elementFromPoint(x, y);
  if (!hit) return true;
  // If the point element is the target or nested within it, names are irrelevant.
  if (hit === el || el.contains(hit) || hit.contains(el)) return true;
  var a = nameOf(el), b = nameOf(hit);
  if (!a || !b) return true; // no name to compare; don't block
  return a === b;
})`;
  try {
    const res = await ctx.cdp<{ result: { value: boolean } }>("Runtime.evaluate", {
      expression: `${js}(${JSON.stringify(ref)}, ${JSON.stringify(cx)}, ${JSON.stringify(cy)})`,
      returnByValue: true,
    });
    return Boolean(res?.result?.value);
  } catch {
    return true; // can't check; don't block
  }
}

/**
 * Wait one animation frame + a short macrotask delay so async overlays
 * (virtualized lists, portals) can finish rendering after a scroll. Returns
 * via CDP by evaluating a promise on the page; capped at ~400ms.
 */
async function waitForRepaint(ctx: ToolContext): Promise<void> {
  const js = String.raw`
new Promise(function (resolve) {
  requestAnimationFrame(function () {
    requestAnimationFrame(function () { setTimeout(resolve, 60); });
  });
})`;
  try {
    await ctx.cdp("Runtime.evaluate", { expression: js, awaitPromise: true, returnByValue: true });
  } catch {
    // Best-effort; ignore failures so the click still proceeds.
  }
}

/**
 * Focus an element by ref (for typing). Returns true on success.
 */
async function focusByRef(
  ctx: ToolContext,
  ref: string,
  clearFirst: boolean,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const js = String.raw`
(function (ref, clearFirst) {
  var w = window.__agentRefMap && window.__agentRefMap[ref];
  if (!w) return false;
  var el = w.deref();
  if (!el || !document.contains(el)) {
    if (window.__agentRefMap) delete window.__agentRefMap[ref];
    return false;
  }
  try {
    el.scrollIntoView({ block: "center", behavior: "instant" });
    if (el instanceof HTMLElement) el.offsetHeight;
    el.focus({ preventScroll: true });
    if (clearFirst && (el.value !== undefined)) {
      el.value = "";
      el.dispatchEvent(new Event("input", { bubbles: true }));
    }
    return true;
  } catch (e) { return false; }
})`;
  try {
    const res = await ctx.cdp<{ result: { value: boolean } }>("Runtime.evaluate", {
      expression: `${js}(${JSON.stringify(ref)}, ${JSON.stringify(clearFirst)})`,
      returnByValue: true,
    });
    if (!res?.result?.value) {
      return {
        ok: false,
        error:
          `ref "${ref}" is no longer focusable on the page (removed, hidden, or ` +
          `page navigated). Call snapshot() to get fresh refs, then retry.`,
      };
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, error: `could not focus ref "${ref}": ${(e as Error).message}` };
  }
}

/**
 * Set the value of an <input>/<textarea> via the NATIVE prototype descriptor
 * setter, then dispatch `input` (and `change` for <input>). This is the
 * Playwright technique: bypassing the element's own value setter defeats
 * React/Vue's controlled-component reconciliation, which would otherwise
 * revert a direct `el.value = ...` assignment on the next render. Critically
 * it also preserves literal '\n' characters, which keystroke-based typing
 * loses in many rich editors.
 *
 * Returns { ok: false } (not an error) when the element is not a value-bearing
 * control, so the caller can fall back to keystroke dispatch.
 */
async function setValueNative(
  ctx: ToolContext,
  ref: string,
  text: string,
): Promise<{ ok: true } | { ok: false }> {
  const js = String.raw`
(function (ref, text) {
  var w = window.__agentRefMap && window.__agentRefMap[ref];
  if (!w) return { ok: false };
  var el = w.deref();
  if (!el || !document.contains(el)) {
    if (window.__agentRefMap) delete window.__agentRefMap[ref];
    return { ok: false };
  }
  var tag = el.tagName;
  if (tag !== "INPUT" && tag !== "TEXTAREA") return { ok: false };
  // Use the prototype descriptor setter to bypass framework value trackers.
  var proto = tag === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  var desc = Object.getOwnPropertyDescriptor(proto, "value");
  if (desc && desc.set) {
    desc.set.call(el, text);
  } else {
    el.value = text;
  }
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
  return { ok: true };
})`;
  try {
    const res = await ctx.cdp<{ result: { value: { ok: boolean } } }>("Runtime.evaluate", {
      expression: `${js}(${JSON.stringify(ref)}, ${JSON.stringify(text)})`,
      returnByValue: true,
    });
    return res?.result?.value?.ok ? { ok: true } : { ok: false };
  } catch {
    return { ok: false };
  }
}

/**
 * Read the current value/text of the element identified by `ref`. For
 * <input>/<textarea> returns `.value`; for contenteditable returns the inner
 * text; returns null if the element is gone. Used for post-type verification.
 */
async function readValue(ctx: ToolContext, ref: string): Promise<string | null> {
  const js = String.raw`
(function (ref) {
  var w = window.__agentRefMap && window.__agentRefMap[ref];
  if (!w) return null;
  var el = w.deref();
  if (!el || !document.contains(el)) return null;
  if (el.value !== undefined && el.value !== null) return el.value;
  if (el.isContentEditable) return (el.innerText || el.textContent || "");
  return null;
})`;
  try {
    const res = await ctx.cdp<{ result: { value: string | null } }>("Runtime.evaluate", {
      expression: `${js}(${JSON.stringify(ref)})`,
      returnByValue: true,
    });
    return res?.result?.value ?? null;
  } catch {
    return null;
  }
}

/** True if `value` ends with `text` (ignoring leading/trailing whitespace on
 *  `value`, which frameworks sometimes pad). Used by the post-type check. */
function textEndsWith(value: string, text: string): boolean {
  return value.trimEnd().endsWith(text.trimEnd());
}

/**
 * Scroll an element (by ref) into view, centered. Returns success or an error.
 * Same deref/document.contains/reflow pattern as resolveCenter.
 */
async function scrollRefIntoView(
  ctx: ToolContext,
  ref: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const js = String.raw`
(function (ref) {
  var w = window.__agentRefMap && window.__agentRefMap[ref];
  if (!w) return { ok: false, error: "ref not found" };
  var el = w.deref();
  if (!el || !document.contains(el)) {
    if (window.__agentRefMap) delete window.__agentRefMap[ref];
    return { ok: false, error: "ref no longer on page" };
  }
  el.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
  if (el instanceof HTMLElement) el.offsetHeight;
  return { ok: true };
})`;
  try {
    const res = await ctx.cdp<{ result: { value: { ok: boolean; error?: string } } }>("Runtime.evaluate", {
      expression: `${js}(${JSON.stringify(ref)})`,
      returnByValue: true,
    });
    const val = res?.result?.value;
    if (!val?.ok) {
      return {
        ok: false,
        error: `ref "${ref}" ${val?.error ?? "is no longer on the page"}. Call snapshot() to get fresh refs, then retry.`,
      };
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, error: `could not scroll to ref "${ref}": ${(e as Error).message}` };
  }
}

/**
 * Overwrite the visible text of the element identified by `ref` with `text`,
 * preserving the element's tag and attributes. Also sets the element's `dir`
 * attribute from the script direction of the new text, so RTL languages
 * (Arabic, Hebrew, Persian, Urdu, ...) render right-to-left automatically.
 *
 * Strategy: if the element has a single text-node child, replace that node's
 * data (cheapest, preserves inline structure). Otherwise set textContent --
 * this collapses nested markup to plain text, which is exactly what you want
 * for a full-text replacement like translation (you don't want to keep stale
 * nested English spans around a translated string). We avoid touching
 * <input>/<textarea> values here; use `type` for fields.
 *
 * Direction detection follows the Unicode Bidirectional Algorithm's notion of
 * "paragraph level": the first STRONG directional character wins. Arabic/Hebrew
 * letter ranges -> rtl; Latin/Cyrillic/CJK/etc. -> ltr. Numbers, punctuation,
 * and whitespace are weak/neutral and skipped. This is robust to mixed content
 * and requires no language lookup table.
 */
async function setElementText(
  ctx: ToolContext,
  ref: string,
  text: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const js = String.raw`
(function (ref, text) {
  var w = window.__agentRefMap && window.__agentRefMap[ref];
  if (!w) return { ok: false, error: "ref not found" };
  var el = w.deref();
  if (!el || !document.contains(el)) {
    if (window.__agentRefMap) delete window.__agentRefMap[ref];
    return { ok: false, error: "ref no longer on page" };
  }
  // Don't clobber form controls -- 'type' is the right tool for those.
  var tag = el.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || el.isContentEditable) {
    return { ok: false, error: "ref is an input/textarea/contenteditable; use the 'type' tool instead" };
  }
  // Fast path: single text-node child -> mutate in place (keeps any inline
  // element wrappers like <span> intact when there's exactly one text node).
  if (el.childNodes.length === 1 && el.childNodes[0].nodeType === Node.TEXT_NODE) {
    el.childNodes[0].nodeValue = text;
  } else {
    el.textContent = text;
  }
  // Set direction from the script of the new text. First STRONG character wins
  // (Unicode Bidi P2). RTL ranges: Arabic (0x0600-0x06FF, 0x0750-0x077F,
  // 0x08A0-0x08FF), Hebrew (0x0590-0x05FF), Arabic Presentation Forms
  // (0xFB50-0xFDFF, 0xFE70-0xFEFF), and extensions for Persian/Urdu/etc.
  // (0x0780-0x07BF Thaana, 0xFB00-0xFB4F). Anything else -> LTR.
  var dir = "ltr";
  for (var i = 0; i < text.length; i++) {
    var c = text.charCodeAt(i);
    if (
      (c >= 0x0590 && c <= 0x05FF) || // Hebrew
      (c >= 0x0600 && c <= 0x06FF) || // Arabic
      (c >= 0x0700 && c <= 0x07BF) || // Syriac / Thaana / NKo etc.
      (c >= 0x0750 && c <= 0x077F) || // Arabic supplement
      (c >= 0x08A0 && c <= 0x08FF) || // Arabic extended-A
      (c >= 0xFB1D && c <= 0xFDFF) || // Hebrew/Arabic presentation forms-A
      (c >= 0xFE70 && c <= 0xFEFF)    // Arabic presentation forms-B
    ) {
      dir = "rtl";
      break;
    }
    // Latin / Cyrillic / Greek / CJK / etc. are strong LTR. We only need to
    // check the Hebrew/Arabic blocks above; any other letter is LTR by default,
    // so there's no explicit LTR early-out needed -- we just let the loop finish
    // and dir stays "ltr".
  }
  el.setAttribute("dir", dir);
  return { ok: true, dir: dir };
})`;
  try {
    const res = await ctx.cdp<{ result: { value: { ok: boolean; error?: string } } }>("Runtime.evaluate", {
      expression: `${js}(${JSON.stringify(ref)}, ${JSON.stringify(text)})`,
      returnByValue: true,
    });
    const val = res?.result?.value;
    if (!val?.ok) {
      return {
        ok: false,
        error: `ref "${ref}" ${val?.error ?? "could not be updated"}. Call snapshot() to get fresh refs, then retry.`,
      };
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, error: `could not set text for ref "${ref}": ${(e as Error).message}` };
  }
}
// Runs in the tab so it has DOM access (canvas). Token-budget resize + adaptive
// JPEG quality stepping, modeled after production extensions.
// ===========================================================================

const RESIZE_FUNC = (base64: string, format: string, maxChars: number, initialQ: number, qStep: number, minQ: number): Promise<string | null> => {
  const dataUrl = "data:image/" + format + ";base64," + base64;
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      const pxPerToken = 28;
      const maxTargetTokens = 1568;
      const maxTargetPx = 1568;
      let w = img.width, h = img.height;
      const tokens = Math.ceil(w / pxPerToken) * Math.ceil(h / pxPerToken);
      // Scale down if over the token budget.
      if (tokens > maxTargetTokens) {
        const scale = Math.sqrt(maxTargetTokens / tokens);
        w = Math.round(w * scale); h = Math.round(h * scale);
      }
      // Cap the longest side.
      const longest = Math.max(w, h);
      if (longest > maxTargetPx) {
        const scale = maxTargetPx / longest;
        w = Math.round(w * scale); h = Math.round(h * scale);
      }
      const canvas = document.createElement("canvas");
      canvas.width = w; canvas.height = h;
      const cx = canvas.getContext("2d");
      if (!cx) return resolve(null);
      cx.drawImage(img, 0, 0, img.width, img.height, 0, 0, w, h);
      // Adaptive JPEG quality: step down until under the byte budget.
      let q = initialQ;
      let out = canvas.toDataURL("image/jpeg", q).split(",")[1];
      while (out.length > maxChars && q - qStep >= minQ) {
        q -= qStep;
        out = canvas.toDataURL("image/jpeg", q).split(",")[1];
      }
      resolve(out);
    };
    img.onerror = () => resolve(null);
    img.src = dataUrl;
  });
};

async function resizeScreenshot(tabId: number, base64: string, format: string): Promise<string | null> {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      func: RESIZE_FUNC,
      args: [base64, format, MAX_BASE64_CHARS, INITIAL_JPEG_QUALITY, JPEG_QUALITY_STEP, MIN_JPEG_QUALITY],
    });
    const r = results?.[0]?.result as unknown;
    if (typeof r === "string" && r.length > 0) return r;
    return null;
  } catch {
    // scripting can fail if we lack host permission for the tab; degrade gracefully.
    return null;
  }
}

// ===========================================================================
// Registry bootstrap
// ===========================================================================

import { ToolRegistry } from "./tool";

export function createBrowserToolRegistry(): ToolRegistry {
  const reg = new ToolRegistry();
  reg.register(new SnapshotTool());
  reg.register(new ClickTool());
  reg.register(new TypeTool());
  reg.register(new NavigateTool());
  reg.register(new ScrollTool());
  reg.register(new ScrollToTool());
  reg.register(new HoverTool());
  reg.register(new PressKeyTool());
  reg.register(new ScreenshotTool());
  reg.register(new ExtractTextTool());
  reg.register(new SetTextTool());
  return reg;
}
