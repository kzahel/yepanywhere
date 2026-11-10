import { randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  DETACHED_PROJECT_PATH,
  canonicalizeProjectPath,
  decodeProjectId,
  encodeProjectId,
  getFileTypeFromRelativePath,
  getProjectIdentityKey,
  getProjectName,
  getSessionFilePath,
  getSessionIdFromPath,
  normalizeProjectPathForDedup,
  readCwdFromSessionFile,
} from "../../src/projects/paths.js";

describe("Project Path Utilities", () => {
  describe("encodeProjectId / decodeProjectId", () => {
    it("roundtrips a simple path", () => {
      const path = "/home/user/project";
      const encoded = encodeProjectId(path);
      const decoded = decodeProjectId(encoded);
      expect(decoded).toBe(path);
    });

    it("roundtrips a path with hyphens", () => {
      const path = "/home/user-name/my-project";
      const encoded = encodeProjectId(path);
      const decoded = decodeProjectId(encoded);
      expect(decoded).toBe(path);
    });

    it("roundtrips a path with special characters", () => {
      const path = "/home/user/project with spaces/test";
      const encoded = encodeProjectId(path);
      const decoded = decodeProjectId(encoded);
      expect(decoded).toBe(path);
    });

    it("produces URL-safe encoding", () => {
      const path = "/home/user/project";
      const encoded = encodeProjectId(path);
      // base64url should not contain +, /, or =
      expect(encoded).not.toMatch(/[+/=]/);
    });
  });

  describe("getProjectName", () => {
    it("returns the basename of a path", () => {
      expect(getProjectName("/home/user/my-project")).toBe("my-project");
    });

    it("handles paths with trailing slash", () => {
      // Note: basename of "/foo/bar/" is "bar" in Node
      expect(getProjectName("/home/user/my-project")).toBe("my-project");
    });

    it("handles single directory", () => {
      expect(getProjectName("/project")).toBe("project");
    });
  });

  describe("getSessionFilePath", () => {
    it("constructs the correct path", () => {
      const sessionDir = "/home/user/.claude/projects/hostname/-encoded-path";
      const sessionId = "abc-123";
      const result = getSessionFilePath(sessionDir, sessionId);
      expect(result).toBe(join(sessionDir, "abc-123.jsonl"));
    });
  });

  describe("getSessionIdFromPath", () => {
    it("extracts session ID from absolute path", () => {
      expect(
        getSessionIdFromPath(
          "/home/user/.claude/projects/xxx/my-session.jsonl",
        ),
      ).toBe("my-session");
    });

    it("extracts session ID from relative path", () => {
      expect(getSessionIdFromPath("projects/xxx/session-123.jsonl")).toBe(
        "session-123",
      );
    });

    it("handles UUID session IDs", () => {
      const uuid = "550e8400-e29b-41d4-a716-446655440000";
      expect(getSessionIdFromPath(`projects/xxx/${uuid}.jsonl`)).toBe(uuid);
    });

    it("handles agent session IDs", () => {
      expect(getSessionIdFromPath("projects/xxx/agent-warmup-123.jsonl")).toBe(
        "agent-warmup-123",
      );
    });

    it("returns null for non-jsonl files", () => {
      expect(getSessionIdFromPath("projects/xxx/settings.json")).toBeNull();
    });

    it("returns null for paths without file extension", () => {
      expect(getSessionIdFromPath("projects/xxx/")).toBeNull();
    });
  });

  describe("getFileTypeFromRelativePath", () => {
    it("identifies session files", () => {
      expect(
        getFileTypeFromRelativePath("projects/xxx/session-123.jsonl"),
      ).toBe("session");
    });

    it("identifies agent session files", () => {
      expect(
        getFileTypeFromRelativePath("projects/xxx/agent-warmup.jsonl"),
      ).toBe("agent-session");
    });

    it("identifies settings file", () => {
      expect(getFileTypeFromRelativePath("settings.json")).toBe("settings");
    });

    it("identifies credentials file", () => {
      expect(getFileTypeFromRelativePath("credentials.json")).toBe(
        "credentials",
      );
    });

    it("identifies credentials directory files", () => {
      expect(getFileTypeFromRelativePath("credentials/oauth.json")).toBe(
        "credentials",
      );
    });

    it("identifies telemetry files", () => {
      expect(getFileTypeFromRelativePath("statsig/cache.json")).toBe(
        "telemetry",
      );
    });

    it("returns other for unknown files", () => {
      expect(getFileTypeFromRelativePath("some-random-file.txt")).toBe("other");
    });
  });

  describe("normalizeProjectPathForDedup", () => {
    it("canonicalizes Windows separators before deduping", () => {
      expect(canonicalizeProjectPath("c:\\Users\\pf\\Projects\\myapp")).toBe(
        "C:/Users/pf/Projects/myapp",
      );
    });

    it("normalizes macOS home paths", () => {
      expect(normalizeProjectPathForDedup("/Users/kgraehl/dotfiles")).toBe(
        "kgraehl/dotfiles",
      );
    });

    it("normalizes Linux home paths", () => {
      expect(normalizeProjectPathForDedup("/home/kgraehl/dotfiles")).toBe(
        "kgraehl/dotfiles",
      );
    });

    it("matches macOS and Linux paths for same user/project", () => {
      const macos = normalizeProjectPathForDedup(
        "/Users/kgraehl/code/yepanywhere",
      );
      const linux = normalizeProjectPathForDedup(
        "/home/kgraehl/code/yepanywhere",
      );
      expect(macos).toBe(linux);
    });

    it("normalizes root user paths", () => {
      expect(normalizeProjectPathForDedup("/root/project")).toBe(
        "root/project",
      );
    });

    it("leaves non-home paths unchanged", () => {
      expect(normalizeProjectPathForDedup("/opt/shared/project")).toBe(
        "/opt/shared/project",
      );
    });

    it("does not merge different users", () => {
      const userA = normalizeProjectPathForDedup("/Users/alice/dotfiles");
      const userB = normalizeProjectPathForDedup("/home/bob/dotfiles");
      expect(userA).not.toBe(userB);
    });

    it("handles nested project paths", () => {
      expect(
        normalizeProjectPathForDedup("/Users/user/code/deep/nested/project"),
      ).toBe("user/code/deep/nested/project");
    });

    it("case-folds Windows drive home paths", () => {
      expect(
        normalizeProjectPathForDedup("C:\\Users\\pf\\Projects\\myapp"),
      ).toBe("pf/projects/myapp");
    });

    it("normalizes Windows paths with forward slashes", () => {
      expect(normalizeProjectPathForDedup("C:/Users/pf/Projects/myapp")).toBe(
        "pf/projects/myapp",
      );
    });

    it("matches Windows and macOS paths for same user/project", () => {
      const win = normalizeProjectPathForDedup(
        "C:\\Users\\kgraehl\\code\\yepanywhere",
      );
      const mac = normalizeProjectPathForDedup(
        "/Users/kgraehl/code/yepanywhere",
      );
      expect(win).toBe(mac);
    });

    it("handles Windows drive letters case-insensitively", () => {
      const upper = normalizeProjectPathForDedup("C:\\Users\\user\\project");
      const lower = normalizeProjectPathForDedup("c:\\Users\\user\\project");
      expect(upper).toBe(lower);
    });

    it("normalizes non-home Windows paths to a stable separator format", () => {
      const backslash = normalizeProjectPathForDedup("D:\\work\\repo");
      const forwardSlash = normalizeProjectPathForDedup("d:/work/repo");
      expect(backslash).toBe("d:/work/repo");
      expect(backslash).toBe(forwardSlash);
    });

    it("case-folds UNC project paths", () => {
      expect(normalizeProjectPathForDedup("\\\\Server\\Share\\Repo")).toBe(
        "//server/share/repo",
      );
    });

    it("matches Windows drive paths that differ only by segment case", () => {
      const upper = normalizeProjectPathForDedup(
        "C:/Users/sox/Documents/code/mclone",
      );
      const lower = normalizeProjectPathForDedup(
        "c:/users/sox/documents/code/mclone",
      );
      expect(upper).toBe(lower);
    });

    it("keeps WSL-like paths case-sensitive", () => {
      const upper = normalizeProjectPathForDedup(
        "/mnt/c/Users/sox/Documents/code/mclone",
      );
      const lower = normalizeProjectPathForDedup(
        "/mnt/c/Users/sox/documents/code/mclone",
      );
      expect(upper).not.toBe(lower);
    });
  });

  describe("getProjectIdentityKey", () => {
    it("case-folds Windows drive paths", () => {
      expect(getProjectIdentityKey("C:/Users/sox/Documents/code/mclone")).toBe(
        getProjectIdentityKey("c:\\users\\sox\\documents\\code\\mclone"),
      );
    });

    it("case-folds UNC paths", () => {
      expect(getProjectIdentityKey("\\\\Server\\Share\\Repo")).toBe(
        getProjectIdentityKey("//server/share/repo"),
      );
    });

    it("preserves POSIX case sensitivity", () => {
      expect(
        getProjectIdentityKey("/Users/sox/Documents/code/mclone"),
      ).not.toBe(getProjectIdentityKey("/Users/sox/documents/code/mclone"));
    });
  });

  describe("readCwdFromSessionFile", () => {
    let testDir: string;

    beforeEach(async () => {
      testDir = join(tmpdir(), `claude-paths-test-${randomUUID()}`);
      await mkdir(testDir, { recursive: true });
    });

    afterEach(async () => {
      await rm(testDir, { recursive: true, force: true });
    });

    it("reads cwd from valid session file", async () => {
      const sessionFile = join(testDir, "session.jsonl");
      await writeFile(
        sessionFile,
        '{"type":"user","cwd":"/home/user/project","message":"hello"}\n' +
          '{"type":"assistant","message":"world"}\n',
      );

      const cwd = await readCwdFromSessionFile(sessionFile);
      expect(cwd).toBe("/home/user/project");
    });

    it("reads cwd from later lines", async () => {
      const sessionFile = join(testDir, "session.jsonl");
      await writeFile(
        sessionFile,
        '{"type":"init","version":"1.0"}\n' +
          '{"type":"user","cwd":"/home/user/project","message":"hello"}\n',
      );

      const cwd = await readCwdFromSessionFile(sessionFile);
      expect(cwd).toBe("/home/user/project");
    });

    it("reads cwd after long queue bookkeeping lines", async () => {
      const sessionFile = join(testDir, "session-long-prefix.jsonl");
      const longPrompt = "x".repeat(9000);
      await writeFile(
        sessionFile,
        JSON.stringify({
          type: "queue-operation",
          operation: "enqueue",
          content: longPrompt,
        }) +
          "\n" +
          JSON.stringify({
            type: "queue-operation",
            operation: "dequeue",
          }) +
          "\n" +
          JSON.stringify({
            type: "user",
            cwd: "/home/user/project",
            message: { content: longPrompt },
          }) +
          "\n",
      );

      const cwd = await readCwdFromSessionFile(sessionFile);
      expect(cwd).toBe("/home/user/project");
    });

    it("returns null for file without cwd", async () => {
      const sessionFile = join(testDir, "session.jsonl");
      await writeFile(
        sessionFile,
        '{"type":"user","message":"hello"}\n' +
          '{"type":"assistant","message":"world"}\n',
      );

      const cwd = await readCwdFromSessionFile(sessionFile);
      expect(cwd).toBeNull();
    });

    it("returns null for empty file", async () => {
      const sessionFile = join(testDir, "session.jsonl");
      await writeFile(sessionFile, "");

      const cwd = await readCwdFromSessionFile(sessionFile);
      expect(cwd).toBeNull();
    });

    it("returns null for non-existent file", async () => {
      const cwd = await readCwdFromSessionFile(
        join(testDir, "nonexistent.jsonl"),
      );
      expect(cwd).toBeNull();
    });

    it("handles malformed JSON lines gracefully", async () => {
      const sessionFile = join(testDir, "session.jsonl");
      await writeFile(
        sessionFile,
        "not valid json\n" +
          '{"type":"user","cwd":"/home/user/project","message":"hello"}\n',
      );

      const cwd = await readCwdFromSessionFile(sessionFile);
      expect(cwd).toBe("/home/user/project");
    });

    it("handles files with UTF-8 BOM", async () => {
      const sessionFile = join(testDir, "session-bom.jsonl");
      await writeFile(
        sessionFile,
        '\uFEFF{"type":"user","cwd":"/home/user/project","message":"hello"}\n',
      );

      const cwd = await readCwdFromSessionFile(sessionFile);
      expect(cwd).toBe("/home/user/project");
    });
  });
});

describe("DETACHED_PROJECT_PATH", () => {
  it("uses the real temp dir so it matches the cwd providers record", () => {
    expect(DETACHED_PROJECT_PATH).toBe(
      join(realpathSync(tmpdir()), "yep-anywhere-no-project"),
    );
  });
});
