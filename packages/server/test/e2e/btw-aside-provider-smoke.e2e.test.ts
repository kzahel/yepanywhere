import { parseNativeSessionId } from "@yep-anywhere/shared";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ClaudeProvider } from "../../src/sdk/providers/claude.js";
import { CodexProvider } from "../../src/sdk/providers/codex.js";
import type { AgentProvider } from "../../src/sdk/providers/types.js";
import type { SDKMessage } from "../../src/sdk/types.js";
import { cloneClaudeSession } from "../../src/sessions/fork.js";

type SmokeProvider = "claude" | "codex";

const ENABLED = process.env.BTW_ASIDE_PROVIDER_SMOKE === "true";
const REQUESTED_PROVIDER_NAMES = (
  process.env.BTW_ASIDE_PROVIDERS ?? "claude,codex"
)
  .split(",")
  .map((item) => item.trim())
  .filter(Boolean);
const REQUESTED_PROVIDERS = new Set(REQUESTED_PROVIDER_NAMES);
const MAX_STORAGE_FORK_MS = Number(
  process.env.BTW_ASIDE_MAX_STORAGE_FORK_MS ?? "3000",
);
const MAX_ASIDE_TURN_MS = Number(
  process.env.BTW_ASIDE_MAX_ASIDE_TURN_MS ?? "120000",
);

interface TurnResult {
  sessionId: string;
  durationMs: number;
  assistantText: string;
}

function log(...args: unknown[]) {
  if (process.env.FOREGROUND === "1") {
    console.log("[btw-smoke]", ...args);
  }
}

function textFromContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((block) =>
      block && typeof block === "object" && "text" in block
        ? String((block as { text?: unknown }).text ?? "")
        : "",
    )
    .filter(Boolean)
    .join("\n");
}

function latestAssistantText(messages: SDKMessage[]): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.type !== "assistant") continue;
    const text = textFromContent(message.message?.content).trim();
    if (text) return text;
  }
  return "";
}

async function runTurn(
  provider: AgentProvider,
  cwd: string,
  prompt: string,
  options: { resumeSessionId?: string; model?: string } = {},
): Promise<TurnResult> {
  const startedAt = Date.now();
  const session = await provider.startSession({
    cwd,
    initialMessage: { text: prompt },
    resumeSessionId: options.resumeSessionId,
    permissionMode: "bypassPermissions",
    model: options.model,
  });
  let sessionId = session.sessionId ?? options.resumeSessionId;
  const messages: SDKMessage[] = [];
  const timeout = setTimeout(() => session.abort(), MAX_ASIDE_TURN_MS);

  try {
    for await (const message of session.iterator) {
      messages.push(message);
      if (!sessionId && typeof message.session_id === "string") {
        sessionId = message.session_id;
      }
      if (message.type === "result" || message.type === "error") {
        break;
      }
    }
  } finally {
    clearTimeout(timeout);
  }

  if (!sessionId) {
    throw new Error("Provider turn completed without a session ID");
  }

  const assistantText = latestAssistantText(messages);
  if (!assistantText) {
    throw new Error("Provider turn completed without assistant text");
  }

  return {
    sessionId,
    durationMs: Date.now() - startedAt,
    assistantText,
  };
}

function findFile(
  root: string,
  predicate: (path: string) => boolean,
): string | null {
  if (!existsSync(root)) return null;
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      const nested = findFile(path, predicate);
      if (nested) return nested;
    } else if (entry.isFile() && predicate(path)) {
      return path;
    }
  }
  return null;
}

function findClaudeSessionFile(root: string, sessionId: string): string | null {
  return findFile(root, (path) => path.endsWith(`${sessionId}.jsonl`));
}

