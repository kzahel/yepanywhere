import { randomUUID } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  nativeSessionRef,
  parseNativeSessionId,
  parseYaSessionId,
  type ClaudeSessionEntry,
} from "@yep-anywhere/shared";
import { afterEach, expect, it, vi } from "vitest";
import { claudeCwdProjectDirectory } from "../../src/projects/claude-project-directory.js";
import { encodeProjectId } from "../../src/projects/paths.js";
import { NestedHarnessRelationshipService } from "../../src/sessions/NestedHarnessRelationshipService.js";
import { SessionIdentityStore } from "../../src/sessions/SessionIdentityStore.js";
import { SessionRelationshipWriter } from "../../src/sessions/SessionRelationshipWriter.js";
import { DiscoverySqliteService } from "../../src/storage/discovery-sqlite.js";
import { quoteShellWord } from "../../src/utils/posixShell.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.restoreAllMocks();
});
const turn = () => new Promise<void>((resolve) => setImmediate(resolve));
async function fixture(history = false) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "ya-harness-sql-")));
  const project = join(root, "project"),
    scope = join(root, "native", claudeCwdProjectDirectory(project));
  await mkdir(project);
  await mkdir(scope, { recursive: true });
  const db = new DiscoverySqliteService({
    dataDir: join(root, "profile"),
    probeNetworkFilesystem: () => undefined,
  });
  const sql = db.getDatabase(),
    identities = new SessionIdentityStore(sql),
    writer = new SessionRelationshipWriter(sql, "server");
  const sessionId = parseYaSessionId(randomUUID()),
    native = nativeSessionRef(
      "claude",
      scope,
      parseNativeSessionId(randomUUID()),
    );
  sql.transaction(() => {
    identities.allocateWithinTransaction({
      sessionId,
      provider: "claude",
      projectId: encodeProjectId(project),
      createdAt: new Date().toISOString(),
    });
    identities.bindWithinTransaction(sessionId, native);
  });
  const context = {
    id: "process-1",
    sessionId,
    projectPath: project,
    provider: "claude" as const,
    confined: false,
  };
  const errors: unknown[] = [],
    committed = vi.fn();
  const admission = {
    createdAt: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString(),
    deleted: false,
    copy: false,
    confined: false as boolean | undefined,
  };
  const admissionReads = vi.fn(() => admission);
  const services: NestedHarnessRelationshipService[] = [];
  const service = () => {
    const s = new NestedHarnessRelationshipService(
      sql,
      writer,
      identities,
      committed,
      (e) => errors.push(e),
      history ? admissionReads : undefined,
    );
    services.push(s);
    return s;
  };
  const first = service();
  cleanups.push(async () => {
    for (const s of services) await s.close();
    identities.close();
    writer.dispose();
    db.close();
    await rm(root, { recursive: true, force: true });
  });
  const resource = { kind: "native" as const, serverId: "server", native };
  const edges = () =>
    writer.index.list({ resource, type: "launched_harness", limit: 200 }).edges;
  const pending = () =>
    writer.index.checkpoint("nested-harness-pending-v1", sessionId);
  const observe = (
    s: NestedHarnessRelationshipService,
    id: string,
    target: string,
    directory = project,
  ) =>
    s.observeMessage(context, {
      type: "assistant",
      session_id: sessionId,
      message: {
        content: [
          {
            type: "tool_use",
            name: "Bash",
            id,
            input: {
              command: `cd ${quoteShellWord(directory)} && claude --session-id ${target} --print go`,
            },
          },
        ],
      },
    });
  const finish = (
    s: NestedHarnessRelationshipService,
    id: string,
    failed = false,
  ) =>
    s.observeMessage(context, {
      type: "user",
      session_id: sessionId,
      message: {
        content: [
          {
            type: "tool_result",
            tool_use_id: id,
            content: "private tool output",
            is_error: failed,
          },
        ],
      },
    });
  const header = (target: string, extra = {}) =>
    JSON.stringify({
      sessionId: target,
      cwd: project,
      isSidechain: false,
      ...extra,
    }) + "\n";
  return {
    root,
    project,
    scope,
    sql,
    writer,
    identities,
    context,
    errors,
    committed,
    first,
    service,
    observe,
    finish,
    header,
    edges,
    pending,
    admission,
    admissionReads,
  };
}

