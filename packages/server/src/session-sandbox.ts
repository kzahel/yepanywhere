import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  closeSync,
  existsSync,
  fstatSync,
  lstatSync,
  openSync,
  readdirSync,
} from "node:fs";
import {
  constants as fsConstants,
  chmod,
  copyFile,
  cp,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readlink,
  realpath,
  rm,
  stat,
  writeFile,
  type FileHandle,
} from "node:fs/promises";
import { homedir, networkInterfaces, tmpdir } from "node:os";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import { fileURLToPath } from "node:url";
import type {
  ProviderName,
  RecapMode,
  SessionSandboxAvailability,
  SessionSandboxAvailabilityState,
  SessionSandboxBlocker,
  SessionSandboxEnforcement,
  SessionSandboxHostPackage,
  SessionSandboxLevel,
} from "@yep-anywhere/shared";
import { getDefaultCodexHomeDir } from "./projects/codex-scanner.js";
import { stripYaControlPlaneCredentials } from "./sdk/providers/env-filter.js";

const BWRAP_CANDIDATES = ["/usr/bin/bwrap", "/bin/bwrap"] as const;
const UNSHARE_CANDIDATES = ["/usr/bin/unshare", "/bin/unshare"] as const;
const SLIRP4NETNS_CANDIDATES = [
  "/usr/bin/slirp4netns",
  "/bin/slirp4netns",
] as const;
const IP_CANDIDATES = [
  "/usr/sbin/ip",
  "/sbin/ip",
  "/usr/bin/ip",
  "/bin/ip",
] as const;
const NSENTER_CANDIDATES = ["/usr/bin/nsenter", "/bin/nsenter"] as const;
const NETWORK_LAUNCHER_PATH = fileURLToPath(
  new URL("./session-sandbox-network-launcher.mjs", import.meta.url),
);
const PORT_BROKER_PATH = fileURLToPath(
  new URL("./session-sandbox-port-broker.mjs", import.meta.url),
);
const NETWORK_BLOCKED_IPV4_DESTINATIONS = [
  "0.0.0.0/8",
  "10.0.0.0/8",
  "100.64.0.0/10",
  "127.0.0.0/8",
  "169.254.0.0/16",
  "172.16.0.0/12",
  "192.0.0.0/24",
  "192.0.2.0/24",
  "192.168.0.0/16",
  "198.18.0.0/15",
  "198.51.100.0/24",
  "203.0.113.0/24",
  "224.0.0.0/4",
  "240.0.0.0/4",
] as const;
/**
 * Mount point for one launch's session-environment bridge, inside the
 * sandbox's fresh /run tmpfs, where no other session's bridge can appear.
 */
const SESSION_ENV_BRIDGE_MOUNT_POINT = "/run/ya-agentctl-session";
/** Prefix of the availability probe's throwaway state; never a state key. */
const AVAILABILITY_PROBE_STATE_PREFIX = ".availability-probe-";
const SUPPORTED_PROVIDERS = new Set<ProviderName>([
  "claude",
  "claude-gateway",
  "claude-ollama",
  "codex",
]);
const SANDBOX_STATE_KEY_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;
const MINIMUM_BWRAP_VERSION = [0, 4, 0] as const;
const SESSION_SANDBOX_AVAILABILITY_TTL_MS = 60_000;
const PROJECT_DIRECTORY_CHILD_FD = 3;
/** Ubuntu 23.10+ sets this to 1, denying user namespaces to unprofiled tools. */
const APPARMOR_USERNS_RESTRICTION_PATH =
  "/proc/sys/kernel/apparmor_restrict_unprivileged_userns";

type SessionSandboxSetupFailureState = Exclude<
  SessionSandboxAvailabilityState,
  "available" | "unsupported-platform" | "auth-required"
>;

class SessionSandboxSetupError extends Error {
  constructor(
    readonly state: SessionSandboxSetupFailureState,
    message: string,
    readonly version?: string,
    readonly blocker?: SessionSandboxBlocker,
  ) {
    super(message);
    this.name = "SessionSandboxSetupError";
  }
}

let cachedSessionSandboxAvailability:
  | {
      checkedAt: number;
      value: SessionSandboxAvailability;
    }
  | undefined;
let pendingSessionSandboxAvailability:
  | Promise<SessionSandboxAvailability>
  | undefined;

export interface SessionSandboxSpawn {
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  stdio: ["pipe", "pipe", "pipe", number];
  /** Release the parent copy after child_process.spawn() has inherited it. */
  release(): void;
}

export interface SessionSandboxRuntime {
  readonly instructions?: import("@yep-anywhere/shared").ResolvedLimitedUserInstructions;
  readonly enforcement: SessionSandboxEnforcement;
  readonly stateKey: string;
  /** Canonical project path whose writable bind defines this sandbox. */
  readonly projectPath: string;
  /** Provider transcript directory inside the project-scoped private state. */
  readonly transcriptDir: string;
  /**
   * Open the transcript directory through no-follow directory handles.
   * Host-side fork helpers must not resolve agent-controlled symlinks.
   */
  openTranscriptDirectory(): Promise<FileHandle>;
  /** Where a launch's session-environment bridge appears inside the sandbox. */
  readonly sessionEnvBridgeDirectory: string;
  /**
   * A runtime whose spawns also mount this one launch's bridge directory
   * read-only at `sessionEnvBridgeDirectory`. It is a directory bind, so the
   * server's later atomic replacements inside it stay visible.
   */
  withSessionEnvBridge(hostDirectory: string): SessionSandboxRuntime;
  wrapSpawn(
    command: string,
    args: readonly string[],
    env: NodeJS.ProcessEnv,
  ): SessionSandboxSpawn;
}

export interface PrepareSessionSandboxOptions {
  instructions?: import("@yep-anywhere/shared").ResolvedLimitedUserInstructions;
  level: SessionSandboxLevel | undefined;
  /** Public-only egress boundary; absent defaults on for project-write. */
  networkFirewall?: boolean;
  provider: ProviderName;
  projectPath: string;
  executor?: string;
  /** Restores the project-private state selected by persisted metadata. */
  stateKey?: string;
  resumeSessionId?: string;
  /** Test-only override; production intentionally uses trusted system paths. */
  bwrapPath?: string;
  /** Test-only overrides; production intentionally uses trusted system paths. */
  unsharePath?: string;
  slirp4netnsPath?: string;
  ipPath?: string;
  /** Test-only override for keeping fixtures out of the real YA state root. */
  stateRoot?: string;
}

