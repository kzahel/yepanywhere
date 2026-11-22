import { spawn } from "node:child_process";
import { stripYaControlPlaneCredentials } from "./env-filter.js";

/** The oldest `agy` YA runs: the native test pin. Older runtimes are refused. */
export const ANTIGRAVITY_MIN_VERSION = "1.5.13";
const MINIMUM = [1, 5, 13] as const;
// `agy` reports a bare semantic version, from ACP `initialize` and `--version`.
const VERSION =
  /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

/** A runtime below the floor, or one whose version YA cannot read. */
export class AntigravityVersionError extends Error {
  override name = "AntigravityVersionError";
}

/** Undefined when `raw` is not a whole semantic version. */
function belowFloor(raw: string): boolean | undefined {
  const match = VERSION.exec(raw);
  if (!match) return undefined;
  for (let i = 0; i < MINIMUM.length; i++) {
    const actual = Number(match[i + 1]);
    if (actual !== MINIMUM[i]) return actual < MINIMUM[i]!;
  }
  // A prerelease precedes the release it names.
  return match[4] !== undefined;
}

function quoted(raw: string): string {
  return raw.replace(/[^\x20-\x7e]/g, "?").slice(0, 40);
}

function refusal(installed: string): string {
  return `Antigravity requires agy ${ANTIGRAVITY_MIN_VERSION} or later; the installed runtime ${installed}. Run \`agy update\`, or install the agy CLI.`;
}

/**
 * The refusal for a version ACP `initialize` reported, or undefined when YA
 * supports it. A missing or unrecognizable version is refused, not assumed
 * current.
 */
export function antigravityVersionRefusal(
  reported: unknown,
): string | undefined {
  const raw = typeof reported === "string" ? reported.trim() : "";
  const below = belowFloor(raw);
  if (below === false) return undefined;
  return refusal(
    below
      ? `reports version ${quoted(raw)}`
      : raw
        ? `reports an unrecognized version "${quoted(raw)}"`
        : "did not report a version",
  );
}

/** The refusal for `agy --version` output; undefined when supported or unreadable. */
export function antigravityCliVersionRefusal(
  output: string,
): string | undefined {
  return belowFloor(output.trim())
    ? antigravityVersionRefusal(output)
    : undefined;
}

/**
 * Run `<command> --version` as an owned child: YA credentials are filtered
 * from its environment, and the deadline or `signal` kills its process group
 * and waits for it to exit. Resolves the trimmed output, or undefined when
 * the command fails, is cancelled or runs out of time.
 */
export function readAgyVersion(
  command: string,
  signal?: AbortSignal,
  deadlineMs = 3_000,
): Promise<string | undefined> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve(undefined);
    const group = process.platform !== "win32";
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(command, ["--version"], {
        stdio: ["ignore", "pipe", "ignore"],
        env: stripYaControlPlaneCredentials(process.env),
        detached: group,
      });
    } catch {
      return resolve(undefined);
    }
    let output = "";
    let killed = false;
    let settled = false;
    const finish = (value: string | undefined) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      signal?.removeEventListener("abort", kill);
      child.stdout?.destroy();
      resolve(value);
    };
    function kill() {
      killed = true;
      // An exited leader cannot be waited on again; stop reading instead.
      if (child.exitCode !== null || child.signalCode !== null)
        return finish(undefined);
      try {
        if (group && child.pid) process.kill(-child.pid, "SIGKILL");
        else child.kill("SIGKILL");
      } catch {
        /* Already exited; the exit event finishes. */
      }
    }
    const deadline = setTimeout(kill, deadlineMs);
    signal?.addEventListener("abort", kill, { once: true });
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      output += chunk;
      if (output.length > 4_096) kill();
    });
    child.once("error", () => finish(undefined));
    child.once("exit", () => {
      if (killed) finish(undefined);
    });
    child.once("close", (code) =>
      finish(!killed && code === 0 ? output.trim() : undefined),
    );
  });
}
