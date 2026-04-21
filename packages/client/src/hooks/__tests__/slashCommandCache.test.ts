import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setCurrentInstallId } from "../../lib/storageKeys";
import {
  getCachedSlashCommands,
  setCachedSlashCommands,
} from "../slashCommandCache";

describe("slashCommandCache", () => {
  beforeEach(() => {
    const store = new Map<string, string>();
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: globalThis,
    });
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      value: {
        getItem: vi.fn((key: string) => store.get(key) ?? null),
        setItem: vi.fn((key: string, value: string) => {
          store.set(key, value);
        }),
        removeItem: vi.fn((key: string) => {
          store.delete(key);
        }),
        clear: vi.fn(() => {
          store.clear();
        }),
      },
    });
    setCurrentInstallId("test-install");
  });

  afterEach(() => {
    localStorage.clear();
  });

  it("persists and restores cached slash commands for a provider", () => {
    setCachedSlashCommands("claude", "project-a", ["docs", "model"]);
    expect(getCachedSlashCommands("claude", "project-a")).toEqual([
      "docs",
      "model",
    ]);
  });

  it("returns an empty list for missing providers or malformed data", () => {
    expect(getCachedSlashCommands(undefined, "project-a")).toEqual([]);
    localStorage.setItem(
      "yep-anywhere-test-install-slash-commands-claude",
      "{",
    );
    expect(getCachedSlashCommands("claude", "project-a")).toEqual([]);
  });

  it("falls back to legacy cache and promotes it to the scoped key", () => {
    localStorage.setItem(
      "yep-anywhere-slash-commands-claude",
      JSON.stringify(["docs", "model"]),
    );

    expect(getCachedSlashCommands("claude", "project-a")).toEqual([
      "docs",
      "model",
    ]);
    expect(
      localStorage.getItem("yep-anywhere-test-install-slash-commands-claude"),
    ).toBe(JSON.stringify(["docs", "model"]));
    expect(
      localStorage.getItem(
        "yep-anywhere-test-install-slash-commands-claude-project-a",
      ),
    ).toBe(JSON.stringify(["docs", "model"]));
    expect(localStorage.getItem("yep-anywhere-slash-commands-claude")).toBe(
      null,
    );
  });

  it("isolates cached slash commands by project", () => {
    setCachedSlashCommands("claude", "project-a", ["docs"]);
    setCachedSlashCommands("claude", "project-b", ["bug-loop-next"]);

    expect(getCachedSlashCommands("claude", "project-a")).toEqual(["docs"]);
    expect(getCachedSlashCommands("claude", "project-b")).toEqual([
      "bug-loop-next",
    ]);
  });
});
