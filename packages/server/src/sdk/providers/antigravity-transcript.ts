import {
  type AntigravitySubagentCall,
  formatSpawnAgentResult,
  isAntigravityInvokeSubagent,
  normalizeInvokeSubagentInput,
} from "../../sessions/antigravity-subagent-links.js";
import type { SDKMessage } from "../types.js";
import type { AntigravityUpdate } from "./antigravity-runtime.js";

/**
 * One ACP replay or one live turn, as normalized messages. A replay keeps
 * its messages, capped at 8 MiB and 10,000 (the fallback's history limit).
 * A live turn keeps none: its owner's projection holds what readers serve
 * (bounded there), so only the open text block and the turn's calls stay.
 */
export class AntigravityTranscript {
  /** A replay's history; always empty for a live turn. */
  readonly messages: SDKMessage[] = [];
  private bytes = 0;
  private count = 0;
  private text?: { kind: string; message: SDKMessage; value: string };
  // A replay's are bounded by its limits; a live turn's are discarded with it.
  private tools = new Map<string, SDKMessage>();
  private subagents = new Map<string, AntigravitySubagentCall>();

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
    if (this.live) return;
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
    if (this.live) {
      if (existing < 0) this.count++;
      return;
    }
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
   * in-place (reusing `${toolCallId}:result` so live streams and cold replays
   * stay idempotent and never duplicate result entries). Never overwrites a
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
    const existing = this.messages.findIndex(
      (entry) => entry.uuid === message.uuid,
    );
    this.record(message, existing);
    return structuredClone(message);
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
          uuid: `${this.prefix}:${this.live ? this.count : this.messages.length}`,
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
        this.record(message);
        this.tools.set(id, message);
      }
      out.push(structuredClone(message));
      // Cold ACP `session/load` replays `invoke_subagent` as a single
      // `tool_call` with `status: "completed"` and no `tool_call_update`.
      // Synthesize the paired `tool_result` (enriched with verified `agent_id`
      // after replay finishes) so the tool does not render stuck pending.
      if (
        !this.live &&
        isSubagent &&
        (update.status === "completed" || update.status === "failed")
      ) {
        const call = this.subagents.get(id);
        if (call) {
          call.completed = update.status === "completed";
          call.failed = update.status === "failed";
        }
        const rawText =
          typeof update.rawOutput === "string"
            ? update.rawOutput
            : typeof update.content === "string"
              ? update.content
              : "";
        const resultMessage: SDKMessage = {
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
                content: rawText,
                is_error: update.status === "failed",
              },
            ],
          },
        };
        const existing = this.messages.findIndex(
          (entry) => entry.uuid === resultMessage.uuid,
        );
        this.record(resultMessage, existing);
        out.push(structuredClone(resultMessage));
      }
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
    const existing = this.messages.findIndex(
      (entry) => entry.uuid === message.uuid,
    );
    this.record(message, existing);
    out.push(message);
    return out;
  }
}
