import { realpath } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProjectScanner } from "../../src/projects/scanner.js";
import { prepareQueuedCompaction } from "../../src/routes/session-input-admission.js";
import {
  AntigravityLiveProjection,
  setAntigravityLiveLimitsForTests,
} from "../../src/sdk/providers/antigravity-live-projection.js";
import { antigravityOwnerView } from "../../src/sdk/providers/antigravity-owners.js";
import { AntigravityRuntime } from "../../src/sdk/providers/antigravity-runtime.js";
import { antigravitySessionWatcherSpec } from "../../src/sessions/antigravity-summaries.js";
import { antigravityFocusedFile } from "../../src/sessions/antigravity-writer-evidence.js";
import { ExternalSessionTracker } from "../../src/supervisor/ExternalSessionTracker.js";
import { createObservedSessionResolver } from "../../src/supervisor/observed-native-session.js";
import type { Supervisor } from "../../src/supervisor/Supervisor.js";
import { type BusEvent, EventBus } from "../../src/watcher/EventBus.js";
import { FileWatcher } from "../../src/watcher/FileWatcher.js";
import { FocusedSessionWatchManager } from "../../src/watcher/FocusedSessionWatchManager.js";
import { nativeFixture } from "./fixture.js";
import { providers } from "./selection.js";

const cleanups: Array<() => Promise<unknown> | unknown> = [];
afterEach(async () => {
  setAntigravityLiveLimitsForTests();
  vi.restoreAllMocks();
  while (cleanups.length) await cleanups.pop()!();
});

/** Longer than the provider-root watcher's debounce plus the tracker's batch. */
const handled = () => new Promise((resolve) => setTimeout(resolve, 1_500));

/**
 * A real `agy` owner, the production provider-root watcher on its store, a
 * focused watch a client opens, and an ExternalSessionTracker fed through
 * the production resolver, as app.ts wires them. Without a metadata service
 * a conversation's public ID is its native ID.
 */
async function owned() {
  const f = await nativeFixture("antigravity");
  cleanups.push(() => f.close());
  (await f.model.next()).finish("FIRST_DONE");
  await f.output("FIRST_DONE");
  await f.idle();
  const gemini = f.environment.GEMINI_HOME!;
  const scope = await realpath(
    join(gemini, "antigravity-cli", "conversations"),
  );
  const eventBus = new EventBus();
  const statuses: Array<[string, string]> = [];
  eventBus.subscribe((event: BusEvent) => {
    if (event.type === "session-status-changed")
      statuses.push([event.sessionId, event.ownership.owner]);
  });
  const { family: _family, ...spec } = antigravitySessionWatcherSpec(scope);
  const watcher = new FileWatcher({ ...spec, eventBus });
  watcher.start();
  cleanups.push(() => watcher.stop());

  let ownerLive = true;
  const scanner = {
    getOrCreateProject: async (id: string) => ({ id }),
  } as unknown as ProjectScanner;
  const focused = new FocusedSessionWatchManager({
    scanner,
    codexScanner: { getSessionsForProject: async () => [] },
    geminiScanner: { getSessionsForProject: async () => [] },
    resolveStoredSessionFile: async ({ sessionId }) =>
      antigravityFocusedFile(join(scope, `${sessionId}.db`)),
  });
  cleanups.push(() => focused.dispose());
  const tracker = new ExternalSessionTracker({
    eventBus,
    focusedChanges: focused,
    supervisor: {
      getProcessForSession: (id: string) =>
        ownerLive && id === f.nativeId() ? f.proc : undefined,
    } as unknown as Supervisor,
    scanner,
    resolveObservedSession: createObservedSessionResolver({
      scanner,
      readerFactory: () => {
        throw Error("Antigravity resolution needs no reader");
      },
      codexSessionsDir: join(f.root, "codex"),
      getCodexDiscoveryIndex: () => undefined,
    }),
  });
  cleanups.push(() => tracker.dispose());
  /** Another program: `agy` started by hand on the same store. */
  const outside = async () => {
    const runtime = new AntigravityRuntime();
    cleanups.push(() => runtime.close());
    await runtime.connect(f.executable, f.project, [
      "acp",
      "--gemini-dir",
      gemini,
      "--dangerously-skip-permissions",
    ]);
    const setup = { cwd: f.project, mcpServers: [] };
    return {
      runtime,
      resume: (sessionId: string) =>
        runtime.call("session/resume", { ...setup, sessionId }),
      create: async () =>
        (await runtime.call<{ sessionId: string }>("session/new", setup))
          .sessionId,
      async turn(sessionId: string, text: string) {
        const turn = runtime.call(
          "session/prompt",
          { sessionId, prompt: [{ type: "text", text }] },
          0,
        );
        (await f.model.next()).finish(`${text}_DONE`);
        await turn;
      },
    };
  };
  return {
    f,
    scope,
    tracker,
    statuses,
    outside,
    /** A client opens the conversation's page while YA does not own it. */
    open: () =>
      focused.subscribe(
        { sessionId: f.nativeId(), projectId: "p" as never },
        () => {},
      ),
    ownerStopped: async () => {
      await f.stop();
      ownerLive = false;
    },
  };
}

