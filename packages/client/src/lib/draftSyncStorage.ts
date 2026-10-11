import { publishDraftPresenceChange } from "./draftPresenceEvents";
import { reconcileSessionDraftPresence } from "./sessionDraftStorage";
import {
  getSyncedDraftSessionIds,
  setSyncedDraftSessionIds,
} from "./syncedDraftPresence";
import type { ClientSummarySourceKey } from "./clientSummaryStore";
import {
  EMPTY_DRAFT,
  draftHasContent,
  draftPayloadEqual,
  mergeDrafts,
  type DraftPayload,
  type DraftRead,
  type DraftSlot,
  type DraftSnapshot,
  type DraftWrite,
  type DraftWriteResult,
} from "@yep-anywhere/shared";
import { readDraftEnvelopeValue } from "./draftEnvelope";
import { accountDraftStorageKey } from "./draftAccountStorage";
import type { SourceTransport } from "./transport/types";
import { generateUUID } from "./uuid";

export const DRAFT_STORAGE_EVENT = "yep-draft-storage";
export const DRAFT_SYNC_STATUS_EVENT = "yep-draft-sync-status";
interface Address {
  source: string;
  slot: DraftSlot;
  format: "envelope" | "string" | "questions" | "async" | "comments";
}
interface Saved {
  raw: string | null;
  base: DraftSnapshot | null;
  pending?: DraftWrite;
  recovery?: string | null;
  discard?: { operation?: DraftWrite; revision?: string | null };
  discardId?: string;
  submitted?: {
    payload: DraftPayload;
    revision: string | null;
    operationId?: string;
  };
}
interface Entry {
  key: string;
  address: Address;
  saved: Saved;
  timer?: ReturnType<typeof setTimeout>;
  firstDirty: number;
  running: boolean;
  remote?: DraftRead;
  needsRecovery?: boolean;
  error?: string;
  /** A rejected request needs changed input, restored access, or explicit retry. */
  rejectedStatus?: number;
  submissionTask?: Promise<void>;
  waitForSync?: Promise<void>;
  confirmations?: number;
  /** When a sibling tab last wrote this draft's text. */
  siblingEditAt?: number;
}
/**
 * A sibling tab that typed into a draft this recently is the one saving it;
 * this tab only mirrors that text, and syncs it itself once the sibling has
 * gone quiet without saving (for example, it closed).
 */
const SIBLING_EDIT_MS = 15_000;
const FOREGROUND_KEY = "draft-sync-foreground";
const TAB_ID = generateUUID();
const owners = new Map<string, string>();
const clients = new Map<string, DraftSyncClient>();
let currentSource = "local";
const listeners = new Map<string, Set<() => void>>();

