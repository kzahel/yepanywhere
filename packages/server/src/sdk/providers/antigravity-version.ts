import { execFile } from "node:child_process";

/** The oldest `agy` YA runs: the native test pin. Older runtimes are refused. */
export const ANTIGRAVITY_MIN_VERSION = "1.5.13";
const MINIMUM = [1, 5, 13] as const;

/** A runtime below the floor, or one whose version YA cannot read. */
export class AntigravityVersionError extends Error {
  override name = "AntigravityVersionError";
}

function parseVersion(raw: string): number[] | undefined {
  const match = raw.match(/(\d+)\.(\d+)\.(\d+)/);
  return match ? match.slice(1, 4).map(Number) : undefined;
}

function belowFloor(version: readonly number[]): boolean {
  for (let i = 0; i < MINIMUM.length; i++) {
    const actual = version[i] ?? 0;
    if (actual !== MINIMUM[i]) return actual < MINIMUM[i]!;
  }
  return false;
}

/**
 * The refusal for a version ACP `initialize` reported, or undefined when YA
 * supports it. A missing or unrecognizable version is refused, not assumed
 * current: the removed standalone runtime and a supported `agy` both answer
 * `initialize`, so only the version tells them apart.
 */
export function antigravityVersionRefusal(
  reported: unknown,
): string | undefined {
  const raw = typeof reported === "string" ? reported.trim() : "";
  const version = parseVersion(raw);
  if (version && !belowFloor(version)) return undefined;
  const installed = version
    ? `reports version ${version.join(".")}`
    : raw
      ? `reports an unrecognized version "${raw.slice(0, 40)}"`
      : "did not report a version";
  return `Antigravity requires agy ${ANTIGRAVITY_MIN_VERSION} or later; the installed runtime ${installed}. Run \`agy update\`, or install the agy CLI.`;
}

/** The refusal for `agy --version` output; undefined when supported or unreadable. */
export function antigravityCliVersionRefusal(
  output: string,
): string | undefined {
  return parseVersion(output) ? antigravityVersionRefusal(output) : undefined;
}

/**
 * `agy` before 1.5 has no `acp` subcommand, so it exits or stalls before
 * `initialize` can report a version. Its `--version` still names it. Asked
 * only after initialization fails; an unreadable answer keeps the native error.
 */
export function probeAntigravityVersionRefusal(
  command: string,
): Promise<string | undefined> {
  return new Promise((resolve) => {
    const child = execFile(
      command,
      ["--version"],
      { timeout: 3_000, maxBuffer: 4_096 },
      (error, stdout) =>
        resolve(error ? undefined : antigravityCliVersionRefusal(stdout)),
    );
    child.stdin?.end();
  });
}
