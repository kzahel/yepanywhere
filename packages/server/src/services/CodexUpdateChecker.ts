import { execFile } from "node:child_process";
import { readFile, realpath, stat } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import { getLogger } from "../logging/logger.js";
import { detectCodexCli, isCodexDesktopAppPath } from "../sdk/cli-detection.js";
import {
  buildNpmCommandArgs,
  resolveNpmCommandTarget,
} from "../utils/npmCommand.js";
import {
  CODEX_INSTALLATION_FAMILY,
  ProviderInstallationBusyError,
  type ProviderInstallationCoordinator,
  providerInstallationCoordinator,
} from "./ProviderInstallationCoordinator.js";

const execFileAsync = promisify(execFile);

const GITHUB_LATEST_URL =
  "https://api.github.com/repos/openai/codex/releases/latest";
const DEFAULT_REFRESH_TTL_MS = 24 * 60 * 60 * 1000;
const ALLOWED_NPM_PACKAGES = new Set(["@openai/codex"]);

const log = getLogger().child({ component: "codex-update-checker" });

/**
 * Oldest Codex CLI release YA's Codex integration works with, or null when no
 * such floor is known. YA gates version-sensitive behavior per feature, so a
 * merely older CLI is not incompatible. Raise this only when a known
 * incompatibility exists: it is the sole trigger for the update dialog.
 */
export const CODEX_CLI_MINIMUM_SUPPORTED_VERSION: string | null = null;

/**
 * How YA can update Codex on this host. "npm" runs `npm install -g`;
 * "standalone" runs the installation's own `codex update`; "manual" means
 * the user updates it with whatever installed it.
 */
export type CodexUpdateMethod = "npm" | "standalone" | "manual";

/** What owns the detected Codex executable. */
export type CodexInstallSource =
  | "npm"
  | "standalone"
  | "homebrew"
  | "cargo"
  | "desktop-app"
  | "unknown";

interface CodexInstallMetadata {
  installedPackage: string | null;
  installSource: CodexInstallSource;
  updateMethod: CodexUpdateMethod;
  /** Best-effort copy-pasteable upgrade command for this install path. */
  manualInstallCommand: string | null;
}

export interface CodexUpdateStatus {
  installed: string | null;
  installedPath: string | null;
  /** npm package name (e.g. "@openai/codex") if install path is npm-global. */
  installedPackage: string | null;
  /** What owns the detected executable; drives the update guidance. */
  installSource: CodexInstallSource;
  /** How the install can be updated; anything but "manual" YA can run. */
  updateMethod: CodexUpdateMethod;
  /**
   * A shell command the user can run to upgrade Codex themselves. Populated
   * for npm / standalone / homebrew / cargo installs; null when we can't
   * confidently infer the right command.
   */
  manualInstallCommand: string | null;
  latest: string | null;
  releaseUrl: string | null;
  updateAvailable: boolean;
  /** Declared oldest supported release; null when none is known. */
  minimumSupported: string | null;
  /** The installed CLI is older than `minimumSupported`. */
  belowMinimum: boolean;
  lastCheckedAt: number | null;
  error: string | null;
}

export interface CodexUpdateInstallResult {
  success: boolean;
  output: string;
  status: CodexUpdateStatus;
  error?: string;
  /** The installation is healthy but an active operation deferred mutation. */
  retryable?: boolean;
}

export interface CodexUpdateCheckerOptions {
  /** Explicit Codex CLI path supplied by an embedding runtime such as desktop. */
  codexCliPath?: string;
  /** Override the remote fetch (for tests). */
  fetchLatest?: () => Promise<{
    tagName: string | null;
    htmlUrl: string | null;
  }>;
  /** Override the local CLI detection (for tests). */
  detectInstalled?: () => Promise<{
    version: string | null;
    path: string | null;
  }>;
  /** Override install metadata detection (for tests). */
  detectInstallMetadata?: (
    installedPath: string | null,
  ) => Promise<CodexInstallMetadata>;
  /** Override the package install command (for tests). Returns combined stdout/stderr. */
  runInstall?: (pkg: string) => Promise<string>;
  /** Override `codex update` for a standalone install (for tests). */
  runStandaloneUpdate?: (codexPath: string) => Promise<string>;
  /** Override the declared minimum supported version (for tests). */
  minimumSupportedVersion?: string | null;
  /** Shared installation lifecycle owner (injectable for tests). */
  installationCoordinator?: Pick<
    ProviderInstallationCoordinator,
    "runExclusiveUpdate" | "withReadLease"
  >;
  /** Refresh TTL in ms (default: 24h). */
  refreshTtlMs?: number;
}

