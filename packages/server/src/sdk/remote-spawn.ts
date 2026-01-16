/**
 * Remote spawn implementation for SSH-based Claude execution.
 *
 * Uses SSH to spawn Claude on a remote machine while communicating
 * via stdin/stdout over the SSH tunnel.
 */

import { type ChildProcess, spawn } from "node:child_process";
import type { Readable, Writable } from "node:stream";
import { getLogger } from "../logging/logger.js";

/**
 * Options passed to the spawn function (from SDK).
 */
export interface SpawnOptions {
  command: string;
  args: string[];
  cwd?: string;
  env: Record<string, string | undefined>;
  signal: AbortSignal;
}

/**
 * Represents a spawned process with stdin/stdout streams (from SDK).
 */
export interface SpawnedProcess {
  stdin: Writable;
  stdout: Readable;
  readonly killed: boolean;
  readonly exitCode: number | null;
  kill(signal: NodeJS.Signals): boolean;
  on(
    event: "exit",
    listener: (code: number | null, signal: NodeJS.Signals | null) => void,
  ): void;
  on(event: "error", listener: (error: Error) => void): void;
  once(
    event: "exit",
    listener: (code: number | null, signal: NodeJS.Signals | null) => void,
  ): void;
  once(event: "error", listener: (error: Error) => void): void;
  off(
    event: "exit",
    listener: (code: number | null, signal: NodeJS.Signals | null) => void,
  ): void;
  off(event: "error", listener: (error: Error) => void): void;
}

/**
 * Options for creating a remote spawn function.
 */
export interface RemoteSpawnOptions {
  /** SSH host alias (from ~/.ssh/config) */
  host: string;
  /** Environment variables to set on remote (e.g., CLAUDE_SESSIONS_DIR for testing) */
  remoteEnv?: Record<string, string>;
}

/**
 * Result of SSH connection test.
 */
export interface SSHTestResult {
  success: boolean;
  /** Whether Claude CLI is available on the remote */
  claudeAvailable?: boolean;
  /** Claude version if available */
  claudeVersion?: string;
  /** Error message if failed */
  error?: string;
  /** SSH connection time in ms */
  connectionTimeMs?: number;
}

/**
 * Result of remote path check.
 */
export interface RemotePathCheckResult {
  exists: boolean;
  error?: string;
}

/**
 * Check if a directory exists on a remote host.
 */
export async function checkRemotePath(
  host: string,
  path: string,
): Promise<RemotePathCheckResult> {
  const log = getLogger();

  try {
    // Use test -d to check if directory exists
    const result = await runSSHCommand(
      host,
      `test -d '${escapeShell(path)}'`,
      5000,
    );

    if (result.success) {
      return { exists: true };
    }

    log.info(
      { event: "remote_path_check_failed", host, path },
      `Remote path does not exist: ${path} on ${host}`,
    );

    return {
      exists: false,
      error: `Directory does not exist on ${host}: ${path}`,
    };
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    return {
      exists: false,
      error: `Failed to check path on ${host}: ${errorMsg}`,
    };
  }
}

/**
 * Test SSH connection to a remote host.
 * Checks:
 * 1. SSH connectivity (with timeout)
 * 2. Claude CLI availability
 */
export async function testSSHConnection(host: string): Promise<SSHTestResult> {
  const log = getLogger();
  const startTime = Date.now();

  try {
    // Test basic SSH connectivity with 5 second timeout
    const connectResult = await runSSHCommand(host, "true", 5000);
    if (!connectResult.success) {
      return {
        success: false,
        error: connectResult.error ?? "SSH connection failed",
        connectionTimeMs: Date.now() - startTime,
      };
    }

    const connectionTimeMs = Date.now() - startTime;

    // Test Claude CLI availability (use login shell to get user's PATH)
    const claudeResult = await runSSHCommand(
      host,
      "bash -l -c 'claude --version'",
      10000,
    );
    if (!claudeResult.success) {
      return {
        success: true,
        claudeAvailable: false,
        error: "Claude CLI not found on remote",
        connectionTimeMs,
      };
    }

    // Parse Claude version from output
    const versionMatch = claudeResult.stdout?.match(/claude\s+(\S+)/i);
    const claudeVersion = versionMatch?.[1];

    log.info(
      {
        event: "ssh_test_success",
        host,
        claudeVersion,
        connectionTimeMs,
      },
      `SSH test successful: ${host} (Claude ${claudeVersion ?? "unknown"})`,
    );

    return {
      success: true,
      claudeAvailable: true,
      claudeVersion,
      connectionTimeMs,
    };
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    log.warn(
      { event: "ssh_test_failed", host, error: errorMsg },
      `SSH test failed: ${host} - ${errorMsg}`,
    );
    return {
      success: false,
      error: errorMsg,
      connectionTimeMs: Date.now() - startTime,
    };
  }
}