export function draftAddress(key: string): Address | null {
  try {
    const parts = key.split(":").map(decodeURIComponent);
    if (key.startsWith("draft-message-"))
      return {
        source: "local",
        slot: { kind: "session", sessionId: key.slice(14) },
        format: "envelope",
      };
    const source = parts[1] ?? currentSource;
    if (parts[0] === "draft-message")
      return {
        source,
        slot: { kind: "session", sessionId: parts.slice(2).join(":") },
        format: "envelope",
      };
    if (parts[0] === "draft-new-session")
      return {
        source,
        slot: {
          kind: "new-session",
          ...(parts[2] ? { projectId: parts[2] } : {}),
        },
        format: "envelope",
      };
    if (parts[0] === "fab-draft")
      return { source, slot: { kind: "floating" }, format: "envelope" };
    if (parts[0] === "draft-handoff")
      return {
        source: currentSource,
        slot: { kind: "handoff", sessionId: parts[1] },
        format: "envelope",
      };
    if (parts[0] === "draft-tool-approval-feedback")
      return {
        source,
        slot: { kind: "approval", sessionId: parts[2] },
        format: "string",
      };
    if (parts[0] === "draft-question-other")
      return {
        source,
        slot: { kind: "question", sessionId: parts[2] },
        format: "questions",
      };
    if (parts[0] === "yep-async-questions") {
      const source = [...new Set([...owners.keys(), currentSource, "local"])]
        .sort((a, b) => b.length - a.length)
        .find((s) => key.startsWith(`yep-async-questions:${s}:`));
      if (source) {
        const rest = key.slice(`yep-async-questions:${source}:`.length);
        const split = rest.indexOf(":");
        if (split > 0)
          return {
            source,
            slot: {
              kind: "async-question",
              sessionId: rest.slice(0, split),
              field: rest.slice(split + 1),
            },
            format: "async",
          };
      }
    }
    if (parts[0] === "session-file-comments")
      return {
        source,
        slot: {
          kind: "file-comments",
          sessionId: parts[2],
          projectId: parts[3],
          field: parts.slice(4).join(":"),
        },
        format: "comments",
      };
  } catch {
    /* Unknown legacy keys remain local. */
  }
  return null;
}
export function draftLocalKey(source: string, slot: DraftSlot): string {
  const e = encodeURIComponent;
  switch (slot.kind) {
    case "session":
      return source === "local"
        ? `draft-message-${slot.sessionId}`
        : `draft-message:${e(source)}:${e(slot.sessionId ?? "")}`;
    case "new-session":
      return `draft-new-session:${e(source)}${slot.projectId ? `:${e(slot.projectId)}` : ""}`;
    case "floating":
      return `fab-draft:${e(source)}`;
    case "handoff":
      return `draft-handoff:${slot.sessionId}`;
    case "approval":
      return `draft-tool-approval-feedback:${e(source)}:${e(slot.sessionId ?? "")}`;
    case "question":
      return `draft-question-other:${e(source)}:${e(slot.sessionId ?? "")}`;
    case "async-question":
      return `yep-async-questions:${source}:${slot.sessionId}:${slot.field}`;
    case "file-comments":
      return [
        "session-file-comments",
        source,
        slot.sessionId ?? "",
        slot.projectId ?? "",
        slot.field ?? "",
      ]
        .map(e)
        .join(":");
  }
}
function payload(address: Address, raw: string | null): DraftPayload {
  try {
    if (address.format === "envelope") {
      const envelope = readDraftEnvelopeValue(raw).envelope;
      return {
        fields: envelope?.text ? { text: envelope.text } : {},
        attachments: envelope?.attachments?.refs ?? [],
      };
    }
    if (address.format === "string")
      return { fields: raw ? { text: raw } : {}, attachments: [] };
    const parsed = JSON.parse(raw ?? "null");
    if (address.format === "async")
      return {
        fields: parsed?.draft ? { text: parsed.draft } : {},
        attachments: [],
      };
    if (address.format === "questions")
      return { fields: parsed ?? {}, attachments: [] };
    const fields: Record<string, string> = {};
    for (const comment of parsed ?? []) {
      const { text, ...meta } = comment;
      fields[`${comment.id}/text`] = text;
      fields[`${comment.id}/meta`] = JSON.stringify(meta);
    }
    return { fields, attachments: [] };
  } catch {
    return EMPTY_DRAFT;
  }
}
function encode(
  address: Address,
  value: DraftPayload,
  old: string | null,
): string | null {
  if (address.format === "envelope")
    return draftHasContent(value)
      ? JSON.stringify({
          version: 1,
          text: value.fields.text ?? "",
          ...(value.attachments.length
            ? {
                attachments: {
                  batchId: value.attachments[0]!.batchId,
                  refs: value.attachments,
                  updatedAt: new Date().toISOString(),
                },
              }
            : {}),
        })
      : null;
  if (address.format === "string") return value.fields.text || null;
  if (address.format === "questions")
    return Object.keys(value.fields).length
      ? JSON.stringify(value.fields)
      : null;
  if (address.format === "async") {
    let record: Record<string, unknown> = {
      draft: "",
      dismissed: false,
      seen: false,
      answer: null,
      edits: 0,
    };
    try {
      record = { ...record, ...JSON.parse(old ?? "{}") };
    } catch {}
    return JSON.stringify({ ...record, draft: value.fields.text ?? "" });
  }
  const comments = [];
  for (const [key, text] of Object.entries(value.fields))
    if (key.endsWith("/text") && text) {
      try {
        comments.push({
          ...JSON.parse(value.fields[`${key.slice(0, -5)}/meta`] ?? "{}"),
          text,
        });
      } catch {}
    }
  return comments.length ? JSON.stringify(comments) : null;
}
function storageAddress(key: string): Address | null {
  const draft = draftAddress(key);
  if (draft) return draft;
  if (/^draft-(index|presence)-message:/.test(key)) {
    try {
      return {
        source: decodeURIComponent(key.split(":")[1] ?? "local"),
        slot: { kind: "floating" },
        format: "string",
      };
    } catch {}
  }
  return null;
}
function physical(key: string, address: Address): string {
  const owner =
    owners.get(address.source) ??
    localStorage.getItem(`draft-owner:${encodeURIComponent(address.source)}`);
  const sourceKey =
    address.slot.kind === "handoff" && address.source !== "local"
      ? `draft-source:${encodeURIComponent(address.source)}:${key}`
      : key;
  return accountDraftStorageKey(sourceKey, owner);
}
function notify(key: string): void {
  for (const listener of listeners.get(key) ?? []) listener();
  window.dispatchEvent(
    new CustomEvent(DRAFT_STORAGE_EVENT, { detail: { key } }),
  );
}
export function subscribeDraftStorage(
  key: string,
  listener: () => void,
): () => void {
  let set = listeners.get(key);
  if (!set) {
    set = new Set();
    listeners.set(key, set);
  }
  set.add(listener);
  const address = draftAddress(key);
  if (address && !key.endsWith("*")) clients.get(address.source)?.observe(key);
  if (key.endsWith("*"))
    for (const client of clients.values()) void client.refresh();
  let subscribed = true;
  return () => {
    if (!subscribed) return;
    subscribed = false;
    set.delete(listener);
    if (!set.size) listeners.delete(key);
    if (address && !key.endsWith("*"))
      clients.get(address.source)?.release(key);
    if (key.endsWith("*"))
      for (const client of clients.values()) client.releaseInactive();
  };
}
function observed(key: string): boolean {
  if (listeners.has(key)) return true;
  for (const candidate of listeners.keys())
    if (candidate.endsWith("*") && key.startsWith(candidate.slice(0, -1)))
      return true;
  return false;
}
export const draftStorage = {
  physicalKey(key: string): string {
    const address = storageAddress(key);
    return address ? physical(key, address) : key;
  },
  keys(): string[] {
    const keys = new Set<string>();
    for (let i = 0; i < localStorage.length; i++) {
      const stored = localStorage.key(i);
      if (!stored) continue;
      let key = stored.startsWith("draft-account:")
        ? stored.slice(stored.indexOf(":", 14) + 1)
        : stored;
      if (key.startsWith("draft-source:"))
        key = key.slice(key.indexOf(":", 13) + 1);
      const a = storageAddress(key);
      if (a && physical(key, a) === stored) keys.add(key);
    }
    return [...keys];
  },
  getItem(key: string): string | null {
    const a = storageAddress(key);
    const held = a && clients.get(a.source)?.entries.get(key);
    if (held) return held.saved.raw;
    return localStorage.getItem(a ? physical(key, a) : key);
  },
  setItem(key: string, raw: string): void {
    const a = storageAddress(key);
    try {
      localStorage.setItem(a ? physical(key, a) : key, raw);
    } catch (error) {
      if (a && draftAddress(key)) {
        clients.get(a.source)?.edit(key, raw);
        clients.get(a.source)?.localFailure(key);
      }
      throw error;
    }
    if (a && draftAddress(key)) clients.get(a.source)?.edit(key, raw);
  },
  removeItem(key: string): void {
    const a = storageAddress(key);
    localStorage.removeItem(a ? physical(key, a) : key);
    if (a && draftAddress(key)) clients.get(a.source)?.edit(key, null);
  },
};
/**
 * The tab holding the window focus claims it in the storage its siblings
 * share, so a background tab can tell that someone may be typing there.
 */
