import { generateUUID } from "./uuid";
import { bytesToUuid } from "@yep-anywhere/shared";

export const NATIVE_FRAME_BYTES = 65_536;
export const NATIVE_MESSAGE_BYTES = 32 * 1024 * 1024;
const HEADER_BYTES = 16;

export interface NativeTransportChannel {
  postMessage(message: string | ArrayBuffer): void;
  onmessage: ((event: { data: string | ArrayBuffer }) => void) | null;
}

export interface NativeSourceDescriptor {
  handle: string;
  profileId: string;
  label: string;
  binary: boolean;
  responseStreams?: boolean;
  stateQuery?: boolean;
  packagedArtifactViewerVersion?: 1;
  isolatedHtmlPreview?: boolean;
}

/** Native operation failure, distinct from an HTTP response and bridge closure. */
export class NativeOperationError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "NativeOperationError";
  }
}

declare global {
  interface Window {
    yaNativeTransport?: NativeTransportChannel;
  }
}

export function encodeNativeFrame(
  kind: number,
  id: number,
  offset: number,
  total: number,
  data: Uint8Array,
): ArrayBuffer {
  if (
    ![1, 2, 3].includes(kind) ||
    id <= 0 ||
    offset < 0 ||
    total <= 0 ||
    total > NATIVE_MESSAGE_BYTES ||
    data.length === 0 ||
    data.length > NATIVE_FRAME_BYTES ||
    offset > total - data.length
  ) {
    throw new Error("Invalid native transport frame");
  }
  const frame = new ArrayBuffer(HEADER_BYTES + data.length);
  const header = new DataView(frame);
  header.setUint16(0, 0x5941);
  header.setUint8(2, 1);
  header.setUint8(3, kind);
  header.setUint32(4, id);
  header.setUint32(8, offset);
  header.setUint32(12, total);
  new Uint8Array(frame, HEADER_BYTES).set(data);
  return frame;
}

export class NativeFrameReceiver {
  private id = 1;
  private offset = 0;
  private kind = 0;
  private buffer: Uint8Array | null = null;

  accept(frame: ArrayBuffer): {
    id: number;
    offset: number;
    message?: Uint8Array;
  } {
    if (
      frame.byteLength <= HEADER_BYTES ||
      frame.byteLength > HEADER_BYTES + NATIVE_FRAME_BYTES
    )
      throw new Error("Invalid frame size");
    const header = new DataView(frame);
    const kind = header.getUint8(3),
      id = header.getUint32(4),
      offset = header.getUint32(8),
      total = header.getUint32(12);
    const data = new Uint8Array(frame, HEADER_BYTES);
    if (
      header.getUint16(0) !== 0x5941 ||
      header.getUint8(2) !== 1 ||
      ![1, 2, 3].includes(kind) ||
      id !== this.id ||
      offset !== this.offset ||
      total === 0 ||
      total > NATIVE_MESSAGE_BYTES ||
      offset > total - data.length
    ) {
      throw new Error("Invalid native frame sequence");
    }
    if (!this.buffer) {
      this.buffer = new Uint8Array(total);
      this.kind = kind;
    }
    if (this.buffer.length !== total || this.kind !== kind)
      throw new Error("Inconsistent native frame");
    this.buffer.set(data, offset);
    this.offset += data.length;
    const acknowledged = this.offset;
    if (this.offset !== total) return { id, offset: acknowledged };
    const message = this.buffer;
    this.buffer = null;
    this.offset = 0;
    this.id += 1;
    return { id, offset: acknowledged, message };
  }
}

function base64(bytes: Uint8Array): string {
  let text = "";
  for (let start = 0; start < bytes.length; start += 8192)
    text += String.fromCharCode(...bytes.subarray(start, start + 8192));
  return btoa(text);
}

