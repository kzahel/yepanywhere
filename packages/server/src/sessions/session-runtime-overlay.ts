import type {
  AgentActivity,
  PendingInputType,
  PermissionMode,
  SessionOwnership,
} from "@yep-anywhere/shared";
import type { NotificationService } from "../notifications/index.js";
import type { ProviderRetentionSnapshot } from "../sdk/types.js";
import { hasUnreadProviderContent } from "./recap-overlays.js";

/** The live-process state a session row reads, and nothing else. */
export interface SessionRuntimeProcess {
  id: string;
  permissionMode?: PermissionMode;
  appliedPermissionMode?: PermissionMode;
  modeVersion?: number;
  recapAfterSeconds?: number;
  state: { type: string };
  isRetainingProviderWork(): boolean;
  getPendingInputRequest(): { type: string } | null;
  /** Recorded provider work; rows without it show no provider phase. */
  getProviderRetentionSnapshot?(): ProviderRetentionSnapshot;
}

/** Who controls the session: this server's process, an external program, or nobody. */
export function sessionOwnershipFromProcess(
  process: SessionRuntimeProcess | undefined,
  options: { isExternal?: boolean; fallback?: SessionOwnership } = {},
): SessionOwnership {
  if (process) {
    return {
      owner: "self",
      processId: process.id,
      permissionMode: process.permissionMode,
      appliedPermissionMode: process.appliedPermissionMode,
      modeVersion: process.modeVersion,
      recapAfterSeconds: process.recapAfterSeconds,
    };
  }
  if (options.isExternal) {
    return { owner: "external" };
  }
  return options.fallback ?? { owner: "none" };
}

/** Which kind of answer a waiting session needs: a tool approval or a user question. */
export function pendingInputTypeFromProcess(
  process: SessionRuntimeProcess | undefined,
): PendingInputType | undefined {
  const request = process?.getPendingInputRequest();
  if (!request) {
    return undefined;
  }
  return request.type === "tool-approval" ? "tool-approval" : "user-question";
}

/** Session activity a row shows; undefined when nothing is running. */
export function sessionActivityFromProcess(
  process: SessionRuntimeProcess | undefined,
): AgentActivity | undefined {
  if (!process) {
    return undefined;
  }
  const state = process.state.type;
  if (state === "in-turn" || state === "waiting-input") {
    return state;
  }
  // Idle with provider-retained background work (tasks, crons) reads as active,
  // so a row shows the activity indicator while that work runs.
  return state === "idle" && process.isRetainingProviderWork()
    ? "in-turn"
    : undefined;
}

/**
 * The activity a live `process-state-changed` event reports for a process:
 * the same activity and pending input a row shows, with no activity as idle.
 */
export function sessionActivityEventFromProcess(
  process: SessionRuntimeProcess,
): { activity: AgentActivity; pendingInputType: PendingInputType | undefined } {
  return {
    activity: sessionActivityFromProcess(process) ?? "idle",
    pendingInputType: pendingInputTypeFromProcess(process),
  };
}

export interface SessionRowRuntimeOverlay {
  ownership: SessionOwnership;
  pendingInputType: PendingInputType | undefined;
  activity: AgentActivity | undefined;
  hasUnread: boolean | undefined;
}

/**
 * The fields every session-row projection derives from live process state.
 * `providerUpdatedAt` is the pre-recap-overlay provider timestamp unread
 * compares against (see hasUnreadProviderContent).
 */
export function sessionRowRuntimeOverlay(
  process: SessionRuntimeProcess | undefined,
  options: {
    sessionId: string;
    providerUpdatedAt: string;
    notificationService?: NotificationService;
    externalTracker?: { isExternal(sessionId: string): boolean };
    fallbackOwnership?: SessionOwnership;
  },
): SessionRowRuntimeOverlay {
  return {
    ownership: sessionOwnershipFromProcess(process, {
      isExternal: options.externalTracker?.isExternal(options.sessionId),
      fallback: options.fallbackOwnership,
    }),
    pendingInputType: pendingInputTypeFromProcess(process),
    activity: sessionActivityFromProcess(process),
    hasUnread: hasUnreadProviderContent(
      options.notificationService,
      options.sessionId,
      options.providerUpdatedAt,
    ),
  };
}