export function getSessionSandboxSettingsError(
  level: SessionSandboxLevel | undefined,
  recapMode: RecapMode | undefined,
): string | undefined {
  if (level === "project-write" && recapMode === "side-session") {
    return (
      "Project-write sandboxed sessions currently support Off, Native, or " +
      "fork recaps; YA side-session helpers are unavailable in v1."
    );
  }
  return undefined;
}

function sandboxInstallError(detail?: string): SessionSandboxSetupError {
  const suffix = detail ? ` (${detail})` : "";
  return new SessionSandboxSetupError(
    "missing-bubblewrap",
    `Sandboxed sessions require Bubblewrap (bwrap)${suffix}. ` +
      "Install it with `sudo dnf install bubblewrap` on Rocky/RHEL/Fedora " +
      "or `sudo apt install bubblewrap` on Debian/Ubuntu.",
    undefined,
    { kind: "missing-packages", packages: ["bubblewrap"] },
  );
}

function sandboxTrustError(): SessionSandboxSetupError {
  return new SessionSandboxSetupError(
    "untrusted-bubblewrap",
    "Sandboxed sessions require a root-owned Bubblewrap binary at " +
      "/usr/bin/bwrap or /bin/bwrap that is not group- or world-writable.",
  );
}

function sandboxRuntimeError(detail: string): SessionSandboxSetupError {
  return new SessionSandboxSetupError(
    "probe-failed",
    `Bubblewrap is installed but could not enforce the session sandbox (${detail}). ` +
      "Check that this host permits unprivileged user and mount namespaces.",
  );
}

function sandboxNetworkInstallError(
  packages: readonly SessionSandboxHostPackage[],
): SessionSandboxSetupError {
  const list = packages.join(", ");
  return new SessionSandboxSetupError(
    "probe-failed",
    `Network-firewalled sandboxed sessions require trusted helpers from ${list}. ` +
      `Install ${list} before starting this session.`,
    undefined,
    { kind: "missing-packages", packages: [...packages] },
  );
}

function missingPackagesOf(error: unknown): SessionSandboxHostPackage[] {
  return error instanceof SessionSandboxSetupError &&
    error.blocker?.kind === "missing-packages"
    ? error.blocker.packages
    : [];
}

function sandboxNetworkTrustError(tool: string): SessionSandboxSetupError {
  return new SessionSandboxSetupError(
    "probe-failed",
    `Network-firewalled sandboxed sessions require a root-owned ${tool} binary ` +
      "that is not group- or world-writable.",
  );
}

function sandboxNetworkRuntimeError(detail: string): SessionSandboxSetupError {
  return new SessionSandboxSetupError(
    "probe-failed",
    `The session network firewall could not establish isolated public egress (${detail}). ` +
      "Check that this host permits unprivileged user and network namespaces.",
  );
}

function isWithin(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== "..");
}

function hasErrorCode(error: unknown, code: string): boolean {
  return (
    error !== null &&
    typeof error === "object" &&
    "code" in error &&
    error.code === code
  );
}

async function findTrustedSystemExecutable(
  candidates: readonly string[],
): Promise<{ path?: string; found: boolean }> {
  let foundCandidate = false;
  for (const candidate of candidates) {
    if (!isAbsolute(candidate)) continue;
    try {
      const resolved = await realpath(candidate);
      const info = await stat(resolved);
      foundCandidate = true;
      if (!info.isFile() || info.uid !== 0 || (info.mode & 0o022) !== 0) {
        continue;
      }
      return { path: resolved, found: true };
    } catch {
      // Try the next trusted system location.
    }
  }
  return { found: foundCandidate };
}

async function resolveTrustedBwrap(explicit?: string): Promise<string> {
  const result = await findTrustedSystemExecutable(
    explicit ? [explicit] : BWRAP_CANDIDATES,
  );
  if (result.path) return result.path;
  if (result.found) throw sandboxTrustError();
  throw sandboxInstallError();
}

async function resolveTrustedNetworkHelper(
  tool: string,
  hostPackage: SessionSandboxHostPackage,
  candidates: readonly string[],
  explicit?: string,
): Promise<string> {
  const result = await findTrustedSystemExecutable(
    explicit ? [explicit] : candidates,
  );
  if (result.path) return result.path;
  if (result.found) throw sandboxNetworkTrustError(tool);
  throw sandboxNetworkInstallError([hostPackage]);
}

async function runBwrapProbe(
  bwrapPath: string,
  args: readonly string[],
  projectDirectoryFd?: number,
): Promise<void> {
  await new Promise<void>((resolveProbe, rejectProbe) => {
    const child = spawn(bwrapPath, [...args, "--", "/bin/true"], {
      stdio:
        projectDirectoryFd === undefined
          ? ["ignore", "ignore", "pipe"]
          : ["ignore", "ignore", "pipe", projectDirectoryFd],
      env: process.env,
    });
    let stderr = "";
    child.stderr?.on("data", (chunk: Buffer) => {
      if (stderr.length < 4000) stderr += chunk.toString("utf8");
    });
    child.once("error", (error) => {
      rejectProbe(sandboxRuntimeError(error.message));
    });
    child.once("exit", (code, signal) => {
      if (code === 0) {
        resolveProbe();
        return;
      }
      const detail =
        stderr.trim() ||
        `probe exited with ${signal ? `signal ${signal}` : `status ${code}`}`;
      rejectProbe(sandboxRuntimeError(detail));
    });
  });
}

interface SessionSandboxNetworkTools {
  unsharePath: string;
  slirp4netnsPath: string;
  ipPath: string;
}

interface SessionSandboxPortBroker {
  nsenterPath: string;
  nodePath: string;
  script: string;
  directory: string;
}

/**
 * Host directory of firewalled sandboxes' loopback port brokers. It is under
 * host /tmp because every sandbox replaces /tmp with its own private one, so
 * no sandbox can reach another's broker.
 */
export function sandboxPortBrokerDirectory(): string {
  return join(tmpdir(), `ya-sandbox-ports-${process.getuid?.() ?? "user"}`);
}

