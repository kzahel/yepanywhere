import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installExternalLinkHandler } from "./externalLinks";

describe("installExternalLinkHandler", () => {
  let invoke: ReturnType<typeof vi.fn>;
  let cleanup: () => void;

  beforeEach(() => {
    invoke = vi.fn().mockResolvedValue(undefined);
    // biome-ignore lint/suspicious/noExplicitAny: simulating Tauri-injected global
    (window as any).__TAURI_INTERNALS__ = { invoke };
    cleanup = installExternalLinkHandler();
  });

  afterEach(() => {
    cleanup();
    document.body.innerHTML = "";
    // biome-ignore lint/suspicious/noExplicitAny: test cleanup
    (window as any).__TAURI_INTERNALS__ = undefined;
    vi.restoreAllMocks();
  });

  function clickAnchor(href: string): MouseEvent {
    const a = document.createElement("a");
    a.href = href;
    a.textContent = "link";
    document.body.appendChild(a);
    const event = new MouseEvent("click", {
      bubbles: true,
      cancelable: true,
    });
    a.dispatchEvent(event);
    return event;
  }

  it("intercepts external http(s) links and opens them via the opener", () => {
    const event = clickAnchor("https://example.com/page");
    expect(event.defaultPrevented).toBe(true);
    expect(invoke).toHaveBeenCalledWith("plugin:opener|open_url", {
      url: "https://example.com/page",
    });
  });

  it("ignores same-origin links so in-app navigation still works", () => {
    const event = clickAnchor(`${window.location.origin}/sessions/123`);
    expect(event.defaultPrevented).toBe(false);
    expect(invoke).not.toHaveBeenCalled();
  });

  it("ignores anchors without an href", () => {
    const a = document.createElement("a");
    a.textContent = "no href";
    document.body.appendChild(a);
    const event = new MouseEvent("click", { bubbles: true, cancelable: true });
    a.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
    expect(invoke).not.toHaveBeenCalled();
  });

  it("does nothing outside Tauri", () => {
    cleanup();
    // biome-ignore lint/suspicious/noExplicitAny: test cleanup
    (window as any).__TAURI_INTERNALS__ = undefined;
    cleanup = installExternalLinkHandler();
    const event = clickAnchor("https://example.com/page");
    expect(event.defaultPrevented).toBe(false);
    expect(invoke).not.toHaveBeenCalled();
  });
});
