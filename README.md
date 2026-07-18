# TabAgent

> Turn the active browser tab into an AI-driven agent.

A Manifest V3 Chrome extension that turns the active tab into an AI-driven agent. Connect any OpenAI-compatible provider — **Z.AI coding plan is the default and first-class** — and let the model control the page through structured browser tools (snapshot, click, type, navigate, screenshot, extractText).

This is a working vertical slice implementing the agent-loop-and-survival layer. It is not the full platform yet (see "What's stubbed" below).

## Demo

https://github.com/user-attachments/assets/2adfd956-d6e8-4b5c-893d-dc04f92abe66

## Z.AI coding plan setup (recommended path)

Z.AI's coding plan is OpenAI-compatible (confirmed via [crush](https://github.com/charmbracelet/crush)'s `catwalk` catalog). No OAuth, no special flow.

1. Get a Z.AI API key from your coding-plan dashboard.
2. Load the extension (see below), open the side panel (`Cmd+Shift+A` or click the toolbar icon).
3. Pick **Z.AI (Coding Plan)** in the provider dropdown, paste your key, click **Connect**.
4. Pick a model. Defaults:
   - **`glm-5.2`** — 1M context, reasoning (levels high/xhigh). Default large model.
   - `glm-4.6v` / `glm-4.5v` — vision-capable (needed for the screenshot/vision fallback).
   - See `src/providers/catalog.ts` for the full GLM roster (5.1, 5-turbo, 5, 4.7, 4.7-flash, 4.6, 4.5, 4.5-air).
5. Navigate to any page, type a goal ("click every unchecked checkbox", "summarize this page", "fill the search form and submit"), and hit Send.

No passphrase, no setup wizard. Your key is encrypted at rest on first connect (see "Security" below).

### Z.AI-specific quirks handled automatically

These are replicated from crush's `coordinator.go`; without them Z.AI tool-calling and reasoning break:

