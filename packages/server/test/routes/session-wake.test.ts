import { describe, expect, it, vi } from "vitest";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { encodeProjectId } from "../../src/projects/paths.js";
import { createSessionWakeRoutes } from "../../src/routes/session-wake.js";
import { ScriptedClaudeProvider } from "../support/scripted-provider.js";
import type { ServerSettingsService } from "../../src/services/ServerSettingsService.js";
import {
  SessionWakeService,
  loadOrCreateSessionWakeSecret,
} from "../../src/services/SessionWakeService.js";
import { createApp } from "../setup/create-app.js";
import {
  closeTestDiscoveryDatabases,
  createTestSessionMetadataService,
} from "../utils/session-metadata-database.js";

function request(token: string, body: unknown): RequestInit {
  return {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  };
}

function captureWakeLogs() {
  return { warn: vi.fn(), error: vi.fn() };
}

function streamedRequest(token: string, body: string): Request {
  const encoded = new TextEncoder().encode(body);
  let offset = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset >= encoded.byteLength) {
        controller.close();
        return;
      }
      const end = Math.min(offset + 1_024, encoded.byteLength);
      controller.enqueue(encoded.slice(offset, end));
      offset = end;
    },
  });
  return new Request("http://localhost/session-1", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: stream,
    duplex: "half",
  } as RequestInit & { duplex: "half" });
}

