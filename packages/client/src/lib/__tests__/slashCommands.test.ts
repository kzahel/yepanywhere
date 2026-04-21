import { describe, expect, it } from "vitest";
import { mergeFallbackSlashCommands } from "../slashCommands";

describe("mergeFallbackSlashCommands", () => {
  it("adds core Claude fallback commands when the SDK omits them", () => {
    expect(
      mergeFallbackSlashCommands("claude", ["compact", "context", "cost"]),
    ).toEqual(
      expect.arrayContaining([
        "compact",
        "context",
        "cost",
        "clear",
        "help",
        "status",
      ]),
    );
  });

  it("does not duplicate existing commands", () => {
    expect(
      mergeFallbackSlashCommands("claude", ["help", "status", "compact"]),
    ).toEqual(expect.arrayContaining(["help", "status", "compact", "clear"]));
  });

  it("does not inject Claude-only fallback commands for other providers", () => {
    expect(mergeFallbackSlashCommands("codex", ["compact"])).toEqual([
      "compact",
    ]);
  });
});
