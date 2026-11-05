import { createHash } from "node:crypto";
import type { Stats } from "node:fs";
import { constants } from "node:fs";
import { lstat, open, readdir, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import {
  nativeSessionRef,
  parseNativeSessionId,
  type NativeSessionRef,
  type ProviderChildSessionSummary,
  truncateSessionTitle,
} from "@yep-anywhere/shared";
import type { FileChangeEvent } from "../watcher/EventBus.js";
import type {
  ObservedProviderChild,
  ProviderChildSource,
} from "./ProviderChildRelationshipService.js";

const MAX_META_BYTES = 64 * 1024;
const MAX_ACTIVITY = 1024;
const READ_CONCURRENCY = 16;
const absent = (error: unknown) =>
  (error as NodeJS.ErrnoException).code === "ENOENT";
const inode = (s: Stats) => `${s.dev}:${s.ino}`;
const stamp = (s: Stats) => `${inode(s)}:${s.size}:${s.mtimeMs}:${s.ctimeMs}`;
interface VersionedPath {
  path: string;
  value: string | null;
  identityOnly?: boolean;
}

/** Strict structural acquisition. The tolerant transcript reader remains separate. */
export function createClaudeChildSource(options: {
  parent: NativeSessionRef;
  owner: object;
  roots: readonly string[];
  isRetired(): boolean;
  onRetire(listener: () => void): () => void;
}): ProviderChildSource {
  const { parent } = options;
  const childDir = join(parent.storageScope, parent.id, "subagents");
  const aliases = new Set<string>();
  const activity = new Map<string, string>();
  let generation = 0;
  let provedRoot: string | undefined;
  let accepted:
    | {
        version: string;
        generation: number;
        root: string;
        paths: VersionedPath[];
      }
    | undefined;
  const check = (signal?: AbortSignal) => {
    if (signal?.aborted || options.isRetired())
      throw new Error("Claude child source retired");
  };
  const eventChild = (event: FileChangeEvent) => {
    if (event.provider !== "claude") return;
    for (const dir of aliases) {
      // Native recursive watchers may report only the newly created parent
      // directory when its subagents and files arrive in the same burst.
      if (event.path === dir || event.path === dirname(dir))
        return { directory: true as const };
      const name = relative(dir, event.path);
      if (!name || name === ".." || name.includes(sep) || isAbsolute(name))
        continue;
      const match = /^agent-(.+)\.(jsonl|meta\.json)$/.exec(name);
      if (!match) continue;
      try {
        return {
          directory: false as const,
          id: parseNativeSessionId(match[1]),
          meta: match[2] === "meta.json",
          aliased: dir !== childDir,
        };
      } catch {
        return;
      }
    }
  };
  const rememberActivity = (id: string, mtimeMs: number | undefined) => {
    if (mtimeMs === undefined || !Number.isFinite(mtimeMs)) return;
    const previous = activity.get(id);
    if (previous && Date.parse(previous) >= mtimeMs) return;
    activity.delete(id);
    activity.set(id, new Date(mtimeMs).toISOString());
    if (activity.size > MAX_ACTIVITY) {
      let oldest: string | undefined;
      for (const [key, time] of activity)
        if (!oldest || time < activity.get(oldest)!) oldest = key;
      activity.delete(oldest!);
    }
  };
  const source: ProviderChildSource = {
    owner: options.owner,
    async ownsNativeScope() {
      for (const root of options.roots)
        if (
          (await realpath(root).catch(() => undefined)) === parent.storageScope
        )
          return true;
      return false;
    },
    isRetired: options.isRetired,
    onRetire: options.onRetire,
    releaseObservation() {
      accepted = undefined;
    },
    ownsFileChange: (event) => !!eventChild(event),
    async handleFileChange(event) {
      const child = eventChild(event);
      if (!child || options.isRetired()) return false;
      if (child.directory) {
        generation++;
        return true;
      }
      // Body growth is activity, not a structural source-version change. Native
      // file creation/deletion and metadata events reconcile the exact parent.
      if (child.meta || event.changeType !== "modify") {
        generation++;
        return true;
      }
      // A configured alias may have been rebound since observation. Proof is
      // event-driven and runs under the coordinator's shared concurrency cap.
      if (
        !provedRoot ||
        (child.aliased &&
          (await realpath(provedRoot).catch(() => undefined)) !==
            parent.storageScope) ||
        (await realpath(childDir).catch(() => undefined)) !== childDir
      )
        return false;
      const file = await lstat(join(childDir, `agent-${child.id}.jsonl`)).catch(
        () => undefined,
      );
      if (!options.isRetired() && file?.isFile())
        rememberActivity(child.id, file.mtimeMs);
      return false;
    },
    overlayActivity(children) {
      let changed = false;
      const next = children.map((child) => {
        const updatedAt = activity.get(child.id);
        if (!updatedAt || updatedAt === child.updatedAt) return child;
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
      aliases.clear();
      provedRoot = undefined;
      const parentDir = relative(
        parent.storageScope,
        join(parent.storageScope, parent.id),
      );
      if (parentDir !== parent.id || parentDir === "." || parentDir === "..")
        throw new Error("Invalid Claude parent directory");
      let root: string | undefined;
      for (const candidate of options.roots) {
        try {
          if ((await realpath(candidate)) === parent.storageScope) {
            root = candidate;
            break;
          }
        } catch (error) {
          if (!absent(error)) throw error;
        }
      }
      if (!root)
        throw new Error("Claude child source does not own the native scope");
      const startGeneration = generation;
      const parentPath = join(parent.storageScope, `${parent.id}.jsonl`);
      const parentStat = await lstat(parentPath);
      if (!parentStat.isFile())
        throw new Error("Claude native parent is not a regular file");
      const paths: VersionedPath[] = [
        { path: parentPath, value: inode(parentStat), identityOnly: true },
      ];
      let files: string[];
      try {
        const before = await lstat(childDir);
        if (!before.isDirectory() || (await realpath(childDir)) !== childDir)
          throw new Error(
            "Claude child directory is not the exact parent scope",
          );
        paths.push({ path: childDir, value: stamp(before) });
        files = await readdir(childDir);
      } catch (error) {
        if (!absent(error)) throw error;
        paths.push({ path: childDir, value: null });
        files = [];
      }
      provedRoot = root;
      aliases.add(childDir);
      aliases.add(join(root, parent.id, "subagents"));
      let partial = false;
      const names = files
        .filter((name) => /^agent-.+\.jsonl$/.test(name))
        .sort();
      const transcripts = new Set(names.map((name) => name.slice(6, -6)));
      if (
        files.some(
          (name) =>
            name.startsWith("agent-") &&
            name.endsWith(".meta.json") &&
            !transcripts.has(name.slice(6, -10)),
        )
      )
        partial = true;
      const children: ObservedProviderChild[] = [];
      let through = 0;
      await Promise.all(
        Array.from(
          { length: Math.min(READ_CONCURRENCY, names.length) },
          async () => {
            while (through < names.length) {
              const name = names[through++]!;
              check(signal);
              let id: ReturnType<typeof parseNativeSessionId>;
              try {
                id = parseNativeSessionId(name.slice(6, -6));
              } catch {
                partial = true;
                continue;
              }
              const file = join(childDir, name);
              let fileStat: Stats;
              try {
                fileStat = await lstat(file);
                if (!fileStat.isFile()) {
                  partial = true;
                  continue;
                }
              } catch {
                partial = true;
                continue;
              }
              paths.push({
                path: file,
                value: inode(fileStat),
                identityOnly: true,
              });
              const summary: ProviderChildSessionSummary = {
                id,
                parentSessionId: parent.id,
                updatedAt: fileStat.mtime.toISOString(),
              };
              const metaPath = file.slice(0, -6) + ".meta.json";
              let metadataAvailable = false;
              let handle: Awaited<ReturnType<typeof open>> | undefined;
              try {
                const link = await lstat(metaPath);
                if (!link.isFile() || link.size > MAX_META_BYTES)
                  throw new Error("Claude child metadata unavailable");
                handle = await open(
                  metaPath,
                  constants.O_RDONLY |
                    (process.platform === "win32"
                      ? 0
                      : constants.O_NOFOLLOW | constants.O_NONBLOCK),
                );
                const before = await handle.stat();
                if (stamp(before) !== stamp(link))
                  throw new Error("Claude child metadata changed");
                const bytes = Buffer.alloc(MAX_META_BYTES + 1);
                const { bytesRead } = await handle.read(
                  bytes,
                  0,
                  bytes.length,
                  0,
                );
                const after = await handle.stat();
                if (
                  bytesRead > MAX_META_BYTES ||
                  bytesRead !== after.size ||
                  stamp(before) !== stamp(after)
                )
                  throw new Error("Claude child metadata changed");
                paths.push({ path: metaPath, value: stamp(after) });
                const value: unknown = JSON.parse(
                  bytes.subarray(0, bytesRead).toString("utf8"),
                );
                if (!value || typeof value !== "object" || Array.isArray(value))
                  throw new Error("Invalid Claude child metadata");
                const meta = value as Record<string, unknown>;
                if (typeof meta.description === "string")
                  summary.title = truncateSessionTitle(meta.description);
                if (typeof meta.agentType === "string")
                  summary.agentType = meta.agentType.slice(0, 256);
                if (
                  typeof meta.toolUseId === "string" &&
                  meta.toolUseId.length <= 1024
                )
                  summary.toolUseId = meta.toolUseId;
                if (
                  typeof meta.spawnDepth === "number" &&
                  Number.isSafeInteger(meta.spawnDepth) &&
                  meta.spawnDepth >= 0
                )
                  summary.spawnDepth = meta.spawnDepth;
                metadataAvailable = true;
              } catch (error) {
                partial = true;
                if (absent(error)) paths.push({ path: metaPath, value: null });
              } finally {
                await handle?.close();
              }
              check(signal);
              children.push({
                native: nativeSessionRef("claude", childDir, id),
                summary,
                metadataAvailable,
              });
            }
          },
        ),
      );
      children.sort((a, b) => a.native.id.localeCompare(b.native.id));
      for (const child of [...children]
        .sort((a, b) => b.summary.updatedAt.localeCompare(a.summary.updatedAt))
        .slice(0, MAX_ACTIVITY)
        .reverse())
        rememberActivity(child.native.id, Date.parse(child.summary.updatedAt));
      const state = partial ? ("partial" as const) : ("complete" as const);
      const version = createHash("sha256")
        .update(
          JSON.stringify({
            state,
            children: children.map(
              ({
                native,
                summary: { updatedAt: _activity, ...summary },
                metadataAvailable,
              }) => ({ native, summary, metadataAvailable }),
            ),
          }),
        )
        .digest("hex");
      accepted = { version, generation: startGeneration, root, paths };
      check(signal);
      return { version, state, children };
    },
    async isCurrent(version) {
      const value = accepted;
      if (
        !value ||
        value.version !== version ||
        value.generation !== generation ||
        options.isRetired()
      )
        return false;
      if (
        (await realpath(value.root).catch(() => undefined)) !==
        parent.storageScope
      )
        return false;
      // Bounded stat concurrency, no transcript body reads or native allocation.
      let through = 0;
      let current = true;
      await Promise.all(
        Array.from(
          { length: Math.min(READ_CONCURRENCY, value.paths.length) },
          async () => {
            while (through < value.paths.length && current) {
              const p = value.paths[through++]!;
              try {
                const s = await lstat(p.path);
                if ((p.identityOnly ? inode(s) : stamp(s)) !== p.value)
                  current = false;
              } catch (error) {
                if (!(p.value === null && absent(error))) current = false;
              }
            }
          },
        ),
      );
      return current && generation === value.generation && !options.isRetired();
    },
  };
  source.refreshMetadata = source.observe;
  return source;
}
