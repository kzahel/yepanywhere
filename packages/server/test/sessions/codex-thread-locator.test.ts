import { randomUUID } from "node:crypto";
import * as zlib from "node:zlib";
import {
  mkdir,
  mkdtemp,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { nativeSessionRef, parseNativeSessionId } from "@yep-anywhere/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CodexSessionScanner } from "../../src/projects/codex-scanner.js";
import { CodexSessionReader } from "../../src/sessions/codex-reader.js";
import { codexRootFileIndex } from "../../src/sessions/codex-root-file-index.js";
import {
  codexSharedScanCache,
  type CodexSessionFile,
} from "../../src/sessions/codex-shared-scan-cache.js";
import { createCodexThreadChangeHints } from "../../src/sessions/codex-thread-index.js";
import { locateCodexThread } from "../../src/sessions/codex-thread-locator.js";
import { isZstdJsonlSupported } from "../../src/utils/jsonl.js";
import { codexStateDriver, createCodexHome } from "./codex-state-fixture.js";

const zstdCompressSync = (
  zlib as typeof zlib & { zstdCompressSync?: (buffer: Buffer) => Buffer }
).zstdCompressSync;
const canZstd =
  typeof zstdCompressSync === "function" && isZstdJsonlSupported();

const cleanup: (() => unknown)[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const step of cleanup.splice(0).reverse()) await step();
});

/**
 * A real Codex home in its own canonical root: the root index is
 * process-wide. `rawRoot` is the same directory as mkdtemp named it, which on
 * macOS is the `/var` alias of the `/private/var` path Codex records.
 */
async function codexHome(
  options: { schema?: string; database?: boolean } = {},
) {
  const rawParent = await mkdtemp(join(tmpdir(), "codex-thread-locator-"));
  const parent = await realpath(rawParent);
  const root = join(parent, "codex");
  cleanup.push(() => rm(parent, { recursive: true, force: true }));
  const home =
    options.database === false
      ? undefined
      : createCodexHome(root, options.schema);
  if (home) cleanup.push(() => home.close());
  const sessionsDir = join(root, "sessions");
  await mkdir(sessionsDir, { recursive: true });
  const forget = (dir: string) =>
    cleanup.push(() => codexSharedScanCache.delete(dir));
  forget(sessionsDir);
  return {
    parent,
    root,
    rawRoot: join(rawParent, "codex"),
    sessionsDir,
    row: (id: string, path: string) => home!.write(id, path),
    forget,
    reader(sessionsDirOverride = sessionsDir) {
      const reader = new CodexSessionReader({
        sessionsDir: sessionsDirOverride,
        slowLogThresholdMs: 60_000,
      });
      cleanup.push(() => reader.close());
      return reader;
    },
  };
}

interface RolloutOptions {
  id?: string;
  day?: string;
  /** The head's thread id when it differs from the filename's. */
  headId?: string;
  rolloutId?: string;
  parent?: string;
  cwd?: string;
  /** A first user turn after the head. */
  prompt?: string;
  representation?: "plain" | "zstd" | "both";
}

async function rollout(sessionsDir: string, options: RolloutOptions = {}) {
  const id = options.id ?? randomUUID();
  const day = options.day ?? "01";
  const timestamp = `2026-11-${day}T00:00:00.000Z`;
  const suffix = options.rolloutId ? `_${options.rolloutId}` : "";
  const dir = join(sessionsDir, "2026", "11", day);
  const path = join(
    dir,
    `rollout-2026-11-${day}T00-00-00-${id}${suffix}.jsonl`,
  );
  const head = `${JSON.stringify({
    type: "session_meta",
    timestamp,
    payload: {
      id: options.headId ?? id,
      cwd: options.cwd ?? "/synthetic/project",
      timestamp,
      ...(options.parent ? { parent_thread_id: options.parent } : {}),
    },
  })}\n${
    options.prompt
      ? `${JSON.stringify({
          type: "event_msg",
          timestamp,
          payload: { type: "user_message", message: options.prompt },
        })}\n`
      : ""
  }`;
  await mkdir(dir, { recursive: true });
  const representation = options.representation ?? "plain";
  if (representation !== "zstd") await writeFile(path, head);
  if (representation !== "plain")
    await writeFile(`${path}.zst`, zstdCompressSync!(Buffer.from(head)));
  return { id, path };
}

