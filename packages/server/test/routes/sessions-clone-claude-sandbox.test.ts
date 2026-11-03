import { randomUUID } from "node:crypto";
import {
  mkdir,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  nativeSessionRef,
  parseNativeSessionId,
  type UrlProjectId,
} from "@yep-anywhere/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { SessionMetadataService } from "../../src/metadata/SessionMetadataService.js";
import { encodeProjectId } from "../../src/projects/paths.js";
import {
  createSessionsRoutes,
  type SessionsDeps,
} from "../../src/routes/sessions.js";
import { getClaudeSandboxProjectDir } from "../../src/session-sandbox.js";
import { ScriptedClaudeProvider } from "../support/scripted-provider.js";
import { SessionReader } from "../../src/sessions/reader.js";
import { Supervisor } from "../../src/supervisor/Supervisor.js";
import type { Project } from "../../src/supervisor/types.js";
import {
  closeTestDiscoveryDatabases,
  createTestSessionMetadataService,
} from "../utils/session-metadata-database.js";

/**
 * A clone of a sandboxed Claude session stays inside the source's settled
 * sandbox and shares its project's private provider root, where the readers
 * look for it (topics/session-sandboxing.md § Session Lifetime).
 */
// This exercises Linux pinned-directory writes through /proc/self/fd.
// Unsupported-host admission is covered by session-sandbox.test.ts.
describe.skipIf(process.platform !== "linux")(
  "Claude clone of a sandboxed session",
  () => {
    const stateKey = "project-clone-test";
    let root: string;
    let dataDir: string;
    let projectPath: string;
    let projectId: UrlProjectId;
    let hostDir: string;
    let sandboxDir: string;
    let metadata: SessionMetadataService;
    let project: Project;

    beforeEach(async () => {
      root = join(tmpdir(), `claude-sandbox-clone-${randomUUID()}`);
      dataDir = join(root, "data");
      projectPath = join(root, "project");
      projectId = encodeProjectId(projectPath);
      hostDir = join(root, "host-sessions");
      sandboxDir = getClaudeSandboxProjectDir({
        dataDir,
        stateKey,
        projectPath,
      });
      await mkdir(projectPath, { recursive: true });
      await mkdir(hostDir, { recursive: true });
      await mkdir(sandboxDir, { recursive: true });
      await writeFile(
        join(sandboxDir, "source-session.jsonl"),
        `${JSON.stringify({
          type: "user",
          uuid: "u1",
          parentUuid: null,
          cwd: projectPath,
          sessionId: "source-session",
          session_id: "source-session",
          timestamp: "2026-09-28T06:00:00.000Z",
          message: { role: "user", content: "Build the canvas" },
        })}\n`,
      );
      metadata = createTestSessionMetadataService(dataDir);
      await metadata.initialize();
      await metadata.setSessionSandbox("source-session", {
        level: "project-write",
        networkFirewall: true,
        stateKey,
        projectPath,
        projectId,
        provider: "claude",
      });
      project = {
        id: projectId,
        path: projectPath,
        name: "project",
        sessionCount: 1,
        sessionDir: hostDir,
        activeOwnedCount: 0,
        activeExternalCount: 0,
        lastActivity: null,
        provider: "claude",
      };
    });

    afterEach(async () => {
      closeTestDiscoveryDatabases();
      await rm(root, { recursive: true, force: true });
    });

    function routes() {
      return createSessionsRoutes({
        supervisor: new Supervisor({
          provider: new ScriptedClaudeProvider(),
          sandboxStateRoot: join(dataDir, "session-sandboxes"),
          sessionMetadataService: metadata,
          resolveNativeSessionSource: async (id) => ({
            native: nativeSessionRef(
              "claude",
              sandboxDir,
              parseNativeSessionId(id),
            ),
            projectId,
            filePath: join(sandboxDir, `${id}.jsonl`),
          }),
        }),
        scanner: {
          getOrCreateProject: async () => project,
        } as unknown as SessionsDeps["scanner"],
        // The readers merge the sandbox transcript directory, as app.ts does.
        readerFactory: () =>
          new SessionReader({
            sessionDir: hostDir,
            additionalDirs: [sandboxDir],
          }),
        sessionMetadataService: metadata,
      });
    }

    const clone = () =>
      routes().request(`/projects/${projectId}/sessions/source-session/clone`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider: "claude" }),
      });

    it("copies inside the private root and records the source's sandbox", async () => {
      const response = await clone();
      expect(response.status, await response.clone().text()).toBe(200);
      const { sessionId } = (await response.json()) as { sessionId: string };

      // Written where the sandbox readers look, never to the host tree.
      expect(await readdir(hostDir)).toEqual([]);
      const copied = await readFile(
        join(sandboxDir, `${sessionId}.jsonl`),
        "utf8",
      );
      expect(JSON.parse(copied)).toMatchObject({
        uuid: "u1",
        session_id: sessionId,
      });
      expect(metadata.getMetadata(sessionId)).toMatchObject({
        provider: "claude",
        sandboxLevel: "project-write",
        sandboxNetworkFirewall: true,
        sandboxStateKey: stateKey,
        sandboxProjectPath: projectPath,
        workingProjectId: projectId,
        forkedFromSessionId: "source-session",
      });
      const reader = new SessionReader({
        sessionDir: hostDir,
        additionalDirs: [sandboxDir],
      });
      expect((await reader.getSessionSummary(sessionId, projectId))?.id).toBe(
        sessionId,
      );
    });

    it("keeps a firewall opt-out the source settled", async () => {
      await metadata.setSessionSandbox("source-session", {
        level: "project-write",
        networkFirewall: false,
        stateKey,
        projectPath,
        projectId,
        provider: "claude",
      });
      const response = await clone();
      expect(response.status).toBe(200);
      const { sessionId } = (await response.json()) as { sessionId: string };
      expect(metadata.getMetadata(sessionId)?.sandboxNetworkFirewall).toBe(
        false,
      );
    });

    it("refuses to read the source through a link the agent planted", async () => {
      const outside = join(root, "outside.jsonl");
      await writeFile(
        outside,
        await readFile(join(sandboxDir, "source-session.jsonl")),
      );
      await rm(join(sandboxDir, "source-session.jsonl"));
      await symlink(outside, join(sandboxDir, "source-session.jsonl"));
      const response = await clone();
      expect(response.status).toBe(500);
      expect(await readdir(hostDir)).toEqual([]);
    });
  },
);
