/**
 * The owner of permission requests that `agy` sends to YA over ACP. One
 * runtime connection is one YA session, so the rules apply per connection.
 *
 * Each request is one entry, keyed by its own JSON-RPC ID (as JSON, so "1"
 * and 1 stay distinct). An entry gets exactly one terminal reply, and only
 * while it is still the entry under its key, so a late answer can never
 * consume a replacement that reused the ID. Every terminal path aborts the
 * entry's controller, which withdraws YA's approval prompt if it is open.
 *
 * A request belongs to its tool call:
 *  - terminal evidence for the call (a `tool_call` or `tool_call_update`
 *    with status completed, failed or cancelled) withdraws the request;
 *  - Stop withdraws every pending request and marks the tool calls then in
 *    flight as cancelled; a later request for one of them is answered
 *    cancelled without a prompt, while a request for a tool call first
 *    announced after Stop is new work and may ask.
 *
 * YA's session goes idle when a turn's or command's result is handled,
 * and an approval still waiting then would be hidden. So requests raised
 * while a YA prompt is outstanding are withdrawn just before that result,
 * and a request arriving after the last prompt response is held until YA
 * reports it is idle (`turnEnded`), or until YA sends another prompt. The
 * prompt count changes synchronously when YA sends a prompt and when its
 * response frame is dispatched, so a request in the same write as that
 * response is not taken for part of the finished prompt.
 */

export type JsonRpcId = string | number | null;

export const CANCELLED_PERMISSION = { outcome: { outcome: "cancelled" } };

/** More than this many unanswered requests are answered cancelled. */
export const MAX_PENDING_PERMISSIONS = 32;
/** Tool calls remembered as in flight; the oldest are forgotten first. */
const MAX_TRACKED_TOOL_CALLS = 256;

type Reply = { result: unknown } | { error: { code: number; message: string } };
type Handler = (
  params: Record<string, unknown>,
  signal: AbortSignal,
) => Promise<unknown>;

export interface PermissionParams extends Record<string, unknown> {
  sessionId: string;
  toolCall: { toolCallId: string };
}

interface Entry {
  key: string;
  id: JsonRpcId;
  toolCall: string;
  params: PermissionParams;
  controller: AbortController;
  duringPrompt: boolean;
  held: boolean;
  done: boolean;
}

const TERMINAL = new Set(["completed", "failed", "cancelled"]);
const toolKey = (sessionId: string, toolCallId: string) =>
  `${sessionId}\0${toolCallId}`;

export class AntigravityPermissionRequests {
  private readonly entries = new Map<string, Entry>();
  // Announced, not yet terminal; true once Stop cancelled it.
  private readonly toolCalls = new Map<string, boolean>();
  private promptsOutstanding = 0;
  private turnClosing = false;
  private closed = false;

  constructor(
    private readonly reply: (id: JsonRpcId, reply: Reply) => void,
    private readonly handler: () => Handler | undefined,
    private readonly limit = MAX_PENDING_PERMISSIONS,
  ) {}

  get size(): number {
    return this.entries.size;
  }

  /** A valid `session/request_permission` request. */
  receive(id: JsonRpcId, params: PermissionParams): void {
    if (this.closed) return;
    const key = JSON.stringify(id);
    const existing = this.entries.get(key);
    if (existing) {
      // Two live requests under one ID cannot be answered unambiguously:
      // withdraw the first and give the ID its one terminal reply.
      this.finish(existing, {
        error: { code: -32600, message: "Duplicate request ID" },
      });
      return;
    }
    const toolCall = toolKey(params.sessionId, params.toolCall.toolCallId);
    if (
      this.toolCalls.get(toolCall) === true ||
      this.entries.size >= this.limit ||
      !this.handler()
    ) {
      this.reply(id, { result: CANCELLED_PERMISSION });
      return;
    }
    const entry: Entry = {
      key,
      id,
      toolCall,
      params,
      controller: new AbortController(),
      duringPrompt: this.promptsOutstanding > 0,
      held: this.turnClosing && this.promptsOutstanding === 0,
      done: false,
    };
    this.entries.set(key, entry);
    if (!entry.held) this.ask(entry);
  }

  /** A `tool_call` or `tool_call_update` notification. */
  observeToolCall(sessionId: string, toolCallId: string, status?: string) {
    const toolCall = toolKey(sessionId, toolCallId);
    if (status && TERMINAL.has(status)) {
      this.toolCalls.delete(toolCall);
      for (const entry of [...this.entries.values()])
        if (entry.toolCall === toolCall)
          this.finish(entry, { result: CANCELLED_PERMISSION });
      return;
    }
    if (this.toolCalls.has(toolCall)) return;
    this.toolCalls.set(toolCall, false);
    if (this.toolCalls.size > MAX_TRACKED_TOOL_CALLS)
      this.toolCalls.delete(this.toolCalls.keys().next().value!);
  }

  /**
   * YA sent `session/prompt`. Held requests are asked now: YA shows them
   * during the new turn, and they count as raised during it.
   */
  promptSent(): void {
    this.promptsOutstanding++;
    this.turnClosing = true;
    for (const entry of [...this.entries.values()])
      if (entry.held) {
        entry.held = false;
        entry.duringPrompt = true;
        this.ask(entry);
      }
  }

  /** A prompt's response frame was dispatched, or its call failed. */
  promptAnswered(): void {
    if (this.promptsOutstanding > 0) this.promptsOutstanding--;
  }

  /**
   * YA's foreground turn is about to publish its result, which makes the
   * session idle: requests raised during the turn and still waiting would
   * be hidden, so they are withdrawn.
   */
  endingTurn(): void {
    if (this.promptsOutstanding > 0) return;
    for (const entry of [...this.entries.values()])
      if (entry.duringPrompt && !entry.held)
        this.finish(entry, { result: CANCELLED_PERMISSION });
  }

  /**
   * YA's foreground turn ended (its result was published, or a command
   * that prompts returned): held requests are put to the user now that
   * the session can show them.
   */
  turnEnded(): void {
    if (this.promptsOutstanding > 0) return;
    this.turnClosing = false;
    for (const entry of [...this.entries.values()])
      if (entry.held) {
        entry.held = false;
        this.ask(entry);
      }
  }

  /**
   * YA sent `session/cancel`. As ACP asks of a client, every pending
   * request is answered cancelled, and the tool calls then in flight are
   * remembered as cancelled.
   */
  stop(): void {
    for (const toolCall of this.toolCalls.keys())
      this.toolCalls.set(toolCall, true);
    for (const entry of [...this.entries.values()])
      this.finish(entry, { result: CANCELLED_PERMISSION });
  }

  /** The connection ended: no more intake, no replies, every prompt withdrawn. */
  close(): void {
    this.closed = true;
    this.toolCalls.clear();
    for (const entry of [...this.entries.values()]) {
      entry.done = true;
      entry.controller.abort();
    }
    this.entries.clear();
  }

  private ask(entry: Entry): void {
    const handle = this.handler();
    if (!handle) {
      this.finish(entry, { result: CANCELLED_PERMISSION });
      return;
    }
    void handle(entry.params, entry.controller.signal).then(
      (result) => this.finish(entry, { result }),
      () => this.finish(entry, { result: CANCELLED_PERMISSION }),
    );
  }

  private finish(entry: Entry, reply: Reply): void {
    if (entry.done) return;
    entry.done = true;
    entry.controller.abort();
    if (this.entries.get(entry.key) !== entry) return;
    this.entries.delete(entry.key);
    if (!this.closed) this.reply(entry.id, reply);
  }
}
