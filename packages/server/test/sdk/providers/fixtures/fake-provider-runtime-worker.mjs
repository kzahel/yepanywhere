import { rmSync } from "node:fs";
import { createServer } from "node:net";

const socketPath = process.env.YEP_PROVIDER_WORKER_SOCKET;
if (!socketPath) throw new Error("missing worker socket");

let launchInput = "";
for await (const chunk of process.stdin) launchInput += chunk;
const launchRequest = JSON.parse(launchInput);

try {
  rmSync(socketPath);
} catch (error) {
  if (error?.code !== "ENOENT") throw error;
}

const sockets = new Set();
let attachedCount = 0;
let acknowledgedSequence = 0;
let activeSubmissionId;
const server = createServer((socket) => {
  sockets.add(socket);
  socket.setEncoding("utf8");
  let buffer = "";
  socket.on("data", (chunk) => {
    buffer += chunk;
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const rawLine of lines) {
      const request = JSON.parse(rawLine);
      if (request.type === "attach") {
        attachedCount += 1;
        socket.write(
          `${JSON.stringify({
            type: "attached",
            protocolVersion: 1,
            acknowledgedSequence,
            queueDepth: 0,
            providerAlive: true,
          })}\n`,
        );
        const sequence = attachedCount;
        socket.write(
          `${JSON.stringify({
            type: "event",
            sequence,
            message: {
              type: "system",
              subtype: "init",
              session_id:
                launchRequest.options.newSessionId ??
                `fake-session-${sequence}`,
            },
          })}\n`,
        );
        socket.write(
          `${JSON.stringify({
            type: "approval",
            requestId: "fake-pending-approval",
            toolName: "FakeTool",
            input: { attachment: attachedCount },
          })}\n`,
        );
      } else if (request.type === "ack") {
        acknowledgedSequence = Math.max(acknowledgedSequence, request.sequence);
      } else if (request.type === "rpc") {
        if (
          launchRequest.providerName === "pi" &&
          request.method === "probeLiveness"
        ) {
          socket.write(
            `${JSON.stringify({ type: "approvalCancelled", requestId: "fake-pending-approval" })}\n`,
          );
        }
        if (
          request.method === "publishAgentctlSessionId" &&
          request.args?.[1]?.YEP_BROWSER_DEBUG_CALLER_TOKEN
        ) {
          socket.write(
            `${JSON.stringify({
              type: "event",
              sequence: attachedCount + 1,
              message: {
                type: "system",
                subtype: "status",
                status: "browser-debug-environment-published",
                browserDebugEnvironment: request.args[1],
              },
            })}\n`,
          );
        }
        socket.write(
          `${JSON.stringify({
            type: "rpcResult",
            id: request.id,
            ok: true,
            result:
              request.method === "probeLiveness"
                ? { status: "alive" }
                : undefined,
          })}\n`,
        );
      } else if (request.type === "approvalResult") {
        // The integration test observes callback dispatch in the Hono proxy;
        // the fake worker only needs to accept its answer.
      }
    }
  });
  socket.on("close", () => sockets.delete(socket));
});

function shutdown() {
  for (const socket of sockets) socket.destroy();
  server.close(() => process.exit(0));
}

process.on("message", (message) => {
  if (message?.type === "sessionTurn") {
    if (activeSubmissionId) {
      process.send?.({
        type: "sessionTurnRejected",
        submissionId: message.submissionId,
        outcome: "busy",
        error: "fake provider is busy",
      });
      return;
    }
    activeSubmissionId = message.submissionId;
    process.send?.({
      type: "sessionTurnAccepted",
      submissionId: message.submissionId,
      sessionOptionsResult: Object.fromEntries(
        Object.entries(message.sessionOptions ?? {}).map(([key, requested]) => [
          key,
          {
            requested,
            status: "applied",
            detail: "fake provider applied the requested option",
          },
        ]),
      ),
    });
    process.send?.({
      type: "sessionTurnStarted",
      submissionId: message.submissionId,
    });
    const events = [
      {
        type: "user",
        uuid: `fake-${message.submissionId}`,
        message: { role: "user", content: message.message.text },
      },
      {
        type: "assistant",
        message: { role: "assistant", content: "fake response" },
      },
      { type: "result", subtype: "success" },
    ];
    events.forEach((event, index) => {
      process.send?.({
        type: "sessionTurnEvent",
        submissionId: message.submissionId,
        sequence: index + 1,
        message: event,
      });
    });
    process.send?.({
      type: "sessionTurnTerminal",
      submissionId: message.submissionId,
      outcome: "completed",
      providerSessionId: launchRequest.options.resumeSessionId,
      lastProviderEventSequence: events.length,
    });
    activeSubmissionId = undefined;
  }
  if (
    message?.type === "interruptSessionTurn" &&
    message.submissionId === activeSubmissionId
  ) {
    process.send?.({
      type: "sessionTurnTerminal",
      submissionId: message.submissionId,
      outcome: "interrupted",
    });
    activeSubmissionId = undefined;
  }
  if (message?.type === "shutdown") shutdown();
});
process.on("disconnect", shutdown);
process.on("SIGTERM", shutdown);

server.listen(socketPath, () => {
  process.send?.({
    type: "ready",
    metadata: {
      sessionId: launchRequest.options.resumeSessionId,
      queueDepth: 0,
      capabilities: { probeLiveness: true },
      agentLaunchEnvironment: {
        harness: process.env.AGENT_LAUNCH_HARNESS,
        model: process.env.AGENT_LAUNCH_MODEL,
        effort: process.env.AGENT_LAUNCH_EFFORT,
        browserDebugUrl: process.env.YEP_BROWSER_DEBUG_AGENT_URL,
        browserDebugCallerToken: process.env.YEP_BROWSER_DEBUG_CALLER_TOKEN,
      },
      remoteAgentLaunchEnvironment: launchRequest.options.remoteEnv,
    },
  });
});
