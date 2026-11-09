import { exec, execFile } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import * as os from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { getLogger } from "../logging/logger.js";
import {
  CODEX_INSTALLATION_FAMILY,
  type ProviderInstallationCoordinator,
  providerInstallationCoordinator,
} from "../services/ProviderInstallationCoordinator.js";
import {
  buildNpmCommandArgs,
  resolveNpmCommandTarget,
} from "../utils/npmCommand.js";
import { whichCommand } from "./which-command.js";

export type InstallationReadCoordinator = Pick<
  ProviderInstallationCoordinator,
  "withReadLease"
>;

const isWindows = os.platform() === "win32";
const CODEX_VERSION_PROBE_TIMEOUT_MS = 3000;
const CODEX_AUTH_PROBE_TIMEOUT_MS = 5000;
const CODEX_FAILED_DISCOVERY_RETRY_MS = 100;
const NPM_GLOBAL_PATH_CACHE_TTL_MS = 5 * 60_000;
const execAsync = promisify(exec);
const execFileAsync = promisify(execFile);
const log = getLogger().child({ component: "cli-detection" });
let npmGlobalCodexPathsCache:
  | { paths: string[]; expiresAt: number }
  | undefined;
let npmGlobalCodexPathsRequest: Promise<string[]> | undefined;

/**
 * Information about the Claude CLI installation.
 */
export interface ClaudeCliInfo {
  /** Whether the CLI was found */
  found: boolean;
  /** Path to the CLI executable */
  path?: string;
  /** CLI version string */
  version?: string;
  /** Error message if not found */
  error?: string;
}

/**
 * Detect the Claude CLI installation.
 *
 * Checks:
 * 1. PATH via `which claude`
 * 2. Common installation locations
 *
 * @returns Information about the CLI installation
 */
export function detectClaudeCli(): ClaudeCliInfo {
  // Short-circuit: let the SDK handle CLI spawning and errors
  return { found: true, path: "claude", version: "(SDK-managed)" };
}

/**
 * Information about the Codex CLI installation.
 */
export interface CodexCliInfo {
  /** Whether the CLI was found */
  found: boolean;
  /** Path to the CLI executable */
  path?: string;
  /** CLI version string */
  version?: string;
  /** Error message if not found */
  error?: string;
}

export interface CodexCliInstall {
  path: string;
  version: string;
  normalizedVersion: string | null;
}

export type CodexCliProbeFailure =
  | "not-found"
  | "timeout"
  | "empty-output"
  | "launch-failure";

export type CodexCliVersionProbeResult =
  | { ok: true; version: string }
  | {
      ok: false;
      reason: CodexCliProbeFailure;
      error?: string;
    };

interface VersionedCodexCandidate extends CodexCliInstall {
  order: number;
}

export interface CodexCommonPathOptions {
  platform?: NodeJS.Platform;
  homeDir?: string;
  env?: NodeJS.ProcessEnv;
}

/**
 * Detect the Codex CLI installation.
 *
 * Checks:
 * 1. PATH via `which codex`
 * 2. Common installation locations (cargo, local bin, etc.)
 *
 * @returns Information about the CLI installation
 */
export async function detectCodexCli(
  explicitPath?: string,
  installationCoordinator: InstallationReadCoordinator = providerInstallationCoordinator,
): Promise<CodexCliInfo> {
  const install = await findCodexCliInstall(
    explicitPath,
    installationCoordinator,
  );
  if (install) {
    return { found: true, path: install.path, version: install.version };
  }

  return {
    found: false,
    error: "Codex CLI not found. Install via: cargo install codex",
  };
}

/**
 * Common Codex CLI installation paths (checked after PATH lookup).
 * Includes Codex desktop app locations.
 */
