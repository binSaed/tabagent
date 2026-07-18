# TabAgent

> Turn any browser tab into an AI agent.

![Chrome 120+](https://img.shields.io/badge/Chrome-120%2B-4285F4?logo=googlechrome&logoColor=white)
![Manifest V3](https://img.shields.io/badge/Manifest-V3-34A853)
![TypeScript](https://img.shields.io/badge/TypeScript-5.7-3178C6?logo=typescript&logoColor=white)
![Zero runtime dependencies](https://img.shields.io/badge/runtime%20deps-0-brightgreen)
![License: MIT](https://img.shields.io/badge/License-MIT-yellow)

TabAgent is a Manifest V3 Chrome extension that lets any OpenAI-compatible LLM drive the active tab through the Chrome DevTools Protocol. Connect a provider — **Z.AI's coding plan is the first-class default** — give the agent a goal in the side panel, and it works the page through 11 structured browser tools. Everything is hand-rolled with zero runtime dependencies: SSE streaming, markdown rendering, and WebCrypto encryption included.

## Demo

https://github.com/user-attachments/assets/2adfd956-d6e8-4b5c-893d-dc04f92abe66

## Features

- **Any OpenAI-compatible provider** — Z.AI, Zhipu/BigModel, OpenAI, OpenRouter, or any custom endpoint (Ollama, LM Studio, Groq, DeepSeek, …) through a single adapter
- **11 CDP browser tools** — snapshot, click, type, scroll, hover, key presses, screenshots, text extraction, and more (see [Browser tools](#browser-tools))
- **Resumable agent loop** — a checkpointed state machine (up to 200 steps) that survives service-worker death and crashes mid-run
- **Plan approval** — the agent can propose a step-by-step plan; you approve or reject it, then watch steps tick off live in the panel
- **Permission system** — per-site grants (site-wide or per-tool), plus **ask**/**auto** autonomy modes
- **Mid-run steering** — queue follow-up messages while the agent is working; they're folded into the run
- **Cross-session memory** — `remember`/`forget` tools, automatic fact extraction after each turn, a memory manager in the panel, and "forget everything" intent detection (English and Arabic)
- **Skills** — keyword-activated expert procedures; ships with full-page translation via in-place text replacement with automatic LTR/RTL handling
- **Selection menu** — select text on any page for a floating **Explain / Summarize / Translate / Rewrite / Ask** menu that hands off to the agent
- **Unattended-run hygiene** — JS dialogs (`alert`/`confirm`/`prompt`) are auto-dismissed; `beforeunload` blocks are detected and reported instead of hanging
- **Notifications** — chime + system toast when a run finishes or needs your attention (toggleable)
- **Polished chat UI** — streaming markdown, collapsible reasoning blocks, screenshot lightbox, suggested next-action chips, light/dark theme, JSON conversation export

## Installation

Requires Chrome 120+.

### Option A: download a pre-built build

[![Download TabAgent](https://img.shields.io/badge/Download-TabAgent-4285F4?logo=googlechrome&logoColor=white)](../../releases/latest)

1. Click the button above (or go to **[Releases](../../releases/latest)**) and download `TabAgent-vX.X.X.zip`, then unzip it.
2. Open `chrome://extensions`, enable **Developer mode** (top right), click **Load unpacked**, and select the unzipped folder.

> The release zip is permanently hosted and always points to the latest version.

### Option B: build from source

Requires Node.js.

```sh
npm install
npm run build   # esbuild → dist/
```

Then load `dist/` via **Load unpacked** as above.

Shortcuts: **Cmd/Ctrl+Shift+A** opens the side panel; **Cmd/Ctrl+Shift+Y** opens the popup (a one-button side-panel launcher).

> Chrome will warn about the `debugger` permission at install — see [The debugger permission](#the-debugger-permission) for why it's required.

## Quick start

1. Open the side panel (**Cmd/Ctrl+Shift+A** or the toolbar icon).
2. Pick a provider — **Z.AI (Coding Plan)** is the default. Z.AI's coding plan is OpenAI-compatible; no OAuth or special flow.
3. Paste your API key and click **Connect**. The key is validated live, host permission for the provider's domain is requested here (not at install), and the key is encrypted at rest on connect.
4. Pick a model from the live model list. The default is **`glm-5.2`** — 1M context with reasoning support.
5. Navigate to any page, type a goal — *"summarize this page"*, *"fill the search form and submit"*, *"click every unchecked checkbox"* — and hit Send.

No passphrase, no setup wizard.

## Providers

| Provider | Endpoint | Notes |
|---|---|---|
| **Z.AI (Coding Plan)** | `api.z.ai/api/coding/paas/v4` | Default. Flat-rate subscription. GLM roster: `glm-5.2` (default), `glm-5.1`, `glm-5-turbo`, `glm-5`, `glm-4.7`, `glm-4.6`, `glm-4.5`, `glm-4.5-air` |
| **Zhipu / BigModel** | `open.bigmodel.cn/api/paas/v4` | Same GLM family, separate key |
| **OpenAI** | `api.openai.com/v1` | Pre-seeded models |
| **OpenRouter** | `openrouter.ai/api/v1` | Fully dynamic model list |
| **Custom (OpenAI-compatible)** | any base URL | Ollama, LM Studio, Groq, DeepSeek, Together, xAI, Fireworks, … — dynamic `GET /models` discovery |

Z.AI's API quirks are handled automatically: `tool_stream: true` is injected into chat requests, `thinking: { type: "enabled" | "disabled" }` is set for reasoning models, and the `/models` health check tolerates `401` (Z.AI scopes that endpoint differently from chat).

The Anthropic native adapter is currently a stub — use OpenRouter for Claude models. There is no Gemini adapter yet.

All providers run through one adapter: `src/providers/openai-compat.ts`, with the catalog in `src/providers/catalog.ts`.

## Browser tools

Eleven CDP-backed tools, defined in `src/tools/browser-tools.ts`:

| Tool | Description |
|---|---|
| `snapshot` | Page snapshot as YAML with `ref` ids for interactive elements (DOM walk over light DOM + open shadow roots) |
| `click` | Trusted mouse click on a `ref` (left/right/middle, double-click) |
| `type` | Focus a `ref` and type text, with optional clear and submit |
| `hover` | Move the mouse over a `ref` (tooltips, dropdown triggers) |
| `press_key` | Press a key or combo (`Escape`, `Tab`, `ctrl+a`, …) |
| `scroll` | Scroll the page by pixels in any direction |
| `scroll_to` | Scroll a `ref` element into view |
| `navigate` | Go to a URL — gated behind user approval |
| `screenshot` | Full-page JPEG, resized to fit a token budget |
| `extractText` | Visible text of the page or a `ref` subtree |
| `set_text` | Overwrite an element's text in place (powers page translation, auto LTR/RTL) |

The agent loop also injects control tools: `propose_plan`, `suggest_actions`, `remember`, and `forget`.

## How it works

```
Side panel (UI only)
      ↕  chrome.runtime messages
Service worker (orchestrator)
   ├─ Agent loop — resumable state machine
   ├─ Checkpointing — storage.session + local mirror
   ├─ Permission & plan-approval services
   └─ chrome.alarms heartbeat (recovery)
      ↕  chrome.debugger (CDP)
Active tab (debuggee)
```

The loop (`src/background/loop.ts`) checkpoints state before every side effect, so recovery after a crash or service-worker restart is deterministic:

- **Mid-stream** (no assistant message committed) → re-send the stream
- **Mid-tool** (a mutating tool may have run) → stop and ask the user; mutating tools are never auto-replayed
- **Idle/paused** → the service worker can die freely; state is preserved

The debugger attaches when a run starts and detaches when it finishes. While attached, it also keeps the service worker alive for the duration of the run (Chrome 118+ behavior).

There are no runtime dependencies: SSE parsing, markdown rendering, and crypto are implemented in-repo, and the UI is vanilla TypeScript.

## The debugger permission

TabAgent requires the `debugger` permission, which triggers a scary install warning and shows a *"this browser is being controlled by automated test software"* banner — but only while a run is active, since the debugger is attached at run start and detached at run finish.

CDP is required for capabilities a content script cannot provide:

- **Trusted input** (`Input.dispatchMouseEvent` and friends) that defeats synthetic-event bot detection
- **Full-page screenshots** beyond the viewport
- **Cross-origin iframes** and **closed shadow DOM**
- **File upload** (`DOM.setFileInputFiles`)
- **Service-worker keepalive** during long runs

## Security & privacy

- API keys are encrypted at rest with AES-GCM using a **random 256-bit master key auto-generated on first run** — no passphrase to manage. The master key lives in `chrome.storage.local`, which protects against content-script compromise (the realistic threat for an agent injected into arbitrary pages) but **not** disk forensics: an attacker with your disk gets key and ciphertext together.
- Decrypted keys exist only in `chrome.storage.session` at `TRUSTED_CONTEXTS` access level — content scripts cannot read them.
- All provider requests originate in the service worker, never in a content script.
- Host permissions are requested per provider domain at connect time; the extension installs with no host permissions.
- `navigate` requires explicit user approval per call, and other tools can be gated per site.
- **Prompt injection is an inherent risk** for any agent that reads untrusted page content. TabAgent does not run an injection classifier — treat the agent like a user with limited trust and review its permission prompts.

## Limitations

- **Anthropic native adapter** is a stub (use OpenRouter for Claude); **no Gemini adapter**
- **Pause is cancel** — true mid-run pause/resume is not implemented yet
- **No cost tracking** — the default Z.AI plan is flat-rate; per-token accounting is absent elsewhere
- **Single tab** — multi-tab orchestration is designed for but not built
- **Offscreen streaming path** is implemented but dormant; the loop currently streams inside the service worker (safe because the attached debugger keeps it alive)
- **No prompt-injection classifier** (see [Security & privacy](#security--privacy))
- **Vanilla TS UI** — no framework

## Development

```sh
npm run typecheck   # tsc --noEmit
npm run build       # esbuild → dist/
npm run clean       # rm -rf dist
```

Iterate by rebuilding, reloading the extension at `chrome://extensions`, and refreshing the target tab.

Key files:

- `src/background/loop.ts` — the resumable agent loop (read the invariants in its header)
- `src/providers/openai-compat.ts` — the one adapter covering every provider
- `src/providers/catalog.ts` — built-in provider and model definitions
- `src/tools/browser-tools.ts` — the 11 CDP browser tools
- `src/core/storage.ts` — encrypted credential store, settings, session persistence

## Credits

Architecture adapted from [charmbracelet/crush](https://github.com/charmbracelet/crush) — particularly the OpenAI-compat adapter pattern, the canonical message/stream-part types, and the Z.AI catalog entry. The browser-tool design follows the Playwright-MCP accessibility-snapshot + `ref` pattern.

## License

MIT
