import type {
  ArtifactViewerStatus,
  SqliteStatus,
  CapabilityBitset,
  ClientDefaults,
  OptionalServerCapabilityBitset,
  SessionSandboxAvailability,
} from "@yep-anywhere/shared";
import { fetchJSON } from "./sourceApiFetch";

export interface VersionInfo {
  /** Storage diagnostic only; absent on older servers. */
  sqlite?: SqliteStatus;
  artifactViewer?: ArtifactViewerStatus;
  current: string;
  latest: string | null;
  updateAvailable: boolean;
  /** Best-effort install source for update guidance. Undefined on older servers. */
  installSource?: "npm-global" | "source" | "release-package" | "unknown";
  /** Session resume protocol version supported by server (undefined on older servers). */
  resumeProtocolVersion?: number;
  /** Coarse hosted remote UI/server compatibility level. Undefined on older servers. */
  remoteCompatibilityLevel?: number;
  /** Feature capabilities supported by the server. Undefined on older servers. */
  capabilities?: string[];
  /** Negotiated numeric capability representation. */
  capabilityEncoding?: number;
  /** Explicit capability IDs not implied by `current`. */
  capabilityBits?: CapabilityBitset;
  /** Version-implied capability IDs explicitly denied by this server. */
  deniedCapabilityBits?: CapabilityBitset;
  /** Compact sparse words for optional capabilities. Undefined on older servers. */
  optionalCapabilityBits?: OptionalServerCapabilityBitset;
  /** Capability names not implied by the reported release. */
  capabilityExtensions?: string[];
  /** Local server-host sandbox preflight. Undefined on older servers. */
  sessionSandboxing?: SessionSandboxAvailability;
  /** Server-routed speech backend ids validated by the server. */
  voiceBackends?: string[];
  /** Configured server-routed speech backends, including validation state. */
  voiceBackendStatuses?: Array<{
    id: string;
    label: string;
    enabled: boolean;
    validationStatus: "pending" | "enabled" | "disabled";
    capabilities?: { streaming?: boolean; smartTurn?: boolean };
    disabledReason?: string;
  }>;
  /** Capability map keyed by server-routed speech backend id. */
  voiceBackendCapabilities?: Record<
    string,
    { streaming?: boolean; smartTurn?: boolean }
  >;
  /** Device bridge availability and update state. Undefined on older servers. */
  deviceBridgeState?:
    | "available"
    | "downloadable"
    | "update-available"
    | "unavailable";
  /** Installed managed bridge binary version when known. */
  deviceBridgeVersion?: string | null;
  /** Latest bridge release version when known. */
  latestDeviceBridgeVersion?: string | null;
  /** Server-learned browser defaults used when local storage has no explicit value. */
  clientDefaults?: ClientDefaults;
  /** True when this server is bundled with the native desktop shell. */
  desktopRuntime?: boolean;
}

export interface ServerInfo {
  /** The host/interface the server is bound to (e.g., "127.0.0.1" or "0.0.0.0") */
  host: string;
  /** The port the server is listening on */
  port: number;
  /** Whether the server is bound to all interfaces (0.0.0.0) */
  boundToAllInterfaces: boolean;
  /** Whether the server is localhost-only */
  localhostOnly: boolean;
}

/**
 * One documented startup env var. For set secrets, `value` is a redacted
 * preview produced server-side; the raw secret is never sent to the client.
 */
export interface EnvSettingEntry {
  name: string;
  group: string;
  description: string;
  secret: boolean;
  set: boolean;
  value?: string;
  /** Dynamic, runtime-computed caption (e.g. HOST's active listen addresses). */
  note?: string;
}

export interface EnvSettingsReport {
  entries: EnvSettingEntry[];
}

export interface GetVersionOptions {
  /** Bypass the server's routine version cache and refresh from the update service. */
  fresh?: boolean;
}

export const serverMetadataApi = {
  getVersion: (options?: GetVersionOptions) =>
    fetchJSON<VersionInfo>(options?.fresh ? "/version?fresh=1" : "/version"),

  getServerInfo: () => fetchJSON<ServerInfo>("/server-info"),

  getEnvSettings: () => fetchJSON<EnvSettingsReport>("/env-settings"),

  restartServer: () =>
    fetchJSON<{ ok: boolean; message: string }>("/server/restart", {
      method: "POST",
    }),
};
