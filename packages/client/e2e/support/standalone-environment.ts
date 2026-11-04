import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { CONFIG_ENV_VARS } from "../../../server/test/setup/config-env-vars.js";
import type { YaServerProfilePaths } from "./ya-server-process.js";

/** Compose explicit fixture inputs without inheriting provider or agent authority. */
export function standaloneYaEnvironment(
  paths: YaServerProfilePaths,
  runtimeDir: string,
  providerHostEnabled: boolean,
  inputs: NodeJS.ProcessEnv = {},
  parent: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const configNames = new Set<string>(
    CONFIG_ENV_VARS.map((name) => name.toUpperCase()),
  );
  const controlPlane = (name: string) =>
    /^(AGENT_|AGENTCTL_|YEP_PROVIDER_|YEP_AGENT_|YA_)/.test(name) ||
    [
      "YEP_SERVER_GENERATION",
      "NODE_OPTIONS",
      "BUN_OPTIONS",
      "BASH_ENV",
      "ENV",
      "ZDOTDIR",
      "YEP_ORIGINAL_BASH_ENV",
      "YEP_ANYWHERE_ORIGINAL_BASH_ENV",
    ].includes(name);
  const env = Object.fromEntries(
    Object.entries(parent).filter(([key]) => {
      const name = key.toUpperCase();
      return (
        !configNames.has(name) &&
        !controlPlane(name) &&
        !/^(ANTHROPIC_|CLAUDE_|CODEX_|OPENAI_|GEMINI_|ANTIGRAVITY_|GOOGLE_|GROK_|XAI_|PI_|OPENCODE_)/.test(
          name,
        ) &&
        !/(?:_API_KEY|_TOKEN|_SECRET|_PASSWORD)$/.test(name)
      );
    }),
  );
  const selected = Object.fromEntries(
    Object.entries(inputs).filter(([key]) => !controlPlane(key.toUpperCase())),
  );
  const home = paths.profileDir;
  // Explicit test inputs may include selected credentials or fake executables.
  // Owned roots and host selection always win over those inputs.
  const owned: NodeJS.ProcessEnv = {
    HOME: home,
    USERPROFILE: home,
    APPDATA: directory(home, "AppData", "Roaming"),
    LOCALAPPDATA: directory(home, "AppData", "Local"),
    XDG_CONFIG_HOME: directory(home, "config"),
    XDG_DATA_HOME: directory(home, "data"),
    XDG_CACHE_HOME: directory(home, "cache"),
    XDG_RUNTIME_DIR: directory(home, "runtime"),
    TMPDIR: directory(home, "tmp"),
    TMP: join(home, "tmp"),
    TEMP: join(home, "tmp"),
    CLAUDE_CONFIG_DIR: join(home, "claude"),
    CLAUDE_PROJECTS_DIR: paths.claudeSessionsDir,
    CLAUDE_SESSIONS_DIR: paths.claudeSessionsDir,
    CODEX_HOME: join(home, "codex"),
    CODEX_SESSIONS_DIR: paths.codexSessionsDir,
    GEMINI_SESSIONS_DIR: paths.geminiSessionsDir,
    GEMINI_CLI_HOME: home,
    GEMINI_HOME: join(home, ".gemini"),
    PI_CODING_AGENT_DIR: join(home, "pi"),
    PI_SESSIONS_DIR: directory(home, "pi", "sessions"),
    GROK_HOME: join(home, "grok"),
    GROK_SESSIONS_DIR: directory(home, "grok", "sessions"),
    YEP_DATA_DIR: paths.dataDir,
    YEP_SCRATCH_DIR: directory(home, "scratch"),
    YEP_PROVIDER_HOST_RUNTIME_DIR: runtimeDir,
    YEP_PROVIDER_HOST_ENABLED: String(providerHostEnabled),
    HOST: "127.0.0.1",
    PORT: "0",
    PORT_FILE: join(paths.tempDir, "port"),
    MAINTENANCE_PORT: "0",
    MAINTENANCE_PORT_FILE: join(paths.tempDir, "maintenance-port"),
    AUTH_DISABLED: "true",
    HTTPS_SELF_SIGNED: "",
    OPEN_BROWSER: "false",
    SERVE_FRONTEND: "false",
    LOG_TO_FILE: "false",
    LOG_LEVEL: "warn",
    LOG_FILE_LEVEL: "warn",
    NODE_ENV: "production",
  };
  // Plain objects lose Windows' case-insensitive environment lookup. Remove
  // every case variant before installing one canonical owned name.
  const protectedNames = new Set(
    Object.keys(owned).map((name) => name.toUpperCase()),
  );
  const unprotected = (values: NodeJS.ProcessEnv) =>
    Object.fromEntries(
      Object.entries(values).filter(
        ([key]) => !protectedNames.has(key.toUpperCase()),
      ),
    );
  return { ...unprotected(env), ...unprotected(selected), ...owned };
}

function directory(...parts: string[]): string {
  const path = join(...parts);
  mkdirSync(path, { recursive: true });
  return path;
}
