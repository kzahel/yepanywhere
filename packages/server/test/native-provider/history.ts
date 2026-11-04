import { readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { ClaudeSessionReader } from "../../src/sessions/reader.js";
import { CodexSessionReader } from "../../src/sessions/codex-reader.js";
import { AntigravitySessionReader } from "../../src/sessions/antigravity-reader.js";
import { PiSessionReader } from "../../src/sessions/pi-reader.js";
import { OpenCodeSessionReader } from "../../src/sessions/opencode-reader.js";
import { GrokSessionReader } from "../../src/sessions/grok-reader.js";
import { GeminiSessionReader } from "../../src/sessions/gemini-reader.js";
import type { ISessionReader } from "../../src/sessions/types.js";
import { isClaude, isCodex, type NativeProvider } from "./runtimes.js";

export async function findNativeFile(
  root: string,
  matches: (name: string) => boolean,
): Promise<string | undefined> {
  for (const entry of await readdir(root, { withFileTypes: true }).catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return [];
      throw error;
    },
  )) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      const found = await findNativeFile(path, matches);
      if (found) return found;
    } else if (matches(entry.name)) return path;
  }
  return undefined;
}

export async function historyReader(
  provider: NativeProvider,
  project: string,
  env: NodeJS.ProcessEnv,
  nativeId: string,
  executable: string,
): Promise<ISessionReader> {
  if (isClaude(provider)) {
    const path = await findNativeFile(
      env.CLAUDE_SESSIONS_DIR!,
      (name) => name === `${nativeId}.jsonl`,
    );
    if (!path) throw Error(`No native Claude transcript for ${nativeId}`);
    return new ClaudeSessionReader({ sessionDir: dirname(path) });
  }
  if (isCodex(provider))
    return new CodexSessionReader({
      sessionsDir: env.CODEX_SESSIONS_DIR!,
      projectPath: project,
      dataDir: env.YEP_DATA_DIR!,
    });
  if (provider === "antigravity")
    return new AntigravitySessionReader({
      sessionsDir: join(env.GEMINI_HOME!, "antigravity-acp", "conversations"),
      projectPath: project,
    });
  if (provider === "pi")
    return new PiSessionReader({
      sessionsDir: env.PI_SESSIONS_DIR!,
      projectPath: project,
    });
  if (provider === "grok")
    return new GrokSessionReader({
      sessionsDir: env.GROK_SESSIONS_DIR!,
      projectPath: project,
    });
  if (provider === "gemini-acp")
    return new GeminiSessionReader({
      sessionsDir: env.GEMINI_SESSIONS_DIR!,
      projectPath: project,
    });
  const root = join(env.XDG_DATA_HOME!, "opencode");
  return new OpenCodeSessionReader({
    storageDir: join(root, "storage"),
    databasePath: join(root, "opencode.db"),
    projectPath: project,
    opencodePath: executable,
  });
}
