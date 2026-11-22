import { upgradeWebSocket } from "@hono/node-server";
import { Hono } from "hono";
import { expect, it, vi } from "vitest";
import { createSpeechRoutes } from "../../src/routes/speech.js";
import { triggerSafeServerRestart } from "../../src/safe-server-restart.js";
import {
  serverAdmissionMiddleware,
  setServerRestartHandler,
} from "../../src/server-restart-control.js";
import { SafeRestartService } from "../../src/services/SafeRestartService.js";
import { SpeechBackendRegistry } from "../../src/services/voice/registry.js";
import { EventBus } from "../../src/watcher/EventBus.js";

it("allows the speech restart request to commit through the server write fence", async () => {
  vi.stubEnv("YEP_SERVER_GENERATION", "");
  const committed = vi.fn();
  setServerRestartHandler(committed);
  const safeRestartService = new SafeRestartService({
    eventBus: new EventBus(),
    getWorkerActivity: () => ({
      activeWorkers: 0,
      queueLength: 0,
      hasActiveWork: false,
    }),
    restart: (canCommit) =>
      triggerSafeServerRestart({
        canCommit,
        stopBackgroundTasks: async () => {},
      }),
  });
  const app = new Hono();
  app.use("*", serverAdmissionMiddleware);
  app.route(
    "/api/speech",
    createSpeechRoutes({
      safeRestartService,
      speechBackendRegistry: new SpeechBackendRegistry(),
      upgradeWebSocket,
    }),
  );
  try {
    const response = await app.request("/api/speech/backends/restart", {
      method: "POST",
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ status: "restarting" });
    expect(committed).toHaveBeenCalledExactlyOnceWith("restart");
  } finally {
    safeRestartService.dispose();
    vi.unstubAllEnvs();
  }
});
