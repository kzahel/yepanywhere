// Scripted provider, real owner/socket/HTTP adapters. Never exposes its lease.
import { request as httpRequest } from "node:http";
import { MessageQueue } from "../../../../src/sdk/messageQueue.js";
import { startAgentSelfSession } from "../../../../src/sdk/providers/agent-self.js";
import { ProviderSessionOwner } from "../../../../src/sdk/providers/provider-session-owner.js";
import { ProviderRuntimeSocketAdapter } from "../../../../src/sdk/providers/provider-runtime-socket-adapter.js";
import type { StartSessionOptions } from "../../../../src/sdk/providers/types.js";
import type { SDKMessage } from "../../../../src/sdk/types.js";

let input = "";
for await (const chunk of process.stdin) input += chunk;
const request = JSON.parse(input) as { options: StartSessionOptions };
const owner = new ProviderSessionOwner({
  runtimeId: process.env.YEP_PROVIDER_WORKER_RUNTIME_ID!,
  peerGrantId: request.options.agentApi?.peerGrantId,
  emitSupervisor: (message) => {
    if (process.connected) process.send?.(message, () => {});
  },
  onTerminal: async () => {
    await adapter.close();
    process.exit(0);
  },
});
const adapter = new ProviderRuntimeSocketAdapter(
  process.env.YEP_PROVIDER_WORKER_SOCKET!,
  process.env.YEP_PROVIDER_WORKER_TOKEN!,
  owner,
);
const stop = () => {
  void owner
    .shutdown("fixture terminated")
    .then(() => adapter.close())
    .finally(() => process.exit(0));
};
process.on("message", (message: unknown) => {
  owner.handleSupervisorMessage(message);
  if (
    message &&
    typeof message === "object" &&
    "type" in message &&
    message.type === "shutdown"
  )
    stop();
});
process.on("SIGTERM", stop);
process.on("disconnect", stop);
const metadata = await owner.start(async (hooks) => ({
  session: await startAgentSelfSession(
    "claude",
    { ...request.options, onAgentApiRead: hooks.onAgentApiRead },
    async (options) => {
      const queue = new MessageQueue();
      const incoming = queue[Symbol.asyncIterator]();
      const env = options.agentApiEnvironment!;
      const iterator = (async function* (): AsyncGenerator<SDKMessage> {
        yield { type: "system", subtype: "init", session_id: "api-fixture" };
        for await (const message of incoming) {
          const text = String(message.message.content);
          const command = text.startsWith("{")
            ? (JSON.parse(text) as { path: string; body?: unknown })
            : { path: text };
          const { path, body: requestBody } = command;
          const result = await new Promise<{ status: number; body: string }>(
            (resolve) => {
              const req = httpRequest(
                new URL(path, env.AGENT_YA_V0_URL),
                {
                  socketPath: env.AGENT_YA_V0_SOCKET,
                  method: requestBody === undefined ? "GET" : "POST",
                  headers: {
                    Authorization: env.AGENT_YA_V0_AUTHORIZATION,
                    "Content-Type": "application/json",
                  },
                },
                (response) => {
                  let body = "";
                  response.on("data", (chunk) => {
                    body += chunk;
                  });
                  response.on("end", () =>
                    resolve({ status: response.statusCode!, body }),
                  );
                },
              );
              req.on("error", () =>
                resolve({ status: 0, body: "unavailable" }),
              );
              req.end(
                requestBody === undefined
                  ? undefined
                  : JSON.stringify(requestBody),
              );
            },
          );
          yield { type: "system", subtype: "status", apiResult: result };
        }
      })();
      return {
        queue,
        iterator,
        abort: async () => {
          await incoming.return();
        },
      };
    },
  ),
}));
await adapter.listen();
owner.begin();
process.send?.({ type: "ready", metadata, providerPid: owner.providerPid() });
