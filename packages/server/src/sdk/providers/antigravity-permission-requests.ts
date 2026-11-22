/**
 * The owner of permission requests that `agy` sends to YA over ACP.
 *
 * Each request is one entry, keyed by its own JSON-RPC ID (as JSON, so "1"
 * and 1 stay distinct). An entry gets exactly one terminal reply, and only
 * while it is still the entry under its key, so a late answer can never
 * consume a replacement that reused the ID. Every terminal path aborts the
 * entry's controller, which withdraws YA's approval prompt if it is still
 * open, and drops the entry.
 *
 * A request belongs to the native work that raised it. While a YA prompt
 * runs for a session, that session's requests belong to the prompt: after
 * YA cancels the session they are answered cancelled without a prompt, and
 * any still open when the prompt settles are withdrawn. A request raised
 * outside a YA prompt (a wake turn, detached work) stays answerable until
 * it is answered, its session is cancelled, or the connection ends.
 */

export type JsonRpcId = string | number | null;

export const CANCELLED_PERMISSION = { outcome: { outcome: "cancelled" } };

/** More than this many unanswered requests are answered cancelled. */
export const MAX_PENDING_PERMISSIONS = 32;

type Reply = { result: unknown } | { error: { code: number; message: string } };

interface Entry {
  key: string;
  id: JsonRpcId;
  sessionId: string;
  controller: AbortController;
  prompt?: PromptScope;
  done: boolean;
}

interface PromptScope {
  prompts: number;
  cancelled: boolean;
  entries: Set<Entry>;
}

export class AntigravityPermissionRequests {
  private readonly entries = new Map<string, Entry>();
  // The session's running YA prompts; steering adds a second prompt to it.
  private readonly prompts = new Map<string, PromptScope>();
  private closed = false;

  constructor(
    private readonly reply: (id: JsonRpcId, reply: Reply) => void,
    private readonly limit = MAX_PENDING_PERMISSIONS,
  ) {}

  get size(): number {
    return this.entries.size;
  }

  /**
   * A `session/request_permission` request. `handle` asks YA's user and
   * resolves with the ACP result; its signal aborts when the entry ends.
   */
  receive(
    id: JsonRpcId,
    params: { sessionId: string } & Record<string, unknown>,
    handle:
      | ((
          params: Record<string, unknown>,
          signal: AbortSignal,
        ) => Promise<unknown>)
      | undefined,
  ): void {
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
    const prompt = this.prompts.get(params.sessionId);
    if (prompt?.cancelled || this.entries.size >= this.limit || !handle) {
      this.reply(id, { result: CANCELLED_PERMISSION });
      return;
    }
    const entry: Entry = {
      key,
      id,
      sessionId: params.sessionId,
      controller: new AbortController(),
      prompt,
      done: false,
    };
    this.entries.set(key, entry);
    prompt?.entries.add(entry);
    void handle(params, entry.controller.signal).then(
      (result) => this.finish(entry, { result }),
      () => this.finish(entry, { result: CANCELLED_PERMISSION }),
    );
  }

  /** YA sent `session/prompt` for the session. */
  promptStarted(sessionId: string): void {
    const prompt = this.prompts.get(sessionId) ?? {
      prompts: 0,
      cancelled: false,
      entries: new Set(),
    };
    prompt.prompts++;
    this.prompts.set(sessionId, prompt);
  }

  /** One of the session's prompts returned; the last withdraws leftovers. */
  promptSettled(sessionId: string): void {
    const prompt = this.prompts.get(sessionId);
    if (!prompt || --prompt.prompts > 0) return;
    this.prompts.delete(sessionId);
    for (const entry of [...prompt.entries])
      this.finish(entry, { result: CANCELLED_PERMISSION });
  }

  /**
   * YA sent `session/cancel`. As ACP asks of a client, every pending
   * request of that session is answered cancelled, and requests arriving
   * before its prompt settles are answered cancelled without a prompt.
   */
  cancelSession(sessionId: string): void {
    const prompt = this.prompts.get(sessionId);
    if (prompt) prompt.cancelled = true;
    for (const entry of [...this.entries.values()])
      if (entry.sessionId === sessionId)
        this.finish(entry, { result: CANCELLED_PERMISSION });
  }

  /** The connection ended: no more intake, no replies, every prompt withdrawn. */
  close(): void {
    this.closed = true;
    this.prompts.clear();
    for (const entry of [...this.entries.values()]) {
      entry.done = true;
      entry.controller.abort();
    }
    this.entries.clear();
  }

  private finish(entry: Entry, reply: Reply): void {
    if (entry.done) return;
    entry.done = true;
    entry.prompt?.entries.delete(entry);
    entry.controller.abort();
    if (this.entries.get(entry.key) !== entry) return;
    this.entries.delete(entry.key);
    if (!this.closed) this.reply(entry.id, reply);
  }
}
