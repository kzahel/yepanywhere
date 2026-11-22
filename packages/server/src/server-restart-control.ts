let stopping = false;
let recoveringQueues = false;
let safeRestartFence: symbol | undefined;
let restartHandler: ((kind: "restart" | "SIGHUP") => void) | undefined;

export function isServerStopping(): boolean {
  return stopping;
}

export function beginServerShutdown(): void {
  stopping = true;
}

export function setServerRestartHandler(
  handler: (kind: "restart" | "SIGHUP") => void,
): void {
  restartHandler = handler;
}

/** Production supervisors need the same verified cleanup as wrapper reloads. */
export function finishServerRestart(
  code: number,
  kind: "restart" | "SIGHUP" = "restart",
): void {
  if (restartHandler) restartHandler(kind);
  else process.exit(code);
}

// Bound by admitted write requests; shutdown joins them before inspecting queues.
let admittedWrites = 0;
const writeDrainWaiters = new Set<() => void>();

export function fenceServerWritesForRestart(): (() => void) | undefined {
  if (stopping || recoveringQueues || safeRestartFence) return undefined;
  const fence = Symbol();
  safeRestartFence = fence;
  return () => {
    if (safeRestartFence === fence) safeRestartFence = undefined;
  };
}

function releaseWrite(): void {
  admittedWrites--;
  if (admittedWrites === 0) for (const notify of writeDrainWaiters) notify();
}

export function admitServerRequest(
  mutating: boolean,
): (() => void) | undefined {
  if (stopping || recoveringQueues || (mutating && safeRestartFence))
    return undefined;
  if (!mutating) return () => {};
  admittedWrites++;
  return releaseWrite;
}

export const serverAdmissionMiddleware: import("hono").MiddlewareHandler =
  async (c, next) => {
    // The safe-restart controller may wait for admitted writes, so its own
    // schedule/cancel requests must not count towards the drain.
    const mutating =
      c.req.path !== "/api/dev/safe-restart" &&
      c.req.path !== "/api/speech/backends/restart" &&
      !["GET", "HEAD", "OPTIONS"].includes(c.req.method);
    const release = admitServerRequest(mutating);
    if (!release) return c.json({ error: "Server is restarting" }, 503);
    try {
      await next();
    } finally {
      release();
    }
  };

export async function drainServerRequests(): Promise<boolean> {
  if (admittedWrites === 0) return true;
  return new Promise((resolve) => {
    const finish = (drained: boolean) => {
      clearTimeout(timer);
      writeDrainWaiters.delete(notify);
      resolve(drained);
    };
    const notify = () => finish(true);
    const timer = setTimeout(() => finish(false), 2_000);
    writeDrainWaiters.add(notify);
  });
}

/** Keep client mutation/recovery ordering closed until startup has succeeded. */
export function holdQueueRecoveryAdmission(pending: boolean): void {
  recoveringQueues = pending;
}

export async function completeQueueRecovery(
  recover: () => Promise<void>,
): Promise<void> {
  if (stopping) return;
  admittedWrites++;
  try {
    await recover();
  } finally {
    recoveringQueues = false;
    releaseWrite();
  }
}
