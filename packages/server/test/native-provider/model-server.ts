import { createServer, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { connect } from "node:net";

/** Script the model wire; the real executable still owns scheduling and tools. */
export type ModelWire = "anthropic" | "responses" | "chat" | "gemini";
export type ModelRequest = Record<string, unknown>;
export const syntheticKey = "owned-model-stub-only";

export class Exchange {
  readonly id = `owned_${randomUUID().replaceAll("-", "")}`;
  readonly cancelled: Promise<void>;
  private finished = false;
  private started = false;
  private textStarted = false;
  private text = "";
  private sequence = 0;

  constructor(
    readonly body: ModelRequest,
    private response: ServerResponse,
    readonly wire: ModelWire,
    readonly model = String(body.model ?? "owned-model"),
  ) {
    this.cancelled = new Promise((resolve) => {
      response.on("close", () => {
        if (!this.finished) resolve();
      });
    });
  }

  private responseInfo(status: string, output: unknown[]) {
    return {
      id: this.id,
      object: "response",
      created_at: 1,
      status,
      error: null,
      incomplete_details: null,
      instructions: null,
      metadata: {},
      model: this.model,
      output,
      parallel_tool_calls: true,
      previous_response_id: null,
      store: false,
      temperature: 1,
      text: { format: { type: "text" } },
      tool_choice: "auto",
      tools: [],
      top_p: 1,
      truncation: "disabled",
      usage: {
        input_tokens: 100,
        output_tokens: 5,
        total_tokens: 105,
        input_tokens_details: { cached_tokens: 0 },
        output_tokens_details: { reasoning_tokens: 0 },
      },
    };
  }

  private event(type: string, fields: Record<string, unknown>) {
    this.response.write(
      `event: ${type}\ndata: ${JSON.stringify({ type, sequence_number: this.sequence++, ...fields })}\n\n`,
    );
  }

  private start() {
    if (this.started) return;
    this.started = true;
    this.response.writeHead(200, { "Content-Type": "text/event-stream" });
    if (this.wire === "anthropic")
      this.event("message_start", {
        message: {
          id: this.id,
          type: "message",
          role: "assistant",
          model: this.model,
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 100, output_tokens: 0 },
        },
      });
    else if (this.wire === "responses")
      this.event("response.created", {
        response: this.responseInfo("in_progress", []),
      });
  }

  private chat(delta: unknown, finishReason: string | null) {
    this.response.write(
      `data: ${JSON.stringify({
        id: this.id,
        object: "chat.completion.chunk",
        created: 1,
        model: this.model,
        choices: [{ index: 0, delta, finish_reason: finishReason }],
      })}\n\n`,
    );
  }

  private gemini(parts: unknown[], final: boolean) {
    this.response.write(
      `data: ${JSON.stringify({
        candidates: [
          {
            content: { role: "model", parts },
            ...(final ? { finishReason: "STOP" } : {}),
            index: 0,
          },
        ],
        ...(final
          ? {
              usageMetadata: {
                promptTokenCount: 100,
                candidatesTokenCount: 5,
                totalTokenCount: 105,
              },
            }
          : {}),
        modelVersion: this.model,
      })}\n\n`,
    );
  }

  partial(text: string) {
    this.start();
    const itemId = `msg_${this.id}`;
    if (!this.textStarted) {
      if (this.wire === "anthropic")
        this.event("content_block_start", {
          index: 0,
          content_block: { type: "text", text: "" },
        });
      else if (this.wire === "responses") {
        this.event("response.output_item.added", {
          output_index: 0,
          item: {
            type: "message",
            id: itemId,
            role: "assistant",
            content: [],
            status: "in_progress",
          },
        });
        this.event("response.content_part.added", {
          output_index: 0,
          item_id: itemId,
          content_index: 0,
          part: { type: "output_text", text: "", annotations: [] },
        });
      }
      this.textStarted = true;
    }
    this.text += text;
    if (this.wire === "anthropic")
      this.event("content_block_delta", {
        index: 0,
        delta: { type: "text_delta", text },
      });
    else if (this.wire === "responses")
      this.event("response.output_text.delta", {
        output_index: 0,
        item_id: itemId,
        content_index: 0,
        delta: text,
        logprobs: [],
      });
    else if (this.wire === "chat")
      this.chat({ role: "assistant", content: text }, null);
    else this.gemini([{ text }], false);
  }

  finish(text: string) {
    if (this.wire === "anthropic" && this.body.stream !== true) {
      this.response.setHeader("Content-Type", "application/json");
      this.response.end(
        JSON.stringify({
          id: this.id,
          type: "message",
          role: "assistant",
          model: this.model,
          content: [{ type: "text", text }],
          stop_reason: "end_turn",
          stop_sequence: null,
          usage: { input_tokens: 100, output_tokens: 5 },
        }),
      );
      this.finished = true;
      return;
    }
    // Readiness/effort probes can request a non-streamed Chat Completion.
    if (this.wire === "chat" && this.body.stream !== true) {
      this.response.setHeader("Content-Type", "application/json");
      this.response.end(
        JSON.stringify({
          id: this.id,
          object: "chat.completion",
          created: 1,
          model: this.model,
          choices: [
            {
              index: 0,
              message: { role: "assistant", content: text },
              finish_reason: "stop",
            },
          ],
          usage: {
            prompt_tokens: 100,
            completion_tokens: 5,
            total_tokens: 105,
          },
        }),
      );
      this.finished = true;
      return;
    }
    this.partial(text);
    const part = {
      type: "output_text",
      text: this.text,
      annotations: [],
      logprobs: [],
    };
    const item = {
      type: "message",
      id: `msg_${this.id}`,
      role: "assistant",
      status: "completed",
      content: [part],
    };
    if (this.wire === "anthropic") {
      this.event("content_block_stop", { index: 0 });
      this.event("message_delta", {
        delta: { stop_reason: "end_turn", stop_sequence: null },
        usage: { output_tokens: 5 },
      });
      this.event("message_stop", {});
    } else if (this.wire === "responses") {
      this.event("response.output_text.done", {
        output_index: 0,
        item_id: item.id,
        content_index: 0,
        text: this.text,
        logprobs: [],
      });
      this.event("response.content_part.done", {
        output_index: 0,
        item_id: item.id,
        content_index: 0,
        part,
      });
      this.event("response.output_item.done", { output_index: 0, item });
      this.event("response.completed", {
        response: this.responseInfo("completed", [item]),
      });
    } else if (this.wire === "chat") {
      this.chat({}, "stop");
      this.response.write("data: [DONE]\n\n");
    } else this.gemini([], true);
    this.end();
  }

  tool(
    name: string,
    args: Record<string, unknown> | string,
    namespace?: string,
  ) {
    this.start();
    if (this.wire === "anthropic") {
      this.event("content_block_start", {
        index: 0,
        content_block: {
          type: "tool_use",
          id: `call_${this.id}`,
          name,
          input: {},
        },
      });
      this.event("content_block_delta", {
        index: 0,
        delta: { type: "input_json_delta", partial_json: JSON.stringify(args) },
      });
      this.event("content_block_stop", { index: 0 });
      this.event("message_delta", {
        delta: { stop_reason: "tool_use", stop_sequence: null },
        usage: { output_tokens: 5 },
      });
      this.event("message_stop", {});
    } else if (this.wire === "responses") {
      const item =
        typeof args === "string"
          ? {
              type: "custom_tool_call",
              id: `fc_${this.id}`,
              call_id: `call_${this.id}`,
              name,
              input: args,
            }
          : {
              type: "function_call",
              id: `fc_${this.id}`,
              call_id: `call_${this.id}`,
              name,
              arguments: JSON.stringify(args),
              ...(namespace ? { namespace } : {}),
              status: "completed",
            };
      this.event("response.output_item.done", { output_index: 0, item });
      this.event("response.completed", {
        response: this.responseInfo("completed", [item]),
      });
    } else if (this.wire === "chat") {
      this.chat(
        {
          role: "assistant",
          tool_calls: [
            {
              index: 0,
              id: `call_${this.id}`,
              type: "function",
              function: { name, arguments: JSON.stringify(args) },
            },
          ],
        },
        null,
      );
      this.chat({}, "tool_calls");
      this.response.write("data: [DONE]\n\n");
    } else this.gemini([{ functionCall: { name, args } }], true);
    this.end();
  }

  fail(status: number, message: string, headers: Record<string, string> = {}) {
    if (this.started)
      throw Error("Cannot replace a started stream with an HTTP error");
    this.finished = true;
    this.response.writeHead(status, {
      "Content-Type": "application/json",
      ...headers,
    });
    this.response.end(
      JSON.stringify({
        error: { type: "invalid_request_error", code: "owned_error", message },
      }),
    );
  }

  private end() {
    this.finished = true;
    this.response.end();
  }
  close() {
    this.response.destroy();
  }
}

