import { CONVERSATION_API_REVISION } from "@yep-anywhere/shared/experimental/conversation-protocol";
import {
  getServerRuntime,
  type ServerRuntimeInfo,
} from "@yep-anywhere/shared/server-runtime";
import { exec } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { isProviderHostDegraded } from "../sdk/providers/provider-host-status.js";
import {
  APPROVAL_AUDIT_LOG_CAPABILITY,
  SERVER_CAPABILITIES,
  type SqliteStatus,
  ACLI_COMMENTARY_RENDERING_CAPABILITY,
  ATTACHMENT_ONLY_SESSION_MESSAGES_CAPABILITY,
  BANG_COMMANDS_CAPABILITY,
  BROWSER_SETTINGS_BACKUP_CAPABILITY,
  CACHE_MISS_BILLING_EXPECTED_EXPIRY_CAPABILITY,
  CACHE_MISS_BILLING_IGNORE_AFTER_CAPABILITY,
  CLAUDE_ADDITIONAL_MODELS_CAPABILITY,
  CLAUDE_GATEWAY_AUTOSTART_CAPABILITY,
  CLAUDE_GATEWAY_CAPABILITY,
  CLAUDE_GATEWAY_DISABLE_AGENT_CAPABILITY,
  CLAUDE_GATEWAY_DISABLE_PLAN_MODE_CAPABILITY,
  CODEX_CYBER_ACCESS_PROGRAM_SETTING_CAPABILITY,
  CODEX_PLAN_TOOL_SETTING_CAPABILITY,
  CODEX_PAGINATED_ROLLOUT_LINEAGE_CAPABILITY,
  CODEX_REASONING_SUMMARY_SETTING_CAPABILITY,
  CODEX_STREAM_DURABLE_ID_ALIGNMENT_CAPABILITY,
  DEVICE_BRIDGE_AVAILABLE_CAPABILITY,
  DEVICE_BRIDGE_CAPABILITY,
  DEVICE_BRIDGE_DOWNLOAD_CAPABILITY,
  DEVICE_BRIDGE_UPDATE_CAPABILITY,
  GIT_FILE_DIFF_PROJECTIONS_CAPABILITY,
  GIT_FILE_REVISION_CAPABILITY,
  GIT_INCLUSIVE_TO_HEAD_CAPABILITY,
  GIT_INCOMING_COMMITS_CAPABILITY,
  GIT_LIVE_WORKTREE_SETTING_CAPABILITY,
  GIT_WORKING_TREE_COMPLETE_SCAN_CAPABILITY,
  GIT_WORKING_TREE_FILES_CAPABILITY,
  GIT_WORKING_TREE_SECTIONS_CAPABILITY,
  GIT_DIRTY_FILE_EDITOR_CAPABILITY,
  GLOSSARY_TOOLTIPS_CAPABILITY,
  GIT_SOURCE_REVIEW_CAPABILITY,
  GIT_SOURCE_REVIEW_PROJECTIONS_CAPABILITY,
  GIT_SOURCE_REVIEW_SUBMISSIONS_CAPABILITY,
  GIT_STATUS_CAPABILITY,
  GIT_STATUS_ENHANCED_CAPABILITY,
  GIT_STATUS_INTEGRATION_OPTIONS_CAPABILITY,
  GIT_STATUS_PULL_CAPABILITY,
  GIT_STATUS_PUSH_CAPABILITY,
  GIT_STATUS_REMOTE_CHECK_CAPABILITY,
  HOST_AWAKE_CONTROL_CAPABILITY,
  HOST_AGENT_PROCESS_OBSERVABILITY_CAPABILITY,
  HOST_IDENTITY_CAPABILITY,
  IDLE_REAP_HOURS_SETTING_CAPABILITY,
  SUBAGENT_MAX_DEPTH_SETTING_CAPABILITY,
  PROGRESSIVE_SESSION_CATALOG_CAPABILITY,
  RETAINED_SESSION_COLLECTIONS_CAPABILITY,
  PROJECT_CAPTIONS_CAPABILITY,
  PROJECT_CODE_NAMES_CAPABILITY,
  PROJECT_FILE_COMPLETION_CAPABILITY,
  PROJECT_NAMES_CAPABILITY,
  SESSION_CONVERSATION_CONTEXT_CAPABILITY,
  SESSION_ASYNC_QUESTIONS_CAPABILITY,
  SESSION_REWIND_CAPABILITY,
  NON_HUMAN_USER_TURN_CAPABILITY,
  SESSION_CONTENT_SEARCH_CAPABILITY,
  SESSION_CREATION_PROVENANCE_CAPABILITY,
  PROJECT_QUEUE_CAPABILITY,
  PROJECT_QUEUE_ATTACHMENT_EDITING_CAPABILITY,
  PROJECT_QUEUE_READINESS_CHECK_CAPABILITY,
  PROJECT_QUEUE_NEW_SESSION_SHORTCUT_SETTING_CAPABILITY,
  PROJECT_SESSION_DEFAULTS_CAPABILITY,
  PROJECT_DIRECTORY_STORAGE_POLICY_CAPABILITY,
  PUBLIC_FILE_SHARES_CAPABILITY,
  PUBLIC_SHARE_MANAGEMENT_CAPABILITY,
  PUBLIC_SHARE_MANAGEMENT_FREEZE_CAPABILITY,
  PROVIDER_SUBSCRIPTION_USAGE_CAPABILITY,
  PROVIDER_HOST_CONTROL_CAPABILITY,
  REMOTE_BROWSER_DIAGNOSTICS_CAPABILITY,
  RELOAD_SAFE_CODEX_RUNTIME_SETTINGS_CAPABILITY,
  SESSION_SANDBOXING_CAPABILITY,
  SESSION_SANDBOX_NETWORK_FIREWALL_CAPABILITY,
  SESSION_SANDBOXING_STATUS_CAPABILITY,
  SESSION_FORK_TURN_INTENTS_CAPABILITY,
  SIDEBAR_SESSION_RESUME_CAPABILITY,
  SYNTHETIC_ARCHIVE_COMMAND_CAPABILITY,
  SYNTHETIC_DONE_COMMAND_CAPABILITY,
  SECURITY_CLIENT_AUDIT_CAPABILITY,
  TOOL_RESULT_MEDIA_PRESERVATION_POLICY_CAPABILITY,
  VOICE_INPUT_CAPABILITY,
  encodeCompactServerCapabilities,
  encodeVersionedServerCapabilities,
  negotiateServerCapabilityEncoding,
  type CapabilityBitset,
  type ClientDefaults,
  type OptionalServerCapabilityBitset,
  type SessionSandboxAvailability,
} from "@yep-anywhere/shared";
import { Hono } from "hono";
import type { ArtifactViewerStatus } from "@yep-anywhere/shared";
import { getSessionSandboxAvailability as getLocalSessionSandboxAvailability } from "../session-sandbox.js";
import type {
  SpeechBackendCapabilities,
  SpeechBackendInfo,
} from "../services/voice/SpeechBackend.js";
import { isNewerSemver } from "../utils/semver.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const execAsync = promisify(exec);

