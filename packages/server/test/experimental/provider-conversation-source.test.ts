import { randomUUID } from "node:crypto";
import {
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
import { ownAntigravitySession } from "../../src/sdk/providers/antigravity-runtime.js";
import { AntigravitySessionReader } from "../../src/sessions/antigravity-reader.js";
import { writeAntigravitySummaries } from "../utils/antigravity-store.js";
import { createProviderConversationSource } from "../../src/experimental/provider-conversation-source.js";
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

  it("replaces a departed owner's rows with the log, keeping text the log never got", async () => {
    const { reader, row, scope } = await setup(
      prompt + record(1, "PLANNER_RESPONSE", { content: "Logged reply" }),
    );
    const live = [
      {
        uuid: `${nativeId}:0`,
        timestamp: at,
        type: "user",
        message: { role: "user", content: "Ask" },
      },
      {
        uuid: `${nativeId}:1`,
        timestamp: at,
        type: "assistant",
        message: { role: "assistant", content: "Logged reply" },
      },
      {
        uuid: `${nativeId}:2`,
        timestamp: at,
        type: "assistant",
        message: { role: "assistant", content: "CUT_OFF_PARTIAL" },
      },
    ];
    const owner = ownAntigravitySession(scope, nativeId);
    for (const message of live) owner.record(message as never);
    let listener: ((event: { type: string }) => void) | undefined;
    let running:
      | {
          sessionId: string;
          provider: string;
          state: { type: string };
          registerViewer(): () => void;
          subscribe(cb: typeof listener): () => void;
          getMessageHistory(): typeof live;
        }
      | undefined = {
      sessionId: nativeId,
      provider: "antigravity",
      state: { type: "in-turn" },
      registerViewer: () => () => {},
      subscribe: (cb) => {
        listener = cb;
        return () => {};
      },
      getMessageHistory: () => live,
    };
    const open = createProviderConversationSource({
      readerFactory: () => reader,
      resolve: async () => row,
      getProcess: () => running as never,
    });
    const abort = new AbortController();
    try {
      const source = await open(nativeId, () => {}, abort.signal);
      const during = await source.read(abort.signal);
      expect(during.messages.map((m) => m.uuid)).toEqual(
        live.map((m) => m.uuid),
      );
      // The owner ends mid-turn with no idle read between.
      owner.release();
      running = undefined;
      listener?.({ type: "terminated" });
      const after = await source.read(abort.signal);
      expect(
        after.messages.map((m) => [
          m.uuid,
          (m as { message?: { content?: unknown } }).message?.content,
        ]),
      ).toEqual([
        [`${nativeId}:step-0`, "Ask"],
        [`${nativeId}:step-1:text`, "Logged reply"],
        [`${nativeId}:2`, "CUT_OFF_PARTIAL"],
      ]);
      source.close();
    } finally {
      abort.abort();
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
      source.close();
    } finally {
      abort.abort();
      await reader.close();
    }
  });
});