const INITIAL_STATUS: CodexUpdateStatus = {
  installed: null,
  installedPath: null,
  installedPackage: null,
  installSource: "unknown",
  updateMethod: "manual",
  manualInstallCommand: null,
  latest: null,
  releaseUrl: null,
  updateAvailable: false,
  minimumSupported: null,
  belowMinimum: false,
  lastCheckedAt: null,
  error: null,
};

const DEFAULT_INSTALL_METADATA: CodexInstallMetadata = {
  installedPackage: null,
  installSource: "unknown",
  updateMethod: "manual",
  manualInstallCommand: null,
};

export class CodexUpdateChecker {
  private status: CodexUpdateStatus = INITIAL_STATUS;
  private inflight: Promise<CodexUpdateStatus> | null = null;
  private readonly fetchLatest: NonNullable<
    CodexUpdateCheckerOptions["fetchLatest"]
  >;
  private readonly detectInstalled: NonNullable<
    CodexUpdateCheckerOptions["detectInstalled"]
  >;
  private readonly detectInstallMetadata: NonNullable<
    CodexUpdateCheckerOptions["detectInstallMetadata"]
  >;
  private readonly runInstall: NonNullable<
    CodexUpdateCheckerOptions["runInstall"]
  >;
  private readonly runStandaloneUpdate: NonNullable<
    CodexUpdateCheckerOptions["runStandaloneUpdate"]
  >;
  private readonly minimumSupported: string | null;
  private readonly refreshTtlMs: number;
  private readonly installationCoordinator: Pick<
    ProviderInstallationCoordinator,
    "runExclusiveUpdate" | "withReadLease"
  >;

  constructor(options: CodexUpdateCheckerOptions = {}) {
    this.installationCoordinator =
      options.installationCoordinator ?? providerInstallationCoordinator;
    this.fetchLatest = options.fetchLatest ?? fetchLatestFromGitHub;
    this.detectInstalled =
      options.detectInstalled ??
      (() =>
        detectInstalledFromCli(
          options.codexCliPath,
          this.installationCoordinator,
        ));
    this.detectInstallMetadata =
      options.detectInstallMetadata ?? detectInstallMetadataFromPath;
    this.runInstall = options.runInstall ?? runNpmGlobalInstall;
    this.runStandaloneUpdate =
      options.runStandaloneUpdate ?? runStandaloneCodexUpdate;
    this.minimumSupported = normalizeVersion(
      options.minimumSupportedVersion === undefined
        ? CODEX_CLI_MINIMUM_SUPPORTED_VERSION
        : options.minimumSupportedVersion,
    );
    this.refreshTtlMs = options.refreshTtlMs ?? DEFAULT_REFRESH_TTL_MS;
  }

  async getStatus(options?: { force?: boolean }): Promise<CodexUpdateStatus> {
    const stale =
      options?.force === true ||
      this.status.lastCheckedAt === null ||
      Date.now() - this.status.lastCheckedAt > this.refreshTtlMs;
    if (stale) {
      await this.refresh();
    }
    return { ...this.status };
  }

  async refresh(): Promise<CodexUpdateStatus> {
    if (this.inflight) return this.inflight;
    this.inflight = this.doRefresh().finally(() => {
      this.inflight = null;
    });
    return this.inflight;
  }