it("correlates immediate results, survives duplicate replay, and recovers a ready target with no Process after restart", async () => {
  const f = await fixture(),
    target = randomUUID();
  f.observe(f.first, "call-1", target);
  f.finish(f.first, "call-1");
  await vi.waitFor(() =>
    expect(JSON.parse(f.pending()!.cursor).hints[0].ready).toBe(true),
  );
  expect(f.edges()).toEqual([]);
  await f.first.close();
  await writeFile(join(f.scope, target + ".jsonl"), f.header(target));
  const recovered = f.service(); // Deliberately no registerProcess/observeMessage.
  await vi.waitFor(() => expect(f.edges()).toHaveLength(1));
  expect(f.pending()?.state).toBe("complete");
  expect(f.writer.index.evidence(f.edges()[0]!.id)).toEqual([
    expect.objectContaining({
      trust: "command-observed",
      metadata: { toolUseId: "call-1" },
    }),
  ]);
  f.observe(recovered, "call-1", target);
  f.finish(recovered, "call-1");
  await turn();
  await turn();
  expect(f.edges()).toHaveLength(1);
  expect(f.committed).toHaveBeenCalledTimes(1);
  expect(f.errors).toEqual([]);
});

it("withholds failed, replayed, sidechain, wrong-store and unproven targets while retaining later valid events", async () => {
  const f = await fixture(),
    bad = randomUUID(),
    good = randomUUID();
  await writeFile(join(f.scope, bad + ".jsonl"), f.header(bad));
  f.observe(f.first, "failed", bad);
  f.finish(f.first, "failed", true);
  // An inaccessible directory used to throw away the rest of this finite batch.
  f.observe(f.first, "missing", randomUUID(), join(f.project, "missing"));
  f.observe(f.first, "good", good);
  f.finish(f.first, "good");
  await writeFile(
    join(f.scope, good + ".jsonl"),
    f.header(good, { cwd: join(f.root, "foreign") }),
  );
  await vi.waitFor(() =>
    expect(JSON.parse(f.pending()!.cursor).hints).toEqual([
      expect.objectContaining({ id: "good", ready: true }),
    ]),
  );
  expect(f.edges()).toEqual([]);
  await vi.waitFor(() =>
    expect(JSON.parse(f.pending()!.cursor).hints[0].attempts).toBe(1),
  );
  await writeFile(
    join(f.scope, good + ".jsonl"),
    f.header(good, { isSidechain: true }),
  );
  f.first.observationReady("claude");
  await vi.waitFor(() =>
    expect(JSON.parse(f.pending()!.cursor).hints[0].attempts).toBe(2),
  );
  expect(f.edges()).toEqual([]);
  await writeFile(join(f.scope, good + ".jsonl"), f.header(good).trimEnd());
  f.first.observationReady("claude");
  await vi.waitFor(() => expect(f.pending()?.state).toBe("complete"));
  expect(f.edges()).toEqual([]);
  await writeFile(join(f.scope, good + ".jsonl"), f.header(good));
  f.observe(f.first, "new-good", good);
  f.finish(f.first, "new-good");
  await vi.waitFor(() => expect(f.edges()).toHaveLength(1));
  expect(f.errors).toHaveLength(1);
  expect(JSON.stringify(f.pending())).not.toContain("private tool output");
});