/**
 * Get version from git describe (for dev mode)
 * Returns something like "v0.1.7" or "v0.1.7-3-g050bfd2" (3 commits after tag)
 */
export function normalizeGitDescribeVersion(version: string): string | null {
  const trimmed = version.trim();
  if (!trimmed) return null;
  return trimmed.replace(/^v(?=\d)/, "");
}

async function getGitVersion(): Promise<string | null> {
  try {
    const { stdout } = await execAsync(
      "git describe --tags --always --match 'v[0-9]*.[0-9]*.[0-9]*'",
      { encoding: "utf-8" },
    );
    return normalizeGitDescribeVersion(stdout);
  } catch {
    return null;
  }
}

export type InstallSource =
  | "npm-global"
  | "source"
  | "release-package"
  | "unknown";

/** The checkout a source launch runs, as it stood when the server started. */
export interface SourceRevision {
  commit: string;
  /** Committer date, ISO 8601. */
  committedAt: string;
  /**
   * `packages/` had tracked or untracked changes at launch, so the running
   * code may differ from the commit. Docs and other paths do not count.
   */
  modified: boolean;
  /**
   * Newest modification time among those changed files, ISO 8601; absent
   * when every change is a deletion.
   */
  modifiedAt?: string;
}

export interface CurrentVersionInfo {
  version: string;
  installSource: InstallSource;
  sourceRevision?: SourceRevision;
}

/**
 * Paths named by `git status --porcelain -z`, relative to the repository
 * root. A rename or copy entry is followed by its source path, which is
 * skipped: only the current name exists on disk.
 */
export function porcelainPaths(output: string): string[] {
  const fields = output.split("\0");
  const paths: string[] = [];
  for (let index = 0; index < fields.length; index++) {
    const entry = fields[index]!;
    if (entry.length < 4) continue;
    paths.push(entry.slice(3));
    if (/[RC]/.test(entry.slice(0, 2))) index++;
  }
  return paths;
}

async function getSourceRevision(): Promise<SourceRevision | undefined> {
  try {
    const { stdout: top } = await execAsync("git rev-parse --show-toplevel", {
      encoding: "utf-8",
    });
    const root = top.trim();
    const [{ stdout: head }, { stdout: status }] = await Promise.all([
      execAsync("git log -1 --format=%H%x09%cI", {
        cwd: root,
        encoding: "utf-8",
      }),
      // Untracked files individually, so a new file's own time counts.
      execAsync("git status --porcelain -z --untracked-files=all -- packages", {
        cwd: root,
        encoding: "utf-8",
      }),
    ]);
    const [commit, committedAt] = head.trim().split("\t");
    if (!commit || !committedAt) return undefined;
    const changed = porcelainPaths(status);
    if (changed.length === 0) return { commit, committedAt, modified: false };
    // A deleted file has no time; the others say when the tree last moved.
    const times = await Promise.all(
      changed.map((file) =>
        fs.promises.stat(path.join(root, file)).then(
          (stats) => stats.mtimeMs,
          () => 0,
        ),
      ),
    );
    const newest = Math.max(...times);
    return {
      commit,
      committedAt,
      modified: true,
      ...(newest ? { modifiedAt: new Date(newest).toISOString() } : {}),
    };
  } catch {
    return undefined;
  }
}

