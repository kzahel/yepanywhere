import { randomUUID } from "node:crypto";
import { mkdir, open as openFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { toUrlProjectId } from "@yep-anywhere/shared";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
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
