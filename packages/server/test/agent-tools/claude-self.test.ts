import { spawn } from "node:child_process";
import { afterEach, expect, it, vi } from "vitest";
import { parseYaSessionId } from "@yep-anywhere/shared";
import { ClaudeProvider } from "../../src/sdk/providers/claude.js";

async function run(
  command: string,
  args: string[],
  options: { env: NodeJS.ProcessEnv; timeout: number },
) {
  return await new Promise<{ stdout: string }>((resolve, reject) => {
    const child = spawn(command, args, {
      ...options,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (data) => {
      stdout += data;
    });
    child.stderr.on("data", (data) => {
      stderr += data;
    });
    child.on("error", reject);
    child.on("exit", (code, signal) =>
      code === 0
        ? resolve({ stdout })
        : reject(
            new Error(`Probe failed ${code}/${signal}: ${stdout} ${stderr}`),
          ),
    );
  });
}
const { query } = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock("@anthropic-ai/claude-agent-sdk", async (original) => ({
  ...(await original<object>()),
  query,
}));

afterEach(() => vi.unstubAllEnvs());

it.each(["legacy", "managed"])(
  "Claude production adapter delivers the real command through its session Bash bridge (%s)",
  async (kind) => {
    const publicId =
      kind === "managed"
        ? parseYaSessionId("public-claude-session")
        : undefined;
    vi.stubEnv("BASH_ENV", undefined);
    vi.stubEnv("YEP_ORIGINAL_BASH_ENV", undefined);
    vi.stubEnv("AGENTCTL_SESSION_ID", undefined);
    query.mockImplementation(({ options }) =>
      (async function* () {
        if (publicId) {
          const early = await run(
            process.platform === "win32" ? "cmd.exe" : "bash",
            process.platform === "win32"
              ? ["/d", "/s", "/c", "ya-agent self --json"]
              : ["-c", "ya-agent self --json"],
            { env: options.env, timeout: 10000 },
          );
          expect(JSON.parse(early.stdout).sessionId).toBe(publicId);
        }
        yield {
          type: "system",
          subtype: "init",
          session_id: "claude-self-test",
          model: "claude-resolved-test",
        };
        const result = await run(
          process.platform === "win32" ? "cmd.exe" : "bash",
          process.platform === "win32"
            ? ["/d", "/s", "/c", "ya-agent self --json"]
            : ["-c", "ya-agent self --json"],
          {
            env: {
              ...options.env,
            },
            timeout: 10000,
          },
        );
        yield {
          type: "assistant",
          session_id: "claude-self-test",
          message: { role: "assistant", content: result.stdout },
        };
        yield {
          type: "result",
          session_id: "claude-self-test",
          subtype: "success",
        };
      })(),
    );
    const session = await new ClaudeProvider().startSession({
      cwd: process.cwd(),
      agentSelf: true,
      publicSessionId: publicId,
      model: "sonnet",
      effort: "low",
    });
    let report: unknown;
    try {
      for await (const message of session.iterator) {
        if (
          !publicId &&
          message.type === "system" &&
          message.subtype === "init"
        )
          await session.publishAgentctlSessionId?.("claude-self-test");
        if (message.type === "assistant")
          report = JSON.parse(String(message.message?.content));
      }
      expect(report).toMatchObject({
        sessionId: publicId ?? "claude-self-test",
        harness: "claude",
        launch: { model: { value: "sonnet" }, effort: { value: "low" } },
        providerEvidence: {
          model: { value: "claude-resolved-test", source: "provider-init" },
          effort: { status: "unknown" },
        },
      });
    } finally {
      await session.abort();
    }
  },
  15000,
);