/**
 * The installed package version, its `git describe` name in a source checkout,
 * and the install source cannot change while this process runs — an in-place
 * upgrade restarts it. Computing them per request spent a `git describe` or
 * `npm root -g` subprocess on every `/api/version`, including the ordinary
 * reads that many mounted consumers issue. `fresh=1` deliberately does not
 * clear this: it promises a fresh check of the dynamic sandbox/device facts,
 * which read from their own owning services.
 */
let currentVersionInfoPromise: Promise<CurrentVersionInfo> | null = null;
let currentVersionInfoComputations = 0;

function getCurrentVersionInfo(): Promise<CurrentVersionInfo> {
  if (!currentVersionInfoPromise) {
    currentVersionInfoComputations += 1;
    currentVersionInfoPromise = computeCurrentVersionInfo().catch((error) => {
      // A failed probe must not poison the process; the next request retries.
      currentVersionInfoPromise = null;
      throw error;
    });
  }
  return currentVersionInfoPromise;
}

/**
 * Test-only: drop the process-generation snapshot. The probe counter keeps
 * accumulating so a caller can measure how many probes a shape actually cost.
 */
export function resetCurrentVersionInfoForTests(): void {
  currentVersionInfoPromise = null;
}

/** Test-only: how many times the underlying probes actually ran. */
export function getCurrentVersionInfoComputations(): number {
  return currentVersionInfoComputations;
}

/**
 * Read the current package version and best-effort install source.
 */
export function readDesktopBuildVersion(
  serverDirectory: string,
): CurrentVersionInfo {
  try {
    const manifest = JSON.parse(
      fs.readFileSync(
        path.join(serverDirectory, "desktop-runtime-manifest.json"),
        "utf8",
      ),
    );
    const version =
      typeof manifest.yepVersion === "string"
        ? normalizeGitDescribeVersion(manifest.yepVersion)
        : null;
    if (version && /^\d+\.\d+\.\d+(?:$|[-+])/.test(version)) {
      return { version, installSource: "release-package" };
    }
  } catch {
    /* Missing/corrupt packaged metadata must not probe an ambient checkout. */
  }
  return { version: "unknown", installSource: "release-package" };
}

async function computeCurrentVersionInfo(): Promise<CurrentVersionInfo> {
  try {
    // In production (npm package), package.json is in the parent of dist/
    // In development, it's in packages/server/
    const packageJsonPath = path.resolve(__dirname, "../../package.json");
    if (process.env.YEP_DESKTOP === "1")
      return readDesktopBuildVersion(path.dirname(packageJsonPath));
    const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf-8"));
    const version = packageJson.version || "unknown";

    // 0.0.1 is the workspace version - we're in dev mode, use git instead
    if (version === "0.0.1") {
      const [gitVersion, sourceRevision] = await Promise.all([
        getGitVersion(),
        getSourceRevision(),
      ]);
      return {
        version: gitVersion || "dev",
        installSource: "source",
        ...(sourceRevision ? { sourceRevision } : {}),
      };
    }

    return {
      version,
      installSource: await detectReleaseInstallSource(packageJsonPath),
    };
  } catch {
    return { version: "unknown", installSource: "unknown" };
  }
}

async function detectReleaseInstallSource(
  packageJsonPath: string,
): Promise<InstallSource> {
  const packageRoot = await realpathOrResolve(path.dirname(packageJsonPath));
  const npmGlobalRoot = await getNpmGlobalRoot();
  if (npmGlobalRoot && isPathInside(packageRoot, npmGlobalRoot)) {
    return "npm-global";
  }
  return "release-package";
}

async function getNpmGlobalRoot(): Promise<string | null> {
  try {
    const { stdout } = await execAsync("npm root -g", {
      encoding: "utf-8",
    });
    const npmGlobalRoot = stdout.trim();
    if (!npmGlobalRoot) return null;
    return realpathOrResolve(npmGlobalRoot);
  } catch {
    return null;
  }
}

async function realpathOrResolve(value: string): Promise<string> {
  try {
    return await fs.promises.realpath(value);
  } catch {
    return path.resolve(value);
  }
}

function isPathInside(candidate: string, parent: string): boolean {
  const relative = path.relative(parent, candidate);
  return (
    relative !== "" &&
    !relative.startsWith(`..${path.sep}`) &&
    relative !== ".." &&
    !path.isAbsolute(relative)
  );
}

export const UPDATE_SERVER_URL = "https://updates.yepanywhere.com/version";

// Cache for update server check (24 hour TTL for routine app traffic)
let cachedLatestVersion: { version: string; timestamp: number } | null = null;
const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

/**
 * Fetch the latest version from the update server.
 * Sends current version and install ID for analytics.
 */
