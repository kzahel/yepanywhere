import { createServer, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";

/** Scripted model transport, not a fake provider executable or an output replay. */
export type ModelWire = "anthropic" | "responses";
export type ModelRequest = Record<string, unknown>;

export class Exchange {
  readonly id = `owned_${randomUUID().replaceAll("-", "")}`;
  readonly cancelled: Promise<void>;
  private resolveCancelled!: () => void;
  private finished = false;
  private text = "";
  private textStarted = false;
  constructor(
    readonly body: ModelRequest,
    private response: ServerResponse,
    private wire: ModelWire,
  ) {
    this.cancelled = new Promise((resolve) => {
      this.resolveCancelled = resolve;
    });
    response.on("close", () => {
      if (!this.finished) this.resolveCancelled();
    });
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    if (wire === "anthropic")
      this.event("message_start", {
        message: {
          id: this.id,
          type: "message",
          role: "assistant",
          model: body.model,
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 100, output_tokens: 0 },
        },
      });
    else
      this.event("response.created", {
        response: {
          id: this.id,
          object: "response",
          status: "in_progress",
          output: [],
        },
      });
  }
  private event(type: string, fields: Record<string, unknown>) {
    this.response.write(
      `event: ${type}\ndata: ${JSON.stringify({ type, ...fields })}\n\n`,
    );
  }
  partial(text: string) {
    const itemId = `msg_${this.id}`;
    if (!this.textStarted) {
      if (this.wire === "anthropic")
        this.event("content_block_start", {
          index: 0,
          content_block: { type: "text", text: "" },
        });
      else {
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
    else
      this.event("response.output_text.delta", {
        output_index: 0,
        item_id: itemId,
        content_index: 0,
        delta: text,
      });
  }
  finish(text: string) {
    this.partial(text);
    const item = {
      type: "message",
      id: `msg_${this.id}`,
      role: "assistant",
      status: "completed",
      content: [{ type: "output_text", text: this.text, annotations: [] }],
    };
    if (this.wire === "anthropic") {
      this.event("content_block_stop", { index: 0 });
      this.event("message_delta", {
        delta: { stop_reason: "end_turn", stop_sequence: null },
        usage: { output_tokens: 5 },
      });
      this.event("message_stop", {});
    } else {
      this.event("response.output_text.done", {
        output_index: 0,
        item_id: item.id,
        content_index: 0,
        text: this.text,
      });
      this.event("response.output_item.done", { output_index: 0, item });
      this.event("response.completed", {
        response: {
          id: this.id,
          object: "response",
          status: "completed",
          output: [item],
          usage: {
            input_tokens: 100,
            output_tokens: 5,
            total_tokens: 105,
            input_tokens_details: { cached_tokens: 0 },
            output_tokens_details: { reasoning_tokens: 0 },
          },
        },
      });
    }
    this.end();
  }
  tool(name: string, args: Record<string, unknown> | string) {
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
    } else {
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
              status: "completed",
            };
      this.event("response.output_item.done", { output_index: 0, item });
      this.event("response.completed", {
        response: {
          id: this.id,
          object: "response",
          status: "completed",
          output: [item],
          usage: { input_tokens: 100, output_tokens: 5, total_tokens: 105 },
        },
      });
    }
    this.end();
  }
  private end() {
    this.finished = true;
    this.response.end();
  }
  close() {
    this.response.destroy();
  }
}

export async function modelServer(wire: ModelWire) {
  const requests: Exchange[] = [],
    waiting: Array<{
      resolve: (exchange: Exchange) => void;
      reject: (error: Error) => void;
    }> = [],
    buffered: Exchange[] = [],
    failures: string[] = [],
    blockedConnections: string[] = [];
  let closed = false;
  function fail(message: string) {
    failures.push(message);
    for (const waiter of waiting.splice(0)) waiter.reject(Error(message));
  }
  const server = createServer((req, res) => {
    void receive().catch(() => {
      fail("Native model request stream failed");
      res.destroy();
    });
    async function receive() {
      const path = new URL(req.url ?? "/", "http://localhost").pathname;
      if (
        req.method !== "POST" ||
        ![
          ...(wire === "anthropic"
            ? ["/v1/messages", "/v1/messages/count_tokens"]
            : ["/v1/responses"]),
        ].includes(path)
      ) {
        fail(`Unexpected native request: ${req.method} ${path}`);
        res.writeHead(400);
        res.end("Unexpected model route");
        return;
      }
      if (
        (req.headers["x-api-key"] ??
          req.headers.authorization?.replace(/^Bearer /, "")) !==
        "owned-model-stub-only"
      ) {
        fail("Native request did not use the synthetic credential");
        res.writeHead(401);
        res.end();
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
      if (path.endsWith("count_tokens")) {
        res.setHeader("Content-Type", "application/json");
        res.end('{"input_tokens":100}');
        return;
      }
      try {
        const exchange = new Exchange(JSON.parse(content), res, wire);
        requests.push(exchange);
        const receive = waiting.shift();
        if (receive) receive.resolve(exchange);
        else buffered.push(exchange);
      } catch {
        fail("Invalid native JSON request");
        res.writeHead(400);
        res.end();
      }
    }
  });
  server.on("connect", (req, socket) => {
    blockedConnections.push(req.url ?? "unknown");
    if (
      !["chatgpt.com:443", "github.com:443", "api.github.com:443"].includes(
        req.url ?? "",
      )
    )
      fail(`Unexpected external connection: ${req.url}`);
    socket.end("HTTP/1.1 403 Forbidden\r\n\r\n");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string")
    throw Error("Missing model listener");
  return {
    url: `http://127.0.0.1:${address.port}`,
    requests,
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
      requests.forEach((r) => r.close());
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}
