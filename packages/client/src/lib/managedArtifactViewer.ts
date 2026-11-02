import {
  MANAGED_ARTIFACT_MAX_FILE_BYTES,
  MANAGED_ARTIFACT_MAX_VIEWER_BYTES,
  MANAGED_ARTIFACT_READ_IDLE_MS,
} from "@yep-anywhere/shared";
import type { SourceTransport } from "./transport/types";

export const ARTIFACT_PREVIEW_PROTOCOL = "yep-artifact-preview/1";
export const MANAGED_ARTIFACT_PARENTS = new Set([
  "https://yepanywhere.com",
  "https://latest.yepanywhere.com",
  "chrome-extension://dgeameddpnggdeenoekpiaacfghdodch",
]);
export interface ArtifactPreviewLease {
  id: string;
  entry: string;
  expiresAt: number;
}

export function managedArtifactUrl(viewer: string, parentOrigin: string) {
  return `https://artifact-${viewer}.yepanywhere.com/__ya/1/bootstrap.html?${new URLSearchParams({ viewer, parent: parentOrigin })}`;
}

let activeReaders = 0;
const waitingReads = new Set<{ canStart(): boolean; start(): void }>();
function drainReads() {
  for (const queued of waitingReads) {
    if (activeReaders >= 32) break;
    if (!queued.canStart()) continue;
    waitingReads.delete(queued);
    queued.start();
  }
}

