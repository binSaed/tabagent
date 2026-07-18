// Manifest V3. The CDP-required decision means "debugger" is a required permission
// (surfaces a scary install warning + a "being debugged" banner on controlled tabs;
// documented in README as the tradeoff for the real AX tree, screenshots, trusted input).
// Broad host access is OPTIONAL and requested per-provider-domain at runtime so the
// default install does not ask for "read and change all your data on all websites".
import type { Manifest } from "./manifest-type";

const manifest: Manifest = {
  manifest_version: 3,
  name: "TabAgent",
  version: "0.1.0",
  description:
    "Universal AI browser agent. Connect any OpenAI-compatible provider (Z.AI coding plan, OpenAI, OpenRouter, Ollama, ...) and let the AI drive the active tab.",
  minimum_chrome_version: "120",
  // MV3 SW. type: "module" would also work; classic is used to keep the build simple.
  background: { service_worker: "background.js" },
  action: {
    default_title: "Open TabAgent",
    default_popup: "popup.html",
    default_icon: {
      "16": "icons/icon-16.png",
      "32": "icons/icon-32.png",
      "48": "icons/icon-48.png",
      "128": "icons/icon-128.png",
    },
  },
  icons: {
    "16": "icons/icon-16.png",
    "32": "icons/icon-32.png",
    "48": "icons/icon-48.png",
    "128": "icons/icon-128.png",
  },
  side_panel: { default_path: "panel.html" },
  permissions: [
    "sidePanel",
    "offscreen",
    "storage",
    "alarms", // heartbeat for the agent-loop survival layer
    "contextMenus",
    "commands",
    "scripting",
    "activeTab",
    "debugger", // CDP-required: real AX tree, screenshots, trusted input
    "notifications", // chime + system toast when a turn finishes or attention is needed
  ],
  // Requested per-site / per-provider at runtime via chrome.permissions.request.
  optional_host_permissions: ["https://*/*", "http://*/*"],
  host_permissions: [], // none required at install
  content_security_policy: {
    extension_pages: "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'",
  },
  web_accessible_resources: [
    {
      // sounds/notification.mp3 is fetched by the offscreen doc via
      // chrome.runtime.getURL("sounds/notification.mp3"); listing it here keeps
      // that fetch off the extension_pages CSP allowlist.
      resources: ["offscreen.html", "sounds/*"],
      matches: ["<all_urls>"],
    },
  ],
  // Selection-triggered suggestion menu. Injected at document_idle so it doesn't
  // slow page load. Only runs where we have host access; on tabs without it the
  // script simply doesn't inject (graceful no-op).
  content_scripts: [
    {
      matches: ["<all_urls>"],
      js: ["selection.js"],
      css: ["selection.css"],
      run_at: "document_idle",
      all_frames: false,
    },
  ],
  commands: {
    "_execute_action": {
      suggested_key: { default: "Ctrl+Shift+Y", mac: "Command+Shift+Y" },
      description: "Open the agent popup",
    },
    "open-side-panel": {
      suggested_key: { default: "Ctrl+Shift+A", mac: "Command+Shift+A" },
      description: "Open the agent side panel",
    },
  },
};

export default manifest;