- `tool_stream: true` injected into the chat request body
- `thinking: { type: "enabled" | "disabled" }` injected for reasoning models (GLM-5.x)
- `/models` health check tolerates `401` (Z.AI's models endpoint uses different scopes than chat)
- Subscription (`flatRate: true`) — per-token cost tracking is hidden; the coding plan is flat-rate

## Other providers (all via the same OpenAI-compat adapter)

- **Zhipu / BigModel** — `open.bigmodel.cn/api/paas/v4`, same GLM roster, separate key
- **OpenAI**, **OpenRouter** — pre-seeded
- **Custom (OpenAI-compatible)** — enter any baseURL + key; works for **Ollama**, **LM Studio**, **Groq**, **Together**, **DeepSeek**, **xAI**, **Fireworks**, **Cerebras**, **Moonshot**, and any other OpenAI-compatible endpoint. Dynamic `GET /v1/models` discovery fills the model list.

## Load the extension

```
npm install
npm run build        # outputs dist/
```

Then in Chrome:

1. Open `chrome://extensions`
2. Enable **Developer mode** (top-right)
3. **Load unpacked** → select the `dist/` folder
4. Pin the toolbar icon, or press `Cmd+Shift+A` (Mac) / `Ctrl+Shift+A` to open the side panel

Requires Chrome 120+.

## The `debugger` permission — read this

This extension requires the `debugger` permission, which triggers a scary install warning ("Access the page debugger — read and change all your data"). It also shows a **"this browser is being controlled by automated test software"** banner on every tab the agent controls.

This is an intentional architectural decision (you chose CDP-required over a content-script fallback). The `debugger` API is the only way to access:

- **The real accessibility tree** (`Accessibility.getFullAXTree`) — the agent's primary page-state representation
- **Full-page screenshots** beyond the viewport (`Page.captureScreenshot`)
- **Trusted input** (`Input.dispatchMouseEvent`) — defeats synthetic-event bot detection
- **Cross-origin iframes** and **closed shadow DOM** (via CDP's DOM domain)
- **File upload** (`DOM.setFileInputFiles`)

Side benefit (Chrome 118+): an attached debugger session keeps the service worker alive for the duration of an agent run, which is the survival mechanism the loop relies on. The debugger is attached only during an active run and detached immediately when the run finishes, so the banner appears only while the agent is working.

If you want to avoid the `debugger` warning, the design supports a content-script-only fallback tier (degraded AX tree via axe-core, no file upload, no closed shadow DOM) — but that is **not** what's wired up here.

## How it works (architecture)

```
Side Panel (UI, no logic)
      ↕  chrome.runtime messages
Service Worker (orchestrator)
   ├── Agent loop (resumable state machine)
   ├── Checkpointing to chrome.storage.session + local mirror
   ├── Permission service (Promise resolved by panel)
   └── chrome.alarms heartbeat (recovery)
      ↕  chrome.debugger (CDP)        ↕  fetch (streaming)
Active tab (debuggee)              Offscreen doc (v2 streaming host)
```

Key files:

- `src/core/types.ts` — canonical types (Message, StreamPart, Model, Session). Borrowed from crush's shapes.
- `src/core/storage.ts` — encrypted credential store + session persistence.
- `src/providers/openai-compat.ts` — the one adapter covering ~15 providers, with real SSE streaming.
- `src/providers/catalog.ts` — Z.AI / Zhipu / OpenAI / OpenRouter / Custom / Anthropic-stub definitions.
- `src/tools/browser-tools.ts` — snapshot (AX tree), click, type, navigate, screenshot, extractText.
- `src/background/loop.ts` — the resumable agent loop. Read the invariants in its header.
- `src/background/background.ts` — SW entry: message router, rehydrate, heartbeat, lifecycle.

## Survival model

The agent loop is a checkpointed state machine. Every state transition writes `updatedAt` + `pendingStep` before its side effect. During a run, the attached debugger keeps the SW alive. Across run boundaries, crashes, and detach events:

- **Mid-stream (no assistant message committed)** → re-send the stream
- **Mid-tool (mutating tools may have run)** → STOP and ask the user (never auto-replay a mutating tool)
- **Idle/paused** → SW can die freely; state is preserved

## What's real vs stubbed

**Real (working):**
- Z.AI coding plan — full streaming, tool-calling, reasoning, vision models, all three quirks
- OpenAI-compat adapter — real SSE parsing, tool-call delta accumulation, retryable errors
- OpenAI, OpenRouter, Zhipu, Custom providers via the same adapter
- Resumable agent loop with checkpointing + alarms recovery + onStartup rehydrate
- CDP-based browser tools: snapshot / click / type / navigate / screenshot / extractText
- Permission prompts (navigate currently requires approval; per-site "always allow")
- Encrypted credential storage (PBKDF2 + AES-GCM)
- Side-panel chat UI with streaming, tool-result display, permission cards

**Stubbed (throws `NotImplementedError` or falls back):**
- **Anthropic native adapter** — listed in the catalog but resolves to the stub; use OpenRouter for Claude for now
- **Gemini native adapter** — not yet present
- **Auto-compact summarizer** — uses the active model (no separate cheap summarizer)
- **Multi-tab orchestration** — designed for (sessions keyed by `tabId`, child-session plumbing is stubbed) but not built
- **Offscreen-doc streaming path** — the doc is created and wired, but the v1 loop streams directly in the SW (safe because debugger keepalive keeps the SW alive during a run). The offscreen path is the v2 home for surviving SW death mid-stream.
- **React UI** — vanilla TS in v1 (documented swap-in)
- **MCP client, prompt library, plugin marketplace, workflows** — future

## Security notes

- API keys are encrypted at rest (AES-GCM) using a **random 256-bit master key auto-generated on first run**. No passphrase to remember — zero friction.
- The master key lives in `chrome.storage.local`. **Honest caveat:** this protects against content-script compromise (the realistic threat for an agent that injects into arbitrary pages) but **not** against disk forensics — an attacker with your disk gets key + ciphertext together. The protection that *does* work against disk forensics would be a user passphrase, which we removed for friction. If you want that back, it's a small change in `src/core/storage.ts`.
- Decrypted keys live only in `chrome.storage.session` at `TRUSTED_CONTEXTS` — content scripts (untrusted web origins) cannot read them.
- All provider `fetch` calls originate in the service worker, never in a content script.
- Host permissions are requested per-provider-domain at connect time (not broad at install).
- `navigate` requires explicit user approval per call; other mutating tools can be gated similarly.
- **Prompt injection is an inherent risk** for any agent that reads untrusted page content. This extension does not yet run an injection classifier — treat the agent like a user with limited trust, and review permission prompts.

## Develop

```
npm run typecheck    # tsc --noEmit
npm run build        # esbuild -> dist/
```

Iterate: rebuild, then reload the extension at `chrome://extensions` and refresh the target tab.

## Credits

Architecture adapted from [charmbracelet/crush](https://github.com/charmbracelet/crush) (the live successor to the archived `opencode-ai/opencode`) — particularly the OpenAI-compat adapter pattern, the canonical message/stream-part types, and the Z.AI catalog entry (`catwalk/internal/providers/configs/zai.json`). The browser-tool design follows the Playwright-MCP / Browser-MCP accessibility-snapshot + ref pattern.