/** Stop-and-wait credits bound both directions, including a slow native socket. */
export class NativeTransportBridge {
  readonly ready: Promise<NativeSourceDescriptor>;
  descriptor: NativeSourceDescriptor | null = null;
  onEvent: (message: Record<string, unknown>) => void = () => {};
  onClose: (error: Error) => void = () => {};
  private readonly receiver = new NativeFrameReceiver();
  private readonly pending = new Map<
    string,
    {
      resolve: (value: unknown) => void;
      reject: (error: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  private tail: Promise<void> = Promise.resolve();
  private queuedBytes = 0;
  private queuedMessages = 0;
  private nextId = 1;
  private closed = false;
  private ackTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly visibility = () => this.armAckTimeout();
  private armAckTimeout(): void {
    clearTimeout(this.ackTimer);
    this.ackTimer = undefined;
    if (!this.ack || document.hidden) return;
    this.ackTimer = setTimeout(
      () =>
        this.ack?.reject(new Error("Native frame acknowledgement timed out")),
      30_000,
    );
  }
  private ack: {
    value: string;
    resolve: () => void;
    reject: (error: Error) => void;
  } | null = null;
  private resolveReady!: (value: NativeSourceDescriptor) => void;
  private rejectReady!: (error: Error) => void;
  private readonly helloTimer: ReturnType<typeof setTimeout>;

  constructor(private readonly channel: NativeTransportChannel) {
    this.ready = new Promise((resolve, reject) => {
      this.resolveReady = resolve;
      this.rejectReady = reject;
    });
    this.helloTimer = setTimeout(
      () => this.close(new Error("Native source handshake timed out")),
      15_000,
    );
    document.addEventListener("visibilitychange", this.visibility);
    channel.onmessage = ({ data }) => {
      try {
        this.receive(data);
      } catch (error) {
        this.close(error instanceof Error ? error : new Error(String(error)));
      }
    };
    channel.postMessage(
      JSON.stringify({ type: "hello", protocol: 1, binary: true }),
    );
  }

  request<T>(
    method: string,
    params: unknown = {},
    signal?: AbortSignal,
    id = generateUUID(),
    timeoutMs = 30_000,
  ): Promise<T> {
    if (this.closed)
      return Promise.reject(new Error("Native source bridge is closed"));
    if (signal?.aborted)
      return Promise.reject(
        signal.reason ?? new DOMException("Aborted", "AbortError"),
      );
    if (this.pending.size >= 32 || this.pending.has(id))
      return Promise.reject(new Error("Native request limit exceeded"));
    return new Promise<T>((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
        this.pending.delete(id);
      };
      const abort = () => {
        cleanup();
        reject(signal?.reason ?? new DOMException("Aborted", "AbortError"));
        void this.sendCommand("cancel", { id }).catch(() => {});
      };
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error("Native request timed out"));
        void this.sendCommand("cancel", { id }).catch(() => {});
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (value) => {
          cleanup();
          resolve(value as T);
        },
        reject: (error) => {
          cleanup();
          reject(error);
        },
        timer,
      });
      signal?.addEventListener("abort", abort, { once: true });
      void this.sendCommand(method, params, id).catch((error: Error) => {
        this.pending.get(id)?.reject(error);
      });
    });
  }

  rejectPending(error: Error): void {
    for (const pending of [...this.pending.values()]) pending.reject(error);
  }

  cancelRequest(id: string): void {
    this.pending.get(id)?.reject(new DOMException("Aborted", "AbortError"));
    void this.sendCommand("cancel", { id }).catch(() => {});
  }

  private async sendCommand(
    method: string,
    params: unknown,
    id = generateUUID(),
  ): Promise<void> {
    const { handle } = await this.ready;
    if (method !== "cancel" && !this.pending.has(id)) return;
    return this.send(
      1,
      new TextEncoder().encode(JSON.stringify({ handle, id, method, params })),
    );
  }

  send(kind: number, bytes: Uint8Array): Promise<void> {
    if (
      this.closed ||
      bytes.length === 0 ||
      bytes.length > NATIVE_MESSAGE_BYTES ||
      this.queuedMessages >= 32 ||
      this.queuedBytes + bytes.length > 64 * 1024 * 1024
    ) {
      return Promise.reject(new Error("Native transport queue limit exceeded"));
    }
    this.queuedBytes += bytes.length;
    this.queuedMessages += 1;
    const task = this.tail
      .then(async () => {
        const descriptor = await this.ready;
        if (this.closed) throw new Error("Native bridge is closed");
        const id = this.nextId++;
        for (
          let offset = 0;
          offset < bytes.length;
          offset += NATIVE_FRAME_BYTES
        ) {
          const chunk = bytes.subarray(
            offset,
            Math.min(offset + NATIVE_FRAME_BYTES, bytes.length),
          );
          const frame = encodeNativeFrame(
            kind,
            id,
            offset,
            bytes.length,
            chunk,
          );
          await new Promise<void>((resolve, reject) => {
            this.ack = {
              value: `ack:${descriptor.handle}:${id}:${offset + chunk.length}`,
              resolve: () => {
                clearTimeout(this.ackTimer);
                resolve();
              },
              reject: (error) => {
                clearTimeout(this.ackTimer);
                reject(error);
              },
            };
            this.armAckTimeout();
            try {
              this.channel.postMessage(
                descriptor.binary
                  ? frame
                  : `frame:${base64(new Uint8Array(frame))}`,
              );
            } catch (error) {
              this.ack.reject(
                error instanceof Error ? error : new Error(String(error)),
              );
            }
          });
        }
      })
      .finally(() => {
        this.queuedBytes -= bytes.length;
        this.queuedMessages -= 1;
      });
    this.tail = task.catch((error: Error) => this.close(error));
    return task;
  }

  private receive(data: string | ArrayBuffer): void {
    if (this.closed) return;
    if (typeof data === "string" && data.startsWith("ack:")) {
      if (data !== this.ack?.value)
        throw new Error("Unexpected native acknowledgement");
      const ack = this.ack;
      this.ack = null;
      ack.resolve();
      return;
    }
    if (typeof data === "string" && !data.startsWith("frame:")) {
      const message = JSON.parse(data) as Record<string, unknown>;
      if (message.type === "fatal") throw new Error(String(message.error));
      if (
        message.type !== "hello" ||
        this.descriptor ||
        message.protocol !== 1 ||
        typeof message.handle !== "string" ||
        typeof message.profileId !== "string" ||
        typeof message.label !== "string" ||
        typeof message.binary !== "boolean"
      )
        throw new Error("Invalid native handshake");
      clearTimeout(this.helloTimer);
      this.descriptor = {
        handle: message.handle,
        profileId: message.profileId,
        label: message.label,
        binary: message.binary,
        ...(message.responseStreams === true ? { responseStreams: true } : {}),
        ...(message.stateQuery === true ? { stateQuery: true } : {}),
        ...(message.isolatedHtmlPreview === true
          ? { isolatedHtmlPreview: true }
          : {}),
        ...(message.packagedArtifactViewerVersion === 1
          ? { packagedArtifactViewerVersion: 1 as const }
          : {}),
      };
      this.resolveReady(this.descriptor);
      return;
    }
    if (!this.descriptor) throw new Error("Native handshake required");
    if (typeof data === "string" && data.length > 87500)
      throw new Error("Invalid native frame size");
    const frame =
      typeof data === "string"
        ? Uint8Array.from(atob(data.slice(6)), (char) => char.charCodeAt(0))
            .buffer
        : data;
    const result = this.receiver.accept(frame);
    this.channel.postMessage(
      `ack:${this.descriptor.handle}:${result.id}:${result.offset}`,
    );
    if (!result.message) return;
    if (new DataView(frame).getUint8(3) === 3) {
      if (
        result.message.length <= 16 ||
        result.message.length > 16 + 128 * 1024
      )
        throw new Error("Invalid native response chunk");
      const id = bytesToUuid(result.message.subarray(0, 16));
      this.pending.get(id)?.resolve(result.message.subarray(16));
      return;
    }
    const message = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(result.message),
    ) as Record<string, unknown>;
    if (message.type === "reply") {
      const pending = this.pending.get(String(message.id));
      if (message.error)
        pending?.reject(
          typeof message.errorCode === "string"
            ? new NativeOperationError(message.errorCode, String(message.error))
            : new Error(String(message.error)),
        );
      else pending?.resolve(message.result);
    } else this.onEvent(message);
  }

  close(error = new Error("Native source bridge disposed")): void {
    if (this.closed) return;
    if (this.descriptor) {
      try {
        this.channel.postMessage(`release:${this.descriptor.handle}`);
      } catch {
        /* The native document may already be gone. */
      }
    }
    this.closed = true;
    document.removeEventListener("visibilitychange", this.visibility);
    clearTimeout(this.ackTimer);
    clearTimeout(this.helloTimer);
    this.rejectReady(error);
    this.ack?.reject(error);
    this.ack = null;
    for (const pending of [...this.pending.values()]) pending.reject(error);
    this.pending.clear();
    this.channel.onmessage = null;
    this.onClose(error);
  }
}