  private async doRefresh(): Promise<CodexUpdateStatus> {
    let installed: string | null = null;
    let installedPath: string | null = null;
    let installMetadata = DEFAULT_INSTALL_METADATA;
    try {
      const info = await this.detectInstalled();
      installed = normalizeVersion(info.version);
      installedPath = info.path;
      installMetadata = await this.detectInstallMetadata(installedPath);
    } catch (error) {
      log.debug({ error }, "detectInstalled failed");
    }

    let latest: string | null = null;
    let releaseUrl: string | null = null;
    let error: string | null = null;
    try {
      const result = await this.fetchLatest();
      latest = normalizeVersion(result.tagName);
      releaseUrl = result.htmlUrl;
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
      log.debug({ error: e }, "fetchLatest failed");
    }

    const updateAvailable =
      installed !== null &&
      latest !== null &&
      compareVersions(installed, latest) < 0;
    const belowMinimum =
      installed !== null &&
      this.minimumSupported !== null &&
      compareVersions(installed, this.minimumSupported) < 0;

    this.status = {
      installed,
      installedPath,
      installedPackage: installMetadata.installedPackage,
      installSource: installMetadata.installSource,
      updateMethod: installMetadata.updateMethod,
      manualInstallCommand: installMetadata.manualInstallCommand,
      latest,
      releaseUrl,
      updateAvailable,
      minimumSupported: this.minimumSupported,
      belowMinimum,
      lastCheckedAt: Date.now(),
      error,
    };
    return { ...this.status };
  }

  /**
   * Update the detected installation with the tool that owns it:
   * `npm install -g <pkg>@latest` for an npm-global install, or the
   * installation's own `codex update` for a standalone install.
   * Refreshes status on success. Returns combined stdout/stderr.
   */
  async install(): Promise<CodexUpdateInstallResult> {
    const current = await this.getStatus();
    const plan = planCodexUpdate(current);
    if ("error" in plan) {
      return { success: false, output: "", status: current, error: plan.error };
    }

    let terminalStatus = current;
    const planDetails = { family: CODEX_INSTALLATION_FAMILY, ...plan };
    log.info(planDetails, "Admitting Codex CLI update");
    try {
      return await this.installationCoordinator.runExclusiveUpdate(
        CODEX_INSTALLATION_FAMILY,
        async () => {
          const admitted = await this.getStatus({ force: true });
          terminalStatus = admitted;
          if (!sameCodexUpdatePlan(planCodexUpdate(admitted), plan)) {
            throw new Error(
              "Codex installation changed before the update could start",
            );
          }

          log.info(planDetails, "Running Codex CLI update");
          let output: string;
          try {
            output =
              plan.method === "npm"
                ? await this.runInstall(plan.pkg)
                : await this.runStandaloneUpdate(plan.codexPath);
          } catch (error) {
            terminalStatus = await this.getStatus({ force: true });
            throw error;
          }
          const refreshed = await this.getStatus({ force: true });
          terminalStatus = refreshed;
          if (!refreshed.installed || !refreshed.installedPath) {
            throw new Error(
              "Codex update completed but the production CLI probe could not launch the installation",
            );
          }
          // A launchable CLI is not success by itself: an updater can exit
          // zero while the old version stays installed. The admitted target
          // version must actually be reached before success publishes.
          const target = admitted.latest;
          if (
            target !== null &&
            compareVersions(refreshed.installed, target) < 0
          ) {
            throw new Error(
              `Codex update completed but the installed CLI still reports ${refreshed.installed}; expected at least ${target}`,
            );
          }
          return { success: true, output, status: refreshed };
        },
      );
    } catch (e) {
      const err = e as NodeJS.ErrnoException & {
        stdout?: string;
        stderr?: string;
      };
      const output = [err.stdout ?? "", err.stderr ?? ""]
        .filter(Boolean)
        .join("\n")
        .trim();
      const details = {
        error: err.message,
        family: CODEX_INSTALLATION_FAMILY,
      };
      if (e instanceof ProviderInstallationBusyError) {
        log.info(details, "Codex CLI update deferred while provider is active");
      } else {
        log.warn(details, "Codex CLI update failed");
      }
      return {
        success: false,
        output,
        status: terminalStatus,
        error: err.message,
        ...(e instanceof ProviderInstallationBusyError
          ? { retryable: true }
          : {}),
      };
    }
  }
}

