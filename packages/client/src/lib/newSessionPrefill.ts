import type { ClientSummarySourceKey } from "./clientSummaryStore";
import { generateUUID } from "./uuid";

const NEW_SESSION_PREFILL_KEY_PREFIX = "new-session-prefill:";
const NEW_SESSION_PREFILL_TOKEN_PREFIX = "new-session-prefill-token:";
const CARET_SUFFIX = ":caret";

/**
 * How long a stashed new-tab prefill stays available, in milliseconds. A tab
 * closed before its form mounts never consumes its token, so an unswept key
 * would outlive every session that could use it.
 */
const NEW_SESSION_PREFILL_TOKEN_LIFETIME_MS = 60 * 60 * 1000;

export type NewSessionPrefillCaret = "start" | "end";

export interface NewSessionPrefillRecord {
  caret: NewSessionPrefillCaret;
  text: string;
}

function encodePrefillKeyPart(value: string): string {
  return encodeURIComponent(value);
}

export function createNewSessionPrefillKey(
  sourceKey: ClientSummarySourceKey,
): string {
  return `${NEW_SESSION_PREFILL_KEY_PREFIX}${encodePrefillKeyPart(sourceKey)}`;
}

function caretStorageKey(sourceKey: ClientSummarySourceKey): string {
  return `${createNewSessionPrefillKey(sourceKey)}${CARET_SUFFIX}`;
}

function readCaret(sourceKey: ClientSummarySourceKey): NewSessionPrefillCaret {
  if (typeof window === "undefined") return "end";
  return sessionStorage.getItem(caretStorageKey(sourceKey)) === "start"
    ? "start"
    : "end";
}

export function getNewSessionPrefill(
  sourceKey: ClientSummarySourceKey,
): string | null {
  if (typeof window === "undefined") return null;
  return sessionStorage.getItem(createNewSessionPrefillKey(sourceKey));
}

export function clearNewSessionPrefill(
  sourceKey: ClientSummarySourceKey,
): void {
  if (typeof window === "undefined") return;
  sessionStorage.removeItem(createNewSessionPrefillKey(sourceKey));
  sessionStorage.removeItem(caretStorageKey(sourceKey));
}

export function setNewSessionPrefill(
  sourceKey: ClientSummarySourceKey,
  text: string,
  options?: { caret?: NewSessionPrefillCaret },
): void {
  if (typeof window === "undefined") return;
  sessionStorage.setItem(createNewSessionPrefillKey(sourceKey), text);
  if (options?.caret === "start") {
    sessionStorage.setItem(caretStorageKey(sourceKey), "start");
  } else {
    sessionStorage.removeItem(caretStorageKey(sourceKey));
  }
}

export function consumeNewSessionPrefill(
  sourceKey: ClientSummarySourceKey,
): NewSessionPrefillRecord | null {
  const text = getNewSessionPrefill(sourceKey);
  if (text == null) return null;
  const caret = readCaret(sourceKey);
  clearNewSessionPrefill(sourceKey);
  return { text, caret };
}

function writtenAt(raw: string): number {
  try {
    const parsed = JSON.parse(raw) as { writtenAt?: unknown };
    return typeof parsed.writtenAt === "number" ? parsed.writtenAt : 0;
  } catch {
    return 0;
  }
}

/** Drops every stashed token past its lifetime, and any left unstamped. */
function forgetStaleNewSessionPrefillTokens(): void {
  const cutoff = Date.now() - NEW_SESSION_PREFILL_TOKEN_LIFETIME_MS;
  const stale: string[] = [];
  for (let index = 0; index < localStorage.length; index += 1) {
    const key = localStorage.key(index);
    if (!key?.startsWith(NEW_SESSION_PREFILL_TOKEN_PREFIX)) continue;
    if (writtenAt(localStorage.getItem(key) ?? "") <= cutoff) stale.push(key);
  }
  for (const key of stale) localStorage.removeItem(key);
}

export function createNewSessionPrefillToken(): string {
  return generateUUID();
}

/**
 * Stores the text a new tab will find under its token. Call this only once the
 * tab exists: a blocked popup that never reads the token must not leave one.
 */
export function stashNewSessionPrefillToken(
  token: string,
  sourceKey: ClientSummarySourceKey,
  text: string,
  options?: { caret?: NewSessionPrefillCaret },
): void {
  if (typeof window === "undefined") return;
  forgetStaleNewSessionPrefillTokens();
  localStorage.setItem(
    `${NEW_SESSION_PREFILL_TOKEN_PREFIX}${token}`,
    JSON.stringify({
      caret: options?.caret === "start" ? "start" : "end",
      sourceKey,
      text,
      writtenAt: Date.now(),
    }),
  );
}

export function consumeNewSessionPrefillToken(
  token: string,
  sourceKey: ClientSummarySourceKey,
): NewSessionPrefillRecord | null {
  if (typeof window === "undefined") return null;
  const storageKey = `${NEW_SESSION_PREFILL_TOKEN_PREFIX}${token}`;
  const raw = localStorage.getItem(storageKey);
  localStorage.removeItem(storageKey);
  forgetStaleNewSessionPrefillTokens();
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as {
      caret?: unknown;
      sourceKey?: unknown;
      text?: unknown;
    };
    if (parsed.sourceKey !== sourceKey || typeof parsed.text !== "string") {
      return null;
    }
    return {
      caret: parsed.caret === "start" ? "start" : "end",
      text: parsed.text,
    };
  } catch {
    return null;
  }
}
