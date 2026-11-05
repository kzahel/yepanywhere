import { randomUUID } from "node:crypto";
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
import {
  nativeSessionRef,
  parseNativeSessionId,
  parseYaSessionId,
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
});
const turn = () => new Promise<void>((resolve) => setImmediate(resolve));
async function fixture() {
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
  const services: NestedHarnessRelationshipService[] = [];
  const service = () => {
    const s = new NestedHarnessRelationshipService(
      sql,
      writer,
      identities,
      committed,
      (e) => errors.push(e),
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
    writer.index.list({ resource, type: "launched_harness" }).edges;
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
