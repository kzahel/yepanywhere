import {
  type AntigravitySubagentCall,
  formatSpawnAgentResult,
  isAntigravityInvokeSubagent,
  normalizeInvokeSubagentInput,
} from "../../sessions/antigravity-subagent-links.js";
import type { SDKMessage } from "../types.js";
import {
  ANTIGRAVITY_LIVE_CUT,
  ANTIGRAVITY_LIVE_CUT_NOTICE,
} from "./antigravity-live-projection.js";
import type { AntigravityUpdate } from "./antigravity-runtime.js";

/** Calls a live transcript remembers. */
const LIVE_CALLS = 256;
/** A live text or thinking block keeps at most this much text, then a notice. */
const LIVE_TEXT_BYTES = 8 * 1024 * 1024;
function trimOldest<V>(map: Map<string, V>): void {
  while (map.size > LIVE_CALLS) map.delete(map.keys().next().value!);
}

/**
 * One live turn's ACP updates as normalized messages. It keeps none: its
 * owner's projection holds what readers serve (bounded there), so only the
 * open text block and the turn's recent calls stay.
 */
export class AntigravityTranscript {
  private count = 0;
  private text?: {
    kind: string;
    message: SDKMessage;
    value: string;
    /** UTF-8 bytes in `value`; a live block stops growing past the cap. */
    bytes: number;
  };
  // Its most recent calls (a passive transcript lasts until the next prompt).
  private tools = new Map<string, SDKMessage>();
  private subagents = new Map<string, AntigravitySubagentCall>();

  /** Message IDs are `<prefix>:<n>`, numbered in arrival order. */
  constructor(
    private readonly sessionId: string,
    private readonly prefix = sessionId,
  ) {}

  private stamp(): { timestamp: string } {
    return { timestamp: new Date().toISOString() };
  }

  /** Commits the open text block: the same id without `_isStreaming`. */
  close(): SDKMessage | undefined {
    const text = this.text;
    this.text = undefined;
    return text ? this.copy(text) : undefined;
  }
  /** A copy of the block being assembled, marked when it was cut. */
  private copy(text: NonNullable<typeof this.text>): SDKMessage {
    return {
      ...structuredClone(text.message),
      ...(text.bytes > LIVE_TEXT_BYTES ? { [ANTIGRAVITY_LIVE_CUT]: true } : {}),
    };
  }

  /** Normalized `spawn_agent` calls observed in this transcript, in order. */
  listSubagentCalls(): AntigravitySubagentCall[] {
    return [...this.subagents.values()];
  }

  /** Look up a previously observed `invoke_subagent` call by ACP `toolCallId`. */
  getSubagentCall(toolCallId: string): AntigravitySubagentCall | undefined {
    return this.subagents.get(toolCallId);
  }

  /**
   * Attach or update a verified `agent_id` on a `spawn_agent` `tool_result`
   * in place (reusing `${toolCallId}:result`, so the owner's projection
   * replaces the result row rather than adding one). Never overwrites a
   * failed invocation.
   */
  enrichSubagentResult(
    toolCallId: string,
    childId: string,
    nickname?: string,
  ): SDKMessage | undefined {
    const call = this.subagents.get(toolCallId);
    if (!call || call.failed) return undefined;
    const message: SDKMessage = {
      type: "user",
      uuid: `${toolCallId}:result`,
      session_id: this.sessionId,
      ...this.stamp(),
      message: {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: toolCallId,
            content: formatSpawnAgentResult(childId, nickname ?? call.role),
            is_error: false,
          },
        ],
      },
    };
    this.count++;
    return structuredClone(message);
  }

  /**
   * Live messages for one native update, in order. A text or thinking block
   * publishes `_isStreaming` snapshots and is committed when another block
   * starts or the caller closes it.
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
          uuid: `${this.prefix}:${this.count}`,
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
        this.count++;
        this.text = { kind, message, value: "", bytes: 0 };
      }
      const added = Buffer.byteLength(content.text, "utf8");
      // A block past the cap keeps its beginning and one notice.
      if (this.text!.bytes + added > LIVE_TEXT_BYTES) {
        // Already cut: nothing new to show.
        if (this.text!.bytes > LIVE_TEXT_BYTES) return out;
        // The part of this chunk that fits, cut at a character boundary.
        const fits = Buffer.from(content.text, "utf8");
        let end = LIVE_TEXT_BYTES - this.text!.bytes;
        while (end > 0 && (fits[end]! & 0xc0) === 0x80) end--;
        this.text!.value +=
          `${fits.subarray(0, end).toString("utf8")}${ANTIGRAVITY_LIVE_CUT_NOTICE}`;
        this.text!.bytes = LIVE_TEXT_BYTES + 1;
      } else {
        this.text!.value += content.text;
        this.text!.bytes += added;
      }
      this.text!.message.message!.content =
        kind === "agent_thought_chunk"
          ? [{ type: "thinking", thinking: this.text!.value }]
          : this.text!.value;
      out.push({ ...this.copy(this.text!), _isStreaming: true });
      return out;
    }
    if (kind !== "tool_call" && kind !== "tool_call_update") return [];
    const committed = this.close();
    const out = committed ? [committed] : [];
    const id = update.toolCallId;
    if (!id) return out;
    if (kind === "tool_call") {
      const isSubagent = isAntigravityInvokeSubagent(update);
      let message = this.tools.get(id);
      if (!message) {
        const subagentInput = isSubagent
          ? normalizeInvokeSubagentInput(update.rawInput)
          : undefined;
        const normalizedInput = subagentInput ?? update.rawInput ?? {};
        if (subagentInput) {
          this.subagents.set(id, {
            toolUseId: id,
            ...(typeof subagentInput.description === "string"
              ? { role: subagentInput.description }
              : {}),
            ...(typeof subagentInput.subagent_type === "string"
              ? { typeName: subagentInput.subagent_type }
              : {}),
            ...(typeof subagentInput.prompt === "string"
              ? { prompt: subagentInput.prompt }
              : {}),
          });
        }
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
                name: isSubagent
                  ? "spawn_agent"
                  : update.title || "Antigravity tool",
                input: normalizedInput,
              },
            ],
          },
        };
        this.count++;
        this.tools.set(id, message);
        trimOldest(this.tools);
        trimOldest(this.subagents);
      }
      out.push(structuredClone(message));
      return out;
    }
    if (update.status !== "completed" && update.status !== "failed") return out;
    const output = update.rawOutput ?? update.content ?? "";
    const rawContent =
      typeof output === "string" ? output : JSON.stringify(output);
    const subagent = this.subagents.get(id);
    if (subagent) {
      subagent.completed = update.status === "completed";
      subagent.failed = update.status === "failed";
    }
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
            content: rawContent,
            is_error: update.status === "failed",
          },
        ],
      },
    };
    this.count++;
    out.push(message);
    return out;
  }
}
