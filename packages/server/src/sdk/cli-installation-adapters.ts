import { describeAntigravityCandidate } from "./providers/antigravity-launch.js";
import { antigravityCliVersionRefusal } from "./providers/antigravity-version.js";
import { execFile } from "node:child_process";
import { existsSync, realpathSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, delimiter, join } from "node:path";
import { promisify } from "node:util";
import type {
  CliCandidate,
  CliInstallationAdapter,
} from "../services/CliInstallationService.js";
import {
  discoverCodexCliCandidates,
  resetCodexCliDiscovery,
  probeCodexCliVersion,
} from "./cli-detection.js";
import { probeCodexExecution } from "./codex-execution-probe.js";

const execFileAsync = promisify(execFile);

/** npm launchers depend on Node and optional platform packages; keep those facts. */
export function describeCodexCandidate(
  path: string,
  version?: string,
  error?: string,
): CliCandidate {
  let command = path;
  const watchPaths: string[] = [
    join(
      dirname(path),
      "codex-code-mode-host" + (process.platform === "win32" ? ".exe" : ""),
    ),
  ];
  try {
    const target = realpathSync(path);
    const packageRoots = [
      dirname(dirname(target)),
      join(dirname(path), "node_modules", "@openai", "codex"),
      join(dirname(dirname(path)), "lib", "node_modules", "@openai", "codex"),
    ];
    for (const root of packageRoots) {
      const manifest = join(root, "package.json");
      if (
        !existsSync(manifest) ||
        JSON.parse(readFileSync(manifest, "utf8")).name !== "@openai/codex"
      )
        continue;
      const require = createRequire(manifest);
      const suffix = {
        darwin: "apple-darwin",
        linux: "unknown-linux-musl",
        win32: "pc-windows-msvc",
      }[process.platform as "darwin" | "linux" | "win32"];
      const arch = process.arch === "arm64" ? "aarch64" : "x86_64";
      try {
        const native = dirname(
          require.resolve(
            `@openai/codex-${process.platform}-${process.arch}/package.json`,
          ),
        );
        const binary = join(
          native,
          "vendor",
          `${arch}-${suffix}`,
          "bin",
          process.platform === "win32" ? "codex.exe" : "codex",
        );
        if (existsSync(binary)) {
          command = binary;
          watchPaths.push(manifest, dirname(binary));
          break;
        }
      } catch {
        /* Standalone and older npm layouts keep their own launcher. */
      }
    }
    watchPaths.push(
      join(
        dirname(realpathSync(command)),
        "codex-code-mode-host" + (process.platform === "win32" ? ".exe" : ""),
      ),
    );
  } catch {
    /* Missing explicit choices are retained with their diagnostic. */
  }
  const hostName =
    "codex-code-mode-host" + (process.platform === "win32" ? ".exe" : "");
  const resolvedCommand = (() => {
    try {
      return realpathSync(command);
    } catch {
      return command;
    }
  })();
  for (const root of [
    dirname(resolvedCommand),
    dirname(dirname(resolvedCommand)),
  ]) {
    watchPaths.push(
      join(root, "codex-resources", hostName),
      join(root, "codex-package.json"),
    );
  }
  const normalized = path.replaceAll("\\", "/");
  const source = normalized.includes("/.sandbox-bin/")
    ? "internal fallback"
    : /\.app\/Contents\/|\/OpenAI\/Codex\/bin\//i.test(normalized)
      ? "desktop app"
      : /fnm|node_modules|\/npm\//i.test(normalized) || /\.cmd$/i.test(path)
        ? "npm / fnm"
        : normalized.includes("/.cargo/")
          ? "cargo"
          : "PATH / local";
  return {
    path,
    launch: { command, args: [] },
    source,
    version,
    error,
    watchPaths,
  };
}

export const codexInstallationAdapter: CliInstallationAdapter = {
  family: "codex",
  installationFamily: "codex-cli",
  probeRevision: "shell-output-v2",
  contextKey: () =>
    JSON.stringify([
      process.platform,
      process.arch,
      process.env.PATH,
      process.env.FNM_DIR,
      process.env.COMSPEC,
      process.env.SHELL,
      process.env.SystemRoot,
      process.env.WINDIR,
      process.env.PATHEXT,
    ]),
  async discover(explicit) {
    if (explicit) {
      const result = await probeCodexCliVersion(explicit);
      return [
        describeCodexCandidate(
          explicit,
          result.ok ? result.version : undefined,
          result.ok ? undefined : (result.error ?? result.reason),
        ),
      ];
    }
    return (await discoverCodexCliCandidates()).map((candidate) =>
      describeCodexCandidate(
        candidate.path,
        candidate.version,
        candidate.error,
      ),
    );
  },
  verify: probeCodexExecution,
  rescan: resetCodexCliDiscovery,
};

export const antigravityInstallationAdapter: CliInstallationAdapter = {
  family: "antigravity",
  installationFamily: "antigravity-cli",
  probeRevision: "no-offline-execution-v1",
  contextKey: () =>
    JSON.stringify([process.platform, process.arch, process.env.PATH]),
  async discover(explicit) {
    if (process.platform === "win32") return [];
    const paths = explicit
      ? [explicit]
      : (process.env.PATH ?? "")
          .split(delimiter)
          .filter(Boolean)
          .map((dir) => join(dir, "agy"))
          .filter(existsSync);
    const candidates = [...new Set(paths)]
      .slice(0, 64)
      .map(describeAntigravityCandidate);
    await Promise.all(
      candidates.map(async (candidate) => {
        if (candidate.error) return;
        try {
          candidate.version = (
            await execFileAsync(candidate.launch.command, ["--version"], {
              timeout: 3000,
              maxBuffer: 4096,
            })
          ).stdout.trim();
        } catch {
          /* Executability and offline execution qualification stay separate. */
          return;
        }
        candidate.error = antigravityCliVersionRefusal(candidate.version);
      }),
    );
    return candidates;
  },
};
