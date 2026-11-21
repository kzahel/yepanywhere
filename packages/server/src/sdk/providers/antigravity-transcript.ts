import type { SDKMessage } from "../types.js";
import type { AntigravityUpdate } from "./antigravity-runtime.js";

/** One replay or live turn, capped independently of the native conversation. */
export class AntigravityTranscript {
  readonly messages: SDKMessage[] = [];
  private bytes = 0;
  private text?: { kind: string; message: SDKMessage; value: string };
  // Bounded by the same 8 MiB/10,000-message replay limits; discarded with it.
  private tools = new Map<string, SDKMessage>();

  /** `live` stamps arrival time; native replay carries no timestamps. */
  constructor(
    private readonly sessionId: string,
    private readonly prefix = sessionId,
    private readonly live = false,
  ) {}

  private stamp(): { timestamp?: string } {
    return this.live ? { timestamp: new Date().toISOString() } : {};
  }

  /** Commits the open text block: the same id without `_isStreaming`. */
  close(): SDKMessage | undefined {
    const message = this.text?.message;
    this.text = undefined;
    return message ? structuredClone(message) : undefined;
  }

  private reserveHistory(bytes: number, addingMessage = false): void {
    if (
      this.bytes + bytes > 8 * 1024 * 1024 ||
      (addingMessage && this.messages.length >= 10_000)
    ) {
      throw new Error(
        "Antigravity replay exceeds the experimental history limit",
      );
    }
    this.bytes += bytes;
  }

  private record(message: SDKMessage, existing = -1): void {
    const previous = existing < 0 ? undefined : this.messages[existing];
    const oldBytes = previous
      ? Buffer.byteLength(JSON.stringify(previous), "utf8")
      : 0;
    this.reserveHistory(
      Buffer.byteLength(JSON.stringify(message), "utf8") - oldBytes,
      existing < 0,
    );
    if (existing < 0) this.messages.push(message);
    else this.messages[existing] = message;
  }

  /**
   * Live messages for one native update, in order. A text or thinking block
   * publishes `_isStreaming` snapshots and is committed when another block
   * starts or the caller closes it. `messages` holds committed history only.
   */
  accept(update: AntigravityUpdate): SDKMessage[] {
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
        return [];
      const out: SDKMessage[] = [];
      if (this.text?.kind !== kind) {
        const committed = this.close();
        if (committed) out.push(committed);
        const role = kind === "user_message_chunk" ? "user" : "assistant";
        const message: SDKMessage = {
          type: role,
          uuid: `${this.prefix}:${this.messages.length}`,
          session_id: this.sessionId,
          ...this.stamp(),
          message: {
            role,
            content:
              kind === "agent_thought_chunk"
                ? [{ type: "thinking", thinking: "" }]
                : "",
          },
        };
        this.record(message);
        this.text = { kind, message, value: "" };
      }
      // Reserve the serialized text delta without rescanning the entire block.
      this.reserveHistory(
        Buffer.byteLength(JSON.stringify(content.text), "utf8") - 2,
      );
      this.text!.value += content.text;
      this.text!.message.message!.content =
        kind === "agent_thought_chunk"
          ? [{ type: "thinking", thinking: this.text!.value }]
          : this.text!.value;
      out.push({ ...structuredClone(this.text!.message), _isStreaming: true });
      return out;
    }
    if (kind !== "tool_call" && kind !== "tool_call_update") return [];
    const committed = this.close();
    const out = committed ? [committed] : [];
    const id = update.toolCallId;
    if (!id) return out;
    if (kind === "tool_call") {
      let message = this.tools.get(id);
      if (!message) {
        message = {
          type: "assistant",
          uuid: `${id}:call`,
          session_id: this.sessionId,
          ...this.stamp(),
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
        this.record(message);
        this.tools.set(id, message);
      }
      out.push(structuredClone(message));
      return out;
    }
    if (update.status !== "completed" && update.status !== "failed") return out;
    const output = update.rawOutput ?? update.content ?? "";
    const message: SDKMessage = {
      type: "user",
      uuid: `${id}:result`,
      session_id: this.sessionId,
      ...this.stamp(),
      message: {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: id,
            content:
              typeof output === "string" ? output : JSON.stringify(output),
            is_error: update.status === "failed",
          },
        ],
      },
    };
    const existing = this.messages.findIndex(
      (entry) => entry.uuid === message.uuid,
    );
    this.record(message, existing);
    out.push(message);
    return out;
  }
}