it("does not follow a target symlink and fences publication after close", async () => {
  const f = await fixture(),
    target = randomUUID(),
    external = join(f.root, "foreign.jsonl");
  await writeFile(external, f.header(target));
  await symlink(external, join(f.scope, target + ".jsonl"));
  f.observe(f.first, "call", target);
  f.finish(f.first, "call");
  await vi.waitFor(() =>
    expect(JSON.parse(f.pending()!.cursor).hints[0].ready).toBe(true),
  );
  await f.first.close();
  expect(f.edges()).toEqual([]);
  await rm(join(f.scope, target + ".jsonl"));
  await writeFile(join(f.scope, target + ".jsonl"), f.header(target));
  f.first.observationReady("claude");
  await turn();
  expect(f.edges()).toEqual([]);
  expect(f.errors).toEqual([]);
});

it("does not acquire copied replay, synthetic, sidechain, foreign-session or confined command evidence", async () => {
  const f = await fixture(),
    target = randomUUID();
  await writeFile(join(f.scope, target + ".jsonl"), f.header(target));
  const message = {
    type: "assistant",
    session_id: f.context.sessionId,
    message: {
      content: [
        {
          type: "tool_use" as const,
          name: "Bash",
          id: "copy",
          input: {
            command: `cd ${quoteShellWord(f.project)} && claude --session-id ${target} -p go`,
          },
        },
      ],
    },
  };
  for (const flags of [
    { isReplay: true },
    { isSynthetic: true },
    { parent_tool_use_id: "native-subagent" },
    { session_id: randomUUID() },
  ])
    f.first.observeMessage(f.context, { ...message, ...flags });
  f.first.observeMessage({ ...f.context, confined: true }, message);
  f.first.observeMessage(f.context, {
    ...message,
    message: {
      content: [
        {
          ...message.message.content[0]!,
          input: {
            ...message.message.content[0]!.input,
            run_in_background: true,
          },
        },
      ],
    },
  });
  f.finish(f.first, "copy");
  await f.first.close();
  expect(f.pending()).toBeNull();
  expect(f.edges()).toEqual([]);
  expect(f.errors).toEqual([]);
});

it("drains more than the retained-source ceiling in finite startup pages without starving later pending facts", async () => {
  const f = await fixture();
  await f.first.close();
  const target = randomUUID(),
    observedAt = new Date().toISOString();
  await writeFile(join(f.scope, target + ".jsonl"), f.header(target));
  const sources = Array.from({ length: 131 }, () => ({
    sessionId: parseYaSessionId(randomUUID()),
    native: nativeSessionRef(
      "claude",
      f.scope,
      parseNativeSessionId(randomUUID()),
    ),
  }));
  f.sql.transaction(() => {
    for (const source of sources) {
      f.identities.allocateWithinTransaction({
        sessionId: source.sessionId,
        provider: "claude",
        projectId: encodeProjectId(f.project),
        createdAt: observedAt,
      });
      f.identities.bindWithinTransaction(source.sessionId, source.native);
      f.writer.index.publishWithinTransaction({
        observation: {
          producer: "nested-harness-pending-v1",
          sourceKey: source.sessionId,
          sourceVersion: "1",
          extractorVersion: 1,
          observedAt,
        },
        expectedRevision: null,
        facts: [],
        progress: {
          state: "partial",
          cursor: JSON.stringify({
            v: 1,
            native: source.native,
            directory: f.project,
            hints: [{ id: "call", targetId: target, observedAt, ready: true }],
          }),
        },
      });
    }
  });
  f.service();
  await vi.waitFor(() => expect(f.committed).toHaveBeenCalledTimes(131));
  expect(f.writer.index.partialSources("nested-harness-pending-v1")).toEqual(
    [],
  );
  const edges = f.writer.index.list({
    resource: {
      kind: "native",
      serverId: "server",
      native: nativeSessionRef("claude", f.scope, parseNativeSessionId(target)),
    },
    direction: "incoming",
    type: "launched_harness",
    limit: 200,
  }).edges;
  expect(
    new Set(
      edges.map(
        (edge) => edge.source.kind === "native" && edge.source.native.id,
      ),
    ).size,
  ).toBe(131);
  expect(f.errors).toEqual([]);
});

