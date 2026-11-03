import { randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import type { AppResult } from "../../src/app.js";
import { ProjectScanner } from "../../src/projects/scanner.js";
import { ScriptedClaudeProvider } from "../support/scripted-provider.js";
import type { Project } from "../../src/supervisor/types.js";
import { createApp } from "../setup/create-app.js";

const apps: AppResult[] = [];
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.disposeSessionReaders()));
  vi.restoreAllMocks();
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true })),
  );
});

it("prepares project discovery at startup before any client request", async () => {
  const root = join(
    process.env.YEP_DATA_DIR!,
    `startup-projects-${randomUUID()}`,
  );
  roots.push(root);
  const projectsDir = join(root, "projects");
  const nativeDir = join(projectsDir, "-home-user-recent");
  await mkdir(nativeDir, { recursive: true });
  await writeFile(
    join(nativeDir, "session.jsonl"),
    `${JSON.stringify({ type: "user", cwd: "/home/user/recent", message: { content: "hello" } })}\n`,
  );
  const app = createApp({
    provider: new ScriptedClaudeProvider(),
    projectsDir,
  });
  apps.push(app);
  await vi.waitFor(() => {
    expect(app.scanner.cachedProjects()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: "/home/user/recent", sessionCount: 1 }),
      ]),
    );
  });
});

it("restores saved projects during startup while reconciliation is blocked", async () => {
  const root = join(
    process.env.YEP_DATA_DIR!,
    `restart-projects-${randomUUID()}`,
  );
  roots.push(root);
  const projectsDir = join(root, "projects");
  const nativeDir = join(projectsDir, "-home-user-recent");
  await mkdir(nativeDir, { recursive: true });
  await writeFile(
    join(nativeDir, "session.jsonl"),
    `${JSON.stringify({ type: "user", cwd: "/home/user/recent", message: { content: "hello" } })}\n`,
  );
  const options = {
    provider: new ScriptedClaudeProvider(),
    projectsDir,
    dataDir: join(root, "data"),
  };
  const first = createApp(options);
  apps.push(first);
  await vi.waitFor(() =>
    expect(first.scanner.cachedProjects()).toHaveLength(1),
  );
  await first.disposeSessionReaders();

  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  vi.spyOn(
    ProjectScanner.prototype as unknown as {
      scanProjects: () => Promise<Project[]>;
    },
    "scanProjects",
  ).mockImplementationOnce(async () => {
    await gate;
    throw new Error("injected reconciliation failure");
  });
  const restored = createApp(options);
  apps.push(restored);
  try {
    await vi.waitFor(() =>
      expect(restored.scanner.cachedProjects()).toEqual([
        expect.objectContaining({ path: "/home/user/recent", sessionCount: 1 }),
      ]),
    );
  } finally {
    release();
    await restored.disposeSessionReaders();
  }
});
