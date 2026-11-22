import { requestDevWrapperSafeReload } from "./dev-wrapper-client.js";
import {
  beginServerShutdown,
  drainServerRequests,
  fenceServerWritesForRestart,
  finishServerRestart,
  isServerStopping,
} from "./server-restart-control.js";

export async function triggerSafeServerRestart(options: {
  canCommit: () => boolean;
  flush?: () => Promise<void> | void;
  stopBackgroundTasks: () => Promise<void>;
}): Promise<boolean> {
  await options.flush?.();
  const commit = async (
    kind: "restart" | "SIGHUP",
    signal?: AbortSignal,
  ): Promise<boolean> => {
    const release = fenceServerWritesForRestart();
    if (!release) return false;
    try {
      if (
        !(await drainServerRequests()) ||
        signal?.aborted ||
        isServerStopping() ||
        !options.canCommit()
      )
        return false;
      // No awaits between the authoritative snapshot and closing admission.
      beginServerShutdown();
      void options.stopBackgroundTasks();
      console.log("[Shutdown] Committed scheduled safe restart");
      finishServerRestart(0, kind);
      return true;
    } finally {
      release();
    }
  };
  let prepared = false;
  const requested = await requestDevWrapperSafeReload((signal) => {
    prepared = true;
    return commit("SIGHUP", signal);
  });
  return prepared ? requested : commit("restart");
}
