// Controlled provider; real worker process, owner, queue and socket protocol.
import { ProviderSessionOwner } from "../../../../src/sdk/providers/provider-session-owner.js";
import { ProviderRuntimeSocketAdapter } from "../../../../src/sdk/providers/provider-runtime-socket-adapter.js";
import { createAgentctlSessionEnvBridge } from "../../../../src/sdk/providers/agentctl-session-env.js";
import { MessageQueue } from "../../../../src/sdk/messageQueue.js";
import type { SDKMessage } from "../../../../src/sdk/types.js";

process.send?.({
  type: "launchHello",
  protocolVersion: 1,
  features: ["session-native-binding-v1"],
});
let input = "";
for await (const chunk of process.stdin) input += chunk;
const request = JSON.parse(input);
if (request.options.model === "hold-ready") {
  await new Promise<void>((resolve) => {
    const ready = (message: unknown) => {
      if ((message as { type?: string })?.type !== "fixtureReady") return;
      process.off("message", ready);
      resolve();
    };
    process.on("message", ready);
    process.send?.({ type: "fixtureHoldingReady" });
  });
}
const owner = new ProviderSessionOwner({
  runtimeId: process.env.YEP_PROVIDER_WORKER_RUNTIME_ID!,
  emitSupervisor: (message) => process.send?.(message),
  onTerminal: () => stop(),
});
const adapter = new ProviderRuntimeSocketAdapter(
  process.env.YEP_PROVIDER_WORKER_SOCKET!,
  process.env.YEP_PROVIDER_WORKER_TOKEN!,
  owner,
);
owner.setBoundIdentity(request.binding);
const queue = new MessageQueue();
const incoming = queue.generator();
const bridge = createAgentctlSessionEnvBridge(request.binding.sessionId);
async function stop() {
  await owner.shutdown("fixture closed");
  await adapter.close();
  process.exit(0);
}
process.on("message", (message: unknown) => {
  owner.handleSupervisorMessage(message);
  if ((message as { type?: string })?.type === "shutdown") void stop();
});
process.on("disconnect", () => void stop());
process.on("SIGTERM", () => void stop());
const nativeId = request.binding.native.id;
const metadata = await owner.start(async () => ({
  agentctlSessionEnvBridge: bridge,
  session: {
    queue,
    sessionId: nativeId,
    abort: async () => {
      await incoming.return();
    },
    iterator: (async function* (): AsyncGenerator<SDKMessage> {
      yield { type: "system", subtype: "init", session_id: nativeId };
      for await (const message of incoming) {
        yield {
          type: "assistant",
          session_id:
            String(message.message.content) === "wrong-native"
              ? "foreign"
              : nativeId,
          message: {
            role: "assistant",
            content: String(message.message.content),
          },
        };
        yield { type: "result", subtype: "success", session_id: nativeId };
      }
    })(),
  },
}));
await adapter.listen();
owner.begin();
process.send?.({ type: "ready", metadata });
