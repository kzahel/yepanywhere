import { spawn, execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { CodexProvider } from "../src/sdk/providers/codex.js";
import {
  COMPUTER_TOOLS,
  type ComputerSession,
} from "../src/computer-control/contract.js";

// No provider authentication, native resident or model turn. Probe the real
// pinned app-server validator with YA's actual thread/start serialization.
if (!process.argv[2]) throw new Error("Pass the pinned Codex executable path");
const executable = path.resolve(process.argv[2]);
const root = await mkdtemp(path.join(tmpdir(), "ya-computer-codex-probe-"));
const env = {
  ...process.env,
  CODEX_HOME: root,
  CODEX_SESSIONS_DIR: path.join(root, "sessions"),
};
delete env.OPENAI_API_KEY;
delete env.CODEX_API_KEY;
delete env.DESKTOP_AUTH_TOKEN;
const version = execFileSync(executable, ["--version"], {
  env,
  encoding: "utf8",
  windowsHide: true,
  stdio: ["ignore", "pipe", "ignore"],
}).trim();
if (version !== "codex-cli 0.154.0")
  throw new Error(`Expected pinned CLI, got ${version}`);
const child = spawn(executable, ["app-server", "--listen", "stdio://"], {
  cwd: root,
  env,
  windowsHide: true,
  stdio: ["pipe", "pipe", "pipe"],
});
let diagnostic = "";
child.stderr.on("data", (data) => {
  diagnostic = (diagnostic + data).slice(-4096);
});
const lines = createInterface({ input: child.stdout });
let sequence = 0;
const pending = new Map<number, (message: Record<string, unknown>) => void>();
lines.on("line", (line) => {
  const message = JSON.parse(line) as Record<string, unknown>;
  if (typeof message.id === "number") pending.get(message.id)?.(message);
});
const request = (method: string, params: unknown) =>
  new Promise<Record<string, unknown>>((resolve, reject) => {
    const id = ++sequence;
    const timeout = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`Probe timed out: ${method}; ${diagnostic}`));
    }, 20_000);
    pending.set(id, (message) => {
      clearTimeout(timeout);
      pending.delete(id);
      resolve(message);
    });
    child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
  });
try {
  const initialized = await request("initialize", {
    clientInfo: { name: "ya_computer_contract_probe", version: "1" },
    capabilities: { experimentalApi: true },
  });
  if (initialized.error) throw new Error(JSON.stringify(initialized.error));
  child.stdin.write(`${JSON.stringify({ method: "initialized" })}\n`);
  const provider = new CodexProvider() as unknown as {
    createThreadStartParams(
      options: object,
      policy: object,
    ): Record<string, unknown>;
  };
  const computerControl: ComputerSession = {
    tools: COMPUTER_TOOLS,
    call: async () => {
      throw new Error("Probe cannot dispatch tools");
    },
    acceptsThread: () => false,
    close: async () => {},
    rename: () => {},
  };
  const params = {
    ...provider.createThreadStartParams(
      { cwd: root, computerControl, model: "gpt-6-astra" },
      { approvalPolicy: "never", sandbox: "danger-full-access" },
    ),
    ephemeral: true,
  };
  const original = await request("thread/start", {
    ...params,
    dynamicTools: COMPUTER_TOOLS,
  });
  const fixed = await request("thread/start", params);
  console.log(
    JSON.stringify({
      version,
      originalError: original.error,
      candidateError: fixed.error,
      candidateThreadStarted: Boolean(
        (fixed.result as { thread?: { id?: string } } | undefined)?.thread?.id,
      ),
      modelTurnStarted: false,
    }),
  );
  if (
    (original.error as { code?: number } | undefined)?.code !== -32600 ||
    fixed.error ||
    !(fixed.result as { thread?: { id?: string } } | undefined)?.thread?.id
  )
    process.exitCode = 1;
} finally {
  lines.close();
  child.stdin.end();
  const exited = new Promise<void>((resolve) =>
    child.once("exit", () => resolve()),
  );
  if (child.exitCode === null) child.kill();
  await Promise.race([
    exited,
    new Promise((resolve) => setTimeout(resolve, 2000)),
  ]);
  await rm(root, {
    recursive: true,
    force: true,
    maxRetries: 5,
    retryDelay: 100,
  });
}
