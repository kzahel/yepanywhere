import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DraftRead } from "@yep-anywhere/shared";
import { SERVER_CAPABILITIES, serverHasCapability } from "@yep-anywhere/shared";
import type { AppResult } from "../../src/app.js";
import { ScriptedClaudeProvider } from "../support/scripted-provider.js";
import { createApp } from "./create-app.js";

const apps: AppResult[] = [];
const slot = { kind: "new-session" };

afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(apps.splice(0).map((app) => app.disposeSessionReaders()));
});

function fixture(overrides: { dataDir?: string } = {}): AppResult {
  const app = createApp({
    provider: new ScriptedClaudeProvider(),
    projectsDir: join(process.env.YEP_DATA_DIR!, "empty-projects"),
    ...overrides,
  });
  apps.push(app);
  return app;
}

async function readDraft(app: AppResult): Promise<DraftRead> {
  const response = await app.app.request("/api/drafts/read", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Yep-Anywhere": "true",
    },
    body: JSON.stringify({ slot }),
  });
  expect(response.status).toBe(200);
  return response.json();
}

async function writeDraft(app: AppResult): Promise<void> {
  const read = await readDraft(app);
  const response = await app.app.request("/api/drafts/write", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Yep-Anywhere": "true",
    },
    body: JSON.stringify({
      slot,
      ticket: read.ticket,
      baseRevision: read.snapshot.revision,
      operationId: randomUUID(),
      payload: {
        fields: { text: "Owned by the first fixture" },
        attachments: [],
      },
    }),
  });
  expect(response.status).toBe(200);
}

describe("full-app test fixture storage", () => {
  it("answers version requests without contacting an external update service", async () => {
    const network = vi.fn(() => {
      throw new Error("Unexpected external fetch");
    });
    vi.stubGlobal("fetch", network);
    const app = fixture();
    const response = await app.app.request("/api/version?fresh=true");
    expect(response.status).toBe(200);
    const version = await response.json();
    expect(version).toMatchObject({
      latest: null,
      updateAvailable: false,
    });
    expect(
      serverHasCapability(version, SERVER_CAPABILITIES.projectSessionDefaults),
    ).toBe(false);
    expect(network).not.toHaveBeenCalled();
  });

  it("stops supervisor automation before closing the app's storage", async () => {
    const app = fixture();
    app.stopNotifications();
    expect(app.supervisor.getMaintenanceScheduleMetrics().armedAtMs).toBeNull();
    await app.disposeSessionReaders();
    apps.splice(apps.indexOf(app), 1);
    expect(app.supervisor.getMaintenanceScheduleMetrics().armedAtMs).toBeNull();
  });

  it("joins concurrent and repeated disposal before removing fixture storage", async () => {
    const app = fixture();
    const close = vi.spyOn(app.artifactServer, "close");
    const first = app.disposeSessionReaders();
    expect(app.disposeSessionReaders()).toBe(first);
    await first;
    expect(app.disposeSessionReaders()).toBe(first);
    await app.artifactServer.ready;
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("does not let a default fixture read another fixture's draft", async () => {
    const first = fixture();
    await writeDraft(first);
    const second = fixture({ dataDir: undefined });
    expect((await readDraft(first)).snapshot.payload.fields.text).toBe(
      "Owned by the first fixture",
    );
    expect((await readDraft(second)).snapshot.payload.fields).toEqual({});
  });

  it("preserves an explicit shared data directory for restart tests", async () => {
    const dataDir = join(process.env.YEP_DATA_DIR!, "explicit-shared-data");
    const first = fixture({ dataDir });
    await writeDraft(first);
    const second = fixture({ dataDir });
    expect((await readDraft(second)).snapshot.payload.fields.text).toBe(
      "Owned by the first fixture",
    );
  });
});
