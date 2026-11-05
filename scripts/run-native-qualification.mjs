import { spawn } from "node:child_process";
import {
  readHostCapacity,
  readHostSample,
  summarizeHostWindow,
} from "./perf-suite/host-profile.mjs";

export function nativeTestReporters() {
  // Agent/minimal reporters otherwise withhold successful-case evidence.
  return [
    "--reporter=default",
    ...(process.env.GITHUB_ACTIONS === "true"
      ? ["--reporter=github-actions"]
      : []),
    "--silent=false",
  ];
}

/** Keep both native runners' process exit and resource-window boundaries equal. */
export async function runNativeQualification(command, env, hostLabel) {
  const pnpm = process.env.npm_execpath;
  if (!pnpm) throw Error("Invoke native qualification through pnpm");
  const capacity = await readHostCapacity();
  const start = await readHostSample(capacity);
  console.info(JSON.stringify({ [hostLabel]: { capacity, start } }));
  try {
    return await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [pnpm, ...command], {
        stdio: "inherit",
        env: { ...process.env, ...env },
      });
      child.on("error", reject);
      child.on("close", (code) => resolve(code ?? 1));
    });
  } finally {
    const end = await readHostSample(capacity);
    console.info(
      JSON.stringify({
        [hostLabel]: {
          capacityKey: capacity.capacityKey,
          end,
          summary: summarizeHostWindow(capacity, start, end),
        },
      }),
    );
  }
}
