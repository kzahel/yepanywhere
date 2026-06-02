import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isTauri, openExternalUrl } from "./tauri";

describe("isTauri", () => {
  afterEach(() => {
    // biome-ignore lint/suspicious/noExplicitAny: test cleanup of injected globals
    (window as any).__TAURI_INTERNALS__ = undefined;
    // biome-ignore lint/suspicious/noExplicitAny: test cleanup of injected globals
    (window as any).__TAURI__ = undefined;
  });

  it("returns false in a normal browser", () => {
    expect(isTauri()).toBe(false);
  });

  it("returns true when Tauri internals are injected", () => {
    // biome-ignore lint/suspicious/noExplicitAny: simulating Tauri-injected global
    (window as any).__TAURI_INTERNALS__ = { invoke: () => {} };
    expect(isTauri()).toBe(true);
  });
});

describe("openExternalUrl", () => {
  let invoke: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    invoke = vi.fn().mockResolvedValue(undefined);
    // biome-ignore lint/suspicious/noExplicitAny: simulating Tauri-injected global
    (window as any).__TAURI_INTERNALS__ = { invoke };
  });

  afterEach(() => {
    // biome-ignore lint/suspicious/noExplicitAny: test cleanup
    (window as any).__TAURI_INTERNALS__ = undefined;
    vi.restoreAllMocks();
  });

  it("opens via the Tauri opener plugin", async () => {
    await openExternalUrl("https://example.com");
    expect(invoke).toHaveBeenCalledWith("plugin:opener|open_url", {
      url: "https://example.com",
    });
  });

  it("falls back to window.open if the opener invoke fails", async () => {
    invoke.mockRejectedValueOnce(new Error("no permission"));
    const open = vi.spyOn(window, "open").mockReturnValue(null);
    await openExternalUrl("https://example.com");
    expect(open).toHaveBeenCalledWith(
      "https://example.com",
      "_blank",
      "noopener,noreferrer",
    );
  });
});
