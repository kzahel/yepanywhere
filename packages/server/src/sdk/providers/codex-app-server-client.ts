import { type ChildProcess, execFile, spawn } from "node:child_process";
import type { SessionSandboxRuntime } from "../../session-sandbox.js";
import type { ProviderActivitySnapshot } from "../types.js";
import type {
  JsonRpcError,
  JsonRpcId,
  JsonRpcNotification,
  JsonRpcServerRequest,
} from "./codex-json-rpc.js";
import { log } from "./codex-log.js";

const APP_SERVER_SHUTDOWN_GRACE_MS = 1500;

const APP_SERVER_FORCE_KILL_WAIT_MS = 1000;

const APP_SERVER_EXIT_POLL_MS = 25;

interface CodexNotificationReceipt {
  sequence: number;
  receivedAtMs: number;
  queuedAhead: number;
  source: "provider" | "synthetic";
}

function isProcessTargetRunning(target: number): boolean {
  try {
    process.kill(target, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") {
      return false;
    }
    if ((error as NodeJS.ErrnoException).code === "EPERM") {
      return true;
    }
    throw error;
  }
}

async function waitForProcessTargetExit(
  target: number,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (isProcessTargetRunning(target)) {
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) {
      return false;
    }
    await new Promise<void>((resolve) =>
      setTimeout(resolve, Math.min(APP_SERVER_EXIT_POLL_MS, remainingMs)),
    );
  }
  return true;
}

export async function terminateChildProcess(
  child: ChildProcess | null | undefined,
  graceMs = APP_SERVER_SHUTDOWN_GRACE_MS,
): Promise<void> {
  if (!child?.pid) {
    return;
  }
  const pid = child.pid;
  const killTarget = process.platform === "win32" ? pid : -pid;
  if (!isProcessTargetRunning(killTarget)) {
    return;
  }

  if (process.platform === "win32") {
    const taskkill = new Promise<void>((resolve) => {
      execFile("taskkill", ["/pid", String(pid), "/T", "/F"], () => resolve());
    });
    await Promise.race([
      taskkill,
      new Promise<void>((resolve) => setTimeout(resolve, graceMs)),
    ]);
    if (!(await waitForProcessTargetExit(pid, APP_SERVER_FORCE_KILL_WAIT_MS))) {
      throw new Error(`Failed to terminate Codex app-server PID ${pid}`);
    }
    return;
  }

  try {
    process.kill(killTarget, "SIGTERM");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") {
      return;
    }
    throw error;
  }

  if (await waitForProcessTargetExit(killTarget, graceMs)) {
    return;
  }

  try {
    process.kill(killTarget, "SIGKILL");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") {
      return;
    }
    throw error;
  }

  if (
    !(await waitForProcessTargetExit(killTarget, APP_SERVER_FORCE_KILL_WAIT_MS))
  ) {
    throw new Error(`Failed to terminate Codex app-server PID ${pid}`);
  }
}

class AsyncQueue<T> {
  private items: T[] = [];
  private waiters: Array<{
    resolve: (value: T) => void;
    reject: (error: Error) => void;
    signal?: AbortSignal;
    onAbort?: () => void;
  }> = [];
  private closedError: Error | null = null;

  get size(): number {
    return this.items.length;
  }

  push(item: T): void {
    if (this.closedError) return;
    const waiter = this.waiters.shift();
    if (waiter) {
      if (waiter.signal && waiter.onAbort) {
        waiter.signal.removeEventListener("abort", waiter.onAbort);
      }
      waiter.resolve(item);
      return;
    }
    this.items.push(item);
  }

  close(error?: Error): void {
    if (this.closedError) return;
    this.closedError = error ?? new Error("Queue closed");
    for (const waiter of this.waiters) {
      if (waiter.signal && waiter.onAbort) {
        waiter.signal.removeEventListener("abort", waiter.onAbort);
      }
      waiter.reject(this.closedError);
    }
    this.waiters = [];
    this.items = [];
  }

  async shift(signal?: AbortSignal): Promise<T> {
    if (this.items.length > 0) {
      const item = this.items.shift();
      if (item === undefined) {
        throw new Error("Queue underflow");
      }
      return item;
    }

    if (this.closedError) {
      throw this.closedError;
    }

    return await new Promise<T>((resolve, reject) => {
      const waiter: {
        resolve: (value: T) => void;
        reject: (error: Error) => void;
        signal?: AbortSignal;
        onAbort?: () => void;
      } = { resolve, reject, signal };

      if (signal) {
        const onAbort = () => {
          this.waiters = this.waiters.filter((w) => w !== waiter);
          reject(new Error("Operation aborted"));
        };
        waiter.onAbort = onAbort;
        signal.addEventListener("abort", onAbort, { once: true });
      }

      this.waiters.push(waiter);
    });
  }
}

type AppServerRequestHandler = (
  request: JsonRpcServerRequest,
) => Promise<unknown>;