/** The broker socket of the firewalled launch whose launcher pid is `pid`. */
export function sandboxPortBrokerSocketPath(pid: number): string {
  return join(sandboxPortBrokerDirectory(), `${pid}.sock`);
}

/**
 * The broker a firewalled launch starts, or undefined when app exposure is
 * unavailable here. Host /tmp is shared with other accounts, so the directory
 * is used only when it is a real directory this account owns with no group
 * or other access; anything else could let another account plant a socket.
 */
async function resolveSessionSandboxPortBroker(): Promise<
  SessionSandboxPortBroker | undefined
> {
  const nsenter = await findTrustedSystemExecutable(NSENTER_CANDIDATES);
  const script = await stat(PORT_BROKER_PATH).catch(() => undefined);
  if (!nsenter.path || !script?.isFile()) return undefined;
  const directory = sandboxPortBrokerDirectory();
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const info = lstatSync(directory);
  if (
    !info.isDirectory() ||
    (process.getuid !== undefined && info.uid !== process.getuid()) ||
    (info.mode & 0o077) !== 0
  ) {
    return undefined;
  }
  return {
    nsenterPath: nsenter.path,
    nodePath: process.execPath,
    script: PORT_BROKER_PATH,
    directory,
  };
}

function blockedIpv4Destinations(): string[] {
  const destinations = new Set<string>(NETWORK_BLOCKED_IPV4_DESTINATIONS);
  for (const addresses of Object.values(networkInterfaces())) {
    for (const address of addresses ?? []) {
      if (address.family === "IPv4") {
        destinations.add(`${address.address}/32`);
      }
    }
  }
  return [...destinations];
}

function buildNetworkLauncherArgs(options: {
  tools: SessionSandboxNetworkTools;
  bwrapPath: string;
  bwrapArgs: readonly string[];
  blockedDestinations: readonly string[];
  passProjectFd: boolean;
  portBroker?: SessionSandboxPortBroker;
  command: string;
  commandArgs: readonly string[];
}): string[] {
  return [
    NETWORK_LAUNCHER_PATH,
    JSON.stringify({
      unsharePath: options.tools.unsharePath,
      slirpPath: options.tools.slirp4netnsPath,
      ipPath: options.tools.ipPath,
      bwrapPath: options.bwrapPath,
      bwrapArgs: options.bwrapArgs,
      blockedDestinations: options.blockedDestinations,
      passProjectFd: options.passProjectFd,
      ...(options.portBroker ? { portBroker: options.portBroker } : {}),
    }),
    options.command,
    ...options.commandArgs,
  ];
}

async function resolveSessionSandboxNetworkTools(options: {
  unsharePath?: string;
  slirp4netnsPath?: string;
  ipPath?: string;
}): Promise<SessionSandboxNetworkTools> {
  const launcher = await stat(NETWORK_LAUNCHER_PATH).catch(() => undefined);
  if (!launcher?.isFile()) {
    throw sandboxNetworkRuntimeError("the YA network launcher is missing");
  }
  const [unshare, slirp4netns, ip] = await Promise.allSettled([
    resolveTrustedNetworkHelper(
      "unshare",
      "util-linux",
      UNSHARE_CANDIDATES,
      options.unsharePath,
    ),
    resolveTrustedNetworkHelper(
      "slirp4netns",
      "slirp4netns",
      SLIRP4NETNS_CANDIDATES,
      options.slirp4netnsPath,
    ),
    resolveTrustedNetworkHelper(
      "ip",
      "iproute2",
      IP_CANDIDATES,
      options.ipPath,
    ),
  ]);
  if (
    unshare.status === "fulfilled" &&
    slirp4netns.status === "fulfilled" &&
    ip.status === "fulfilled"
  ) {
    return {
      unsharePath: unshare.value,
      slirp4netnsPath: slirp4netns.value,
      ipPath: ip.value,
    };
  }
  // Name every absent package at once, so one install clears the preflight;
  // an untrusted helper is a different fix and takes precedence.
  const failures = [unshare, slirp4netns, ip].flatMap((result) =>
    result.status === "rejected" ? [result.reason] : [],
  );
  const untrusted = failures.find(
    (failure) => missingPackagesOf(failure).length === 0,
  );
  if (untrusted) throw untrusted;
  throw sandboxNetworkInstallError(failures.flatMap(missingPackagesOf));
}

async function isUnprivilegedUsernsRestricted(
  path = APPARMOR_USERNS_RESTRICTION_PATH,
): Promise<boolean> {
  try {
    return (await readFile(path, "utf8")).trim() === "1";
  } catch (error) {
    // Kernels without the AppArmor knob impose no such restriction.
    if (hasErrorCode(error, "ENOENT")) return false;
    throw error;
  }
}

async function runNetworkSandboxProbe(options: {
  tools: SessionSandboxNetworkTools;
  bwrapPath: string;
  bwrapArgs: readonly string[];
  blockedDestinations: readonly string[];
  projectDirectoryFd?: number;
}): Promise<void> {
  await new Promise<void>((resolveProbe, rejectProbe) => {
    const child = spawn(
      process.execPath,
      buildNetworkLauncherArgs({
        ...options,
        passProjectFd: options.projectDirectoryFd !== undefined,
        command: "/bin/true",
        commandArgs: [],
      }),
      {
        cwd: "/",
        stdio:
          options.projectDirectoryFd === undefined
            ? ["ignore", "ignore", "pipe"]
            : ["ignore", "ignore", "pipe", options.projectDirectoryFd],
        env: process.env,
      },
    );
    let stderr = "";
    child.stderr?.on("data", (chunk: Buffer) => {
      if (stderr.length < 8000) stderr += chunk.toString("utf8");
    });
    child.once("error", (error) => {
      rejectProbe(sandboxNetworkRuntimeError(error.message));
    });
    child.once("exit", (code, signal) => {
      if (code === 0) {
        resolveProbe();
        return;
      }
      const detail =
        stderr.trim() ||
        `probe exited with ${signal ? `signal ${signal}` : `status ${code}`}`;
      rejectProbe(sandboxNetworkRuntimeError(detail));
    });
  });
}