export function getCodexCommonPaths(
  options: CodexCommonPathOptions = {},
): string[] {
  const platform = options.platform ?? os.platform();
  const home = options.homeDir ?? os.homedir();
  const env = options.env ?? process.env;
  const windows = platform === "win32";
  const ext = windows ? ".exe" : "";
  const sep = windows ? "\\" : "/";
  const localAppData = env.LOCALAPPDATA ?? `${home}${sep}AppData${sep}Local`;
  if (windows) {
    return [
      ...getOpenAICodexDesktopPaths(localAppData, platform),
      `${home}${sep}.codex${sep}.sandbox-bin${sep}codex${ext}`,
      `${home}${sep}.cargo${sep}bin${sep}codex${ext}`,
      `${home}${sep}.codex${sep}bin${sep}codex${ext}`,
      `${localAppData}${sep}bin${sep}codex${ext}`,
    ];
  }

  return platform === "darwin"
    ? [
        // ChatGPT 26.x bundles its CLI as a package beside the app resources.
        "/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex",
        `${home}/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex`,
        "/Applications/ChatGPT.app/Contents/Resources/codex",
        `${home}/Applications/ChatGPT.app/Contents/Resources/codex`,
        "/Applications/Codex.app/Contents/Resources/codex",
        `${home}/Applications/Codex.app/Contents/Resources/codex`,
        `${home}/.codex/.sandbox-bin/codex`,
        `${home}/.local/bin/codex`,
        "/opt/homebrew/bin/codex",
        "/usr/local/bin/codex",
        `${home}/.cargo/bin/codex`,
        `${home}/.codex/bin/codex`,
      ]
    : [
        `${home}/.codex/.sandbox-bin/codex`,
        `${home}/.local/bin/codex`,
        "/opt/homebrew/bin/codex",
        "/usr/local/bin/codex",
        `${home}/.cargo/bin/codex`,
        `${home}/.codex/bin/codex`,
      ];
}

function getOpenAICodexDesktopPaths(
  localAppData: string,
  platform: NodeJS.Platform = process.platform,
): string[] {
  if (platform !== "win32") return [];

  const binRoot = join(localAppData, "OpenAI", "Codex", "bin");
  try {
    return readdirSync(binRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => {
        const path = join(binRoot, entry.name, "codex.exe");
        const mtimeMs = safeMtimeMs(join(binRoot, entry.name));
        return { path, mtimeMs };
      })
      .sort((a, b) => b.mtimeMs - a.mtimeMs)
      .map((entry) => entry.path);
  } catch {
    return [];
  }
}

function safeMtimeMs(path: string): number {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return 0;
  }
}

/**
 * Parse `which` / Windows `where` output into ordered command candidates.
 *
 * Windows routinely reports one CRLF-delimited line per PATHEXT match. Keep
 * parsing separate from executable selection: a `.cmd` shim may exist but
 * still be unusable by a provider that launches through `execFile()`.
 */
export function parseCommandLookupOutput(stdout: string): string[] {
  return stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

export type CommandLookupLaunchMode = "direct" | "shell";

/**
 * Select an existing lookup hit compatible with a provider's launch mode.
 *
 * POSIX launchers keep the first existing hit. On Windows, shell-free Node
 * launches require a native executable, while an intentionally shell-owned
 * launch may also use command and batch shims. Extensionless npm shims are
 * POSIX shell scripts and are not safe candidates for either Windows mode.
 */
export function selectCommandLookupTarget(
  stdout: string,
  launchMode: CommandLookupLaunchMode,
  platform: NodeJS.Platform = process.platform,
  fileExists: (path: string) => boolean = existsSync,
): string | null {
  const candidates = parseCommandLookupOutput(stdout).filter((path) =>
    fileExists(path),
  );
  if (platform !== "win32") return candidates[0] ?? null;

  const compatibleExtension =
    launchMode === "direct" ? /\.(?:exe|com)$/i : /\.(?:exe|com|cmd|bat)$/i;
  return candidates.find((path) => compatibleExtension.test(path)) ?? null;
}

function dedupePathKey(path: string): string {
  return isWindows ? path.toLowerCase() : path;
}

function uniquePaths(paths: string[]): string[] {
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const path of paths) {
    const key = dedupePathKey(path);
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(path);
  }
  return unique;
}

