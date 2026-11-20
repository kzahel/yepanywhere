import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { streamSSE } from "hono/streaming";
import { chatRequest, toModelContext } from "./chat-request.mjs";

const hash = (value) => createHash("sha256").update(value).digest();
const maximumRequestBytes = 32 * 1024 * 1024;
const maximumConcurrentRequests = 4;

function errorResponse(context, status, message) {
  return context.json({ error: { message } }, status);
}

function usage(message) {
  const counts = message.usage;
  if (!counts) return undefined;
  return {
    prompt_tokens: counts.input + counts.cacheRead + counts.cacheWrite,
    completion_tokens: counts.output,
    total_tokens: counts.totalTokens,
    prompt_tokens_details: { cached_tokens: counts.cacheRead },
  };
}

function finishReason(message) {
  if (message.stopReason === "toolUse") return "tool_calls";
  if (message.stopReason === "length") return "length";
  if (message.stopReason === "stop") return "stop";
  throw new Error("Provider did not complete the model request.");
}

function toolCall(block) {
  if (block.argumentsError)
    throw new Error("Provider returned invalid tool arguments.");
  return {
    id: block.id,
    type: "function",
    function: { name: block.name, arguments: JSON.stringify(block.arguments) },
  };
}

function completion(message, header) {
  const content = message.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("");
  const calls = message.content
    .filter((block) => block.type === "toolCall")
    .map(toolCall);
  return {
    ...header,
    object: "chat.completion",
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: content || null,
          ...(calls.length ? { tool_calls: calls } : {}),
        },
        finish_reason: finishReason(message),
      },
    ],
    usage: usage(message),
  };
}

async function sendCompletion(stream, events, header, includeUsage) {
  const send = (payload) =>
    stream.writeSSE({
      data: JSON.stringify({
        ...header,
        object: "chat.completion.chunk",
        ...payload,
      }),
    });
  const choice = (delta, finish_reason = null) =>
    send({ choices: [{ index: 0, delta, finish_reason }] });
  let toolIndex = 0;
  await choice({ role: "assistant", content: "" });
  for await (const event of events) {
    if (stream.aborted) return;
    switch (event.type) {
      case "text_delta":
        await choice({ content: event.delta });
        break;
      case "thinking_delta":
        await choice({ reasoning_content: event.delta });
        break;
      case "toolcall_end":
        await choice({
          tool_calls: [{ index: toolIndex++, ...toolCall(event.toolCall) }],
        });
        break;
      case "error":
        throw new Error("Provider did not complete the model request.");
      case "done":
        await choice({}, finishReason(event.message));
        if (includeUsage)
          await send({ choices: [], usage: usage(event.message) });
        await stream.writeSSE({ data: "[DONE]" });
        return;
    }
  }
  throw new Error("Provider stream ended without a result.");
}

export function createModelApi({ models, runtime, token }) {
  const app = new Hono();
  const expected = hash(`Bearer ${token}`);
  let active = 0;

  app.use("/v1/*", async (context, next) => {
    const host = context.req.header("host");
    if (
      !host ||
      !/^(?:127\.0\.0\.1|localhost)(?::\d+)?$/u.test(host) ||
      context.req.header("origin")
    ) {
      return errorResponse(
        context,
        403,
        "Use the local model API from your application server.",
      );
    }
    if (
      !timingSafeEqual(
        expected,
        hash(context.req.header("authorization") ?? ""),
      )
    ) {
      return errorResponse(context, 401, "Invalid model API credential.");
    }
    context.header("Cache-Control", "no-store");
    await next();
  });

  app.get("/v1/models", (context) =>
    context.json({
      object: "list",
      data: Array.from(models, ([id, model]) => ({
        id,
        object: "model",
        owned_by: model.provider,
        context_window: model.contextWindow,
        max_output_tokens: model.maxTokens,
        reasoning: model.reasoning,
        modalities: { input: model.input },
      })),
    }),
  );

  app.post(
    "/v1/chat/completions",
    bodyLimit({ maxSize: maximumRequestBytes }),
    async (context) => {
      if (active >= maximumConcurrentRequests)
        return errorResponse(
          context,
          429,
          "Model API concurrency limit reached.",
        );
      const request = chatRequest.safeParse(
        await context.req.json().catch(() => null),
      );
      if (!request.success)
        return errorResponse(
          context,
          400,
          "Unsupported chat completion request.",
        );
      const input = request.data;
      const model = models.get(input.model);
      if (!model)
        return errorResponse(
          context,
          404,
          "Model is not enabled for this API.",
        );
      let modelContext;
      try {
        modelContext = toModelContext(input, model);
      } catch (error) {
        return errorResponse(context, 400, error.message);
      }
      if (active >= maximumConcurrentRequests)
        return errorResponse(
          context,
          429,
          "Model API concurrency limit reached.",
        );

      const abort = new AbortController();
      const signal = AbortSignal.any([
        context.req.raw.signal,
        abort.signal,
        AbortSignal.timeout(5 * 60_000),
      ]);
      const maxTokens = input.max_completion_tokens ?? input.max_tokens;
      const start = () =>
        runtime.streamSimple(model, modelContext, {
          signal,
          maxTokens: Math.min(maxTokens ?? model.maxTokens, model.maxTokens),
          reasoning:
            input.reasoning_effort === "none"
              ? undefined
              : input.reasoning_effort,
          toolChoice: input.tool_choice,
          temperature: input.temperature,
        });
      const header = {
        id: `chatcmpl-${randomUUID()}`,
        created: Math.floor(Date.now() / 1000),
        model: input.model,
      };
      active++;
      if (!input.stream) {
        try {
          return context.json(completion(await start().result(), header));
        } catch {
          return errorResponse(
            context,
            502,
            "Provider did not complete the model request.",
          );
        } finally {
          active--;
        }
      }
      return streamSSE(context, async (stream) => {
        stream.onAbort(() => abort.abort());
        try {
          await sendCompletion(
            stream,
            start(),
            header,
            input.stream_options?.include_usage,
          );
        } catch {
          if (!stream.aborted)
            await stream.writeSSE({
              data: JSON.stringify({
                error: {
                  message: "Provider did not complete the model request.",
                },
              }),
            });
        } finally {
          abort.abort();
          active--;
        }
      });
    },
  );
  return app;
}
