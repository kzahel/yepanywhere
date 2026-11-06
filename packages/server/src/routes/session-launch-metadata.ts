import type {
  PromptSuggestionMode,
  ProviderName,
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
import { persistedSandboxNetworkFirewall } from "./session-sandbox-settings.js";

/** The sandbox a launched session records for later resumes. */
export interface LaunchSandboxRecord {
  level: SessionSandboxLevel;
  networkFirewall?: boolean;
  stateKey?: string;
  projectPath: string;
  projectId: UrlProjectId;
}

/**
 * The launch metadata a route records itself. Creation admission already
 * saved a new session's or copy's provider, model and preferences, so the
 * successor routes pass only the preferences a started process resolved and
 * the sandbox record; recovered-queue reactivation passes the rest. An
 * absent field is not written.
 */
export interface LaunchMetadataRecord {
  provider?: ProviderName;
  executor?: string;
  requestedModel?: string;
  promptSuggestionMode?: PromptSuggestionMode;
  recapAfterSeconds?: number;
  sandbox?: LaunchSandboxRecord;
}

/** Source fields a transcript child inherits its sandbox record from. */
type InheritedLaunchSource = Pick<
  SessionMetadata,
  | "sandboxLevel"
  | "sandboxNetworkFirewall"
  | "sandboxStateKey"
  | "workingProjectId"
>;

/**
 * Write a launched session's metadata, in a fixed order: provider, executor,
 * requested model, prompt-suggestion mode, recap delay, sandbox. A later
 * resume that omits these from its request recovers them from here.
 */
export async function persistLaunchMetadata(
  service: SessionMetadataService | undefined,
  sessionId: string,
  record: LaunchMetadataRecord,
): Promise<void> {
  if (!service) {
    return;
  }
  if (record.provider) {
    await service.setProvider(sessionId, record.provider);
  }
  if (record.executor) {
    await service.setExecutor(sessionId, record.executor);
  }
  // Persist the launch model identity, the selected YA alias (including
  // "default").
  if (record.requestedModel) {
    await service.setRequestedModel(sessionId, record.requestedModel);
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
 * The sandbox record a transcript child of `source` keeps: the source's
 * level and firewall, the child's own sandbox state when the copy made one,
 * and the source's working project.
 */
export function inheritedSandboxRecord(
  source: InheritedLaunchSource | undefined,
  child: {
    sandboxStateKey: string | undefined;
    projectPath: string;
    projectId: UrlProjectId;
  },
): LaunchSandboxRecord {
  return {
    level: source?.sandboxLevel ?? "none",
    networkFirewall: persistedSandboxNetworkFirewall(source),
    stateKey: child.sandboxStateKey ?? source?.sandboxStateKey,
    projectPath: child.projectPath,
    projectId: source?.workingProjectId ?? child.projectId,
  };
}

/** What open session lists are told about a new session. */
export interface NewSessionAnnouncement {
  title?: string;
  archived?: boolean;
  forkedFromSessionId?: string;
}

/**
 * The title, archiving and lineage only the route knows about a session it
 * made from another one: a handoff's title, a fork's lineage root, the
 * fork-summary target's archiving. An absent field is not written.
 */
export interface NewSessionRecord extends NewSessionAnnouncement {
  /** The fork lineage's root, which only fork numbering reads. */
  forkLineageRootId?: string;
}

/**
 * Record what only the route knows about a new session, then announce the
 * session with `session-metadata-changed` so open session lists show it.
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