async function getLatestVersion(
  currentVersion: string,
  installId?: string,
  options?: { forceRefresh?: boolean },
): Promise<string | null> {
  // Return cached value if fresh
  if (
    !options?.forceRefresh &&
    cachedLatestVersion &&
    Date.now() - cachedLatestVersion.timestamp < CACHE_TTL_MS
  ) {
    return cachedLatestVersion.version;
  }

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 5000);

    const headers: Record<string, string> = {
      Accept: "application/json",
    };
    if (installId) {
      headers["X-CFU-ID"] = installId;
    }

    const response = await fetch(`${UPDATE_SERVER_URL}/${currentVersion}`, {
      signal: controller.signal,
      headers,
    });

    clearTimeout(timeoutId);

    // 204 = no update available (current version is latest)
    if (response.status === 204) {
      cachedLatestVersion = { version: currentVersion, timestamp: Date.now() };
      return currentVersion;
    }

    if (!response.ok) {
      return null;
    }

    const data = (await response.json()) as { version?: string };
    const version = data.version || null;

    if (version) {
      cachedLatestVersion = { version, timestamp: Date.now() };
    }

    return version;
  } catch {
    // Network error, timeout, etc. - fail silently
    return null;
  }
}

export interface VersionInfo {
  experimentalSimpleClientApiRevision?: typeof CONVERSATION_API_REVISION;
  /** Absent on older servers; never implies storage readiness. */
  serverRuntime?: ServerRuntimeInfo;
  /** Storage diagnostic only; absent on older servers. */
  sqlite?: SqliteStatus;
  artifactViewer?: ArtifactViewerStatus;
  current: string;
  latest: string | null;
  updateAvailable: boolean;
  /** Best-effort install source for update guidance. Absent on older servers. */
  installSource?: InstallSource;
  /** A source launch's commit; absent for packages and older servers. */
  sourceRevision?: SourceRevision;
  /** Session resume protocol version supported by this server. */
  resumeProtocolVersion: number;
  /** Coarse hosted remote UI/server compatibility level. */
  remoteCompatibilityLevel: number;
  /** Legacy full names for clients predating version-based ID negotiation. */
  capabilities?: string[];
  /** Numeric capability encoding chosen for this client's version. */
  capabilityEncoding?: number;
  /** Explicit capability IDs not implied by `current`. */
  capabilityBits?: CapabilityBitset;
  /** Version-implied capability IDs this server generation explicitly denies. */
  deniedCapabilityBits?: CapabilityBitset;
  /** Sparse 32-bit words for optional capabilities in compact-v1 responses. */
  optionalCapabilityBits?: OptionalServerCapabilityBitset;
  /** Names not yet implied by the reported release, chiefly source builds. */
  capabilityExtensions?: readonly string[];
  /** Local host preflight for the optional YA session sandbox backend. */
  sessionSandboxing?: SessionSandboxAvailability;
  /**
   * Speech backend ids this server has validated and is willing to route
   * audio to. Browser-native remains client-side and is not listed here.
   */
  voiceBackends?: string[];
  /** Configured speech backends, including startup validation state. */
  voiceBackendStatuses?: SpeechBackendInfo[];
  /** Capability map keyed by server-routed speech backend id. */
  voiceBackendCapabilities?: Record<string, SpeechBackendCapabilities>;
  /** Device bridge availability and update state. */
  deviceBridgeState?: DeviceBridgeState;
  /** Installed managed bridge binary version when known. */
  deviceBridgeVersion?: string | null;
  /** Latest bridge release version when known. */
  latestDeviceBridgeVersion?: string | null;
  /** Server-learned browser defaults used when local storage is unset. */
  clientDefaults?: ClientDefaults;
  /** Whether this process is the server bundled with the desktop shell. */
  desktopRuntime?: boolean;
  /**
   * Linux boot tried to attach or start the provider host and still has none.
   * Absent on healthy servers and on non-Linux hosts.
   */
  providerHostDegraded?: boolean;
}

/** Resume protocol version with mutual nonce challenge + server proof binding. */
export const RESUME_PROTOCOL_VERSION = 3;
/** Coarse hosted remote UI/server compatibility generation. */
export const REMOTE_COMPATIBILITY_LEVEL = 10;

