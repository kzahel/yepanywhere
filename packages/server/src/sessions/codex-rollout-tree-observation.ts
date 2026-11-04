/**
 * Which Codex sessions trees a live native watcher currently covers.
 *
 * A cached enumeration of a covered tree stays current until the watcher
 * reports a rollout change, so the scanner and reader stop re-walking cold
 * history on a timer (topics/codex-metadata-scanner.md § Watcher-trusted
 * enumeration). An enumeration is trusted only under the observation epoch it
 * started in: changes made before the watcher began, or across a watcher
 * failure, were never reported to it.
 */
import { realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import type { FileChangeEvent } from "../watcher/EventBus.js";

/** Current observation epoch, or null while no healthy watcher covers the tree. */
export type CodexRolloutTreeEpoch = () => number | null;

interface Observer {
  primary: string;
  epoch: CodexRolloutTreeEpoch;
  aliases: Set<string>;
  canonical?: string;
  canonicalEpoch?: number | null;
}
const observers = new Map<string, Observer>();
const roots = new Map<
  string,
  { observer?: Observer; epoch: number | null; value: Promise<string> }
>();

export function registerCodexRolloutTreeObserver(
  sessionsDir: string,
  epoch: CodexRolloutTreeEpoch,
): () => void {
  const key = resolve(sessionsDir);
  const observer: Observer = { primary: key, epoch, aliases: new Set([key]) };
  observers.set(key, observer);
  return () => {
    for (const alias of observer.aliases) {
      if (observers.get(alias) === observer) observers.delete(alias);
      if (roots.get(alias)?.observer === observer) roots.delete(alias);
    }
  };
}

export function getCodexRolloutTreeEpoch(sessionsDir: string): number | null {
  const key = resolve(sessionsDir),
    observer = observers.get(key);
  if (!observer) return null;
  const epoch = observer.epoch();
  return key === observer.primary || observer.canonicalEpoch === epoch
    ? epoch
    : null;
}

/** No filesystem work: aliases are learned only from actual native events. */
export function observedCodexRoot(sessionsDir: string): string {
  const key = resolve(sessionsDir);
  return observers.get(key)?.canonical ?? key;
}

/** Resolve healthy watcher aliases on explicit acquisition, never at idle startup. */
export async function reconcileCodexRootObservation(
  sessionsDir: string,
): Promise<void> {
  const key = resolve(sessionsDir),
    direct = observers.get(key);
  if (direct) {
    if (key !== direct.primary && direct.canonicalEpoch !== direct.epoch())
      await canonicalRoot(direct.primary);
    return;
  }
  for (const observer of new Set(observers.values())) {
    if (
      observer.epoch() !== null &&
      (await canonicalRoot(observer.primary)) === key
    )
      return;
  }
}

async function canonicalRoot(root: string): Promise<string> {
  const key = resolve(root),
    observer = observers.get(key),
    epoch = observer?.epoch() ?? null;
  const previous = roots.get(key);
  if (previous && previous.observer === observer && previous.epoch === epoch)
    return previous.value;
  const entry = { observer, epoch, value: realpath(key) };
  roots.delete(key);
  roots.set(key, entry);
  while (roots.size > 16) roots.delete(roots.keys().next().value!);
  try {
    const physical = await entry.value;
    if (
      observer &&
      observers.get(key) === observer &&
      observer.epoch() === epoch &&
      (key === observer.primary ||
        (observer.canonicalEpoch === epoch &&
          observer.canonical === physical)) &&
      roots.get(key) === entry
    ) {
      if (observer.canonical !== physical) {
        for (const alias of observer.aliases)
          if (alias !== observer.primary && observers.get(alias) === observer)
            observers.delete(alias);
        observer.aliases = new Set([observer.primary, physical]);
        observer.canonical = physical;
      }
      observer.canonicalEpoch = epoch;
      observers.set(physical, observer);
    }
    return physical;
  } catch (error) {
    if (roots.get(key) === entry) roots.delete(key);
    throw error;
  }
}

/** Internal canonical address; preserve the original event's wire payload. */
export async function canonicalCodexChange(
  event: FileChangeEvent,
  expectedRoot?: string,
): Promise<{ scope: string; path: string } | null> {
  const root = event.nativeStorageScope ?? expectedRoot;
  if (!root) return null;
  const scope = await canonicalRoot(root);
  if (expectedRoot && scope !== (await canonicalRoot(expectedRoot)))
    return null;
  const outside = (suffix: string) =>
    !suffix ||
    suffix === ".." ||
    suffix.startsWith(`..${sep}`) ||
    isAbsolute(suffix);
  let suffix = relative(root, event.path);
  if (outside(suffix)) suffix = relative(scope, event.path);
  if (outside(suffix)) return null;
  return { scope, path: join(scope, suffix) };
}

/** Whether an enumeration that began under `epoch` is still current evidence. */
export function isCodexRolloutTreeEnumerationTrusted(
  sessionsDir: string,
  epoch: number | null | undefined,
): boolean {
  return (
    epoch !== null &&
    epoch !== undefined &&
    getCodexRolloutTreeEpoch(sessionsDir) === epoch
  );
}
