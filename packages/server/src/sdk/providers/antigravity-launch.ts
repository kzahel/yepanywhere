import { accessSync, constants, realpathSync } from "node:fs";
import type { CliCandidate } from "../../services/CliInstallationService.js";

/** An `agy` executable launched as its built-in ACP server, `agy acp`. */
export function describeAntigravityCandidate(path: string): CliCandidate {
  let command = path;
  let error: string | undefined;
  try {
    accessSync(path, constants.X_OK);
    command = realpathSync(path);
  } catch {
    error = "Selected executable is missing or not executable";
  }
  const args = ["acp"];
  if (process.env.CLOUD_CODE_URL && process.env.GEMINI_HOME) {
    // agy ACP otherwise looks under the OS home even when GEMINI_HOME is set.
    args.push("--gemini-dir", process.env.GEMINI_HOME);
  }
  return {
    path,
    source: "PATH / local",
    launch: { command, args },
    watchPaths: [],
    error,
  };
}