const BASE_CAPABILITIES: string[] = [
  SERVER_CAPABILITIES.contextUsageBreakdown.name,
  SERVER_CAPABILITIES.processServiceTierChange.name,
  SERVER_CAPABILITIES.mcpAppViews.name,
  SERVER_CAPABILITIES.projectCreationGitChoice.name,
  SERVER_CAPABILITIES.unicodeProseMath.name,
  SERVER_CAPABILITIES.projectFileViewCommand.name,
  SERVER_CAPABILITIES.fileOwnerProject.name,
  SERVER_CAPABILITIES.vhostFileSites.name,
  SERVER_CAPABILITIES.vhostFileSiteReplacement.name,
  SERVER_CAPABILITIES.projectAppDeletion.name,
  SERVER_CAPABILITIES.localSourceBrowse.name,
  SERVER_CAPABILITIES.personalProjectHiding.name,
  SERVER_CAPABILITIES.projectService.name,
  SERVER_CAPABILITIES.projectAppReservations.name,
  SERVER_CAPABILITIES.fileSourceEditing.name,
  SERVER_CAPABILITIES.limitedUsers.name,
  SERVER_CAPABILITIES.projectTemplateSources.name,
  SERVER_CAPABILITIES.projectTemplateCreation.name,
  SERVER_CAPABILITIES.limitedUserProjectTemplates.name,
  SERVER_CAPABILITIES.limitedUserInstructions.name,
  SERVER_CAPABILITIES.limitedUserBrowserDefaults.name,
  SERVER_CAPABILITIES.limitedUserPathGrants.name,
  SERVER_CAPABILITIES.projectAccessSharing.name,
  SERVER_CAPABILITIES.projectCopy.name,
  SERVER_CAPABILITIES.limitedUserNoProjectSessions.name,
  SERVER_CAPABILITIES.projectAppAddressLinks.name,
  SERVER_CAPABILITIES.projectAppInventory.name,
  SERVER_CAPABILITIES.projectLivePreview.name,
  SERVER_CAPABILITIES.templatePreparationAttachments.name,
  SERVER_CAPABILITIES.sidebarSessionCategories.name,
  SERVER_CAPABILITIES.agentServerAccess.name,
  SERVER_CAPABILITIES.sessionScopedLocalFiles.name,
  SERVER_CAPABILITIES.turnEffortModifiers.name,
  SERVER_CAPABILITIES.syntheticTerminateCommand.name,
  SERVER_CAPABILITIES.speechBackendSetup.name,
  SERVER_CAPABILITIES.localSpeechModelSelection.name,
  ACLI_COMMENTARY_RENDERING_CAPABILITY,
  SESSION_ASYNC_QUESTIONS_CAPABILITY,
  SESSION_REWIND_CAPABILITY,
  NON_HUMAN_USER_TURN_CAPABILITY,
  SESSION_CONVERSATION_CONTEXT_CAPABILITY,
  SESSION_CONTENT_SEARCH_CAPABILITY,
  SESSION_CREATION_PROVENANCE_CAPABILITY,
  PROJECT_FILE_COMPLETION_CAPABILITY,
  ATTACHMENT_ONLY_SESSION_MESSAGES_CAPABILITY,
  CACHE_MISS_BILLING_EXPECTED_EXPIRY_CAPABILITY,
  CACHE_MISS_BILLING_IGNORE_AFTER_CAPABILITY,
  GLOSSARY_TOOLTIPS_CAPABILITY,
  GIT_STATUS_CAPABILITY,
  GIT_STATUS_ENHANCED_CAPABILITY,
  GIT_DIRTY_FILE_EDITOR_CAPABILITY,
  GIT_FILE_DIFF_PROJECTIONS_CAPABILITY,
  GIT_FILE_REVISION_CAPABILITY,
  GIT_INCLUSIVE_TO_HEAD_CAPABILITY,
  GIT_INCOMING_COMMITS_CAPABILITY,
  GIT_WORKING_TREE_FILES_CAPABILITY,
  GIT_LIVE_WORKTREE_SETTING_CAPABILITY,
  GIT_SOURCE_REVIEW_CAPABILITY,
  GIT_SOURCE_REVIEW_SUBMISSIONS_CAPABILITY,
  GIT_SOURCE_REVIEW_PROJECTIONS_CAPABILITY,
  GIT_STATUS_REMOTE_CHECK_CAPABILITY,
  GIT_STATUS_PULL_CAPABILITY,
  GIT_STATUS_PUSH_CAPABILITY,
  GIT_STATUS_INTEGRATION_OPTIONS_CAPABILITY,
  APPROVAL_AUDIT_LOG_CAPABILITY,
  BANG_COMMANDS_CAPABILITY,
  CLAUDE_ADDITIONAL_MODELS_CAPABILITY,
  CLAUDE_GATEWAY_CAPABILITY,
  CLAUDE_GATEWAY_AUTOSTART_CAPABILITY,
  CLAUDE_GATEWAY_DISABLE_AGENT_CAPABILITY,
  CLAUDE_GATEWAY_DISABLE_PLAN_MODE_CAPABILITY,
  CODEX_CYBER_ACCESS_PROGRAM_SETTING_CAPABILITY,
  CODEX_PLAN_TOOL_SETTING_CAPABILITY,
  CODEX_PAGINATED_ROLLOUT_LINEAGE_CAPABILITY,
  CODEX_REASONING_SUMMARY_SETTING_CAPABILITY,
  CODEX_STREAM_DURABLE_ID_ALIGNMENT_CAPABILITY,
  HOST_AWAKE_CONTROL_CAPABILITY,
  HOST_AGENT_PROCESS_OBSERVABILITY_CAPABILITY,
  HOST_IDENTITY_CAPABILITY,
  IDLE_REAP_HOURS_SETTING_CAPABILITY,
  SUBAGENT_MAX_DEPTH_SETTING_CAPABILITY,
  PROGRESSIVE_SESSION_CATALOG_CAPABILITY,
  RETAINED_SESSION_COLLECTIONS_CAPABILITY,
  PROJECT_CAPTIONS_CAPABILITY,
  PROJECT_CODE_NAMES_CAPABILITY,
  PROJECT_NAMES_CAPABILITY,
  PROJECT_QUEUE_CAPABILITY,
  SERVER_CAPABILITIES.retainedRecents.name,
  SERVER_CAPABILITIES.retainedProjects.name,
  SERVER_CAPABILITIES.providerDescriptors.name,
  PROJECT_QUEUE_ATTACHMENT_EDITING_CAPABILITY,
  PROJECT_QUEUE_READINESS_CHECK_CAPABILITY,
  PROJECT_QUEUE_NEW_SESSION_SHORTCUT_SETTING_CAPABILITY,
  PROJECT_SESSION_DEFAULTS_CAPABILITY,
  PROJECT_DIRECTORY_STORAGE_POLICY_CAPABILITY,
  PUBLIC_FILE_SHARES_CAPABILITY,
  PUBLIC_SHARE_MANAGEMENT_CAPABILITY,
  PUBLIC_SHARE_MANAGEMENT_FREEZE_CAPABILITY,
  PROVIDER_SUBSCRIPTION_USAGE_CAPABILITY,
  REMOTE_BROWSER_DIAGNOSTICS_CAPABILITY,
  RELOAD_SAFE_CODEX_RUNTIME_SETTINGS_CAPABILITY,
  SESSION_SANDBOXING_STATUS_CAPABILITY,
  SESSION_SANDBOX_NETWORK_FIREWALL_CAPABILITY,
  SESSION_FORK_TURN_INTENTS_CAPABILITY,
  SIDEBAR_SESSION_RESUME_CAPABILITY,
  SYNTHETIC_ARCHIVE_COMMAND_CAPABILITY,
  SYNTHETIC_DONE_COMMAND_CAPABILITY,
  TOOL_RESULT_MEDIA_PRESERVATION_POLICY_CAPABILITY,
];