async function requireSupportedBwrapVersion(
  bwrapPath: string,
): Promise<string> {
  const output = await new Promise<string>((resolveVersion, rejectVersion) => {
    const child = spawn(bwrapPath, ["--version"], {
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      if (stdout.length < 1000) stdout += chunk.toString("utf8");
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      if (stderr.length < 1000) stderr += chunk.toString("utf8");
    });
    child.once("error", (error) => {
      rejectVersion(sandboxRuntimeError(error.message));
    });
    // "exit" can precede the last stdout chunk; a loaded host then reads the
    // version as empty. "close" fires after the pipes drain.
    child.once("close", (code, signal) => {
      if (code === 0) {
        resolveVersion(stdout.trim());
        return;
      }
      const detail =
        stderr.trim() ||
        `version check exited with ${signal ? `signal ${signal}` : `status ${code}`}`;
      rejectVersion(sandboxRuntimeError(detail));
    });
  });
  const match = /\b(?:bubblewrap|bwrap)\s+(\d+)\.(\d+)(?:\.(\d+))?\b/i.exec(
    output,
  );
  if (!match) {
    throw sandboxRuntimeError(`unrecognized bwrap --version output: ${output}`);
  }
  const found = [
    Number(match[1]),
    Number(match[2]),
    Number(match[3] ?? 0),
  ] as const;
  const supported =
    found[0] > MINIMUM_BWRAP_VERSION[0] ||
    (found[0] === MINIMUM_BWRAP_VERSION[0] &&
      (found[1] > MINIMUM_BWRAP_VERSION[1] ||
        (found[1] === MINIMUM_BWRAP_VERSION[1] &&
          found[2] >= MINIMUM_BWRAP_VERSION[2])));
  if (!supported) {
    const version = found.join(".");
    throw new SessionSandboxSetupError(
      "unsupported-version",
      `Sandboxed sessions require Bubblewrap 0.4.0 or newer (found ${found.join(".")}). ` +
        "Upgrade Bubblewrap before starting this session.",
      version,
    );
  }
  return found.join(".");
}

export interface ProbeSessionSandboxAvailabilityOptions {
  /** Test-only platform override. Production probes the execution host. */
  platform?: NodeJS.Platform;
  /** Test-only binary override. Production uses fixed trusted system paths. */
  bwrapPath?: string;
  /** Test-only helper overrides. Production uses fixed trusted system paths. */
  unsharePath?: string;
  slirp4netnsPath?: string;
  ipPath?: string;
  /** Test-only override for the AppArmor user-namespace restriction knob. */
  usernsRestrictionPath?: string;
  /**
   * Private-state root whose throwaway subdirectory the probe mounts, as a
   * launch mounts its real state. Defaults to the launch default.
   */
  stateRoot?: string;
  /** Test-only override for the host resolver path the launch mounts over. */
  resolvConfPath?: string;
}

/**
 * A host missing Bubblewrap often lacks the network helpers too; name them
 * together so a single install makes the sandbox available.
 */
async function withMissingNetworkPackages(
  error: SessionSandboxSetupError,
  options: ProbeSessionSandboxAvailabilityOptions,
): Promise<SessionSandboxBlocker | undefined> {
  const network = await resolveSessionSandboxNetworkTools(options).then(
    () => [],
    missingPackagesOf,
  );
  return {
    kind: "missing-packages",
    packages: [...missingPackagesOf(error), ...network],
  };
}

/**
 * Check whether this server host can currently offer a local session sandbox.
 * The probe mounts what a launch mounts, over throwaway state; the
 * project-specific launch path repeats all checks with its final binds.
 */
export async function probeSessionSandboxAvailability(
  options: ProbeSessionSandboxAvailabilityOptions = {},
): Promise<SessionSandboxAvailability> {
  const platform = options.platform ?? process.platform;
  if (platform !== "linux") {
    return {
      state: "unsupported-platform",
      platform,
    };
  }

  try {
    const bwrapPath = await resolveTrustedBwrap(options.bwrapPath);
    const version = await requireSupportedBwrapVersion(bwrapPath);
    const tools = await resolveSessionSandboxNetworkTools(options);
    try {
      await probeLaunchShape({
        tools,
        bwrapPath,
        stateRoot: options.stateRoot,
        resolvConfPath: options.resolvConfPath,
      });
    } catch (error) {
      // Bubblewrap ships its own AppArmor exemption; the namespace helper
      // does not, so this knob is the likely cause of a failed setup.
      if (
        error instanceof SessionSandboxSetupError &&
        (await isUnprivilegedUsernsRestricted(options.usernsRestrictionPath))
      ) {
        throw new SessionSandboxSetupError(
          error.state,
          error.message,
          version,
          { kind: "userns-restricted" },
        );
      }
      throw error;
    }
    return {
      state: "available",
      platform,
      backend: "bubblewrap",
      version,
    };
  } catch (error) {
    if (error instanceof SessionSandboxSetupError) {
      const blocker =
        error.state === "missing-bubblewrap"
          ? await withMissingNetworkPackages(error, options)
          : error.blocker;
      return {
        state: error.state,
        platform,
        backend: "bubblewrap",
        ...(error.version ? { version: error.version } : {}),
        ...(blocker ? { blocker } : {}),
      };
    }
    return {
      state: "probe-failed",
      platform,
      backend: "bubblewrap",
    };
  }
}

/**
 * Coalesce and briefly cache host preflight checks for version/capability
 * reads. There is intentionally no background poll; `fresh=1` rechecks.
 */
export function getSessionSandboxAvailability(options?: {
  forceRefresh?: boolean;
  /** The private-state root launches use; the probe mounts from it too. */
  stateRoot?: string;
}): Promise<SessionSandboxAvailability> {
  const now = Date.now();
  if (
    !options?.forceRefresh &&
    cachedSessionSandboxAvailability &&
    now - cachedSessionSandboxAvailability.checkedAt <
      SESSION_SANDBOX_AVAILABILITY_TTL_MS
  ) {
    return Promise.resolve(cachedSessionSandboxAvailability.value);
  }
  if (!options?.forceRefresh && pendingSessionSandboxAvailability) {
    return pendingSessionSandboxAvailability;
  }

  const request = probeSessionSandboxAvailability({
    stateRoot: options?.stateRoot,
  }).then((value) => {
    cachedSessionSandboxAvailability = {
      checkedAt: Date.now(),
      value,
    };
    return value;
  });
  pendingSessionSandboxAvailability = request;
  void request.finally(() => {
    if (pendingSessionSandboxAvailability === request) {
      pendingSessionSandboxAvailability = undefined;
    }
  });
  return request;
}