interface ModelServerOptions {
  catalogModel?: string;
  authOptional?: boolean;
  syntheticKeys?: string[];
  blockedHosts?: string[];
  /** Known native helper requests are recorded separately, never silently discarded. */
  auxiliary?: (body: ModelRequest, path: string) => string | undefined;
}

export async function modelServer(
  wire: ModelWire,
  options: ModelServerOptions = {},
) {
  const requests: Exchange[] = [],
    auxiliaryRequests: Array<{ kind: string; body: ModelRequest }> = [];
  const waiting: Array<{
    resolve: (exchange: Exchange) => void;
    reject: (error: Error) => void;
  }> = [];
  const buffered: Exchange[] = [],
    failures: string[] = [],
    blockedConnections: string[] = [];
  const tunnels = new Set<import("node:stream").Duplex>();
  let closed = false;
  function fail(message: string) {
    failures.push(message);
    for (const waiter of waiting.splice(0)) waiter.reject(Error(message));
  }
  const server = createServer((req, res) => {
    void receive().catch(() => {
      if (!closed) fail("Native model request stream failed");
      res.destroy();
    });
    async function receive() {
      const parsed = new URL(req.url ?? "/", "http://localhost");
      const path = parsed.pathname;
      const listening = server.address();
      if (
        /^https?:/.test(req.url ?? "") &&
        (!listening ||
          typeof listening === "string" ||
          parsed.hostname !== "127.0.0.1" ||
          parsed.port !== String(listening.port))
      ) {
        fail("Native HTTP proxy attempted an external model endpoint");
        res.writeHead(403);
        res.end();
        return;
      }
      if (
        req.method === "GET" &&
        path === "/v1/models" &&
        options.catalogModel
      ) {
        auxiliaryRequests.push({ kind: "catalog", body: {} });
        res.setHeader("Content-Type", "application/json");
        res.end(
          JSON.stringify({
            object: "list",
            data: [{ id: options.catalogModel, object: "model" }],
          }),
        );
        return;
      }
      let content = "";
      for await (const chunk of req) {
        content += chunk;
        if (content.length > 4_000_000) {
          fail("Oversized model request");
          res.destroy();
          return;
        }
      }
      let body: ModelRequest;
      try {
        body = content ? (JSON.parse(content) as ModelRequest) : {};
      } catch {
        fail("Invalid native JSON request");
        res.writeHead(400);
        res.end();
        return;
      }
      const helper = options.auxiliary?.(body, path);
      const actualWire: ModelWire | undefined =
        path === "/v1/messages"
          ? "anthropic"
          : path === "/v1/responses"
            ? "responses"
            : path === "/v1/chat/completions"
              ? "chat"
              : /\/models\/[^/]+:streamGenerateContent$/.test(path)
                ? "gemini"
                : undefined;
      const key =
        req.headers["x-api-key"] ??
        req.headers["x-goog-api-key"] ??
        req.headers.authorization?.replace(/^Bearer /, "") ??
        parsed.searchParams.get("key");
      if (
        actualWire &&
        !(options.authOptional && !key) &&
        ![syntheticKey, ...(options.syntheticKeys ?? [])].includes(String(key))
      ) {
        fail("Native request did not use the synthetic credential");
        res.writeHead(401);
        res.end();
        return;
      }
      if (helper) {
        auxiliaryRequests.push({ kind: helper, body });
        if (actualWire)
          new Exchange(body, res, actualWire).finish("OWNED_AUXILIARY_REPLY");
        else {
          res.writeHead(404);
          res.end();
        }
        return;
      }
      if (path.endsWith("count_tokens") || path.endsWith(":countTokens")) {
        auxiliaryRequests.push({ kind: "count-tokens", body });
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ input_tokens: 100, totalTokens: 100 }));
        return;
      }
      if (req.method !== "POST" || actualWire !== wire) {
        fail(`Unexpected native request: ${req.method} ${path}`);
        res.writeHead(400);
        res.end();
        return;
      }
      const model =
        wire === "gemini"
          ? decodeURIComponent(path.split("/models/")[1]!.split(":")[0]!)
          : String(body.model);
      const exchange = new Exchange(body, res, wire, model);
      requests.push(exchange);
      const waiter = waiting.shift();
      if (waiter) waiter.resolve(exchange);
      else buffered.push(exchange);
    }
  });
  server.on("connect", (req, socket, head) => {
    socket.on("error", () => socket.destroy());
    // Some native proxy agents ignore NO_PROXY. Only this exact owned listener may tunnel.
    const address = server.address();
    if (
      address &&
      typeof address !== "string" &&
      req.url === `127.0.0.1:${address.port}`
    ) {
      const peer = connect(address.port, "127.0.0.1", () => {
        socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        if (head.length) peer.write(head);
        socket.pipe(peer);
        peer.pipe(socket);
      });
      tunnels.add(peer);
      tunnels.add(socket);
      peer.on("error", () => socket.destroy());
      // A client FIN cancels its in-flight model response. Waiting for both
      // pipe halves to close would keep a held SSE response alive forever.
      socket.once("end", () => peer.destroy());
      peer.once("end", () => socket.destroy());
      socket.on("close", () => {
        peer.destroy();
        tunnels.delete(socket);
      });
      peer.on("close", () => {
        socket.destroy();
        tunnels.delete(peer);
      });
      return;
    }
    blockedConnections.push(req.url ?? "unknown");
    if (
      !(
        options.blockedHosts ?? [
          "chatgpt.com:443",
          "github.com:443",
          "api.github.com:443",
        ]
      ).includes(req.url ?? "")
    )
      fail(`Unexpected external connection: ${req.url}`);
    socket.end("HTTP/1.1 403 Forbidden\r\n\r\n");
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string")
    throw Error("Missing model listener");
  return {
    url: `http://127.0.0.1:${address.port}`,
    requests,
    auxiliaryRequests,
    failures,
    blockedConnections,
    next(): Promise<Exchange> {
      if (failures.length) return Promise.reject(Error(failures.join("; ")));
      if (closed)
        return Promise.reject(Error("Owned model listener is closed"));
      const value = buffered.shift();
      return value
        ? Promise.resolve(value)
        : new Promise((resolve, reject) => waiting.push({ resolve, reject }));
    },
    async close() {
      closed = true;
      for (const waiter of waiting.splice(0))
        waiter.reject(Error("Owned model listener closed before next request"));
      for (const request of requests) request.close();
      for (const tunnel of tunnels) tunnel.destroy();
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}
