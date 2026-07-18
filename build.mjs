// esbuild bundler for the MV3 extension.
// Three TS entrypoints -> three JS bundles; HTML + manifest copied as static assets.
import * as esbuild from "esbuild";
import { cpSync, mkdirSync, rmSync, writeFileSync, existsSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

const ROOT = process.cwd();
const SRC = join(ROOT, "src");
const DIST = join(ROOT, "dist");

// Shared build options. MV3 service workers, offscreen docs, and extension pages
// all run as classic scripts (modules are allowed in MV3 but classic is simplest
// for the SW where top-level await / import.meta nuances bite less).
const common = {
  bundle: true,
  platform: "browser",
  target: "chrome120",
  format: "iife",
  sourcemap: "linked",
  logLevel: "info",
  legalComments: "none",
};

const entries = [
  { in: join(SRC, "background/background.ts"), out: "background.js" },
  { in: join(SRC, "offscreen/offscreen.ts"), out: "offscreen.js" },
  { in: join(SRC, "panel/panel.ts"), out: "panel.js" },
  { in: join(SRC, "popup/popup.ts"), out: "popup.js" },
  { in: join(SRC, "content/selection.ts"), out: "selection.js" },
];

function copyStatic() {
  // HTML shells + CSS
  for (const [src, dest] of [
    [join(SRC, "offscreen/offscreen.html"), join(DIST, "offscreen.html")],
    [join(SRC, "panel/panel.html"), join(DIST, "panel.html")],
    [join(SRC, "panel/panel.css"), join(DIST, "panel.css")],
    [join(SRC, "popup/popup.html"), join(DIST, "popup.html")],
    [join(SRC, "content/selection.css"), join(DIST, "selection.css")],
  ]) {
    cpSync(src, dest);
  }
  // Icons dir (optional). If missing we synthesize a placeholder.
  const iconsSrc = join(ROOT, "icons");
  const iconsDest = join(DIST, "icons");
  if (existsSync(iconsSrc)) {
    cpSync(iconsSrc, iconsDest, { recursive: true });
  }
  // Sounds (notification chime, etc.). Shipped as static assets so the
  // offscreen doc can fetch(chrome.runtime.getURL("sounds/...")).
  const soundsSrc = join(SRC, "sounds");
  const soundsDest = join(DIST, "sounds");
  if (existsSync(soundsSrc)) {
    cpSync(soundsSrc, soundsDest, { recursive: true });
  }
  // Panel fonts (Source Serif 4 variable woff2 for AI response text).
  const fontsSrc = join(SRC, "panel", "fonts");
  const fontsDest = join(DIST, "fonts");
  if (existsSync(fontsSrc)) {
    cpSync(fontsSrc, fontsDest, { recursive: true });
  }
}

try {
  rmSync(DIST, { recursive: true, force: true });
  mkdirSync(DIST, { recursive: true });

  await Promise.all(
    entries.map((e) =>
      esbuild.build({
        ...common,
        entryPoints: [e.in],
        outfile: join(DIST, e.out),
      })
    )
  );

  // Manifest is generated so the package version stays in sync. esbuild
  // transforms manifest.ts -> JS first, so the build works on any Node >= 18
  // (native dynamic import() of .ts only exists on Node 23.6+, which CI and
  // many local setups don't have).
  const manifestTmp = join(DIST, ".manifest.mjs");
  await esbuild.build({
    bundle: true,
    platform: "node",
    format: "esm",
    entryPoints: [join(SRC, "manifest.ts")],
    outfile: manifestTmp,
    logLevel: "silent",
  });
  const manifest = (await import(pathToFileURL(manifestTmp).href)).default;
  unlinkSync(manifestTmp);
  writeFileSync(join(DIST, "manifest.json"), JSON.stringify(manifest, null, 2));

  copyStatic();
  console.log("\n[build] OK -> dist/");
} catch (err) {
  console.error("[build] FAILED:", err);
  process.exit(1);
}
