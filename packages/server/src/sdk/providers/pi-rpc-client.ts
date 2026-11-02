/**
 * Minimal client for pi's headless RPC mode (`pi --mode rpc`).
 *
 * Protocol (see ~/pi packages/coding-agent/docs/rpc.md):
 * - Commands are JSON objects written to stdin, one per LF-terminated line.
 * - stdout interleaves three line kinds, each a JSON object discriminated by
 *   `type`:
 *     - `{ type: "response", id?, command, success, data?/error }` — the
 *       correlated reply to a command (id echoed when the command carried one);
 *     - `{ type: "extension_ui_request", id, method, ... }` — an extension
 *       asking for user input (confirm/select/input/...);
 *     - everything else is an `AgentSessionEvent` (agent_start, turn_*,
 *       message_*, tool_execution_*, queue_update, compaction_*, ...).
 *
 * Framing is strict LF-only JSONL: payload strings may contain U+2028/U+2029,
 * which are valid inside JSON strings, so we must split on `\n` only. This is
 * exactly why node:readline is unusable here (it also breaks on those Unicode
 * separators). This mirrors pi's own modes/rpc/jsonl.ts reader.
 */

import type { ChildProcess } from "node:child_process";
import type { Readable } from "node:stream";
import { StringDecoder } from "node:string_decoder";
import { getLogger } from "../../logging/logger.js";

/** A correlated command reply on stdout. */
export interface PiRpcResponse {
  type: "response";
  id?: string;
  command: string;
  success: boolean;
  data?: unknown;
  error?: string;
}

/**
 * A pi `AgentSessionEvent` line. Kept loose (discriminated only by `type`) so
 * the normalizer can read fields per event kind without re-deriving pi's full
 * event union here.
 */
export interface PiAgentEvent {
  type: string;
  [key: string]: unknown;
}

/** An extension UI request line (confirm/select/input/notify/...). */
export interface PiExtensionUiRequest {
  type: "extension_ui_request";
  id: string;
  method: string;
  [key: string]: unknown;
}

/**
 * An extension failure line: pi caught a throw from an extension's handler.
 * For a command, `extensionPath` is `command:<name>`, and the line precedes
 * that command's `response`.
 */
export interface PiExtensionError {
  type: "extension_error";
  extensionPath?: string;
  event?: string;
  error?: string;
}

type PiCommand = { type: string; [key: string]: unknown };

/**
 * Attach an LF-only JSONL line reader to a stream. Deliberately NOT
 * node:readline: readline also splits on U+2028/U+2029, which are valid inside
 * JSON strings, so it does not implement strict JSONL framing. A trailing `\r`
 * is tolerated and stripped.
 */
export function attachJsonlLineReader(
  stream: Readable,
  onLine: (line: string) => void,
): () => void {
  const decoder = new StringDecoder("utf8");
  let buffer = "";

  const emit = (line: string) => {
    onLine(line.endsWith("\r") ? line.slice(0, -1) : line);
  };

  const onData = (chunk: string | Buffer) => {
    buffer += typeof chunk === "string" ? chunk : decoder.write(chunk);
    let newlineIndex = buffer.indexOf("\n");
    while (newlineIndex !== -1) {
      emit(buffer.slice(0, newlineIndex));
      buffer = buffer.slice(newlineIndex + 1);
      newlineIndex = buffer.indexOf("\n");
    }
  };

  const onEnd = () => {
    buffer += decoder.end();
    if (buffer.length > 0) {
      emit(buffer);
      buffer = "";
    }
  };

  stream.on("data", onData);
  stream.on("end", onEnd);
  return () => {
    stream.off("data", onData);
    stream.off("end", onEnd);
  };
}

interface PendingRequest {
  resolve: (response: PiRpcResponse) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

/**
 * Owns the JSONL conversation with one `pi --mode rpc` child process: command
 * write, response correlation by id, and fan-out of agent events.
 */
export class PiRpcClient {
  private nextId = 1;
  private closed = false;
  private readonly pending = new Map<string, PendingRequest>();
  private readonly eventListeners = new Set<(event: PiAgentEvent) => void>();
  private extensionRequestHandler?: (request: PiExtensionUiRequest) => void;
  private readonly extensionErrorListeners = new Set<
    (error: PiExtensionError) => void
  >();
  private readonly detach: () => void;