it("abandons interrupted calls at real process end without exhausting later launches", async () => {
  const f = await fixture();
  for (let i = 0; i < 33; i++) {
    const context = { ...f.context, id: `ended-${i}` },
      target = randomUUID();
    f.first.observeMessage(context, {
      type: "assistant",
      session_id: context.sessionId,
      message: {
        content: [
          {
            type: "tool_use",
            id: `call-${i}`,
            name: "Bash",
            input: {
              command: `cd ${quoteShellWord(f.project)} && claude --session-id ${target} -p go`,
            },
          },
        ],
      },
    });
    f.first.forgetProcess(context); // No result can arrive from this ended process.
    await vi.waitFor(
      () =>
        expect(
          f.writer.index.checkpoint(
            "nested-harness-complete-v1",
            JSON.stringify([context.sessionId, `call-${i}`]),
          ),
        ).not.toBeNull(),
      { interval: 5 },
    );
    expect(f.pending()?.state).toBe("complete");
    expect(JSON.parse(f.pending()!.cursor).hints).toEqual([]);
  }
  const target = randomUUID();
  await writeFile(join(f.scope, target + ".jsonl"), f.header(target));
  f.observe(f.first, "later-valid", target);
  f.finish(f.first, "later-valid");
  await vi.waitFor(() => expect(f.edges()).toHaveLength(1));
  expect(f.writer.index.partialSources("nested-harness-pending-v1")).toEqual(
    [],
  );
  expect(f.errors).toEqual([]);
});

it("tombstones exhausted missing targets as unknown and no longer recovers them at startup", async () => {
  const f = await fixture(),
    target = randomUUID();
  f.observe(f.first, "missing-target", target);
  f.finish(f.first, "missing-target");
  for (let attempt = 1; attempt <= 3; attempt++) {
    if (attempt > 1) f.first.observationReady("claude");
    await vi.waitFor(() =>
      expect(
        attempt === 3
          ? f.pending()?.state
          : JSON.parse(f.pending()!.cursor).hints[0].attempts,
      ).toBe(attempt === 3 ? "complete" : attempt),
    );
  }
  expect(
    f.writer.index.checkpoint(
      "nested-harness-complete-v1",
      JSON.stringify([f.context.sessionId, "missing-target"]),
    )?.cursor,
  ).toBe('{"observed":false}');
  await f.first.close();
  await writeFile(join(f.scope, target + ".jsonl"), f.header(target));
  const next = f.service();
  await turn();
  await turn();
  await next.close();
  expect(f.writer.index.partialSources("nested-harness-pending-v1")).toEqual(
    [],
  );
  expect(f.edges()).toEqual([]);
  expect(f.errors).toEqual([]);
});

it("abandons aged unready recovery hints without a timer or a live process", async () => {
  const f = await fixture();
  await f.first.close();
  const source = f.identities.resolveYa(f.context.sessionId)!.native!,
    observedAt = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
  f.writer.index.publish({
    observation: {
      producer: "nested-harness-pending-v1",
      sourceKey: f.context.sessionId,
      sourceVersion: "1",
      extractorVersion: 1,
      observedAt,
    },
    expectedRevision: null,
    facts: [],
    progress: {
      state: "partial",
      cursor: JSON.stringify({
        v: 1,
        native: source,
        directory: f.project,
        hints: [
          { id: "aged", targetId: randomUUID(), observedAt, ready: false },
        ],
      }),
    },
  });
  f.service();
  await vi.waitFor(() => expect(f.pending()?.state).toBe("complete"));
  expect(f.writer.index.partialSources("nested-harness-pending-v1")).toEqual(
    [],
  );
  expect(f.edges()).toEqual([]);
  expect(f.errors).toEqual([]);
});

