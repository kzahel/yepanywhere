import { ProjectQueueService } from "../../src/services/ProjectQueueService.js";
import { randomUUID } from "node:crypto";
import { NEW_SESSION_BOOTSTRAP } from "@yep-anywhere/shared";
import { join } from "node:path";
import { mkdir, writeFile, appendFile } from "node:fs/promises";
import { afterEach, expect, it } from "vitest";
import { EventBus } from "../../src/watcher/EventBus.js";
import {
  applyCollectionUpdate,
  type CollectionUpdate,
} from "@yep-anywhere/shared/collection-updates";
import type { AppResult } from "../../src/app.js";
import { RecentsService } from "../../src/recents/RecentsService.js";
import { ServerSettingsService } from "../../src/services/ServerSettingsService.js";
import { ScriptedClaudeProvider } from "../support/scripted-provider.js";
import { createApp } from "../setup/create-app.js";
import { LimitedUsersService } from "../../src/auth/LimitedUsersService.js";
import { AuthService } from "../../src/auth/AuthService.js";
import { SESSION_COOKIE_NAME } from "../../src/auth/routes.js";
import { AUTHENTICATED_SRP_TRANSPORT } from "../../src/middleware/authenticated-transport.js";
import { WS_INTERNAL_AUTHENTICATED } from "../../src/middleware/internal-auth.js";
import { encodeProjectId } from "../../src/projects/paths.js";

const apps: AppResult[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.disposeSessionReaders()));
});

