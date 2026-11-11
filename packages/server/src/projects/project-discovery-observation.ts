import { readdir, stat } from "node:fs/promises";
import type { Stats } from "node:fs";
import type { ProviderObservationCallbacks } from "../watcher/ProviderSessionWatcherRegistry.js";

export type ProjectObservationEpoch = NonNullable<
  ProviderObservationCallbacks["getProviderObservationEpoch"]
>;
export interface ProjectDiscoveryScope {
  claude: string;
  codex: string | null;
  gemini: string | null;
  metadata: string | null;
  metadataRevision?: number;
}
interface RootObservation {
  family: "claude" | "codex" | "gemini";
  path: string;
  epoch: number | null;
  empty?: string;
  absent?: boolean;
  checkedAt: number;
}
/** At most three native roots; no session/file inventory and no timer. */
export interface ProjectDiscoveryObservation {
  roots: readonly RootObservation[];
  /** Only metadata registrations not represented by native file discovery; bounded by registrations. */
  registrations: ReadonlyMap<string, string>;
  metadataRevision: number;
}
const identity = (value: Stats) =>
  `${value.dev}:${value.ino}:${value.mtimeMs}:${value.ctimeMs}:${value.size}`;
const missing = (error: unknown) =>
  ["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "");

/** Capture before enumeration, never relabel an old inventory with a later epoch. */
export async function captureProjectObservation(
  scope: ProjectDiscoveryScope,
  epoch?: ProjectObservationEpoch,
): Promise<ProjectDiscoveryObservation> {
  const roots = await Promise.all(
    (["claude", "codex", "gemini"] as const).flatMap((family) => {
      const path = scope[family];
      return path
        ? [
            (async (): Promise<RootObservation> => {
              const root: RootObservation = {
                family,
                path,
                epoch: epoch?.(family, path) ?? null,
                checkedAt: Date.now(),
              };
              if (root.epoch !== null) return root;
              try {
                const before = await stat(path);
                if (
                  before.isDirectory() &&
                  (await readdir(path)).length === 0
                ) {
                  const after = await stat(path);
                  if (identity(before) === identity(after))
                    root.empty = identity(after);
                }
              } catch (error) {
                if (missing(error)) root.absent = true;
                else throw error;
              }
              return root;
            })(),
          ]
        : [];
    }),
  );
  return {
    roots,
    registrations: new Map(),
    metadataRevision: scope.metadataRevision ?? 0,
  };
}

export function projectObservationEpochsCurrent(
  proof: ProjectDiscoveryObservation,
  epoch?: ProjectObservationEpoch,
): boolean {
  return proof.roots.every(
    (root) => root.epoch === (epoch?.(root.family, root.path) ?? null),
  );
}

/** Unwatched nonempty roots keep the old complete-read TTL fallback. */
export async function projectObservationCurrent(
  proof: ProjectDiscoveryObservation,
  ttlMs: number,
  epoch?: ProjectObservationEpoch,
): Promise<"current" | "unobserved" | "changed"> {
  if (!projectObservationEpochsCurrent(proof, epoch)) return "changed";
  let unobserved = false;
  for (const root of proof.roots) {
    if (root.epoch !== null) continue;
    if (!root.absent && !root.empty) {
      unobserved = true;
      continue;
    }
    if (Date.now() - root.checkedAt < ttlMs) continue;
    try {
      const observed = await stat(root.path);
      if (root.absent || identity(observed) !== root.empty) return "changed";
    } catch (error) {
      if (!missing(error)) throw error;
      if (!root.absent) return "changed";
    }
    root.checkedAt = Date.now();
  }
  if (!projectObservationEpochsCurrent(proof, epoch)) return "changed";
  return unobserved ? "unobserved" : "current";
}
