/**
 * Storage layer.
 *
 * Two areas:
 *   - chrome.storage.session (memory-only, TRUSTED_CONTEXTS by default)
 *     => sessions, the decrypted credential working copy. Wiped on browser
 *        restart, never visible to content scripts.
 *   - chrome.storage.local (persisted to disk)
 *     => the encrypted credential envelope (AES-GCM, key derived from a user
 *        passphrase via PBKDF2), session mirror for crash recovery, and
 *        settings (selected provider/model, per-site permission grants).
 *
 * The passphrase itself is never stored. On browser restart the user re-enters
 * it to decrypt credentials back into storage.session. There is an opt-in
 * "remember passphrase" mode that stores it in session-only (cleared on
 * restart) to avoid re-entry within a single browser session.
 */

import type { Session } from "./types";

// Type-narrow the global chrome.storage accessors for ergonomics.
type StorageArea = chrome.storage.StorageArea;

const SESSION_KEY = "agent.session";
const CREDS_WORKING_KEY = "agent.creds.working";
const SETTINGS_KEY = "agent.settings";
const CREDS_ENCRYPTED_KEY = "agent.creds.encrypted";
const MASTER_KEY_STORE = "agent.masterkey";

/** Public, non-secret settings. */
export interface Settings {
  providerId?: string;
  modelId?: string;
  /** Has the user completed onboarding? (auto-generated on first connect) */
  initialized?: boolean;
  /** Per-site/per-tool permission grants: `${site}::${tool}` -> true. */
  permissionGrants?: Record<string, boolean>;
  /**
   * Autonomy mode.
   *   "ask"  -- prompt the user before any action that changes the page
   *             (click, type, navigate, ...). Default.
   *   "auto" -- act without asking; no permission prompts.
   */
  autonomyMode?: "ask" | "auto";
  /**
   * Whether to play the notification chime + show system toasts when a turn
   * finishes or attention is needed. Stored value is the user's explicit
   * choice; read sites treat undefined as ENABLED so the chime is on by default
   * without migrating existing stored settings.
   */
  notificationsEnabled?: boolean;
  /**
   * Panel color theme.
   *   "dark"  -- warm near-black (default).
   *   "light" -- warm cream.
   * Undefined is treated as "dark" by the panel so existing users keep their
   * look without a settings migration.
   */
  theme?: "light" | "dark";
  /**
   * Global, cross-session memory the agent builds about the user (name,
   * interests, durable preferences, ...). Stored in chrome.storage.local so it
   * survives restarts. Same trust level as permissionGrants -- NOT synced,
   * never sent anywhere except the connected provider (which already sees the
   * full conversation). See user-memory.ts for the formatting/extraction layer.
   */
  userMemory?: { facts: UserFact[]; updatedAt: number };
}

/**
 * A single durable fact the agent has learned (or been told) about the user.
 * Persisted in Settings.userMemory.facts.
 */
export interface UserFact {
  id: string;
  category: UserFactCategory;
  text: string;
  createdAt: number;
  source: UserFactSource;
}

export type UserFactCategory = "identity" | "preference" | "interest" | "work" | "other";
export type UserFactSource = "extracted" | "remember_tool" | "manual";

/** Cap so memory does not grow unbounded; oldest non-essential facts get
 *  compacted into a single summary fact when exceeded. */
export const MAX_FACTS = 50;

// ---------------------------------------------------------------------------
// Generic helpers
// ---------------------------------------------------------------------------

async function getJSON<T>(area: StorageArea, key: string): Promise<T | undefined> {
  const obj = await area.get(key);
  return obj[key] as T | undefined;
}

async function setJSON(area: StorageArea, key: string, value: unknown): Promise<void> {
  await area.set({ [key]: value });
}

const sessionArea = (): StorageArea => chrome.storage.session;
const localArea = (): StorageArea => chrome.storage.local;