/**
 * Run a simple SSH command and return the result.
 */
async function runSSHCommand(
  host: string,
  command: string,
  timeoutMs: number,
): Promise<{ success: boolean; stdout?: string; error?: string }> {
  return new Promise((resolve) => {
    const sshProcess = spawn(
      "ssh",
      [
        "-o",
        `ConnectTimeout=${Math.ceil(timeoutMs / 1000)}`,
        "-o",
        "BatchMode=yes", // Don't prompt for password
        host,
        command,
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );

    let stdout = "";
    let stderr = "";

    sshProcess.stdout.on("data", (data: Buffer) => {
      stdout += data.toString();
    });

    sshProcess.stderr.on("data", (data: Buffer) => {
      stderr += data.toString();
    });

    const timeout = setTimeout(() => {
      sshProcess.kill("SIGTERM");
      resolve({ success: false, error: "Connection timeout" });
    }, timeoutMs);

    sshProcess.on("exit", (code) => {
      clearTimeout(timeout);
      if (code === 0) {
        resolve({ success: true, stdout: stdout.trim() });
      } else {
        resolve({
          success: false,
          error: stderr.trim() || `Exit code ${code}`,
        });
      }
    });

    sshProcess.on("error", (error) => {
      clearTimeout(timeout);
      resolve({ success: false, error: error.message });
    });
  });
}

/**
 * Create a spawn function that runs Claude on a remote machine via SSH.
 *
 * The returned function satisfies the SDK's spawnClaudeCodeProcess interface.
 * It spawns an SSH process that runs Claude on the remote machine,
 * piping stdin/stdout over the SSH tunnel.
 */
export function createRemoteSpawn(
  options: RemoteSpawnOptions,
): (spawnOptions: SpawnOptions) => SpawnedProcess {
  const { host, remoteEnv } = options;

  return (spawnOptions: SpawnOptions): SpawnedProcess => {
    const log = getLogger();
    const { command, args, cwd, env, signal } = spawnOptions;

    // Build the remote command
    // We need to:
    // 1. Set environment variables
    // 2. Change to the working directory
    // 3. Run the claude command with args

    const envParts: string[] = [];

    // Forward ANTHROPIC_API_KEY if set locally and not overridden
    if (env.ANTHROPIC_API_KEY && !remoteEnv?.ANTHROPIC_API_KEY) {
      envParts.push(
        `ANTHROPIC_API_KEY='${escapeShell(env.ANTHROPIC_API_KEY)}'`,
      );
    }

    // Add any remote-specific env vars (for testing)
    if (remoteEnv) {
      for (const [key, value] of Object.entries(remoteEnv)) {
        if (value !== undefined) {
          envParts.push(`${key}='${escapeShell(value)}'`);
        }
      }
    }

    // Build the full command
    // Use bash -il (interactive login shell) to get user's full PATH
    // Interactive (-i) sources .bashrc which is needed for NVM/node
    // Login (-l) sources .bash_profile/.profile

    // The SDK passes command='node' with args=['/local/path/to/cli.js', '--flag', 'value', ...]
    // For remote execution, we use the remote's `claude` CLI directly
    // Skip the first arg (local cli.js path) and keep the rest (flags and their values)
    const remoteArgs = args.slice(1);
    const escapedArgs = remoteArgs
      .map((arg) => `'${escapeShell(arg)}'`)
      .join(" ");
    // Use 'claude' command directly on the remote (installed via claude.ai/install.sh)
    const remoteCommand = "claude";
    const innerCmd = cwd
      ? `cd '${escapeShell(cwd)}' && ${envParts.join(" ")} ${remoteCommand} ${escapedArgs}`
      : `${envParts.join(" ")} ${remoteCommand} ${escapedArgs}`;
    // Wrap in interactive login shell - escape single quotes for the outer bash -il -c '...'
    const remoteCmd = `bash -il -c '${innerCmd.replace(/'/g, "'\\''")}'`;

    log.info(
      {
        event: "remote_spawn_start",
        host,
        command: remoteCommand,
        args: remoteArgs,
        cwd,
        remoteEnvKeys: remoteEnv ? Object.keys(remoteEnv) : [],
      },
      `Starting remote Claude on ${host}: ${remoteCommand} ${remoteArgs.join(" ")}`,
    );

    // Spawn SSH with PTY allocation (-t) so SIGHUP propagates when SSH terminates
    // This ensures the remote Claude process is killed if SSH disconnects
    const sshProcess = spawn(
      "ssh",
      [
        "-t", // PTY allocation for signal propagation
        "-o",
        "BatchMode=yes", // Don't prompt for password
        host,
        remoteCmd,
      ],
      {
        stdio: ["pipe", "pipe", "pipe"],
      },
    );

    // Handle stderr - log it but don't mix with SDK stdout
    sshProcess.stderr?.on("data", (data: Buffer) => {
      const stderr = data.toString();
      // Filter out PTY-related messages
      if (!stderr.includes("Pseudo-terminal") && stderr.trim()) {
        log.debug(
          { event: "remote_stderr", host, stderr: stderr.trim() },
          `Remote stderr: ${stderr.trim()}`,
        );
      }
    });

    // Handle abort signal
    const abortHandler = () => {
      log.info(
        { event: "remote_spawn_abort", host },
        `Aborting remote Claude on ${host}`,
      );
      sshProcess.kill("SIGTERM");
    };
    signal.addEventListener("abort", abortHandler);

    // Clean up abort listener when process exits
    sshProcess.on("exit", () => {
      signal.removeEventListener("abort", abortHandler);
    });

    // Return SpawnedProcess interface wrapping the SSH process
    return wrapChildProcess(sshProcess);
  };
}

/**
 * Wrap a ChildProcess to satisfy SpawnedProcess interface.
 */
function wrapChildProcess(childProcess: ChildProcess): SpawnedProcess {
  // Type-safe wrapper functions with overloads matching SDK interface
  function onWrapper(
    event: "exit",
    listener: (code: number | null, signal: NodeJS.Signals | null) => void,
  ): void;
  function onWrapper(event: "error", listener: (error: Error) => void): void;
  // biome-ignore lint/suspicious/noExplicitAny: ChildProcess.on requires any[] for listener args
  function onWrapper(event: string, listener: (...args: any[]) => void): void {
    childProcess.on(event, listener);
  }

  function onceWrapper(
    event: "exit",
    listener: (code: number | null, signal: NodeJS.Signals | null) => void,
  ): void;
  function onceWrapper(event: "error", listener: (error: Error) => void): void;
  function onceWrapper(
    event: string,
    // biome-ignore lint/suspicious/noExplicitAny: ChildProcess.once requires any[] for listener args
    listener: (...args: any[]) => void,
  ): void {
    childProcess.once(event, listener);
  }

  function offWrapper(
    event: "exit",
    listener: (code: number | null, signal: NodeJS.Signals | null) => void,
  ): void;
  function offWrapper(event: "error", listener: (error: Error) => void): void;
  // biome-ignore lint/suspicious/noExplicitAny: ChildProcess.off requires any[] for listener args
  function offWrapper(event: string, listener: (...args: any[]) => void): void {
    childProcess.off(event, listener);
  }

  return {
    stdin: childProcess.stdin as Writable,
    stdout: childProcess.stdout as Readable,
    get killed() {
      return childProcess.killed;
    },
    get exitCode() {
      return childProcess.exitCode;
    },
    kill(signal: NodeJS.Signals): boolean {
      return childProcess.kill(signal);
    },
    on: onWrapper,
    once: onceWrapper,
    off: offWrapper,
  };
}

/**
 * Escape a string for use in a shell command.
 */
function escapeShell(str: string): string {
  // Replace single quotes with escaped version
  return str.replace(/'/g, "'\\''");
}
