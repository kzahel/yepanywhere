import type {
  PromptSuggestionMode,
  SessionSandboxLevel,
  UrlProjectId,
} from "@yep-anywhere/shared";
import type {
  SessionMetadata,
  SessionMetadataService,
} from "../metadata/index.js";
import type { ForkOrdinalClaim } from "../metadata/SessionMetadataService.js";
import { ForkSettingsPersistenceError } from "../supervisor/Supervisor.js";
import type { EventBus } from "../watcher/index.js";

/** The sandbox a launched session records for later resumes. */
export interface LaunchSandboxRecord {
  level: SessionSandboxLevel;
  networkFirewall?: boolean;
  stateKey?: string;
  projectPath: string;
  projectId: UrlProjectId;
}

/**
 * The launch metadata a launch caller records itself. Creation admission
 * already saved a new session's or copy's provider, model and preferences,
 * the Supervisor records the settings a process runs with, and a copy its
 * sandbox record, so a caller passes only preferences and a started
 * successor's sandbox record: the successor launches the preferences their
 * started process resolved, recovered-queue reactivation the session's saved
 * ones. An absent field is not written.
 */
export interface LaunchMetadataRecord {
  promptSuggestionMode?: PromptSuggestionMode;
  recapAfterSeconds?: number;
  sandbox?: LaunchSandboxRecord;
}

/**
 * Write a launched session's metadata, in a fixed order: prompt-suggestion
 * mode, recap delay, sandbox. A later resume that omits these from its request
 * recovers them from here.
 */
export async function persistLaunchMetadata(
  service: SessionMetadataService | undefined,
  sessionId: string,
  record: LaunchMetadataRecord,
): Promise<void> {
  if (!service) {
    return;
  }
  // Persist the resolved prompt-suggestion mode so a later resume (which may
  // omit it from the request body) recovers the per-session preference
  // instead of falling back to the provider's native default.
  if (record.promptSuggestionMode !== undefined) {
    await service.updateMetadata(sessionId, {
      promptSuggestionMode: record.promptSuggestionMode,
    });
  }
  if (record.recapAfterSeconds !== undefined) {
    await service.updateMetadata(sessionId, {
      recapAfterSeconds: record.recapAfterSeconds,
    });
  }
  if (record.sandbox) {
    await service.setSessionSandbox?.(sessionId, record.sandbox);
  }
}

/**
 * The project a transcript child of `source` is listed under: the source's
 * working project, or the one the request named when the source has none.
 * The copy saves it with the child's sandbox record.
 */
export function inheritedWorkingProject(
  source: Pick<SessionMetadata, "workingProjectId"> | undefined,
  projectId: string,
): UrlProjectId {
  return source?.workingProjectId ?? (projectId as UrlProjectId);
}

/** What open session lists are told about a new session. */
export interface NewSessionAnnouncement {
  title?: string;
  archived?: boolean;
  forkedFromSessionId?: string;
}

/**
 * The title, archiving and lineage only the launch caller knows about a
 * session it made from another one: a handoff's title, a fork's lineage root,
 * the fork-summary target's archiving. An absent field is not written.
 */
export interface NewSessionRecord extends NewSessionAnnouncement {
  /** The fork lineage's root, which only fork numbering reads. */
  forkLineageRootId?: string;
}

/**
 * Record what only the launch caller knows about a new session, then announce
 * the session with `session-metadata-changed` so open session lists show it.
 * `admitted` names fields creation admission already saved, such as a
 * copy's title and source; they are announced, not written again. The
 * announcement carries every field but the lineage root.
 */
export async function recordNewSessionMetadata(
  service: SessionMetadataService | undefined,
  eventBus: EventBus | undefined,
  sessionId: string,
  record: NewSessionRecord,
  admitted: NewSessionAnnouncement = {},
): Promise<void> {
  if (!service) {
    return;
  }
  if (Object.keys(record).length > 0) {
    await service.updateMetadata(sessionId, record);
  }
  const { forkLineageRootId: _lineageRoot, ...announced } = record;
  eventBus?.emit({
    type: "session-metadata-changed",
    sessionId,
    ...admitted,
    ...announced,
    timestamp: new Date().toISOString(),
  });
}

/**
 * Give back the fork number a failed fork claimed for its title, so the next
 * fork takes it. A fork kept without its settings
 * (`ForkSettingsPersistenceError`) exists and keeps its number.
 */
export async function releaseFailedForkNumber(
  service: SessionMetadataService | undefined,
  claim: ForkOrdinalClaim | undefined,
  error: unknown,
): Promise<void> {
  if (claim && !(error instanceof ForkSettingsPersistenceError)) {
    await service?.releaseForkOrdinal(claim);
  }
}
