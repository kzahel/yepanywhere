import { randomUUID } from "node:crypto";
import {
  appendFile,
  mkdir,
  mkdtemp,
  realpath,
  rename,
  stat,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { ProjectScanner } from "../../src/projects/scanner.js";
import { RetainedSessionCollections } from "../../src/services/RetainedSessionCollections.js";
import { sameCodexArrival } from "../../src/sessions/catalog-adapters/codex-catalog-arrival.js";
import { createCollectionCatalogAdapters } from "../../src/sessions/catalog-adapters/collection-catalog-adapters.js";
import {
  codexSharedScanCache,
  observeCodexRolloutTree,
} from "../../src/sessions/codex-shared-scan-cache.js";
import { CodexSessionReader } from "../../src/sessions/codex-reader.js";
import { createCodexHome } from "./codex-state-fixture.js";
import { EventBus } from "../../src/watcher/EventBus.js";
import {
  closeTestDiscoveryDatabases,
  openTestDiscoveryDatabase,
} from "../utils/session-metadata-database.js";

it("matches cold discovery for new threads in a shared date directory and defers competing rollouts to discovery", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "codex-catalog-")));
  const sessionsDir = join(root, "sessions");
  const day = join(sessionsDir, "2026", "11", "27");
  const first = join(root, "first"),
    second = join(root, "second");
  const bus = new EventBus();
  const release = observeCodexRolloutTree({
    sessionsDir,
    eventBus: bus,
    epoch: () => 1,
  });
  const close: (() => Promise<void>)[] = [];
  async function write(cwd: string, minute: number, id = randomUUID()) {
    const timestamp = `2026-11-27T09:${String(minute).padStart(2, "0")}:00`;
    const file = join(
      day,
      `rollout-${timestamp.replaceAll(":", "-")}-${id}.jsonl`,
    );
    await writeFile(
      file,
      JSON.stringify({
        type: "session_meta",
        timestamp,
        payload: { id, cwd, timestamp },
      }) + "\n",
    );
    bus.emit({
      type: "file-change",
      path: file,
      relativePath: file,
      provider: "codex",
      fileType: "session",
      changeType: "create",
      timestamp,
    });
    return { id, file };
  }
  function changed(file: string) {
    bus.emit({
      type: "file-change",
      path: file,
      relativePath: file,
      provider: "codex",
      fileType: "session",
      changeType: "modify",
      timestamp: new Date().toISOString(),
    });
  }
  function owner(label: string) {
    const scanner = new ProjectScanner({
      projectsDir: join(root, "claude"),
      enableGemini: false,
      codexSessionsDir: sessionsDir,
      eventBus: bus,
    });
    const scan = vi.spyOn(scanner, "listFileCatalogProjects");
    const collections = new RetainedSessionCollections({
      dataDir: join(root, label),
      database: openTestDiscoveryDatabase(join(root, label)),
      eventBus: bus,
      adapters: createCollectionCatalogAdapters({
        scanner,
        codexSessionsDir: sessionsDir,
        readerFactory: () => {
          throw new Error("Unexpected provider");
        },
        getCatalogFamilies: () => ["codex"],
      }),
    });
    close.push(async () => {
      await collections.dispose();
      await scanner.dispose();
    });
    return { collections, scan };
  }
  try {
    await mkdir(day, { recursive: true });
    await write(first, 1);
    await write(second, 2);
    const { collections, scan } = owner("incremental");
    await collections.refresh();
    expect(scan).toHaveBeenCalledTimes(1);
    const a = await write(first, 3),
      b = await write(second, 4);
    await collections.refresh();
    const rows = async (owner: RetainedSessionCollections) =>
      [...(await owner.readPublishedRows()).rows].sort((a, b) =>
        a.sessionId.localeCompare(b.sessionId),
      );
    const partial = await rows(collections);
    expect(partial).toHaveLength(4);
    for (const [file, project] of [
      [a, first],
      [b, second],
    ] as const)
      expect(partial.find((row) => row.sessionId === file.id)).toMatchObject({
        projectPath: project,
        location: { kind: "file", path: file.file },
      });
    expect(scan).toHaveBeenCalledTimes(1);
    codexSharedScanCache.delete(sessionsDir);
    const cold = owner("cold").collections;
    await cold.refresh();
    expect(await rows(cold)).toEqual(partial);
    await close.pop()!();

    // Drop the root index as on a cold reader. The missing database and a
    // committed native row should each resolve without any tree enumeration.
    const scanTree = vi.spyOn(
      CodexSessionReader.prototype as unknown as {
        findJsonlFiles(dir: string): Promise<string[]>;
      },
      "findJsonlFiles",
    );
    for (const [index, mode] of [
      "indexless",
      "missing-row",
      "indexed",
    ].entries()) {
      codexSharedScanCache.delete(sessionsDir);
      const native = mode === "indexless" ? undefined : createCodexHome(root);
      try {
        const live = await write(second, 10 + index);
        if (mode === "indexed") native!.write(live.id, live.file);
        const pathLookup = CodexSessionReader.prototype.getSessionFilePath;
        const summary = CodexSessionReader.prototype.getSessionListSummary;
        const duringPath = vi
          .spyOn(CodexSessionReader.prototype, "getSessionFilePath")
          .mockImplementationOnce(async function (
            this: CodexSessionReader,
            id,
          ) {
            await appendFile(
              live.file,
              '{"type":"event_msg","payload":{"type":"task_started"}}\n',
            );
            return pathLookup.call(this, id);
          });
        const duringSummary = vi
          .spyOn(CodexSessionReader.prototype, "getSessionListSummary")
          .mockImplementationOnce(async function (
            this: CodexSessionReader,
            ...args
          ) {
            const result = await summary.apply(this, args);
            await appendFile(
              live.file,
              '{"type":"event_msg","payload":{"type":"task_complete"}}\n',
            );
            return result;
          });
        await collections.refresh();
        expect(
          (await rows(collections)).find((r) => r.sessionId === live.id),
        ).toMatchObject({
          projectPath: second,
          sourceVersion: expect.stringMatching(/^unsettled:/),
        });
        duringPath.mockRestore();
        duringSummary.mockRestore();
        changed(live.file);
        await collections.refresh();
        expect(
          (await rows(collections)).find((r) => r.sessionId === live.id)
            ?.sourceVersion,
        ).not.toMatch(/^unsettled:/);
        expect(scanTree).not.toHaveBeenCalled();
        expect(scan).toHaveBeenCalledTimes(1);
      } finally {
        native?.close();
        if (native) await rm(native.databasePath);
      }
    }
    codexSharedScanCache.delete(sessionsDir);
    const afterLive = owner("cold-after-append").collections;
    await afterLive.refresh();
    expect(await rows(collections)).toEqual(await rows(afterLive));
    await close.pop()!();

    const replacement = await write(second, 5, a.id);
    await collections.refresh();
    expect(scan).toHaveBeenCalledTimes(2);
    expect(
      (await rows(collections)).find((row) => row.sessionId === a.id),
    ).toMatchObject({
      projectPath: second,
      location: { kind: "file", path: replacement.file },
    });
    // A completely new logical thread with two physical candidates in one
    // watcher batch also needs the reader's native precedence election.
    const earlier = await write(second, 6);
    const later = await write(first, 7, earlier.id);
    await collections.refresh();
    expect(scan).toHaveBeenCalledTimes(3);
    expect(
      (await rows(collections)).find((row) => row.sessionId === earlier.id),
    ).toMatchObject({
      projectPath: first,
      location: { kind: "file", path: later.file },
    });

    const unknown = await write(join(root, "previously unseen"), 14);
    await collections.refresh();
    expect(scan).toHaveBeenCalledTimes(4);
    expect(
      (await rows(collections)).find((r) => r.sessionId === unknown.id)
        ?.projectPath,
    ).toBe(join(root, "previously unseen"));
    const child = await write(first, 15);
    await writeFile(
      child.file,
      JSON.stringify({
        type: "session_meta",
        payload: {
          id: child.id,
          cwd: first,
          source: { subagent: { thread_spawn: { parent_thread_id: a.id } } },
        },
      }) + "\n",
    );
    await collections.refresh();
    expect(scan).toHaveBeenCalledTimes(5);
    expect(
      (await rows(collections)).some((r) => r.sessionId === child.id),
    ).toBe(false);
    await rm(b.file);
    changed(b.file);
    await collections.refresh();
    expect((await rows(collections)).some((r) => r.sessionId === b.id)).toBe(
      false,
    );
    const returned = await write(first, 16, b.id);
    await collections.refresh();
    expect(scan).toHaveBeenCalledTimes(6);
    expect(
      (await rows(collections)).find((r) => r.sessionId === b.id),
    ).toMatchObject({
      projectPath: first,
      location: { kind: "file", path: returned.file },
    });
  } finally {
    vi.restoreAllMocks();
    release();
    for (const dispose of close.reverse()) await dispose();
    codexSharedScanCache.delete(sessionsDir);
    closeTestDiscoveryDatabases();
    await rm(root, { recursive: true, force: true });
  }
});

it("rejects same-inode growth with a different project and a replacement with the original header", async () => {
  const store = await realpath(
    await mkdtemp(join(tmpdir(), "codex-arrival-race-")),
  );
  const id = randomUUID(),
    file = join(store, "rollout-" + id + ".jsonl");
  const header = (cwd: string) =>
    JSON.stringify({ type: "session_meta", payload: { id, cwd } }) + "\n";
  try {
    await writeFile(file, header(store));
    const before = await stat(file);
    await writeFile(file, header(join(store, "other-project")));
    expect(await sameCodexArrival(before, store, file, id, store)).toBe(false);
    const replacement = file + ".tmp";
    await writeFile(replacement, header(store) + "\n");
    await rename(replacement, file);
    expect(await sameCodexArrival(before, store, file, id, store)).toBe(false);
  } finally {
    await rm(store, { recursive: true, force: true });
  }
});