export function normalizeCodexCliVersion(
  raw: string | null | undefined,
): string | null {
  if (!raw) return null;
  const match = raw.match(/(\d+)\.(\d+)\.(\d+)(?:-([\w.]+))?/);
  if (!match) return null;
  const [, major, minor, patch, pre] = match;
  return pre
    ? `${major}.${minor}.${patch}-${pre}`
    : `${major}.${minor}.${patch}`;
}

export function compareCodexCliVersions(a: string, b: string): number {
  const parsedA = splitCodexCliVersion(a);
  const parsedB = splitCodexCliVersion(b);
  for (let i = 0; i < 3; i++) {
    const partA = parsedA.parts[i] ?? 0;
    const partB = parsedB.parts[i] ?? 0;
    if (partA !== partB) return partA < partB ? -1 : 1;
  }
  if (parsedA.pre === null && parsedB.pre === null) return 0;
  if (parsedA.pre === null) return 1;
  if (parsedB.pre === null) return -1;
  return parsedA.pre < parsedB.pre ? -1 : parsedA.pre > parsedB.pre ? 1 : 0;
}

function splitCodexCliVersion(version: string): {
  parts: number[];
  pre: string | null;
} {
  const dashIndex = version.indexOf("-");
  const core = dashIndex === -1 ? version : version.slice(0, dashIndex);
  const pre = dashIndex === -1 ? null : version.slice(dashIndex + 1);
  return {
    parts: core.split(".").map((part) => {
      const parsed = Number.parseInt(part, 10);
      return Number.isFinite(parsed) ? parsed : 0;
    }),
    pre,
  };
}

/**
 * Whether a Codex executable path lies inside a desktop app bundle, which the
 * app replaces on its own release schedule: a macOS `.app` resource directory
 * or the Windows OpenAI desktop binary directory.
 */
export function isCodexDesktopAppPath(path: string): boolean {
  const normalized = path.replace(/\\/g, "/");
  return (
    /\.app\/Contents\/Resources\//.test(normalized) ||
    /\/OpenAI\/Codex\/bin\//i.test(normalized)
  );
}

function isDesktopAppPrerelease(candidate: VersionedCodexCandidate): boolean {
  return (
    candidate.normalizedVersion?.includes("-") === true &&
    isCodexDesktopAppPath(candidate.path)
  );
}

function compareCodexCandidates(
  a: VersionedCodexCandidate,
  b: VersionedCodexCandidate,
): number {
  if (a.normalizedVersion && b.normalizedVersion) {
    // A desktop app may bundle an alpha build. It must not silently replace
    // a versioned install the user chose, so it ranks below every other one.
    const aDemoted = isDesktopAppPrerelease(a);
    if (aDemoted !== isDesktopAppPrerelease(b)) return aDemoted ? -1 : 1;
    const versionOrder = compareCodexCliVersions(
      a.normalizedVersion,
      b.normalizedVersion,
    );
    if (versionOrder !== 0) return versionOrder;
  } else if (a.normalizedVersion) {
    return 1;
  } else if (b.normalizedVersion) {
    return -1;
  }

  // Lower order means earlier discovery priority; keep it as the tie-breaker.
  return b.order - a.order;
}

function selectBestCodexCandidate(
  candidates: VersionedCodexCandidate[],
): VersionedCodexCandidate | null {
  let best: VersionedCodexCandidate | null = null;
  for (const candidate of candidates) {
    if (!best || compareCodexCandidates(candidate, best) > 0) {
      best = candidate;
    }
  }
  return best;
}

