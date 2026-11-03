import type { SDKMessage } from "../types.js";
import type { AntigravityUpdate } from "./antigravity-runtime.js";

/** One replay or live turn, capped independently of the native conversation. */
export class AntigravityTranscript {
  readonly messages: SDKMessage[] = [];
  private bytes = 0;
  private text?: { kind: string; message: SDKMessage; value: string };
  // Bounded by the same 8 MiB/10,000-message replay limits; discarded with it.
  private tools = new Map<string, SDKMessage>();

  constructor(
    private readonly sessionId: string,
    private readonly prefix = sessionId,
  ) {}

  accept(update: AntigravityUpdate): SDKMessage | undefined {
    this.bytes += Buffer.byteLength(JSON.stringify(update), "utf8");
    if (this.bytes > 8 * 1024 * 1024 || this.messages.length >= 10_000)
      throw new Error(
        "Antigravity replay exceeds the experimental history limit",
      );
    const kind = update.sessionUpdate;
    if (
      kind === "user_message_chunk" ||
      kind === "agent_message_chunk" ||
      kind === "agent_thought_chunk"
    ) {
      const content = update.content;
      if (
        !content ||
        Array.isArray(content) ||
        content.type !== "text" ||
        typeof content.text !== "string"
      )
        return;
      if (this.text?.kind !== kind) {
        const role = kind === "user_message_chunk" ? "user" : "assistant";
        const message: SDKMessage = {
          type: role,
          uuid: `${this.prefix}:${this.messages.length}`,
          session_id: this.sessionId,
          message: { role, content: "" },
        };
        this.messages.push(message);
        this.text = { kind, message, value: "" };
      }
      this.text!.value += content.text;
      this.text!.message.message!.content =
        kind === "agent_thought_chunk"
          ? [{ type: "thinking", thinking: this.text!.value }]
          : this.text!.value;
      return structuredClone(this.text!.message);
    }
    if (kind !== "tool_call" && kind !== "tool_call_update") return;
    this.text = undefined;
    const id = update.toolCallId;
    if (!id) return;
    if (kind === "tool_call") {
      let message = this.tools.get(id);
      if (!message) {
        message = {
          type: "assistant",
          uuid: `${id}:call`,
          session_id: this.sessionId,
          message: {
            role: "assistant",
            content: [
              {
                type: "tool_use",
                id,
                name: update.title || "Antigravity tool",
                input: update.rawInput ?? {},
              },
            ],
          },
        };
        this.tools.set(id, message);
        this.messages.push(message);
      }
      return structuredClone(message);
    }
    if (update.status !== "completed" && update.status !== "failed") return;
    const message: SDKMessage = {
      type: "user",
      uuid: `${id}:result`,
      session_id: this.sessionId,
      message: {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: id,
            content:
              typeof update.rawOutput === "string"
                ? update.rawOutput
                : JSON.stringify(update.rawOutput ?? update.content ?? ""),
            is_error: update.status === "failed",
          },
        ],
      },
    };
    const existing = this.messages.findIndex(
      (entry) => entry.uuid === message.uuid,
    );
    if (existing >= 0) this.messages[existing] = message;
    else this.messages.push(message);
    return message;
  }
}
