import { randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { toUrlProjectId } from "@yep-anywhere/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppResult } from "../../src/app.js";
import { AuthService } from "../../src/auth/AuthService.js";
import { LimitedUsersService } from "../../src/auth/LimitedUsersService.js";
import { SESSION_COOKIE_NAME } from "../../src/auth/routes.js";
import { ScriptedClaudeProvider } from "../support/scripted-provider.js";
import { ServerSettingsService } from "../../src/services/ServerSettingsService.js";
import { seedTestCatalog } from "../utils/session-catalog.js";
import type { SessionCatalogRow } from "../../src/sessions/catalog-types.js";
import type { SessionSeenEvent } from "../../src/watcher/EventBus.js";
import { createApp } from "../setup/create-app.js";
import {
  closeTestDiscoveryDatabases,
  createTestSessionMetadataService,
} from "../utils/session-metadata-database.js";

/**
 * Session-scoped limited-user decisions read the session catalog the app
 * itself keeps, through `createApp`: an idle session with no process and no
 * pinned project resolves to its project, the join-freshness rule sees its
 * real last activity, and a join needs the sandbox its last launch recorded.
 * topics/limited-users.md § Delivery v1 — Freshness, Authorization.
 */
describe("limited-user session access through the app's session catalog", () => {
  const projectPath = "/home/user/granted";
  const projectId = toUrlProjectId(projectPath);
  const sessionId = "idle-session";
  // Idle sessions the superuser left behind, none of them running now.
  const minutesAgo = (minutes: number) =>
    new Date(Date.now() - minutes * 60 * 1000).toISOString();
  const seededSessions = [
    // Well past Claude's believed 60-minute cache-warm window.
    { sessionId, lastActivity: minutesAgo(180), sandboxed: true },
    {
      sessionId: "fresh-sandboxed",
      lastActivity: minutesAgo(1),
      sandboxed: true,
    },
    {
      sessionId: "fresh-unsandboxed",
      lastActivity: minutesAgo(1),
      sandboxed: false,
    },
    {
      sessionId: "fresh-firewall-off",
      lastActivity: minutesAgo(1),
      sandboxed: true,
      networkFirewall: false,
    },
  ];

  let testDir: string;
  let instance: AppResult;
  let limitedCookie: string;
  let starterCookie: string;

  beforeEach(async () => {
    testDir = join(tmpdir(), `session-access-app-${randomUUID()}`);
    const dataDir = join(testDir, "data");
    const projectsDir = join(testDir, "claude");
    const encodedPath = projectPath.replace(/[/\\:]/g, "-");
    await mkdir(dataDir, { recursive: true });
    await mkdir(join(projectsDir, "localhost", encodedPath), {
      recursive: true,
    });
    const sessionMetadataService = createTestSessionMetadataService(dataDir);
    await sessionMetadataService.initialize();
    for (const seeded of seededSessions) {
      await writeFile(
        join(
          projectsDir,
          "localhost",
          encodedPath,
          `${seeded.sessionId}.jsonl`,
        ),
        `${JSON.stringify({
          type: "user",
          cwd: projectPath,
          sessionId: seeded.sessionId,
          timestamp: seeded.lastActivity,
          message: { role: "user", content: "Hello" },
        })}\n`,
      );
      if (seeded.sandboxed) {
        await sessionMetadataService.setSessionSandbox(seeded.sessionId, {
          level: "project-write",
          networkFirewall: seeded.networkFirewall,
          projectPath,
          projectId,
        });
      }
    }

    // The durable catalog a previous run left behind.
    const rows: SessionCatalogRow[] = seededSessions.map((seeded) => ({
      catalogFamily: "claude",
      storeKey: "seed",
      sessionId: seeded.sessionId,
      projectId,
      projectPath,
      projectIdentityKey: projectPath,
      updatedAt: seeded.lastActivity,
      fidelity: "head",
      sourceVersion: "v1",
      location: { kind: "provider", recordId: seeded.sessionId },
    }));
    await seedTestCatalog(dataDir, [
      {
        catalogFamily: "claude",
        storeKey: "seed",
        scan: async () => ({ sourceVersion: "v1", rows }),
      },
    ]);

    const authService = new AuthService({
      dataDir,
      cookieSecret: "session-access-app-secret",
    });
    await authService.initialize();
    await authService.enableAuth("superuser-password");
    limitedCookie = `${SESSION_COOKIE_NAME}=${await authService.createSession("bob", "bob")}`;

    const limitedUsersService = new LimitedUsersService({ dataDir });
    await limitedUsersService.initialize();
    await limitedUsersService.create({
      username: "bob",
      password: "correct-horse-battery",
      joinProjects: [projectId],
      joinStaleOffsetMinutes: 0,
    });
    // Carol started the cold session herself and may start new ones here.
    starterCookie = `${SESSION_COOKIE_NAME}=${await authService.createSession("carol", "carol")}`;
    await limitedUsersService.create({
      username: "carol",
      password: "correct-horse-battery",
      newSessionProjects: [projectId],
      joinStaleOffsetMinutes: 0,
    });
    await sessionMetadataService.recordSessionCreator(sessionId, "carol");
    const serverSettingsService = new ServerSettingsService({ dataDir });
    await serverSettingsService.initialize();
    await serverSettingsService.updateSettings({ limitedUsersEnabled: true });

    instance = createApp({
      provider: new ScriptedClaudeProvider(),
      dataDir,
      projectsDir,
      getCatalogFamilies: () => ["claude"],
      authService,
      authDisabled: false,
      limitedUsersService,
      serverSettingsService,
      sessionMetadataService,
    });
  });

  const postTurn = (id: string) =>
    instance.app.request(`/api/sessions/${id}/messages`, {
      method: "POST",
      headers: { Cookie: limitedCookie, "X-Yep-Anywhere": "true" },
    });

  it("refuses a turn to a fresh session that runs outside the sandbox", async () => {
    const response = await postTurn("fresh-unsandboxed");
    expect(response.status).toBe(403);
    expect(((await response.json()) as { reason?: string }).reason).toBe(
      "unsandboxed-session",
    );
  });

  it("refuses a turn to a fresh sandboxed session whose firewall is off", async () => {
    const response = await postTurn("fresh-firewall-off");
    expect(response.status).toBe(403);
    expect(((await response.json()) as { reason?: string }).reason).toBe(
      "unsandboxed-session",
    );
  });

  it("passes a turn to a fresh sandboxed session through to the route", async () => {
    // Allowed by the policy; the route itself answers that nothing is running.
    const response = await postTurn("fresh-sandboxed");
    expect(response.status).toBe(404);
    expect(((await response.json()) as { error?: string }).error).toBe(
      "No active process for session",
    );
  });

  afterEach(async () => {
    await instance.disposeSessionReaders();
    closeTestDiscoveryDatabases();
    await rm(testDir, { recursive: true, force: true });
  });

  it("refuses a turn to an idle session whose last activity is cold", async () => {
    const response = await postTurn(sessionId);
    expect(response.status).toBe(403);
    expect(((await response.json()) as { reason?: string }).reason).toBe(
      "stale-session",
    );
  });

  it("holds the user who started a cold session to the cutoff, with a redirect", async () => {
    for (const path of [
      `/api/sessions/${sessionId}/messages`,
      `/api/projects/${projectId}/sessions/${sessionId}/resume`,
    ]) {
      const response = await instance.app.request(path, {
        method: "POST",
        headers: {
          Cookie: starterCookie,
          "X-Yep-Anywhere": "true",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ message: "what is a volcano?" }),
      });
      expect(response.status, path).toBe(403);
      expect(await response.json(), path).toMatchObject({
        reason: "stale-session",
        staleRedirect: "stale-handoff",
      });
    }
  });

  it("lets a user with a grant on its project subscribe to an idle session", async () => {
    await expect(
      instance.authorizeSubscription({
        username: "bob",
        target: { kind: "scoped", projectIds: [], sessionIds: [sessionId] },
      }),
    ).resolves.toBe(true);
    await expect(
      instance.authorizeSubscription({
        username: "bob",
        target: {
          kind: "scoped",
          projectIds: [],
          sessionIds: ["no-such-session"],
        },
      }),
    ).resolves.toBe(false);
  });

  it("shows an idle session's activity once the catalog has been read", async () => {
    const event: SessionSeenEvent = {
      type: "session-seen",
      sessionId,
      timestamp: new Date().toISOString(),
    };
    // The first event starts the catalog read rather than waiting on it.
    instance.activityEventForIdentity("bob", event);
    await vi.waitFor(() => {
      expect(instance.activityEventForIdentity("bob", event)).toEqual(event);
    });
  });
});
