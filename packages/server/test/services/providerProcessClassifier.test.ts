import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  classifyProviderProcess,
  readNativeProcessSession,
} from "../../src/services/providerProcessClassifier.js";

describe("classifyProviderProcess", () => {
  it("classifies only direct executables and generic runtime entrypoints", () => {
    expect(classifyProviderProcess("codex", ["codex"])).toBe("codex");
    expect(
      classifyProviderProcess("MainThread", [
        "node",
        "/packages/@anthropic-ai/claude-code/cli.js",
      ]),
    ).toBe("claude");
    expect(classifyProviderProcess("bash", ["bash", "codex"])).toBeUndefined();
    expect(
      classifyProviderProcess("python3", ["python3", "my-codex-report.py"]),
    ).toBeUndefined();
  });

  it("recognizes Windows executable names and the gemini-cli alias", () => {
    expect(classifyProviderProcess("Claude.exe", [])).toBe("claude");
    expect(classifyProviderProcess("gemini-cli", ["gemini-cli"])).toBe(
      "gemini",
    );
    expect(
      classifyProviderProcess("MainThread", [
        "node.exe",
        "C:\\npm\\node_modules\\@google\\gemini-cli\\index.js",
      ]),
    ).toBe("gemini");
  });

  it("does not classify a provider name past the entrypoint window", () => {
    // A prompt or a path argument is not an entrypoint, and treating it as one
    // is how an unrelated process gets reported as a running agent.
    expect(
      classifyProviderProcess("node", [
        "node",
        "./build.js",
        "--out",
        "dist",
        "codex",
      ]),
    ).toBeUndefined();
    expect(
      classifyProviderProcess("node", ["node", "./run.js", "ask claude about"]),
    ).toBeUndefined();
  });
});

describe("Claude Code's bundled tools and pid records", () => {
  it("classifies the claude binary invoked as a bundled search tool as that tool", () => {
    expect(
      classifyProviderProcess("claude", ["ugrep", "-G", "x"]),
    ).toBeUndefined();
    expect(
      classifyProviderProcess("claude", ["rg", "--files"]),
    ).toBeUndefined();
    expect(classifyProviderProcess("claude", ["claude"])).toBe("claude");
    expect(
      classifyProviderProcess("claude", [
        "/home/u/.local/share/claude/versions/2.1.302",
      ]),
    ).toBe("claude");
  });

  it("reads a session only from a pid record whose start time matches", async () => {
    const configDir = await mkdtemp(join(tmpdir(), "claude-config-"));
    vi.stubEnv("CLAUDE_CONFIG_DIR", configDir);
    try {
      await mkdir(join(configDir, "sessions"));
      await mkdir(join(configDir, "projects"));
      const startedAt = Date.parse("2026-07-28T11:00:00.400Z");
      await writeFile(
        join(configDir, "sessions", "4321.json"),
        JSON.stringify({
          pid: 4321,
          sessionId: "6ff01135-8ed7-4168",
          cwd: "/work/p",
          startedAt,
        }),
      );
      // ps reports whole seconds, so a sub-second difference still matches.
      await expect(
        readNativeProcessSession(
          "claude",
          4321,
          Date.parse("2026-07-28T11:00:00.000Z"),
        ),
      ).resolves.toEqual({
        nativeSessionId: "6ff01135-8ed7-4168",
        projectPath: "/work/p",
        projectsRoot: await realpath(join(configDir, "projects")),
      });
      // A reused pid started later is not the recorded process.
      await expect(
        readNativeProcessSession("claude", 4321, startedAt + 60_000),
      ).resolves.toBeUndefined();
      await expect(
        readNativeProcessSession("codex", 4321, startedAt),
      ).resolves.toBeUndefined();
      await expect(
        readNativeProcessSession("claude", 9999, startedAt),
      ).resolves.toBeUndefined();
    } finally {
      vi.unstubAllEnvs();
      await rm(configDir, { recursive: true });
    }
  });
});
