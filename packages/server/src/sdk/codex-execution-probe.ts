import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { CliCandidate } from "../services/CliInstallationService.js";
import { CodexAppServerClient } from "./providers/codex-app-server-client.js";
import { scriptedResponse } from "./scripted-responses.js";

async function removeProbeDirectory(root: string): Promise<void> {
  // Bun 1.3.14 ignores recursive rm retry options even while Windows is
  // releasing handles from a process that has just exited.
  for (let attempt = 0; ; attempt++) {
    try {
      await rm(root, { recursive: true, force: true });
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (
        attempt === 5 ||
        !code ||
        !["EBUSY", "EPERM", "ENOTEMPTY", "EMFILE", "ENFILE"].includes(code)
      ) {
        throw error;
      }
      await delay(100 * (attempt + 1));
    }
  }
}

/** Real app-server, code-mode host and shell; only model responses are scripted. */
export async function probeCodexExecution(
  candidate: CliCandidate,
  signal: AbortSignal,
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "ya-cli-probe-"));
  const home = join(root, "home");
  const workspace = join(root, "workspace");
  const marker = `YA_CLI_${randomUUID().replaceAll("-", "")}`;
  const key = "ya-local-execution-probe-only";
  let toolOutputVerified = false;
  let toolFailure: string | undefined;
  let requests = 0;
  let modelFailure: Error | undefined;
  let client: CodexAppServerClient | undefined;
  const server = createServer(async (request, response) => {
    try {
      if (
        request.method !== "POST" ||
        request.url !== "/v1/responses" ||
        request.headers.authorization !== `Bearer ${key}`
      ) {
        response.writeHead(403).end();
        return;
      }
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of request) {
        size += chunk.length;
        if (size > 2 * 1024 * 1024)
          throw new Error("Oversized probe model request");
        chunks.push(chunk);
      }
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      const outputs = Array.isArray(body.input)
        ? body.input.filter(
            (item: { type?: string }) =>
              item.type === "custom_tool_call_output" ||
              item.type === "function_call_output",
          )
        : [];
      toolOutputVerified ||= outputs.some((item: { output?: unknown }) => {
        const output =
          typeof item.output === "string"
            ? item.output
            : JSON.stringify(item.output);
        return output?.includes(marker) && /exitCode\\?":\s*0/.test(output);
      });
      if (outputs.length && !toolOutputVerified)
        toolFailure = outputs
          .map((item: { output?: unknown }) =>
            typeof item.output === "string"
              ? item.output
              : JSON.stringify(item.output),
          )
          .join("\n")
          .slice(0, 2048);
      if (++requests > 3)
        throw new Error("Probe did not produce successful command output");
      // Code-mode tools may be described in model context rather than `tools`.
      // The reproduced 0.160+ package requires the real code-mode host path.
      const version = candidate.version?.match(/(\d+)\.(\d+)\./);
      const codeMode =
        !version || Number(version[1]) > 0 || Number(version[2]) >= 160;
      const command = `echo ${marker}`;
      const output =
        requests === 1
          ? [
              codeMode
                ? {
                    type: "custom_tool_call",
                    id: "fc_probe",
                    call_id: "call_probe",
                    name: "exec",
                    input: `let r=await tools.exec_command({cmd:${JSON.stringify(command)},workdir:${JSON.stringify(workspace)},yield_time_ms:1000,max_output_tokens:100});let output=r.output??"";while(r.session_id){r=await tools.write_stdin({session_id:r.session_id,chars:"",yield_time_ms:1000,max_output_tokens:100});output+=r.output??"";}text(JSON.stringify({exitCode:r.exit_code,output}));`,
                  }
                : {
                    type: "function_call",
                    id: "fc_probe",
                    call_id: "call_probe",
                    name: "exec_command",
                    arguments: JSON.stringify({
                      cmd: command,
                      workdir: workspace,
                      max_output_tokens: 100,
                      yield_time_ms: 10_000,
                    }),
                    status: "completed",
                  },
            ]
          : [];
      // Older non-code-mode releases report exit status in their native tool body.
      if (!codeMode && requests > 1)
        toolOutputVerified ||= outputs.some((item: { output?: unknown }) => {
          const output = JSON.stringify(item.output);
          return (
            output.includes(marker) &&
            /(?:exit_code\\?":\s*0|exited with code 0|Exit code: 0)/i.test(
              output,
            )
          );
        });
      response.writeHead(200, { "Content-Type": "text/event-stream" });
      const event = (type: string, fields: Record<string, unknown>) =>
        response.write(
          `event: ${type}\ndata: ${JSON.stringify({ type, ...fields })}\n\n`,
        );
      event("response.created", {
        response: scriptedResponse("probe", "gpt-6.1-sol", "in_progress", []),
      });
      for (const item of output)
        event("response.output_item.done", { output_index: 0, item });
      event("response.completed", {
        response: scriptedResponse("probe", "gpt-6.1-sol", "completed", output),
      });
      response.end();
    } catch (error) {
      modelFailure = error instanceof Error ? error : new Error(String(error));
      response.writeHead(500).end();
      void client?.close().catch(() => {});
    }
  });
  server.on("connect", (_request, socket) =>
    socket.end("HTTP/1.1 403 Forbidden\r\n\r\n"),
  );
  const abort = () => {
    void client?.close().catch(() => {});
  };
  signal.addEventListener("abort", abort, { once: true });
  try {
    signal.throwIfAborted();
    await Promise.all([mkdir(home), mkdir(workspace)]);
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("Probe endpoint unavailable");
    const url = `http://127.0.0.1:${address.port}`;
    const codexHome = join(home, ".codex");
    await mkdir(codexHome);
    await writeFile(
      join(codexHome, "config.toml"),
      `model_provider = "ya_probe"\nmodel = "gpt-6.1-sol"\n[model_providers.ya_probe]\nname = "YA local execution check"\nbase_url = "${url}/v1"\nwire_api = "responses"\nenv_key = "OPENAI_API_KEY"\nsupports_websockets = false\n[analytics]\nenabled = false\n`,
    );
    // Allow only process/shell necessities; never inherit credentials, profiles or agents.
    const env: NodeJS.ProcessEnv = {};
    for (const name of [
      "PATH",
      "Path",
      "SystemRoot",
      "SYSTEMROOT",
      "WINDIR",
      "COMSPEC",
      "PATHEXT",
      "SHELL",
      "LANG",
      "LC_ALL",
    ])
      if (process.env[name]) env[name] = process.env[name];
    Object.assign(env, {
      HOME: home,
      USERPROFILE: home,
      CODEX_HOME: codexHome,
      XDG_CONFIG_HOME: home,
      XDG_DATA_HOME: home,
      XDG_CACHE_HOME: home,
      APPDATA: home,
      LOCALAPPDATA: home,
      TMPDIR: root,
      TEMP: root,
      TMP: root,
      OPENAI_API_KEY: key,
      HTTP_PROXY: url,
      HTTPS_PROXY: url,
      ALL_PROXY: url,
      http_proxy: url,
      https_proxy: url,
      all_proxy: url,
      NO_PROXY: "127.0.0.1,localhost",
      no_proxy: "127.0.0.1,localhost",
    });
    client = new CodexAppServerClient(
      candidate.launch.command,
      workspace,
      env,
      undefined,
      undefined,
      candidate.launch.args,
    );
    signal.throwIfAborted();
    await client.connect();
    await client.request("initialize", {
      clientInfo: { name: "ya_execution_probe", version: "1" },
      capabilities: { experimentalApi: true },
    });
    client.notify("initialized");
    client.setServerRequestHandler(async () => {
      throw new Error("Unexpected approval in isolated execution probe");
    });
    const result = await client.request<{ thread: { id: string } }>(
      "thread/start",
      {
        cwd: workspace,
        model: "gpt-6.1-sol",
        modelProvider: "ya_probe",
        sandbox: "danger-full-access",
        approvalPolicy: "never",
        ephemeral: true,
      },
    );
    await client.request("turn/start", {
      threadId: result.thread.id,
      input: [
        {
          type: "text",
          text: "Run the supplied harmless installation check.",
          text_elements: [],
        },
      ],
    });
    for (;;) {
      const notification = await client.nextNotification(signal);
      if (modelFailure) throw modelFailure;
      if (notification.method === "turn/completed") {
        const params = notification.params as {
          turn?: { status?: string; error?: { message?: string } };
        };
        if (params.turn?.status !== "completed" || !toolOutputVerified)
          throw new Error(
            params.turn?.error?.message ??
              toolFailure ??
              "Shell command did not return the verification marker and successful exit",
          );
        break;
      }
    }
  } finally {
    signal.removeEventListener("abort", abort);
    try {
      await client?.close();
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await removeProbeDirectory(root);
    }
  }
}