describe("real provider /btw fork smoke", () => {
  let testRoot = "";
  let projectDir = "";
  let previousEnv: Record<string, string | undefined> = {};

  beforeAll(() => {
    if (!ENABLED) {
      console.log(
        "Skipping /btw provider smoke - set BTW_ASIDE_PROVIDER_SMOKE=true to enable",
      );
      return;
    }
    if (REQUESTED_PROVIDERS.has("opencode")) {
      console.log(
        "Skipping OpenCode /btw smoke - YA has no OpenCode storage-fork path yet; " +
          "add it only with BTW_ASIDE_OPENCODE_MODEL set to a free cloud model or <=0.5B local model",
      );
    }

    testRoot = mkdtempSync(join(tmpdir(), "yep-btw-provider-smoke-"));
    projectDir = join(testRoot, "project");
    mkdirSync(projectDir, { recursive: true });
    writeFileSync(join(projectDir, "README.md"), "# /btw smoke\n", "utf-8");

    const claudeSessionsDir = join(testRoot, "claude-projects");
    const codexSessionsDir = join(testRoot, "codex-sessions");
    mkdirSync(claudeSessionsDir, { recursive: true });
    mkdirSync(codexSessionsDir, { recursive: true });

    previousEnv = {
      CLAUDE_SESSIONS_DIR: process.env.CLAUDE_SESSIONS_DIR,
      CODEX_SESSIONS_DIR: process.env.CODEX_SESSIONS_DIR,
    };
    process.env.CLAUDE_SESSIONS_DIR = claudeSessionsDir;
    process.env.CODEX_SESSIONS_DIR = codexSessionsDir;
  });

  afterAll(() => {
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    if (testRoot) {
      rmSync(testRoot, { recursive: true, force: true });
    }
  });

  for (const providerName of ["claude", "codex"] as SmokeProvider[]) {
    it(
      `${providerName} can resume a forked /btw session`,
      async () => {
        if (!ENABLED || !REQUESTED_PROVIDERS.has(providerName)) {
          return;
        }

        const provider =
          providerName === "claude"
            ? new ClaudeProvider()
            : new CodexProvider();
        if (!(await provider.isInstalled())) {
          console.log(`Skipping ${providerName} /btw smoke - provider missing`);
          return;
        }

        const model =
          process.env[
            providerName === "claude"
              ? "BTW_ASIDE_CLAUDE_MODEL"
              : "BTW_ASIDE_CODEX_MODEL"
          ];
        const parent = await runTurn(
          provider,
          projectDir,
          'Reply with exactly "parent-ready" and nothing else.',
          { model },
        );
        expect(parent.assistantText.toLowerCase()).toContain("parent-ready");
        log(providerName, "parent", parent);

        const forkStartedAt = Date.now();
        let clone: { newSessionId: string };
        if (providerName === "claude") {
          const sourcePath = findClaudeSessionFile(
            process.env.CLAUDE_SESSIONS_DIR ?? "",
            parent.sessionId,
          );
          if (!sourcePath) {
            throw new Error(
              `Could not find Claude source session ${parent.sessionId}`,
            );
          }
          clone = await cloneClaudeSession(
            dirname(sourcePath),
            parent.sessionId,
          );
        } else {
          const fork = await provider.forkSession({
            nativeSessionId: parseNativeSessionId(parent.sessionId),
            cwd: projectDir,
          });
          clone = { newSessionId: fork.nativeSessionId };
        }
        const storageForkMs = Date.now() - forkStartedAt;
        expect(storageForkMs).toBeLessThan(MAX_STORAGE_FORK_MS);
        log(providerName, "clone", {
          id: clone.newSessionId,
          storageForkMs,
        });

        const aside = await runTurn(
          provider,
          projectDir,
          'Reply with exactly "aside-ready" and nothing else.',
          { resumeSessionId: clone.newSessionId, model },
        );
        expect(aside.sessionId).toBe(clone.newSessionId);
        expect(aside.durationMs).toBeLessThan(MAX_ASIDE_TURN_MS);
        expect(aside.assistantText.toLowerCase()).toContain("aside-ready");
      },
      MAX_ASIDE_TURN_MS + 30000,
    );
  }
});
