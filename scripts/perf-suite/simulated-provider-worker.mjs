#!/usr/bin/env node

import { rmSync } from "node:fs";
import { createServer } from "node:net";
import {
  parseCreationRuntimeIdentity,
  sameCreationRuntimeIdentity,
} from "../../packages/server/src/sdk/providers/creation-runtime-record.mjs";
import { appendSimulatedTranscriptTurn } from "./simulated-transcript.mjs";

const socketPath = process.env.YEP_PROVIDER_WORKER_SOCKET;
const token = process.env.YEP_PROVIDER_WORKER_TOKEN;
const runtimeId = process.env.YEP_PROVIDER_WORKER_RUNTIME_ID;
if (!socketPath || !token || !runtimeId) {
  throw new Error("simulated provider worker is missing its runtime identity");
}

const streamChunks = parsePositiveInteger(
  process.env.YEP_PERF_SIM_STREAM_CHUNKS,
  24,
  "YEP_PERF_SIM_STREAM_CHUNKS",
);
const streamChunkBytes = parsePositiveInteger(
  process.env.YEP_PERF_SIM_STREAM_CHUNK_BYTES,
  1024,
  "YEP_PERF_SIM_STREAM_CHUNK_BYTES",
);
const streamDelayMs = parseNonnegativeInteger(
  process.env.YEP_PERF_SIM_STREAM_DELAY_MS,
  2,
  "YEP_PERF_SIM_STREAM_DELAY_MS",
);

// Negotiate before launch stdin: the host sends managed identities only after hello.
process.send?.({
  type: "launchHello",
  protocolVersion: 1,
  features: ["session-creation-owner-v1"],
});
let launchInput = "";
for await (const chunk of process.stdin) launchInput += chunk;
const launchRequest = JSON.parse(launchInput);
if (launchRequest.providerName !== "claude") {
  throw new Error("simulated provider worker only supports claude");
}

const creation =
  launchRequest.creation === undefined
    ? undefined
    : parseCreationRuntimeIdentity(launchRequest.creation);
const protocolVersion = creation ? 2 : 1;
const sessionId =
  launchRequest.options?.resumeSessionId ??
  launchRequest.options?.newSessionId ??
  `perf-sim-${runtimeId}`;
if (
  creation &&
  (creation.nativeNamespace.family !== "claude" ||
    creation.nativeSessionId !== sessionId ||
    launchRequest.options?.resumeSessionId)
)
  throw new Error("Simulated creation identity mismatch");
let initialInputConsumed = false;
const creationEvidence = () =>
  creation
    ? { identity: creation, nativeSessionId: sessionId, initialInputConsumed }
    : undefined;
const sockets = new Set();
const bufferedEvents = [];
let attachedSocket = null;
let sequence = 0;
let acknowledgedSequence = 0;
let turn = 0;
let parentUuid = null;
let queueDepth = 0;
let streaming = false;
let initialized = false;
let turnTail = Promise.resolve();

function parsePositiveInteger(raw, fallback, name) {
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}