it("preserves an unreturned call through local reload completion and reattached results", async () => {
  const f = await fixture(),
    target = randomUUID();
  f.observe(f.first, "reload-call", target);
  await vi.waitFor(() =>
    expect(JSON.parse(f.pending()!.cursor).hints[0].ready).toBe(false),
  );
  f.first.forgetProcess(f.context, "reload");
  await turn();
  await turn();
  expect(
    f.writer.index.checkpoint(
      "nested-harness-complete-v1",
      JSON.stringify([f.context.sessionId, "reload-call"]),
    ),
  ).toBeNull();
  await f.first.close();
  await writeFile(join(f.scope, target + ".jsonl"), f.header(target));
  const next = f.service(),
    context = { ...f.context, id: "reattached" };
  next.registerProcess(context);
  next.observeMessage(context, {
    type: "user",
    session_id: context.sessionId,
    message: {
      content: [
        {
          type: "tool_result",
          tool_use_id: "reload-call",
          content: "completed after direct signal",
        },
      ],
    },
  });
  await vi.waitFor(() => expect(f.edges()).toHaveLength(1));
  expect(f.errors).toEqual([]);
});

function historicalRows(
  f: Awaited<ReturnType<typeof fixture>>,
  targets: string[],
  timestamp = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString(),
): ClaudeSessionEntry[] {
  const native = f.identities.resolveYa(f.context.sessionId)!.native!;
  return targets
    .flatMap(
      (target, index) =>
        [
          {
            type: "assistant",
            uuid: `command-${index}`,
            sessionId: native.id,
            timestamp,
            message: {
              role: "assistant",
              content: [
                {
                  type: "tool_use",
                  name: "Bash",
                  id: `historical-${index}`,
                  input: {
                    command: `cd ${quoteShellWord(f.project)} && claude --session-id ${target} --print go`,
                  },
                },
              ],
            },
          },
          {
            type: "user",
            uuid: `result-${index}`,
            sessionId: native.id,
            timestamp,
            message: {
              role: "user",
              content: [
                {
                  type: "tool_result",
                  tool_use_id: `historical-${index}`,
                  content: "private historical output",
                },
              ],
            },
          },
        ] as ClaudeSessionEntry[],
    )
    .concat([
      {
        type: "assistant",
        uuid: "last",
        sessionId: native.id,
        timestamp,
        message: {
          role: "assistant",
          content: [{ type: "text", text: "Complete" }],
        },
      } as ClaudeSessionEntry,
    ]);
}

it("indexes more than one historical batch from already acquired rows, without a parent file or retained commands", async () => {
  const f = await fixture(true),
    targets = Array.from({ length: 80 }, () => randomUUID());
  await Promise.all(
    targets.map((target) =>
      writeFile(join(f.scope, target + ".jsonl"), f.header(target)),
    ),
  );
  const rows = historicalRows(f, targets);
  f.first.observeTranscript(f.context, rows);
  expect(f.edges()).toEqual([]);
  expect(f.admissionReads).not.toHaveBeenCalled(); // No synchronous SQL/native work.
  await vi.waitFor(() => expect(f.edges()).toHaveLength(80));
  const evidence = f.writer.index.evidence(f.edges()[0]!.id);
  expect(evidence).toEqual([
    expect.objectContaining({
      producer: "nested-harness-history-v1",
      trust: "command-observed",
      metadata: expect.objectContaining({
        sourceTimestamp: expect.any(String),
      }),
    }),
  ]);
  expect(JSON.stringify(evidence)).not.toContain("private historical output");
  f.first.observeTranscript(f.context, rows);
  await turn();
  await turn();
  expect(f.committed.mock.calls.length).toBeLessThanOrEqual(3);
  expect(f.errors).toEqual([]);
});

it("can refine a live terminal unknown from a proved historical command/result pair", async () => {
  const f = await fixture(true),
    target = randomUUID();
  f.observe(f.first, "historical-0", target);
  f.first.forgetProcess(f.context);
  await vi.waitFor(() =>
    expect(
      f.writer.index.checkpoint(
        "nested-harness-complete-v1",
        JSON.stringify([f.context.sessionId, "historical-0"]),
      )?.cursor,
    ).toBe('{"observed":false}'),
  );
  await writeFile(join(f.scope, target + ".jsonl"), f.header(target));
  const rows = historicalRows(f, [target]);
  f.first.observeTranscript(f.context, rows);
  await vi.waitFor(() => expect(f.edges()).toHaveLength(1));
  expect(f.errors).toEqual([]);
});

