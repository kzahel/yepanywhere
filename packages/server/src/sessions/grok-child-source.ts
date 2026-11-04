import { createHash } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { lstat, open, readdir, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, sep } from "node:path";
import {
  nativeSessionRef,
  parseNativeSessionId,
  truncateSessionTitle,
  type NativeSessionRef,
  type ProviderChildSessionSummary,
} from "@yep-anywhere/shared";
import { getProjectIdentityKey, isAbsolutePath } from "../projects/paths.js";
import type { FileChangeEvent } from "../watcher/EventBus.js";
import type {
  ObservedProviderChild,
  ProviderChildSource,
} from "./ProviderChildRelationshipService.js";

// Grok includes the entire delegated prompt in meta.json. It is never retained
// in the graph. Oversized native records remain unavailable, not empty proof.
const MAX_JSON_BYTES = 1024 * 1024;
const MAX_ACTIVITY = 1024;
const CONCURRENCY = 4;
const absent = (error: unknown) =>
  (error as NodeJS.ErrnoException).code === "ENOENT";
const stamp = (s: Stats) =>
  `${s.dev}:${s.ino}:${s.size}:${s.mtimeMs}:${s.ctimeMs}`;
const inode = (s: Stats) => `${s.dev}:${s.ino}`;
interface Proof {
  path: string;
  value: string | null;
  identityOnly?: boolean;
}

