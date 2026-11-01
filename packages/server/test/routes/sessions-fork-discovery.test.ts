import { parseNativeSessionId } from "@yep-anywhere/shared";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { encodeProjectId } from "../../src/projects/paths.js";
import {
  createSessionsRoutes,
  type SessionsDeps,
} from "../../src/routes/sessions.js";
import { PiProvider } from "../../src/sdk/providers/pi.js";
import type { AgentProvider } from "../../src/sdk/providers/types.js";
import { CodexSessionReader } from "../../src/sessions/codex-reader.js";
import { PiSessionReader } from "../../src/sessions/pi-reader.js";
import { ClaudeSessionReader } from "../../src/sessions/reader.js";
import { Supervisor } from "../../src/supervisor/Supervisor.js";
import type { Project } from "../../src/supervisor/types.js";
import {
  closeTestDiscoveryDatabases,
  createTestSessionMetadataService,
} from "../utils/session-metadata-database.js";

const directories: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  closeTestDiscoveryDatabases();
  await Promise.all(
    directories
      .splice(0)
      .map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

describe("fork discovery before immediate navigation", () => {
  for (const providerName of ["codex", "pi", "claude"] as const) {
    it(`${providerName}: opens the child through the real route with warm readers`, async () => {
      const dir = await mkdtemp(join(tmpdir(), "fork-discovery-route-"));
      directories.push(dir);
      const sessionsDir = join(dir, "sessions");
      const projectPath = join(dir, "project");
      await mkdir(projectPath);
      const bucket =
        providerName === "codex"
          ? join(sessionsDir, "2026", "09", "09")
          : providerName === "pi"
            ? join(sessionsDir, "--project--")
            : sessionsDir;
      await mkdir(bucket, { recursive: true });
      const sourceId = randomUUID();
      const project: Project = {
        id: encodeProjectId(projectPath),
        path: projectPath,
        name: "project",
        provider: providerName,
        sessionDir: sessionsDir,
        sessionCount: 1,
        activeOwnedCount: 0,
        activeExternalCount: 0,
        lastActivity: null,
      };
      const writeSession = async (id: string) => {
        const timestamp = "2026-09-09T08:00:00.000Z";
        const filePath = join(
          bucket,
          providerName === "codex"
            ? `rollout-${id}.jsonl`
            : providerName === "pi"
              ? `2026-09-09_${id}.jsonl`
              : `${id}.jsonl`,
        );
        const entries =
          providerName === "codex"
            ? [
                {
                  type: "session_meta",
                  payload: { id, cwd: projectPath, timestamp },
                },
                {
                  type: "event_msg",
                  timestamp,
                  payload: { type: "user_message", message: "Retained prompt" },
                },
              ]
            : providerName === "pi"
              ? [
                  {
                    type: "session",
                    version: 3,
                    id,
                    cwd: projectPath,
                    timestamp,
                  },
                  {
                    type: "message",
                    id: "u1",
                    parentId: null,
                    timestamp,
                    message: { role: "user", content: "Retained prompt" },
                  },
                ]
              : [
                  {
                    type: "user",
                    uuid: "u1",
                    parentUuid: null,
                    sessionId: id,
                    cwd: projectPath,
                    timestamp,
                    message: { role: "user", content: "Retained prompt" },
                  },
                ];
        await writeFile(
          filePath,
          `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`,
        );
        return filePath;
      };
      await writeSession(sourceId);
      const makeReader = () =>
        providerName === "codex"
          ? new CodexSessionReader({ sessionsDir, projectPath })
          : providerName === "pi"
            ? new PiSessionReader({ sessionsDir, projectPath })
            : new ClaudeSessionReader({ sessionDir: sessionsDir });
      const primary = makeReader();
      const secondary = makeReader();
      for (const reader of [primary, secondary]) {
        expect(await reader.getSession(sourceId, project.id)).not.toBeNull();
      }
      const pi = new PiProvider({ sessionsDir });
      const forkSession = vi.fn(
        async (
          options: Parameters<NonNullable<AgentProvider["forkSession"]>>[0],
        ) => {
          if (providerName === "pi") return pi.forkSession(options);
          const sessionId = randomUUID();
          const filePath = await writeSession(sessionId);
          // Claude has no discovery hint: its reader probes the filename directly.
          return providerName === "claude"
            ? { nativeSessionId: parseNativeSessionId(sessionId) }
            : { nativeSessionId: parseNativeSessionId(sessionId), filePath };
        },
      );
      const metadata = createTestSessionMetadataService(join(dir, "metadata"));
      await metadata.initialize();
      const settings = {
        permissionMode: "bypassPermissions" as const,
        requestedModel: "source-model",
        serviceTier: "priority",
        thinking: { type: "adaptive" as const },
        effort: "high" as const,
      };
      await metadata.recordEffectiveLaunchSettings(sourceId, settings);
      const sourceMetadata = metadata.getMetadata(sourceId);
      const supervisor = new Supervisor({
        sessionMetadataService: metadata,
        provider: {
          name: providerName,
          forkSession,
        } as unknown as AgentProvider,
      });
      const resume = vi.spyOn(supervisor, "resumeSession");
      const routes = createSessionsRoutes({
        supervisor,
        sessionMetadataService: metadata,
        scanner: {
          getOrCreateProject: async () => project,
        } as unknown as SessionsDeps["scanner"],
        readerFactory: () => primary,
        ...(providerName === "codex"
          ? { codexReaderFactory: () => secondary as CodexSessionReader }
          : {}),
        ...(providerName === "pi"
          ? { piReaderFactory: () => secondary as PiSessionReader }
          : {}),
      });
      const sourceParse =
        providerName === "codex"
          ? (primary as CodexSessionReader).getEntryCacheStats()
          : undefined;
      const response = await routes.request(
        `/projects/${project.id}/sessions/${sourceId}/fork`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ forkKind: "clone-latest-complete" }),
        },
      );
      expect(response.status).toBe(200);
      const fork = (await response.json()) as { sessionId: string };
      expect(fork).not.toHaveProperty("filePath");
      if (sourceParse) {
        expect((primary as CodexSessionReader).getEntryCacheStats()).toEqual(
          sourceParse,
        );
      }
      const opened = await routes.request(
        `/projects/${project.id}/sessions/${fork.sessionId}`,
      );
      expect(opened.status).toBe(200);
      const body = (await opened.json()) as {
        messages: unknown[];
        session: { effectiveLaunchSettings?: unknown };
      };
      expect(JSON.stringify(body.messages)).toContain("Retained prompt");
      expect(body.session.effectiveLaunchSettings).toMatchObject(settings);
      expect(metadata.getEffectiveLaunchSettings(sourceId)).toEqual(
        sourceMetadata?.effectiveLaunchSettings,
      );
      expect(forkSession).toHaveBeenCalledWith(
        expect.objectContaining({ launchSettings: settings }),
      );
      const metadataResponse = await routes.request(
        `/projects/${project.id}/sessions/${fork.sessionId}/metadata`,
      );
      expect(metadataResponse.status).toBe(200);
      // A warm reader and a reader created after the fork both find it without
      // any watcher, timeout, cache invalidation, or second provider request.
      for (const reader of [primary, secondary, makeReader()]) {
        expect(await reader.getSessionFilePath?.(fork.sessionId)).toBeTruthy();
      }
      expect(forkSession).toHaveBeenCalledTimes(1);
      expect(resume).not.toHaveBeenCalled();
    });
  }
});