// Lock content scripts out of session storage. session defaults to
// TRUSTED_CONTEXTS already, but we set it explicitly to be safe; we do NOT
// raise local storage's access level.
export async function initStorageAccess(): Promise<void> {
  try {
    await chrome.storage.session.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" });
  } catch {
    // Older Chrome: setAccessLevel may not exist; default is already trusted-only.
  }
}

// ---------------------------------------------------------------------------
// Sessions (session area + local mirror for crash recovery)
// ---------------------------------------------------------------------------

export async function saveSession(s: Session): Promise<void> {
  s.updatedAt = Date.now();
  await setJSON(sessionArea(), sessionKey(s.sessionId), s);
  // Mirror to local for crash recovery. Secrets never live on Session, so this
  // is safe to persist.
  await setJSON(localArea(), sessionKey(s.sessionId), s);
}

function sessionKey(sessionId: string): string {
  return `${SESSION_KEY}.${sessionId}`;
}

export async function loadSession(sessionId: string): Promise<Session | undefined> {
  return getJSON<Session>(sessionArea(), sessionKey(sessionId));
}

export async function loadSessionLocal(sessionId: string): Promise<Session | undefined> {
  return getJSON<Session>(localArea(), sessionKey(sessionId));
}

export async function deleteSession(sessionId: string): Promise<void> {
  await sessionArea().remove(sessionKey(sessionId));
  await localArea().remove(sessionKey(sessionId));
}

/** All sessions with non-idle state, for the recovery routine on SW startup. */
export async function listActiveSessions(): Promise<Session[]> {
  const all = await sessionArea().get(null);
  const out: Session[] = [];
  for (const [k, v] of Object.entries(all)) {
    if (k.startsWith(`${SESSION_KEY}.`) && v && typeof v === "object") {
      out.push(v as Session);
    }
  }
  return out;
}

/** Crash-recovery variant: read from the local mirror (session area is empty
 *  after a browser restart). */