async function copyBootstrapEntry(
  sourceRoot: string,
  destinationRoot: string,
  entry: string,
): Promise<void> {
  const source = join(sourceRoot, entry);
  const destination = join(destinationRoot, entry);
  try {
    await lstat(source);
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) return;
    throw error;
  }
  await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
  // cp anchors relative links to the source path's parent. Canonicalize that
  // parent first: a symlinked harness home can have a different real parent.
  const canonicalSource = join(
    await realpath(dirname(source)),
    basename(source),
  );
  await cp(canonicalSource, destination, {
    recursive: true,
    force: false,
    errorOnExist: false,
    preserveTimestamps: true,
    dereference: false,
    verbatimSymlinks: false,
    mode: fsConstants.COPYFILE_FICLONE,
  });
}

async function bootstrapProviderState(options: {
  provider: ProviderName;
  providerStateDir: string;
  privateClaudeJson: string;
}): Promise<void> {
  const marker = join(
    dirname(options.providerStateDir),
    `.ya-${options.provider === "codex" ? "codex" : "claude"}-sandbox-initialized`,
  );
  try {
    await stat(marker);
    return;
  } catch (error) {
    if (!hasErrorCode(error, "ENOENT")) throw error;
  }

  if (options.provider === "codex") {
    const source = getDefaultCodexHomeDir();
    for (const entry of [
      "auth.json",
      "config.toml",
      "models_cache.json",
      "plugins",
      "rules",
      "skills",
    ]) {
      await copyBootstrapEntry(source, options.providerStateDir, entry);
    }
  } else {
    // .credentials.json is shared, not copied: see sharedClaudeCredentials.
    const source = hostClaudeConfigDir();
    for (const entry of ["settings.json", "plugins", "skills"]) {
      await copyBootstrapEntry(source, options.providerStateDir, entry);
    }
    const hostClaudeJson = join(homedir(), ".claude.json");
    try {
      await copyFile(
        hostClaudeJson,
        options.privateClaudeJson,
        fsConstants.COPYFILE_FICLONE,
      );
    } catch (error) {
      if (!hasErrorCode(error, "ENOENT")) throw error;
      await writeEmptyFile(options.privateClaudeJson);
    }
    await chmod(options.privateClaudeJson, 0o600);
  }

  await writeEmptyFile(marker);
  await chmod(marker, 0o600);
}

function hostClaudeConfigDir(): string {
  return process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude");
}

/**
 * The host's Claude login, mounted writable over the private config's
 * `.credentials.json`. Claude rotates its refresh token on every refresh and
 * the old one dies, so a private copy stops working as soon as either side
 * refreshes, and a sandbox refreshing first logs the host out. One shared
 * file keeps both current: Claude rewrites it in place and re-reads it when
 * another process refreshed first. Sandboxes can already read this file
 * through the read-only host view; sharing adds write access to it.
 */
async function sharedClaudeCredentials(
  providerStateDir: string,
): Promise<{ source: string; target: string } | undefined> {
  const source = join(hostClaudeConfigDir(), ".credentials.json");
  try {
    // Claude itself refuses a symlinked credentials file.
    if (!(await lstat(source)).isFile()) return undefined;
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) return undefined;
    throw error;
  }
  const target = join(providerStateDir, ".credentials.json");
  // The bind needs an existing mount point; an older sandbox's stale copy
  // serves, and is hidden under the mount.
  await writeFile(target, "", { flag: "a", mode: 0o600 });
  return { source, target };
}

async function writeEmptyFile(destination: string): Promise<void> {
  await copyFile("/dev/null", destination);
}

async function hasClaudeJsonMountPoint(): Promise<boolean> {
  const destination = join(homedir(), ".claude.json");
  try {
    const info = await stat(destination);
    if (!info.isFile()) {
      throw new Error(
        `Cannot sandbox Claude because ${destination} is not a regular file`,
      );
    }
    return true;
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) return false;
    throw error;
  }
}

function claudeProjectDirectory(projectPath: string): string {
  return projectPath.replace(/[/\\:]/g, "-");
}

export function getClaudeSandboxProjectDir(options: {
  dataDir: string;
  stateKey: string;
  projectPath: string;
}): string {
  return join(
    options.dataDir,
    "session-sandboxes",
    options.stateKey,
    "claude",
    "projects",
    claudeProjectDirectory(options.projectPath),
  );
}

export function getCodexSandboxSessionsDir(options: {
  dataDir: string;
  stateKey: string;
}): string {
  return join(
    options.dataDir,
    "session-sandboxes",
    options.stateKey,
    "codex",
    "sessions",
  );
}

interface ProjectDirectoryIdentity {
  device: bigint;
  inode: bigint;
}

interface ProjectDirectoryAnchor {
  fd: number;
  identity: ProjectDirectoryIdentity;
  release(): void;
}

function openProjectDirectoryAnchor(
  projectPath: string,
  expectedIdentity?: ProjectDirectoryIdentity,
): ProjectDirectoryAnchor {
  let fd: number | undefined;
  try {
    fd = openSync(
      projectPath,
      fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW,
    );
    const info = fstatSync(fd, { bigint: true });
    if (!info.isDirectory()) {
      throw new Error("the selected project is no longer a directory");
    }
    if (
      expectedIdentity &&
      (info.dev !== expectedIdentity.device ||
        info.ino !== expectedIdentity.inode)
    ) {
      throw new Error("the selected project's filesystem identity changed");
    }

    const anchorFd = fd;
    let released = false;
    return {
      fd: anchorFd,
      identity: { device: info.dev, inode: info.ino },
      release() {
        if (released) return;
        released = true;
        closeSync(anchorFd);
      },
    };
  } catch (error) {
    if (fd !== undefined) closeSync(fd);
    const detail = error instanceof Error ? ` (${error.message})` : "";
    if (expectedIdentity) {
      throw new Error(
        `Session sandbox project boundary changed before provider launch; refusing to follow ${projectPath}${detail}.`,
      );
    }
    throw new Error(
      `Session sandbox could not anchor the selected project directory ${projectPath}${detail}.`,
    );
  }
}

