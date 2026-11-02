import type {
  PermissionMode,
  ProviderName,
  SessionSandboxLevel,
  ShowThinking,
  ThinkingOption,
} from "./types.js";
import type { StagedAttachmentRef, UploadedFile } from "./upload.js";
import type { UrlProjectId } from "./projectId.js";
import type { QueuedYaCommand } from "./queued-ya-commands.js";
import type { UserMessageMetadata } from "./user-message-metadata.js";
import type {
  SessionCreationProvenance,
  SessionQueuedMessageSummary,
} from "./app-types.js";

export const DEFAULT_PROJECT_QUEUE_QUIET_SECONDS = 30;
export const MAX_PROJECT_QUEUE_QUIET_SECONDS = 5 * 60;

export function clampProjectQueueQuietSeconds(
  value: unknown,
): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  return Math.min(
    MAX_PROJECT_QUEUE_QUIET_SECONDS,
    Math.max(0, Math.round(value)),
  );
}

export type ProjectQueueItemStatus = "queued" | "dispatching" | "failed";

export type ProjectQueueDispatchPauseReason = "manual" | "restart";

export type ProjectQueueDispatchState =
  | { status: "running" }
  | {
      status: "paused";
      reason: ProjectQueueDispatchPauseReason;
      pausedAt: string;
    };

export type ProjectQueueProjectState =
  | "empty"
  | "paused"
  | "blocked"
  | "waiting-quiet"
  | "ready"
  | "dispatching";

/**
 * How many of a project's blockers the queue UI names; the rest are counted.
 * The server resolves blocker session titles for these alone.
 */
export const PROJECT_QUEUE_NAMED_BLOCKER_COUNT = 3;

/** Why one session holds a project's queued work. */
export const PROJECT_QUEUE_SESSION_BLOCKER_REASONS = [
  "in-turn",
  "waiting-input",
  "provider-retained",
  "direct-queue",
  "deferred-queue",
  "pending-input",
  "user-starting",
  "automation-paused",
  "external",
] as const;

export type ProjectQueueSessionBlockerReason =
  (typeof PROJECT_QUEUE_SESSION_BLOCKER_REASONS)[number];

/**
 * A project-idle blocker string, parsed. The wire form stays a string
 * (`<sessionId>:<reason>`, `readiness:<detail>`, `worker-queue`, …) so every
 * server release and client agree on it; this is its one reader.
 */
export type ProjectQueueBlocker =
  | {
      kind: "session";
      sessionId: string;
      reason: ProjectQueueSessionBlockerReason;
    }
  | { kind: "session-liveness"; sessionId: string; status: string }
  | { kind: "readiness"; detail: string }
  | { kind: "worker-queue" }
  | { kind: "recovered-session-queue"; count: string }
  | { kind: "first-item-failed" }
  | { kind: "other"; blocker: string };

const SESSION_BLOCKER_REASONS: ReadonlySet<string> = new Set(
  PROJECT_QUEUE_SESSION_BLOCKER_REASONS,
);

const LIVENESS_BLOCKER_PREFIX = "liveness-";

/** The blocker string naming a session that holds a project's queue. */
export function projectQueueSessionBlocker(
  sessionId: string,
  reason: ProjectQueueSessionBlockerReason,
): string {
  return `${sessionId}:${reason}`;
}

/** The blocker string for a session whose liveness is not verified idle. */
export function projectQueueLivenessBlocker(
  sessionId: string,
  livenessStatus: string,
): string {
  return `${sessionId}:${LIVENESS_BLOCKER_PREFIX}${livenessStatus}`;
}

export function parseProjectQueueBlocker(blocker: string): ProjectQueueBlocker {
  if (blocker.startsWith("readiness:")) {
    return { kind: "readiness", detail: blocker.slice("readiness:".length) };
  }
  if (blocker === "worker-queue") return { kind: "worker-queue" };
  if (blocker === "project-queue:first-failed") {
    return { kind: "first-item-failed" };
  }
  if (blocker.startsWith("recovered-session-queue:")) {
    return {
      kind: "recovered-session-queue",
      count: blocker.slice("recovered-session-queue:".length),
    };
  }
  const separator = blocker.indexOf(":");
  if (separator > 0) {
    const sessionId = blocker.slice(0, separator);
    const reason = blocker.slice(separator + 1);
    if (SESSION_BLOCKER_REASONS.has(reason)) {
      return {
        kind: "session",
        sessionId,
        reason: reason as ProjectQueueSessionBlockerReason,
      };
    }
    if (reason.startsWith(LIVENESS_BLOCKER_PREFIX)) {
      return {
        kind: "session-liveness",
        sessionId,
        status: reason.slice(LIVENESS_BLOCKER_PREFIX.length),
      };
    }
  }
  return { kind: "other", blocker };
}

export interface ProjectQueueProjectStatus {
  projectId: UrlProjectId;
  state: ProjectQueueProjectState;
  idle: boolean;
  /** Parse each entry with `parseProjectQueueBlocker`. */
  blockers: string[];
  /** Display titles for session ids named by blockers, when resolvable. */
  blockerSessionTitles?: Record<string, string>;
  dispatchPaused: boolean;
  inFlight: boolean;
  quietWindowMs: number;
  itemCount: number;
  nextItemId?: string;
  nextAttemptAt?: string;
  quietStartedAt?: string;
  quietEligibleAt?: string;
}