function claimForeground(): void {
  try {
    localStorage.setItem(FOREGROUND_KEY, TAB_ID);
  } catch {
    /* Without storage there are no siblings to protect. */
  }
}
function releaseForeground(): void {
  try {
    if (localStorage.getItem(FOREGROUND_KEY) === TAB_ID)
      localStorage.removeItem(FOREGROUND_KEY);
  } catch {
    /* Without storage there are no siblings to protect. */
  }
}
let foregroundClaimInstalled = false;
function installForegroundClaim(): void {
  if (foregroundClaimInstalled) return;
  foregroundClaimInstalled = true;
  if (document.hasFocus()) claimForeground();
  window.addEventListener("focus", claimForeground);
  window.addEventListener("blur", releaseForeground);
  window.addEventListener("pagehide", releaseForeground);
}
function uninstallForegroundClaim(): void {
  if (!foregroundClaimInstalled) return;
  foregroundClaimInstalled = false;
  window.removeEventListener("focus", claimForeground);
  window.removeEventListener("blur", releaseForeground);
  window.removeEventListener("pagehide", releaseForeground);
  releaseForeground();
}
/** True while another tab sharing this origin's storage holds the focus. */
function siblingForeground(): boolean {
  if (document.hasFocus()) return false;
  try {
    const tab = localStorage.getItem(FOREGROUND_KEY);
    return !!tab && tab !== TAB_ID;
  } catch {
    return false;
  }
}
/** A composer in a window without focus is not being typed in. */
function editing(key: string): boolean {
  if (!document.hasFocus()) return false;
  const el = document.activeElement;
  const editorKey = el
    ?.closest("[data-draft-key]")
    ?.getAttribute("data-draft-key");
  if (editorKey && editorKey !== key) return false;
  return (
    !!el &&
    (el.tagName === "TEXTAREA" ||
      el.tagName === "INPUT" ||
      (el as HTMLElement).isContentEditable)
  );
}
export interface PendingDraft {
  key: string;
  slot: DraftSlot;
  error?: string;
  recovery: boolean;
  local: DraftPayload;
  remote?: DraftSnapshot;
  submitted?: DraftPayload;
}

/**
 * Server text replaces this tab's text only where nobody can be typing over
 * it. A composer being edited keeps its text unless it is still empty and
 * untouched since the last save, which is a window picking up a draft begun
 * elsewhere. A background tab never writes server text into the storage a
 * focused sibling types into: that write lands in the sibling's composer and
 * drops whatever was typed after the text it was merged from.
 */
function holdsRemote(e: Entry, local: DraftPayload): boolean {
  if (siblingForeground()) return true;
  if (!editing(e.key)) return false;
  return (
    draftHasContent(local) ||
    !draftPayloadEqual(local, e.saved.base?.payload ?? EMPTY_DRAFT)
  );
}

/** A one-sided update held for focus is ordinary handoff, not a conflict. */
function conflicting(e: Entry): boolean {
  if (!e.remote) return false;
  const base = e.saved.base?.payload ?? EMPTY_DRAFT;
  const local = payload(e.address, e.saved.raw);
  const remote = e.remote.snapshot.payload;
  return Object.keys(local.fields).some((key) => {
    const l = local.fields[key] ?? "";
    const r = remote.fields[key] ?? "";
    const b = base.fields[key] ?? "";
    return (
      !key.endsWith("/meta") && !!l && !!r && l !== r && l !== b && r !== b
    );
  });
}

export function draftSyncPending(source?: string): PendingDraft[] {
  return [...clients.values()]
    .filter((c) => !source || c.source === source)
    .flatMap((c) =>
      [...c.entries.values()]
        .filter(
          (e) =>
            e.error === "local" ||
            (!e.saved.discard &&
              (conflicting(e) || e.error || e.needsRecovery)),
        )
        .map((e) => ({
          key: e.key,
          slot: e.address.slot,
          error: e.error,
          recovery: !!e.needsRecovery,
          local: payload(e.address, e.saved.raw),
          remote: e.remote?.snapshot,
          submitted: e.saved.submitted?.payload,
        })),
    );
}
export function acceptPendingDraft(key: string): void {
  const address = draftAddress(key);
  const client = address && clients.get(address.source);
  const entry = client?.entries.get(key);
  if (entry && client) client.accept(entry);
}
export function retryPendingDraft(key: string): void {
  const address = draftAddress(key);
  const client = address && clients.get(address.source);
  const entry = client?.entries.get(key);
  if (entry && client) client.retryEntry(entry);
}
export function discardPendingDraft(key: string): void {
  const address = draftAddress(key);
  const client = address && clients.get(address.source);
  const entry = client?.entries.get(key);
  if (entry && client) client.discard(entry);
}
export type DraftResolution = "local" | "remote" | "combine";
export async function resolvePendingDraft(
  key: string,
  choice: DraftResolution,
  reviewedRevision: string | null,
): Promise<boolean> {
  const address = draftAddress(key);
  const client = address && clients.get(address.source);
  const entry = client?.entries.get(key);
  return entry && client
    ? client.resolve(entry, choice, reviewedRevision)
    : false;
}
function status(): void {
  window.dispatchEvent(new Event(DRAFT_SYNC_STATUS_EVENT));
}
/** Server sequences only grow, so an acknowledged base never moves back. */
function newerBase(
  candidate: DraftSnapshot | null | undefined,
  current: DraftSnapshot | null,
): candidate is DraftSnapshot {
  return !!candidate && candidate.sequence > (current?.sequence ?? -1);
}

