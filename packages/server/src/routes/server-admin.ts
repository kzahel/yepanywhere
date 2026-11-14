import { Hono } from "hono";
import { finishServerRestart } from "../server-restart-control.js";
import { requestDevWrapperReload } from "../dev-wrapper-client.js";
import { markDevReloadRequested } from "../dev-reload-signal.js";
import type { NotificationService } from "../notifications/index.js";
import type { Supervisor } from "../supervisor/Supervisor.js";

export interface ServerAdminDeps {
  supervisor: Supervisor;
  notificationService?: NotificationService;
  beforeRestart?: () => void | Promise<void>;
}

export interface TriggerServerRestartOptions {
  notificationService?: NotificationService;
  beforeRestart?: () => void | Promise<void>;
  beforeRestartTimeoutMs?: number;
  exit?: (code: number) => void;
  exitDelayMs?: number;
  requestWrapperReload?: () => Promise<boolean>;
}

const DEFAULT_RESTART_CLEANUP_TIMEOUT_MS = 1000;

async function runBeforeRestart(
  beforeRestart: (() => void | Promise<void>) | undefined,
  timeoutMs: number,
): Promise<void> {
  if (!beforeRestart) return;

  let timeout: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;
  const cleanup = Promise.resolve().then(beforeRestart);
  cleanup.catch((error) => {
    if (timedOut) {
      console.warn(
        "[ServerAdmin] Restart cleanup failed after timeout:",
        error,
      );
    }
  });

  try {
    await Promise.race([
      cleanup,
      new Promise<void>((resolve) => {
        timeout = setTimeout(
          () => {
            timedOut = true;
            console.warn("[ServerAdmin] Restart cleanup timed out");
            resolve();
          },
          Math.max(0, timeoutMs),
        );
      }),
    ]);
  } catch (error) {
    console.warn("[ServerAdmin] Restart cleanup failed:", error);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

export async function triggerServerRestart({
  notificationService,
  beforeRestart,
  beforeRestartTimeoutMs = DEFAULT_RESTART_CLEANUP_TIMEOUT_MS,
  exit = finishServerRestart,
  exitDelayMs = 100,
  requestWrapperReload = requestDevWrapperReload,
}: TriggerServerRestartOptions = {}): Promise<void> {
  await notificationService?.flush();
  await runBeforeRestart(beforeRestart, beforeRestartTimeoutMs);
  if (await requestWrapperReload()) return;
  markDevReloadRequested();

  // Process supervisor (scripts/dev.js, systemd, pm2) will restart the process.
  setTimeout(() => {
    exit(0);
  }, exitDelayMs);
}

/**
 * Administrative routes for server management.
 * Always mounted (not dev-mode-only), so remote relay clients can use them.
 */
export function createServerAdminRoutes(deps: ServerAdminDeps): Hono {
  const routes = new Hono();

  // POST /api/server/restart - Trigger graceful server restart
  routes.post("/restart", async (c) => {
    console.log("[ServerAdmin] Restart requested via API");

    await triggerServerRestart({
      notificationService: deps.notificationService,
      beforeRestart: deps.beforeRestart,
    });

    // Respond before exiting
    const response = c.json({
      ok: true,
      message: "Server restarting...",
    });

    return response;
  });

  return routes;
}
