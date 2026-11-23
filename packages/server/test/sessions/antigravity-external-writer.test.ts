import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProjectScanner } from "../../src/projects/scanner.js";
import { AntigravityLiveProjection } from "../../src/sdk/providers/antigravity-live-projection.js";
import { ownAntigravitySession } from "../../src/sdk/providers/antigravity-owners.js";
import { ExternalSessionTracker } from "../../src/supervisor/ExternalSessionTracker.js";
import { createObservedSessionResolver } from "../../src/supervisor/observed-native-session.js";
import type { Supervisor } from "../../src/supervisor/Supervisor.js";
import {
  type BusEvent,
  EventBus,
  type FileChangeEvent,
} from "../../src/watcher/EventBus.js";
import type { FocusedSessionWatchEvent } from "../../src/watcher/FocusedSessionWatchManager.js";
import { writeAntigravitySummaries } from "../utils/antigravity-store.js";

const ID = "c0ffee00-0000-4000-8000-000000000701";
const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  vi.restoreAllMocks();
  while (cleanups.length) await cleanups.pop()!();
});

/**
 * A generated `agy` store with one listed conversation and a tracker fed
 * through the production Antigravity resolver, as app.ts wires it.
 */
async function harness() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "ya-agy-writer-")));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const store = join(root, "antigravity-cli");
  const scope = join(store, "conversations");
  await mkdir(scope, { recursive: true });
  await writeAntigravitySummaries(store, [
    { id: ID, cwd: join(root, "project") },
  ]);
  await writeFile(join(scope, `${ID}.db`), "database");
  const eventBus = new EventBus();
  const statuses: string[] = [];
  eventBus.subscribe((event: BusEvent) => {
    if (event.type === "session-status-changed" && event.sessionId === ID)
      statuses.push(event.ownership.owner);
  });
  let focused: ((event: FocusedSessionWatchEvent) => void) | undefined;
  const scanner = {
    getOrCreateProject: vi.fn(async (id: string) => ({ id })),
  } as unknown as ProjectScanner;
  const tracker = new ExternalSessionTracker({
    eventBus,
    supervisor: {
      getProcessForSession: () => undefined,
    } as unknown as Supervisor,
    scanner,
    focusedChanges: {
      observeChanges(observer) {
        focused = observer;
        return () => {
          focused = undefined;
        };
      },
    },
    resolveObservedSession: createObservedSessionResolver({
      scanner,
      readerFactory: () => {
        throw Error("Antigravity resolution needs no reader");
      },
      codexSessionsDir: join(root, "codex"),
      getCodexDiscoveryIndex: () => undefined,
    }),
  });
  cleanups.push(() => tracker.dispose());
  /** What the provider-root watcher reports for a file in the store. */
  const change = (
    name: string,
    facts: { size?: number; mtimeMs?: number; changeType?: string } = {},
  ) => {
    const path = join(scope, name);
    eventBus.emit({
      type: "file-change",
      provider: "antigravity",
      path,
      relativePath: relative(scope, path),
      nativeStorageScope: scope,
      changeType: (facts.changeType ?? "modify") as "modify",
      timestamp: new Date().toISOString(),
      fileType: name.startsWith(ID) ? "session" : "other",
      ...(facts.changeType === "delete"
        ? {}
        : { size: facts.size ?? 4096, mtimeMs: facts.mtimeMs ?? Date.now() }),
    } satisfies FileChangeEvent);
  };
  /** Lets the tracker's batches run. */
  const settle = () => new Promise((resolve) => setTimeout(resolve, 50));
  return {
    tracker,
    scope,
    store,
    statuses,
    change,
    settle,
    focused: (event: FocusedSessionWatchEvent) => focused!(event),
  };
}

describe("an Antigravity conversation written by another program", () => {
  it("is external after its database or a non-empty WAL changes, not after an open, a close or the summaries index", async () => {
    const h = await harness();
    // Any SQLite open adds an empty WAL and the shared memory; a writer
    // closing deletes them; every writer touches the summaries index.
    h.change(`${ID}.db-wal`, { size: 0, changeType: "create" });
    h.change(`${ID}.db-shm`, { size: 32_768, changeType: "create" });
    h.change(`${ID}.db-wal`, { changeType: "delete" });
    h.change("../conversation_summaries.db-wal", { size: 16_512 });
    await h.settle();
    expect(h.tracker.isExternal(ID)).toBe(false);

    h.change(`${ID}.db-wal`, { size: 98_408 });
    await vi.waitFor(() => expect(h.tracker.isExternal(ID)).toBe(true));
    expect(h.statuses).toEqual(["external"]);
  });

  it("is not external for YA's own agy: holding the conversation (idle close included) or before it let go", async () => {
    const h = await harness();
    const foreign = vi.spyOn(
      AntigravityLiveProjection.prototype,
      "foreignWrite",
    );
    const owner = ownAntigravitySession(h.scope, ID);
    cleanups.push(() => owner.release());
    // Attribution happens when the tracker handles an event, so each
    // phase is handled before the owner moves on.
    // Registered, not yet open (a resume under way).
    h.change(`${ID}.db-wal`, { size: 98_408 });
    await h.settle();
    owner.open({ step: -1, end: 0 });
    h.change(`${ID}.db-wal`, { size: 196_784 });
    await h.settle();
    // An idle agy closes its database about 30 s after its last write:
    // a checkpoint while the owner is open and quiet (review round 1).
    h.change(`${ID}.db`, { mtimeMs: Date.now() + 30_000 });
    await h.settle();
    // Its close: the checkpoint lands before release, the event after.
    const closedAt = Date.now();
    owner.release();
    h.change(`${ID}.db`, { mtimeMs: closedAt });
    await h.settle();
    expect(h.tracker.isExternal(ID)).toBe(false);
    expect(h.statuses).toEqual([]);
    // Another writer beside a live owner is the owner's own check to find.
    expect(foreign).not.toHaveBeenCalled();

    // A write after YA let go is another program's.
    h.change(`${ID}.db-wal`, { size: 98_408, mtimeMs: Date.now() + 1_000 });
    await vi.waitFor(() => expect(h.tracker.isExternal(ID)).toBe(true));
  });

  it("is external after its log grows while a client has it open", async () => {
    const h = await harness();
    const log = join(
      h.store,
      "brain",
      ID,
      ".system_generated",
      "logs",
      "transcript_full.jsonl",
    );
    h.focused({
      type: "session-watch-change",
      sessionId: ID,
      projectId: "p" as never,
      provider: "antigravity",
      path: log,
      source: "fs-watch",
      changeVersion: 1,
      sourceObservedAt: new Date().toISOString(),
      mtimeMs: Date.now(),
      size: 562,
      timestamp: new Date().toISOString(),
    });
    await vi.waitFor(() => expect(h.tracker.isExternal(ID)).toBe(true));
  });
});
