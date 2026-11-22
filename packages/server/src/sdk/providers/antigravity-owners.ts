import type { SDKMessage } from "../types.js";

// One entry per live preview owner; removed when its iterator closes. The preview
// stays in-process so readers never replay a database held by another owner.
interface NativeSessionOwner {
  history?: Map<string, SDKMessage>;
  bytes: number;
  /** A bounded history read, which a live session may wait out. */
  historyRead: boolean;
  released: Promise<void>;
}
const ownedNativeSessions = new Map<string, NativeSessionOwner>();
export function antigravityLiveHistory(
  scope: string,
  id: string,
): SDKMessage[] | undefined {
  const history = ownedNativeSessions.get(`${scope}\0${id}`)?.history;
  return history ? structuredClone([...history.values()]) : undefined;
}
export function antigravitySessionOwned(scope: string, id: string): boolean {
  return ownedNativeSessions.has(`${scope}\0${id}`);
}
/**
 * Own a native session for a live run, first waiting out any history read:
 * opening a cold session reads it while the user may already be sending.
 * Another live owner still refuses.
 */
export async function ownAntigravitySessionAfterReads(
  scope: string,
  id: string,
  signal: AbortSignal,
) {
  for (;;) {
    const current = ownedNativeSessions.get(`${scope}\0${id}`);
    if (!current?.historyRead) return ownAntigravitySession(scope, id);
    await new Promise<void>((resolve, reject) => {
      const abort = () =>
        reject(new Error("Antigravity session start aborted"));
      if (signal.aborted) return abort();
      signal.addEventListener("abort", abort, { once: true });
      void current.released.then(() => {
        signal.removeEventListener("abort", abort);
        resolve();
      });
    });
  }
}
export function ownAntigravitySession(
  scope: string,
  id: string,
  options: { historyRead?: boolean } = {},
) {
  const key = `${scope}\0${id}`;
  if (ownedNativeSessions.has(key))
    throw new Error("Antigravity session already has a local owner");
  let release!: () => void;
  const owner: NativeSessionOwner = {
    bytes: 0,
    historyRead: options.historyRead === true,
    released: new Promise<void>((resolve) => {
      release = resolve;
    }),
  };
  ownedNativeSessions.set(key, owner);
  return {
    release: () => {
      if (ownedNativeSessions.get(key) !== owner) return;
      ownedNativeSessions.delete(key);
      release();
    },
    record(message: SDKMessage) {
      if (!message.uuid)
        throw new Error("Antigravity projection requires a message ID");
      owner.history ??= new Map();
      const previous = owner.history.get(message.uuid);
      const bytes =
        owner.bytes +
        Buffer.byteLength(JSON.stringify(message), "utf8") -
        (previous ? Buffer.byteLength(JSON.stringify(previous), "utf8") : 0);
      if (
        bytes > 8 * 1024 * 1024 ||
        (!previous && owner.history.size >= 10_000)
      )
        throw new Error(
          "Antigravity live history exceeds the experimental history limit",
        );
      owner.bytes = bytes;
      owner.history.set(message.uuid, structuredClone(message));
    },
  };
}
