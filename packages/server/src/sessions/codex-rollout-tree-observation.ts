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
import { resolve } from "node:path";

/** Current observation epoch, or null while no healthy watcher covers the tree. */
export type CodexRolloutTreeEpoch = () => number | null;

const observers = new Map<string, CodexRolloutTreeEpoch>();

export function registerCodexRolloutTreeObserver(
  sessionsDir: string,
  epoch: CodexRolloutTreeEpoch,
): () => void {
  const key = resolve(sessionsDir);
  observers.set(key, epoch);
  return () => {
    if (observers.get(key) === epoch) observers.delete(key);
  };
}

export function getCodexRolloutTreeEpoch(sessionsDir: string): number | null {
  return observers.get(resolve(sessionsDir))?.() ?? null;
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
