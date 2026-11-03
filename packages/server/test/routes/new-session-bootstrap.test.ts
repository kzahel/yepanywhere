import { randomUUID } from "node:crypto";
import { NEW_SESSION_BOOTSTRAP } from "@yep-anywhere/shared";
import { join } from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { afterEach, expect, it } from "vitest";
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
  "preserves %s principal filtering inside every bundle part",
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
    const instance = createApp({
      provider: new ScriptedClaudeProvider(),
      dataDir,
      projectsDir,
      serverSettingsService,
      recentsService,
      limitedUsersService,
      authService,
      authDisabled: false,
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
