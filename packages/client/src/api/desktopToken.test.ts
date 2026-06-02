import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveDesktopAuthToken } from "./client";

describe("resolveDesktopAuthToken", () => {
  beforeEach(() => {
    window.sessionStorage.clear();
    window.history.replaceState({}, "", "/");
  });

  afterEach(() => {
    window.sessionStorage.clear();
    window.history.replaceState({}, "", "/");
  });

  it("reads the token from the URL and strips it", () => {
    window.history.replaceState({}, "", "/?desktop_token=abc123");
    const token = resolveDesktopAuthToken();
    expect(token).toBe("abc123");
    // Token removed from the visible URL.
    expect(window.location.search).not.toContain("desktop_token");
  });

  it("persists the token so a later reload (no URL param) still finds it", () => {
    // First load: token in URL.
    window.history.replaceState({}, "", "/?desktop_token=abc123");
    expect(resolveDesktopAuthToken()).toBe("abc123");

    // Simulate a document reload / back-navigation: URL has no token anymore.
    window.history.replaceState({}, "", "/sessions/42");
    expect(resolveDesktopAuthToken()).toBe("abc123");
  });

  it("preserves other query params when stripping the token", () => {
    window.history.replaceState({}, "", "/?desktop_token=abc123&foo=bar");
    resolveDesktopAuthToken();
    expect(window.location.search).toContain("foo=bar");
    expect(window.location.search).not.toContain("desktop_token");
  });

  it("returns null when no token has ever been provided", () => {
    expect(resolveDesktopAuthToken()).toBeNull();
  });
});
