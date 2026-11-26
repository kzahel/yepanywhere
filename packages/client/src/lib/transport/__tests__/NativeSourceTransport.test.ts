import { afterEach, describe, expect, it, vi } from "vitest";
import { File as NodeFile } from "node:buffer";
import { NativeSourceTransport } from "../NativeSourceTransport";
import { NativeTransportFixture } from "./nativeTransportFixture";

const transports: NativeSourceTransport[] = [];
async function setup(binary = true, responseStreams = false) {
  const host = new NativeTransportFixture(binary, "CONNECTED", responseStreams);
  const transport = new NativeSourceTransport(host.channel);
  transports.push(transport);
  await transport.ready;
  await vi.waitFor(() =>
    expect(transport.status.getSnapshot().state).toBe("ready"),
  );
  return { host, transport };
}
afterEach(() => {
  for (const transport of transports.splice(0)) transport.dispose();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("native source transport", () => {
  it.each([
    ["CONNECTED", "ready"],
    ["CONNECTING", "reconnecting"],
    ["RETRYING", "reconnecting"],
  ])(
    "ignores a recovery failure after native reports %s",
    async (phase, state) => {
      const { host, transport } = await setup();
      let fail!: (error: Error) => void;
      host.handler = () =>
        new Promise((_, reject) => {
          fail = reject;
        });
      const recovery = transport.reconnect();
      const rejected = expect(recovery).rejects.toThrow("old recovery");
      await vi.waitFor(() => expect(host.commands).toHaveLength(1));
      await host.emit({ type: "state", phase, recoverable: true });
      const current = transport.status.getSnapshot();
      fail(new Error("old recovery"));
      await rejected;
      expect(transport.status.getSnapshot()).toBe(current);
      expect(current.state).toBe(state);
      window.dispatchEvent(new Event("online"));
      expect(host.commands).toHaveLength(1);
    },
  );

  it("does not promote a newer native retry when an earlier recovery succeeds", async () => {
    const { host, transport } = await setup();
    let finish!: () => void;
    host.handler = () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      });
    const recovery = transport.reconnect();
    await vi.waitFor(() => expect(host.commands).toHaveLength(1));
    await host.emit({ type: "state", phase: "RETRYING", recoverable: true });
    finish();
    await recovery;
    expect(transport.status.getSnapshot().state).toBe("reconnecting");
    await host.emit({ type: "state", phase: "CONNECTED", recoverable: false });
    expect(transport.status.getSnapshot().state).toBe("ready");
  });

  it("keeps Android retry exhaustion recoverable and soon asks for one more attempt", async () => {
    const { host, transport } = await setup();
    vi.useFakeTimers();
    await host.emit({ type: "state", phase: "FAILED", recoverable: true });
    expect(transport.status.getSnapshot().state).toBe("reconnecting");
    await vi.advanceTimersByTimeAsync(9_999);
    expect(host.commands).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(
      host.commands.map(({ method, params }) => ({ method, params })),
    ).toEqual([{ method: "reconnect", params: { retry: false } }]);
    expect(transport.status.getSnapshot().state).toBe("ready");
  });

  it("starts the recovery ramp over when the document returns from suspension", async () => {
    const { host } = await setup();
    vi.useFakeTimers();
    const exhausted = { type: "state", phase: "FAILED", recoverable: true };
    host.handler = async () => {
      await host.emit(exhausted);
      throw new Error("offline");
    };
    await host.emit(exhausted);
    // The first wait is 10 seconds and the second 20.
    await vi.advanceTimersByTimeAsync(10_000);
    expect(host.commands).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(host.commands).toHaveLength(1);
    await host.emit({ type: "state", phase: "SUSPENDED" });
    await host.emit(exhausted);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(host.commands).toHaveLength(2);
  });

  it("uses native network restoration once and ignores it while suspended", async () => {
    const { host, transport } = await setup();
    await host.emit({ type: "state", phase: "SUSPENDED" });
    await host.emit({ type: "networkAvailable" });
    expect(host.commands).toHaveLength(0);
    await host.emit({ type: "state", phase: "FAILED", recoverable: true });
    let finish!: () => void;
    host.handler = () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      });
    await host.emit({ type: "networkAvailable" });
    await host.emit({ type: "networkAvailable" });
    await vi.waitFor(() => expect(host.commands).toHaveLength(1));
    window.dispatchEvent(new Event("online"));
    expect(host.commands).toHaveLength(1);
    finish();
    await vi.waitFor(() =>
      expect(transport.status.getSnapshot().state).toBe("ready"),
    );
  });

  it("does not retry a native verification failure or turn it into sign-in", async () => {
    const { host, transport } = await setup();
    vi.useFakeTimers();
    const signIn = vi.fn();
    transport.onAuthenticationRequired = signIn;
    await host.emit({ type: "state", phase: "FAILED", recoverable: false });
    await host.emit({ type: "networkAvailable" });
    window.dispatchEvent(new Event("online"));
    window.dispatchEvent(new Event("offline"));
    document.dispatchEvent(new Event("visibilitychange"));
    await vi.advanceTimersByTimeAsync(120_000);
    expect(transport.status.getSnapshot().state).toBe("disconnected");
    expect(host.commands).toHaveLength(0);
    expect(signIn).not.toHaveBeenCalled();
  });

  it("ignores an old native failure after the state event already retried its read", async () => {
    const { host, transport } = await setup();
    let reads = 0;
    host.handler = () => {
      if (++reads === 1) return new Promise(() => {});
      return { status: 200, body: { recovered: true } };
    };
    const request = transport.fetch("/projects");
    await vi.waitFor(() => expect(host.commands).toHaveLength(1));
    const oldId = host.commands[0]?.id;
    await host.emit({ type: "state", phase: "RETRYING" });
    await host.emit({ type: "state", phase: "CONNECTED" });
    await expect(request).resolves.toEqual({ recovered: true });
    await host.emit({
      type: "reply",
      id: oldId,
      error: "Native connection unavailable",
      errorCode: "CONNECTION_UNAVAILABLE",
    });
    expect(transport.status.getSnapshot().state).toBe("ready");
    expect(reads).toBe(2);
  });

  it("does not retry an abandoned read when its delayed native error arrives", async () => {
    const { host, transport } = await setup();
    host.handler = () => new Promise(() => {});
    const controller = new AbortController();
    const request = transport.fetch("/projects", { signal: controller.signal });
    const rejected = expect(request).rejects.toMatchObject({
      name: "AbortError",
    });
    await vi.waitFor(() => expect(host.commands).toHaveLength(1));
    const id = host.commands[0]?.id;
    controller.abort();
    await rejected;
    await host.emit({
      type: "reply",
      id,
      error: "Native connection unavailable",
      errorCode: "CONNECTION_UNAVAILABLE",
    });
    expect(transport.status.getSnapshot().state).toBe("ready");
    expect(
      host.commands.filter((command) => command.method === "request"),
    ).toHaveLength(1);
  });

  it("waits for native recovery when a typed request failure precedes the state event", async () => {
    const { host, transport } = await setup();
    let reads = 0;
    host.handler = () => {
      reads++;
      if (reads === 1) return new Promise(() => {});
      return { status: 200, body: { recovered: true } };
    };
    const request = transport.fetch("/projects");
    const result = expect(request).resolves.toEqual({ recovered: true });
    await vi.waitFor(() => expect(host.commands).toHaveLength(1));
    await host.emit({
      type: "reply",
      id: host.commands[0]?.id,
      error: "Native connection unavailable",
      errorCode: "CONNECTION_UNAVAILABLE",
    });
    await vi.waitFor(() =>
      expect(transport.status.getSnapshot().state).toBe("reconnecting"),
    );
    expect(reads).toBe(1);
    await host.emit({ type: "state", phase: "RETRYING" });
    await host.emit({ type: "state", phase: "CONNECTED" });
    await result;
    expect(reads).toBe(2);
  });

  it.each(["POST", "PUT", "DELETE"])(
    "does not replay an interrupted %s",
    async (method) => {
      const { host, transport } = await setup();
      host.handler = () => new Promise(() => {});
      const request = transport.fetch("/projects", { method });
      const result = expect(request).rejects.toMatchObject({
        name: "ConnectionReconnectingError",
      });
      await vi.waitFor(() => expect(host.commands).toHaveLength(1));
      await host.emit({
        type: "reply",
        id: host.commands[0]?.id,
        error: "Native connection unavailable",
        errorCode: "CONNECTION_UNAVAILABLE",
      });
      await result;
      await host.emit({ type: "state", phase: "CONNECTED" });
      expect(
        host.commands.filter((command) => command.method === "request"),
      ).toHaveLength(1);
    },
  );

  it.each([
    "TIMEOUT",
    "OVERFLOW",
    "INVALID_MESSAGE",
    "REAUTHENTICATION_REQUIRED",
    "FUTURE_CODE",
  ])(
    "preserves %s without treating it as a server response or reconnecting",
    async (code) => {
      const { host, transport } = await setup();
      host.handler = () => new Promise(() => {});
      const request = transport.fetch("/projects");
      const result = expect(request).rejects.toMatchObject({
        code,
        message: "Native operation failed",
      });
      await vi.waitFor(() => expect(host.commands).toHaveLength(1));
      await host.emit({
        type: "reply",
        id: host.commands[0]?.id,
        error: "Native operation failed",
        errorCode: code,
      });
      await result;
      expect(transport.status.getSnapshot().state).toBe("ready");
      expect(host.commands).toHaveLength(1);
    },
  );

  it("preserves genuine server 503 responses without retrying them", async () => {
    const { host, transport } = await setup();
    host.handler = () => ({
      status: 503,
      body: { error: "Server maintenance" },
    });
    await expect(transport.fetch("/projects")).rejects.toThrow(
      "API error: 503: Server maintenance",
    );
    expect(host.commands).toHaveLength(1);
    expect(transport.status.getSnapshot().state).toBe("ready");
  });

  it("does not expire frame credit while the WebView is hidden", async () => {
    const { host, transport } = await setup();
    vi.useFakeTimers();
    const hidden = vi.spyOn(document, "hidden", "get").mockReturnValue(false);
    const original = host.channel.postMessage;
    let frame: string | ArrayBuffer | undefined;
    host.channel.postMessage = (value) => {
      frame = value;
    };
    const send = transport.bridge.send(
      1,
      new TextEncoder().encode(
        JSON.stringify({
          handle: "document-one",
          method: "cancel",
          id: "one",
          params: { id: "none" },
        }),
      ),
    );
    await vi.advanceTimersByTimeAsync(1);
    hidden.mockReturnValue(true);
    document.dispatchEvent(new Event("visibilitychange"));
    await vi.advanceTimersByTimeAsync(120_000);
    expect(host.channel.onmessage).not.toBeNull();
    hidden.mockReturnValue(false);
    document.dispatchEvent(new Event("visibilitychange"));
    host.channel.postMessage = original;
    if (frame === undefined) throw new Error("No frame was sent");
    original(frame);
    await send;
    expect(transport.status.getSnapshot().state).toBe("ready");
  });

  it("suspends demand without closing the document bridge and resumes in place", async () => {
    const { host, transport } = await setup();
    const descriptor = transport.bridge.descriptor;
    let complete!: (value: unknown) => void;
    host.handler = () =>
      new Promise((resolve) => {
        complete = resolve;
      });
    const request = transport.fetch("/projects");
    await vi.waitFor(() => expect(host.commands).toHaveLength(1));
    await host.emit({ type: "state", phase: "SUSPENDED" });
    expect(transport.status.getSnapshot().state).toBe("reconnecting");
    window.dispatchEvent(new Event("online"));
    window.dispatchEvent(new Event("focus"));
    await expect(transport.reconnect()).rejects.toThrow();
    expect(host.commands).toHaveLength(1);
    complete({ status: 200, body: { stale: true } });
    host.handler = () => ({ status: 200, body: { recovered: true } });
    await host.emit({ type: "state", phase: "CONNECTING" });
    await host.emit({ type: "state", phase: "CONNECTED" });
    await expect(request).resolves.toEqual({ recovered: true });
    expect(transport.bridge.descriptor).toBe(descriptor);
    await expect(transport.fetch("/projects")).resolves.toEqual({
      recovered: true,
    });
  });

  it("recovers an exhausted cold connection on online and coalesces input signals", async () => {
    const { host, transport } = await setup();
    let finish!: () => void;
    host.handler = () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      });
    await host.emit({ type: "state", phase: "FAILED" });
    window.dispatchEvent(new Event("online"));
    window.dispatchEvent(new Event("focus"));
    document.dispatchEvent(new Event("pointerdown"));
    await vi.waitFor(() => expect(host.commands).toHaveLength(1));
    expect(host.commands[0]?.method).toBe("reconnect");
    finish();
    await vi.waitFor(() =>
      expect(transport.status.getSnapshot().state).toBe("ready"),
    );
  });

  it("retains recovery demand arriving inside the five-second cooldown", async () => {
    const { host, transport } = await setup();
    vi.useFakeTimers();
    host.handler = () => {
      throw new Error("network still unavailable");
    };
    await expect(transport.reconnect()).rejects.toThrow(
      "network still unavailable",
    );
    await vi.advanceTimersByTimeAsync(1000);
    host.handler = async () => {
      await host.emit({ type: "state", phase: "CONNECTED" });
      return {};
    };
    window.dispatchEvent(new Event("online"));
    window.dispatchEvent(new Event("focus"));
    document.dispatchEvent(new Event("pointerdown"));
    await vi.advanceTimersByTimeAsync(3999);
    expect(host.commands).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(host.commands).toHaveLength(2);
    expect(transport.status.getSnapshot().state).toBe("ready");
  });

  it("cancels deferred demand while hidden and on disposal", async () => {
    const { host, transport } = await setup();
    vi.useFakeTimers();
    const hidden = vi.spyOn(document, "hidden", "get").mockReturnValue(false);
    host.handler = () => {
      throw new Error("offline");
    };
    await expect(transport.reconnect()).rejects.toThrow("offline");
    window.dispatchEvent(new Event("online"));
    hidden.mockReturnValue(true);
    document.dispatchEvent(new Event("visibilitychange"));
    await vi.advanceTimersByTimeAsync(5000);
    expect(host.commands).toHaveLength(1);
    hidden.mockReturnValue(false);
    host.handler = () => ({});
    document.dispatchEvent(new Event("visibilitychange"));
    await vi.advanceTimersByTimeAsync(1);
    expect(transport.status.getSnapshot().state).toBe("ready");
    host.handler = () => {
      throw new Error("offline again");
    };
    await expect(transport.reconnect()).rejects.toThrow("offline again");
    window.dispatchEvent(new Event("online"));
    const count = host.commands.length;
    transport.dispose();
    await vi.advanceTimersByTimeAsync(120000);
    expect(host.commands).toHaveLength(count);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("pauses exhausted recovery while hidden and stops it on disposal or rejection", async () => {
    const { host, transport } = await setup();
    vi.useFakeTimers();
    const hidden = vi.spyOn(document, "hidden", "get").mockReturnValue(true);
    await host.emit({ type: "state", phase: "FAILED" });
    await vi.advanceTimersByTimeAsync(120_000);
    expect(host.commands).toHaveLength(0);
    hidden.mockReturnValue(false);
    document.dispatchEvent(new Event("visibilitychange"));
    await vi.advanceTimersByTimeAsync(1);
    expect(host.commands).toHaveLength(1);
    await host.emit({ type: "state", phase: "REAUTHENTICATION_REQUIRED" });
    window.dispatchEvent(new Event("offline"));
    expect(transport.authenticationRequired).toBe(true);
    window.dispatchEvent(new Event("online"));
    await vi.advanceTimersByTimeAsync(120_000);
    expect(host.commands).toHaveLength(1);
    transport.dispose();
    window.dispatchEvent(new Event("online"));
    expect(vi.getTimerCount()).toBe(0);
  });
  it("retains unchanged phase snapshots while preserving authentication transitions", async () => {
    const { host, transport } = await setup();
    const changed = vi.fn();
    const authenticate = vi.fn();
    transport.status.subscribe(changed);
    transport.onAuthenticationRequired = authenticate;
    const connected = transport.status.getSnapshot();
    for (let index = 0; index < 20; index++) {
      await host.emit({ type: "state", phase: "CONNECTED" });
    }
    expect(transport.status.getSnapshot()).toBe(connected);
    expect(changed).not.toHaveBeenCalled();
    await host.emit({ type: "state", phase: "RETRYING" });
    const reconnecting = transport.status.getSnapshot();
    expect(reconnecting.state).toBe("reconnecting");
    await host.emit({ type: "state", phase: "RETRYING" });
    expect(transport.status.getSnapshot()).toBe(reconnecting);
    expect(changed).toHaveBeenCalledTimes(1);
    await host.emit({ type: "state", phase: "FAILED" });
    await host.emit({ type: "state", phase: "REAUTHENTICATION_REQUIRED" });
    await host.emit({ type: "state", phase: "REVOKED" });
    expect(transport.status.getSnapshot().state).toBe("disconnected");
    expect(authenticate).toHaveBeenCalledTimes(2);
  });
  it("waits for cold native demand instead of treating initial idle as terminal", async () => {
    const { host, transport } = await setup();
    await host.emit({ type: "state", phase: "IDLE" });
    const request = transport.fetch("/version");
    await Promise.resolve();
    expect(host.commands).toHaveLength(0);
    await host.emit({ type: "state", phase: "CONNECTED" });
    expect(await request).toEqual({ ok: true });
  });
  it("streams a 1 MiB attachment with credit and native upload handles", async () => {
    const { host, transport } = await setup();
    host.handler = (command) => {
      if (command.method === "uploadEnd") {
        void host.emit({
          type: "upload_complete",
          uploadId: (command.params as { uploadId: string }).uploadId,
          stagedRef: { id: "attachment-one" },
        });
      }
      return {};
    };
    const file = new NodeFile(
      [new Uint8Array(1024 * 1024)],
      "large.bin",
    ) as unknown as File;
    expect(await transport.uploadStagedAttachment(file)).toEqual({
      id: "attachment-one",
    });
    expect(
      host.chunks.reduce((total, chunk) => total + chunk.length - 24, 0),
    ).toBe(file.size);
    expect(host.chunks.every((chunk) => chunk.length <= 65_560)).toBe(true);
  });

  it("allows a progressing upload past two minutes but cancels a stalled one", async () => {
    const { host, transport } = await setup();
    vi.useFakeTimers();
    const file = new NodeFile(["attachment"], "test.txt") as unknown as File;
    let settled = false;
    const upload = transport.uploadStagedAttachment(file).then(
      (value) => {
        settled = true;
        return value;
      },
      (error: Error) => {
        settled = true;
        return error;
      },
    );
    await vi.waitFor(() =>
      expect(host.commands.at(-1)?.method).toBe("uploadEnd"),
    );
    const uploadId = (host.commands[0]!.params as { uploadId: string })
      .uploadId;
    for (const bytesReceived of [1, 2, 3]) {
      await vi.advanceTimersByTimeAsync(90_000);
      await host.emit({ type: "upload_progress", uploadId, bytesReceived });
      expect(settled).toBe(false);
    }
    // Repeated progress with no new bytes must not keep a stuck upload alive.
    await vi.advanceTimersByTimeAsync(90_000);
    await host.emit({ type: "upload_progress", uploadId, bytesReceived: 3 });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(await upload).toMatchObject({ message: "Native upload timed out" });
    expect(
      host.commands.some((command) => command.method === "uploadCancel"),
    ).toBe(true);
  });

  it("aborts an upload while native startup is pending", async () => {
    const { host, transport } = await setup();
    host.handler = (command) =>
      command.method === "uploadStart" ? new Promise(() => {}) : {};
    const controller = new AbortController();
    const file = new NodeFile(["attachment"], "test.txt") as unknown as File;
    const upload = transport.uploadStagedAttachment(file, {
      signal: controller.signal,
    });
    const rejected = expect(upload).rejects.toMatchObject({
      name: "AbortError",
    });
    await vi.waitFor(() =>
      expect(host.commands.at(-1)?.method).toBe("uploadStart"),
    );
    controller.abort();
    await rejected;
    await vi.waitFor(() =>
      expect(
        host.commands.some((command) => command.method === "uploadCancel"),
      ).toBe(true),
    );
    expect(host.chunks).toHaveLength(0);
  });

  it.each([true, false])(
    "enters a native source and carries large JSON with binary=%s",
    async (binary) => {
      const { host, transport } = await setup(binary);
      const body = { text: "x".repeat(1024 * 1024) };
      host.handler = () => ({
        status: 200,
        headers: { "content-type": "application/json" },
        body,
      });
      expect(await transport.fetch("/sessions")).toEqual(body);
      expect(host.commands[0]).toMatchObject({
        handle: "document-one",
        method: "request",
        params: { path: "/api/sessions" },
      });
      expect(transport.capabilities).toEqual({ sameOriginUrls: false });
      expect(
        localStorage.getItem("yep-anywhere-remote-credentials"),
      ).toBeNull();
    },
  );

  it.each([false, true])(
    "preserves redirects, binary media and API error status (streams=%s)",
    async (streams) => {
      const { host, transport } = await setup(true, streams);
      host.handler = (command) => {
        const path = (command.params as { path: string }).path;
        if (path === "/api/redirect")
          return {
            status: 302,
            headers: { Location: "/api/media" },
            body: null,
          };
        if (path === "/api/media")
          return {
            status: 200,
            headers: { "content-type": "image/png" },
            body: { _binary: true, data: btoa("png") },
          };
        return {
          status: 403,
          headers: { "X-Setup-Required": "true" },
          body: { error: "denied" },
        };
      };
      const response = await transport.fetchResponse("/redirect");
      expect(response.status).toBe(200);
      expect(await response.text()).toBe("png");
      await expect(transport.fetchResponse("/forbidden")).rejects.toMatchObject(
        {
          message: "API error: 403: denied",
          setupRequired: true,
          status: 403,
        },
      );
    },
  );

  it("cancels an abandoned native request and ignores its late reply", async () => {
    const { host, transport } = await setup();
    host.handler = () => new Promise(() => {});
    const controller = new AbortController();
    const request = transport.fetch("/slow", { signal: controller.signal });
    const rejected = expect(request).rejects.toMatchObject({
      name: "AbortError",
    });
    await vi.waitFor(() => expect(host.commands.length).toBe(1));
    controller.abort();
    await rejected;
    await vi.waitFor(() => expect(host.commands.at(-1)?.method).toBe("cancel"));
    expect(host.commands.at(-1)?.params).toEqual({ id: host.commands[0]?.id });
  });

  it("delivers native subscriptions and opens the native host picker", async () => {
    const { host, transport } = await setup();
    const onEvent = vi.fn();
    const subscription = transport.subscribeSession(
      "session-one",
      { onEvent },
      "event-4",
      { wantsLiveDeltas: true },
    );
    await vi.waitFor(() => expect(host.commands.length).toBe(1));
    const params = host.commands[0]?.params as { subscriptionId: string };
    await host.emit({
      type: "event",
      subscriptionId: params.subscriptionId,
      eventType: "text_delta",
      eventId: "event-5",
      data: { text: "Hello" },
    });
    expect(onEvent).toHaveBeenCalledWith("text_delta", "event-5", {
      text: "Hello",
    });
    subscription.close();
    await transport.switchHost();
    expect(
      host.commands.some((command) => command.method === "unsubscribe"),
    ).toBe(true);
    expect(host.commands.at(-1)?.method).toBe("switchHost");
  });
});