/**
 * Where the sandbox's private resolver file must be mounted. Hosts that manage
 * DNS (systemd-resolved on Ubuntu) make /etc/resolv.conf a symlink into /run,
 * which the sandbox replaces with a fresh tmpfs; mounting at the link would
 * follow it into a directory that no longer exists. The final target need not
 * exist on the host either, since the mount creates it.
 */
async function resolvConfMountPoint(
  path = "/etc/resolv.conf",
): Promise<string> {
  let current = path;
  for (let hop = 0; hop < 8; hop++) {
    let target: string;
    try {
      target = await readlink(current);
    } catch (error) {
      // EINVAL: not a symlink. ENOENT: a dangling final target.
      if (hasErrorCode(error, "EINVAL") || hasErrorCode(error, "ENOENT")) {
        return current;
      }
      throw error;
    }
    current = resolve(dirname(current), target);
  }
  throw sandboxNetworkRuntimeError(`${path} has too many symlink hops`);
}

function buildBwrapBaseArgs(options: {
  projectPath: string;
  projectSourcePath: string;
  providerStateDir: string;
  cacheDir: string;
  tempDir: string;
  varTempDir: string;
  privateClaudeJson?: string;
  sharedCredentials?: { source: string; target: string };
  providerHostRuntimeDir?: string;
  networkResolvConf?: { source: string; mountPoint: string };
}): string[] {
  const args = [
    "--unshare-all",
    "--share-net",
    "--die-with-parent",
    "--new-session",
    "--cap-drop",
    "ALL",
    "--ro-bind",
    "/",
    "/",
    "--proc",
    "/proc",
    "--dev",
    "/dev",
    "--tmpfs",
    "/run",
    "--bind",
    options.tempDir,
    "/tmp",
    "--bind",
    options.varTempDir,
    "/var/tmp",
    "--bind",
    options.projectSourcePath,
    options.projectPath,
    "--bind",
    options.providerStateDir,
    options.providerStateDir,
    "--bind",
    options.cacheDir,
    options.cacheDir,
  ];
  if (options.sharedCredentials) {
    // After the provider-state bind, so it overlays the private path.
    args.push(
      "--bind",
      options.sharedCredentials.source,
      options.sharedCredentials.target,
    );
  }
  if (options.privateClaudeJson) {
    args.push(
      "--bind-try",
      options.privateClaudeJson,
      join(homedir(), ".claude.json"),
    );
  }
  if (options.providerHostRuntimeDir) {
    args.push("--tmpfs", options.providerHostRuntimeDir);
  }
  if (options.networkResolvConf) {
    const { source, mountPoint } = options.networkResolvConf;
    // Inside the fresh /run tmpfs the target's directory must be made first.
    if (isWithin("/run", dirname(mountPoint))) {
      args.push("--dir", dirname(mountPoint));
    }
    args.push("--ro-bind", source, mountPoint);
  }
  args.push(
    "--chdir",
    options.projectPath,
    "--unsetenv",
    "SSH_AUTH_SOCK",
    "--unsetenv",
    "GPG_AGENT_INFO",
    "--unsetenv",
    "DOCKER_HOST",
    "--unsetenv",
    "CONTAINER_HOST",
    "--unsetenv",
    "KUBECONFIG",
    "--unsetenv",
    "AUTH_COOKIE_SECRET",
    "--unsetenv",
    "DESKTOP_AUTH_TOKEN",
    "--unsetenv",
    "YEP_PROVIDER_RUNTIME_TOKEN",
    "--unsetenv",
    "YEP_PROVIDER_RUNTIME_DIR",
    "--unsetenv",
    "YEP_PROVIDER_HOST_RUNTIME_DIR",
  );
  return args;
}

async function resolveProviderHostRuntimeMask(options: {
  projectPath: string;
  stateDir: string;
}): Promise<string | undefined> {
  const configured =
    process.env.YEP_PROVIDER_RUNTIME_DIR?.trim() ||
    process.env.YEP_PROVIDER_HOST_RUNTIME_DIR?.trim();
  if (!configured) return undefined;
  if (!isAbsolute(configured)) {
    throw new Error(
      "Session sandbox requires an absolute provider-host runtime directory.",
    );
  }
  const runtimeDir = await realpath(configured);
  const info = await stat(runtimeDir);
  if (!info.isDirectory()) {
    throw new Error(
      "Session sandbox provider-host runtime path must be a directory.",
    );
  }
  if (
    runtimeDir === "/" ||
    isWithin(runtimeDir, options.projectPath) ||
    isWithin(options.projectPath, runtimeDir) ||
    isWithin(runtimeDir, options.stateDir) ||
    isWithin(options.stateDir, runtimeDir)
  ) {
    throw new Error(
      "Session sandbox provider-host runtime directory must be dedicated and outside the project and private provider state.",
    );
  }
  for (const alreadyPrivate of ["/run", "/tmp", "/var/tmp"]) {
    if (isWithin(alreadyPrivate, runtimeDir)) return undefined;
  }
  return runtimeDir;
}

/**
 * Create the configured private-state root and return its real path.
 * Bubblewrap mount destinations must name the real directory, not an ancestor
 * symlink that it cannot create through the read-only host bind.
 */
async function resolveSandboxStateRoot(configured?: string): Promise<string> {
  const configuredRoot = sessionSandboxStateRoot(configured);
  await mkdir(configuredRoot, { recursive: true, mode: 0o700 });
  return realpath(configuredRoot);
}

function sandboxStatePaths(stateDir: string, provider: ProviderName) {
  return {
    providerStateDir: join(stateDir, provider === "codex" ? "codex" : "claude"),
    cacheDir: join(stateDir, "cache"),
    ...sandboxPrivateTempDirs(stateDir),
    privateClaudeJson: join(stateDir, "claude.json"),
    networkResolvConf: join(stateDir, "network-resolv.conf"),
  };
}

/**
 * Host directories a sandbox mounts as its private /tmp and /var/tmp, so a
 * path a sandboxed session printed under those names can be found on the
 * host. `stateDir` is `<state root>/<state key>`.
 */
export function sandboxPrivateTempDirs(stateDir: string): {
  tempDir: string;
  varTempDir: string;
} {
  return {
    tempDir: join(stateDir, "tmp"),
    varTempDir: join(stateDir, "var-tmp"),
  };
}

/**
 * Every existing sandbox's private /tmp and /var/tmp under `stateRoot`: the
 * scratch sandboxed sessions write artifacts to. Provider state, credentials
 * and caches beside them are not included.
 */