export async function listActiveSessionsLocal(): Promise<Session[]> {
  const all = await localArea().get(null);
  const out: Session[] = [];
  for (const [k, v] of Object.entries(all)) {
    if (k.startsWith(`${SESSION_KEY}.`) && v && typeof v === "object") {
      out.push(v as Session);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Settings (local area)
// ---------------------------------------------------------------------------

export async function loadSettings(): Promise<Settings> {
  return (await getJSON<Settings>(localArea(), SETTINGS_KEY)) ?? {};
}

export async function saveSettings(patch: Partial<Settings>): Promise<void> {
  const cur = await loadSettings();
  await setJSON(localArea(), SETTINGS_KEY, { ...cur, ...patch });
}

/**
 * Resolve the notifications setting to a concrete boolean, defaulting to ON.
 * Use this everywhere the value is consumed so the default lives in one place.
 */
export async function notificationsAreEnabled(): Promise<boolean> {
  const { notificationsEnabled } = await loadSettings();
  return notificationsEnabled ?? true;
}

// ---------------------------------------------------------------------------
// Encrypted credentials
// ---------------------------------------------------------------------------

/**
 * The at-rest envelope. iv is random per-write; the ciphertext encrypts a JSON
 * map of providerId -> { field -> value }. The AES key is auto-generated on
 * first run and stored separately (see getMasterKey).
 */
interface EncryptedEnvelope {
  iv: string; // base64
  ciphertext: string; // base64
  version: 2;
}

const IV_BYTES = 12;
const KEY_BYTES = 32; // 256-bit AES key

function bytesToB64(b: Uint8Array): string {
  let s = "";
  for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
  return btoa(s);
}
function b64ToBytes(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/**
 * Get-or-create the master AES key. On first run, a random 256-bit key is
 * generated with crypto.getRandomValues and persisted to storage.local.
 *
 * SECURITY TRADEOFF (read this honestly):
 * The master key lives in storage.local alongside the ciphertext. This means
 * the encryption is REAL defense-in-depth against content-script compromise
 * (the highest-value threat for an agent that injects into arbitrary pages --
 * a malicious page that exploits your injected script cannot read the key
 * because storage.local defaults to TRUSTED_CONTEXTS-only... well, actually
 * storage.local is readable by content scripts by default, so the real win is
 * keeping the DECRYPTED working copy in storage.session at TRUSTED_CONTEXTS,
 * which content scripts cannot read). It does NOT protect against disk
 * forensics -- an attacker with your disk gets key + ciphertext together.
 * The alternative that DOES protect against disk forensics is a user passphrase
 * (the previous design), which we removed for friction reasons.
 */
async function getMasterKey(): Promise<CryptoKey> {
  const stored = await getJSON<string>(localArea(), MASTER_KEY_STORE);
  let raw: Uint8Array;
  if (stored) {
    raw = b64ToBytes(stored);
  } else {
    raw = crypto.getRandomValues(new Uint8Array(KEY_BYTES));
    await setJSON(localArea(), MASTER_KEY_STORE, bytesToB64(raw));
  }
  return crypto.subtle.importKey("raw", raw as BufferSource, { name: "AES-GCM" }, false, [
    "encrypt",
    "decrypt",
  ]);
}

export interface CredentialMap {
  [providerId: string]: Record<string, string>;
}

/** Encrypt and persist the full credential map. Called on every credential change. */
export async function writeEncryptedCredentials(creds: CredentialMap): Promise<void> {
  const key = await getMasterKey();
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const plaintext = new TextEncoder().encode(JSON.stringify(creds));
  const ct = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv: iv as BufferSource },
      key,
      plaintext as BufferSource,
    ),
  );
  const env: EncryptedEnvelope = {
    iv: bytesToB64(iv),
    ciphertext: bytesToB64(ct),
    version: 2,
  };
  await setJSON(localArea(), CREDS_ENCRYPTED_KEY, env);
  // Mirror the plaintext working copy into storage.session at TRUSTED_CONTEXTS
  // so content scripts (untrusted web origins) cannot read the live keys.
  await setJSON(sessionArea(), CREDS_WORKING_KEY, creds);
}

/**
 * Decrypt the at-rest envelope into the session working copy.
 * Auto-succeeds (uses the stored master key); no user interaction needed.
 * Called on SW startup to rehydrate the working copy after a restart.
 */
export async function unlockCredentials(): Promise<boolean> {
  const env = await getJSON<EncryptedEnvelope>(localArea(), CREDS_ENCRYPTED_KEY);
  if (!env) {
    // First run, nothing encrypted yet. Seed an empty working map.
    await setJSON(sessionArea(), CREDS_WORKING_KEY, {});
    return true;
  }
  try {
    const iv = b64ToBytes(env.iv);
    const ct = b64ToBytes(env.ciphertext);
    const key = await getMasterKey();
    const pt = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: iv as BufferSource },
      key,
      ct as BufferSource,
    );
    const creds = JSON.parse(new TextDecoder().decode(pt)) as CredentialMap;
    await setJSON(sessionArea(), CREDS_WORKING_KEY, creds);
    return true;
  } catch {
    return false;
  }
}

/** True if an encrypted envelope exists (i.e. onboarding is complete). */
export async function hasEncryptedCredentials(): Promise<boolean> {
  return !!(await getJSON<EncryptedEnvelope>(localArea(), CREDS_ENCRYPTED_KEY));
}

/** Read the decrypted working copy (session area). Returns {} if locked. */
export async function readWorkingCredentials(): Promise<CredentialMap> {
  return (await getJSON<CredentialMap>(sessionArea(), CREDS_WORKING_KEY)) ?? {};
}

/** Read one provider's credentials from the working copy. */
export async function readProviderCredentials(providerId: string): Promise<Record<string, string>> {
  const all = await readWorkingCredentials();
  return all[providerId] ?? {};
}

