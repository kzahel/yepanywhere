import { randomUUID } from "node:crypto";
import {
  appendFile,
  mkdir,
  mkdtemp,
  open as openFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { toUrlProjectId } from "@yep-anywhere/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ownAntigravitySession } from "../../src/sdk/providers/antigravity-owners.js";
import {
  EMPTY_ANTIGRAVITY_LOG,
  setAntigravityLiveLimitsForTests,
} from "../../src/sdk/providers/antigravity-live-projection.js";
import { AntigravitySessionReader } from "../../src/sessions/antigravity-reader.js";
import { writeAntigravitySummaries } from "../utils/antigravity-store.js";
import {
  prepareConversation,
  selectConversation,
} from "../../src/experimental/conversation-projection.js";
import type { ConversationInput } from "../../src/experimental/conversation-projection.js";

/** The coverage v0 publishes for a source read. */
function publish(input: ConversationInput, compactions = 2) {
  const view = selectConversation(
    prepareConversation(input, compactions),
    { sessionId: input.sessionId, maxMessages: 100, anchorMessageId: null },
    { subscriptionId: "test", sequence: 0 },
  ).view;
  if (view.kind !== "conversation") throw Error(view.kind);
  return view.coverage;
}
import { createProviderConversationSource } from "../../src/experimental/provider-conversation-source.js";
import { ConversationSubscriptions } from "../../src/experimental/conversation-subscriptions.js";
import type { SessionCatalogRow } from "../../src/sessions/catalog-types.js";
import { CodexSessionReader } from "../../src/sessions/codex-reader.js";
import type { ISessionReader } from "../../src/sessions/types.js";
import { closeTestDiscoveryDatabases } from "../utils/session-metadata-database.js";

let dir: string;
beforeEach(async () => {
  dir = join(tmpdir(), `provider-conversation-source-${randomUUID()}`);
  await mkdir(dir, { recursive: true });
});
afterEach(async () => {
  closeTestDiscoveryDatabases();
  await rm(dir, { recursive: true, force: true });
});

// Past V8's maximum string length, so a whole-rollout read cannot succeed.
const UNREADABLE_HOLE_BYTES = 600 * 1024 * 1024;

it("opens a Codex conversation from its compact tail when the rollout is too large to read whole", async () => {
  const id = randomUUID();
  const ts = "2026-11-14T00:00:00.000Z";
  const path = join(dir, `rollout-${id}.jsonl`);
  const user = (message: string) => ({
    type: "event_msg",
    timestamp: ts,
    payload: { type: "user_message", message },
  });
  const head = [
    {
      type: "session_meta",
      timestamp: ts,
      payload: { id, cwd: "/test/project", timestamp: ts },
    },
    user("before compaction"),
  ];
  const tail = [
    { type: "compacted", timestamp: ts, payload: { message: "summary" } },
    user("after compaction"),
  ];
  const jsonl = (rows: unknown[]) =>
    Buffer.from(rows.map((row) => `${JSON.stringify(row)}\n`).join(""));
  const file = await openFile(path, "w");
  try {
    const headBytes = jsonl(head);
    const tailBytes = Buffer.concat([Buffer.from("\n"), jsonl(tail)]);
    await file.write(headBytes, 0, headBytes.length, 0);
    await file.write(
      tailBytes,
      0,
      tailBytes.length,
      headBytes.length + UNREADABLE_HOLE_BYTES,
    );
  } finally {
    await file.close();
  }

  const projectId = toUrlProjectId("/test/project");
  const reader = new CodexSessionReader({ sessionsDir: dir });
  // The index holds a summary already; a head read stands in for it.
  const summary = (sessionReader: ISessionReader) =>
    sessionReader.getSessionSummary(id, projectId, { readMode: "head" });
  const row: SessionCatalogRow = {
    sessionId: id,
    catalogFamily: "codex",
    storeKey: "test",
    projectId,
    projectPath: "/test/project",
    projectIdentityKey: "/test/project",
    updatedAt: ts,
    fidelity: "tail",
    sourceVersion: "1",
    location: { kind: "file", path },
    nativeStorageScope: dir,
  };
  const open = createProviderConversationSource({
    readerFactory: () => reader,
    resolve: async () => row,
    getProcess: () => undefined,
    sessionIndexService: {
      getCachedSessionSummary: async (_dir, _project, _id, r) => summary(r),
      getSessionSummaryWithCache: async (_dir, _project, _id, r) => summary(r),
    },
  });
  // Count bytes read through file handles, which is how the Codex reader
  // acquires rollout ranges.
  const prototype = Object.getPrototypeOf(file) as {
    read: (...args: unknown[]) => Promise<{ bytesRead: number }>;
  };
  const originalRead = prototype.read;
  let bytes = 0;
  const spy = vi.spyOn(prototype, "read").mockImplementation(async function (
    this: unknown,
    ...args: unknown[]
  ) {
    const result = await originalRead.apply(this, args);
    bytes += result.bytesRead;
    return result;
  });
  const abort = new AbortController();
  const source = await open(id, () => {}, abort.signal, 1);
  const input = await source.read(abort.signal).finally(() => {
    abort.abort();
    spy.mockRestore();
  });
  expect(bytes).toBeGreaterThan(0);
  expect(bytes).toBeLessThan(8 * 1024 * 1024);

  const texts = JSON.stringify(input.messages);
  expect(texts).toContain("after compaction");
  expect(texts).not.toContain("before compaction");
  expect(input.sourceCoverage.earlierOutsideScope).toBe("yes");
});

describe("an Antigravity conversation source", () => {
  const nativeId = "c0ffee00-0000-4000-8000-000000000198";
  const at = "2026-11-22T08:00:00Z";
  const record = (step: number, type: string, fields: object) =>
    `${JSON.stringify({
      step_index: step,
      source:
        type === "USER_INPUT"
          ? "USER_EXPLICIT"
          : type === "GENERIC" || type === "PLANNER_RESPONSE"
            ? "MODEL"
            : "SYSTEM",
      type,
      status: "DONE",
      created_at: at,
      ...fields,
    })}\n`;
  async function setup(log: string) {
    const project = await realpath(await mkdtemp(join(dir, "project-")));
    const store = join(dir, "antigravity-cli");
    const conversations = join(store, "conversations");
    const logs = join(store, "brain", nativeId, ".system_generated", "logs");
    await mkdir(logs, { recursive: true });
    await writeAntigravitySummaries(store, [{ id: nativeId, cwd: project }]);
    await writeFile(join(conversations, `${nativeId}.db`), "db");
    await writeFile(join(logs, "transcript_full.jsonl"), log);
    const scope = await realpath(conversations);
    const reader = new AntigravitySessionReader({
      projectPath: project,
      sessionsDir: scope,
    });
    const row: SessionCatalogRow = {
      sessionId: nativeId,
      catalogFamily: "antigravity",
      storeKey: "test",
      projectId: toUrlProjectId(project),
      projectPath: project,
      projectIdentityKey: project,
      updatedAt: at,
      fidelity: "tail",
      sourceVersion: "1",
      location: { kind: "file", path: join(scope, `${nativeId}.db`) },
      nativeStorageScope: scope,
    };
    return { reader, row, scope };
  }
  const prompt = record(0, "USER_INPUT", {
    content: "<USER_REQUEST>\nAsk\n</USER_REQUEST>",
  });

  type Row = {
    uuid: string;
    timestamp: string;
    type: string;
    message: { role: string; content: string };
  };
  const row = (uuid: string, role: string, content: string): Row => ({
    uuid,
    timestamp: at,
    type: role,
    message: { role, content },
  });
  /** A stand-in owner process whose events the test sends. */
  function owner(rows: Row[], state = "in-turn") {
    type Listener = (event: { type: string; message?: Row }) => void;
    const listeners = new Set<Listener>();
    return {
      emit: (type: string, message?: Row) => {
        if (type === "message" && message) rows.push(message);
        for (const listener of listeners) listener({ type, message });
      },
      process: {
        sessionId: nativeId,
        provider: "antigravity",
        state: { type: state },
        registerViewer: () => () => {},
        subscribe: (cb: Listener) => {
          listeners.add(cb);
          return () => listeners.delete(cb);
        },
        getMessageHistory: () => rows,
      },
    };
  }
  const shown = (messages: readonly { uuid?: string }[]) =>
    messages.map(
      (m) =>
        (m as { message?: { content?: unknown } }).message?.content ?? m.uuid,
    );

  it("shows what the log holds once an owner departs, dropping its rows the log lacks", async () => {
    const logged =
      prompt +
      record(1, "PLANNER_RESPONSE", {
        content: "Earlier: say yes tomorrow",
      });
    const { reader, row: source, scope } = await setup(logged);
    // An unlogged steer whose text an earlier reply contains, and a queued
    // prompt the log gains only later.
    const live = [
      row(`${nativeId}:0`, "user", "Ask"),
      row(`${nativeId}:1`, "assistant", "Earlier: say yes tomorrow"),
      row(`${nativeId}:2`, "user", "yes"),
      row(`${nativeId}:3`, "user", "QUEUED_PROMPT"),
    ];
    // A new session's owner: its log was empty when it opened.
    const native = ownAntigravitySession(scope, nativeId);
    native.open(EMPTY_ANTIGRAVITY_LOG);
    for (const message of live) native.record(message as never);
    let current: ReturnType<typeof owner> | undefined = owner(live);
    let changed: (() => void) | undefined;
    const open = createProviderConversationSource({
      readerFactory: () => reader,
      resolve: async () => source,
      getProcess: () => current?.process as never,
      watch: (_row, invalidate) => {
        changed = invalidate;
        return () => {};
      },
    });
    const abort = new AbortController();
    try {
      const view = await open(nativeId, () => {}, abort.signal);
      expect(shown((await view.read(abort.signal)).messages)).toEqual([
        "Ask",
        "Earlier: say yes tomorrow",
        "yes",
        "QUEUED_PROMPT",
      ]);
      // The owner ends mid-turn with no idle read between.
      native.release();
      current!.emit("terminated");
      current = undefined;
      expect(shown((await view.read(abort.signal)).messages)).toEqual([
        "Ask",
        "Earlier: say yes tomorrow",
      ]);
      // The log gains the queued prompt: it appears once.
      await appendFile(
        join(
          dir,
          "antigravity-cli",
          "brain",
          nativeId,
          ".system_generated",
          "logs",
          "transcript_full.jsonl",
        ),
        record(2, "USER_INPUT", {
          content: "<USER_REQUEST>\nQUEUED_PROMPT\n</USER_REQUEST>",
        }),
      );
      changed?.();
      expect(shown((await view.read(abort.signal)).messages)).toEqual([
        "Ask",
        "Earlier: say yes tomorrow",
        "QUEUED_PROMPT",
      ]);
      view.close();
    } finally {
      abort.abort();
      await reader.close();
    }
  });

  const logged = prompt + record(1, "PLANNER_RESPONSE", { content: "Reply" });
  /** The boundary `session/resume` records for `logged`. */
  const resumedAt = { step: 1, end: Buffer.byteLength(logged) };
  /** What `agy` appends for a turn that ends after the resume. */
  const nextTurn =
    record(2, "USER_INPUT", {
      content: "<USER_REQUEST>\nNext\n</USER_REQUEST>",
    }) + record(3, "PLANNER_RESPONSE", { content: "Reply 2" });
  const logPath = () =>
    join(
      dir,
      "antigravity-cli",
      "brain",
      nativeId,
      ".system_generated",
      "logs",
      "transcript_full.jsonl",
    );
  const coldIds = [`${nativeId}:step-0`, `${nativeId}:step-1:text`];

  /** An owner whose candidates the log proves at whatever `move` names. */
  function provingOwner(scope: string) {
    const native = ownAntigravitySession(scope, nativeId);
    let proven: typeof resumedAt | undefined;
    const live = native.open(resumedAt, async () => proven);
    const move = async (seq: number, boundary: typeof resumedAt) => {
      proven = boundary;
      live.addCandidate({ seq, size: 0, at: 0 });
      await new Promise((resolve) => setImmediate(resolve));
    };
    return { native, live, move };
  }

  // Review finding 4: a live message that arrives while a read is pending,
  // and leaves the owner's memory before the read returns, is the read's log
  // row by then. On the step 6 design this commit replaces, the source kept
  // it under its live ID beside that log row.
  it("never keeps a turn under both a live ID and a log ID when it leaves memory during a pending read", async () => {
    setAntigravityLiveLimitsForTests({ softRows: 2, splitAgeMs: 0 });
    const { reader, row: source, scope } = await setup(logged);
    const { native, live, move } = provingOwner(scope);
    const prompt2 = row("next-uuid", "user", "Next");
    native.record(prompt2 as never);
    const current = owner([prompt2]);
    const open = createProviderConversationSource({
      readerFactory: () => reader,
      resolve: async () => source,
      getProcess: () => current.process as never,
    });
    const abort = new AbortController();
    try {
      const view = await open(nativeId, () => {}, abort.signal);
      expect(uuids(await view.read(abort.signal))).toEqual([
        ...coldIds,
        "next-uuid",
      ]);
      current.process.state = { type: "idle" };
      current.emit("complete");
      const held = holdNextRead(reader);
      const reading = view.read(abort.signal);
      await held.entered;
      // During the read: the reply arrives, agy logs the turn, the next
      // prompt goes out, and the owner moves the turn into the log.
      const reply = row("reply-uuid", "assistant", "Reply 2");
      native.record(reply as never);
      current.emit("message", reply);
      await appendFile(logPath(), nextTurn);
      const prompt3 = row("third-uuid", "user", "Third");
      const seq = live.seq;
      native.record(prompt3 as never);
      current.emit("message", prompt3);
      await move(seq, { step: 3, end: Buffer.byteLength(logged + nextTurn) });
      expect(live.history().map((m) => m.uuid)).toEqual(["third-uuid"]);
      held.release();
      await reading;
      // This read, and the next, show the turn once, under its log IDs.
      current.emit("complete");
      for (const input of [await view.read(abort.signal)]) {
        expect(uuids(input)).toEqual([
          ...coldIds,
          `${nativeId}:step-2`,
          `${nativeId}:step-3:text`,
          "third-uuid",
        ]);
      }
      view.close();
    } finally {
      setAntigravityLiveLimitsForTests();
      native.release();
      abort.abort();
      await reader.close();
    }
  });

  // Review round 2 finding 7: Process echoes a direct input when it accepts
  // it, before the provider sees it. Retiring rows by timestamp dropped
  // such an echo when a move came while it was still queued.
  it("keeps a queued Process echo the owner never recorded across a move", async () => {
    setAntigravityLiveLimitsForTests({ softRows: 2, splitAgeMs: 0 });
    const { reader, row: source, scope } = await setup(logged);
    const { native, live, move } = provingOwner(scope);
    const prompt = row("p", "user", "Next");
    const reply = row("r", "assistant", "Reply 2");
    native.record(prompt as never);
    native.record(reply as never);
    const queued = row("queued", "user", "QUEUED_BUT_NOT_DISPATCHED");
    const current = owner([prompt, reply, queued]);
    const open = createProviderConversationSource({
      readerFactory: () => reader,
      resolve: async () => source,
      getProcess: () => current.process as never,
    });
    const abort = new AbortController();
    try {
      const view = await open(nativeId, () => {}, abort.signal);
      expect(uuids(await view.read(abort.signal))).toContain("queued");
      await appendFile(logPath(), nextTurn);
      const split = row("split", "user", "FIRST_QUEUED_PROMPT");
      const seq = live.seq;
      native.record(split as never);
      current.emit("message", split);
      await move(seq, { step: 3, end: Buffer.byteLength(logged + nextTurn) });
      current.process.state = { type: "idle" };
      current.emit("complete");
      expect(uuids(await view.read(abort.signal))).toEqual([
        ...coldIds,
        `${nativeId}:step-2`,
        `${nativeId}:step-3:text`,
        "split",
        // Not yet sent: it follows what the reader serves.
        "queued",
      ]);
      view.close();
    } finally {
      setAntigravityLiveLimitsForTests();
      native.release();
      abort.abort();
      await reader.close();
    }
  });

  it("joins a resumed owner's rows after the log's history, each once", async () => {
    const { reader, row: source, scope } = await setup(logged);
    const first = [
      row(`${nativeId}:0`, "user", "Ask"),
      row(`${nativeId}:1`, "assistant", "Reply"),
    ];
    const firstOwner = ownAntigravitySession(scope, nativeId);
    firstOwner.open(EMPTY_ANTIGRAVITY_LOG);
    for (const message of first) firstOwner.record(message as never);
    let current = owner(first);
    const open = createProviderConversationSource({
      readerFactory: () => reader,
      resolve: async () => source,
      getProcess: () => current.process as never,
    });
    const abort = new AbortController();
    try {
      const view = await open(nativeId, () => {}, abort.signal);
      expect(uuids(await view.read(abort.signal))).toEqual(
        first.map((m) => m.uuid),
      );
      // The first owner departs; a replacement resumes from the log, in turn.
      firstOwner.release();
      current.emit("terminated");
      const second = [row(`${nativeId}:r0`, "user", "Next")];
      const secondOwner = ownAntigravitySession(scope, nativeId);
      secondOwner.open(resumedAt);
      for (const message of second) secondOwner.record(message as never);
      current = owner(second);
      // The log gains the resumed turn's prompt; the owner's row serves it.
      await appendFile(logPath(), nextTurn);
      expect(uuids(await view.read(abort.signal))).toEqual([
        ...coldIds,
        `${nativeId}:r0`,
      ]);
      secondOwner.release();
      view.close();
    } finally {
      abort.abort();
      await reader.close();
    }
  });

  /** Holds the reader's next result, once read, until `release`. */
  function holdNextRead(reader: AntigravitySessionReader) {
    const original = reader.getSession.bind(reader);
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let armed = true;
    vi.spyOn(reader, "getSession").mockImplementation(async (...args) => {
      const result = await original(...args);
      if (armed) {
        armed = false;
        entered.resolve();
        await release.promise;
      }
      return result;
    });
    return { entered: entered.promise, release: () => release.resolve() };
  }
  const uuids = (input: { messages: readonly { uuid?: string }[] }) =>
    input.messages.map((m) => m.uuid);

  it("shows the prior turn once, before the new prompt, to an observer reading while the resumed owner starts", async () => {
    const { reader, row: source, scope } = await setup(logged);
    let current: ReturnType<typeof owner> | undefined;
    const open = createProviderConversationSource({
      readerFactory: () => reader,
      resolve: async () => source,
      getProcess: () => current?.process as never,
    });
    const abort = new AbortController();
    try {
      // One observer holds a stopped baseline in the log's IDs.
      const settled = await open(nativeId, () => {}, abort.signal);
      expect(uuids(await settled.read(abort.signal))).toEqual(coldIds);
      // The resumed process is registered and in turn, its prompt queued,
      // while its provider has only started: no native session is open.
      const prompt = row("prompt-uuid", "user", "Next");
      current = owner([prompt]);
      const starting = await open(nativeId, () => {}, abort.signal);
      expect(uuids(await starting.read(abort.signal))).toEqual([
        ...coldIds,
        "prompt-uuid",
      ]);
      // The owner opens at the log's last record; its prompt and the reply
      // it is still producing are live rows.
      const native = ownAntigravitySession(scope, nativeId);
      native.open(resumedAt);
      native.record(prompt as never);
      const reply = row("reply-uuid", "assistant", "Reply 2 (growing)");
      native.record(reply as never);
      // agy logs the prompt as soon as it is submitted.
      await appendFile(
        logPath(),
        record(2, "USER_INPUT", {
          content: "<USER_REQUEST>\nNext\n</USER_REQUEST>",
        }),
      );
      current.emit("message", reply);
      // A third observer's first read is held while the log moves on.
      const held = holdNextRead(reader);
      const late = await open(nativeId, () => {}, abort.signal);
      const reading = late.read(abort.signal);
      await held.entered;
      await appendFile(
        logPath(),
        record(3, "PLANNER_RESPONSE", { content: "Reply 2" }),
      );
      held.release();
      const expected = [...coldIds, "prompt-uuid", "reply-uuid"];
      const shownAs = ["Ask", "Reply", "Next", "Reply 2 (growing)"];
      // Each observer: the old reply belongs to the old prompt, once.
      for (const input of [
        await reading,
        await settled.read(abort.signal),
        await starting.read(abort.signal),
      ]) {
        expect(uuids(input), JSON.stringify(uuids(input))).toEqual(expected);
        expect(shown(input.messages)).toEqual(shownAs);
      }
      // Idle: every observer reads again and keeps the same rows.
      current.process.state = { type: "idle" };
      current.emit("complete");
      for (const view of [settled, starting, late])
        expect(uuids(await view.read(abort.signal))).toEqual(expected);
      native.release();
      for (const view of [settled, starting, late]) view.close();
    } finally {
      abort.abort();
      await reader.close();
    }
  });

  it("shows a departed owner's turns from the log once a resumed owner attaches during the read", async () => {
    const { reader, row: source, scope } = await setup(logged);
    const first = [
      row(`${nativeId}:0`, "user", "Ask"),
      row(`${nativeId}:1`, "assistant", "Reply"),
    ];
    const firstOwner = ownAntigravitySession(scope, nativeId);
    firstOwner.open(EMPTY_ANTIGRAVITY_LOG);
    for (const message of first) firstOwner.record(message as never);
    const a = owner(first);
    let current: ReturnType<typeof owner> | undefined = a;
    const open = createProviderConversationSource({
      readerFactory: () => reader,
      resolve: async () => source,
      getProcess: () => current?.process as never,
    });
    const abort = new AbortController();
    try {
      const views = [
        await open(nativeId, () => {}, abort.signal),
        await open(nativeId, () => {}, abort.signal),
      ];
      for (const view of views)
        expect(uuids(await view.read(abort.signal))).toEqual(
          first.map((m) => m.uuid),
        );
      // A departs; the cold read after it is in flight when B resumes.
      firstOwner.release();
      a.emit("terminated");
      current = undefined;
      const held = holdNextRead(reader);
      const reading = views[0]!.read(abort.signal);
      await held.entered;
      const second = [row(`${nativeId}:r0`, "user", "Next")];
      const secondOwner = ownAntigravitySession(scope, nativeId);
      secondOwner.open(resumedAt);
      for (const message of second) secondOwner.record(message as never);
      current = owner(second);
      held.release();
      const expected = [...coldIds, `${nativeId}:r0`];
      expect(uuids(await reading)).toEqual(expected);
      // Both observers agree, and stay so while B is in turn.
      for (const view of views)
        expect(uuids(await view.read(abort.signal))).toEqual(expected);
      secondOwner.release();
      for (const view of views) view.close();
    } finally {
      abort.abort();
      await reader.close();
    }
  });

  /** The text of every published message that mentions `marker`. */
  const mentioning = (
    messages: readonly { content?: unknown }[],
    marker: string,
  ) => messages.filter((m) => JSON.stringify(m.content).includes(marker));

  // Review round 1, finding 2.
  it("reports the history before a live owner's resume point as unavailable once its log is gone", async () => {
    const { reader, row: source, scope } = await setup(logged);
    const native = ownAntigravitySession(scope, nativeId);
    native.open(resumedAt);
    const next = row("next-uuid", "user", "Next");
    native.record(next as never);
    const open = createProviderConversationSource({
      readerFactory: () => reader,
      resolve: async () => source,
      getProcess: () => owner([next], "idle").process as never,
    });
    const abort = new AbortController();
    try {
      const view = await open(nativeId, () => {}, abort.signal);
      expect((await view.read(abort.signal)).sourceCoverage.complete).toBe(
        true,
      );
      view.close();
      await rm(logPath());
      const fresh = await open(nativeId, () => {}, abort.signal);
      const input = await fresh.read(abort.signal);
      // One row says the earlier history cannot be shown.
      expect(uuids(input)).toEqual([
        `${nativeId}:history-unavailable`,
        "next-uuid",
      ]);
      expect(input.sourceCoverage).toMatchObject({
        complete: false,
        earlierOutsideScope: "unknown",
      });
      expect(publish(input)).toMatchObject({
        completeForRequest: false,
        earlierOutsideScope: "unknown",
      });
      fresh.close();
    } finally {
      abort.abort();
      native.release();
      await reader.close();
    }
  });

  // Review round 1: a departure while a read is held. The direct source can
  // merge that cold read with the departed owner's rows; the termination
  // invalidates the read, so the publisher discards it and reads again.
  it("never publishes a cold read beside a known-log owner that departed during it", async () => {
    const { reader, row: source, scope } = await setup(logged);
    const native = ownAntigravitySession(scope, nativeId);
    native.open(resumedAt);
    const rows = [
      row("next-uuid", "user", "Next"),
      row("reply-uuid", "assistant", "Reply 2"),
    ];
    for (const message of rows) native.record(message as never);
    // In turn: its rows stay the observer's live rows, not its baseline.
    let current: ReturnType<typeof owner> | undefined = owner(rows);
    const direct = createProviderConversationSource({
      readerFactory: () => reader,
      resolve: async () => source,
      getProcess: () => current?.process as never,
    });
    // Every result the direct source returns, published or not.
    const reads: Array<{ message?: { content?: unknown } }[]> = [];
    const open: typeof direct = async (...args) => {
      const opened = await direct(...args);
      return {
        ...opened,
        read: async (signal) => {
          const input = await opened.read(signal);
          reads.push(input.messages as never);
          return input;
        },
      };
    };
    const published = new ConversationSubscriptions(open);
    const views: Array<{ messages?: { content?: unknown }[] }> = [];
    const unsubscribe = published.subscribe(
      { sessionId: nativeId, maxMessages: 100, anchorMessageId: null },
      "held",
      { send: (raw: string) => views.push(JSON.parse(raw).view), close() {} },
    );
    try {
      await vi.waitFor(() => expect(views.length).toBeGreaterThan(0));
      expect(mentioning(views.at(-1)!.messages!, "Reply 2")).toHaveLength(1);
      // The next read reaches the reader before the owner departs, and
      // reads the log after agy has logged the turn and the owner is gone.
      const entered = Promise.withResolvers<void>();
      const proceed = Promise.withResolvers<void>();
      const original = reader.getSession.bind(reader);
      vi.spyOn(reader, "getSession").mockImplementationOnce(async (...args) => {
        entered.resolve();
        await proceed.promise;
        return original(...args);
      });
      const departing = current;
      departing.process.state = { type: "idle" };
      departing.emit("state-change");
      await entered.promise;
      await appendFile(logPath(), nextTurn);
      native.release();
      current = undefined;
      departing.emit("terminated");
      proceed.resolve();
      await vi.waitFor(() =>
        expect(
          JSON.stringify(views.at(-1)?.messages ?? []).includes(":step-2"),
        ).toBe(true),
      );
      // The held read took the cold log after the owner went, so it drops
      // the departed owner's rows itself (plan 195 step 6): no result, even
      // one the publisher would have discarded, holds the turn twice.
      const replies = (input: { message?: { content?: unknown } }[]) =>
        input.filter((m) =>
          JSON.stringify(m.message?.content).includes("Reply 2"),
        ).length;
      expect(reads.length).toBeGreaterThan(1);
      for (const input of reads) expect(replies(input)).toBeLessThan(2);
      for (const view of views)
        expect(mentioning(view.messages ?? [], "Reply 2").length).toBeLessThan(
          2,
        );
      expect(mentioning(views.at(-1)!.messages!, "Reply 2")).toHaveLength(1);
    } finally {
      unsubscribe();
      published.close();
      await reader.close();
    }
  });

  it("reports a page cut by bytes as incomplete within the requested scope", async () => {
    const big = "r".repeat(2 * 1024 * 1024);
    const { reader, row } = await setup(
      prompt +
        record(1, "PLANNER_RESPONSE", {
          tool_calls: [0, 1, 2].map(() => ({ name: "read_file", args: {} })),
        }) +
        [2, 3, 4]
          .map((step) => record(step, "GENERIC", { content: big }))
          .join("") +
        record(5, "PLANNER_RESPONSE", { content: "Short final reply" }),
    );
    const open = createProviderConversationSource({
      readerFactory: () => reader,
      resolve: async () => row,
      getProcess: () => undefined,
    });
    const abort = new AbortController();
    try {
      const source = await open(nativeId, () => {}, abort.signal);
      const input = await source.read(abort.signal);
      expect(JSON.stringify(input.messages)).toContain("Short final reply");
      expect(JSON.stringify(input.messages)).not.toContain('"Ask"');
      expect(input.sourceCoverage).toMatchObject({
        complete: false,
        earlierInScope: true,
        earlierOutsideScope: "unknown",
      });
      expect(input.sourceCoverage.limitedBy).toContain("bytes");
      // Published: a byte limit with earlier history in scope, never a
      // compaction limit. (The reply's turn starts outside the view, which
      // the grouping reports as unavailable.)
      const published = publish(input);
      expect(published).toMatchObject({
        completeForRequest: false,
        earlierInScope: true,
        earlierOutsideScope: "unknown",
      });
      expect(published.limitedBy).toContain("bytes");
      expect(published.limitedBy).not.toContain("compactionScope");
      source.close();
    } finally {
      abort.abort();
      await reader.close();
    }
  });

  it("reports a page a checkpoint cut as limited by its compaction scope", async () => {
    const { reader, row } = await setup(
      prompt +
        record(1, "PLANNER_RESPONSE", { content: "Before" }) +
        record(2, "CHECKPOINT", { content: "Summary" }) +
        record(3, "PLANNER_RESPONSE", { content: "After" }),
    );
    const open = createProviderConversationSource({
      readerFactory: () => reader,
      resolve: async () => row,
      getProcess: () => undefined,
    });
    const abort = new AbortController();
    try {
      const source = await open(nativeId, () => {}, abort.signal, 1);
      const input = await source.read(abort.signal);
      expect(JSON.stringify(input.messages)).not.toContain("Before");
      const published = publish(input, 1);
      expect(published).toMatchObject({ earlierOutsideScope: "yes" });
      expect(published.limitedBy).toContain("compactionScope");
      expect(published.limitedBy).not.toContain("bytes");
      source.close();
    } finally {
      abort.abort();
      await reader.close();
    }
  });
});