describe.skipIf(!providers.includes("antigravity"))(
  "native Antigravity external writer",
  () => {
    it("marks a stopped conversation external after another agy's turn, not after YA's own turns, compaction, wake, Stop, close or resume", async () => {
      const { f, tracker, statuses, outside, open, ownerStopped } =
        await owned();
      const id = f.nativeId();
      // A tool turn.
      expect(f.proc.queueMessage({ text: "TOOL_TURN" }).success).toBe(true);
      (await f.model.next()).tool("read_file", {
        Path: join(f.project, "notes.txt"),
      });
      (await f.model.next()).finish("TOOL_DONE");
      await f.output("TOOL_DONE");
      await f.idle();
      // A background command whose wake lands seconds after the turn.
      expect(f.proc.queueMessage({ text: "WAKE_TURN" }).success).toBe(true);
      (await f.model.next()).tool("run_command", {
        CommandLine: "sleep 4; echo WAKE_BG_DONE",
        WaitMsBeforeAsync: 100,
        toolSummary: "background",
      });
      (await f.model.next()).finish("WAKE_TURN_DONE");
      await f.output("WAKE_TURN_DONE");
      await f.idle();
      (await f.model.next()).finish("WAKE_REPLY");
      await f.output("WAKE_REPLY");
      // A queued compaction verified by its checkpoint.
      expect(f.proc.queueMessage({ text: "BEFORE_COMPACT" }).success).toBe(
        true,
      );
      const before = await f.model.next();
      const compact = {
        text: "/compact keep markers",
        tempId: "compact",
        queuedCompact: {
          command: "compact" as const,
          argument: "keep markers",
        },
      };
      expect(
        await prepareQueuedCompaction(f.proc, compact, "keep markers"),
      ).toBeUndefined();
      expect(f.proc.deferMessage(compact).success).toBe(true);
      before.finish("BEFORE_COMPACT_DONE");
      (await f.model.next()).finish(
        "<analysis>a</analysis><summary>WRITER_SUMMARY</summary>",
      );
      (await f.model.next()).finish("COMPACT_CONTINUE");
      expect(await f.commandResult).toMatchObject({ completion: "completed" });
      await f.idle();
      // A turn stopped while its reply streams, then quiet.
      expect(f.proc.queueMessage({ text: "STOP_TURN" }).success).toBe(true);
      const stopped = await f.model.next();
      stopped.partial("STOP_PART ");
      await f.output("STOP_PART");
      await f.proc.interrupt();
      await stopped.cancelled;
      await f.idle();
      await new Promise((resolve) => setTimeout(resolve, 3_000));
      // YA's owner closes (idle teardown and reload close it the same way),
      // and a client has the stopped conversation open.
      await ownerStopped();
      open();
      await handled();
      // YA's own resume (session/resume), a turn, and close.
      const source = await f.source();
      await f.restart({
        resumeSessionId: id,
        nativeResumeSource: source,
        initialMessage: { text: "RESUMED_TURN" },
      });
      (await f.model.next()).finish("RESUMED_DONE");
      await f.output("RESUMED_DONE");
      await f.idle();
      await ownerStopped();
      await handled();
      expect(statuses).toEqual([]);
      expect(tracker.isExternal(id)).toBe(false);

      // Another agy in another conversation of the same store.
      const other = await outside();
      const y = await other.create();
      await other.turn(y, "OTHER_CONVERSATION");
      await other.runtime.close();
      await handled();
      expect(tracker.isExternal(id)).toBe(false);
      // Then a turn in this one: the open page's watch sees its log grow.
      const second = await outside();
      await second.resume(id);
      await second.turn(id, "OUTSIDE_TURN");
      await vi.waitFor(() => expect(tracker.isExternal(id)).toBe(true), {
        timeout: 20_000,
      });
      expect(statuses).toContainEqual([id, "external"]);
    }, 120_000);

    it("drops the split candidates of a YA owner whose conversation another agy writes, and marks it external once YA stops", async () => {
      const foreign = vi.spyOn(
        AntigravityLiveProjection.prototype,
        "foreignWrite",
      );
      const { f, tracker, statuses, outside, ownerStopped } = await owned();
      const id = f.nativeId();
      const second = await outside();
      await second.resume(id);
      // YA's owner has been quiet for longer than its settle (agy sends a
      // title update about a second after a turn).
      await new Promise((resolve) => setTimeout(resolve, 5_000));
      await second.turn(id, "SECOND_WRITER");
      // The owner's own check at its next prompt sees the log grew while
      // it was idle, whatever the platform's watcher reported.
      expect(f.proc.queueMessage({ text: "OWNER_TURN" }).success).toBe(true);
      (await f.model.next()).finish("OWNER_DONE");
      await f.output("OWNER_DONE");
      await f.idle();
      expect(foreign).toHaveBeenCalled();
      expect(f.diagnostics).toContainEqual(
        expect.objectContaining({
          event: "antigravity_foreign_write_while_owned",
          sessionId: id,
        }),
      );
      // Ownership stays YA's while its process lives.
      await handled();
      expect(tracker.isExternal(id)).toBe(false);
      expect(statuses).toEqual([]);
      // Once YA stops, the other agy's next turn and close are another
      // program's writes.
      await ownerStopped();
      await handled();
      expect(tracker.isExternal(id)).toBe(false);
      await second.turn(id, "SECOND_AFTER_STOP");
      await second.runtime.close();
      await vi.waitFor(() => expect(tracker.isExternal(id)).toBe(true), {
        timeout: 20_000,
      });
    }, 120_000);

    // Review round 1: an idle agy closes its database about 30 s after its
    // last write (a checkpoint, no record). That is the owner's own write.
    it("keeps an idle owner's split candidate through its database close 30 s after a turn, and moves at it", async () => {
      setAntigravityLiveLimitsForTests({ splitAgeMs: 0 });
      const foreign = vi.spyOn(
        AntigravityLiveProjection.prototype,
        "foreignWrite",
      );
      const { f, scope, tracker, statuses } = await owned();
      const id = f.nativeId();
      const turn = async (text: string) => {
        expect(f.proc.queueMessage({ text }).success).toBe(true);
        (await f.model.next()).finish(`${text}_DONE`);
        await f.output(`${text}_DONE`);
        await f.idle();
      };
      await turn("BEFORE_IDLE");
      const view = () => {
        const owner = antigravityOwnerView(scope, id);
        return owner?.state === "open" ? owner : undefined;
      };
      const opened = view()!.boundary;
      // The window is full: the next prompt passes it.
      setAntigravityLiveLimitsForTests({
        softRows: view()!.history().length,
        splitAgeMs: 0,
      });
      await new Promise((resolve) => setTimeout(resolve, 36_000));
      await handled();
      const warned = () =>
        f.diagnostics.filter(
          (entry) => entry.event === "antigravity_foreign_write_while_owned",
        );
      expect(foreign).not.toHaveBeenCalled();
      expect(warned()).toEqual([]);
      expect(view()!.boundary).toEqual(opened);
      // The candidate BEFORE_IDLE's prompt took before the idle proves the
      // split once the next prompt passes the budget.
      await turn("AFTER_IDLE");
      await vi.waitFor(() => expect(view()!.boundary).not.toEqual(opened));
      const prose = view()!
        .history()
        .flatMap((row) =>
          row.type === "user" && typeof row.message?.content === "string"
            ? [row.message.content]
            : [],
        );
      expect(prose[0]).toBe("BEFORE_IDLE");
      expect(foreign).not.toHaveBeenCalled();
      expect(warned()).toEqual([]);
      expect(tracker.isExternal(id)).toBe(false);
      expect(statuses).toEqual([]);
    }, 120_000);
  },
);
