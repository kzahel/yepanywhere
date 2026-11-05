import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  nativeSessionRef,
  parseNativeSessionId,
  parseYaSessionId,
  toUrlProjectId,
} from "@yep-anywhere/shared";
import { expect, it, vi } from "vitest";
import { DiscoverySqliteService } from "../../src/storage/discovery-sqlite.js";
import { SessionMetadataService } from "../../src/metadata/SessionMetadataService.js";
import { ProviderChildRelationshipService } from "../../src/sessions/ProviderChildRelationshipService.js";
import { ClaudeSessionReader } from "../../src/sessions/reader.js";
import { ScriptedClaudeProvider } from "../support/scripted-provider.js";
import { createApp } from "../setup/create-app.js";

it("recovers scoped SQL launch anchors without native files and merges fresh pending children without stale or ambiguous aliases", async () => {
  const root = await realpath(
      await mkdtemp(join(tmpdir(), "ya-indexed-agent-mappings-")),
    ),
    dataDir = join(root, "profile"),
    project = join(root, "project");
  await mkdir(project);
  const sql = new DiscoverySqliteService({
    dataDir,
    probeNetworkFilesystem: () => undefined,
  });
  const metadata = new SessionMetadataService({
    dataDir,
    database: sql.getDatabase(),
  });
  await metadata.initialize();
  const projectId = toUrlProjectId(project),
    scopes = [join(root, "native-a"), join(root, "native-b")];
  const native = scopes.map((scope) =>
    nativeSessionRef("claude", scope, parseNativeSessionId("same-parent")),
  );
  const readers = scopes.map(
    (sessionDir) => new ClaudeSessionReader({ sessionDir }),
  );
  let committed: () => void = () => {};
  const errors: unknown[] = [];
  const seed = new ProviderChildRelationshipService(
    sql.getDatabase(),
    metadata.relationships.serverId,
    () => committed(),
    (e) => errors.push(e),
    () => metadata.relationships.index,
  );
  let app: ReturnType<typeof createApp> | undefined;
  const persist = async (index: number, id: string, toolUseId: string) => {
    const scope = scopes[index]!,
      parent = native[index]!;
    await mkdir(join(scope, parent.id, "subagents"), { recursive: true });
    await writeFile(
      join(scope, parent.id + ".jsonl"),
      JSON.stringify({
        type: "user",
        uuid: "parent-message",
        sessionId: parent.id,
        cwd: project,
        message: { role: "user", content: "parent" },
      }) + "\n",
    );
    await writeFile(
      join(scope, parent.id, "subagents", `agent-${id}.jsonl`),
      JSON.stringify({
        type: "user",
        uuid: "child-message",
        agentId: id,
        isSidechain: true,
        sessionId: parent.id,
        message: { role: "user", content: "child" },
      }) + "\n",
    );
    await writeFile(
      join(scope, parent.id, "subagents", `agent-${id}.meta.json`),
      JSON.stringify({
        toolUseId,
        agentType: "Explore",
        description: "Child " + index,
        spawnDepth: 1,
      }),
    );
  };
  try {
    sql.getDatabase().transaction(() => {
      for (const [i, ref] of native.entries()) {
        const id = parseYaSessionId("public-" + i);
        metadata.identities.allocateWithinTransaction({
          sessionId: id,
          provider: "claude",
          projectId,
          createdAt: new Date().toISOString(),
        });
        metadata.identities.bindWithinTransaction(id, ref);
      }
      metadata.identities.allocateWithinTransaction({
        sessionId: parseYaSessionId("unbound"),
        provider: "claude",
        projectId,
        createdAt: new Date().toISOString(),
      });
      metadata.identities.allocateWithinTransaction({
        sessionId: parseYaSessionId("public-unknown"),
        provider: "claude",
        projectId,
        createdAt: new Date().toISOString(),
      });
      metadata.identities.bindWithinTransaction(
        parseYaSessionId("public-unknown"),
        nativeSessionRef(
          "claude",
          scopes[0]!,
          parseNativeSessionId("unknown-parent"),
        ),
      );
    });
    await persist(0, "same-child", "call-a");
    await persist(0, "ambiguous-one", "duplicate-call");
    await persist(0, "ambiguous-two", "duplicate-call");
    await persist(1, "same-child", "call-b");
    for (const [i, ref] of native.entries()) {
      const done = new Promise<void>((resolve) => {
        committed = resolve;
      });
      seed.demand(
        ref,
        { sessionId: "public-" + i },
        readers[i]!.getProviderChildSource(ref)!,
      );
      await done;
    }
    expect(errors).toEqual([]);
    await seed.close();
    for (const reader of readers) reader.close();
    await Promise.all(scopes.map((scope) => rm(scope, { recursive: true })));
    app = createApp({
      dataDir,
      discoverySqlite: sql,
      sessionMetadataService: metadata,
      provider: new ScriptedClaudeProvider(),
      projectsDir: join(root, "no-ambient-native-root"),
    });
    const mappings = async (id: string) => {
      const response = await app!.app.request(
        `/api/projects/${projectId}/sessions/${id}/agents`,
      );
      expect(response.status).toBe(200);
      return (await response.json()).mappings;
    };
    expect(await mappings("public-0")).toEqual([
      {
        toolUseId: "call-a",
        agentId: "same-child",
        agentType: "Explore",
        description: "Child 0",
        spawnDepth: 1,
      },
    ]);
    expect(await mappings("public-1")).toEqual([
      {
        toolUseId: "call-b",
        agentId: "same-child",
        agentType: "Explore",
        description: "Child 1",
        spawnDepth: 1,
      },
    ]);
    // Fresh native anchors and new children win while SQL discovery is pending.
    await persist(0, "same-child", "replacement-call");
    await persist(0, "new-child", "new-call");
    expect(
      (await mappings("public-0"))
        .map((m: { toolUseId: string }) => m.toolUseId)
        .sort(),
    ).toEqual(["new-call", "replacement-call"]);
    // A missing sidecar yields a native agent-id placeholder; accepted SQL can
    // restore its real call id while preserving the fresh, unrelated new child.
    await rm(
      join(
        scopes[0]!,
        native[0]!.id,
        "subagents",
        "agent-same-child.meta.json",
      ),
    );
    expect(
      (await mappings("public-0"))
        .map((m: { toolUseId: string }) => m.toolUseId)
        .sort(),
    ).toEqual(["call-a", "new-call"]);
    expect(await mappings("public-1")).toHaveLength(1);
    const unbound = await app.app.request(
      `/api/projects/${projectId}/sessions/unbound/agents`,
    );
    expect(unbound.status).toBe(404);
    const failedNative = vi
      .spyOn(ClaudeSessionReader.prototype, "getAgentMappings")
      .mockRejectedValue(new Error("owned native mapping failure"));
    try {
      expect(await mappings("public-0")).toEqual([
        expect.objectContaining({ toolUseId: "call-a", agentId: "same-child" }),
      ]);
      // Unknown SQL must preserve the native failure rather than claim empty.
      const unknown = await app.app.request(
        `/api/projects/${projectId}/sessions/public-unknown/agents`,
      );
      expect(unknown.status).toBe(500);
    } finally {
      failedNative.mockRestore();
    }
  } finally {
    app?.stopNotifications();
    await app?.disposeSessionReaders();
    await seed.close();
    for (const r of readers) r.close();
    sql.close();
    await rm(root, { recursive: true, force: true });
  }
});