async function detectInstalledFromCli(
  codexCliPath: string | undefined,
  installationCoordinator: Pick<
    ProviderInstallationCoordinator,
    "withReadLease"
  >,
): Promise<{
  version: string | null;
  path: string | null;
}> {
  const info = await detectCodexCli(codexCliPath, installationCoordinator);
  return {
    version: info.version ?? null,
    path: info.path ?? null,
  };
}

async function detectInstallMetadataFromPath(
  installedPath: string | null,
): Promise<CodexInstallMetadata> {
  if (!installedPath) {
    return { ...DEFAULT_INSTALL_METADATA };
  }

  let resolvedInstalledPath = path.resolve(installedPath);
  try {
    resolvedInstalledPath = await realpath(installedPath);
  } catch {
    // Keep the original resolved path if realpath fails (e.g. broken symlink).
  }

  const npmGlobalRoot = await getNpmGlobalRoot();
  let installedPackage = npmGlobalRoot
    ? extractNpmGlobalPackageName(resolvedInstalledPath, npmGlobalRoot)
    : null;
  if (!installedPackage && npmGlobalRoot) {
    installedPackage = await resolveNpmPrefixShimPackage(
      resolvedInstalledPath,
      npmGlobalRoot,
    );
  }

  if (installedPackage) {
    return {
      installedPackage,
      installSource: "npm",
      updateMethod: "npm",
      manualInstallCommand: `npm install -g ${installedPackage}@latest`,
    };
  }

  if (await isStandaloneRelease(resolvedInstalledPath, defaultCodexHome())) {
    return {
      installedPackage: null,
      installSource: "standalone",
      updateMethod: "standalone",
      manualInstallCommand: "codex update",
    };
  }

  return classifyManualInstall(installedPath, resolvedInstalledPath);
}

function defaultCodexHome(): string {
  return process.env.CODEX_HOME?.trim() || path.join(os.homedir(), ".codex");
}

/**
 * Codex's standalone installer keeps each release under
 * `<CODEX_HOME>/packages/standalone/releases/` and updates it with
 * `codex update`; this mirrors the CLI's own install-method detection.
 */