it.each(["direct", "relay"])(
  "preserves %s principal filtering inside bundles and collection updates",
  async (transport) => {
    const dataDir = join(
      process.env.YEP_DATA_DIR!,
      `bootstrap-auth-${randomUUID()}`,
    );
    const projectsDir = join(dataDir, "projects");
    const projectPaths = [join(dataDir, "visible"), join(dataDir, "private")];
    for (const [index, path] of projectPaths.entries()) {
      const native = join(projectsDir, `-bootstrap-${index}`);
      await mkdir(native, { recursive: true });
      await mkdir(path, { recursive: true });
      await writeFile(
        join(native, `${index}.jsonl`),
        `${JSON.stringify({ type: "user", cwd: path, message: { content: "hello" } })}\n`,
      );
    }
    const [visibleId, privateId] = projectPaths.map(encodeProjectId);
    const projectQueueService = new ProjectQueueService({ dataDir });
    await projectQueueService.initialize();
    for (const [index, projectId] of [visibleId!, privateId!].entries())
      await projectQueueService.createItem({
        projectId,
        projectPath: projectPaths[index]!,
        creationProvenance: { surface: "api" },
        request: {
          target: { type: "new-session", provider: "claude" },
          message: { text: "queue " + projectId },
        },
      });
    const serverSettingsService = new ServerSettingsService({ dataDir });
    const recentsService = new RecentsService({ dataDir });
    const limitedUsersService = new LimitedUsersService({ dataDir });
    const authService = new AuthService({
      dataDir,
      cookieSecret: "bootstrap-test-secret",
    });
    await Promise.all([
      serverSettingsService.initialize(),
      recentsService.initialize(),
      limitedUsersService.initialize(),
      authService.initialize(),
    ]);
    await serverSettingsService.updateSettings({
      limitedUsersEnabled: true,
      lifecycleWebhookToken: "private-setting",
    });
    await limitedUsersService.create({
      username: "reader",
      password: "bootstrap-password",
      viewProjects: [visibleId!],
    });
    await authService.enableAuth("bootstrap-owner-password");
    await recentsService.recordVisit("visible-session", visibleId!);
    await recentsService.recordVisit("private-session", privateId!);
    const bus = new EventBus();
    const instance = createApp({
      provider: new ScriptedClaudeProvider(),
      dataDir,
      projectsDir,
      serverSettingsService,
      recentsService,
      limitedUsersService,
      projectQueueService,
      authService,
      authDisabled: false,
      eventBus: bus,
      getCatalogFamilies: () => ["claude"],
    });
    apps.push(instance);
    expect(
      (await instance.scanner.listProjects())
        .map((project) => project.id)
        .sort(),
    ).toEqual([visibleId, privateId].sort());
    const headers = {
      "X-Yep-Anywhere": "true",
      Accept: "text/event-stream",
      Cookie:
        transport === "direct"
          ? `${SESSION_COOKIE_NAME}=${await authService.createSession("test", "reader")}`
          : "",
    };
    const response = await instance.app.request(
      "/api/settings?bootstrap=new-session-v1",
      { headers },
      transport === "relay"
        ? {
            [WS_INTERNAL_AUTHENTICATED]: true,
            [AUTHENTICATED_SRP_TRANSPORT]: {
              kind: "srp",
              username: "reader",
              sessionId: "test-session",
            },
          }
        : undefined,
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toContain("text/event-stream");
    const text = await response.text();
    expect(text).not.toContain("private-setting");
    expect(text).not.toContain(privateId!);
    const frames = text
      .split("\n")
      .filter((line) => line.startsWith("data: "))
      .map((line) => JSON.parse(line.slice(6)));
    expect(
      frames
        .find((frame) => frame.part === "projects")
        .body.projects.map((project: { id: string }) => project.id),
    ).toEqual([visibleId]);
    expect(
      frames
        .find((frame) => frame.part === "recents")
        .body.visits.map((visit: { projectId: string }) => visit.projectId),
    ).toEqual([visibleId]);
    const ordinary = await instance.app.request(
      "/api/settings",
      { headers },
      transport === "relay"
        ? {
            [WS_INTERNAL_AUTHENTICATED]: true,
            [AUTHENTICATED_SRP_TRANSPORT]: {
              kind: "srp",
              username: "reader",
              sessionId: "test-session",
            },
          }
        : undefined,
    );
    expect(ordinary.headers.get("Content-Type")).toContain("application/json");
    expect(await ordinary.json()).toEqual(
      frames.find((frame) => frame.part === "settings").body,
    );
    const env =
      transport === "relay"
        ? {
            [WS_INTERNAL_AUTHENTICATED]: true,
            [AUTHENTICATED_SRP_TRANSPORT]: {
              kind: "srp",
              username: "reader",
              sessionId: "test-session",
            },
          }
        : undefined;
    await expect
      .poll(async () => {
        const response = await instance.app.request(
          "/api/sessions?summaryMode=retained",
          { headers },
          env,
        );
        return ((await response.json()) as { sessions: unknown[] }).sessions
          .length;
      })
      .toBe(1);
    for (const query of ["/projects?summaryMode=retained", "/project-queue"]) {
      const abort = new AbortController();
      const response = await instance.app.request(
        "/api/activity/collections?queries=" +
          encodeURIComponent(JSON.stringify([query])),
        { headers, signal: abort.signal },
        env,
      );
      expect(response.status).toBe(200);
      const reader = response.body!.getReader();
      try {
        const frame = JSON.parse(
          new TextDecoder().decode((await reader.read()).value!).trim(),
        ) as CollectionUpdate;
        const body = applyCollectionUpdate(undefined, frame).body;
        expect(
          (
            body[
              query.startsWith("/projects") ? "projects" : "items"
            ] as Array<{ id: string; projectId?: string }>
          ).map((row) => row.projectId ?? row.id),
        ).toEqual([visibleId]);
        expect(JSON.stringify(frame)).not.toContain(privateId!);
      } finally {
        abort.abort();
        await reader.cancel();
      }
    }
    const abort = new AbortController();
    const query = "/sessions?limit=20";
    const updates = await instance.app.request(
      "/api/activity/collections?queries=" +
        encodeURIComponent(JSON.stringify([query])),
      { headers, signal: abort.signal },
      env,
    );
    expect(updates.status).toBe(200);
    const reader = updates.body!.getReader();
    try {
      const frame = JSON.parse(
        new TextDecoder().decode((await reader.read()).value!).trim(),
      ) as CollectionUpdate;
      const body = applyCollectionUpdate(undefined, frame).body;
      expect(
        (body.sessions as Array<{ projectId: string }>).map(
          (row) => row.projectId,
        ),
      ).toEqual([visibleId]);
      expect(JSON.stringify(frame)).not.toContain(privateId!);
      if (transport === "direct") {
        const peerSession = await authService.createSession("peer", "reader");
        const peerHeaders = {
          ...headers,
          Cookie: `${SESSION_COOKIE_NAME}=${peerSession}`,
        };
        const peerAbort = new AbortController();
        const peer = await instance.app.request(
          "/api/activity/collections?queries=" +
            encodeURIComponent(JSON.stringify([query])),
          { headers: peerHeaders, signal: peerAbort.signal },
        );
        expect(peer.status).toBe(200);
        const peerReader = peer.body!.getReader();
        try {
          expect((await peerReader.read()).done).toBe(false);
          await authService.invalidateSession(peerSession);
          const file = join(projectsDir, "-bootstrap-0", "0.jsonl");
          const at = new Date(Date.now() + 1000).toISOString();
          await appendFile(
            file,
            JSON.stringify({
              type: "assistant",
              uuid: "authorized-tail",
              timestamp: at,
              message: {
                role: "assistant",
                content: [{ type: "text", text: "Fresh authorized output" }],
              },
            }) + "\n",
          );
          bus.emit({
            type: "file-change",
            provider: "claude",
            path: file,
            relativePath: "-bootstrap-0/0.jsonl",
            changeType: "modify",
            fileType: "session",
            timestamp: at,
          });
          expect((await peerReader.read()).done).toBe(true);
          // A second credential's retirement cannot retire this healthy view.
          let changed = false;
          while (!changed) {
            const chunk = await reader.read();
            expect(chunk.done).toBe(false);
            const frame = JSON.parse(
              new TextDecoder().decode(chunk.value!).trim(),
            ) as CollectionUpdate;
            changed = frame.upserts.some(([, row]) => row.updatedAt === at);
          }
        } finally {
          peerAbort.abort();
          await peerReader.cancel();
        }
      }
      const forbidden = await instance.app.request(
        "/api/activity/collections?queries=" +
          encodeURIComponent(JSON.stringify(["/settings"])),
        { headers },
        env,
      );
      expect(forbidden.status).toBe(400);
      expect(
        (await instance.app.request("/api/activity/status", { headers }, env))
          .status,
      ).toBe(403);
    } finally {
      abort.abort();
      await reader.cancel();
    }
  },
);

it("streams prepared route facts while version discovery is held", async () => {
  expect(NEW_SESSION_BOOTSTRAP).toBe("new-session-v1");
  const dataDir = join(process.env.YEP_DATA_DIR!, `bootstrap-${randomUUID()}`);
  const projectsDir = join(dataDir, "projects");
  await mkdir(projectsDir, { recursive: true });
  const serverSettingsService = new ServerSettingsService({ dataDir });
  const recentsService = new RecentsService({ dataDir });
  await Promise.all([
    serverSettingsService.initialize(),
    recentsService.initialize(),
  ]);
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const instance = createApp({
    provider: new ScriptedClaudeProvider(),
    dataDir,
    serverSettingsService,
    recentsService,
    getLatestVersion: async () => {
      await held;
      return null;
    },
    projectsDir,
  });
  apps.push(instance);
  try {
    const response = await instance.app.request(
      "/api/settings?bootstrap=new-session-v1",
      {
        headers: { "X-Yep-Anywhere": "true", Accept: "text/event-stream" },
      },
    );
    expect(
      response.headers.get("Content-Type"),
      response.headers.get("Content-Type")?.includes("application/json")
        ? await response.text()
        : undefined,
    ).toContain("text/event-stream");
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let text = "";
    const frames: { part: string; status: number; body: unknown }[] = [];
    while (
      !["settings", "projects", "recents"].every((part) =>
        frames.some((frame) => frame.part === part),
      )
    ) {
      const next = await reader.read();
      expect(next.done).toBe(false);
      text += decoder.decode(next.value, { stream: true });
      let end = text.indexOf("\n\n");
      while (end !== -1) {
        const frame = text.slice(0, end);
        text = text.slice(end + 2);
        const data = frame
          .split("\n")
          .find((line) => line.startsWith("data: "));
        if (data) frames.push(JSON.parse(data.slice(6)));
        end = text.indexOf("\n\n");
      }
    }
    expect(frames.find((frame) => frame.part === "version")).toBeUndefined();
    expect(frames.find((frame) => frame.part === "projects")).toMatchObject({
      status: 200,
      // Initial retained rows may precede or include the scanner's Home fallback.
      // This contract is availability while version is held, not discovery order.
      body: { projects: expect.any(Array) },
    });
    expect(frames.find((frame) => frame.part === "recents")).toMatchObject({
      status: 200,
      body: { visits: [] },
    });
    release();
    while (!(await reader.read()).done) {
      /* Drain the finite bundle. */
    }
  } finally {
    release();
  }
});

it("preserves desktop query authentication through canonical collection reads", async () => {
  const dataDir = join(
    process.env.YEP_DATA_DIR!,
    "collection-desktop-" + randomUUID(),
  );
  const authService = new AuthService({
    dataDir,
    cookieSecret: "desktop-collection-test",
  });
  await authService.initialize();
  await authService.enableAuth("owner-collection-password");
  const instance = createApp({
    dataDir,
    authService,
    authDisabled: false,
    desktopAuthToken: "desktop-collection-token",
    eventBus: new EventBus(),
  });
  apps.push(instance);
  const path =
    "/api/activity/collections?queries=" +
    encodeURIComponent(JSON.stringify(["/sessions?limit=20"]));
  const abort = new AbortController();
  const response = await instance.app.request(
    path + "&desktop_token=desktop-collection-token",
    { signal: abort.signal, headers: { "X-Yep-Anywhere": "true" } },
  );
  expect(response.status).toBe(200);
  const reader = response.body!.getReader();
  try {
    const first = await reader.read();
    expect(first.done).toBe(false);
    const frame = JSON.parse(
      new TextDecoder().decode(first.value!).trim(),
    ) as CollectionUpdate;
    expect(applyCollectionUpdate(undefined, frame).body.sessions).toEqual([]);
    expect(
      (
        await instance.app.request(path + "&desktop_token=wrong", {
          headers: { "X-Yep-Anywhere": "true" },
        })
      ).status,
    ).toBe(401);
  } finally {
    abort.abort();
    await reader.cancel();
  }
});
