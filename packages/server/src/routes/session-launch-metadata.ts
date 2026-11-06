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
 * The launch metadata a session-launching route records for a session it
 * started, resumed or copied. An absent field is not written.
 */
export interface LaunchMetadataRecord {
  provider?: ProviderName;
  executor?: string;
  requestedModel?: string;
  promptSuggestionMode?: PromptSuggestionMode;
  recapAfterSeconds?: number;
  sandbox?: LaunchSandboxRecord;
}

/** Source fields a transcript child inherits its launch metadata from. */
type InheritedLaunchSource = Pick<
  SessionMetadata,
  | "sandboxLevel"
  | "sandboxNetworkFirewall"
  | "sandboxStateKey"
  | "workingProjectId"
  | "promptSuggestionMode"
  | "recapAfterSeconds"
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
  // Persist the launch model identity. Normal launches retain the selected YA
  // alias (including "default"); forks replace "default" with the observed
  // source model so a cold first resume cannot drift to a new default.
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

/**
 * The launch metadata a cold transcript child (fork, or a retitle or
 * fork-summary helper) inherits from its source session.
 */
export function inheritedChildLaunchMetadata(
  source: InheritedLaunchSource | undefined,
  child: {
    provider: ProviderName;
    executor: string | undefined;
    requestedModel: string | undefined;
    sandboxStateKey: string | undefined;
    projectPath: string;
    projectId: UrlProjectId;
  },
): LaunchMetadataRecord {
  return {
    provider: child.provider,
    executor: child.executor,
    requestedModel: child.requestedModel,
    promptSuggestionMode: source?.promptSuggestionMode,
    recapAfterSeconds: source?.recapAfterSeconds,
    sandbox: inheritedSandboxRecord(source, child),
  };
}
