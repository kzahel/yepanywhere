import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  ModelInfo,
  ProviderSubscriptionUsage,
  ProviderSubscriptionUsageWindow,
} from "@yep-anywhere/shared";
import { quoteShellWord } from "../../utils/posixShell.js";
import {
  processTreeSpawnOptions,
  signalProcessTree,
} from "../../utils/processTree.js";
import { stripYaControlPlaneCredentials } from "./env-filter.js";

const QUOTA_FAMILIES = [
  {
    bucket: "gemini",
    label: "Gemini",
    model: /^gemini-(?!4-(?:argon|carbon)(?:-|$)|pro-orchestrator-)/,
  },
  {
    bucket: "gemini-argon-wtu",
    label: "Gemini Argon",
    model: /^gemini-4-argon(?:-|$)/,
  },
  {
    bucket: "gemini-carbon-wtu",
    label: "Gemini Carbon",
    model: /^gemini-4-carbon(?:-|$)/,
  },
  {
    bucket: "gemini-carbon",
    label: "Gemini Carbon",
    model: /^gemini-4-carbon(?:-|$)/,
  },
  { bucket: "3p", label: "Claude & GPT", model: /^(?:claude|gpt)-/ },
] as const;

const WINDOWS = { "5h": 300, weekly: 10_080 } as const;
const BUCKETS = QUOTA_FAMILIES.flatMap((family) =>
  Object.entries(WINDOWS).map(([window, minutes]) => ({
    ...family,
    id: `${family.bucket}-${window}`,
    minutes,
  })),
);

interface QuotaReading {
  quota: Record<string, { remaining_fraction: number; reset_time?: string }>;
  fetchedAt: string;
}

const PROBE_TIMEOUT_MS = 8_000;

// The CLI callback receives other session and account fields. Only recognized
// quota buckets cross into the probe's private temporary directory.
const REPORT_QUOTA = `
const fs = require('node:fs');
const [pidFile, quotaFile, bucketIds] = process.argv.slice(2);
const status = JSON.parse(fs.readFileSync(0, 'utf8'));
const quota = {};
for (const id of JSON.parse(bucketIds)) {
  const bucket = status.quota?.[id];
  const fraction = bucket?.remaining_fraction;
  if (bucket?.disabled || !Number.isFinite(fraction) || fraction < 0 || fraction > 1) continue;
  quota[id] = { remaining_fraction: fraction };
  if (typeof bucket.reset_time === 'string' && bucket.reset_time.length <= 64) {
    quota[id].reset_time = bucket.reset_time;
  }
}
if (Object.keys(quota).length > 0) {
  fs.writeFileSync(quotaFile, JSON.stringify({quota, fetchedAt: new Date().toISOString()}), {flag: 'wx'});
  process.kill(Number(fs.readFileSync(pidFile, 'utf8')), 'SIGINT');
}
`;

export function canProbeAntigravityUsage(): boolean {
  return (
    (process.platform === "darwin" || process.platform === "linux") &&
    !process.env.CLOUD_CODE_URL &&
    !process.env.AGY_LLM_GATEWAY_URL &&
    !process.env.AGY_ACP_CCPA_PROJECT &&
    !process.env.GEMINI_API_KEY &&
    !process.env.GOOGLE_API_KEY
  );
}

export async function probeAntigravityUsage(
  command: string,
): Promise<QuotaReading | null> {
  const directory = await mkdtemp(join(tmpdir(), "ya-agy-usage-"));
  try {
    const pidFile = join(directory, "pid");
    const quotaFile = join(directory, "quota.json");
    const callbackPath = join(directory, "status-line.cjs");
    await writeFile(callbackPath, REPORT_QUOTA);
    const callback = [
      process.execPath,
      callbackPath,
      pidFile,
      quotaFile,
      JSON.stringify(BUCKETS.map(({ id }) => id)),
    ]
      .map(quoteShellWord)
      .join(" ");
    const settings = JSON.stringify({
      statusLine: {
        type: "command",
        command: `exec ${callback}`,
        enabled: true,
      },
    });
    // script creates a separate process group for the PTY foreground command.
    // Save its leader before exec so a timeout can stop that group too.
    const invocation = [
      "/bin/sh",
      "-c",
      'printf "%s" "$$" > "$1" && shift && exec "$@"',
      "agy-usage",
      pidFile,
      command,
      "--settings",
      settings,
      "--log-file",
      join(directory, "agy.log"),
    ];
    const macOS = process.platform === "darwin";
    const args = macOS
      ? ["-q", "/dev/null", ...invocation]
      : [
          "-q",
          "-c",
          `exec ${invocation.map(quoteShellWord).join(" ")}`,
          "/dev/null",
        ];
    const child = spawn("script", args, {
      ...processTreeSpawnOptions,
      cwd: directory,
      // BSD script rejects Node's socket-backed stdin. util-linux accepts the
      // socket, which we leave open so it does not inject an EOF into the PTY.
      stdio: [macOS ? "ignore" : "pipe", "ignore", "ignore"],
      env: {
        ...stripYaControlPlaneCredentials(process.env),
        AGY_CLI_DISABLE_AUTO_UPDATE: "1",
        BROWSER: "/usr/bin/false",
        SHELL: "/bin/sh",
        TERM: "xterm-256color",
      },
    });
    const closed = new Promise<true>((resolve) => {
      child.once("error", () => undefined);
      child.once("close", () => resolve(true));
    });
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<false>((resolve) => {
      timeout = setTimeout(() => resolve(false), PROBE_TIMEOUT_MS);
    });
    const finished = await Promise.race([closed, deadline]);
    clearTimeout(timeout);
    if (!finished) {
      const group = Number(await readFile(pidFile, "utf8").catch(() => ""));
      if (
        child.exitCode === null &&
        child.signalCode === null &&
        Number.isSafeInteger(group) &&
        group > 1
      ) {
        try {
          process.kill(-group, "SIGKILL");
        } catch {
          // The foreground command may have exited as the deadline fired.
        }
      }
      const escalation = setTimeout(
        () => signalProcessTree(child, "SIGKILL"),
        500,
      );
      try {
        await closed;
      } finally {
        clearTimeout(escalation);
      }
      return null;
    }

    const result = await readFile(quotaFile, "utf8").catch(() => undefined);
    return result ? (JSON.parse(result) as QuotaReading) : null;
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

export function normalizeAntigravityUsage(
  reading: QuotaReading | null,
  models: readonly ModelInfo[],
): ProviderSubscriptionUsage | null {
  if (!reading) return null;
  const windows: ProviderSubscriptionUsageWindow[] = [];
  for (const bucket of BUCKETS) {
    const quota = reading.quota[bucket.id];
    if (!quota) continue;
    const modelIds = models
      .filter(({ id }) => bucket.model.test(id))
      .map(({ id }) => id);
    if (modelIds.length === 0) continue;
    // A window with no usage yet reports the Unix epoch as its reset time.
    const reset = Date.parse(quota.reset_time ?? "");
    windows.push({
      id: `antigravity:${bucket.id}`,
      usedPercent: (1 - quota.remaining_fraction) * 100,
      windowDurationMinutes: bucket.minutes,
      resetsAt: reset > 0 ? new Date(reset).toISOString() : undefined,
      scope: { type: "models", label: bucket.label, modelIds },
    });
  }
  return windows.length > 0
    ? { provider: "antigravity", windows, fetchedAt: reading.fetchedAt }
    : null;
}
