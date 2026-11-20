import { describe, expect, it } from "vitest";
import { createModelApi } from "./routes.mjs";

const model = {
  provider: "test",
  id: "model",
  api: "openai-responses",
  input: ["text"],
  contextWindow: 10000,
  maxTokens: 1000,
};
const modelId = "test/model";
const token = "synthetic-model-api-credential-for-testing";
const toolCall = {
  type: "toolCall",
  id: "call_1",
  name: "lookup",
  arguments: { name: "Euler" },
};
const usage = {
  input: 10,
  output: 3,
  cacheRead: 2,
  cacheWrite: 0,
  totalTokens: 15,
};

function fixture() {
  const requests = [];
  const app = createModelApi({
    models: new Map([[modelId, model]]),
    token,
    runtime: {
      async *streamSimple(model, context) {
        requests.push({ model, context });
        if (context.messages.some((message) => message.role === "toolResult")) {
          yield { type: "text_delta", delta: "Euler's result" };
          yield { type: "done", message: { stopReason: "stop", usage } };
        } else {
          yield { type: "toolcall_end", toolCall };
          yield { type: "done", message: { stopReason: "toolUse", usage } };
        }
      },
    },
  });
  const request = (path, body, headers = {}) =>
    app.request(`http://127.0.0.1:3410/v1/${path}`, {
      ...(body ? { method: "POST", body: JSON.stringify(body) } : {}),
      headers: {
        Host: "127.0.0.1:3410",
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        ...headers,
      },
    });
  return { request, requests };
}

async function chunks(response) {
  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toContain("text/event-stream");
  const data = (await response.text())
    .split("\n")
    .filter((line) => line.startsWith("data: "))
    .map((line) => line.slice(6));
  expect(data.pop()).toBe("[DONE]");
  return data.map((line) => JSON.parse(line));
}

describe("local model API", () => {
  it("streams caller-owned tool calls, then resumes from their results without a shared session", async () => {
    const { request, requests } = fixture();
    expect((await (await request("models")).json()).data).toMatchObject([
      { id: modelId, context_window: 10000 },
    ]);
    const first = {
      model: modelId,
      stream: true,
      stream_options: { include_usage: true },
      messages: [
        { role: "developer", content: "Use the lookup tool." },
        { role: "user", content: "Find Euler" },
      ],
      tools: [
        {
          type: "function",
          function: { name: "lookup", parameters: { type: "object" } },
        },
      ],
    };
    const events = await chunks(await request("chat/completions", first));
    const streamed = events[1].choices[0].delta.tool_calls[0];
    expect(streamed).toEqual({
      index: 0,
      id: "call_1",
      type: "function",
      function: { name: "lookup", arguments: '{"name":"Euler"}' },
    });
    expect(events[2].choices[0].finish_reason).toBe("tool_calls");
    expect(events[3].usage).toMatchObject({
      prompt_tokens: 12,
      total_tokens: 15,
    });

    const { index: _, ...call } = streamed;
    const follow = {
      ...first,
      messages: [
        ...first.messages,
        { role: "assistant", tool_calls: [call] },
        { role: "tool", tool_call_id: call.id, content: "Euler found" },
      ],
    };
    const [continued, independent] = await Promise.all([
      request("chat/completions", follow).then(chunks),
      request("chat/completions", first).then(chunks),
    ]);
    expect(continued[1].choices[0].delta.content).toBe("Euler's result");
    expect(independent[2].choices[0].finish_reason).toBe("tool_calls");
    expect(requests[0].context).toMatchObject({
      messages: [{ role: "system" }, { role: "user" }],
      tools: [{ name: "lookup" }],
    });
    const replay = requests.find(
      ({ context }) => context.messages.length === 4,
    );
    expect(replay.context.messages[2]).toMatchObject({
      role: "assistant",
      usage: { totalTokens: 0 },
    });
    expect(replay.context.messages[3]).toMatchObject({
      role: "toolResult",
      toolCallId: call.id,
      toolName: "lookup",
      content: [{ text: "Euler found" }],
    });
  });

  it("refuses browser origins, unlisted models and invalid tool history", async () => {
    const { request, requests } = fixture();
    expect(
      (await request("models", null, { Authorization: "Bearer wrong" })).status,
    ).toBe(401);
    expect((await request("models", null, { Host: "other.test" })).status).toBe(
      403,
    );
    expect(
      (await request("models", null, { Origin: "http://127.0.0.1:3410" }))
        .status,
    ).toBe(403);
    expect(
      (
        await request("chat/completions", {
          model: "not-enabled",
          messages: [{ role: "user", content: "hi" }],
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await request("chat/completions", {
          model: modelId,
          messages: [
            { role: "tool", tool_call_id: "orphan", content: "value" },
          ],
        })
      ).status,
    ).toBe(400);
    expect(requests).toHaveLength(0);
  });
});