function parseNonnegativeInteger(raw, fallback, name) {
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${name} must be a nonnegative integer`);
  }
  return value;
}

function write(socket, message) {
  if (!socket || socket.destroyed) return;
  socket.write(`${JSON.stringify(message)}\n`);
}

function providerActivity() {
  return {
    lastRawProviderEventAt: new Date().toISOString(),
    lastRawProviderEventSource: "perf-simulated-provider",
  };
}

function providerRetention() {
  return {
    retained: false,
    reasons: [],
    backgroundTaskCount: 0,
    sessionCronCount: 0,
    liveTaskCount: 0,
    lastUpdatedAt: new Date().toISOString(),
  };
}

function sendEvent(message) {
  const event = {
    type: "event",
    sequence: ++sequence,
    message,
    providerActivity: providerActivity(),
    providerRetention: providerRetention(),
  };
  bufferedEvents.push(event);
  write(attachedSocket, event);
}

function acknowledge(value) {
  if (!Number.isInteger(value) || value <= acknowledgedSequence) return;
  acknowledgedSequence = Math.min(value, sequence);
  while (
    bufferedEvents.length > 0 &&
    bufferedEvents[0].sequence <= acknowledgedSequence
  ) {
    bufferedEvents.shift();
  }
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function emitTurn(message) {
  if (creation && message?.uuid === creation.initialInputId) {
    initialInputConsumed = true;
    const evidence = { type: "creationEvidence", creation: creationEvidence() };
    process.send?.(evidence);
    write(attachedSocket, evidence);
  }
  streaming = true;
  queueDepth = 1;
  write(attachedSocket, { type: "queueDepth", depth: queueDepth });
  if (message?.uuid) {
    write(attachedSocket, {
      type: "queueRemoved",
      uuids: [message.uuid],
    });
  }

  const assistantId = `perf-assistant-${runtimeId}-${turn++}`;
  const chunkPrefix = `[${assistantId}] README.md `;
  const chunkText = `${chunkPrefix}${"x".repeat(
    Math.max(0, streamChunkBytes - Buffer.byteLength(chunkPrefix)),
  )}`;
  const content = Array.from({ length: streamChunks }, () => chunkText).join(
    "",
  );

  sendEvent({
    type: "stream_event",
    event: {
      type: "message_start",
      message: { id: assistantId, role: "assistant", content: [] },
    },
  });
  sendEvent({
    type: "stream_event",
    event: {
      type: "content_block_start",
      index: 0,
      content_block: { type: "thinking", thinking: "" },
    },
  });
  sendEvent({
    type: "stream_event",
    event: {
      type: "content_block_delta",
      index: 0,
      delta: {
        type: "thinking_delta",
        thinking: "Simulated private reasoning for the provider boundary.",
      },
    },
  });
  sendEvent({
    type: "stream_event",
    event: { type: "content_block_stop", index: 0 },
  });
  sendEvent({
    type: "stream_event",
    event: {
      type: "content_block_start",
      index: 1,
      content_block: { type: "text", text: "" },
    },
  });
  for (let index = 0; index < streamChunks; index += 1) {
    if (streamDelayMs > 0) await delay(streamDelayMs);
    sendEvent({
      type: "stream_event",
      event: {
        type: "content_block_delta",
        index: 1,
        delta: { type: "text_delta", text: chunkText },
      },
    });
  }
  sendEvent({
    type: "stream_event",
    event: { type: "content_block_stop", index: 1 },
  });
  sendEvent({ type: "stream_event", event: { type: "message_stop" } });
  const assistant = {
    type: "assistant",
    uuid: assistantId,
    session_id: sessionId,
    message: {
      role: "assistant",
      model: "perf-simulated-thinking-model",
      content: [
        {
          type: "thinking",
          thinking: "Simulated private reasoning for the provider boundary.",
        },
        { type: "text", text: content },
      ],
    },
  };
  const transcriptDirectory = process.env.YEP_PERF_TRANSCRIPT_DIR;
  if (!transcriptDirectory)
    throw new Error("simulated transcript directory is missing");
  await appendSimulatedTranscriptTurn({
    directory: transcriptDirectory,
    sessionId,
    cwd: launchRequest.options.cwd,
    userMessage: message,
    assistant,
    parentUuid,
  });
  parentUuid = assistantId;
  sendEvent(assistant);
  sendEvent({ type: "result", session_id: sessionId, subtype: "success" });
  streaming = false;
  queueDepth = 0;
  write(attachedSocket, { type: "queueDepth", depth: queueDepth });
}

async function call(method, args) {
  switch (method) {
    case "drainQueue":
      return [];
    case "probeLiveness":
      return {
        status: streaming ? "active" : "idle",
        source: "perf-simulated-provider",
        checkedAt: new Date().toISOString(),
      };
    case "supportedModels":
      return [
        {
          id: "perf-simulated-thinking-model",
          name: "Perf simulated thinking model",
        },
      ];
    case "publishAgentctlSessionId": {
      const publishedSessionId = args[0];
      if (typeof publishedSessionId !== "string" || !publishedSessionId) {
        throw new Error("publishAgentctlSessionId requires a session id");
      }
      if (creation) {
        if (publishedSessionId !== creation.sessionId)
          throw new Error("Simulated public identity mismatch");
        process.send?.({
          type: "creationEvidence",
          creation: creationEvidence(),
        });
      } else process.send?.({ type: "bound", sessionId: publishedSessionId });
      return undefined;
    }
    case "interrupt":
    case "setEffort":
    case "setMaxThinkingTokens":
    case "setModel":
      return undefined;
    default:
      return undefined;
  }
}

try {
  rmSync(socketPath);
} catch (error) {
  if (error?.code !== "ENOENT") throw error;
}

const server = createServer((socket) => {
  sockets.add(socket);
  socket.setEncoding("utf8");
  let attached = false;
  let buffer = "";
  socket.on("data", (chunk) => {
    buffer += chunk;
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const rawLine of lines) {
      if (!rawLine.trim()) continue;
      const request = JSON.parse(rawLine);
      if (!attached) {
        if (
          request.type !== "attach" ||
          request.token !== token ||
          request.protocolVersion !== protocolVersion ||
          (creation
            ? !sameCreationRuntimeIdentity(creation, request.creation)
            : request.creation !== undefined)
        ) {
          write(socket, { type: "error", error: "unauthorized attach" });
          socket.end();
          continue;
        }
        attached = true;
        attachedSocket = socket;
        write(socket, {
          type: "attached",
          protocolVersion,
          providerSessionId: sessionId,
          ...(creation ? { creation: creationEvidence() } : {}),
          runtimeId,
          acknowledgedSequence,
          queueDepth,
          providerAlive: true,
          providerActivity: providerActivity(),
          providerRetention: providerRetention(),
        });
        for (const event of bufferedEvents) write(socket, event);
        if (!initialized) {
          initialized = true;
          sendEvent({ type: "system", subtype: "init", session_id: sessionId });
        }
        continue;
      }

      if (request.type === "ack") {
        acknowledge(Number(request.sequence));
      } else if (request.type === "queuePush") {
        turnTail = turnTail.then(() => emitTurn(request.message));
        turnTail.catch((error) => {
          write(attachedSocket, { type: "failed", error: error.message });
        });
      } else if (request.type === "removeQueued") {
        queueDepth = 0;
        write(attachedSocket, { type: "queueDepth", depth: queueDepth });
      } else if (request.type === "rpc") {
        void call(String(request.method), request.args ?? []).then(
          (result) =>
            write(socket, {
              type: "rpcResult",
              id: request.id,
              ok: true,
              result,
            }),
          (error) =>
            write(socket, {
              type: "rpcResult",
              id: request.id,
              ok: false,
              error: error.message,
            }),
        );
      }
    }
  });
  socket.on("close", () => {
    sockets.delete(socket);
    if (attachedSocket === socket) attachedSocket = null;
  });
  socket.on("error", () => {});
});

function shutdown() {
  for (const socket of sockets) socket.destroy();
  server.close(() => process.exit(0));
}

process.on("message", (message) => {
  if (message?.type === "shutdown") shutdown();
});
process.on("disconnect", shutdown);
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

server.listen(socketPath, () => {
  process.send?.({
    type: "ready",
    metadata: {
      sessionId,
      ...(creation ? { creation: creationEvidence() } : {}),
      queueDepth,
      providerActivity: providerActivity(),
      providerRetention: providerRetention(),
      capabilities: {
        probeLiveness: true,
        getProviderActivity: true,
        getProviderRetention: true,
        publishAgentctlSessionId: true,
        supportedModels: true,
      },
    },
  });
});
