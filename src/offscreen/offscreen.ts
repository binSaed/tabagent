/**
 * Offscreen document.
 *
 * Hosts the long-lived streaming fetch to the provider. The SW delegates every
 * stream here because:
 *   - MV3 SW fetches are capped (30s to first byte, 5min per request).
 *   - The offscreen doc is a full window not subject to SW timers, and it
 *     survives SW restarts (so a stream can keep flowing while the SW reboots,
 *     then be drained on reconnect -- see design doc 3.3).
 *
 * The SW sends OPEN_STREAM with a streamKey (`sessionId::runId::stepId`). We
 * run the fetch, parse SSE inline (no provider specifics here -- the SW builds
 * the full request), and forward each parsed `data:` line back as a
 * `stream_part` message. On stream end we send `stream_end`; on network/HTTP
 * error we send `stream_error` with a retryable hint.
 *
 * Only ONE offscreen doc is allowed per extension, so all concurrent streams
 * multiplex here, keyed by streamKey.
 */

interface ActiveStream {
  controller: AbortController;
  // Recent parsed parts (ring buffer) so a reconnecting SW can catch up.
  ring: { part: unknown }[];
}

const active = new Map<string, ActiveStream>();
const RING_SIZE = 64;

// The offscreen doc shares chrome.runtime.onMessage with the background SW.
// CRITICAL: a listener must ONLY return true + sendResponse for messages it
// owns. Returning true for everything else (as a previous version did) races
// the SW: both listeners fire on every message, and whichever sendResponse
// runs first wins. The offscreen doc's trivial default case frequently beat
// the SW, replying { ignored: true } to panel requests like list_providers --
// which made the panel set state.providers = undefined and crash on the next
// render. Now: for messages we don't own, return false and stay SILENT so the
// SW (the true owner) can respond.
const OWNED_KINDS = new Set(["ping", "open_stream", "abort_stream", "peek_stream", "play_sound"]);

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  const kind = (msg as { kind?: string } | null)?.kind;
  if (!kind || !OWNED_KINDS.has(kind)) {
    return false; // not ours; let another listener (the SW) handle it
  }
  void handle(msg)
    .then((resp) => sendResponse({ ok: true, data: resp }))
    .catch((e) => sendResponse({ ok: false, error: (e as Error).message }));
  return true; // keep the channel open for the async response
});

async function handle(msg: unknown): Promise<unknown> {
  const m = msg as { kind?: string; [k: string]: unknown };
  switch (m.kind) {
    case "ping":
      return { pong: true };
    case "open_stream":
      return openStream(
        m.streamKey as string,
        m.url as string,
        m.headers as Record<string, string>,
        m.body as string,
      );
    case "abort_stream":
      abortStream(m.streamKey as string);
      return { aborted: true };
    case "peek_stream":
      return { alive: active.has(m.streamKey as string) };
    case "play_sound":
      await playNotificationSound((m.volume as number | undefined) ?? 0.5);
      return { played: true };
    default:
      return { ignored: true };
  }
}

async function openStream(
  streamKey: string,
  url: string,
  headers: Record<string, string>,
  body: string,
): Promise<{ started: true }> {
  // If this exact stream is already running (SW reconnect mid-stream), do nothing;
  // the SW will drain the ring on reconnect.
  if (active.has(streamKey)) return { started: true };

  const controller = new AbortController();
  const stream: ActiveStream = { controller, ring: [] };
  active.set(streamKey, stream);

  // Fire and forget; results flow back via chrome.runtime messages.
  void runStream(streamKey, url, headers, body, controller.signal);

  return { started: true };
}

function abortStream(streamKey: string): void {
  const s = active.get(streamKey);
  if (s) {
    s.controller.abort();
    active.delete(streamKey);
  }
}

