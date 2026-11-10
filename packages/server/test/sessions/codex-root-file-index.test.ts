import { randomUUID } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  realpath,
  rename,
  rm,
  stat,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { nativeSessionRef, parseNativeSessionId } from "@yep-anywhere/shared";
import { CodexSessionReader } from "../../src/sessions/codex-reader.js";
import { codexRootFileIndex } from "../../src/sessions/codex-root-file-index.js";
import {
  codexSharedScanCache,
  type CodexSessionFile,
} from "../../src/sessions/codex-shared-scan-cache.js";

let root: string;
const readers: CodexSessionReader[] = [];

vi.mock("node:fs/promises", async (original) => {
  const fs = await original<typeof import("node:fs/promises")>();
  return { ...fs, stat: vi.fn(fs.stat) };
});

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "codex-root-index-")));
});

afterEach(async () => {
  vi.restoreAllMocks();
  vi.mocked(stat).mockReset();
  vi.mocked(stat).mockImplementation(
    (
      await vi.importActual<typeof import("node:fs/promises")>(
        "node:fs/promises",
      )
    ).stat,
  );
  await Promise.all(readers.splice(0).map((reader) => reader.close()));
  codexSharedScanCache.delete(root);
  await rm(root, { recursive: true, force: true });
});

function reader(projectPath: string) {
  const value = new CodexSessionReader({
    sessionsDir: root,
    projectPath,
    slowLogThresholdMs: 60_000,
  });
  readers.push(value);
  return value;
}

async function rollout(project: string, id = randomUUID(), day = "01") {
  const file = join(root, `rollout-2026-11-${day}T00-00-00-${id}.jsonl`);
  const timestamp = `2026-11-${day}T00:00:00.000Z`;
  await mkdir(root, { recursive: true });
  await writeFile(
    file,
    `${JSON.stringify({
      type: "session_meta",
      timestamp,
      payload: { id, cwd: project, timestamp },
    })}\n`,
  );
  return { id, file };
}

function barrier() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