async function isStandaloneRelease(
  resolvedInstalledPath: string,
  codexHome: string,
): Promise<boolean> {
  let resolvedHome: string;
  try {
    resolvedHome = await realpath(codexHome);
  } catch {
    return false;
  }
  const releasesRoot = path.join(
    resolvedHome,
    "packages",
    "standalone",
    "releases",
  );
  const relative = path.relative(releasesRoot, resolvedInstalledPath);
  return (
    relative.length > 0 &&
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

/**
 * Best-effort classification of an install YA cannot update itself.
 * Recognized: a desktop app bundle, Homebrew (formula or cask), and cargo
 * installs under ~/.cargo/bin. The command is null when we can't be sure.
 */
function classifyManualInstall(
  installedPath: string,
  resolvedInstalledPath: string,
): CodexInstallMetadata {
  const manual = (
    installSource: CodexInstallSource,
    manualInstallCommand: string | null,
  ): CodexInstallMetadata => ({
    installedPackage: null,
    installSource,
    updateMethod: "manual",
    manualInstallCommand,
  });
  if (
    isCodexDesktopAppPath(installedPath) ||
    isCodexDesktopAppPath(resolvedInstalledPath)
  ) {
    return manual("desktop-app", null);
  }
  const normalizedPath = resolvedInstalledPath.replace(/\\/g, "/");
  if (normalizedPath.includes("/Caskroom/")) {
    return manual("homebrew", "brew upgrade --cask codex");
  }
  if (normalizedPath.includes("/Cellar/")) {
    return manual("homebrew", "brew upgrade codex");
  }
  if (normalizedPath.includes("/.cargo/bin/")) {
    return manual("cargo", "cargo install --locked codex");
  }
  return manual("unknown", null);
}

type CodexUpdatePlan =
  | { method: "npm"; pkg: string }
  | { method: "standalone"; codexPath: string };

function planCodexUpdate(
  status: CodexUpdateStatus,
): CodexUpdatePlan | { error: string } {
  if (status.updateMethod === "npm" && status.installedPackage) {
    const pkg = status.installedPackage;
    return ALLOWED_NPM_PACKAGES.has(pkg)
      ? { method: "npm", pkg }
      : { error: `Refusing to update unrecognized Codex npm package: ${pkg}` };
  }
  if (status.updateMethod === "standalone" && status.installedPath) {
    return { method: "standalone", codexPath: status.installedPath };
  }
  return {
    error:
      "This Codex installation must be updated manually, with the tool that installed it",
  };
}

function sameCodexUpdatePlan(
  candidate: CodexUpdatePlan | { error: string },
  plan: CodexUpdatePlan,
): boolean {
  if ("error" in candidate) return false;
  if (candidate.method === "npm") {
    return plan.method === "npm" && candidate.pkg === plan.pkg;
  }
  return plan.method === "standalone" && candidate.codexPath === plan.codexPath;
}

async function getNpmGlobalRoot(): Promise<string | null> {
  try {
    const target = resolveNpmCommandTarget();
    const { stdout } = await execFileAsync(
      target.command,
      buildNpmCommandArgs(target, ["root", "-g"]),
      {
        encoding: "utf-8",
        windowsHide: true,
      },
    );
    const npmGlobalRoot = stdout.trim();
    if (!npmGlobalRoot) return null;
    try {
      return await realpath(npmGlobalRoot);
    } catch {
      return path.resolve(npmGlobalRoot);
    }
  } catch {
    return null;
  }
}

const MAX_SHIM_FILE_BYTES = 64 * 1024;

/**
 * Resolve the npm package behind a launcher shim that sits in the npm
 * prefix directory beside `node_modules`. A normal Windows global install
 * exposes `%APPDATA%\npm\codex.cmd` — a generated cmd/PowerShell/sh shim,
 * not a symlink — so realpath never lands below `npm root -g` and prefix
 * membership has to be recognized from the shim itself.
 */
async function resolveNpmPrefixShimPackage(
  resolvedInstalledPath: string,
  npmGlobalRoot: string,
): Promise<string | null> {
  if (path.basename(npmGlobalRoot) !== "node_modules") return null;
  const prefixDir = path.dirname(npmGlobalRoot);
  if (path.dirname(resolvedInstalledPath) !== prefixDir) return null;

  let shim: string;
  try {
    const stats = await stat(resolvedInstalledPath);
    if (!stats.isFile() || stats.size > MAX_SHIM_FILE_BYTES) return null;
    shim = await readFile(resolvedInstalledPath, { encoding: "utf-8" });
  } catch {
    return null;
  }

  // Generated shims reference the target as
  // node_modules\@scope\name\bin\entry.js (cmd) or with forward slashes
  // (sh/PowerShell); either separator identifies the owning package.
  const match = shim.match(
    /node_modules[\\/](@[^\\/\s"']+[\\/][^\\/\s"']+|[^\\/\s"']+)/,
  );
  const candidate = match?.[1];
  if (!candidate) return null;
  const segments = candidate.split(/[\\/]/);
  if (segments.some((segment) => segment === "." || segment === "..")) {
    return null;
  }

  try {
    const packageDir = path.join(npmGlobalRoot, ...segments);
    const packageStats = await stat(packageDir);
    if (!packageStats.isDirectory()) return null;
  } catch {
    return null;
  }
  return segments.join("/");
}

function extractNpmGlobalPackageName(
  installedPath: string,
  npmGlobalRoot: string,
): string | null {
  const relativePath = path.relative(npmGlobalRoot, installedPath);
  if (
    !relativePath ||
    relativePath === ".." ||
    relativePath.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relativePath)
  ) {
    return null;
  }

  const segments = relativePath.split(path.sep).filter(Boolean);
  const firstSegment = segments[0];
  if (!firstSegment) return null;

  if (firstSegment.startsWith("@")) {
    const secondSegment = segments[1];
    return secondSegment ? `${firstSegment}/${secondSegment}` : null;
  }

  return firstSegment;
}

async function runNpmGlobalInstall(pkg: string): Promise<string> {
  if (!ALLOWED_NPM_PACKAGES.has(pkg)) {
    throw new Error(`Unsupported Codex npm package: ${pkg}`);
  }
  const target = resolveNpmCommandTarget();
  const { stdout, stderr } = await execFileAsync(
    target.command,
    buildNpmCommandArgs(target, ["install", "-g", `${pkg}@latest`]),
    {
      timeout: 5 * 60 * 1000,
      maxBuffer: 10 * 1024 * 1024,
      encoding: "utf8",
      windowsHide: true,
    },
  );
  return [stdout, stderr].filter(Boolean).join("\n").trim();
}

/**
 * Run the standalone installation's own updater. `codex update` reinstalls
 * through Codex's install script non-interactively and moves the `current`
 * release link, so the public command path keeps working.
 */
async function runStandaloneCodexUpdate(codexPath: string): Promise<string> {
  const { stdout, stderr } = await execFileAsync(codexPath, ["update"], {
    // Keep a project directory's tool configuration out of the updater.
    cwd: os.tmpdir(),
    timeout: 5 * 60 * 1000,
    maxBuffer: 10 * 1024 * 1024,
    encoding: "utf8",
    windowsHide: true,
  });
  return [stdout, stderr].filter(Boolean).join("\n").trim();
}

async function fetchLatestFromGitHub(): Promise<{
  tagName: string | null;
  htmlUrl: string | null;
}> {
  const res = await fetch(GITHUB_LATEST_URL, {
    headers: {
      accept: "application/vnd.github+json",
      "user-agent": "yep-anywhere-update-checker",
    },
  });
  if (!res.ok) {
    throw new Error(`GitHub returned ${res.status}`);
  }
  const body = (await res.json()) as {
    tag_name?: unknown;
    html_url?: unknown;
  };
  return {
    tagName: typeof body.tag_name === "string" ? body.tag_name : null,
    htmlUrl: typeof body.html_url === "string" ? body.html_url : null,
  };
}

function normalizeVersion(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const match = raw.match(/(\d+)\.(\d+)\.(\d+)(?:-([\w.]+))?/);
  if (!match) return null;
  const [, major, minor, patch, pre] = match;
  return pre
    ? `${major}.${minor}.${patch}-${pre}`
    : `${major}.${minor}.${patch}`;
}

function compareVersions(a: string, b: string): number {
  const pa = splitVersion(a);
  const pb = splitVersion(b);
  for (let i = 0; i < 3; i++) {
    const av = pa.parts[i] ?? 0;
    const bv = pb.parts[i] ?? 0;
    if (av !== bv) return av < bv ? -1 : 1;
  }
  if (pa.pre === null && pb.pre === null) return 0;
  if (pa.pre === null) return 1;
  if (pb.pre === null) return -1;
  return pa.pre < pb.pre ? -1 : pa.pre > pb.pre ? 1 : 0;
}

function splitVersion(v: string): { parts: number[]; pre: string | null } {
  const dash = v.indexOf("-");
  const core = dash === -1 ? v : v.slice(0, dash);
  const pre = dash === -1 ? null : v.slice(dash + 1);
  const parts = core.split(".").map((n) => {
    const parsed = Number.parseInt(n, 10);
    return Number.isFinite(parsed) ? parsed : 0;
  });
  return { parts, pre };
}

export const __testing__ = {
  normalizeVersion,
  compareVersions,
  extractNpmGlobalPackageName,
  classifyManualInstall,
  isStandaloneRelease,
  resolveNpmPrefixShimPackage,
};