  constructor(private readonly proc: ChildProcess) {
    if (!proc.stdout) {
      throw new Error("pi RPC process has no stdout");
    }
    this.detach = attachJsonlLineReader(proc.stdout, (line) =>
      this.onLine(line),
    );
    proc.once("exit", () => this.handleExit());
    // Spawn errors and asynchronous pipe failures must reject the same pending
    // commands as exit. Keep an error listener on the pipe until it closes;
    // write callbacks and the stream can report the same EPIPE.
    const transportError = (error: Error) => {
      this.handleExit(error);
      if (proc.pid && proc.exitCode === null && proc.signalCode === null) {
        proc.kill("SIGTERM");
      }
    };
    proc.once("error", transportError);
    proc.stdin?.on("error", transportError);
  }

  private onLine(line: string): void {
    if (!line.trim()) return;
    let parsed: PiRpcResponse | PiAgentEvent | PiExtensionUiRequest;
    try {
      parsed = JSON.parse(line);
    } catch {
      getLogger().warn(
        { line: line.slice(0, 200) },
        "pi RPC: ignoring unparseable stdout line",
      );
      return;
    }

    if (parsed.type === "response") {
      const response = parsed as PiRpcResponse;
      const pending = response.id ? this.pending.get(response.id) : undefined;
      if (pending && response.id) {
        this.pending.delete(response.id);
        clearTimeout(pending.timer);
        pending.resolve(response);
      }
      // A response without a matching pending entry is an async prompt ack
      // (success arrives after preflight, events follow); nothing to resolve.
      return;
    }

    if (parsed.type === "extension_ui_request") {
      this.extensionRequestHandler?.(parsed as PiExtensionUiRequest);
      return;
    }

    if (parsed.type === "extension_error") {
      getLogger().warn({ event: parsed }, "pi RPC: extension error");
      for (const listener of this.extensionErrorListeners) {
        listener(parsed as PiExtensionError);
      }
      return;
    }

    for (const listener of this.eventListeners) {
      listener(parsed as PiAgentEvent);
    }
  }

  private handleExit(error = new Error("pi RPC process exited")): void {
    if (this.closed) return;
    this.closed = true;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    this.detach();
  }

  /** Subscribe to agent events; returns an unsubscribe function. */
  subscribe(listener: (event: PiAgentEvent) => void): () => void {
    this.eventListeners.add(listener);
    return () => this.eventListeners.delete(listener);
  }

  /** Observe extension failures; returns an unsubscribe function. */
  onExtensionError(listener: (error: PiExtensionError) => void): () => void {
    this.extensionErrorListeners.add(listener);
    return () => this.extensionErrorListeners.delete(listener);
  }

  /** Register the single handler for extension UI requests (permission bridge). */
  onExtensionRequest(handler: (request: PiExtensionUiRequest) => void): void {
    this.extensionRequestHandler = handler;
  }

  /** Send a command without awaiting a correlated response (e.g. `prompt`). */
  notify(command: PiCommand): void {
    this.write(command);
  }

  /** Send a command and await its correlated `response` line. */
  request(command: PiCommand, timeoutMs = 15000): Promise<PiRpcResponse> {
    if (this.closed) {
      return Promise.reject(new Error("pi RPC process is not running"));
    }
    const id = `ya-${this.nextId++}`;
    return new Promise<PiRpcResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`pi RPC command '${command.type}' timed out`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.write({ ...command, id });
      } catch (error) {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  /** Reply to a pending extension UI request. */
  sendExtensionResponse(response: {
    type: "extension_ui_response";
    id: string;
    [key: string]: unknown;
  }): void {
    this.write(response);
  }

  private write(obj: unknown): void {
    const stdin = this.proc.stdin;
    if (!stdin?.writable) {
      throw new Error("pi RPC stdin is not writable");
    }
    stdin.write(`${JSON.stringify(obj)}\n`, (error) => {
      if (error) this.handleExit(error);
    });
  }
}