it.each([
  "copy",
  "deleted",
  "invalid-birth",
  "confined",
  "missing-sandbox",
] as const)(
  "withholds historical %s sources without spinning",
  async (kind) => {
    const f = await fixture(true),
      target = randomUUID();
    await writeFile(join(f.scope, target + ".jsonl"), f.header(target));
    if (kind === "copy") f.admission.copy = true;
    if (kind === "deleted") f.admission.deleted = true;
    if (kind === "confined") f.admission.confined = true;
    if (kind === "missing-sandbox") f.admission.confined = undefined;
    if (kind === "invalid-birth") f.admission.createdAt = "invalid";
    const rows = historicalRows(
      f,
      [target],
      new Date(Date.now() + 3600000).toISOString(),
    );
    f.first.observeTranscript(f.context, rows);
    await vi.waitFor(() => expect(f.admissionReads).toHaveBeenCalled());
    await turn();
    await f.first.close();
    expect(f.edges()).toEqual([]);
    expect(f.errors).toEqual([]);
  },
);

it("persists an unpaired committed command across observer replacement and accepts a newly committed last-row result", async () => {
  const f = await fixture(true),
    target = randomUUID();
  await writeFile(join(f.scope, target + ".jsonl"), f.header(target));
  const rows = historicalRows(f, [target]),
    key = "nested-harness-history-scan-v1";
  f.first.observeTranscript(f.context, rows, 1, {
    id: "owned-file",
    size: 100,
    mtime: 1,
  });
  await vi.waitFor(() =>
    expect(
      JSON.parse(f.writer.index.checkpoint(key, f.context.sessionId)!.cursor)
        .entry,
    ).toBe(1),
  );
  expect(f.edges()).toEqual([]);
  const pending = JSON.parse(
    f.writer.index.checkpoint(key, f.context.sessionId)!.cursor,
  );
  expect(pending.pending).toHaveLength(1);
  expect(JSON.stringify(pending)).not.toContain("claude --session-id");
  await f.first.close();
  const next = f.service(),
    committedRows = rows.slice(0, 2);
  next.observeTranscript(f.context, committedRows, 2, {
    id: "owned-file",
    size: 200,
    mtime: 2,
  });
  await vi.waitFor(() => expect(f.edges()).toHaveLength(1));
  await vi.waitFor(() =>
    expect(f.writer.index.checkpoint(key, f.context.sessionId)?.state).toBe(
      "complete",
    ),
  );
  const revision = f.writer.index.checkpoint(
    key,
    f.context.sessionId,
  )!.revision;
  next.observeTranscript(f.context, committedRows, 2, {
    id: "owned-file",
    size: 200,
    mtime: 2,
  });
  await turn();
  await turn();
  await next.close();
  expect(f.writer.index.checkpoint(key, f.context.sessionId)!.revision).toBe(
    revision,
  );
  expect(f.errors).toEqual([]);
});

it("resets historical progress after a same-size native rewrite while preserving accepted history", async () => {
  const f = await fixture(true),
    targets = [randomUUID(), randomUUID()];
  await Promise.all(
    targets.map((target) =>
      writeFile(join(f.scope, target + ".jsonl"), f.header(target)),
    ),
  );
  const first = historicalRows(f, [targets[0]!]);
  f.first.observeTranscript(f.context, first, first.length, {
    id: "owned-file",
    size: 500,
    mtime: 1,
  });
  await vi.waitFor(() => expect(f.edges()).toHaveLength(1));
  await vi.waitFor(() =>
    expect(
      f.writer.index.checkpoint(
        "nested-harness-history-scan-v1",
        f.context.sessionId,
      )?.state,
    ).toBe("complete"),
  );
  const replacement = historicalRows(f, [targets[1]!]);
  // UUID positions deliberately remain equal; the native snapshot changed.
  const command = replacement[0] as unknown as {
      message: { content: { id: string }[] };
    },
    result = replacement[1] as unknown as {
      message: { content: { tool_use_id: string }[] };
    };
  command.message.content[0]!.id = "replacement-call";
  result.message.content[0]!.tool_use_id = "replacement-call";
  f.first.observeTranscript(f.context, replacement, replacement.length, {
    id: "owned-file",
    size: 500,
    mtime: 2,
  });
  await vi.waitFor(() => expect(f.edges()).toHaveLength(2));
  expect(f.errors).toEqual([]);
});

