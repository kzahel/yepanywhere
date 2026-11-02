// Test-only adapter seam. The real Hono, host, production worker,
// ProviderSessionOwner, socket adapter and proxy all execute unchanged.
// Loaded explicitly with Node --import, never from production code.
import { appendFileSync, existsSync, mkdirSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";

const root = process.env.YA_HOST_TEST_ROOT;
const target = process.argv[1] ?? "";
if (
  root &&
  (target.endsWith("/src/index.ts") ||
    target.endsWith("/provider-runtime-worker.ts"))
) {
  const { getRawProvider } = await import(
    "../../../src/sdk/providers/index.ts"
  );
  const { MessageQueue } = await import("../../../src/sdk/messageQueue.ts");
  const record = (event) =>
    appendFileSync(
      join(root, "barriers.jsonl"),
      `${JSON.stringify({ ...event, pid: process.pid, at: Date.now() })}\n`,
    );
  record({ type: "module", target });
  const provider = getRawProvider("claude");
  provider.isInstalled = async () => true;
  provider.isAuthenticated = async () => true;
  provider.getAuthStatus = async () => ({
    installed: true,
    authenticated: true,
    enabled: true,
  });
  provider.getAvailableModels = async () => [
    { id: "test-model", name: "Test model" },
  ];
  provider.startSession = async (options) => {
    const id = options.resumeSessionId ?? options.newSessionId ?? randomUUID();
    const nativeCwd = realpathSync(options.cwd);
    const queue = new MessageQueue();
    const input = queue[Symbol.asyncIterator]();
    const child = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], {
      stdio: "ignore",
      env: { PATH: process.env.PATH },
    });
    let stopped = false;
    record({ type: "provider-started", id, providerPid: child.pid });
    const transcriptDir = join(
      process.env.CLAUDE_CONFIG_DIR,
      "projects",
      nativeCwd.replace(/[^a-zA-Z0-9]/g, "-"),
    );
    mkdirSync(transcriptDir, { recursive: true });
    const emit = (message) => {
      const full = {
        ...message,
        uuid: message.uuid ?? randomUUID(),
        session_id: id,
      };
      appendFileSync(
        join(transcriptDir, `${id}.jsonl`),
        `${JSON.stringify({ ...full, sessionId: id, cwd: nativeCwd, timestamp: new Date().toISOString() })}\n`,
      );
      record({ type: "event", id, message: full });
      return full;
    };
    async function waitForBarrier(name) {
      const deadline = Date.now() + 30_000;
      while (!stopped && !existsSync(join(root, name))) {
        if (Date.now() > deadline)
          throw new Error(`Provider barrier timed out: ${name}`);
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    }
    async function* events() {
      yield emit({
        type: "system",
        subtype: "init",
        model: "test-model",
        tools: ["Bash"],
      });
      for await (const message of input) {
        const text = JSON.stringify(message.message.content);
        if (text.includes("defer-confirmation")) {
          record({ type: "input-pulled-unconfirmed", id });
          await waitForBarrier("confirm-initial");
        }
        yield emit({ ...message, type: "user" });
        record({ type: "turn-started", id, text });
        if (text.includes("hold")) {
          await waitForBarrier("emit-detached");
          yield emit({
            type: "assistant",
            message: {
              role: "assistant",
              content: [{ type: "text", text: "unacknowledged suffix" }],
            },
          });
          const result = await options.onToolApproval(
            "Bash",
            { command: "echo approved" },
            {
              signal: new AbortController().signal,
              toolUseId: "test-approval",
            },
          );
          record({ type: "approval-resolved", id, result });
          if (result.behavior !== "allow")
            throw new Error("Original approval denied");
        }
        yield emit({
          type: "assistant",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "COMPLETED" }],
          },
        });
        yield emit({
          type: "result",
          subtype: "success",
          is_error: false,
          result: "COMPLETED",
          duration_ms: 1,
          duration_api_ms: 1,
          num_turns: 1,
          total_cost_usd: 0,
          usage: { input_tokens: 1, output_tokens: 1 },
        });
        record({ type: "turn-complete", id });
      }
    }
    if (options.initialMessage) queue.push(options.initialMessage);
    return {
      sessionId: id,
      queue,
      iterator: events(),
      pid: child.pid,
      isProcessAlive: () => !stopped,
      abort: async () => {
        stopped = true;
        await input.return();
        child.kill("SIGTERM");
        record({ type: "aborted", id });
      },
      publishAgentctlSessionId: () => {},
    };
  };
}
