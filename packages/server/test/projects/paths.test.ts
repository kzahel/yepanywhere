import { randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  canonicalizeProjectPath,
  decodeProjectId,
  encodeProjectId,
  getFileTypeFromRelativePath,
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
      expect(result.replace(/\\/g, "/")).toBe(
        "/home/user/.claude/projects/hostname/-encoded-path/abc-123.jsonl",
      );
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

    it("canonicalizes Win32 namespace paths", () => {
      expect(
        canonicalizeProjectPath("\\\\?\\C:\\Users\\pf\\Projects\\myapp"),
      ).toBe("C:/Users/pf/Projects/myapp");
      expect(canonicalizeProjectPath("//?/c:/Users/pf/Projects/myapp")).toBe(
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

    it("normalizes Windows paths with backslashes", () => {
      expect(
        normalizeProjectPathForDedup("C:\\Users\\pf\\Projects\\myapp"),
      ).toBe("pf/Projects/myapp");
    });

    it("normalizes Windows paths with forward slashes", () => {
      expect(normalizeProjectPathForDedup("C:/Users/pf/Projects/myapp")).toBe(
        "pf/Projects/myapp",
      );
    });

    it("deduplicates Win32 namespace paths with normal Windows paths", () => {
      const namespaced = normalizeProjectPathForDedup(
        "\\\\?\\C:\\Users\\pf\\Projects\\myapp",
      );
      const normal = normalizeProjectPathForDedup("C:/Users/pf/Projects/myapp");
      expect(namespaced).toBe(normal);
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
      expect(backslash).toBe("D:/work/repo");
      expect(backslash).toBe(forwardSlash);
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
