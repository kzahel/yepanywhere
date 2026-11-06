import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseYaSessionId, toUrlProjectId } from "@yep-anywhere/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionMetadataService } from "../../src/metadata/SessionMetadataService.js";
import { MessageQueue } from "../../src/sdk/messageQueue.js";
import { ClaudeProvider } from "../../src/sdk/providers/claude.js";
import { DiscoverySqliteService } from "../../src/storage/discovery-sqlite.js";
import {
  createControllableIterator,
  waitFor,
} from "../process.test-support.js";
import { createApp } from "../setup/create-app.js";

/**
 * What a session made from another one keeps for its later resumes, read
 * from the stored metadata and from the process a later resume starts. The
 * creation record, the Supervisor and the routes each save part of it; these
 * pins hold whichever of them saves each field.
 */
describe("the launch settings a new session keeps for later resumes", () => {
  const nativeId = "019a0000-7777-7777-8777-777777777777";
  const publicId = parseYaSessionId("launch-records-source");
  const timestamp = "2026-11-01T00:00:00.000Z";
  let root: string;
  let projectPath: string;
  let projectId: string;
  let storage: DiscoverySqliteService;
  let metadata: SessionMetadataService;
  let provider: ClaudeProvider;
  let app: ReturnType<typeof createApp>;

  beforeEach(async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    root = await realpath(await mkdtemp(join(tmpdir(), "ya-launch-records-")));
    projectPath = join(root, "project");
    projectId = toUrlProjectId(projectPath);
    const claudeConfig = join(root, "claude");
    vi.stubEnv("CLAUDE_CONFIG_DIR", claudeConfig);
    const nativeRoot = join(
      claudeConfig,
      "projects",
      projectPath.replace(/[/\\:]/g, "-"),
    );
    await mkdir(projectPath, { recursive: true });
    await mkdir(nativeRoot, { recursive: true });
    await writeFile(
      join(nativeRoot, `${nativeId}.jsonl`),
      transcript(nativeId, [
        ["11111111-1111-4111-8111-111111111111", "user", "first question"],
        ["22222222-2222-4222-8222-222222222222", "assistant", "first answer"],
        ["33333333-3333-4333-8333-333333333333", "user", "second question"],
        ["44444444-4444-4444-8444-444444444444", "assistant", "second answer"],
      ]),
    );
    const dataDir = join(root, "data");
    storage = new DiscoverySqliteService({
      dataDir,
      probeNetworkFilesystem: () => undefined,
    });
    metadata = new SessionMetadataService({
      dataDir,
      database: storage.getDatabase(),
    });
    await metadata.initialize();
    const insert = storage
      .getDatabase()
      .prepare(
        "INSERT INTO session_identities VALUES (?, 'claude', ?, ?, 'claude', ?, ?)",
      );
    try {
      insert.run(publicId, projectId, timestamp, nativeRoot, nativeId);
    } finally {
      insert.finalize();
    }
    await metadata.setProvider(publicId, "claude");
    await metadata.updateMetadata(publicId, { title: "Source title" });
    await metadata.recordEffectiveLaunchSettings(publicId, {
      schemaVersion: 1,
      revision: 1,
      permissionMode: "acceptEdits",
      requestedModel: "source-model",
      serviceTier: null,
      thinking: null,
      effort: "high",
    });
    provider = new ClaudeProvider();
    vi.spyOn(provider, "isInstalled").mockResolvedValue(true);
    vi.spyOn(provider, "isAuthenticated").mockResolvedValue(true);
    // A provider that reports its session, confirms each input it is given
    // and, for a new session, writes the transcript a later resume reads.
    vi.spyOn(provider, "startSession").mockImplementation(async (options) => {
      const sessionId = (options.resumeSessionId ?? options.newSessionId)!;
      if (options.newSessionId) {
        await writeFile(
          join(nativeRoot, `${sessionId}.jsonl`),
          transcript(sessionId, [
            [randomUUID(), "user", "handoff"],
            [randomUUID(), "assistant", "continued"],
          ]),
        );
      }
      const owner = createControllableIterator();
      const queue = new MessageQueue();
      owner.push({
        type: "system",
        subtype: "init",
        session_id: sessionId,
      } as Parameters<typeof owner.push>[0]);
      void (async () => {
        for await (const input of queue) {
          owner.push({
            type: "assistant",
            session_id: sessionId,
            user_message_uuid: input.uuid,
            message: { role: "assistant", content: "reply" },
          } as Parameters<typeof owner.push>[0]);
        }
      })();
      return { iterator: owner.iterator, queue, abort: owner.finish };
    });
    app = createApp({
      provider,
      dataDir,
      projectsDir: join(claudeConfig, "projects"),
      sessionMetadataService: metadata,
      discoverySqlite: storage,
    });
  });

  function transcript(
    sessionId: string,
    rows: Array<[uuid: string, type: "user" | "assistant", text: string]>,
  ): string {
    return `${rows
      .map(([uuid, type, text], index) =>
        JSON.stringify({
          type,
          uuid,
          parentUuid: index === 0 ? null : rows[index - 1]![0],
          sessionId,
          cwd: projectPath,
          timestamp,
          message:
            type === "user"
              ? { role: "user", content: text }
              : {
                  role: "assistant",
                  model: "claude-transcript-model",
                  content: [{ type: "text", text }],
                },
        }),
      )
      .join("\n")}\n`;
  }

  afterEach(async () => {
    for (const process of app.supervisor.getAllProcesses()) {
      await process.abort();
    }
    await app.supervisor.stopBackgroundTasks();
    app.stopNotifications();
    await app.disposeSessionReaders();
    storage.close();
    await rm(root, { recursive: true, force: true });
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  /** The source's own prompt-suggestion and recap preferences. */
  async function givenSourcePreferences(): Promise<void> {
    await metadata.updateMetadata(publicId, {
      promptSuggestionMode: "off",
      recapAfterSeconds: 240,
    });
  }

  async function post(path: string, body: unknown): Promise<Response> {
    return app.app.request(`/api/projects/${projectId}/sessions/${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Yep-Anywhere": "true",
      },
      body: JSON.stringify(body),
    });
  }

  /** The stored launch record, with this run's paths and ids made stable. */
  function stored(sessionId: string): Record<string, unknown> {
    const record = metadata.getMetadata(sessionId) ?? {};
    const {
      initialPrompt: _initialPrompt,
      creationProvenance: _creationProvenance,
      ...kept
    } = record as Record<string, unknown>;
    return JSON.parse(
      JSON.stringify(kept)
        .replaceAll(projectId, "<project-id>")
        .replaceAll(projectPath, "<project>"),
    );
  }

  /** What a plain later resume of `sessionId` launches with. */
  async function laterResume(sessionId: string) {
    const live = app.supervisor.getProcessForSession(sessionId);
    if (live) await app.supervisor.abortProcess(live.id);
    const response = await post(`${sessionId}/resume`, {
      message: "a later turn",
    });
    expect(response.status, await response.clone().text()).toBe(200);
    const process = app.supervisor.getProcessForSession(sessionId)!;
    return {
      provider: process.provider,
      requestedModel: process.requestedModel,
      model: process.model,
      permissionMode: process.permissionMode,
      thinking: process.thinking,
      effort: process.effort,
      recapMode: process.recapMode,
      recapAfterSeconds: process.recapAfterSeconds,
      promptSuggestionMode: process.promptSuggestionMode,
      sandbox: process.sandboxEnforcement?.effective ?? "none",
    };
  }

  it("fork", async () => {
    await givenSourcePreferences();
    const response = await post(`${publicId}/fork`, {});
    expect(response.status, await response.clone().text()).toBe(200);
    const { sessionId } = (await response.json()) as { sessionId: string };
    expect(stored(sessionId)).toMatchInlineSnapshot(`
      {
        "customTitle": "Fork: Source title",
        "effectiveLaunchSettings": {
          "effort": "high",
          "permissionMode": "acceptEdits",
          "requestedModel": "source-model",
          "revision": 1,
          "schemaVersion": 1,
          "serviceTier": null,
          "thinking": null,
        },
        "forkLineageRootId": "launch-records-source",
        "forkedFromSessionId": "launch-records-source",
        "promptSuggestionMode": "off",
        "provider": "claude",
        "recapAfterSeconds": 240,
        "requestedModel": "source-model",
        "sandboxEverConfined": false,
        "sandboxLevel": "none",
        "sandboxProjectPath": "<project>",
        "workingProjectId": "<project-id>",
      }
    `);
    expect(await laterResume(sessionId)).toMatchInlineSnapshot(`
      {
        "effort": "high",
        "model": "source-model",
        "permissionMode": "acceptEdits",
        "promptSuggestionMode": "off",
        "provider": "claude",
        "recapAfterSeconds": 240,
        "recapMode": "off",
        "requestedModel": "source-model",
        "sandbox": "none",
        "thinking": undefined,
      }
    `);
  });

  it("clone", async () => {
    await givenSourcePreferences();
    const response = await post(`${publicId}/clone`, {
      parentSessionId: publicId,
    });
    expect(response.status, await response.clone().text()).toBe(200);
    const { sessionId } = (await response.json()) as { sessionId: string };
    expect(stored(sessionId)).toMatchInlineSnapshot(`
      {
        "customTitle": "Source title [cloned]",
        "effectiveLaunchSettings": {
          "effort": "high",
          "permissionMode": "acceptEdits",
          "requestedModel": "source-model",
          "revision": 1,
          "schemaVersion": 1,
          "serviceTier": null,
          "thinking": null,
        },
        "forkedFromSessionId": "launch-records-source",
        "parentSessionId": "launch-records-source",
        "parentSessionKind": "btw-aside",
        "promptSuggestionMode": "off",
        "provider": "claude",
        "recapAfterSeconds": 240,
        "requestedModel": "source-model",
        "sandboxEverConfined": false,
        "sandboxLevel": "none",
        "workingProjectId": "<project-id>",
      }
    `);
    expect(await laterResume(sessionId)).toMatchInlineSnapshot(`
      {
        "effort": "high",
        "model": "source-model",
        "permissionMode": "acceptEdits",
        "promptSuggestionMode": "off",
        "provider": "claude",
        "recapAfterSeconds": 240,
        "recapMode": "off",
        "requestedModel": "source-model",
        "sandbox": "none",
        "thinking": undefined,
      }
    `);
  });

  it("restart handoff", async () => {
    await givenSourcePreferences();
    const response = await post(`${publicId}/restart`, {
      handoffText: "Handoff of the source session",
      model: "request-model",
      promptSuggestionMode: "native",
      recapAfterSeconds: 600,
    });
    expect(response.status, await response.clone().text()).toBe(200);
    const { sessionId } = (await response.json()) as { sessionId: string };
    expect(stored(sessionId)).toMatchInlineSnapshot(`
      {
        "customTitle": "Handoff: Source title",
        "effectiveLaunchSettings": {
          "effort": "high",
          "permissionMode": "acceptEdits",
          "requestedModel": "request-model",
          "revision": 1,
          "schemaVersion": 1,
          "serviceTier": null,
          "thinking": null,
        },
        "promptSuggestionMode": "native",
        "provider": "claude",
        "recapAfterSeconds": 600,
        "requestedModel": "request-model",
        "sandboxEverConfined": false,
        "sandboxLevel": "none",
        "sandboxProjectPath": "<project>",
        "workingProjectId": "<project-id>",
      }
    `);
    expect(await laterResume(sessionId)).toMatchInlineSnapshot(`
      {
        "effort": "high",
        "model": "request-model",
        "permissionMode": "acceptEdits",
        "promptSuggestionMode": "native",
        "provider": "claude",
        "recapAfterSeconds": 600,
        "recapMode": "off",
        "requestedModel": "request-model",
        "sandbox": "none",
        "thinking": undefined,
      }
    `);
  });

  it("restart fork", async () => {
    await givenSourcePreferences();
    const response = await post(`${publicId}/restart`, {
      restartMode: "fork",
      reason: "Continue from here",
      model: "request-model",
      promptSuggestionMode: "native",
      recapAfterSeconds: 600,
    });
    expect(response.status, await response.clone().text()).toBe(200);
    const { sessionId } = (await response.json()) as { sessionId: string };
    expect(stored(sessionId)).toMatchInlineSnapshot(`
      {
        "customTitle": "Fork: Source title",
        "effectiveLaunchSettings": {
          "effort": "high",
          "permissionMode": "acceptEdits",
          "requestedModel": "request-model",
          "revision": 1,
          "schemaVersion": 1,
          "serviceTier": null,
          "thinking": null,
        },
        "forkLineageRootId": "launch-records-source",
        "forkedFromSessionId": "launch-records-source",
        "promptSuggestionMode": "native",
        "provider": "claude",
        "recapAfterSeconds": 600,
        "requestedModel": "request-model",
        "sandboxEverConfined": false,
        "sandboxLevel": "none",
        "sandboxProjectPath": "<project>",
        "workingProjectId": "<project-id>",
      }
    `);
    expect(await laterResume(sessionId)).toMatchInlineSnapshot(`
      {
        "effort": "high",
        "model": "request-model",
        "permissionMode": "acceptEdits",
        "promptSuggestionMode": "native",
        "provider": "claude",
        "recapAfterSeconds": 600,
        "recapMode": "off",
        "requestedModel": "request-model",
        "sandbox": "none",
        "thinking": undefined,
      }
    `);
  });

  it("retitle helper", async () => {
    await givenSourcePreferences();
    const generateSummary = vi
      .spyOn(app.supervisor, "generateSummary")
      .mockResolvedValue({ text: "Proposed title" } as Awaited<
        ReturnType<typeof app.supervisor.generateSummary>
      >);
    const response = await post(`${publicId}/retitle`, {});
    expect(response.status, await response.clone().text()).toBe(200);
    const generator = generateSummary.mock.calls[0]?.[1]?.generatorSessionId;
    expect(generator).toEqual(expect.any(String));
    expect(stored(generator!)).toMatchInlineSnapshot(`
      {
        "customTitle": "Retitle generator",
        "effectiveLaunchSettings": {
          "effort": "high",
          "permissionMode": "acceptEdits",
          "requestedModel": "source-model",
          "revision": 1,
          "schemaVersion": 1,
          "serviceTier": null,
          "thinking": null,
        },
        "forkedFromSessionId": "launch-records-source",
        "isArchived": true,
        "promptSuggestionMode": "off",
        "provider": "claude",
        "recapAfterSeconds": 240,
        "recapMode": "off",
        "requestedModel": "source-model",
        "sandboxEverConfined": false,
        "sandboxLevel": "none",
        "sandboxProjectPath": "<project>",
        "workingProjectId": "<project-id>",
      }
    `);
  });

  it("fork-summary helper and target", async () => {
    await givenSourcePreferences();
    const generateSummary = vi
      .spyOn(app.supervisor, "generateSummary")
      .mockResolvedValue({ text: "Summary of the work so far" } as Awaited<
        ReturnType<typeof app.supervisor.generateSummary>
      >);
    const response = await post(`${publicId}/fork-summary`, {
      sourceMessageId: "33333333-3333-4333-8333-333333333333",
    });
    expect(response.status, await response.clone().text()).toBeLessThan(300);
    await waitFor(() =>
      expect(
        metadata.getMetadata(publicId)?.transcriptDisplayObjects,
      ).toContainEqual(
        expect.objectContaining({ kind: "fork-summary", status: "ready" }),
      ),
    );
    const generator = generateSummary.mock.calls[0]?.[1]?.generatorSessionId;
    const target = metadata
      .getMetadata(publicId)
      ?.transcriptDisplayObjects?.find(
        (object) => object.kind === "fork-summary",
      ) as { targetSessionId?: string } | undefined;
    expect(stored(generator!)).toMatchInlineSnapshot(`
      {
        "customTitle": "Fork summary generator",
        "effectiveLaunchSettings": {
          "effort": "high",
          "permissionMode": "acceptEdits",
          "requestedModel": "source-model",
          "revision": 1,
          "schemaVersion": 1,
          "serviceTier": null,
          "thinking": null,
        },
        "forkedFromSessionId": "launch-records-source",
        "isArchived": true,
        "promptSuggestionMode": "off",
        "provider": "claude",
        "recapAfterSeconds": 240,
        "recapMode": "off",
        "requestedModel": "source-model",
        "sandboxEverConfined": false,
        "sandboxLevel": "none",
        "sandboxProjectPath": "<project>",
        "workingProjectId": "<project-id>",
      }
    `);
    expect(stored(target!.targetSessionId!)).toMatchInlineSnapshot(`
      {
        "customTitle": "Summary of the work so far",
        "effectiveLaunchSettings": {
          "effort": "high",
          "permissionMode": "acceptEdits",
          "requestedModel": "source-model",
          "revision": 1,
          "schemaVersion": 1,
          "serviceTier": null,
          "thinking": null,
        },
        "forkLineageRootId": "launch-records-source",
        "forkedFromSessionId": "launch-records-source",
        "promptSuggestionMode": "off",
        "provider": "claude",
        "recapAfterSeconds": 240,
        "requestedModel": "source-model",
        "sandboxEverConfined": false,
        "sandboxLevel": "none",
        "sandboxProjectPath": "<project>",
        "workingProjectId": "<project-id>",
      }
    `);
    expect(await laterResume(target!.targetSessionId!)).toMatchInlineSnapshot(`
      {
        "effort": "high",
        "model": "source-model",
        "permissionMode": "acceptEdits",
        "promptSuggestionMode": "off",
        "provider": "claude",
        "recapAfterSeconds": 240,
        "recapMode": "off",
        "requestedModel": "source-model",
        "sandbox": "none",
        "thinking": undefined,
      }
    `);
  });

  it("fork of a source with no saved preferences", async () => {
    const response = await post(`${publicId}/fork`, {});
    expect(response.status, await response.clone().text()).toBe(200);
    const { sessionId } = (await response.json()) as { sessionId: string };
    expect(stored(sessionId)).toMatchInlineSnapshot(`
      {
        "customTitle": "Fork: Source title",
        "effectiveLaunchSettings": {
          "effort": "high",
          "permissionMode": "acceptEdits",
          "requestedModel": "source-model",
          "revision": 1,
          "schemaVersion": 1,
          "serviceTier": null,
          "thinking": null,
        },
        "forkLineageRootId": "launch-records-source",
        "forkedFromSessionId": "launch-records-source",
        "provider": "claude",
        "requestedModel": "source-model",
        "sandboxEverConfined": false,
        "sandboxLevel": "none",
        "sandboxProjectPath": "<project>",
        "workingProjectId": "<project-id>",
      }
    `);
    expect(await laterResume(sessionId)).toMatchInlineSnapshot(`
      {
        "effort": "high",
        "model": "source-model",
        "permissionMode": "acceptEdits",
        "promptSuggestionMode": "native",
        "provider": "claude",
        "recapAfterSeconds": 300,
        "recapMode": "off",
        "requestedModel": "source-model",
        "sandbox": "none",
        "thinking": undefined,
      }
    `);
  });

  it("restart handoff of a source with no saved preferences", async () => {
    const response = await post(`${publicId}/restart`, {
      handoffText: "Handoff of the source session",
    });
    expect(response.status, await response.clone().text()).toBe(200);
    const { sessionId } = (await response.json()) as { sessionId: string };
    expect(stored(sessionId)).toMatchInlineSnapshot(`
      {
        "customTitle": "Handoff: Source title",
        "effectiveLaunchSettings": {
          "effort": "high",
          "permissionMode": "acceptEdits",
          "requestedModel": "source-model",
          "revision": 1,
          "schemaVersion": 1,
          "serviceTier": null,
          "thinking": null,
        },
        "promptSuggestionMode": "native",
        "provider": "claude",
        "recapAfterSeconds": 300,
        "requestedModel": "source-model",
        "sandboxEverConfined": false,
        "sandboxLevel": "none",
        "sandboxProjectPath": "<project>",
        "workingProjectId": "<project-id>",
      }
    `);
    expect(await laterResume(sessionId)).toMatchInlineSnapshot(`
      {
        "effort": "high",
        "model": "source-model",
        "permissionMode": "acceptEdits",
        "promptSuggestionMode": "native",
        "provider": "claude",
        "recapAfterSeconds": 300,
        "recapMode": "off",
        "requestedModel": "source-model",
        "sandbox": "none",
        "thinking": undefined,
      }
    `);
  });

  it("restart fork of a source with no saved preferences", async () => {
    const response = await post(`${publicId}/restart`, {
      restartMode: "fork",
      reason: "Continue from here",
    });
    expect(response.status, await response.clone().text()).toBe(200);
    const { sessionId } = (await response.json()) as { sessionId: string };
    expect(stored(sessionId)).toMatchInlineSnapshot(`
      {
        "customTitle": "Fork: Source title",
        "effectiveLaunchSettings": {
          "effort": "high",
          "permissionMode": "acceptEdits",
          "requestedModel": "source-model",
          "revision": 1,
          "schemaVersion": 1,
          "serviceTier": null,
          "thinking": null,
        },
        "forkLineageRootId": "launch-records-source",
        "forkedFromSessionId": "launch-records-source",
        "promptSuggestionMode": "native",
        "provider": "claude",
        "recapAfterSeconds": 300,
        "requestedModel": "source-model",
        "sandboxEverConfined": false,
        "sandboxLevel": "none",
        "sandboxProjectPath": "<project>",
        "workingProjectId": "<project-id>",
      }
    `);
    expect(await laterResume(sessionId)).toMatchInlineSnapshot(`
      {
        "effort": "high",
        "model": "source-model",
        "permissionMode": "acceptEdits",
        "promptSuggestionMode": "native",
        "provider": "claude",
        "recapAfterSeconds": 300,
        "recapMode": "off",
        "requestedModel": "source-model",
        "sandbox": "none",
        "thinking": undefined,
      }
    `);
  });

  it("fork-summary target of a source with no saved preferences", async () => {
    vi.spyOn(app.supervisor, "generateSummary").mockResolvedValue({
      text: "Summary of the work so far",
    } as Awaited<ReturnType<typeof app.supervisor.generateSummary>>);
    const response = await post(`${publicId}/fork-summary`, {
      sourceMessageId: "33333333-3333-4333-8333-333333333333",
    });
    expect(response.status, await response.clone().text()).toBeLessThan(300);
    await waitFor(() =>
      expect(
        metadata.getMetadata(publicId)?.transcriptDisplayObjects,
      ).toContainEqual(
        expect.objectContaining({ kind: "fork-summary", status: "ready" }),
      ),
    );
    const target = metadata
      .getMetadata(publicId)
      ?.transcriptDisplayObjects?.find(
        (object) => object.kind === "fork-summary",
      ) as { targetSessionId?: string } | undefined;
    expect(stored(target!.targetSessionId!)).toMatchInlineSnapshot(`
      {
        "customTitle": "Summary of the work so far",
        "effectiveLaunchSettings": {
          "effort": "high",
          "permissionMode": "acceptEdits",
          "requestedModel": "source-model",
          "revision": 1,
          "schemaVersion": 1,
          "serviceTier": null,
          "thinking": null,
        },
        "forkLineageRootId": "launch-records-source",
        "forkedFromSessionId": "launch-records-source",
        "promptSuggestionMode": "native",
        "provider": "claude",
        "recapAfterSeconds": 300,
        "requestedModel": "source-model",
        "sandboxEverConfined": false,
        "sandboxLevel": "none",
        "sandboxProjectPath": "<project>",
        "workingProjectId": "<project-id>",
      }
    `);
    expect(await laterResume(target!.targetSessionId!)).toMatchInlineSnapshot(`
      {
        "effort": "high",
        "model": "source-model",
        "permissionMode": "acceptEdits",
        "promptSuggestionMode": "native",
        "provider": "claude",
        "recapAfterSeconds": 300,
        "recapMode": "off",
        "requestedModel": "source-model",
        "sandbox": "none",
        "thinking": undefined,
      }
    `);
  });

  it("helper generators of a source that shows prompt suggestions", async () => {
    await metadata.updateMetadata(publicId, { promptSuggestionMode: "native" });
    const generateSummary = vi
      .spyOn(app.supervisor, "generateSummary")
      .mockResolvedValue({ text: "Proposed title" } as Awaited<
        ReturnType<typeof app.supervisor.generateSummary>
      >);
    const retitle = await post(`${publicId}/retitle`, {});
    expect(retitle.status, await retitle.clone().text()).toBe(200);
    const forkSummary = await post(`${publicId}/fork-summary`, {
      sourceMessageId: "33333333-3333-4333-8333-333333333333",
    });
    expect(forkSummary.status, await forkSummary.clone().text()).toBe(202);
    await waitFor(() =>
      expect(
        metadata.getMetadata(publicId)?.transcriptDisplayObjects,
      ).toContainEqual(
        expect.objectContaining({ kind: "fork-summary", status: "ready" }),
      ),
    );
    const generators = generateSummary.mock.calls.map(
      ([, request]) => request.generatorSessionId!,
    );
    expect(generators).toHaveLength(2);
    expect(
      generators.map((id) => ({
        title: stored(id).customTitle,
        promptSuggestionMode: stored(id).promptSuggestionMode,
        recapMode: stored(id).recapMode,
      })),
    ).toMatchInlineSnapshot(`
      [
        {
          "promptSuggestionMode": "native",
          "recapMode": "off",
          "title": "Retitle generator",
        },
        {
          "promptSuggestionMode": "native",
          "recapMode": "off",
          "title": "Fork summary generator",
        },
      ]
    `);
  });

  it("clone titles are stored on one line, and a blank one stores none", async () => {
    const titles: unknown[] = [];
    for (const title of ["Quick answer: line one\nline two \u202e ", "   "]) {
      const response = await post(`${publicId}/clone`, { title });
      expect(response.status, await response.clone().text()).toBe(200);
      const { sessionId } = (await response.json()) as { sessionId: string };
      titles.push(stored(sessionId).customTitle ?? null);
    }
    expect(titles).toMatchInlineSnapshot(`
      [
        "Quick answer: line one line two",
        null,
      ]
    `);
  });
});