async function readJson(
  path: string,
  proofs: Proof[],
): Promise<Record<string, unknown>> {
  const before = await lstat(path);
  if (!before.isFile() || before.size > MAX_JSON_BYTES)
    throw new Error("Grok native metadata unavailable");
  const handle = await open(
    path,
    constants.O_RDONLY |
      (process.platform === "win32"
        ? 0
        : constants.O_NOFOLLOW | constants.O_NONBLOCK),
  );
  try {
    if (stamp(await handle.stat()) !== stamp(before))
      throw new Error("Grok native metadata changed");
    const buffer = Buffer.alloc(before.size + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const after = await handle.stat();
    if (stamp(before) !== stamp(after) || bytesRead !== before.size)
      throw new Error("Grok native metadata changed");
    const value: unknown = JSON.parse(
      buffer.subarray(0, bytesRead).toString("utf8"),
    );
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw new Error("Invalid Grok native metadata");
    proofs.push({ path, value: stamp(after) });
    return value as Record<string, unknown>;
  } finally {
    await handle.close();
  }
}

/** Qualified provider-owned sidecars, independent of tolerant transcript replay. */
export function createGrokChildSource(options: {
  owner: object;
  parent: NativeSessionRef;
  root: string;
  projectPath?: string;
  /** Existing reader locator only; native identity is independently re-proved. */
  knownParentPath(): string | undefined;
  isRetired(): boolean;
  onRetire(listener: () => void): () => void;
}): ProviderChildSource {
  const { parent } = options;
  let generation = 0;
  let parentDir: string | undefined;
  let aliases: readonly string[] = [];
  let accepted:
    | { version: string; generation: number; proofs: Proof[] }
    | undefined;
  const activity = new Map<string, { updatedAt: string; file?: string }>();
  const check = (signal?: AbortSignal) => {
    if (signal?.aborted || options.isRetired())
      throw new Error("Grok child source retired");
  };
  const remember = (id: string, updatedAt: string, file: string) => {
    const previous = activity.get(id)?.updatedAt;
    activity.set(id, {
      updatedAt: previous && previous > updatedAt ? previous : updatedAt,
      file,
    });
    if (activity.size > MAX_ACTIVITY) {
      let oldest: string | undefined;
      for (const [key, value] of activity)
        if (!oldest || value.updatedAt < activity.get(oldest)!.updatedAt)
          oldest = key;
      activity.delete(oldest!);
    }
  };
  const physicalPath = (path: string, rootHint?: string) => {
    for (const root of [
      parent.storageScope,
      options.root,
      ...(rootHint ? [rootHint] : []),
    ]) {
      const suffix = relative(root, path);
      if (
        suffix !== ".." &&
        !suffix.startsWith(`..${sep}`) &&
        !isAbsolute(suffix)
      )
        return join(parent.storageScope, suffix);
    }
    return undefined;
  };
  // This is only a lexical event candidate. Native proof is still required
  // before publication, including after a failed first header observation.
  try {
    const known = options.knownParentPath();
    const file = known
      ? physicalPath(known)
      : options.projectPath
        ? join(
            parent.storageScope,
            encodeURIComponent(options.projectPath),
            parent.id,
            "summary.json",
          )
        : undefined;
    if (file) {
      parentDir = dirname(file);
      aliases = [join(parentDir, "subagents")];
    }
  } catch {
    /* An unavailable locator still requires native observation. */
  }
  const eventKind = (event: FileChangeEvent) => {
    if (event.provider !== "grok") return undefined;
    const path = physicalPath(event.path, event.nativeStorageScope);
    if (!path || !parentDir) return undefined;
    if (
      path === parentDir ||
      path === join(parentDir, "summary.json") ||
      path === join(parentDir, "subagents")
    )
      return { kind: "structure" as const };
    for (const dir of aliases) {
      const suffix = relative(dir, path).split(sep);
      if (suffix.length === 1 && suffix[0] && suffix[0] !== "..")
        return { kind: "structure" as const };
      if (
        suffix.length === 2 &&
        suffix[0] !== ".." &&
        suffix[1] === "meta.json"
      )
        return { kind: "structure" as const };
    }
    const id = basename(dirname(path));
    if (activity.get(id)?.file === path)
      return { kind: "activity" as const, id, path };
    return undefined;
  };
  const readParent = async (file: string) => {
    const path = physicalPath(file);
    if (!path || (await realpath(file)) !== path)
      throw new Error("Grok parent escaped its physical namespace");
    const components = relative(parent.storageScope, path).split(sep);
    if (
      components.length !== 3 ||
      components[0] === ".." ||
      components[2] !== "summary.json"
    )
      throw new Error("Grok parent outside its native namespace");
    const proofs: Proof[] = [];
    const header = await readJson(path, proofs);
    const info =
      header.info &&
      typeof header.info === "object" &&
      !Array.isArray(header.info)
        ? (header.info as Record<string, unknown>)
        : {};
    const nativeId =
      typeof info.id === "string" && info.id ? info.id : components[1];
    const cwd = decodeURIComponent(components[0]!);
    if (!isAbsolutePath(cwd))
      throw new Error("Grok native project is not absolute");
    if (
      (typeof info.cwd === "string" &&
        getProjectIdentityKey(info.cwd) !== getProjectIdentityKey(cwd)) ||
      (options.projectPath &&
        getProjectIdentityKey(options.projectPath) !==
          getProjectIdentityKey(cwd))
    )
      throw new Error("Grok native parent project changed");
    return { path, proofs, cwd, nativeId };
  };
  const locateParent = async (signal: AbortSignal) => {
    const known = options.knownParentPath();
    if (known) {
      try {
        const candidate = await readParent(known);
        if (candidate.nativeId !== parent.id)
          throw new Error("Grok native parent identity changed");
        return candidate;
      } catch (error) {
        if (!absent(error)) throw error;
      }
    }
    if (options.projectPath) {
      try {
        const direct = await readParent(
          join(
            parent.storageScope,
            encodeURIComponent(options.projectPath),
            parent.id,
            "summary.json",
          ),
        );
        if (direct.nativeId === parent.id) return direct;
      } catch (error) {
        if (!absent(error)) throw error;
      }
    }
    // A native id normally names its directory. Older stores may use another
    // basename; reuse that format without treating the basename as an alias.
    // This finite, bounded-header fallback is off the request path and creates
    // no second locator cache or identity registry.
    const cwdDirs = await readdir(parent.storageScope, { withFileTypes: true });
    let found: Awaited<ReturnType<typeof readParent>> | undefined;
    for (const entry of cwdDirs) {
      check(signal);
      if (!entry.isDirectory()) continue;
      let cwd: string;
      try {
        cwd = decodeURIComponent(entry.name);
      } catch {
        continue;
      }
      if (
        options.projectPath &&
        getProjectIdentityKey(cwd) !==
          getProjectIdentityKey(options.projectPath)
      )
        continue;
      const project = join(parent.storageScope, entry.name);
      try {
        const direct = await readParent(
          join(project, parent.id, "summary.json"),
        );
        if (direct.nativeId === parent.id) return direct;
      } catch (error) {
        if (!absent(error)) throw error;
      }
      const names = await readdir(project, { withFileTypes: true });
      for (const dir of names) {
        check(signal);
        if (!dir.isDirectory() || dir.name === parent.id) continue;
        let candidate: Awaited<ReturnType<typeof readParent>>;
        try {
          candidate = await readParent(join(project, dir.name, "summary.json"));
        } catch {
          continue;
        }
        if (candidate.nativeId !== parent.id) continue;
        if (found) throw new Error("Ambiguous Grok native parent identity");
        found = candidate;
      }
    }
    if (!found) throw new Error("Grok native parent unavailable");
    return found;
  };
  return {
    owner: options.owner,
    isRetired: options.isRetired,
    onRetire: options.onRetire,
    ownsNativeScope: async () =>
      (await realpath(options.root).catch(() => undefined)) ===
      parent.storageScope,
    releaseObservation() {
      accepted = undefined;
    },
    ownsFileChange: (event) => !!eventKind(event),
    async handleFileChange(event) {
      const kind = eventKind(event);
      if (!kind || options.isRetired()) return false;
      if (
        event.nativeStorageScope &&
        (await realpath(event.nativeStorageScope).catch(() => undefined)) !==
          parent.storageScope
      )
        return false;
      if (kind.kind === "structure") {
        generation++;
        return true;
      }
      // Sidecars establish relationships. Creation or loss of an already-known
      // child's content changes availability, not its structural membership.
      if (event.changeType === "delete") return false;
      if (
        (await realpath(options.root).catch(() => undefined)) !==
          parent.storageScope ||
        (await realpath(dirname(kind.path)).catch(() => undefined)) !==
          dirname(kind.path)
      )
        return false;
      const stats = await lstat(kind.path).catch(() => undefined);
      if (stats?.isFile() && !options.isRetired())
        remember(kind.id, stats.mtime.toISOString(), kind.path);
      return false;
    },
    overlayActivity(children) {
      let changed = false;
      const next = children.map((child) => {
        const updatedAt = activity.get(child.id)?.updatedAt;
        if (!updatedAt || updatedAt <= child.updatedAt) return child;
        changed = true;
        return { ...child, updatedAt };
      });
      return changed
        ? next.sort(
            (a, b) =>
              b.updatedAt.localeCompare(a.updatedAt) ||
              a.id.localeCompare(b.id),
          )
        : children;
    },
    async observe(signal) {
      check(signal);
      const startGeneration = generation;
      if ((await realpath(options.root)) !== parent.storageScope)
        throw new Error("Grok child source does not own the native scope");
      const located = await locateParent(signal);
      check(signal);
      const selected = dirname(located.path);
      const { proofs, cwd } = located;
      const parentDirectory = await lstat(selected);
      if (
        !parentDirectory.isDirectory() ||
        (await realpath(selected)) !== selected
      )
        throw new Error("Grok native parent directory changed");
      proofs.push({
        path: selected,
        value: inode(parentDirectory),
        identityOnly: true,
      });
      const subagents = join(selected, "subagents");
      let entries: string[];
      try {
        const directory = await lstat(subagents);
        if (
          !directory.isDirectory() ||
          (await realpath(subagents)) !== subagents
        )
          throw new Error(
            "Grok subagents directory is not the exact parent scope",
          );
        proofs.push({ path: subagents, value: stamp(directory) });
        entries = (await readdir(subagents, { withFileTypes: true }))
          .filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
          .map((entry) => entry.name);
      } catch (error) {
        if (!absent(error)) throw error;
        proofs.push({ path: subagents, value: null });
        entries = [];
      }
      // Keep proved ownership during subsequent acquisition, so native events
      // cannot disappear merely because the next snapshot is being read.
      parentDir = selected;
      aliases = [subagents];
      let partial = false,
        through = 0;
      const children: ObservedProviderChild[] = [];
      await Promise.all(
        Array.from(
          { length: Math.min(CONCURRENCY, entries.length) },
          async () => {
            while (through < entries.length) {
              check(signal);
              const name = entries[through++]!;
              try {
                const id = parseNativeSessionId(name);
                if (name === "." || name === ".." || id === parent.id)
                  throw new Error("Invalid Grok child directory");
                const dir = join(subagents, name);
                const directory = await lstat(dir);
                if (!directory.isDirectory() || (await realpath(dir)) !== dir)
                  throw new Error("Grok child directory escaped native scope");
                proofs.push({
                  path: dir,
                  value: inode(directory),
                  identityOnly: true,
                });
                const meta = await readJson(join(dir, "meta.json"), proofs);
                if (
                  meta.subagent_id !== id ||
                  meta.child_session_id !== id ||
                  meta.parent_session_id !== parent.id
                )
                  throw new Error(
                    "Grok child does not prove its native parent",
                  );
                const timestamp = [meta.completed_at, meta.started_at].find(
                  (value) =>
                    typeof value === "string" &&
                    Number.isFinite(Date.parse(value)),
                );
                const summary: ProviderChildSessionSummary = {
                  id,
                  parentSessionId: parent.id,
                  updatedAt: timestamp
                    ? new Date(Date.parse(timestamp as string)).toISOString()
                    : new Date(0).toISOString(),
                };
                if (typeof meta.description === "string")
                  summary.title = truncateSessionTitle(meta.description);
                if (typeof meta.subagent_type === "string")
                  summary.agentType = meta.subagent_type.slice(0, 256);
                const childCwd =
                  typeof meta.child_cwd === "string" ? meta.child_cwd : cwd;
                let body: string | undefined;
                try {
                  if (isAbsolutePath(childCwd))
                    body = join(
                      parent.storageScope,
                      encodeURIComponent(childCwd),
                      id,
                      "updates.jsonl",
                    );
                } catch {
                  /* Invalid Unicode makes only the locator unavailable. */
                }
                if (!body) {
                  partial = true;
                  const previous = activity.get(id)?.updatedAt;
                  if (previous) {
                    activity.set(id, { updatedAt: previous });
                    if (previous > summary.updatedAt)
                      summary.updatedAt = previous;
                  }
                } else {
                  if (
                    (await realpath(dirname(body)).catch(() => undefined)) ===
                    dirname(body)
                  ) {
                    const stats = await lstat(body).catch(() => undefined);
                    if (stats?.isFile())
                      summary.updatedAt =
                        stats.mtime.toISOString() > summary.updatedAt
                          ? stats.mtime.toISOString()
                          : summary.updatedAt;
                  }
                  remember(id, summary.updatedAt, body);
                }
                children.push({
                  native: nativeSessionRef("grok", parent.storageScope, id),
                  summary,
                });
              } catch {
                partial = true;
              }
            }
          },
        ),
      );
      check(signal);
      children.sort((a, b) => a.native.id.localeCompare(b.native.id));
      const state = partial ? ("partial" as const) : ("complete" as const);
      const version = createHash("sha256")
        .update(
          JSON.stringify({
            state,
            children: children.map(
              ({ native, summary: { updatedAt: _activity, ...summary } }) => ({
                native,
                summary,
              }),
            ),
          }),
        )
        .digest("hex");
      accepted = { version, generation: startGeneration, proofs };
      return { version, state, children };
    },
    async isCurrent(version) {
      const value = accepted;
      if (
        !value ||
        value.version !== version ||
        value.generation !== generation ||
        options.isRetired() ||
        (await realpath(options.root).catch(() => undefined)) !==
          parent.storageScope
      )
        return false;
      let through = 0,
        current = true;
      await Promise.all(
        Array.from(
          { length: Math.min(CONCURRENCY, value.proofs.length) },
          async () => {
            while (current && through < value.proofs.length) {
              const p = value.proofs[through++]!;
              try {
                const stats = await lstat(p.path);
                if ((p.identityOnly ? inode(stats) : stamp(stats)) !== p.value)
                  current = false;
              } catch (error) {
                if (!(p.value === null && absent(error))) current = false;
              }
            }
          },
        ),
      );
      return current && value.generation === generation && !options.isRetired();
    },
  };
}