export interface ProjectQueuePromoteNowResult {
  promoted: boolean;
  itemId?: string;
  sessionId?: string;
  reason:
    | "promoted"
    | "empty"
    | "paused"
    | "blocked"
    | "in-flight"
    | "not-found"
    | "not-queued"
    | "failed";
  error?: string;
  status: ProjectQueueProjectStatus;
}

export interface ProjectQueuePromoteNowRequest {
  itemId?: string;
  force?: boolean;
  /** Deliver an existing-session item through the provider's active-turn steering path. */
  deliveryIntent?: "steer";
}

export type ProjectQueueClientSource =
  | "toolbar"
  | "projects-page"
  | "new-session";

export interface ProjectQueueMessage {
  text: string;
  attachments?: UploadedFile[];
  stagedAttachments?: ProjectQueueStagedAttachments;
  mode?: PermissionMode;
  metadata?: UserMessageMetadata;
  /**
   * Marks `text` as a YA-emulated command to run against the target session
   * at dispatch instead of sending it to the provider. `text` is the only
   * source of the command: the server re-derives name and argument from it on
   * every write and at dispatch, so what runs is what every queue surface
   * shows.
   */
  yaCommand?: QueuedYaCommand;
}

export interface ProjectQueueStagedAttachments {
  batchId: string;
  refs: StagedAttachmentRef[];
  updatedAt: string;
}

export type ProjectQueueTarget =
  | {
      type: "existing-session";
      sessionId: string;
      provider?: ProviderName;
      mode?: PermissionMode;
      model?: string;
      serviceTier?: string;
      executor?: string;
      thinking?: ThinkingOption;
      showThinking?: ShowThinking;
    }
  | {
      type: "new-session";
      provider?: ProviderName;
      mode?: PermissionMode;
      model?: string;
      serviceTier?: string;
      executor?: string;
      sandboxLevel?: SessionSandboxLevel;
      sandboxNetworkFirewall?: boolean;
      title?: string;
      thinking?: ThinkingOption;
      showThinking?: ShowThinking;
    };

export interface ProjectQueueCreatedFrom {
  sessionId?: string;
  client?: ProjectQueueClientSource;
}

export interface ProjectQueueItem {
  id: string;
  projectId: UrlProjectId;
  projectPath: string;
  target: ProjectQueueTarget;
  message: ProjectQueueMessage;
  createdAt: string;
  updatedAt: string;
  createdFrom?: ProjectQueueCreatedFrom;
  /** Original enqueue source; absent only on legacy persisted items. */
  creationProvenance?: SessionCreationProvenance;
  /**
   * The limited user who queued this item, whose launch policy and
   * attribution apply when it runs; absent means the superuser.
   */
  createdByUser?: string;
  status: ProjectQueueItemStatus;
  lastError?: string;
  lastAttemptAt?: string;
}

export interface ProjectQueueItemSummary {
  id: string;
  projectId: UrlProjectId;
  target: ProjectQueueTarget;
  targetTitle?: string | null;
  targetFullTitle?: string | null;
  messagePreview: string;
  message: ProjectQueueMessage;
  createdAt: string;
  updatedAt: string;
  createdFrom?: ProjectQueueCreatedFrom;
  /** Original enqueue source; absent only on legacy persisted items. */
  creationProvenance?: SessionCreationProvenance;
  /** The limited user who queued this item; absent means the superuser. */
  createdByUser?: string;
  status: ProjectQueueItemStatus;
  attachmentCount: number;
  lastError?: string;
  lastAttemptAt?: string;
}

export interface ProjectQueueRecoveredSessionQueueSummary
  extends SessionQueuedMessageSummary {
  id: string;
  sessionId: string;
  projectId: UrlProjectId;
  kind: "patient";
  status: "paused-after-restart";
  sessionTitle?: string;
}

export interface ProjectQueueResponse {
  projectId: UrlProjectId;
  items: ProjectQueueItemSummary[];
  dispatchState?: ProjectQueueDispatchState;
  projectStatuses?: Record<string, ProjectQueueProjectStatus>;
}

export interface ProjectQueueListResponse {
  items: ProjectQueueItemSummary[];
  dispatchState?: ProjectQueueDispatchState;
  recoveredSessionQueues?: ProjectQueueRecoveredSessionQueueSummary[];
  projectStatuses?: Record<string, ProjectQueueProjectStatus>;
}

export interface ProjectQueuePromoteNowResponse
  extends ProjectQueueListResponse {
  promoteResult: ProjectQueuePromoteNowResult;
}

export interface CreateProjectQueueItemRequest {
  target: ProjectQueueTarget;
  message: ProjectQueueMessage;
  createdFrom?: ProjectQueueCreatedFrom;
}

export interface UpdateProjectQueueItemRequest {
  target?: ProjectQueueTarget;
  message?: ProjectQueueMessage;
}

export interface ProjectQueueChangedEvent {
  type: "project-queue-changed";
  projectId: UrlProjectId;
  items: ProjectQueueItemSummary[];
  reason:
    | "created"
    | "updated"
    | "deleted"
    | "retry"
    | "paused"
    | "resumed"
    | "dispatching"
    | "released"
    | "reordered"
    | "readiness"
    | "promoted"
    | "failed";
  itemId?: string;
  dispatchState?: ProjectQueueDispatchState;
  timestamp: string;
}