describe("session wake route", () => {
  it("is mounted outside cookie and custom-header API authentication", async () => {
    const secret = Buffer.alloc(32, 5);
    const token = new SessionWakeService({
      secret,
      isEnabled: () => true,
      deliver: async () => ({ accepted: true }),
    }).tokenForSession("missing-session");
    const serverSettingsService = {
      getSetting: (key: string) =>
        key === "wakeTurnsEnabled" ? true : undefined,
      onSettingsChanged: () => () => undefined,
    } as unknown as ServerSettingsService;
    const logger = captureWakeLogs();
    const { app, supervisor } = createApp({
      provider: new ScriptedClaudeProvider(),
      sessionWakeSecret: secret,
      sessionWakeLogger: logger,
      serverSettingsService,
    });

    const response = await app.request(
      "/session-wake/missing-session",
      request(token, { text: "job finished" }),
    );

    expect(response.status).toBe(404);
    expect(logger.warn).toHaveBeenCalledWith(
      { sessionId: "missing-session", status: 404 },
      "SESSION_WAKE: delivery rejected",
    );

    const started = await supervisor.startSession(process.cwd(), {
      text: "initial turn",
    });
    expect("error" in started || "queued" in started).toBe(false);
    if ("error" in started || "queued" in started) return;
    try {
      const liveToken = new SessionWakeService({
        secret,
        isEnabled: () => true,
        deliver: async () => ({ accepted: true }),
      }).tokenForSession(started.sessionId);
      const liveResponse = await app.request(
        `/session-wake/${started.sessionId}`,
        request(liveToken, { text: "job finished" }),
      );

      expect(liveResponse.status).toBe(202);
    } finally {
      await started.abort();
    }
  });

  it("persists one owner-readable server secret", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "ya-session-wake-test-"));
    try {
      const first = await loadOrCreateSessionWakeSecret(dataDir);
      const second = await loadOrCreateSessionWakeSecret(dataDir);
      const secretStat = await stat(join(dataDir, "session-wake-secret"));

      expect(second).toEqual(first);
      if (process.platform !== "win32") {
        expect(secretStat.mode & 0o777).toBe(0o600);
      }
    } finally {
      await rm(dataDir, { recursive: true });
    }
  });

  it("accepts a bounded authenticated wake for an enabled session", async () => {
    const deliver = vi.fn(async () => ({ accepted: true as const }));
    const service = new SessionWakeService({
      secret: Buffer.alloc(32, 7),
      isEnabled: () => true,
      deliver,
    });
    const token = service.tokenForSession("session-1");

    const response = await createSessionWakeRoutes(service).request(
      "/session-1",
      request(token, {
        text: "job finished",
        source: "agentctl",
        jobId: "run-1",
      }),
    );

    expect(response.status).toBe(202);
    expect(deliver).toHaveBeenCalledWith({
      sessionId: "session-1",
      text: "job finished",
      source: "agentctl",
      jobId: "run-1",
    });
  });

  it("resumes an eligible cold session and rejects an archived one", async () => {
    const root = await mkdtemp(join(tmpdir(), "ya-session-wake-cold-test-"));
    const secret = Buffer.alloc(32, 11);
    const sdk = new ScriptedClaudeProvider();
    const startSession = vi.spyOn(sdk, "startSession");
    const metadata = createTestSessionMetadataService(join(root, "data"));
    await metadata.initialize();
    const projectId = encodeProjectId(homedir());
    await metadata.setWorkingProject("cold-session", projectId, projectId);
    await metadata.updateMetadata("cold-session", { wakeTurnsEnabled: true });
    await metadata.setWorkingProject("archived-session", projectId, projectId);
    await metadata.updateMetadata("archived-session", {
      archived: true,
      wakeTurnsEnabled: true,
    });
    const logger = captureWakeLogs();
    const { app, supervisor } = createApp({
      provider: sdk,
      dataDir: join(root, "app-data"),
      projectsDir: join(root, "projects"),
      sessionMetadataService: metadata,
      sessionWakeSecret: secret,
      sessionWakeLogger: logger,
    });
    const resumeSession = vi.spyOn(supervisor, "resumeSession");
    const tokens = new SessionWakeService({
      secret,
      isEnabled: () => true,
      deliver: async () => ({ accepted: true }),
    });

    try {
      const accepted = await app.request(
        "/session-wake/cold-session",
        request(tokens.tokenForSession("cold-session"), {
          text: "cold job finished",
        }),
      );
      expect(accepted.status).toBe(202);
      expect(resumeSession).toHaveBeenCalledWith("cold-session", homedir(), {
        automaticSource: "wake",
        text: "cold job finished",
      });
      expect(startSession).toHaveBeenCalledWith(
        expect.objectContaining({
          resumeSessionId: "cold-session",
        }),
      );

      const callsAfterAccepted = resumeSession.mock.calls.length;
      const rejected = await app.request(
        "/session-wake/archived-session",
        request(tokens.tokenForSession("archived-session"), {
          text: "archived job finished",
        }),
      );
      expect(rejected.status).toBe(409);
      expect(logger.warn).toHaveBeenCalledWith(
        { sessionId: "archived-session", status: 409 },
        "SESSION_WAKE: delivery rejected",
      );
      expect(resumeSession).toHaveBeenCalledTimes(callsAfterAccepted);
    } finally {
      await supervisor.getProcessForSession("cold-session")?.abort();
      closeTestDiscoveryDatabases();
      await rm(root, { recursive: true });
    }
  });

  it("rejects invalid tokens before revealing whether wake is enabled", async () => {
    const isEnabled = vi.fn(() => true);
    const deliver = vi.fn();
    const service = new SessionWakeService({
      secret: Buffer.alloc(32, 3),
      isEnabled,
      deliver,
    });

    const response = await createSessionWakeRoutes(service).request(
      "/session-1",
      request("wrong", { text: "job finished" }),
    );

    expect(response.status).toBe(401);
    expect(isEnabled).not.toHaveBeenCalled();
    expect(deliver).not.toHaveBeenCalled();
  });

  it("authenticates before declared-size rejection and streams hard bounds", async () => {
    const service = new SessionWakeService({
      secret: Buffer.alloc(32, 4),
      isEnabled: () => true,
      deliver: async () => ({ accepted: true }),
    });
    const routes = createSessionWakeRoutes(service);
    const token = service.tokenForSession("session-1");
    const declaredHeaders = {
      Authorization: `Bearer ${token}`,
      "Content-Length": "1000000",
      "Content-Type": "application/json",
    };

    const unauthorized = await routes.request("/session-1", {
      method: "POST",
      headers: { ...declaredHeaders, Authorization: "Bearer wrong" },
      body: "{}",
    });
    const declaredOverflow = await routes.request("/session-1", {
      method: "POST",
      headers: declaredHeaders,
      body: "{}",
    });
    const chunkedOverflow = await routes.fetch(
      streamedRequest(token, JSON.stringify({ text: "x".repeat(9_000) })),
    );

    expect(unauthorized.status).toBe(401);
    expect(declaredOverflow.status).toBe(413);
    expect(chunkedOverflow.status).toBe(413);
  });

  it("enforces the feature gate, payload bound, and token-bucket rate limit", async () => {
    let now = 1_000;
    let enabled = false;
    const deliver = vi.fn(async () => ({ accepted: true as const }));
    const logger = captureWakeLogs();
    const service = new SessionWakeService({
      secret: Buffer.alloc(32, 9),
      isEnabled: () => enabled,
      deliver,
      logger,
      now: () => now,
      burst: 2,
      refillMs: 60_000,
    });
    const routes = createSessionWakeRoutes(service);
    const token = service.tokenForSession("session-1");

    expect(
      (
        await routes.request(
          "/session-1",
          request(token, { text: "job finished" }),
        )
      ).status,
    ).toBe(403);
    enabled = true;
    expect(
      (
        await routes.request(
          "/session-1",
          request(token, { text: "x".repeat(2_001) }),
        )
      ).status,
    ).toBe(413);
    expect(
      (await routes.request("/session-1", request(token, { text: "first" })))
        .status,
    ).toBe(202);
    expect(
      (await routes.request("/session-1", request(token, { text: "second" })))
        .status,
    ).toBe(202);
    expect(
      (await routes.request("/session-1", request(token, { text: "third" })))
        .status,
    ).toBe(429);
    expect(logger.warn).toHaveBeenCalledWith(
      { sessionId: "session-1" },
      "SESSION_WAKE: rate limit exceeded",
    );
    now += 60_000;
    expect(
      (
        await routes.request(
          "/session-1",
          request(token, { text: "after refill" }),
        )
      ).status,
    ).toBe(202);
  });

  it("captures delivery exceptions instead of leaking expected stderr", async () => {
    const logger = captureWakeLogs();
    const failure = new Error("delivery probe");
    const service = new SessionWakeService({
      secret: Buffer.alloc(32, 12),
      isEnabled: () => true,
      deliver: async () => {
        throw failure;
      },
      logger,
    });
    const token = service.tokenForSession("session-1");

    const response = await createSessionWakeRoutes(service).request(
      "/session-1",
      request(token, { text: "job finished" }),
    );

    expect(response.status).toBe(503);
    expect(logger.error).toHaveBeenCalledWith(
      { err: failure, sessionId: "session-1" },
      "SESSION_WAKE: delivery failed",
    );
  });
});