async function probeCodexCandidate(
  path: string,
  order: number,
  installationCoordinator: InstallationReadCoordinator,
): Promise<VersionedCodexCandidate | null> {
  const result = await probeCodexCliVersion(path, installationCoordinator);
  if (!result.ok) {
    log.debug(
      { path, reason: result.reason, error: result.error },
      "Codex CLI candidate probe failed",
    );
    return null;
  }
  const version = result.version;
  return {
    path,
    version,
    normalizedVersion: normalizeCodexCliVersion(version),
    order,
  };
}

async function getPathCodexCandidates(): Promise<string[]> {
  try {
    // `where` returns every Windows match, while Unix `which` needs `-a` to
    // enumerate beyond the first PATH hit so version selection can compare all
    // installed candidates.
    const command = isWindows ? whichCommand("codex") : "which -a codex";
    const { stdout } = await execAsync(command, {
      encoding: "utf-8",
    });
    return parseCommandLookupOutput(stdout);
  } catch {
    return [];
  }
}

async function findAutoCodexCliInstall(
  installationCoordinator: InstallationReadCoordinator,
): Promise<CodexCliInstall | null> {
  const candidatePaths = uniquePaths([
    ...(await getPathCodexCandidates()),
    ...(await getNpmGlobalCodexPaths()),
    ...getCodexCommonPaths().filter((path) => existsSync(path)),
  ]);

  const candidates = (
    await Promise.all(
      candidatePaths.map((path, order) =>
        probeCodexCandidate(path, order, installationCoordinator),
      ),
    )
  ).filter((candidate): candidate is VersionedCodexCandidate =>
    Boolean(candidate),
  );

  const best = selectBestCodexCandidate(candidates);
  return best
    ? {
        path: best.path,
        version: best.version,
        normalizedVersion: best.normalizedVersion,
      }
    : null;
}

/**
 * Find the Codex CLI path by checking an explicit path first, then PATH, then
 * common locations. In auto mode, all usable candidates are probed and the
 * highest parsed CLI version wins; discovery order is only a tie-breaker.
 * If an explicit path is provided but missing, return null:
 * explicit provider configuration is authoritative and should not silently
 * drift to a different install.
 * Returns the path if found, null otherwise.
 */
export async function findCodexCliPath(
  explicitPath?: string,
  installationCoordinator: InstallationReadCoordinator = providerInstallationCoordinator,
): Promise<string | null> {
  const install = await findCodexCliInstall(
    explicitPath,
    installationCoordinator,
  );
  return install?.path ?? null;
}

export async function findCodexCliInstall(
  explicitPath?: string,
  installationCoordinator: InstallationReadCoordinator = providerInstallationCoordinator,
): Promise<CodexCliInstall | null> {
  return installationCoordinator.withReadLease(
    CODEX_INSTALLATION_FAMILY,
    async () => {
      for (let attempt = 0; attempt < 2; attempt++) {
        if (explicitPath) {
          if (existsSync(explicitPath)) {
            const version = await getCodexCliVersion(
              explicitPath,
              installationCoordinator,
            );
            if (version) {
              return {
                path: explicitPath,
                version,
                normalizedVersion: normalizeCodexCliVersion(version),
              };
            }
          }
        } else {
          const install = await findAutoCodexCliInstall(
            installationCoordinator,
          );
          if (install) return install;
        }

        if (attempt === 0) {
          await delay(CODEX_FAILED_DISCOVERY_RETRY_MS);
        }
      }
      return null;
    },
  );
}

function isWindowsCommandScript(path: string): boolean {
  return isWindows && /\.(?:cmd|bat)$/i.test(path);
}

function quoteWindowsCommandPath(path: string): string {
  return `"${path.replace(/"/g, '""')}"`;
}

/**
 * Get the version of the Codex CLI at the given path.
 */
export async function getCodexCliVersion(
  codexPath: string,
  installationCoordinator: InstallationReadCoordinator = providerInstallationCoordinator,
): Promise<string | undefined> {
  const result = await probeCodexCliVersion(codexPath, installationCoordinator);
  return result.ok ? result.version : undefined;
}