function holdFirstHeadRead(value: CodexSessionReader) {
  const entered = barrier();
  const held = barrier();
  const internals = value as unknown as {
    readSessionMeta(path: string): Promise<CodexSessionFile | null>;
  };
  const read = internals.readSessionMeta.bind(value);
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

/** Count retained file locators, independent of the lookup field's name. */
function locatorSlots(owner: object) {
  return Object.values(owner).reduce((total: number, value: unknown) => {
    if (!(value instanceof Map)) return total;
    return (
      total +
      [...value.values()].filter(
        (entry) =>
          (typeof entry === "string" && entry.startsWith(root)) ||
          (entry && typeof entry.filePath === "string"),
      ).length
    );
  }, 0);
}

it("retains one store's locators as project readers return only their own rows", async () => {
  const projects = Array.from({ length: 6 }, (_, i) => join(root, `p${i}`));
  const files = await Promise.all(projects.map((project) => rollout(project)));
  const scoped = projects.map(reader);
  const lists = await Promise.all(
    scoped.map((value) => value.listSessionFiles(root)),
  );
  expect(lists.map((rows) => rows.map((row) => row.sessionId))).toEqual(
    files.map(({ id }) => [id]),
  );
  // This is the regression: a reader-count ceiling cannot bound the bytes of
  // complete store mirrors in each reader. Parsed transcripts stay unopened.
  expect(scoped.reduce((n, value) => n + locatorSlots(value), 0)).toBe(0);
  expect(locatorSlots(codexRootFileIndex(root))).toBe(files.length * 2);
});

it("keeps a newer exact observation when an older shared scan completes", async () => {
  const project = join(root, "project");
  const old = await rollout(project);
  const scanning = reader(project);
  const observing = reader(project);
  const hold = holdFirstHeadRead(scanning);
  const pending = scanning.listSessionFiles(root);
  try {
    await hold.entered;
    const newer = await rollout(project, old.id, "02");
    expect(
      await observing.observeNativeSessionFile(
        nativeSessionRef("codex", root, parseNativeSessionId(old.id)),
        newer.file,
      ),
    ).toBe(true);
    hold.release();
    await pending;
    expect(await scanning.getSessionFilePath(old.id)).toBe(newer.file);
    expect(await observing.getSessionFilePath(old.id)).toBe(newer.file);
  } finally {
    hold.release();
    await pending;
  }
});

it("fences old scan completion after a sibling invalidates and observes a replacement", async () => {
  const project = join(root, "project");
  const old = await rollout(project);
  const scanning = reader(project);
  const observing = reader(project);
  const hold = holdFirstHeadRead(scanning);
  const pending = scanning.listSessionFiles(root);
  try {
    await hold.entered;
    observing.invalidateCache();
    await rm(old.file);
    const newer = await rollout(project, old.id, "02");
    expect(
      await observing.observeNativeSessionFile(
        nativeSessionRef("codex", root, parseNativeSessionId(old.id)),
        newer.file,
      ),
    ).toBe(true);
    hold.release();
    expect(await pending).toEqual([
      { sessionId: old.id, filePath: newer.file },
    ]);
    expect(await scanning.getSessionFilePath(old.id)).toBe(newer.file);
    expect(await observing.getSessionFilePath(old.id)).toBe(newer.file);
  } finally {
    hold.release();
    await pending;
  }
});

it("lets a sibling finish a shared scan when its initiating project reader closes", async () => {
  const a = join(root, "a"),
    b = join(root, "b");
  await rollout(a);
  const own = await rollout(b);
  const first = reader(a),
    sibling = reader(b);
  const hold = holdFirstHeadRead(first);
  const pending = first.listSessionFiles(root);
  try {
    await hold.entered;
    const joined = sibling.listSessionFiles(root);
    await first.close();
    hold.release();
    expect(await joined).toEqual([{ sessionId: own.id, filePath: own.file }]);
    expect(await sibling.getSessionFilePath(own.id)).toBe(own.file);
    await pending;
  } finally {
    hold.release();
    await pending;
  }
});

it("does not treat a filtered enumeration as proof that cold sessions are absent", async () => {
  const project = join(root, "project");
  const cold = await rollout(project);
  const hot = await rollout(project);
  await utimes(cold.file, new Date(0), new Date(0));
  const value = reader(project);
  expect(
    await value.listSessionFiles(root, { activeAfterMs: Date.now() - 10_000 }),
  ).toEqual([{ sessionId: hot.id, filePath: hot.file }]);
  expect(await value.getSessionFilePath(cold.id)).toBe(cold.file);
  expect(
    (await value.listSessionFiles(root)).map((row) => row.sessionId).sort(),
  ).toEqual([cold.id, hot.id].sort());
});

it("retires deleted locators only after a complete unfiltered enumeration", async () => {
  const project = join(root, "project");
  const cold = await rollout(project);
  const hot = await rollout(project);
  await utimes(cold.file, new Date(0), new Date(0));
  const existing = reader(project);
  await existing.listSessionFiles(root);
  // A later filtered scan cannot erase the older session's valid locator.
  await existing.listSessionFiles(root, { activeAfterMs: Date.now() - 10_000 });
  expect(await existing.getSessionFilePath(cold.id)).toBe(cold.file);
  await rm(cold.file);
  const now = Date.now();
  vi.spyOn(Date, "now").mockReturnValue(now + 60_000);
  const fresh = reader(project);
  expect(await fresh.listSessionFiles(root)).toEqual([
    { sessionId: hot.id, filePath: hot.file },
  ]);
  expect(await fresh.getSessionFilePath(cold.id)).toBeNull();
  expect(await existing.getSessionFilePath(cold.id)).toBeNull();
});

it("uses an older surviving rollout when a full scan proves the newest file disappeared", async () => {
  const project = join(root, "project");
  const old = await rollout(project);
  const newest = await rollout(project, old.id, "02");
  const existing = reader(project);
  await existing.listSessionFiles(root);
  expect(await existing.getSessionFilePath(old.id)).toBe(newest.file);
  await rm(newest.file);
  const now = Date.now();
  vi.spyOn(Date, "now").mockReturnValue(now + 60_000);
  const fresh = reader(project);
  expect(await fresh.listSessionFiles(root)).toEqual([
    { sessionId: old.id, filePath: old.file },
  ]);
  expect(await existing.getSessionFilePath(old.id)).toBe(old.file);
});

it("rejects an older filtered scan after unfiltered deletion/fallback authority advances", async () => {
  const project = join(root, "project");
  const newest = await rollout(project, randomUUID(), "02");
  const current = reader(project);
  await current.listSessionFiles(root);
  const filtered = reader(project);
  const hold = holdFirstHeadRead(filtered);
  const pending = filtered.listSessionFiles(root, { activeAfterMs: 1 });
  try {
    await hold.entered;
    await rm(newest.file);
    const survivor = await rollout(project, newest.id, "01");
    const now = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(now + 60_000);
    expect(await current.listSessionFiles(root)).toEqual([
      { sessionId: newest.id, filePath: survivor.file },
    ]);
    hold.release();
    expect(await pending).toEqual([
      { sessionId: newest.id, filePath: survivor.file },
    ]);
    expect(await current.getSessionFilePath(newest.id)).toBe(survivor.file);
    expect(
      await current.observeNativeSessionFile(
        nativeSessionRef("codex", root, parseNativeSessionId(newest.id)),
        survivor.file,
      ),
    ).toBe(true);
    const genuinelyNew = await rollout(project, newest.id, "03");
    expect(
      await current.observeNativeSessionFile(
        nativeSessionRef("codex", root, parseNativeSessionId(newest.id)),
        genuinelyNew.file,
      ),
    ).toBe(true);
    expect(await filtered.getSessionFilePath(newest.id)).toBe(
      genuinelyNew.file,
    );
  } finally {
    hold.release();
    await pending;
  }
});

it("lets a newer full scan replace a deleted winner published by an older filtered scan", async () => {
  const project = join(root, "project");
  const newest = await rollout(project, randomUUID(), "02");
  const filtered = reader(project);
  const first = holdFirstHeadRead(filtered);
  const filteredRead = filtered.listSessionFiles(root, { activeAfterMs: 1 });
  await first.entered;
  await rm(newest.file);
  const survivor = await rollout(project, newest.id, "01");
  const full = reader(project);
  const second = holdFirstHeadRead(full);
  const fullRead = full.listSessionFiles(root);
  try {
    await second.entered;
    first.release();
    await filteredRead;
    second.release();
    expect(await fullRead).toEqual([
      { sessionId: newest.id, filePath: survivor.file },
    ]);
    expect(await full.getSessionFilePath(newest.id)).toBe(survivor.file);
    expect(await filtered.getSessionFilePath(newest.id)).toBe(survivor.file);
  } finally {
    first.release();
    second.release();
    await Promise.allSettled([filteredRead, fullRead]);
  }
});

it("does not promote a deleted incumbent when an exact point validates an older survivor", async () => {
  const project = join(root, "project");
  const survivor = await rollout(project);
  const newest = await rollout(project, survivor.id, "02");
  const value = reader(project);
  await value.listSessionFiles(root);
  await rm(newest.file);
  const now = Date.now();
  vi.spyOn(Date, "now").mockReturnValue(now + 60_000);
  const hold = holdFirstHeadRead(value);
  const pending = value.listSessionFiles(root);
  try {
    await hold.entered;
    expect(
      await reader(project).observeNativeSessionFile(
        nativeSessionRef("codex", root, parseNativeSessionId(survivor.id)),
        survivor.file,
      ),
    ).toBe(false);
    hold.release();
    expect(await pending).toEqual([
      { sessionId: survivor.id, filePath: survivor.file },
    ]);
    expect(await value.getSessionFilePath(survivor.id)).toBe(survivor.file);
  } finally {
    hold.release();
    await pending;
  }
});

it.each(["fresh", "cached"] as const)(
  "distinguishes %s filtered evidence of an unchanged winner during a full scan",
  async (evidence) => {
    const project = join(root, "project");
    const survivor = await rollout(project);
    const newest = await rollout(project, survivor.id, "02");
    const value = reader(project);
    await value.listSessionFiles(root);
    const filtered = reader(project);
    if (evidence === "cached")
      await filtered.listSessionFiles(root, { activeAfterMs: 1 });
    const hidden = join(root, "held-rollout");
    await rename(newest.file, hidden);
    // Expire only the full enumeration, preserving the filtered cache-hit
    // control without moving wall-clock time or rewriting native mtime.
    const scans = codexSharedScanCache.get(root)!;
    for (const entry of scans.values())
      if (entry.activeAfterMs === undefined) entry.timestamp = 0;
    const hold = holdFirstHeadRead(value);
    const pending = value.listSessionFiles(root);
    try {
      await hold.entered;
      if (evidence === "fresh") await rename(hidden, newest.file);
      await filtered.listSessionFiles(root, { activeAfterMs: 1 });
      hold.release();
      const winner = evidence === "fresh" ? newest.file : survivor.file;
      expect(await pending).toEqual([
        { sessionId: survivor.id, filePath: winner },
      ]);
      expect(await value.getSessionFilePath(survivor.id)).toBe(winner);
    } finally {
      hold.release();
      await pending;
    }
  },
);

it("retains a freshly enumerated fallback while a full scan proves its incumbent absent", async () => {
  const project = join(root, "project");
  const newest = await rollout(project, randomUUID(), "02");
  const other = await rollout(project);
  const value = reader(project);
  await value.listSessionFiles(root);
  await rm(newest.file);
  const now = Date.now();
  vi.spyOn(Date, "now").mockReturnValue(now + 60_000);
  const hold = holdFirstHeadRead(value);
  const pending = value.listSessionFiles(root);
  try {
    await hold.entered;
    const survivor = await rollout(project, newest.id, "01");
    const fresh = await reader(project).listSessionFiles(root, {
      activeAfterMs: 1,
    });
    expect(fresh.map((row) => row.sessionId).sort()).toEqual(
      [other.id, newest.id].sort(),
    );
    hold.release();
    expect((await pending).map((row) => row.sessionId).sort()).toEqual(
      [other.id, newest.id].sort(),
    );
    expect(await value.getSessionFilePath(newest.id)).toBe(survivor.file);
  } finally {
    hold.release();
    await pending;
  }
});

it("retains newer fallback proof when an older filtered scan displaces its winner", async () => {
  const project = join(root, "project");
  const newest = await rollout(project, randomUUID(), "02");
  const first = reader(project);
  const firstHold = holdFirstHeadRead(first);
  const firstRead = first.listSessionFiles(root, { activeAfterMs: 1 });
  await firstHold.entered;
  await rm(newest.file);
  const other = await rollout(project);
  const full = reader(project);
  const fullHold = holdFirstHeadRead(full);
  const fullRead = full.listSessionFiles(root);
  try {
    await fullHold.entered;
    const survivor = await rollout(project, newest.id, "01");
    await reader(project).listSessionFiles(root, { activeAfterMs: 2 });
    firstHold.release();
    await firstRead;
    fullHold.release();
    expect((await fullRead).map((row) => row.sessionId).sort()).toEqual(
      [other.id, newest.id].sort(),
    );
    expect(await full.getSessionFilePath(newest.id)).toBe(survivor.file);
  } finally {
    firstHold.release();
    fullHold.release();
    await Promise.allSettled([firstRead, fullRead]);
  }
});

it.each(["EACCES", "EIO"])(
  "does not publish failed root stat as authoritative absence (%s)",
  async (code) => {
    const project = join(root, "project");
    const own = await rollout(project);
    const value = reader(project);
    await value.listSessionFiles(root);
    const now = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(now + 60_000);
    vi.mocked(stat).mockRejectedValueOnce(
      Object.assign(new Error(code), { code }),
    );
    await expect(value.listSessionFiles(root)).rejects.toMatchObject({ code });
    expect(await value.getSessionFilePath(own.id)).toBe(own.file);
    expect(await reader(project).listSessionFiles(root)).toEqual([
      { sessionId: own.id, filePath: own.file },
    ]);
  },
);
