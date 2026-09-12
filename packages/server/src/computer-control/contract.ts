import { z } from "zod";
import type { DynamicToolSpec } from "../sdk/providers/codex-protocol/generated/v2/DynamicToolSpec.js";

const hwnd = z.number().int().positive().safe();
const generation = z.string().regex(/^[a-f0-9]{32}$/);
const reference = z.string().min(1).max(2048);
const base = { expectedGeneration: generation };
export const computerOperation = z.discriminatedUnion("operation", [
  z.object({ operation: z.literal("windows") }).strict(),
  z
    .object({
      operation: z.literal("snapshot"),
      hwnd,
      maxDepth: z.number().int().min(1).max(12).default(6),
      maxElements: z.number().int().min(1).max(500).default(200),
    })
    .strict(),
  z
    .object({ operation: z.literal("screenshot"), hwnd: hwnd.optional() })
    .strict(),
  z.object({ operation: z.literal("invoke"), reference, ...base }).strict(),
  z
    .object({
      operation: z.literal("set.value"),
      reference,
      text: z.string().max(4096),
      ...base,
    })
    .strict(),
  z
    .object({
      operation: z.literal("click"),
      hwnd,
      x: z.number().int().min(-32768).max(32767),
      y: z.number().int().min(-32768).max(32767),
      button: z.enum(["left", "right", "middle"]).default("left"),
      ...base,
    })
    .strict(),
  z
    .object({
      operation: z.literal("key"),
      key: z
        .string()
        .min(1)
        .max(80)
        .regex(/^[A-Za-z0-9+_ -]+$/),
      ...base,
    })
    .strict(),
  z
    .object({
      operation: z.literal("type"),
      text: z.string().min(1).max(4096),
      ...base,
    })
    .strict(),
  z.object({ operation: z.literal("app.activate"), hwnd, ...base }).strict(),
  z
    .object({
      operation: z.literal("window.state"),
      hwnd,
      state: z.enum(["restored", "minimized", "maximized"]),
      ...base,
    })
    .strict(),
]);

export type ComputerOperation = z.infer<typeof computerOperation>;
const advertisedProperties = Object.assign(
  {},
  ...computerOperation.options.map((option) => {
    const schema = z.toJSONSchema(option) as {
      properties?: Record<string, unknown>;
    };
    return schema.properties;
  }),
);
advertisedProperties.operation = {
  type: "string",
  enum: computerOperation.options.map((option) => option.shape.operation.value),
};
export const COMPUTER_TOOLS: DynamicToolSpec[] = [
  {
    type: "function",
    name: "computer_control",
    deferLoading: true,
    description:
      "Inspect and control the ordinary Windows desktop. Start with windows, then snapshot an exact hwnd to obtain semantic references and the current expectedGeneration. Prefer invoke/set.value over input. Screenshots return images. Preserve reported provider, fidelity, delivery, effect and uncertainty; delivery is not proof of effect. Never replay an uncertain mutation. Fresh observations are required after idle expiry or stale references. No elevated, lock/login, arbitrary shell or service operations.",
    inputSchema: JSON.parse(
      JSON.stringify({
        type: "object",
        properties: advertisedProperties,
        required: ["operation"],
        additionalProperties: false,
      }),
    ),
  },
];

export interface ComputerToolResult {
  success: boolean;
  contentItems: Array<
    | { type: "inputText"; text: string }
    | { type: "inputImage"; imageUrl: string }
  >;
}

export interface ComputerSession {
  tools: DynamicToolSpec[];
  call(
    tool: string,
    args: unknown,
    callId?: string,
  ): Promise<ComputerToolResult>;
  acceptsThread(threadId: unknown): boolean;
  close(): Promise<void>;
  rename(sessionId: string): void;
}