export type DeviceBridgeState =
  | "available"
  | "downloadable"
  | "update-available"
  | "unavailable";

export interface DeviceBridgeStatus {
  state: DeviceBridgeState;
  installedVersion?: string | null;
  latestVersion?: string | null;
}

export interface VersionRouteOptions {
  /** Owned update lookup; the default uses the public update service. */
  getLatestVersion?: typeof getLatestVersion;
  getDraftSyncAvailable?: () => boolean;
  vhostAppControlAvailable?: boolean;
  getExperimentalConversationAvailable?: () => boolean;
  /** Read retained startup state; never probe storage in the version route. */
  getSqliteStatus?: () => SqliteStatus;
  getIssueAssociationsAvailable?: () => boolean;
  getArtifactViewerStatus?: () => ArtifactViewerStatus;
  /** Test/service override for the process-generation version snapshot. */
  getCurrentVersionInfo?: () => Promise<CurrentVersionInfo>;
  /** Whether the signed security-client audit routes are mounted. */
  securityClientAuditAvailable?: boolean;
  nativePush?: import("@yep-anywhere/shared").NativePushVersionInfo;
  /** Whether the browser-settings backup storage route is mounted. */
  browserSettingsBackupAvailable?: boolean;
  /** Dynamic device bridge state: available (binary exists), downloadable (ADB found, no binary), unavailable (no ADB). */
  getDeviceBridgeState?: () => DeviceBridgeState;
  /** Detailed device bridge status for version-aware update prompts. */
  getDeviceBridgeStatus?: (options?: {
    forceRefresh?: boolean;
  }) => Promise<DeviceBridgeStatus>;
  /** Whether the user has opted into the device bridge feature. */
  isDeviceBridgeEnabled?: () => boolean;
  /** Unique installation ID for update analytics. */
  installId?: string;
  /** Whether voice input is enabled (default: true). */
  voiceInputEnabled?: boolean;
  /**
   * Returns ids of server-routed speech backends validated at startup.
   * Browser-native is implicit and intentionally not included.
   */
  getEnabledVoiceBackends?: () => string[];
  /** Returns all configured backends, including pending and disabled entries. */
  getVoiceBackendStatuses?: () => SpeechBackendInfo[];
  /** Returns capabilities keyed by validated backend id. */
  getVoiceBackendCapabilities?: () => Record<string, SpeechBackendCapabilities>;
  /** Browser-client defaults persisted by this server. */
  getClientDefaults?: () => ClientDefaults | undefined;
  /** Whether this process is the server bundled with the desktop shell. */
  desktopRuntime?: boolean;
  /** Whether this Hono generation is registered with a provider host. */
  providerHostControlAvailable?: boolean;
  /** Installed MC readiness route is mounted on this supported host. */
  installedMachineControlAvailable?: boolean;
  /** Agent self inspection is enabled, so tabs' session views are collected. */
  agentSessionViewAvailable?: boolean;
  agentAuthRouterAvailable?: boolean;
  /** Whether the operator enabled experimental live worktree monitoring. */
  isLiveWorktreeMonitoringEnabled?: () => boolean;
  /** Version-implied contracts deliberately unavailable in this generation. */
  deniedCapabilities?: readonly string[];
  /** Resolved local sandbox preflight used while constructing capabilities. */
  sessionSandboxAvailability?: SessionSandboxAvailability;
  /** Test/service override for the cached host preflight. */
  getSessionSandboxAvailability?: (options?: {
    forceRefresh?: boolean;
  }) => Promise<SessionSandboxAvailability>;
}

export interface ServerCompatibilityInfo {
  appVersion: string;
  installSource: InstallSource;
  resumeProtocolVersion: number;
  remoteCompatibilityLevel: number;
  renderProtocolVersion?: number;
  capabilities: string[];
  clientDefaults?: ClientDefaults;
  desktopRuntime?: boolean;
}