it("retries historical pairs after 32 live pending calls release capacity without advancing past them", async () => {
  const f = await fixture(true),
    targets = [randomUUID(), randomUUID()];
  await Promise.all(
    targets.map((t) => writeFile(join(f.scope, t + ".jsonl"), f.header(t))),
  );
  for (let i = 0; i < 32; i++)
    f.observe(f.first, `pressure-${i}`, randomUUID());
  await vi.waitFor(() =>
    expect(JSON.parse(f.pending()!.cursor).hints).toHaveLength(32),
  );
  const rows = historicalRows(f, targets);
  f.first.observeTranscript(f.context, rows, rows.length);
  await vi.waitFor(() => expect(f.admissionReads).toHaveBeenCalled());
  await turn();
  await turn();
  expect(
    f.writer.index.checkpoint(
      "nested-harness-history-scan-v1",
      f.context.sessionId,
    ),
  ).toBeNull();
  f.first.forgetProcess(f.context);
  await vi.waitFor(() => expect(f.pending()?.state).toBe("complete"));
  f.first.observeTranscript(f.context, rows, rows.length);
  await vi.waitFor(() => expect(f.edges()).toHaveLength(2));
  expect(f.errors).toEqual([]);
});

it("retains a completed historical pair after failed handoff and retries it without rereading earlier rows", async () => {
  const f = await fixture(true),
    target = randomUUID();
  await writeFile(join(f.scope, target + ".jsonl"), f.header(target));
  const rows = historicalRows(f, [target]);
  await rename(f.project, f.project + "-away");
  f.first.observeTranscript(f.context, rows, rows.length);
  await vi.waitFor(() =>
    expect(
      JSON.parse(
        f.writer.index.checkpoint(
          "nested-harness-history-scan-v1",
          f.context.sessionId,
        )!.cursor,
      ).pending[0].ready,
    ).toBe(true),
  );
  expect(f.edges()).toEqual([]);
  await rename(f.project + "-away", f.project);
  const realNow = Date.now.bind(Date);
  vi.spyOn(Date, "now").mockImplementation(() => realNow() + 1100);
  f.first.observeTranscript(f.context, rows, rows.length);
  await vi.waitFor(() => expect(f.edges()).toHaveLength(1));
  expect(f.errors).toHaveLength(1);
});

it("does not let historical reads change the completion key, clock or retry budget of a live hint", async () => {
  const f = await fixture(true),
    target = randomUUID();
  f.observe(f.first, "historical-0", target);
  f.finish(f.first, "historical-0");
  await vi.waitFor(() =>
    expect(JSON.parse(f.pending()!.cursor).hints[0].attempts).toBe(1),
  );
  const before = JSON.parse(f.pending()!.cursor).hints[0],
    rows = historicalRows(f, [target]);
  for (let i = 0; i < 1500; i++)
    rows.push({
      ...rows[rows.length - 1]!,
      uuid: `tail-${i}`,
    } as ClaudeSessionEntry);
  f.first.observeTranscript(f.context, rows, rows.length);
  await vi.waitFor(() =>
    expect(
      JSON.parse(
        f.writer.index.checkpoint(
          "nested-harness-history-scan-v1",
          f.context.sessionId,
        )!.cursor,
      ).entry,
    ).toBe(rows.length),
  );
  const revision = f.writer.index.checkpoint(
    "nested-harness-history-scan-v1",
    f.context.sessionId,
  )!.revision;
  f.first.observeTranscript(f.context, rows, rows.length);
  await turn();
  await turn();
  expect(
    f.writer.index.checkpoint(
      "nested-harness-history-scan-v1",
      f.context.sessionId,
    )!.revision,
  ).toBe(revision);
  expect(JSON.parse(f.pending()!.cursor).hints[0]).toEqual(before);
  await writeFile(join(f.scope, target + ".jsonl"), f.header(target));
  f.first.observationReady("claude");
  await vi.waitFor(() => expect(f.edges()).toHaveLength(1));
  expect(f.writer.index.evidence(f.edges()[0]!.id)[0]?.producer).toBe(
    "nested-harness-command-v1",
  );
  expect(f.errors).toEqual([]);
});