/** One source/account owner. Storage wrappers are also used in local-only mode. */
export class DraftSyncClient {
  readonly entries = new Map<string, Entry>();
  private stopped = false;
  private started = false;
  private identified = false;
  private refreshing?: Promise<void>;
  private refreshSince?: number;
  private refreshedAt = 0;
  private sequence = -1;
  private abort = new AbortController();
  private retry?: ReturnType<typeof setTimeout>;
  private unstatus?: () => void;
  constructor(
    readonly source: string,
    readonly owner: string,
    private transport: SourceTransport,
  ) {}
  private metaKey(key: string): string {
    return `draft-sync-v1:${encodeURIComponent(this.source)}:${encodeURIComponent(this.owner)}:${encodeURIComponent(key)}`;
  }
  private persist(e: Entry): void {
    try {
      localStorage.setItem(this.metaKey(e.key), JSON.stringify(e.saved));
    } catch {
      e.error = "local";
      status();
    }
  }
  register(key: string): Entry | null {
    const present = this.entries.get(key);
    if (present) return present;
    const address = draftAddress(key);
    if (!address || address.source !== this.source) return null;
    let raw: string | null = null;
    let error: string | undefined;
    try {
      raw = draftStorage.getItem(key);
    } catch {
      error = "local";
    }
    let saved: Saved = { raw, base: null };
    try {
      const meta = JSON.parse(
        localStorage.getItem(this.metaKey(key)) ?? "null",
      );
      if (meta) {
        // Earlier builds stored sibling-tab merges here; the storage value
        // already holds that text, and replaying the merge duplicates it.
        const { alternative: _sibling, ...kept } = meta;
        saved = { ...kept, raw: saved.raw };
      }
    } catch {}
    const e: Entry = {
      key,
      address,
      saved,
      firstDirty: 0,
      running: false,
      needsRecovery: !!saved.submitted,
      error,
    };
    this.entries.set(key, e);
    return e;
  }
  localFailure(key: string): void {
    const e = this.entries.get(key);
    if (e) {
      e.error = "local";
      status();
    }
  }
  observe(key: string): void {
    const e = this.register(key);
    if (e) this.schedule(e, 0);
  }
  /** Only discard memory that can be reconstructed without losing sync work. */
  release(key: string): void {
    const e = this.entries.get(key);
    if (
      !e ||
      observed(key) ||
      e.running ||
      e.waitForSync ||
      e.submissionTask ||
      e.confirmations ||
      e.saved.pending ||
      e.saved.discard ||
      e.saved.submitted ||
      e.remote ||
      e.needsRecovery ||
      e.error ||
      e.rejectedStatus ||
      !draftPayloadEqual(
        payload(e.address, e.saved.raw),
        e.saved.base?.payload ?? EMPTY_DRAFT,
      ) ||
      (e.address.format === "envelope" &&
        readDraftEnvelopeValue(e.saved.raw).envelope?.pendingSendAt !==
          undefined)
    )
      return;
    try {
      // A failed local write or a sibling-tab edit must not discard our copy.
      if (localStorage.getItem(physical(key, e.address)) !== e.saved.raw)
        return;
    } catch {
      return;
    }
    if (e.timer) clearTimeout(e.timer);
    this.entries.delete(key);
  }
  releaseInactive(): void {
    for (const key of this.entries.keys()) this.release(key);
  }
  edit(key: string, raw: string | null): void {
    const e = this.register(key);
    if (!e) return;
    e.saved.raw = raw;
    if (e.error === "local") e.error = undefined;
    if (e.rejectedStatus && [400, 413, 422].includes(e.rejectedStatus))
      e.rejectedStatus = undefined;
    // Typing here makes this tab the one that saves the draft.
    e.siblingEditAt = undefined;
    // The text itself is already in browser storage. Rewriting this tab's
    // sync metadata on every keystroke would also overwrite a newer base a
    // sibling tab stored after saving the same draft.
    if (
      e.saved.submitted &&
      raw &&
      readDraftEnvelopeValue(raw).envelope?.pendingSendAt === undefined
    ) {
      e.saved.recovery = encode(e.address, e.saved.submitted.payload, null);
      this.persist(e);
    }
    if (
      raw &&
      readDraftEnvelopeValue(raw).envelope?.pendingSendAt !== undefined
    ) {
      this.beginSubmit(e);
      return;
    }
    this.schedule(e, raw === null ? 0 : 3000);
    if (e.remote) status();
  }
  private schedule(e: Entry, delay: number): void {
    if (this.stopped || e.needsRecovery || e.rejectedStatus) return;
    if (e.timer) clearTimeout(e.timer);
    if (!e.firstDirty) e.firstDirty = Date.now();
    e.timer = setTimeout(
      () => {
        e.timer = undefined;
        void this.sync(e);
      },
      Math.min(delay, Math.max(0, 10_000 - (Date.now() - e.firstDirty))),
    );
  }
  /**
   * Sibling tabs share one browser storage and so one draft: the newest base
   * any of them acknowledged is this tab's base too. Reconciling against an
   * older in-memory base makes a sibling's save of this same text look like
   * another device's edit.
   */
  private adoptSharedBase(e: Entry): void {
    try {
      const stored = JSON.parse(
        localStorage.getItem(this.metaKey(e.key)) ?? "null",
      ) as Saved | null;
      if (newerBase(stored?.base, e.saved.base)) e.saved.base = stored!.base;
    } catch {
      /* Unreadable storage leaves this tab's own base. */
    }
  }
  /** One reconciliation of a slot at a time across this origin's tabs. */
  private async exclusive<T>(e: Entry, run: () => Promise<T>): Promise<T> {
    const locks =
      typeof navigator === "undefined" ? undefined : navigator.locks;
    return locks ? await locks.request(this.metaKey(e.key), run) : run();
  }
  private post<T>(path: string, body: unknown): Promise<T> {
    return this.transport.fetch<T>(`/drafts/${path}`, {
      method: "POST",
      body: JSON.stringify(body),
      signal: this.abort.signal,
    });
  }
  sync(e: Entry): Promise<void> {
    return this.exclusive(e, () => this.syncNow(e));
  }
  private async syncNow(e: Entry): Promise<void> {
    if (
      this.stopped ||
      this.entries.get(e.key) !== e ||
      e.running ||
      (this.started && !this.identified) ||
      this.transport.status.getSnapshot().state !== "ready" ||
      e.needsRecovery ||
      e.rejectedStatus ||
      e.saved.submitted ||
      e.submissionTask
    )
      return;
    // Two tabs saving one shared draft race each other's merges; leave it to
    // the tab being typed in.
    const siblingActive =
      SIBLING_EDIT_MS - (Date.now() - (e.siblingEditAt ?? -Infinity));
    if (siblingActive > 0) {
      e.firstDirty = 0;
      this.schedule(e, siblingActive);
      return;
    }
    e.running = true;
    const saved = e.saved;
    let finishSync!: () => void;
    e.waitForSync = new Promise<void>((resolve) => {
      finishSync = resolve;
    });
    e.firstDirty = 0;
    let readSucceeded = false;
    try {
      let read = await this.post<DraftRead>("read", { slot: e.address.slot });
      readSucceeded = true;
      if (this.stopped || e.saved !== saved) return;
      if (e.error === "sync") e.error = undefined;
      if (saved.discard) {
        if (
          saved.discard.revision !== undefined &&
          saved.discard.revision !== read.snapshot.revision &&
          !saved.discard.operation
        ) {
          saved.discard = undefined;
          saved.base = read.snapshot;
          if (draftHasContent(read.snapshot.payload)) e.remote = read;
          this.persist(e);
          status();
          return;
        }
        if (!saved.discard.operation) {
          saved.discard.revision = read.snapshot.revision;
          saved.discard.operation = {
            slot: e.address.slot,
            baseRevision: read.snapshot.revision,
            ticket: read.ticket,
            operationId: generateUUID(),
            payload: EMPTY_DRAFT,
          };
          this.persist(e);
        }
        const result = await this.post<DraftWriteResult>(
          "clear",
          saved.discard.operation,
        );
        if (this.stopped || e.saved !== saved) return;
        if (result.outcome === "expired") {
          saved.discard.operation = undefined;
          this.persist(e);
          this.schedule(e, 0);
          return;
        }
        saved.discard = undefined;
        saved.base = result.snapshot;
        this.persist(e);
        // A concurrent remote edit survives the conditional clear.
        if (
          result.outcome !== "accepted" &&
          draftHasContent(result.snapshot.payload)
        )
          e.remote = result;
        else if (draftHasContent(payload(e.address, saved.raw)))
          this.schedule(e, 0);
        status();
        return;
      }
      if (e.saved.pending) {
        const result = await this.post<DraftWriteResult>(
          "write",
          e.saved.pending,
        );
        if (this.stopped || e.saved !== saved) return;
        if (result.outcome === "accepted") {
          e.saved.base = result.snapshot;
          e.saved.pending = undefined;
          this.persist(e);
          read = await this.post<DraftRead>("read", { slot: e.address.slot });
          if (this.stopped || e.saved !== saved) return;
        } else if (result.outcome === "expired") {
          e.needsRecovery = true;
          e.saved.recovery = e.saved.raw;
          this.persist(e);
          status();
          return;
        } else {
          e.saved.pending = undefined;
          this.persist(e);
          read = result;
        }
      }
      if (e.saved.submitted) return;
      e.remote = undefined;
      this.adoptSharedBase(e);
      // A read answered before a newer acknowledged revision (this tab's or a
      // sibling's) holds text the draft has already moved past, such as the
      // prefix typed before a send that has since been cleared. Merged against
      // that newer base, it would come back as another device's edit. The
      // next change notification or edit reads again.
      if (read.snapshot.sequence < (e.saved.base?.sequence ?? -1)) return;
      const local = payload(e.address, e.saved.raw);
      if (
        e.saved.base?.revision &&
        read.snapshot.revision === null &&
        draftHasContent(local)
      ) {
        e.needsRecovery = true;
        e.saved.recovery = e.saved.raw;
        this.persist(e);
        status();
        return;
      }
      const merged = mergeDrafts(
        e.saved.base?.payload ?? EMPTY_DRAFT,
        local,
        read.snapshot.payload,
      );
      if (!draftPayloadEqual(local, merged)) {
        e.remote = read;
        if (holdsRemote(e, local) || conflicting(e)) {
          status();
          return;
        }
        e.remote = undefined;
        this.apply(e, merged);
      }
      e.saved.base = read.snapshot;
      this.persist(e);
      if (draftPayloadEqual(merged, read.snapshot.payload)) {
        if (e.error !== "local") e.error = undefined;
        status();
        return;
      }
      const operation: DraftWrite = {
        slot: e.address.slot,
        baseRevision: read.snapshot.revision,
        ticket: read.ticket,
        operationId: generateUUID(),
        payload: merged,
        recovery: !draftPayloadEqual(local, merged),
      };
      e.saved.pending = operation;
      this.persist(e);
      const result = await this.post<DraftWriteResult>("write", operation);
      if (this.stopped || e.saved !== saved) return;
      if (result.outcome === "accepted") {
        e.saved.base = result.snapshot;
        this.ackSubmitted(e, result);
        e.saved.pending = undefined;
        this.persist(e);
        if (e.error !== "local") e.error = undefined;
      } else if (result.outcome === "expired") {
        e.needsRecovery = true;
        e.saved.recovery = e.saved.raw;
        status();
      } else {
        e.saved.pending = undefined;
        this.persist(e);
        this.schedule(e, 500);
      }
      // Acknowledgement only covers the immutable captured payload.
      if (!draftPayloadEqual(payload(e.address, e.saved.raw), merged))
        this.schedule(e, 3000);
      status();
    } catch (error) {
      if (!this.stopped && e.saved === saved) {
        const httpStatus =
          error instanceof Error && "status" in error
            ? error.status
            : undefined;
        if (
          typeof httpStatus === "number" &&
          [400, 403, 404, 413, 422].includes(httpStatus)
        ) {
          e.rejectedStatus = httpStatus;
          // These responses reject the operation before accepting a revision.
          if (readSucceeded && [400, 413, 422].includes(httpStatus)) {
            saved.pending = undefined;
            if (saved.discard) saved.discard.operation = undefined;
            this.persist(e);
          }
        }
        if (e.error !== "local")
          e.error = draftHasContent(payload(e.address, saved.raw))
            ? "sync"
            : undefined;
        status();
        this.schedule(e, 10_000);
      }
    } finally {
      e.running = false;
      e.waitForSync = undefined;
      finishSync();
      if (e.saved !== saved) this.schedule(e, 0);
      if (this.started) this.release(e.key);
    }
  }
  private ackSubmitted(e: Entry, result: DraftWriteResult): void {
    const submitted = e.saved.submitted;
    if (
      submitted?.operationId === result.operationId &&
      draftPayloadEqual(result.snapshot.payload, submitted.payload)
    )
      submitted.revision = result.snapshot.revision;
  }
  private apply(e: Entry, p: DraftPayload): void {
    const previousRaw = e.saved.raw;
    e.saved.raw = encode(e.address, p, e.saved.raw);
    const key = physical(e.key, e.address);
    try {
      if (e.saved.raw === null) localStorage.removeItem(key);
      else localStorage.setItem(key, e.saved.raw);
      this.persist(e);
    } catch {
      e.error = "local";
      status();
    }
    this.reconcilePresence(e, previousRaw);
    notify(e.key);
  }
  private reconcilePresence(e: Entry, previousRaw: string | null): void {
    if (e.address.slot.kind !== "session" || !e.address.slot.sessionId) return;
    reconcileSessionDraftPresence(
      {
        sourceKey: this.source as ClientSummarySourceKey,
        sessionId: e.address.slot.sessionId,
      },
      previousRaw,
      e.saved.raw,
    );
  }
  /** Retry storing this tab's current value after a failed browser write. */
  private retryLocal(e: Entry): void {
    const key = physical(e.key, e.address);
    try {
      if (e.saved.raw === null) localStorage.removeItem(key);
      else localStorage.setItem(key, e.saved.raw);
      localStorage.setItem(this.metaKey(e.key), JSON.stringify(e.saved));
      e.error = undefined;
    } catch {
      e.error = "local";
    }
  }
  retryEntry(e: Entry): void {
    e.rejectedStatus = undefined;
    if (e.error === "local") this.retryLocal(e);
    else e.error = undefined;
    this.schedule(e, 0);
    status();
  }
  accept(e: Entry): void {
    e.rejectedStatus = undefined;
    if (e.error === "local") this.retryLocal(e);
    if (e.needsRecovery) {
      if (e.saved.submitted)
        this.apply(
          e,
          mergeDrafts(
            EMPTY_DRAFT,
            payload(e.address, e.saved.raw),
            e.saved.submitted.payload,
          ),
        );
      e.saved.pending = undefined;
      e.saved.base = null;
      e.needsRecovery = false;
      e.saved.submitted = undefined;
      this.persist(e);
    }
    if (e.remote) {
      const remote = e.remote;
      e.remote = undefined;
      this.adoptSharedBase(e);
      this.apply(
        e,
        mergeDrafts(
          e.saved.base?.payload ?? EMPTY_DRAFT,
          payload(e.address, e.saved.raw),
          remote.snapshot.payload,
        ),
      );
      e.saved.base = remote.snapshot;
      this.persist(e);
    }
    if (e.error !== "local") e.error = undefined;
    this.schedule(e, 0);
    status();
  }
  /** Refresh before a choice; changed server evidence requires another review. */
  resolve(
    e: Entry,
    choice: DraftResolution,
    reviewedRevision: string | null,
  ): Promise<boolean> {
    const localAtChoice = payload(e.address, e.saved.raw);
    return this.exclusive(e, () =>
      this.resolveNow(e, choice, reviewedRevision, localAtChoice),
    );
  }
  private async resolveNow(
    e: Entry,
    choice: DraftResolution,
    reviewedRevision: string | null,
    localAtChoice: DraftPayload,
  ): Promise<boolean> {
    await e.waitForSync;
    if (
      this.stopped ||
      e.running ||
      e.needsRecovery ||
      e.saved.submitted ||
      this.transport.status.getSnapshot().state !== "ready"
    )
      return false;
    e.running = true;
    const saved = e.saved;
    let finish!: () => void;
    e.waitForSync = new Promise<void>((resolve) => {
      finish = resolve;
    });
    try {
      const remote = await this.post<DraftRead>("read", {
        slot: e.address.slot,
      });
      if (this.stopped || e.saved !== saved || saved.submitted) return false;
      if (e.error === "sync") e.error = undefined;
      this.adoptSharedBase(e);
      e.remote = remote;
      status();
      const local = payload(e.address, saved.raw);
      if (
        remote.snapshot.revision !== reviewedRevision ||
        !draftPayloadEqual(local, localAtChoice)
      )
        return false;
      const resolved =
        choice === "local"
          ? local
          : choice === "remote"
            ? remote.snapshot.payload
            : mergeDrafts(
                saved.base?.payload ?? EMPTY_DRAFT,
                local,
                remote.snapshot.payload,
              );
      e.remote = undefined;
      saved.base = remote.snapshot;
      this.apply(e, resolved);
      return true;
    } catch {
      if (e.saved === saved && e.error !== "local") e.error = "sync";
      return false;
    } finally {
      e.running = false;
      e.waitForSync = undefined;
      finish();
      this.schedule(e, 0);
      status();
    }
  }
  discard(e: Entry): void {
    e.rejectedStatus = undefined;
    e.saved = {
      raw: e.saved.raw,
      base: e.saved.base,
      discard: {},
      discardId: generateUUID(),
    };
    e.remote = undefined;
    e.needsRecovery = false;
    e.error = undefined;
    this.apply(e, EMPTY_DRAFT);
    this.schedule(e, 0);
    status();
  }
  private beginSubmit(e: Entry): void {
    if (e.saved.submitted) return;
    const captured = payload(e.address, e.saved.raw);
    e.saved.submitted = {
      payload: captured,
      revision: draftPayloadEqual(
        e.saved.base?.payload ?? EMPTY_DRAFT,
        captured,
      )
        ? (e.saved.base?.revision ?? null)
        : null,
      operationId: e.saved.pending?.operationId,
    };
    this.persist(e);
    const ongoing = e.waitForSync;
    e.submissionTask = (async () => {
      await ongoing;
      if (!this.stopped) await this.flushSubmitted(e);
    })().finally(() => {
      e.submissionTask = undefined;
      if (!e.saved.submitted) this.schedule(e, 0);
    });
  }
  private async flushSubmitted(e: Entry): Promise<void> {
    const saved = e.saved;
    const submitted = e.saved.submitted;
    if (!submitted || (this.started && !this.identified)) return;
    try {
      if (e.saved.pending) {
        const pending = e.saved.pending;
        const result = await this.post<DraftWriteResult>("write", pending);
        if (this.stopped || e.saved !== saved) return;
        if (result.outcome !== "accepted") return;
        e.saved.base = result.snapshot;
        e.saved.pending = undefined;
        if (draftPayloadEqual(result.snapshot.payload, submitted.payload))
          submitted.revision = result.snapshot.revision;
      }
      const read = await this.post<DraftRead>("read", { slot: e.address.slot });
      if (
        this.stopped ||
        e.saved.submitted !== submitted ||
        read.snapshot.revision !== (e.saved.base?.revision ?? null)
      )
        return;
      if (draftPayloadEqual(read.snapshot.payload, submitted.payload)) {
        submitted.revision = read.snapshot.revision;
        this.persist(e);
        return;
      }
      const operation: DraftWrite = {
        slot: e.address.slot,
        baseRevision: read.snapshot.revision,
        ticket: read.ticket,
        operationId: generateUUID(),
        payload: submitted.payload,
      };
      e.saved.pending = operation;
      submitted.operationId = operation.operationId;
      this.persist(e);
      const result = await this.post<DraftWriteResult>("write", operation);
      if (this.stopped || e.saved !== saved) return;
      if (result.outcome === "accepted") {
        submitted.revision = result.snapshot.revision;
        e.saved.base = result.snapshot;
        e.saved.pending = undefined;
        this.persist(e);
      }
    } catch {
      /* The existing send can still succeed. Preserve its recovery copy. */
    }
  }
  async confirm(key: string): Promise<void> {
    const e = this.register(key);
    if (!e) return;
    e.confirmations = (e.confirmations ?? 0) + 1;
    const submitted = e.saved.submitted;
    const captured = submitted?.payload ?? payload(e.address, e.saved.raw);
    if (!submitted) this.beginSubmit(e);
    const saved = e.saved;
    // Resolve an in-flight save first; never clear a revision with different content.
    try {
      await e.submissionTask;
      if (this.stopped || e.saved !== saved) return;
      if (e.saved.pending) {
        const result = await this.post<DraftWriteResult>(
          "write",
          e.saved.pending,
        );
        if (this.stopped || e.saved !== saved) return;
        if (result.outcome === "accepted") {
          e.saved.base = result.snapshot;
          if (
            e.saved.submitted?.operationId === result.operationId &&
            draftPayloadEqual(result.snapshot.payload, captured)
          )
            e.saved.submitted.revision = result.snapshot.revision;
          e.saved.pending = undefined;
        }
      }
      const read = await this.post<DraftRead>("read", { slot: e.address.slot });
      if (this.stopped || e.saved !== saved) return;
      if (
        !draftPayloadEqual(read.snapshot.payload, captured) ||
        read.snapshot.revision !== e.saved.submitted?.revision
      )
        return;
      const result = await this.post<DraftWriteResult>("clear", {
        slot: e.address.slot,
        baseRevision: read.snapshot.revision,
        ticket: read.ticket,
        operationId: generateUUID(),
      });
      if (this.stopped || e.saved !== saved) return;
      if (result.outcome === "accepted") e.saved.base = result.snapshot;
    } catch {
      if (e.saved === saved && e.error !== "local") e.error = "sync";
      status();
    } finally {
      e.confirmations = (e.confirmations ?? 1) - 1;
      if (e.saved === saved) e.saved.submitted = undefined;
      this.persist(e);
      this.schedule(e, 0);
      if (this.started) this.release(key);
    }
  }
  resume(key: string): void {
    const e = this.entries.get(key);
    if (e) {
      if (e.saved.submitted) {
        const local = payload(e.address, e.saved.raw);
        this.apply(
          e,
          mergeDrafts(EMPTY_DRAFT, local, e.saved.submitted.payload),
        );
      }
      e.saved.submitted = undefined;
      e.needsRecovery = false;
      this.persist(e);
      this.schedule(e, 0);
    }
  }
  refresh(since?: number): Promise<void> {
    if (this.refreshing) {
      // A foreground/full refresh must not settle with a partial index.
      if (since === undefined && this.refreshSince !== undefined)
        return this.refreshing.then(() => this.refresh());
      return this.refreshing;
    }
    this.refreshSince = since;
    this.refreshing = this.refreshNow(since).finally(() => {
      this.refreshing = undefined;
      this.refreshSince = undefined;
    });
    return this.refreshing;
  }
  private async refreshNow(since?: number): Promise<void> {
    if (
      this.stopped ||
      document.visibilityState === "hidden" ||
      this.transport.status.getSnapshot().state !== "ready"
    )
      return;
    try {
      let after = "";
      let sequence = this.sequence;
      const sessionIds =
        since === undefined
          ? new Set<string>()
          : new Set(getSyncedDraftSessionIds(this.source));
      const revisions = new Map<string, string>();
      do {
        const result = await this.transport.fetch<{
          entries: Array<{ slot: DraftSlot; revision: string; empty: boolean }>;
          next: string | null;
          owner: string;
          sequence: number;
        }>(
          `/drafts/index?after=${encodeURIComponent(after)}${since === undefined ? "" : `&since=${since}`}`,
          {
            signal: this.abort.signal,
          },
        );
        if (this.stopped) return;
        if (result.owner !== this.owner) {
          this.stop();
          return;
        }
        // A replaced/reset account has no history covering the old cursor.
        if (since !== undefined && result.sequence < since)
          return this.refreshNow();
        this.identified = true;
        // Later pages may include changes absent from pages already read.
        // Acknowledge only the first page's cursor, after the whole scan succeeds.
        if (!after) sequence = result.sequence;
        for (const item of result.entries) {
          if (item.slot.kind === "session" && item.slot.sessionId) {
            if (item.empty) sessionIds.delete(item.slot.sessionId);
            else sessionIds.add(item.slot.sessionId);
          }
          const key = draftLocalKey(this.source, item.slot);
          revisions.set(key, item.revision);
          const e =
            this.entries.get(key) ??
            (observed(key) ? this.register(key) : null);
          // A pending save reads the server anyway. Preempting its debounce
          // made each tab's save a change notice that sent the other tab's
          // save at once, so two tabs alternated writes on every keystroke.
          if (e && !e.timer && e.saved.base?.revision !== item.revision)
            this.schedule(e, 0);
        }
        after = result.next ?? "";
      } while (after && !this.stopped);
      this.sequence = sequence;
      this.refreshedAt = Date.now();
      const previous = getSyncedDraftSessionIds(this.source);
      setSyncedDraftSessionIds(this.source, sessionIds);
      for (const sessionId of new Set([...previous, ...sessionIds])) {
        if (previous.has(sessionId) === sessionIds.has(sessionId)) continue;
        const key = draftLocalKey(this.source, { kind: "session", sessionId });
        const address = draftAddress(key)!;
        let localHasContent = previous.has(sessionId);
        try {
          localHasContent = draftHasContent(
            payload(address, draftStorage.getItem(key)),
          );
        } catch {
          // Storage failure must not erase the last known local badge.
        }
        publishDraftPresenceChange({
          storageKey: key,
          hasContent: sessionIds.has(sessionId) || localHasContent,
          sessionDraft: {
            sourceKey: this.source as ClientSummarySourceKey,
            sessionId,
          },
        });
      }
      for (const e of this.entries.values()) {
        if (
          !e.timer &&
          (e.saved.discard ||
            e.saved.pending ||
            e.remote ||
            ((since === undefined || revisions.has(e.key)) &&
              e.saved.base?.revision !== (revisions.get(e.key) ?? null)) ||
            !draftPayloadEqual(
              payload(e.address, e.saved.raw),
              e.saved.base?.payload ?? EMPTY_DRAFT,
            ))
        )
          this.schedule(e, 0);
      }
    } catch {
      /* One source retry owner below retries when connected. */
    }
  }
  private async watch(): Promise<void> {
    if (this.stopped) return;
    try {
      if (
        document.visibilityState !== "hidden" &&
        this.transport.status.getSnapshot().state === "ready"
      ) {
        const next = await this.transport.fetch<{ sequence: number }>(
          `/drafts/changes?after=${this.sequence}`,
          { signal: this.abort.signal },
        );
        if (next.sequence !== this.sequence) {
          // Old/offline cursors may predate retained clears. Rebuild instead;
          // normal foreground/reconnect refreshes already use the full index.
          const since =
            this.sequence >= 0 && Date.now() - this.refreshedAt < 86_400_000
              ? this.sequence
              : undefined;
          await this.refresh(since);
        }
      }
    } catch {
      /* Offline is ordinary; no console loop. */
    }
    if (!this.stopped) this.retry = setTimeout(() => void this.watch(), 1000);
  }
  private wake = () => {
    void this.refresh();
  };
  private blur = () => {
    // The scheduled task runs after focus has moved, including navigation.
    for (const e of this.entries.values()) if (e.remote) this.schedule(e, 0);
  };
  /**
   * Every tab of this origin shares one browser storage, so a sibling tab's
   * write is the newest local value rather than a divergent replica: adopt
   * it, never merge it. Merging against this tab's older base and writing the
   * result back re-entered every sibling's handler, appending the whole draft
   * again on each keystroke until storage filled and the browser stalled.
   * Adoption never writes draft bodies or sync metadata, so no tab can echo
   * another's change. Session presence markers can be repaired separately.
   */
  private storage = (event: StorageEvent) => {
    if (!event.key) return;
    for (const e of this.entries.values()) {
      if (physical(e.key, e.address) === event.key) {
        if (e.saved.raw === event.newValue) return;
        const previousRaw = e.saved.raw;
        e.saved.raw = event.newValue;
        // The sibling's stored value supersedes a write this tab failed to store.
        if (e.error === "local") e.error = undefined;
        e.siblingEditAt = Date.now();
        this.reconcilePresence(e, previousRaw);
        notify(e.key);
        this.schedule(e, SIBLING_EDIT_MS);
        status();
        return;
      }
      if (this.metaKey(e.key) === event.key) {
        // Share the sibling's acknowledged base so a later server merge sees
        // the sibling's synced text as common ancestry, not a conflict.
        if (!event.newValue) return;
        try {
          const saved = JSON.parse(event.newValue) as Saved;
          if (saved.discardId && saved.discardId !== e.saved.discardId) {
            const previousRaw = e.saved.raw;
            e.saved = saved;
            e.remote = undefined;
            e.needsRecovery = false;
            e.error = undefined;
            this.reconcilePresence(e, previousRaw);
            notify(e.key);
            this.schedule(e, 0);
            status();
            return;
          }
          if (e.running) return;
          if (newerBase(saved.base, e.saved.base)) e.saved.base = saved.base;
          if (saved.discardId === e.saved.discardId && !saved.discard)
            e.saved.discard = undefined;
        } catch {}
        return;
      }
    }
  };
  start(): void {
    this.started = true;
    clients.set(this.source, this);
    installForegroundClaim();
    try {
      const keys = new Set(draftStorage.keys());
      const metaPrefix = `draft-sync-v1:${encodeURIComponent(this.source)}:${encodeURIComponent(this.owner)}:`;
      for (let i = 0; i < localStorage.length; i++) {
        const stored = localStorage.key(i);
        if (stored?.startsWith(metaPrefix))
          keys.add(decodeURIComponent(stored.slice(metaPrefix.length)));
      }
      for (const key of keys)
        if (draftAddress(key)?.source === this.source) {
          this.register(key);
          this.release(key);
        }
    } catch {
      /* Observed inputs remain usable in memory without browser storage. */
    }
    for (const key of listeners.keys())
      if (!key.endsWith("*") && draftAddress(key)?.source === this.source)
        this.register(key);
    this.unstatus = this.transport.status.subscribe(this.wake);
    window.addEventListener("focus", this.wake);
    document.addEventListener("visibilitychange", this.wake);
    window.addEventListener("storage", this.storage);
    document.addEventListener("focusout", this.blur);
    status();
    void this.refresh();
    void this.watch();
  }
  stop(): void {
    this.stopped = true;
    this.abort.abort();
    if (this.retry) clearTimeout(this.retry);
    for (const e of this.entries.values()) if (e.timer) clearTimeout(e.timer);
    this.entries.clear();
    this.unstatus?.();
    window.removeEventListener("focus", this.wake);
    document.removeEventListener("visibilitychange", this.wake);
    window.removeEventListener("storage", this.storage);
    document.removeEventListener("focusout", this.blur);
    if (clients.get(this.source) === this) clients.delete(this.source);
    status();
  }
}
export function setDraftAccount(source: string, owner: string): void {
  currentSource = source;
  const old = owners.get(source);
  owners.set(source, owner);
  try {
    localStorage.setItem(`draft-owner:${encodeURIComponent(source)}`, owner);
  } catch {}
  if (old !== owner) setSyncedDraftSessionIds(source, new Set());
  if (old !== owner)
    for (const key of listeners.keys())
      if (draftAddress(key)?.source === source) notify(key);
}
export function confirmSyncedDraft(key: string): void {
  const a = draftAddress(key);
  if (a) void clients.get(a.source)?.confirm(key);
}
export function resumeSyncedDraft(key: string): void {
  const a = draftAddress(key);
  if (a) clients.get(a.source)?.resume(key);
}

export const draftPayloadFromStorage = payload;
export const draftPayloadToStorage = encode;

// A development hot update replaces this module. A client of the old instance
// left running would keep syncing the same drafts in this tab beside the new
// one, with its own base and no storage events between them.
import.meta.hot?.dispose(() => {
  // Snapshot teardown owners: stop dispatches status events that can register clients.
  for (const client of [...clients.values()]) client.stop();
  uninstallForegroundClaim();
});