export class CodexAppServerClient {
  private process: ChildProcess | null = null;
  private stdoutBuffer = "";
  private closePromise: Promise<void> | null = null;
  private notificationReceiptSequence = 0;
  private readonly notificationReceipts = new WeakMap<
    JsonRpcNotification,
    CodexNotificationReceipt
  >();

  /** OS PID of the spawned app-server child process */
  get pid(): number | undefined {
    return this.process?.pid;
  }

  isAlive(): boolean {
    const child = this.process;
    if (!child?.pid) return false;
    const target = process.platform === "win32" ? child.pid : -child.pid;
    return isProcessTargetRunning(target);
  }
  private nextRequestId = 1;
  private readonly pendingRequests = new Map<
    JsonRpcId,
    {
      resolve: (result: unknown) => void;
      reject: (error: Error) => void;
    }
  >();
  private readonly notifications = new AsyncQueue<JsonRpcNotification>();
  private onServerRequest: AppServerRequestHandler | null = null;
  private notificationObserver:
    | ((notification: JsonRpcNotification) => void)
    | null = null;
  private closed = false;
  private lastRawProviderEventAt: Date | null = null;
  private lastRawProviderEventSource: string | null = null;

  constructor(
    private readonly command: string,
    private readonly cwd: string,
    private readonly env: NodeJS.ProcessEnv,
    private readonly shouldSuppressNotification?: (
      notification: JsonRpcNotification,
    ) => boolean,
    private readonly sessionSandbox?: SessionSandboxRuntime,
    private readonly launchArguments: string[] = [],
  ) {}

  get isClosed(): boolean {
    return this.closed;
  }

  get lastNotificationReceiptSequence(): number {
    return this.notificationReceiptSequence;
  }

  getNotificationReceipt(
    notification: JsonRpcNotification,
  ): CodexNotificationReceipt | null {
    return this.notificationReceipts.get(notification) ?? null;
  }

  setServerRequestHandler(handler: AppServerRequestHandler): void {
    this.onServerRequest = handler;
  }

  /**
   * See every provider notification on arrival, including the ones that
   * reach the queue only when the next turn reads it.
   */
  setNotificationObserver(
    observer: ((notification: JsonRpcNotification) => void) | null,
  ): void {
    this.notificationObserver = observer;
  }

  getProviderActivity(): ProviderActivitySnapshot {
    return {
      lastRawProviderEventAt: this.lastRawProviderEventAt,
      lastRawProviderEventSource: this.lastRawProviderEventSource,
    };
  }

  async connect(): Promise<void> {
    if (this.process) {
      throw new Error("Codex app-server already connected");
    }

    const commandArgs = [
      "app-server",
      "--listen",
      "stdio://",
      ...this.launchArguments,
    ];
    const sandboxed = this.sessionSandbox?.wrapSpawn(
      this.command,
      commandArgs,
      this.env,
    );
    const child = (() => {
      try {
        return spawn(
          sandboxed?.command ?? this.command,
          sandboxed?.args ?? commandArgs,
          {
            cwd: sandboxed?.cwd ?? this.cwd,
            detached: process.platform !== "win32",
            stdio: sandboxed?.stdio ?? ["pipe", "pipe", "pipe"],
            env: sandboxed?.env ?? this.env,
            shell: sandboxed
              ? false
              : process.platform === "win32" &&
                !this.command.toLowerCase().endsWith(".exe"),
          },
        );
      } finally {
        sandboxed?.release();
      }
    })();

    this.process = child;

    child.stdout?.on("data", (chunk: Buffer) => {
      this.stdoutBuffer += chunk.toString("utf-8");
      const lines = this.stdoutBuffer.split("\n");
      this.stdoutBuffer = lines.pop() ?? "";
      for (const raw of lines) {
        const line = raw.trim();
        if (!line) continue;
        this.handleJsonRpcLine(line);
      }
    });

    child.stderr?.on("data", (chunk: Buffer) => {
      const stderr = chunk.toString("utf-8").trim();
      if (stderr) {
        log.debug({ stderr }, "codex app-server stderr");
      }
    });

    child.on("error", (error) => {
      this.handleProcessClose(error);
    });

    child.on("exit", (code, signal) => {
      this.handleProcessClose(
        new Error(
          `Codex app-server exited (code=${code ?? "null"}, signal=${signal ?? "null"})`,
        ),
      );
    });

    await new Promise<void>((resolve, reject) => {
      const onSpawn = () => {
        child.off("error", onError);
        resolve();
      };
      const onError = (error: Error) => {
        child.off("spawn", onSpawn);
        reject(error);
      };
      child.once("spawn", onSpawn);
      child.once("error", onError);
    });
  }

