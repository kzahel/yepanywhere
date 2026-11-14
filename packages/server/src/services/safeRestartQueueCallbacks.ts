import type { ProjectQueueService } from "./ProjectQueueService.js";
import type { QueueRestartHandoff } from "./QueueRestartHandoff.js";
import type { SafeRestartServiceOptions } from "./SafeRestartService.js";

export function safeRestartQueueCallbacks(options: {
  projectQueueService?: ProjectQueueService;
  queueRestartHandoff?: QueueRestartHandoff;
}): Pick<
  SafeRestartServiceOptions,
  "pauseProjectQueueDispatch" | "resumeProjectQueueDispatch"
> {
  return {
    pauseProjectQueueDispatch: async () => {
      if (options.queueRestartHandoff)
        return options.queueRestartHandoff.pauseProjectQueue();
      const service = options.projectQueueService;
      if (!service || service.listAll().length === 0) return false;
      if (service.isDispatchPaused()) return false;
      await service.pauseDispatch("restart");
      return true;
    },
    resumeProjectQueueDispatch: async () => {
      if (options.queueRestartHandoff)
        return options.queueRestartHandoff.cancelScheduledRestart();
      const service = options.projectQueueService;
      if (!service) return;
      const dispatchState = service.getDispatchState();
      if (
        dispatchState.status === "paused" &&
        dispatchState.reason === "restart"
      ) {
        await service.resumeDispatch();
      }
    },
  };
}