/** One captured source and lease. Content can request relative GETs only. */
export function connectManagedArtifactViewer(options: {
  frame: HTMLIFrameElement;
  viewerId: string;
  lease: ArtifactPreviewLease;
  base: string;
  transport: SourceTransport;
  title: string;
  theme: "light" | "dark";
  widgetState: unknown;
  onWidgetState(state: unknown): void;
  onFollowUp(text: string): void;
  onReady(): void;
  onFailure(): void;
}) {
  const { frame, viewerId, lease, base, transport } = options;
  const origin = new URL(frame.src).origin;
  const channel = new MessageChannel();
  const requests = new Set<() => void>();
  let closed = false;
  let connected = false;
  let failed = false;
  let runningReaders = 0;
  let bytes = 0;
  let followUps = 0;
  let acknowledgeClose: (() => void) | undefined;
  const fail = () => {
    if (closed || failed) return;
    failed = true;
    clearTimeout(timer);
    clearTimeout(expiryTimer);
    for (const stop of [...requests]) stop();
    options.onFailure();
  };
  const timer = setTimeout(fail, 20000);
  const expiryTimer = setTimeout(
    fail,
    Math.max(0, lease.expiresAt - Date.now()),
  );
  const ready = (event: MessageEvent) => {
    if (
      closed ||
      failed ||
      connected ||
      event.source !== frame.contentWindow ||
      event.origin !== origin ||
      event.data?.protocol !== ARTIFACT_PREVIEW_PROTOCOL ||
      event.data.type !== "ready" ||
      event.data.viewerId !== viewerId
    )
      return;
    connected = true;
    frame.contentWindow?.postMessage(
      {
        protocol: ARTIFACT_PREVIEW_PROTOCOL,
        type: "connect",
        viewerId,
        entry: lease.entry,
        title: options.title,
        theme: options.theme,
        widgetState: options.widgetState,
      },
      origin,
      [channel.port2],
    );
  };
  window.addEventListener("message", ready);
  channel.port1.onmessage = (event) => {
    const message = event.data;
    if (message?.protocol !== ARTIFACT_PREVIEW_PROTOCOL) return;
    if (message.type === "closed") {
      acknowledgeClose?.();
      return;
    }
    if (closed || failed) {
      for (const port of event.ports) port.close();
      return;
    }
    if (message.type === "registered") {
      clearTimeout(timer);
      options.onReady();
      return;
    }
    if (message.type === "failed") {
      clearTimeout(timer);
      fail();
      return;
    }
    if (message.type === "widget-state") {
      try {
        if (JSON.stringify(message.state).length <= 65536)
          options.onWidgetState(message.state);
      } catch {
        /* Invalid or oversized state has no authority. */
      }
      return;
    }
    if (
      message.type === "followup" &&
      typeof message.text === "string" &&
      message.text.length > 0 &&
      message.text.length <= 8000 &&
      followUps < 8 &&
      navigator.userActivation?.isActive === true &&
      document.activeElement === frame
    ) {
      followUps++;
      options.onFollowUp(message.text);
      return;
    }
    if (message.type !== "read") return;
    const port = event.ports[0];
    if (!port) return;
    if (
      event.ports.length !== 1 ||
      message.viewerId !== viewerId ||
      typeof message.path !== "string" ||
      message.path.length > 4096 ||
      !message.path ||
      message.path.startsWith("/") ||
      message.path.includes("\\") ||
      message.path.includes("\0") ||
      message.path.split("/").some((p: string) => !p || p.startsWith(".")) ||
      (message.range != null &&
        (typeof message.range !== "string" ||
          !/^bytes=\d*-\d*$/.test(message.range)))
    ) {
      for (const extra of event.ports.slice(1)) extra.close();
      port.postMessage({ status: 403 });
      port.close();
      return;
    }
    if (waitingReads.size >= 256 || requests.size - runningReaders >= 64) {
      port.postMessage({ status: 429 });
      port.close();
      return;
    }
    const controller = new AbortController();
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    let finished = false;
    let started = false;
    let pulling = false;
    let fileBytes = 0;
    let length: number | undefined;
    const stop = () => {
      if (finished) return;
      finished = true;
      clearTimeout(deadline);
      requests.delete(stop);
      waitingReads.delete(queued);
      if (started) {
        activeReaders--;
        runningReaders--;
      }
      controller.abort();
      void reader?.cancel().catch(() => {});
      port.close();
      drainReads();
    };
    const queued = {
      canStart: () => !closed && !failed && runningReaders < 8,
      start: () => {
        started = true;
        activeReaders++;
        runningReaders++;
        void readFile();
      },
    };
    let deadline: ReturnType<typeof setTimeout>;
    const progress = () => {
      clearTimeout(deadline);
      deadline = setTimeout(() => {
        port.postMessage({ type: "error" });
        stop();
      }, MANAGED_ARTIFACT_READ_IDLE_MS);
    };
    progress();
    requests.add(stop);
    port.onmessage = async (event) => {
      if (finished) return;
      if (event.data?.type === "cancel") {
        stop();
        return;
      }
      if (event.data?.type !== "pull" || pulling || !reader) {
        port.postMessage({ type: "error" });
        stop();
        return;
      }
      pulling = true;
      try {
        const part = await reader.read();
        if (finished || closed) return;
        if (part.done) {
          if (length !== undefined && fileBytes !== length)
            throw new Error("Incomplete preview body");
          port.postMessage({ type: "end" });
          stop();
          return;
        }
        progress();
        fileBytes += part.value.byteLength;
        bytes += part.value.byteLength;
        if (
          fileBytes > (length ?? MANAGED_ARTIFACT_MAX_FILE_BYTES) ||
          bytes > MANAGED_ARTIFACT_MAX_VIEWER_BYTES
        )
          throw new Error("Preview byte limit");
        const buffer = part.value.slice().buffer;
        port.postMessage({ type: "chunk", bytes: buffer }, [buffer]);
      } catch {
        if (!finished) {
          port.postMessage({ type: "error" });
          stop();
        }
      } finally {
        pulling = false;
      }
    };
    const readFile = async () => {
      try {
        const init = {
          signal: controller.signal,
          headers: message.range ? { Range: message.range } : undefined,
        };
        const path = `${base}/${encodeURIComponent(lease.id)}/file?${new URLSearchParams({ path: message.path, download: "true" })}`;
        const response = await (transport.fetchStream
          ? transport.fetchStream(path, init)
          : transport.fetchResponse(path, init));
        if (closed || finished) {
          await response.body?.cancel();
          return;
        }
        if (![200, 206].includes(response.status)) {
          const refusal = await response.json().catch(() => null);
          const range = response.headers.get("content-range");
          port.postMessage({
            status: response.status >= 400 ? response.status : 502,
            ...(response.status === 416 && /^bytes \*\/\d+$/.test(range ?? "")
              ? { headers: { "content-range": range } }
              : {}),
          });
          stop();
          if (
            message.path === lease.entry ||
            refusal?.reason === "preview-unavailable"
          )
            fail();
          return;
        }
        const declared = response.headers.get("content-length");
        if (declared !== null) {
          length = Number(declared);
          if (
            !/^\d+$/.test(declared) ||
            !Number.isSafeInteger(length) ||
            length > MANAGED_ARTIFACT_MAX_FILE_BYTES
          )
            throw new Error("Invalid preview length");
        }
        progress();
        reader = (
          response.body ??
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.close();
            },
          })
        ).getReader();
        const headers: Record<string, string> = {};
        for (const name of [
          "content-range",
          "accept-ranges",
          "content-length",
        ]) {
          const value = response.headers.get(name);
          if (value) headers[name] = value;
        }
        port.postMessage({
          status: response.status,
          mime:
            response.headers.get("content-type") ?? "application/octet-stream",
          headers,
        });
      } catch (error) {
        if (!finished) {
          const status =
            error &&
            typeof error === "object" &&
            "status" in error &&
            typeof error.status === "number" &&
            error.status >= 400 &&
            error.status <= 599
              ? error.status
              : 502;
          const range =
            error instanceof Error &&
            "headers" in error &&
            error.headers instanceof Headers
              ? error.headers.get("content-range")
              : null;
          port.postMessage({
            status,
            ...(status === 416 && /^bytes \*\/\d+$/.test(range ?? "")
              ? { headers: { "content-range": range } }
              : {}),
          });
          stop();
          if (
            message.path === lease.entry ||
            (error &&
              typeof error === "object" &&
              "reason" in error &&
              error.reason === "preview-unavailable")
          )
            fail();
        }
      }
    };
    waitingReads.add(queued);
    drainReads();
  };
  return async () => {
    if (closed) return;
    closed = true;
    clearTimeout(timer);
    clearTimeout(expiryTimer);
    window.removeEventListener("message", ready);
    for (const stop of [...requests]) stop();
    // The bootstrap also unregisters on pagehide when its React frame is removed.
    if (connected && frame.isConnected) {
      let closeTimer: ReturnType<typeof setTimeout> | undefined;
      await new Promise<void>((resolve) => {
        acknowledgeClose = resolve;
        closeTimer = setTimeout(resolve, 1000);
        channel.port1.postMessage({
          protocol: ARTIFACT_PREVIEW_PROTOCOL,
          type: "close",
        });
      });
      clearTimeout(closeTimer);
    }
    channel.port1.close();
    channel.port2.close();
  };
}