export function listSandboxPrivateTempRoots(stateRoot: string): string[] {
  let keys: string[];
  try {
    keys = readdirSync(stateRoot);
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) return [];
    throw error;
  }
  return keys
    .filter((key) => SANDBOX_STATE_KEY_PATTERN.test(key))
    .flatMap((key) => {
      const { tempDir, varTempDir } = sandboxPrivateTempDirs(
        join(stateRoot, key),
      );
      return [tempDir, varTempDir].filter((dir) => existsSync(dir));
    });
}

async function makePrivateDirectories(
  directories: readonly string[],
): Promise<void> {
  await Promise.all(
    directories.map(async (directory) => {
      await mkdir(directory, { recursive: true, mode: 0o700 });
      await chmod(directory, 0o700);
    }),
  );
}

async function writeNetworkResolvConf(path: string): Promise<void> {
  await writeFile(path, "nameserver 10.0.2.3\noptions timeout:2 attempts:2\n", {
    mode: 0o600,
  });
  await chmod(path, 0o600);
}

/**
 * Run the network launcher once with the argument shape a firewalled Claude
 * launch builds, the superset of the provider shapes, over throwaway private
 * state and project directories. A host that passes can mount everything a
 * launch mounts; the launch still repeats the probe with its real state.
 */
async function probeLaunchShape(options: {
  tools: SessionSandboxNetworkTools;
  bwrapPath: string;
  stateRoot?: string;
  resolvConfPath?: string;
}): Promise<void> {
  const root = await resolveSandboxStateRoot(options.stateRoot);
  const stateDir = await mkdtemp(join(root, AVAILABILITY_PROBE_STATE_PREFIX));
  try {
    const projectPath = join(stateDir, "project");
    const paths = sandboxStatePaths(stateDir, "claude");
    await makePrivateDirectories([
      projectPath,
      paths.providerStateDir,
      paths.cacheDir,
      paths.tempDir,
      paths.varTempDir,
    ]);
    await writeEmptyFile(paths.privateClaudeJson);
    await writeNetworkResolvConf(paths.networkResolvConf);
    const args = buildBwrapBaseArgs({
      projectPath,
      projectSourcePath: `/proc/self/fd/${PROJECT_DIRECTORY_CHILD_FD}`,
      providerStateDir: paths.providerStateDir,
      cacheDir: paths.cacheDir,
      tempDir: paths.tempDir,
      varTempDir: paths.varTempDir,
      privateClaudeJson: (await hasClaudeJsonMountPoint())
        ? paths.privateClaudeJson
        : undefined,
      providerHostRuntimeDir: await resolveProviderHostRuntimeMask({
        projectPath,
        stateDir,
      }),
      networkResolvConf: {
        source: paths.networkResolvConf,
        mountPoint: await resolvConfMountPoint(options.resolvConfPath),
      },
    });
    const projectAnchor = openProjectDirectoryAnchor(projectPath);
    try {
      await runNetworkSandboxProbe({
        tools: options.tools,
        bwrapPath: options.bwrapPath,
        bwrapArgs: args,
        blockedDestinations: blockedIpv4Destinations(),
        projectDirectoryFd: projectAnchor.fd,
      });
    } finally {
      projectAnchor.release();
    }
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
}

async function openAnchoredDirectory(
  root: string,
  relativePath: string,
): Promise<FileHandle> {
  const flags =
    fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW;
  let current = await open(root, flags);
  try {
    for (const component of relativePath.split(sep).filter(Boolean)) {
      const next = await open(
        `/proc/self/fd/${current.fd}/${component}`,
        flags,
      );
      await current.close();
      current = next;
    }
    return current;
  } catch (error) {
    await current.close();
    throw error;
  }
}

/** The root holding every project's private sandbox state. */
function sessionSandboxStateRoot(stateRoot: string | undefined): string {
  return resolve(
    stateRoot ?? join(homedir(), ".yep-anywhere", "session-sandboxes"),
  );
}

/**
 * Open a sandboxed Claude session's private transcript directory for a
 * host-side copy, the same directory `prepareSessionSandbox` gives the
 * provider and `getClaudeSandboxProjectDir` gives the readers. The state root
 * and key are YA's own; everything below them is writable from inside the
 * sandbox, so each of those components is opened without following links.
 */
export async function openClaudeSandboxTranscriptDirectory(options: {
  stateRoot?: string;
  stateKey: string;
  projectPath: string;
}): Promise<FileHandle> {
  if (!SANDBOX_STATE_KEY_PATTERN.test(options.stateKey)) {
    throw new Error("Invalid session sandbox state key");
  }
  const root = await realpath(sessionSandboxStateRoot(options.stateRoot));
  return openAnchoredDirectory(
    root,
    join(
      options.stateKey,
      "claude",
      "projects",
      claudeProjectDirectory(options.projectPath),
    ),
  );
}

export async function prepareSessionSandbox(
  options: PrepareSessionSandboxOptions,
): Promise<SessionSandboxRuntime | undefined> {
  const level = options.level ?? "none";
  if (level === "none") {
    if (options.networkFirewall === true) {
      throw new Error(
        "Session sandbox network firewall requires project-write sandboxing.",
      );
    }
    return undefined;
  }
  if (level !== "project-write") {
    throw new Error(`Invalid session sandbox level: ${String(level)}`);
  }
  if (options.executor) {
    throw new Error(
      "Project-write session sandboxing is not supported for remote executors.",
    );
  }
  if (!SUPPORTED_PROVIDERS.has(options.provider)) {
    throw new Error(
      `Project-write session sandboxing is not yet supported for provider ${options.provider}.`,
    );
  }
  if (process.platform !== "linux") {
    throw new Error(
      "Project-write session sandboxing currently requires Linux and Bubblewrap.",
    );
  }
  const projectPath = await realpath(options.projectPath);
  if (projectPath === "/") {
    throw new Error(
      "Project-write session sandboxing cannot use the filesystem root as its project.",
    );
  }
  const stateKey =
    options.stateKey ??
    `project-${createHash("sha256").update(projectPath).digest("hex").slice(0, 32)}`;
  if (!SANDBOX_STATE_KEY_PATTERN.test(stateKey)) {
    throw new Error("Invalid session sandbox state key");
  }

  const root = await resolveSandboxStateRoot(options.stateRoot);
  const stateDir = resolve(root, stateKey);
  if (!isWithin(root, stateDir)) {
    throw new Error("Session sandbox state escaped its configured root");
  }
  const bwrapPath = await resolveTrustedBwrap(options.bwrapPath);
  await requireSupportedBwrapVersion(bwrapPath);
  const networkFirewall = options.networkFirewall !== false;
  const networkTools = networkFirewall
    ? await resolveSessionSandboxNetworkTools(options)
    : undefined;
  const blockedDestinations = networkFirewall
    ? blockedIpv4Destinations()
    : undefined;
  const portBroker = networkFirewall
    ? await resolveSessionSandboxPortBroker()
    : undefined;
  const {
    providerStateDir,
    cacheDir,
    tempDir,
    varTempDir,
    privateClaudeJson,
    networkResolvConf,
  } = sandboxStatePaths(stateDir, options.provider);
  const transcriptDir =
    options.provider === "codex"
      ? join(providerStateDir, "sessions")
      : join(providerStateDir, "projects", claudeProjectDirectory(projectPath));
  await makePrivateDirectories([
    root,
    stateDir,
    providerStateDir,
    cacheDir,
    tempDir,
    varTempDir,
  ]);
  await bootstrapProviderState({
    provider: options.provider,
    providerStateDir,
    privateClaudeJson,
  });
  if (networkFirewall) {
    await writeNetworkResolvConf(networkResolvConf);
  }
  const mountPrivateClaudeJson =
    options.provider !== "codex" && (await hasClaudeJsonMountPoint());
  const sharedCredentials =
    options.provider === "codex"
      ? undefined
      : await sharedClaudeCredentials(providerStateDir);
  const providerHostRuntimeDir = await resolveProviderHostRuntimeMask({
    projectPath,
    stateDir,
  });

  const initialProjectAnchor = openProjectDirectoryAnchor(projectPath);
  const projectIdentity = initialProjectAnchor.identity;
  const baseArgs = buildBwrapBaseArgs({
    projectPath,
    projectSourcePath: `/proc/self/fd/${PROJECT_DIRECTORY_CHILD_FD}`,
    providerStateDir,
    cacheDir,
    tempDir,
    varTempDir,
    privateClaudeJson: mountPrivateClaudeJson ? privateClaudeJson : undefined,
    sharedCredentials,
    providerHostRuntimeDir,
    networkResolvConf: networkFirewall
      ? { source: networkResolvConf, mountPoint: await resolvConfMountPoint() }
      : undefined,
  });
  try {
    if (networkTools && blockedDestinations) {
      await runNetworkSandboxProbe({
        tools: networkTools,
        bwrapPath,
        bwrapArgs: baseArgs,
        blockedDestinations,
        projectDirectoryFd: initialProjectAnchor.fd,
      });
    } else {
      await runBwrapProbe(bwrapPath, baseArgs, initialProjectAnchor.fd);
    }
  } finally {
    initialProjectAnchor.release();
  }

  const sandboxEnv: NodeJS.ProcessEnv = {
    TMPDIR: "/tmp",
    TMP: "/tmp",
    TEMP: "/tmp",
    XDG_CACHE_HOME: cacheDir,
    HF_HOME: join(cacheDir, "huggingface"),
    PIP_CACHE_DIR: join(cacheDir, "pip"),
    UV_CACHE_DIR: join(cacheDir, "uv"),
    NPM_CONFIG_CACHE: join(cacheDir, "npm"),
    YARN_CACHE_FOLDER: join(cacheDir, "yarn"),
  };
  if (options.provider === "codex") {
    sandboxEnv.CODEX_HOME = providerStateDir;
  } else {
    sandboxEnv.CLAUDE_CONFIG_DIR = providerStateDir;
    sandboxEnv.CLAUDE_SESSIONS_DIR = join(providerStateDir, "projects");
  }

  const runtimeWithArgs = (
    launchArgs: readonly string[],
    sessionEnvBridgeMounted: boolean,
  ): SessionSandboxRuntime => ({
    instructions: options.instructions,
    stateKey,
    projectPath,
    transcriptDir,
    openTranscriptDirectory: () =>
      openAnchoredDirectory(stateDir, relative(stateDir, transcriptDir)),
    enforcement: {
      requested: "project-write",
      effective: "project-write",
      state: "enforced",
      hostBackend: `bubblewrap:${basename(bwrapPath)}`,
      networkFirewall,
    },
    sessionEnvBridgeDirectory: SESSION_ENV_BRIDGE_MOUNT_POINT,
    withSessionEnvBridge(hostDirectory) {
      if (sessionEnvBridgeMounted) {
        throw new Error(
          "Session sandbox already mounts a session environment bridge.",
        );
      }
      if (!isAbsolute(hostDirectory)) {
        throw new Error(
          "Session sandbox bridge directory must be an absolute path.",
        );
      }
      if (!lstatSync(hostDirectory).isDirectory()) {
        throw new Error("Session sandbox bridge path must be a directory.");
      }
      return runtimeWithArgs(
        [
          ...launchArgs,
          "--ro-bind",
          hostDirectory,
          SESSION_ENV_BRIDGE_MOUNT_POINT,
        ],
        true,
      );
    },
    wrapSpawn(command, args, env) {
      const projectAnchor = openProjectDirectoryAnchor(
        projectPath,
        projectIdentity,
      );
      return {
        command: networkTools ? process.execPath : bwrapPath,
        args:
          networkTools && blockedDestinations
            ? buildNetworkLauncherArgs({
                tools: networkTools,
                bwrapPath,
                bwrapArgs: launchArgs,
                blockedDestinations,
                passProjectFd: true,
                ...(portBroker ? { portBroker } : {}),
                command,
                commandArgs: args,
              })
            : [...launchArgs, "--", command, ...args],
        // Bubblewrap changes to the project only after installing the
        // descriptor-backed bind. Its host-side cwd must not follow a
        // pathname replacement between wrapSpawn() and spawn().
        cwd: "/",
        env: {
          ...stripYaControlPlaneCredentials(env),
          ...sandboxEnv,
        },
        stdio: ["pipe", "pipe", "pipe", projectAnchor.fd],
        release: () => projectAnchor.release(),
      };
    },
  });
  return runtimeWithArgs(baseArgs, false);
}