/** Unrelated history across date directories that a scan would have to read. */
async function unrelated(sessionsDir: string, count = 24) {
  for (let i = 0; i < count; i++)
    await rollout(sessionsDir, { day: String((i % 9) + 1).padStart(2, "0") });
}

type HeadReader = {
  readSessionMeta(path: string): Promise<CodexSessionFile | null>;
};

function countHeads(reader: CodexSessionReader) {
  return vi.spyOn(reader as unknown as HeadReader, "readSessionMeta");
}

function barrier() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

/** Hold this reader's first head read until the test releases it. */
function holdFirstHead(reader: CodexSessionReader) {
  const entered = barrier(),
    held = barrier();
  const internals = reader as unknown as HeadReader;
  const read = internals.readSessionMeta.bind(reader);
  vi.spyOn(internals, "readSessionMeta").mockImplementationOnce(
    async (path) => {
      const head = await read(path);
      entered.release();
      await held.promise;
      return head;
    },
  );
  return { entered: entered.promise, release: held.release };
}

describe.skipIf(!codexStateDriver)("Codex native thread locator", () => {
  it("resolves indexed threads on a cold root without enumerating it", async () => {
    const codex = await codexHome();
    await unrelated(codex.sessionsDir);
    const main = await rollout(codex.sessionsDir, {
      day: "05",
      prompt: "synthetic located prompt",
    });
    const child = await rollout(codex.sessionsDir, {
      day: "05",
      parent: main.id,
    });
    const scannerOnly = await rollout(codex.sessionsDir, { day: "06" });
    const childFirst = await rollout(codex.sessionsDir, {
      day: "07",
      parent: main.id,
    });
    for (const { id, path } of [main, child, scannerOnly, childFirst])
      codex.row(id, path);

    const reader = codex.reader();
    const heads = countHeads(reader);
    expect(await reader.getSessionFilePath(main.id)).toBe(main.path);
    const detail = await reader.getSession(
      main.id,
      "synthetic-project" as never,
    );
    // The located file is the transcript actually read, not just a path.
    expect(detail).not.toBeNull();
    expect(detail!.summary.id).toBe(main.id);
    expect(detail!.summary.title).toBe("synthetic located prompt");
    // The reader is root-wide and includes subagents (agent lookups use it).
    expect(await reader.getSessionFilePath(child.id)).toBe(child.path);
    // This is the regression: the old ladder enumerated every directory and
    // read every unrelated header before answering.
    expect(reader.getLastScanMetrics()).toBeNull();
    expect(heads.mock.calls.map(([path]) => path)).toEqual([
      main.path,
      child.path,
    ]);

    // The scanner shares the locator, keeps its non-subagent filter, and
    // reaches SQL itself for a thread no reader has located.
    const scanner = new CodexSessionScanner({ sessionsDir: codex.sessionsDir });
    expect(await scanner.getSessionProjectPath(scannerOnly.id)).toBe(
      "/synthetic/project",
    );
    expect(await scanner.getSessionProjectPath(main.id)).toBe(
      "/synthetic/project",
    );
    expect(await scanner.getSessionProjectPath(child.id)).toBeNull();
    expect(await scanner.getSessionProjectPath(childFirst.id)).toBeNull();
    expect(scanner.getLastScanMetrics()).toBeNull();
  });

  it.each([
    ["the macOS /var alias of the recorded root", false],
    ["a symlinked configured root", true],
  ])("maps canonical row paths back under %s", async (_label, viaSymlink) => {
    const codex = await codexHome();
    const { id, path } = await rollout(codex.sessionsDir);
    // Codex records canonical paths; YA was configured with an alias.
    codex.row(id, path);
    let root = codex.rawRoot;
    if (viaSymlink) {
      root = join(codex.parent, "alias");
      await symlink(codex.root, root);
    }
    const sessionsDir = join(root, "sessions");
    codex.forget(sessionsDir);
    const reader = codex.reader(sessionsDir);
    expect(await reader.getSessionFilePath(id)).toBe(
      join(sessionsDir, path.slice(codex.sessionsDir.length + 1)),
    );
    expect(reader.getLastScanMetrics()).toBeNull();
  });

  interface FallbackRows {
    target: string;
    /** The same filename thread whose head names another thread. */
    decoy: string;
    /** Another thread's real rollout. */
    other: string;
    root: string;
  }
  const fallbacks: [
    string,
    {
      schema?: string;
      database?: boolean;
      id?: string;
      row?: (rows: FallbackRows) => string;
    },
  ][] = [
    ["unavailable", { database: false }],
    ["unavailable", { schema: "CREATE TABLE threads (id TEXT PRIMARY KEY);" }],
    ["missing-row", {}],
    ["missing-file", { row: ({ target }) => `${target}.moved` }],
    ["mismatched-head", { row: ({ decoy }) => decoy }],
    ["mismatched-name", { row: ({ other }) => other }],
    [
      "archived",
      {
        row: ({ root }) =>
          join(root, "archived_sessions", "rollout-archived.jsonl"),
      },
    ],
    ["outside", { row: () => "/synthetic/elsewhere/rollout-outside.jsonl" }],
    ["unsupported-id", { id: "legacy-thread" }],
  ];

  it.each(fallbacks)(
    "falls back to enumeration when the row is %s",
    async (reason, options) => {
      const codex = await codexHome(options);
      const id = options.id ?? randomUUID();
      // The target's filename always carries a UUID; a legacy head id need not.
      const target = await rollout(codex.sessionsDir, {
        day: "03",
        ...(options.id ? { headId: id } : { id }),
      });
      // Rows are never pruned, and a stale one can name a reused filename.
      const decoy = await rollout(codex.sessionsDir, {
        day: "02",
        id: options.id ? randomUUID() : id,
        headId: randomUUID(),
      });
      const other = await rollout(codex.sessionsDir, { day: "04" });
      await unrelated(codex.sessionsDir, 4);
      if (options.row)
        codex.row(
          id,
          options.row({
            target: target.path,
            decoy: decoy.path,
            other: other.path,
            root: codex.root,
          }),
        );
      expect(
        await locateCodexThread({
          sessionsDir: codex.sessionsDir,
          threadId: id,
        }),
      ).toEqual({ kind: "fallback", reason });
      // SQL absence is never native absence: enumeration still answers.
      const reader = codex.reader();
      expect(await reader.getSessionFilePath(id)).toBe(target.path);
      expect(reader.getLastScanMetrics()?.directoriesVisited).toBeGreaterThan(
        1,
      );
    },
  );

  it.skipIf(!canZstd)(
    "serves the compressed representation and prefers plain when both exist",
    async () => {
      const codex = await codexHome();
      const zstd = await rollout(codex.sessionsDir, { representation: "zstd" });
      const both = await rollout(codex.sessionsDir, { representation: "both" });
      // Codex keeps naming the plain rollout after compressing it.
      codex.row(zstd.id, zstd.path);
      codex.row(both.id, both.path);
      const reader = codex.reader();
      expect(await reader.getSessionFilePath(zstd.id)).toBe(`${zstd.path}.zst`);
      expect(await reader.getSessionFilePath(both.id)).toBe(both.path);
      expect(reader.getLastScanMetrics()).toBeNull();
    },
  );

  it("lets a lagging row lose to a newer rollout, then converge on enumeration", async () => {
    const codex = await codexHome();
    const older = await rollout(codex.sessionsDir, { day: "01" });
    // A revert persists the replacement before swapping the row.
    const newer = await rollout(codex.sessionsDir, {
      id: older.id,
      day: "04",
      rolloutId: randomUUID(),
    });
    codex.row(older.id, older.path);

    // Cold: the row is the only point evidence, as upstream would resume it.
    const cold = codex.reader();
    expect(await cold.getSessionFilePath(older.id)).toBe(older.path);
    expect(cold.getLastScanMetrics()).toBeNull();
    await cold.listSessionFiles(codex.sessionsDir);
    expect(await cold.getSessionFilePath(older.id)).toBe(newer.path);

    // Warm race: a newer exact point lands while the row's head is read.
    codexSharedScanCache.delete(codex.sessionsDir);
    const locating = codex.reader();
    const hold = holdFirstHead(locating);
    const pending = locating.getSessionFilePath(older.id);
    await hold.entered;
    const native = nativeSessionRef(
      "codex",
      codex.sessionsDir,
      parseNativeSessionId(older.id),
    );
    expect(
      await codex.reader().observeNativeSessionFile(native, newer.path),
    ).toBe(true);
    hold.release();
    expect(await pending).toBe(newer.path);
    expect(locating.getLastScanMetrics()).toBeNull();

    // After the swap the row names the suffixed replacement rollout; its
    // filename thread id and head still prove it, so a cold root needs no scan.
    codexSharedScanCache.delete(codex.sessionsDir);
    codex.row(older.id, newer.path);
    const swapped = codex.reader();
    expect(await swapped.getSessionFilePath(older.id)).toBe(newer.path);
    expect(swapped.getLastScanMetrics()).toBeNull();
  });

  it.each(["invalidated", "re-enumerated"] as const)(
    "never publishes a row read under authority the root %s meanwhile",
    async (change) => {
      const codex = await codexHome();
      const { id, path } = await rollout(codex.sessionsDir);
      codex.row(id, path);
      const reader = codex.reader();
      const before = codexRootFileIndex(codex.sessionsDir);
      const hold = holdFirstHead(reader);
      const pending = reader.getSessionFilePath(id);
      await hold.entered;
      if (change === "invalidated") reader.invalidateCache();
      else await codex.reader().listSessionFiles(codex.sessionsDir);
      const authority = before.readVersion().authority;
      hold.release();
      expect(await pending).toBe(path);
      const after = codexRootFileIndex(codex.sessionsDir);
      if (change === "invalidated") {
        // The retired owner never learned the stale point; the retry did.
        expect(before.getSession(id)).toBeUndefined();
        expect(after).not.toBe(before);
        expect(reader.getLastScanMetrics()).toBeNull();
      } else {
        // The retry was answered by the completed enumeration's facts.
        expect(after).toBe(before);
        expect(after.readVersion().authority).toBe(authority);
      }
      expect(after.getSession(id)?.filePath).toBe(path);
    },
  );

  it("a reader closed before or during a lookup neither publishes nor scans", async () => {
    const codex = await codexHome();
    const during = await rollout(codex.sessionsDir);
    const before = await rollout(codex.sessionsDir);
    const unindexed = await rollout(codex.sessionsDir);
    codex.row(during.id, during.path);
    codex.row(before.id, before.path);
    const index = codexRootFileIndex(codex.sessionsDir);

    // Closed while the row's head is being read.
    const closing = codex.reader();
    const hold = holdFirstHead(closing);
    const pending = closing.getSessionFilePath(during.id);
    await hold.entered;
    await closing.close();
    hold.release();
    expect(await pending).toBeNull();

    // Already closed: an indexed row or a row-less thread alike.
    const closed = codex.reader();
    await closed.close();
    const heads = countHeads(closed);
    expect(await closed.getSessionFilePath(before.id)).toBeNull();
    expect(await closed.getSessionFilePath(unindexed.id)).toBeNull();
    expect(heads).not.toHaveBeenCalled();

    for (const reader of [closing, closed])
      expect(reader.getLastScanMetrics()).toBeNull();
    for (const { id } of [during, before, unindexed])
      expect(index.getSession(id)).toBeUndefined();
    // The shared root stays usable by live readers.
    expect(await codex.reader().getSessionFilePath(during.id)).toBe(
      during.path,
    );
  });

  it.each(["directory", "file"] as const)(
    "never serves a row whose path escapes the root through a symlinked %s",
    async (link) => {
      const codex = await codexHome();
      // A valid rollout of this thread, physically outside the store.
      const elsewhere = join(codex.parent, "elsewhere");
      const outside = await rollout(elsewhere);
      const name = outside.path.slice(elsewhere.length + 1);
      if (link === "directory")
        await symlink(join(elsewhere, "2026"), join(codex.sessionsDir, "2026"));
      else {
        await mkdir(join(codex.sessionsDir, "2026", "11", "01"), {
          recursive: true,
        });
        await symlink(outside.path, join(codex.sessionsDir, name));
      }
      const lexical = join(codex.sessionsDir, name);

      // The watcher's hints share the mapper: the row is skipped, neither
      // reported as a change nor treated as a foreign index.
      const hints = createCodexThreadChangeHints(codex.sessionsDir);
      expect(await hints.changedPaths()).toBeNull();
      codex.row(outside.id, lexical);
      expect(await hints.changedPaths()).toEqual([]);

      expect(
        await locateCodexThread({
          sessionsDir: codex.sessionsDir,
          threadId: outside.id,
        }),
      ).toEqual({ kind: "fallback", reason: "escaped" });
      // Enumeration follows neither symlink, so the answer is still absent.
      const reader = codex.reader();
      expect(await reader.getSessionFilePath(outside.id)).toBeNull();
      expect(reader.getLastScanMetrics()).not.toBeNull();
      expect(codexRootFileIndex(codex.sessionsDir).getSession(outside.id)).toBe(
        undefined,
      );
    },
  );
});
