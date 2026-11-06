import type { Context } from "hono";
import type { Process } from "../supervisor/Process.js";
import type {
  QueueFullResponse,
  Supervisor,
} from "../supervisor/Supervisor.js";
import type { QueuedResponse } from "../supervisor/WorkerQueue.js";

/** What a Supervisor start or resume answered. */
export type LaunchResult = Process | QueuedResponse | QueueFullResponse;

/** A launch that will not run: the queue was full, or it could not start now. */
export interface RefusedLaunch {
  kind: "refused";
  error: string;
  maxQueueSize?: number;
}

export interface StartedLaunch {
  kind: "started";
  process: Process;
}

/** A launch once the caller's queue policy is applied. */
export type LaunchOutcome =
  | StartedLaunch
  | { kind: "queued"; queued: QueuedResponse }
  | RefusedLaunch;

/**
 * What the caller does with a launch the Supervisor queued for a free
 * worker. A send or new session can wait for one. A replacement or helper
 * that must start now cancels the queued request and is refused with
 * `notStartedError`: restart leaves the old process running rather than
 * replace it later, and the fork-summary job, which tracks the target's
 * process so a cancel can stop it, fails instead.
 */
export type QueuedLaunchPolicy = WaitWhenQueued | CancelWhenQueued;
interface WaitWhenQueued {
  whenQueued: "wait";
}
interface CancelWhenQueued {
  whenQueued: "cancel";
  supervisor: Pick<Supervisor, "cancelQueuedRequest">;
  notStartedError: string;
}

/** The one reading of a Supervisor start or resume result. */
export function settleLaunch(
  result: LaunchResult,
  policy: WaitWhenQueued,
): LaunchOutcome;
export function settleLaunch(
  result: LaunchResult,
  policy: CancelWhenQueued,
): StartedLaunch | RefusedLaunch;
export function settleLaunch(
  result: LaunchResult,
  policy: QueuedLaunchPolicy,
): LaunchOutcome {
  if (isQueueFull(result)) {
    return {
      kind: "refused",
      error: "Queue is full",
      maxQueueSize: result.maxQueueSize,
    };
  }
  if (isQueued(result)) {
    if (policy.whenQueued === "wait") return { kind: "queued", queued: result };
    policy.supervisor.cancelQueuedRequest(result.queueId);
    return { kind: "refused", error: policy.notStartedError };
  }
  return { kind: "started", process: result };
}

function isQueued(result: LaunchResult): result is QueuedResponse {
  return "queued" in result && result.queued === true;
}

function isQueueFull(result: LaunchResult): result is QueueFullResponse {
  return "error" in result && result.error === "queue_full";
}

/**
 * The 503 a route answers for a refused launch. `context` names what the
 * request already made, such as a restart fork's new session.
 */
export function refusedLaunchResponse(
  c: Context,
  refused: RefusedLaunch,
  context: Record<string, unknown> = {},
): Response {
  return c.json(
    { error: refused.error, maxQueueSize: refused.maxQueueSize, ...context },
    503,
  );
}
