import { MockClaudeSDK } from "../src/sdk/mock.js";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { toUrlProjectId } from "@yep-anywhere/shared";
import { createApp } from "./setup/create-app.js";
import { SessionCatalogService } from "../src/services/SessionCatalogService.js";
import { loadCapture } from "./utils/captured-provider-replay.js";
import { readConversation } from "@yep-anywhere/shared/experimental/conversation-client";

it("consumes a captured native session through the real app, catalog, capability gate and typed client", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ya-conversation-app-"));
  const capture = await loadCapture("claude-basic-2026-09-12");
  const path = join(directory, "native.jsonl");
  await writeFile(
    path,
    `${capture.native.map((row) => JSON.stringify(row)).join("\n")}\n`,
  );
  const seed = new SessionCatalogService({ dataDir: directory });
  await seed.initialize();
  await seed.reconcile([
    {
      catalogFamily: "claude",
      storeKey: "fixture",
      scan: async () => ({
        sourceVersion: "1",
        rows: [
          {
            sessionId: capture.manifest.sessionId,
            catalogFamily: "claude",
            storeKey: "fixture",
            projectId: toUrlProjectId(capture.manifest.projectPath),
            projectPath: capture.manifest.projectPath,
            projectIdentityKey: capture.manifest.projectPath,
            updatedAt: "2026-09-12T00:00:00.000Z",
            fidelity: "tail",
            sourceVersion: "1",
            location: { kind: "file", path },
          },
        ],
      }),
    },
  ]);
  seed.stop();
  // Version update discovery has no role in this contract test.
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(null, { status: 503 })),
  );
  const app = createApp({
    dataDir: directory,
    projectsDir: join(directory, "no-projects"),
    sdk: new MockClaudeSDK(),
  });
  // This fixture supplies a retained catalog, not a provider project directory.
  // Focused-watch filesystem discovery is covered by its own integration tests.
  const projectLookup = vi
    .spyOn(app.scanner, "getProject")
    .mockResolvedValue(null);
  const projectCreation = vi
    .spyOn(app.scanner, "getOrCreateProject")
    .mockResolvedValue(null);
  try {
    const version = await (await app.app.request("/api/version")).json();
    expect(version.experimentalSimpleClientApiRevision).toBe(
      "simple-client-spike-1",
    );
    const result = await readConversation({
      sourceId: "fixture-server",
      subscriptionId: "app-test",
      query: {
        sessionId: capture.manifest.sessionId,
        maxMessages: 20,
        anchorMessageId: null,
      },
      version,
      request: async (path) => {
        const response = await app.app.request(path);
        expect(response.status).toBe(200);
        return response.text();
      },
    });
    expect(result).toMatchObject({
      sourceId: "fixture-server",
      snapshot: {
        sequence: 0,
        view: { kind: "conversation", sessionId: capture.manifest.sessionId },
      },
    });
    if (!("snapshot" in result) || result.snapshot.view.kind !== "conversation")
      throw new Error("Missing conversation");
    expect(result.snapshot.view.messages.length).toBeGreaterThan(2);
  } finally {
    app.stopNotifications();
    await app.disposeSessionReaders();
    projectLookup.mockRestore();
    projectCreation.mockRestore();
    vi.unstubAllGlobals();
    await rm(directory, { recursive: true, force: true });
  }
});