async function runStream(
  streamKey: string,
  url: string,
  headers: Record<string, string>,
  body: string,
  signal: AbortSignal,
): Promise<void> {
  const stream = active.get(streamKey);
  if (!stream) return;

  let resp: Response;
  try {
    resp = await fetch(url, { method: "POST", headers, body, signal });
  } catch (e) {
    if (signal.aborted) {
      void sendEnd(streamKey);
      return;
    }
    await sendError(streamKey, { message: `network: ${(e as Error).message}`, retryable: true });
    return;
  }

  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    const retryable = resp.status === 429 || resp.status >= 500;
    await sendError(streamKey, {
      message: `HTTP ${resp.status} ${resp.statusText}: ${text.slice(0, 500)}`,
      status: resp.status,
      retryable,
    });
    return;
  }

  if (!resp.body) {
    await sendError(streamKey, { message: "no response body", retryable: false });
    return;
  }

  // Parse SSE and forward each `data:` payload as a raw stream_part envelope.
  // (The SW owns the per-provider semantic interpretation; here we just hand
  // back the raw chunk JSON the way OpenAI-compat streams deliver it.)
  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      if (signal.aborted) break;
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let sep: number;
      while ((sep = buffer.indexOf("\n\n")) !== -1) {
        const rawEvent = buffer.slice(0, sep);
        buffer = buffer.slice(sep + 2);
        for (const dataStr of dataLines(rawEvent)) {
          if (dataStr === "[DONE]") continue;
          let parsed: unknown = null;
          try {
            parsed = JSON.parse(dataStr);
          } catch {
            continue;
          }
          // Forward as a generic "sse" part; the SW's provider adapter would
          // normally do this parsing, but since the SW delegated the fetch to
          // us, we hand back raw chunks and let the SW's streamChat consumer
          // treat them. To keep semantics simple in v1, we send the raw SSE
          // JSON object directly as the part's `delta` payload.
          pushPart(streamKey, { type: "sse", raw: parsed });
        }
      }
    }
  } catch (e) {
    if (!signal.aborted) {
      await sendError(streamKey, { message: `stream read: ${(e as Error).message}`, retryable: true });
      return;
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      /* ignore */
    }
  }

  await sendEnd(streamKey);
}

function dataLines(rawEvent: string): string[] {
  const out: string[] = [];
  for (const line of rawEvent.split(/\r?\n/)) {
    const t = line.trimStart();
    if (t.startsWith("data:")) out.push(t.slice(5).trimStart());
  }
  return out;
}

function pushPart(streamKey: string, part: unknown): void {
  const stream = active.get(streamKey);
  if (stream) {
    stream.ring.push({ part });
    if (stream.ring.length > RING_SIZE) stream.ring.shift();
  }
  void chrome.runtime
    .sendMessage({ kind: "stream_part", streamKey, part })
    .catch(() => {});
}

async function sendEnd(streamKey: string): Promise<void> {
  active.delete(streamKey);
  await chrome.runtime.sendMessage({ kind: "stream_end", streamKey }).catch(() => {});
}

async function sendError(streamKey: string, error: { message: string; status?: number; retryable?: boolean }): Promise<void> {
  active.delete(streamKey);
  await chrome.runtime.sendMessage({ kind: "stream_error", streamKey, error }).catch(() => {});
}

// ---------------------------------------------------------------------------
// Notification sound (Web Audio API)
// ---------------------------------------------------------------------------
//
// The SW can't play audio (no DOM in the service worker). It routes the chime
// here as a `play_sound` message; the offscreen doc has a real window, so it
// owns the AudioContext. Pattern adapted from the Claude reference extension,
// stripped to just the playback path (no GIF/canvas).
//
// AudioContext is lazy + the decoded AudioBuffer is cached after the first
// play, so subsequent chimes don't re-fetch/re-decode the mp3.

let audioContext: AudioContext | null = null;
let decodedBuffer: AudioBuffer | null = null;

function getAudioContext(): AudioContext {
  if (!audioContext) {
    const Ctor =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    audioContext = new Ctor!();
  }
  return audioContext;
}

async function fetchDecodedBuffer(): Promise<AudioBuffer> {
  if (decodedBuffer) return decodedBuffer;
  const url = chrome.runtime.getURL("sounds/notification.mp3");
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`notification.mp3 fetch failed: ${resp.status}`);
  const arr = await resp.arrayBuffer();
  const ctx = getAudioContext();
  // decodeAudioData's callback/promise duality varies by Chrome version; the
  // Promise form works in 120+ (our minimum).
  decodedBuffer = await ctx.decodeAudioData(arr);
  return decodedBuffer;
}

async function playNotificationSound(volume: number): Promise<void> {
  const ctx = getAudioContext();
  // A suspended context (Chrome's default until a user gesture has occurred in
  // this document) silently drops playback. Resume is best-effort; the first
  // chime after install may be skipped if no gesture has happened yet, which
  // is fine -- subsequent plays work once the doc is "warm".
  if (ctx.state === "suspended") {
    await ctx.resume().catch(() => {});
  }
  const buffer = await fetchDecodedBuffer();
  const source = ctx.createBufferSource();
  source.buffer = buffer;
  const gain = ctx.createGain();
  gain.gain.value = volume;
  source.connect(gain);
  gain.connect(ctx.destination);
  source.start(0);
}

// Self-register: the SW creates this document via chrome.offscreen on demand.
console.log("[offscreen] ready");
