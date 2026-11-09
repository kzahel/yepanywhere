/**
 * Finding the Claude Code executable: the SDK's bundled native binary, a
 * configured or PATH command, and on Windows the copy Claude Desktop
 * installs. Also the claude.ai login command and status read with it.
 */

import { execFile } from "node:child_process";
import {
  accessSync,
  constants,
  existsSync,
  readdirSync,
  statSync,
} from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { delimiter, extname, join, win32 } from "node:path";
import { promisify } from "node:util";
import { formatExecutableInvocation } from "../../utils/executableInvocation.js";

const execFileAsync = promisify(execFile);

export const CLAUDE_LOGIN_ARGS = ["auth", "login", "--claudeai"] as const;
const DEFAULT_CLAUDE_LOGIN_COMMAND = `claude ${CLAUDE_LOGIN_ARGS.join(" ")}`;

const requireFromHere = createRequire(import.meta.url);
const requireFromClaudeSdk = createRequire(
  requireFromHere.resolve("@anthropic-ai/claude-agent-sdk"),
);
let cachedLocalClaudeCodeExecutable: string | null | undefined;

function isExecutableFile(filePath: string | undefined): filePath is string {
  if (!filePath) return false;
  try {
    accessSync(filePath, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

interface ResolvePathExecutableOptions {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  isExecutable?: (filePath: string) => boolean;
}

export function resolvePathExecutable(
  command: string,
  options: ResolvePathExecutableOptions = {},
): string | undefined {
  if (!command.trim()) return undefined;

  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const executable = options.isExecutable ?? isExecutableFile;
  const windows = platform === "win32";
  const pathApi = windows ? win32 : { extname, join };
  const hasPath = command.includes("/") || command.includes("\\");
  const commandExtension = pathApi.extname(command);
  if (
    windows &&
    commandExtension &&
    !/^\.(?:com|exe)$/i.test(commandExtension)
  ) {
    return undefined;
  }
  const commandNames =
    windows && !commandExtension
      ? (env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD")
          .split(";")
          .map((extension) => extension.trim())
          .filter((extension) => /^\.(?:com|exe)$/i.test(extension))
          .map((extension) => `${command}${extension}`)
      : [command];
  const directories = hasPath
    ? [""]
    : (env.PATH ?? "").split(windows ? ";" : delimiter);

  for (const dir of directories) {
    for (const commandName of commandNames) {
      const candidate = dir ? pathApi.join(dir, commandName) : commandName;
      if (executable(candidate)) {
        return candidate;
      }
    }
  }
  return undefined;
}

function hasGlibcRuntime(): boolean {
  if (typeof process.report?.getReport !== "function") {
    return false;
  }
  // Node supports this since 22.0; the workspace's report type omits it.
  const processReport = process.report as typeof process.report & {
    excludeNetwork: boolean;
  };
  const excludeNetwork = processReport.excludeNetwork;
  try {
    // Libc selection must not wait for interface inspection or reverse DNS.
    processReport.excludeNetwork = true;
    const report = processReport.getReport() as {
      header?: { glibcVersionRuntime?: string };
    };
    return Boolean(report.header?.glibcVersionRuntime);
  } finally {
    processReport.excludeNetwork = excludeNetwork;
  }
}

function getClaudeSdkNativePackageNames(): string[] {
  const binaryArch = process.arch;
  if (process.platform === "linux") {
    const glibcPackage = `@anthropic-ai/claude-agent-sdk-linux-${binaryArch}`;
    const muslPackage = `${glibcPackage}-musl`;
    return hasGlibcRuntime()
      ? [glibcPackage, muslPackage]
      : [muslPackage, glibcPackage];
  }

  return [`@anthropic-ai/claude-agent-sdk-${process.platform}-${binaryArch}`];
}

export function resolveClaudeSdkNativeExecutable(): string | undefined {
  const binaryName = process.platform === "win32" ? "claude.exe" : "claude";
  for (const packageName of getClaudeSdkNativePackageNames()) {
    try {
      const executable = requireFromClaudeSdk.resolve(
        `${packageName}/${binaryName}`,
      );
      if (isExecutableFile(executable)) {
        return executable;
      }
    } catch {
      // Optional package not installed for this platform.
    }
  }
  return undefined;
}

export function resolveLocalClaudeCodeExecutable(): string | undefined {
  if (cachedLocalClaudeCodeExecutable !== undefined) {
    return cachedLocalClaudeCodeExecutable ?? undefined;
  }

  const envExecutable =
    process.env.CLAUDE_CODE_EXECUTABLE ?? process.env.CLAUDE_CODE_PATH;
  const executable = envExecutable
    ? resolvePathExecutable(envExecutable)
    : (resolveClaudeSdkNativeExecutable() ?? resolvePathExecutable("claude"));

  cachedLocalClaudeCodeExecutable = executable ?? null;
  return executable;
}

/**
 * This computer's claude.ai login as a routed Claude launch would see it, with
 * the credential variables that launch clears removed; null when Claude Code
 * would use no claude.ai login. Reads `claude auth status`, never a token.
 */
export async function readClaudeAiLogin(): Promise<{ email?: string } | null> {
  const executable = resolveLocalClaudeCodeExecutable();
  if (!executable) return null;
  const env = { ...process.env };
  for (const name of [
    "ANTHROPIC_AUTH_TOKEN",
    "ANTHROPIC_API_KEY",
    "CLAUDE_CODE_OAUTH_TOKEN",
  ])
    delete env[name];
  try {
    const { stdout } = await execFileAsync(executable, ["auth", "status"], {
      encoding: "utf-8",
      timeout: 5000,
      env,
    });
    const status = JSON.parse(stdout) as {
      loggedIn?: unknown;
      authMethod?: unknown;
      email?: unknown;
    };
    if (status.loggedIn !== true || status.authMethod !== "claude.ai")
      return null;
    return typeof status.email === "string" ? { email: status.email } : {};
  } catch {
    return null;
  }
}
function safeMtimeMs(path: string): number {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return 0;
  }
}

export function formatClaudeLoginCommand(
  executablePath?: string,
  platform: NodeJS.Platform = process.platform,
): string {
  const trimmedPath = executablePath?.trim();
  if (!trimmedPath || trimmedPath === "claude") {
    return DEFAULT_CLAUDE_LOGIN_COMMAND;
  }
  return formatExecutableInvocation(
    trimmedPath,
    CLAUDE_LOGIN_ARGS.join(" "),
    platform,
  );
}

function getClaudeDesktopCodeRoots(): string[] {
  if (process.platform !== "win32") return [];

  const localAppData =
    process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local");
  const appData = process.env.APPDATA ?? join(homedir(), "AppData", "Roaming");
  const roots: string[] = [];

  try {
    for (const entry of readdirSync(join(localAppData, "Packages"), {
      withFileTypes: true,
    })) {
      if (entry.isDirectory() && entry.name.startsWith("Claude_")) {
        roots.push(
          join(
            localAppData,
            "Packages",
            entry.name,
            "LocalCache",
            "Roaming",
            "Claude",
            "claude-code",
          ),
        );
      }
    }
  } catch {
    // Claude Desktop may not be installed through the Store package.
  }

  roots.push(join(appData, "Claude", "claude-code"));
  return roots;
}

function findClaudeDesktopExecutables(): string[] {
  const candidates: Array<{ path: string; mtimeMs: number }> = [];

  for (const root of getClaudeDesktopCodeRoots()) {
    try {
      for (const entry of readdirSync(root, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;

        const candidateDir = join(root, entry.name);
        const candidate = join(candidateDir, "claude.exe");
        if (existsSync(candidate)) {
          candidates.push({
            path: candidate,
            mtimeMs: safeMtimeMs(candidateDir),
          });
        }
      }
    } catch {
      // This Claude Desktop layout is optional and version-dependent.
    }
  }

  return candidates
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
    .map((candidate) => candidate.path);
}

function hasShellClaudeCommand(): boolean {
  return resolvePathExecutable("claude") !== undefined;
}

async function isUsableClaudeExecutable(path: string): Promise<boolean> {
  try {
    await execFileAsync(path, ["--version"], {
      encoding: "utf-8",
      timeout: 5000,
    });
    return true;
  } catch {
    return false;
  }
}

async function findPreferredClaudeLoginExecutable(): Promise<
  string | undefined
> {
  if (hasShellClaudeCommand()) {
    return undefined;
  }

  const sdkExecutable = resolveLocalClaudeCodeExecutable();
  if (sdkExecutable && (await isUsableClaudeExecutable(sdkExecutable))) {
    return sdkExecutable;
  }

  for (const executable of findClaudeDesktopExecutables()) {
    if (await isUsableClaudeExecutable(executable)) {
      return executable;
    }
  }

  return undefined;
}

/** The executable the displayed login command names, as a runnable path. */
export async function resolveClaudeLoginExecutable(): Promise<
  string | undefined
> {
  return (
    resolvePathExecutable("claude") ??
    (await findPreferredClaudeLoginExecutable())
  );
}

export async function getClaudeLoginCommand(): Promise<string> {
  return formatClaudeLoginCommand(await findPreferredClaudeLoginExecutable());
}
