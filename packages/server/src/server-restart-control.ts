let stopping = false;
let recoveringQueues = false;
let restartHandler: (() => void) | undefined;

export function isServerStopping(): boolean {
  return stopping;
}

export function beginServerShutdown(): void {
  stopping = true;
}

export function setServerRestartHandler(handler: () => void): void {
  restartHandler = handler;
}

/** Production supervisors need the same verified cleanup as wrapper reloads. */
export function finishServerRestart(code: number): void {
  if (restartHandler) restartHandler();
  else process.exit(code);
}

// Bound by admitted write requests; shutdown joins them before inspecting queues.
let admittedWrites = 0;
let notifyDrained: (() => void) | undefined;

export function admitServerRequest(
  mutating: boolean,
): (() => void) | undefined {
  if (stopping || recoveringQueues) return undefined;
  if (!mutating) return () => {};
  admittedWrites++;
  return () => {
    admittedWrites--;
    if (admittedWrites === 0) notifyDrained?.();
  };
}

export const serverAdmissionMiddleware: import("hono").MiddlewareHandler =
  async (c, next) => {
    const release = admitServerRequest(
      !["GET", "HEAD", "OPTIONS"].includes(c.req.method),
    );
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
      notifyDrained = undefined;
      resolve(drained);
    };
    const timer = setTimeout(() => finish(false), 2_000);
    notifyDrained = () => finish(true);
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
    admittedWrites--;
    if (admittedWrites === 0) notifyDrained?.();
  }
}
