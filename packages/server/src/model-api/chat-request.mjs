import { z } from "zod";

const text = z.object({ type: z.literal("text"), text: z.string() });
const image = z.object({
  type: z.literal("image_url"),
  image_url: z.object({ url: z.string() }),
});
const textContent = z.union([z.string(), z.array(text)]);
const richContent = z.union([z.string(), z.array(z.union([text, image]))]);
const toolName = z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/u);
const object = z.record(z.string(), z.unknown());
const toolCall = z.object({
  type: z.literal("function"),
  id: z.string().min(1).max(512),
  function: z.object({ name: toolName, arguments: z.string() }),
});
const unknownUsage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

export const chatRequest = z.object({
  model: z.string(),
  messages: z
    .array(
      z.discriminatedUnion("role", [
        z.object({
          role: z.enum(["system", "developer"]),
          content: textContent,
        }),
        z.object({ role: z.literal("user"), content: richContent }),
        z.object({
          role: z.literal("assistant"),
          content: textContent.nullish(),
          tool_calls: z.array(toolCall).optional(),
        }),
        z.object({
          role: z.literal("tool"),
          tool_call_id: z.string(),
          content: richContent,
        }),
      ]),
    )
    .min(1),
  tools: z
    .array(
      z.object({
        type: z.literal("function"),
        function: z.object({
          name: toolName,
          description: z.string().optional(),
          parameters: object.optional(),
          strict: z.boolean().nullish(),
        }),
      }),
    )
    .optional(),
  tool_choice: z.enum(["auto", "none"]).optional(),
  stream: z.boolean().default(false),
  stream_options: z
    .object({ include_usage: z.boolean().optional() })
    .optional(),
  reasoning_effort: z
    .enum(["none", "minimal", "low", "medium", "high", "xhigh", "max"])
    .optional(),
  max_tokens: z.number().int().positive().optional(),
  max_completion_tokens: z.number().int().positive().optional(),
  temperature: z.number().min(0).max(2).optional(),
  n: z.literal(1).optional(),
});

function textBlocks(content) {
  return typeof content === "string"
    ? [{ type: "text", text: content }]
    : (content ?? []);
}

function richBlocks(content, model) {
  return textBlocks(content).map((part) => {
    if (part.type === "text") return part;
    const match =
      /^data:(image\/(?:png|jpeg|webp|gif));base64,([A-Za-z0-9+/]+={0,2})$/u.exec(
        part.image_url.url,
      );
    if (!model.input.includes("image") || !match)
      throw new Error("Use a base64 data URL with an image-capable model.");
    return { type: "image", mimeType: match[1], data: match[2] };
  });
}

export function toModelContext(request, model) {
  const calls = new Map();
  const timestamp = Date.now();
  const messages = request.messages.map((message) => {
    switch (message.role) {
      case "system":
      case "developer":
        return { role: "system", content: message.content, timestamp };
      case "user":
        return {
          role: "user",
          content: richBlocks(message.content, model),
          timestamp,
        };
      case "assistant": {
        const content = [...textBlocks(message.content)];
        for (const call of message.tool_calls ?? []) {
          const { name } = call.function;
          let args;
          try {
            args = object.parse(JSON.parse(call.function.arguments));
          } catch {
            throw new Error("Tool call arguments must be a JSON object.");
          }
          if (calls.has(call.id)) throw new Error("Duplicate tool call ID.");
          calls.set(call.id, name);
          content.push({
            type: "toolCall",
            id: call.id,
            name,
            arguments: args,
          });
        }
        return {
          role: "assistant",
          content,
          provider: model.provider,
          model: model.id,
          api: model.api,
          timestamp,
          stopReason: message.tool_calls?.length ? "toolUse" : "stop",
          usage: unknownUsage,
        };
      }
      case "tool": {
        const name = calls.get(message.tool_call_id);
        if (name === undefined)
          throw new Error("Tool result has no matching assistant tool call.");
        calls.delete(message.tool_call_id);
        return {
          role: "toolResult",
          toolCallId: message.tool_call_id,
          toolName: name,
          content: richBlocks(message.content, model),
          timestamp,
          isError: false,
        };
      }
      default:
        throw new Error("Unsupported message role.");
    }
  });
  const tools = request.tools?.map(({ function: tool }) => ({
    name: tool.name,
    description: tool.description ?? "",
    parameters: tool.parameters ?? { type: "object", properties: {} },
    ...(tool.strict === false
      ? { constrainedSampling: false }
      : tool.strict === true
        ? { constrainedSampling: { type: "json_schema", strict: "require" } }
        : {}),
  }));
  return { messages, tools };
}