function getCapabilitiesForDeviceBridgeState(
  state: DeviceBridgeState,
  enabled: boolean,
): string[] {
  if (state === "unavailable") {
    return [];
  }

  const capabilities: string[] = [DEVICE_BRIDGE_AVAILABLE_CAPABILITY];
  if (!enabled) {
    return capabilities;
  }

  if (state === "available") {
    capabilities.push(DEVICE_BRIDGE_CAPABILITY);
    return capabilities;
  }

  capabilities.push(DEVICE_BRIDGE_DOWNLOAD_CAPABILITY);
  if (state === "update-available") {
    capabilities.push(DEVICE_BRIDGE_UPDATE_CAPABILITY);
  }
  return capabilities;
}

export function getServerCapabilities(options?: VersionRouteOptions): string[] {
  const capabilities: string[] = [...BASE_CAPABILITIES];
  if (options?.getDraftSyncAvailable?.())
    capabilities.push(SERVER_CAPABILITIES.draftSync.name);
  capabilities.push(SERVER_CAPABILITIES.vhostBearerAccess.name);
  capabilities.push(SERVER_CAPABILITIES.vhostOauthAccess.name);
  capabilities.push(SERVER_CAPABILITIES.vhostOauthProviders.name);
  if (options?.vhostAppControlAvailable)
    capabilities.push(SERVER_CAPABILITIES.vhostAppControl.name);
  if (options?.agentAuthRouterAvailable) {
    capabilities.push(SERVER_CAPABILITIES.agentAuthRouter.name);
    capabilities.push(SERVER_CAPABILITIES.agentAuthRouterRecovery.name);
    capabilities.push(SERVER_CAPABILITIES.agentAuthRouterPools.name);
    capabilities.push(SERVER_CAPABILITIES.agentAuthRouterOwnedPools.name);
    capabilities.push(SERVER_CAPABILITIES.agentAuthRouterMostRemaining.name);
  }
  if (options?.installedMachineControlAvailable)
    capabilities.push(SERVER_CAPABILITIES.installedMachineControl.name);
  if (options?.agentSessionViewAvailable)
    capabilities.push(SERVER_CAPABILITIES.agentSessionView.name);
  capabilities.push(SERVER_CAPABILITIES.claudeGatewayServices.name);
  if (options?.getExperimentalConversationAvailable?.())
    capabilities.push(SERVER_CAPABILITIES.experimentalConversation.name);
  if (options?.getSqliteStatus?.().state === "ready") {
    capabilities.push(SERVER_CAPABILITIES.speechVocabulary.name);
    if (options.getIssueAssociationsAvailable?.())
      capabilities.push(SERVER_CAPABILITIES.issueSessionAssociations.name);
    capabilities.push(SERVER_CAPABILITIES.speechVocabularySessionTerms.name);
  }
  if (options?.getArtifactViewerStatus?.().available)
    capabilities.push(SERVER_CAPABILITIES.artifactViewer.name);
  if (options?.sessionSandboxAvailability?.state === "available") {
    capabilities.push(SESSION_SANDBOXING_CAPABILITY);
  }
  if (options?.browserSettingsBackupAvailable) {
    capabilities.push(BROWSER_SETTINGS_BACKUP_CAPABILITY);
  }
  if (options?.securityClientAuditAvailable) {
    capabilities.push(SECURITY_CLIENT_AUDIT_CAPABILITY);
  }
  if (options?.nativePush)
    capabilities.push(SERVER_CAPABILITIES.nativePushSubscriptions.name);
  if (options?.voiceInputEnabled !== false) {
    capabilities.push(VOICE_INPUT_CAPABILITY);
  }
  if (options?.providerHostControlAvailable) {
    capabilities.push(PROVIDER_HOST_CONTROL_CAPABILITY);
  }
  if (options?.isLiveWorktreeMonitoringEnabled?.() === true) {
    capabilities.push(
      GIT_WORKING_TREE_SECTIONS_CAPABILITY,
      GIT_WORKING_TREE_COMPLETE_SCAN_CAPABILITY,
    );
  }
  const deviceBridgeState = options?.getDeviceBridgeState?.() ?? "unavailable";
  const enabled = options?.isDeviceBridgeEnabled?.() ?? false;
  capabilities.push(
    ...getCapabilitiesForDeviceBridgeState(deviceBridgeState, enabled),
  );
  const denied = new Set(options?.deniedCapabilities ?? []);
  return capabilities.filter((capability) => !denied.has(capability));
}

export function getEnabledVoiceBackends(
  options?: VersionRouteOptions,
): string[] {
  if (options?.voiceInputEnabled === false) {
    return [];
  }
  return options?.getEnabledVoiceBackends?.() ?? [];
}

export function getVoiceBackendCapabilities(
  options?: VersionRouteOptions,
): Record<string, SpeechBackendCapabilities> {
  if (options?.voiceInputEnabled === false) {
    return {};
  }
  return options?.getVoiceBackendCapabilities?.() ?? {};
}