it("keeps a historical proof on the retry ladder after a transient I/O failure", async () => {
  const f = await fixture(true),
    target = randomUUID();
  await writeFile(join(f.scope, target + ".jsonl"), f.header(target));
  const probe = vi
    .spyOn(
      f.first as unknown as {
        targetExists(p: unknown, h: unknown): Promise<boolean>;
      },
      "targetExists",
    )
    .mockRejectedValueOnce(
      Object.assign(Error("temporary header read"), { code: "EIO" }),
    );
  const rows = historicalRows(f, [target]);
  f.first.observeTranscript(f.context, rows, rows.length);
  await vi.waitFor(() =>
    expect(JSON.parse(f.pending()!.cursor).hints[0].attempts).toBe(1),
  );
  expect(f.edges()).toEqual([]);
  f.first.observationReady("claude");
  await vi.waitFor(() => expect(f.edges()).toHaveLength(1));
  expect(f.errors).toHaveLength(1);
  probe.mockRestore();
});

it("ignores an older same-file snapshot after a newer history view commits", async () => {
  const f = await fixture(true),
    target = randomUUID();
  await writeFile(join(f.scope, target + ".jsonl"), f.header(target));
  const rows = historicalRows(f, [target]);
  f.first.observeTranscript(f.context, rows, rows.length, {
    id: "stable-file",
    size: 200,
    mtime: 2,
  });
  await vi.waitFor(() =>
    expect(
      f.writer.index.checkpoint(
        "nested-harness-history-scan-v1",
        f.context.sessionId,
      )?.state,
    ).toBe("complete"),
  );
  const before = f.writer.index.checkpoint(
    "nested-harness-history-scan-v1",
    f.context.sessionId,
  )!;
  f.first.observeTranscript(f.context, rows.slice(0, 1), 1, {
    id: "stable-file",
    size: 100,
    mtime: 1,
  });
  await turn();
  await turn();
  await f.first.close();
  expect(
    f.writer.index.checkpoint(
      "nested-harness-history-scan-v1",
      f.context.sessionId,
    ),
  ).toEqual(before);
  expect(f.errors).toEqual([]);
});

it("rebuilds a corrupt private scan cursor without losing independently accepted facts", async () => {
  const f = await fixture(true),
    target = randomUUID();
  await writeFile(join(f.scope, target + ".jsonl"), f.header(target));
  f.writer.index.publish({
    observation: {
      producer: "nested-harness-history-scan-v1",
      sourceKey: f.context.sessionId,
      sourceVersion: "old",
      extractorVersion: 1,
      observedAt: new Date().toISOString(),
    },
    expectedRevision: null,
    facts: [],
    progress: { state: "partial", cursor: "not valid JSON" },
  });
  const rows = historicalRows(f, [target]);
  f.first.observeTranscript(f.context, rows, rows.length);
  await vi.waitFor(() => expect(f.edges()).toHaveLength(1));
  await vi.waitFor(() =>
    expect(
      f.writer.index.checkpoint(
        "nested-harness-history-scan-v1",
        f.context.sessionId,
      )?.state,
    ).toBe("complete"),
  );
  expect(f.errors).toEqual([]);
});
