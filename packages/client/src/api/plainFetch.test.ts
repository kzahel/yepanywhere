import { afterEach, describe, expect, it, vi } from "vitest";
import {
  fetchPlainBlob,
  fetchPlainJSON,
  fetchPlainResponse,
} from "./plainFetch";
import {
  API_REQUEST_DEADLINE_MS,
  isRequestDeadlineError,
} from "./requestDeadline";

describe("fetchPlainJSON", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("sends desktop token and same-origin headers", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    await fetchPlainJSON("/projects", undefined, {
      desktopAuthToken: "desktop-secret",
      fetchImpl,
    });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] ?? [];
    expect(url).toBe("/api/projects");
    expect(init?.credentials).toBe("include");
    const headers = new Headers(init?.headers);
    expect(headers.get("content-type")).toBe("application/json");
    expect(headers.get("x-yep-anywhere")).toBe("true");
    expect(headers.get("x-yep-client-version")).toBe("unknown");
    expect(headers.get("x-desktop-token")).toBe("desktop-secret");
  });

  it("signals login-required and preserves setup-required on 401 responses", async () => {
    const onLoginRequired = vi.fn();
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ error: "login required" }), {
        status: 401,
        statusText: "Unauthorized",
        headers: {
          "content-type": "application/json",
          "X-Setup-Required": "true",
        },
      }),
    );

    await expect(
      fetchPlainJSON("/sessions", undefined, {
        fetchImpl,
        onLoginRequired,
      }),
    ).rejects.toMatchObject({
      message: "login required",
      status: 401,
      setupRequired: true,
    });
    expect(onLoginRequired).toHaveBeenCalledTimes(1);
  });

  it("does not signal login-required for auth endpoints", async () => {
    const onLoginRequired = vi.fn();
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ message: "bad password" }), {
        status: 401,
        statusText: "Unauthorized",
        headers: { "content-type": "application/json" },
      }),
    );

    await expect(
      fetchPlainJSON("/auth/login", undefined, {
        fetchImpl,
        onLoginRequired,
      }),
    ).rejects.toMatchObject({
      message: "bad password",
      status: 401,
    });
    expect(onLoginRequired).not.toHaveBeenCalled();
  });

  it("passes blob cache directives and caller headers to fetch", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response("png-bytes"));

    await fetchPlainBlob(
      "/local-image?path=%2Ftmp%2Fplot.png",
      {
        cache: "no-cache",
        headers: { "X-File-Probe": "current" },
      },
      { fetchImpl },
    );

    const [url, init] = fetchImpl.mock.calls[0] ?? [];
    expect(url).toBe("/api/local-image?path=%2Ftmp%2Fplot.png");
    expect(init?.cache).toBe("no-cache");
    expect(init?.credentials).toBe("include");
    const headers = new Headers(init?.headers);
    expect(headers.get("x-file-probe")).toBe("current");
    expect(headers.get("x-yep-anywhere")).toBe("true");
  });

  it("preserves conditional response status and validators without parsing a body", async () => {
    const etag = 'W/"file-generation"';
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        new Response(null, { status: 304, headers: { ETag: etag } }),
      );
    const response = await fetchPlainResponse(
      "/projects/p/files/raw?path=schema.json",
      {
        headers: { "If-None-Match": etag },
        cache: "no-store",
      },
      { fetchImpl },
    );
    expect(response.status).toBe(304);
    expect(response.headers.get("etag")).toBe(etag);
    expect(await response.text()).toBe("");
    expect(
      new Headers(fetchImpl.mock.calls[0]?.[1]?.headers).get("if-none-match"),
    ).toBe(etag);
  });

  it("gives a request without its own signal the shared deadline", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        new Response(JSON.stringify({ ok: true }), { status: 200 }),
      );

    await fetchPlainJSON("/projects", undefined, { fetchImpl });

    const signal = fetchImpl.mock.calls[0]?.[1]?.signal;
    expect(signal).toBeInstanceOf(AbortSignal);
    expect(signal?.aborted).toBe(false);
  });

  it("leaves cancellation to a caller that brought its own signal", async () => {
    const controller = new AbortController();
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        new Response(JSON.stringify({ ok: true }), { status: 200 }),
      );

    await fetchPlainJSON(
      "/projects/p/file-completions",
      { signal: controller.signal },
      { fetchImpl },
    );

    // A caller with its own signal has taken over the request's lifetime —
    // a long upload, or a read it abandons when the reader navigates — so it
    // must not be shortened to the shared deadline.
    expect(fetchImpl.mock.calls[0]?.[1]?.signal).toBe(controller.signal);
  });

  it("abandons a request the server never answers", async () => {
    vi.useFakeTimers();
    // jsdom schedules AbortSignal.timeout on its own window timers, which the
    // fake clock does not control; drive the same TimeoutError from it.
    const timeout = vi
      .spyOn(AbortSignal, "timeout")
      .mockImplementation((milliseconds) => {
        const controller = new AbortController();
        setTimeout(
          () =>
            controller.abort(
              new DOMException("The operation timed out.", "TimeoutError"),
            ),
          milliseconds,
        );
        return controller.signal;
      });
    try {
      const fetchImpl = vi.fn<typeof fetch>((_url, init) => {
        return new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            reject((init.signal as AbortSignal).reason);
          });
        });
      });

      const pending = fetchPlainJSON("/projects", undefined, { fetchImpl });
      const settled = vi.fn();
      void pending.catch(settled);

      await vi.advanceTimersByTimeAsync(API_REQUEST_DEADLINE_MS + 1);

      expect(settled).toHaveBeenCalledTimes(1);
      expect(isRequestDeadlineError(settled.mock.calls[0]?.[0])).toBe(true);
      expect(timeout).toHaveBeenCalledWith(API_REQUEST_DEADLINE_MS);
    } finally {
      timeout.mockRestore();
      vi.useRealTimers();
    }
  });
});