  private handleJsonRpcLine(line: string): void {
    let message: Record<string, unknown>;
    try {
      message = JSON.parse(line) as Record<string, unknown>;
    } catch {
      log.debug({ line }, "Ignoring non-JSON app-server line");
      return;
    }

    const method =
      typeof message.method === "string" ? (message.method as string) : null;
    const hasId =
      typeof message.id === "string" || typeof message.id === "number";

    // Server request/notification
    if (method) {
      if (hasId) {
        this.recordRawProviderEvent(`codex:request:${method}`);
        const request: JsonRpcServerRequest = {
          id: message.id as JsonRpcId,
          method,
          params: message.params,
        };
        this.handleServerRequest(request);
        return;
      }

      const notification = { method, params: message.params };
      try {
        this.notificationObserver?.(notification);
      } catch (error) {
        log.debug({ error, method }, "Codex notification observer failed");
      }
      if (this.shouldSuppressNotification?.(notification)) {
        return;
      }

      this.recordRawProviderEvent(`codex:notification:${method}`);
      this.enqueueNotification(notification, "provider");
      return;
    }

    // Response to our request
    if (hasId) {
      const id = message.id as JsonRpcId;
      const pending = this.pendingRequests.get(id);
      if (!pending) {
        return;
      }
      this.pendingRequests.delete(id);

      if (message.error && typeof message.error === "object") {
        const error = message.error as JsonRpcError;
        const rpcError = new Error(error.message ?? "JSON-RPC request failed");
        Object.assign(rpcError, {
          jsonRpcCode: error.code,
          jsonRpcData: error.data,
          jsonRpcRequestId: id,
        });
        pending.reject(rpcError);
        return;
      }

      pending.resolve(message.result);
    }
  }

  private handleServerRequest(request: JsonRpcServerRequest): void {
    const respond = (payload: Record<string, unknown>) => {
      this.sendRaw({
        jsonrpc: "2.0",
        id: request.id,
        ...payload,
      });
    };

    if (!this.onServerRequest) {
      respond({
        error: {
          code: -32601,
          message: `Unhandled server request: ${request.method}`,
        },
      });
      return;
    }

    void this.onServerRequest(request)
      .then((result) => {
        respond({ result: result ?? {} });
      })
      .catch((error) => {
        respond({
          error: {
            code: -32000,
            message:
              error instanceof Error ? error.message : "Server request failed",
          },
        });
      });
  }

  async request<T>(method: string, params?: unknown): Promise<T> {
    if (this.closed) {
      throw new Error("Codex app-server client is closed");
    }

    const id = this.nextRequestId++;

    const resultPromise = new Promise<T>((resolve, reject) => {
      this.pendingRequests.set(id, {
        resolve: (result) => resolve(result as T),
        reject,
      });
    });

    this.sendRaw({
      jsonrpc: "2.0",
      id,
      method,
      params,
    });

    return await resultPromise;
  }

  notify(method: string, params?: unknown): void {
    this.sendRaw({
      jsonrpc: "2.0",
      method,
      ...(params === undefined ? {} : { params }),
    });
  }

  private recordRawProviderEvent(source: string): void {
    this.lastRawProviderEventAt = new Date();
    this.lastRawProviderEventSource = source;
  }

  injectNotification(notification: JsonRpcNotification): void {
    this.enqueueNotification(notification, "synthetic");
  }

  async nextNotification(signal?: AbortSignal): Promise<JsonRpcNotification> {
    return await this.notifications.shift(signal);
  }

  private enqueueNotification(
    notification: JsonRpcNotification,
    source: CodexNotificationReceipt["source"],
  ): void {
    const receipt = {
      sequence: ++this.notificationReceiptSequence,
      receivedAtMs: Date.now(),
      queuedAhead: this.notifications.size,
      source,
    } satisfies CodexNotificationReceipt;
    this.notificationReceipts.set(notification, receipt);
    this.notifications.push(notification);
  }

  async close(): Promise<void> {
    if (this.closePromise) {
      return await this.closePromise;
    }
    if (this.closed) return;
    this.closed = true;

    const closeError = new Error("Codex app-server client closed");
    for (const pending of this.pendingRequests.values()) {
      pending.reject(closeError);
    }
    this.pendingRequests.clear();
    this.notifications.close(closeError);

    const child = this.process;
    this.process = null;
    this.closePromise = terminateChildProcess(child);
    await this.closePromise;
  }

  private handleProcessClose(error: Error): void {
    if (this.closed) return;
    this.closed = true;

    for (const pending of this.pendingRequests.values()) {
      pending.reject(error);
    }
    this.pendingRequests.clear();

    // Emit a terminal error notification so consumers can surface it.
    this.enqueueNotification(
      {
        method: "error",
        params: {
          error: { message: error.message },
          willRetry: false,
          codexProcessExit: true,
        },
      },
      "synthetic",
    );
    this.notifications.close(error);
    this.process = null;
  }

  private sendRaw(payload: Record<string, unknown>): void {
    if (this.closed) {
      return;
    }

    try {
      if (!this.process?.stdin) return;
      this.process.stdin.write(`${JSON.stringify(payload)}\n`);
    } catch (error) {
      this.handleProcessClose(
        error instanceof Error
          ? error
          : new Error("Failed to write to codex app-server stdin"),
      );
    }
  }
}