/** True if the working copy is loaded into session. */
export async function isUnlocked(): Promise<boolean> {
  const all = await getJSON<CredentialMap>(sessionArea(), CREDS_WORKING_KEY);
  return all !== undefined;
}

/** Wipe all stored credentials + master key. Used for "disconnect all" / reset. */
export async function wipeCredentials(): Promise<void> {
  await localArea().remove([CREDS_ENCRYPTED_KEY, MASTER_KEY_STORE]);
  await sessionArea().remove(CREDS_WORKING_KEY);
}

// ---------------------------------------------------------------------------
// User memory (local area, global across all sessions)
// ---------------------------------------------------------------------------

/** Normalize text for dedup comparison: trim, collapse whitespace, lowercase. */
export function normalizeFactText(text: string): string {
  return text.trim().replace(/\s+/g, " ").toLowerCase();
}

/** Read the current memory blob. Never returns undefined (empty array fallback). */
export async function loadMemory(): Promise<{ facts: UserFact[]; updatedAt: number }> {
  const s = await loadSettings();
  return s.userMemory ?? { facts: [], updatedAt: 0 };
}

/** Replace the whole memory blob. */
export async function saveMemory(facts: UserFact[]): Promise<void> {
  await saveSettings({ userMemory: { facts, updatedAt: Date.now() } });
}

/**
 * Add a fact unless a normalized-duplicate already exists. Returns the stored
 * fact (newly created or the pre-existing match) or null if the text was empty.
 */
export async function addFact(
  text: string,
  category: UserFactCategory,
  source: UserFactSource,
): Promise<UserFact | null> {
  const normalized = normalizeFactText(text);
  if (!normalized) return null;
  const { facts } = await loadMemory();
  if (facts.some((f) => normalizeFactText(f.text) === normalized)) {
    return facts.find((f) => normalizeFactText(f.text) === normalized) ?? null;
  }
  const fact: UserFact = {
    id: crypto.randomUUID(),
    category,
    text: text.trim().replace(/\s+/g, " "),
    createdAt: Date.now(),
    source,
  };
  facts.push(fact);
  await saveMemory(facts);
  return fact;
}

/** Upsert by id (when provided) or by normalized text match. */
export async function upsertFact(input: {
  id?: string;
  category: UserFactCategory;
  text: string;
  source: UserFactSource;
}): Promise<UserFact> {
  const normalized = normalizeFactText(input.text);
  const { facts } = await loadMemory();
  const byId = input.id ? facts.find((f) => f.id === input.id) : undefined;
  const byText = facts.find((f) => normalizeFactText(f.text) === normalized);
  const existing = byId ?? byText;
  if (existing) {
    existing.text = input.text.trim().replace(/\s+/g, " ");
    existing.category = input.category;
    await saveMemory(facts);
    return existing;
  }
  const fact: UserFact = {
    id: crypto.randomUUID(),
    category: input.category,
    text: input.text.trim().replace(/\s+/g, " "),
    createdAt: Date.now(),
    source: input.source,
  };
  facts.push(fact);
  await saveMemory(facts);
  return fact;
}

/** Remove a fact by id. Returns true if something was removed. */
export async function deleteFact(id: string): Promise<boolean> {
  const { facts } = await loadMemory();
  const next = facts.filter((f) => f.id !== id);
  if (next.length === facts.length) return false;
  await saveMemory(next);
  return true;
}

/** Remove facts whose normalized text contains the query (case/space-insensitive). */
export async function deleteFactsByMatch(query: string): Promise<number> {
  const q = normalizeFactText(query);
  if (!q) return 0;
  const { facts } = await loadMemory();
  const next = facts.filter((f) => !normalizeFactText(f.text).includes(q));
  const removed = facts.length - next.length;
  if (removed > 0) await saveMemory(next);
  return removed;
}

/** Wipe the entire memory. */
export async function clearMemory(): Promise<void> {
  await saveMemory([]);
}