export function getServerCompatibilityInfo(
  options?: VersionRouteOptions,
): Promise<ServerCompatibilityInfo> {
  const clientDefaults = options?.getClientDefaults?.();
  return Promise.all([
    (options?.getCurrentVersionInfo ?? getCurrentVersionInfo)(),
    (
      options?.getSessionSandboxAvailability ??
      getLocalSessionSandboxAvailability
    )(),
  ]).then(([versionInfo, sessionSandboxAvailability]) => ({
    appVersion: versionInfo.version,
    installSource: versionInfo.installSource,
    resumeProtocolVersion: RESUME_PROTOCOL_VERSION,
    remoteCompatibilityLevel: REMOTE_COMPATIBILITY_LEVEL,
    capabilities: getServerCapabilities({
      ...options,
      sessionSandboxAvailability,
    }),
    ...(clientDefaults ? { clientDefaults } : {}),
    ...(options?.desktopRuntime ? { desktopRuntime: true } : {}),
  }));
}

export function createVersionRoutes(options?: VersionRouteOptions): Hono {
  const routes = new Hono();

  routes.get("/", async (c) => {
    const fresh =
      c.req.query("fresh") === "1" || c.req.query("fresh") === "true";
    const currentVersionRequest = (
      options?.getCurrentVersionInfo ?? getCurrentVersionInfo
    )();
    const [
      currentVersionInfo,
      deviceBridgeStatus,
      sessionSandboxAvailability,
      latest,
    ] = await Promise.all([
      currentVersionRequest,
      options?.getDeviceBridgeStatus
        ? options.getDeviceBridgeStatus({ forceRefresh: fresh })
        : Promise.resolve<DeviceBridgeStatus>({
            state: options?.getDeviceBridgeState?.() ?? "unavailable",
          }),
      (
        options?.getSessionSandboxAvailability ??
        getLocalSessionSandboxAvailability
      )({ forceRefresh: fresh }),
      currentVersionRequest.then(({ version }) =>
        options?.desktopRuntime
          ? null
          : (options?.getLatestVersion ?? getLatestVersion)(
              version.split("-")[0] || version,
              options?.installId,
              { forceRefresh: fresh },
            ),
      ),
    ]);
    const current = currentVersionInfo.version;
    const clientVersion =
      c.req.query("clientVersion") ?? c.req.header("X-Yep-Client-Version");
    const capabilityEncoding = negotiateServerCapabilityEncoding(
      clientVersion,
      current,
    );
    const compactCapabilities = c.req.query("capabilities") === "compact-v1";
    const capabilities = getServerCapabilities({
      ...options,
      getDeviceBridgeState: () => deviceBridgeStatus.state,
      sessionSandboxAvailability,
    });
    const deniedCapabilities = options?.deniedCapabilities ?? [];
    const voiceBackends = getEnabledVoiceBackends(options);
    const voiceBackendStatuses = options?.getVoiceBackendStatuses?.() ?? [];
    const voiceBackendCapabilities = getVoiceBackendCapabilities(options);
    const clientDefaults = options?.getClientDefaults?.();

    // For dev versions like "v0.1.7-3-g050bfd2", extract base version "v0.1.7"
    // to compare against the update server.
    const baseVersion = current.split("-")[0] || current;
    const updateAvailable = latest ? isNewerSemver(baseVersion, latest) : false;

    const info: VersionInfo = {
      current,
      serverRuntime: getServerRuntime(process.versions),
      ...(options?.getSqliteStatus
        ? { sqlite: options.getSqliteStatus() }
        : {}),
      ...(options?.getArtifactViewerStatus
        ? { artifactViewer: options.getArtifactViewerStatus() }
        : {}),
      latest,
      updateAvailable,
      installSource: currentVersionInfo.installSource,
      ...(currentVersionInfo.sourceRevision
        ? { sourceRevision: currentVersionInfo.sourceRevision }
        : {}),
      resumeProtocolVersion: RESUME_PROTOCOL_VERSION,
      ...(options?.nativePush &&
      capabilities.includes(SERVER_CAPABILITIES.nativePushSubscriptions.name)
        ? { nativePush: options.nativePush }
        : {}),
      remoteCompatibilityLevel: REMOTE_COMPATIBILITY_LEVEL,
      ...(capabilityEncoding
        ? encodeVersionedServerCapabilities(
            capabilities,
            current,
            deniedCapabilities,
          )
        : compactCapabilities
          ? encodeCompactServerCapabilities(
              capabilities,
              current,
              deniedCapabilities,
            )
          : { capabilities }),
      ...(capabilities.includes(
        SERVER_CAPABILITIES.experimentalConversation.name,
      )
        ? { experimentalSimpleClientApiRevision: CONVERSATION_API_REVISION }
        : {}),
      sessionSandboxing: sessionSandboxAvailability,
      voiceBackends,
      voiceBackendStatuses,
      voiceBackendCapabilities,
      deviceBridgeState: deviceBridgeStatus.state,
      deviceBridgeVersion: deviceBridgeStatus.installedVersion ?? null,
      latestDeviceBridgeVersion: deviceBridgeStatus.latestVersion ?? null,
      ...(clientDefaults ? { clientDefaults } : {}),
      ...(options?.desktopRuntime ? { desktopRuntime: true } : {}),
      ...(isProviderHostDegraded() ? { providerHostDegraded: true } : {}),
    };

    return c.json(info);
  });

  return routes;
}