export async function probeCodexCliVersion(
  codexPath: string,
  installationCoordinator: InstallationReadCoordinator = providerInstallationCoordinator,
): Promise<CodexCliVersionProbeResult> {
  return installationCoordinator.withReadLease(CODEX_INSTALLATION_FAMILY, () =>
    probeCodexCliVersionUncoordinated(codexPath),
  );
}

async function probeCodexCliVersionUncoordinated(
  codexPath: string,
): Promise<CodexCliVersionProbeResult> {
  if (!existsSync(codexPath)) {
    return { ok: false, reason: "not-found" };
  }
  try {
    const options = {
      encoding: "utf-8",
      timeout: CODEX_VERSION_PROBE_TIMEOUT_MS,
      windowsHide: true,
    } as const;
    const { stdout } = isWindowsCommandScript(codexPath)
      ? await execAsync(`${quoteWindowsCommandPath(codexPath)} --version`, {
          ...options,
          windowsHide: true,
        })
      : await execFileAsync(codexPath, ["--version"], options);
    const output = stdout.trim();
    return output
      ? { ok: true, version: output }
      : { ok: false, reason: "empty-output" };
  } catch (error) {
    const failure = error as NodeJS.ErrnoException & { killed?: boolean };
    return {
      ok: false,
      reason:
        failure.killed || failure.code === "ETIMEDOUT"
          ? "timeout"
          : "launch-failure",
      error: failure.message,
    };
  }
}

/**
 * Ask the selected Codex CLI whether its ordinary auth store is usable.
 * Codex deliberately exits non-zero for a logged-out or unreadable store.
 */
export async function isCodexCliAuthenticated(
  codexPath: string,
  env: NodeJS.ProcessEnv = process.env,
  installationCoordinator: InstallationReadCoordinator = providerInstallationCoordinator,
): Promise<boolean> {
  return installationCoordinator.withReadLease(
    CODEX_INSTALLATION_FAMILY,
    async () => {
      if (!existsSync(codexPath)) return false;
      const options = {
        encoding: "utf-8",
        timeout: CODEX_AUTH_PROBE_TIMEOUT_MS,
        windowsHide: true,
        env,
      } as const;
      try {
        if (isWindowsCommandScript(codexPath)) {
          await execAsync(
            `${quoteWindowsCommandPath(codexPath)} login status`,
            options,
          );
        } else {
          await execFileAsync(codexPath, ["login", "status"], options);
        }
        return true;
      } catch {
        return false;
      }
    },
  );
}

async function getNpmGlobalCodexPaths(): Promise<string[]> {
  if (
    npmGlobalCodexPathsCache &&
    npmGlobalCodexPathsCache.expiresAt > Date.now()
  ) {
    return npmGlobalCodexPathsCache.paths;
  }
  if (npmGlobalCodexPathsRequest) return npmGlobalCodexPathsRequest;

  npmGlobalCodexPathsRequest = resolveNpmGlobalCodexPaths().finally(() => {
    npmGlobalCodexPathsRequest = undefined;
  });
  const paths = await npmGlobalCodexPathsRequest;
  npmGlobalCodexPathsCache = {
    paths,
    expiresAt: Date.now() + NPM_GLOBAL_PATH_CACHE_TTL_MS,
  };
  return paths;
}

async function resolveNpmGlobalCodexPaths(): Promise<string[]> {
  try {
    const target = resolveNpmCommandTarget();
    const { stdout } = await execFileAsync(
      target.command,
      buildNpmCommandArgs(target, ["prefix", "-g"]),
      {
        encoding: "utf8",
        timeout: CODEX_VERSION_PROBE_TIMEOUT_MS,
        windowsHide: true,
      },
    );
    const prefix = stdout.trim();
    if (!prefix) return [];
    return isWindows
      ? [join(prefix, "codex.exe"), join(prefix, "codex.cmd")]
      : [join(prefix, "bin", "codex")];
  } catch (error) {
    log.debug({ error }, "Unable to resolve npm-global Codex candidate");
    return [];
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
