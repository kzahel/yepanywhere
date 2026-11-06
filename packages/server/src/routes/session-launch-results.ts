import type { Process } from "../supervisor/Process.js";
import type { QueueFullResponse } from "../supervisor/Supervisor.js";
import type { QueuedResponse } from "../supervisor/WorkerQueue.js";

/**
 * Type guard to check if a result is a QueuedResponse
 */
export function isQueuedResponse(
  result: Process | QueuedResponse | QueueFullResponse,
): result is QueuedResponse {
  return "queued" in result && result.queued === true;
}

/**
 * Type guard to check if a result is a QueueFullResponse
 */
export function isQueueFullResponse(
  result: Process | QueuedResponse | QueueFullResponse,
): result is QueueFullResponse {
  return "error" in result && result.error === "queue_full";
}
