import {
  draftStorage,
  subscribeDraftStorage,
  DRAFT_STORAGE_EVENT,
  confirmSyncedDraft,
} from "./draftSyncStorage";
import { useCallback, useSyncExternalStore } from "react";
import { z } from "zod";

const recordSchema = z.object({
  draft: z.string(),
  dismissed: z.boolean(),
  seen: z.boolean(),
  answer: z.string().nullable(),
  quoted: z.boolean().optional(),
  edits: z.number().nonnegative(),
});
export type AsyncQuestionRecord = z.infer<typeof recordSchema>;
export const emptyQuestionRecord: AsyncQuestionRecord = {
  draft: "",
  dismissed: false,
  seen: false,
  answer: null,
  edits: 0,
};
type Records = Record<string, AsyncQuestionRecord>;
export function isQuestionAnswered(record: AsyncQuestionRecord | undefined) {
  return record?.answer != null || record?.quoted === true;
}
const stores = new Map<
  string,
  { records: Records; listeners: Set<() => void> }
>();
const reminderListeners = new Set<() => void>();
let revision = 0;
let subscriptions = 0;

export function questionStorageKey(sourceKey: string, sessionId: string) {
  return `yep-async-questions:${sourceKey}:${sessionId}`;
}

function parse(raw: string | null): AsyncQuestionRecord | undefined {
  if (!raw) return undefined;
  try {
    const result = recordSchema.safeParse(JSON.parse(raw));
    return result.success ? result.data : undefined;
  } catch {
    return undefined;
  }
}

function read(key: string): Records {
  const records: Records = {};
  try {
    for (const storedKey of draftStorage.keys()) {
      if (!storedKey?.startsWith(`${key}:`)) continue;
      const record = parse(draftStorage.getItem(storedKey));
      if (record) records[storedKey.slice(key.length + 1)] = record;
    }
  } catch {
    /* Browser storage may be unavailable. */
  }
  return records;
}

function store(key: string) {
  let value = stores.get(key);
  if (!value) {
    value = { records: read(key), listeners: new Set() };
    stores.set(key, value);
  }
  return value;
}

function publish(key: string, records: Records, reminders = true) {
  const value = store(key);
  value.records = records;
  for (const listener of value.listeners) listener();
  if (reminders) {
    revision++;
    for (const listener of reminderListeners) listener();
  }
}

function receive(event: StorageEvent) {
  if (event.key !== null && !event.key.startsWith("yep-async-questions:"))
    return;
  for (const key of stores.keys()) {
    if (event.key === null) publish(key, {});
    else if (event.key.startsWith(`${key}:`)) {
      const id = event.key.slice(key.length + 1);
      const records = { ...store(key).records };
      const next = parse(draftStorage.getItem(event.key));
      if (next)
        records[id] = {
          ...next,
          edits: Math.max(next.edits, records[id]?.edits ?? 0),
        };
      else delete records[id];
      publish(key, records);
    }
  }
}

function receiveDraft(event: Event) {
  const key = (event as CustomEvent<{ key: string }>).detail.key;
  for (const prefix of stores.keys())
    if (key === `${prefix}:*`) publish(prefix, read(prefix));
    else if (key.startsWith(`${prefix}:`)) {
      const id = key.slice(prefix.length + 1);
      const current = parse(draftStorage.getItem(key));
      const records = { ...store(prefix).records };
      if (current) records[id] = current;
      else delete records[id];
      publish(prefix, records);
    }
}
function subscribe(listeners: Set<() => void>, listener: () => void) {
  if (subscriptions++ === 0) {
    window.addEventListener("storage", receive);
    window.addEventListener(DRAFT_STORAGE_EVENT, receiveDraft);
  }
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    if (--subscriptions === 0) {
      window.removeEventListener("storage", receive);
      window.removeEventListener(DRAFT_STORAGE_EVENT, receiveDraft);
    }
  };
}

export function getQuestionRecords(key: string): Records {
  return store(key).records;
}

export function updateQuestionRecord(
  key: string,
  id: string,
  patch: Partial<AsyncQuestionRecord>,
): Records {
  const value = store(key);
  const previous = value.records[id] ?? emptyQuestionRecord;
  let current = previous;
  try {
    current = parse(draftStorage.getItem(`${key}:${id}`)) ?? current;
  } catch {
    /* Preserve this tab's state without browser storage. */
  }
  if (patch.answer != null && patch.draft === "")
    confirmSyncedDraft(`${key}:${id}`);
  const next = {
    ...current,
    ...patch,
    edits: Math.max(previous.edits, current.edits, patch.edits ?? 0),
  };
  try {
    draftStorage.setItem(`${key}:${id}`, JSON.stringify(next));
  } catch {
    /* Keep drafts and answers usable in memory. */
  }
  const records = { ...value.records, [id]: next };
  const reminders =
    previous.answer !== next.answer ||
    previous.quoted !== next.quoted ||
    previous.dismissed !== next.dismissed ||
    previous.seen !== next.seen ||
    previous.edits !== next.edits;
  publish(key, records, reminders);
  return records;
}

export function useQuestionRecords(key: string): Records {
  // A new subscribe function makes React resubscribe after every render, and
  // each wildcard draft subscription rereads the whole synced draft index.
  const subscribeRecords = useCallback(
    (listener: () => void) => {
      const unsubscribe = subscribe(store(key).listeners, listener);
      const unobserve = subscribeDraftStorage(`${key}:*`, () => {});
      return () => {
        unsubscribe();
        unobserve();
      };
    },
    [key],
  );
  return useSyncExternalStore(subscribeRecords, () => store(key).records);
}

const subscribeReminders = (listener: () => void) =>
  subscribe(reminderListeners, listener);
const getRevision = () => revision;
export function useQuestionReminderRevision() {
  return useSyncExternalStore(subscribeReminders, getRevision);
}
