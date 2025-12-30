import { randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../../src/app.js";
import { MockClaudeSDK, createMockScenario } from "../../src/sdk/mock.js";
import { encodeProjectId } from "../../src/supervisor/types.js";

describe("Sessions API", () => {
  let mockSdk: MockClaudeSDK;
  let testDir: string;
  let projectId: string;

  beforeEach(async () => {
    mockSdk = new MockClaudeSDK();
    // Create temp directory structure with a valid project
    testDir = join(tmpdir(), `claude-test-${randomUUID()}`);
    const projectPath = "/home/user/myproject";
    projectId = encodeProjectId(projectPath);
    const encodedPath = projectPath.replaceAll("/", "-");

    await mkdir(join(testDir, "localhost", encodedPath), { recursive: true });
    // Session file must include cwd field for project path discovery
    await writeFile(
      join(testDir, "localhost", encodedPath, "sess-existing.jsonl"),
      `{"type":"user","cwd":"${projectPath}","message":{"content":"Hello"}}\n`,
    );
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  describe("POST /api/projects/:projectId/sessions", () => {
    it("returns 400 if message is missing", async () => {
      const app = createApp({ sdk: mockSdk, projectsDir: testDir });

      const res = await app.request(`/api/projects/${projectId}/sessions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Claude-Anywhere": "true",
        },
        body: JSON.stringify({}),
      });

      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.error).toBe("Message is required");
    });

    it("returns 400 for invalid JSON", async () => {
      const app = createApp({ sdk: mockSdk, projectsDir: testDir });

      const res = await app.request(`/api/projects/${projectId}/sessions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Claude-Anywhere": "true",
        },
        body: "not json",
      });

      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.error).toBe("Invalid JSON body");
    });

    it("returns 404 for unknown project", async () => {
      const app = createApp({ sdk: mockSdk, projectsDir: testDir });

      const res = await app.request("/api/projects/unknown/sessions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Claude-Anywhere": "true",
        },
        body: JSON.stringify({ message: "hello" }),
      });

      expect(res.status).toBe(404);
      const json = await res.json();
      expect(json.error).toBe("Project not found");
    });

    it("starts a session and returns processId", async () => {
      mockSdk.addScenario(createMockScenario("new-session", "Hello!"));
      const app = createApp({ sdk: mockSdk, projectsDir: testDir });

      const res = await app.request(`/api/projects/${projectId}/sessions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Claude-Anywhere": "true",
        },
        body: JSON.stringify({ message: "hello" }),
      });

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.sessionId).toBeDefined();
      expect(json.processId).toBeDefined();
    });

    it("accepts permission mode parameter", async () => {
      mockSdk.addScenario(createMockScenario("new-session", "Hello!"));
      const app = createApp({ sdk: mockSdk, projectsDir: testDir });

      const res = await app.request(`/api/projects/${projectId}/sessions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Claude-Anywhere": "true",
        },
        body: JSON.stringify({ message: "hello", mode: "acceptEdits" }),
      });

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.sessionId).toBeDefined();
      expect(json.processId).toBeDefined();
    });
  });

  describe("POST /api/projects/:projectId/sessions/:sessionId/resume", () => {
    it("returns 400 if message is missing", async () => {
      const app = createApp({ sdk: mockSdk, projectsDir: testDir });

      const res = await app.request(
        `/api/projects/${projectId}/sessions/sess-123/resume`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Claude-Anywhere": "true",
          },
          body: JSON.stringify({}),
        },
      );

      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.error).toBe("Message is required");
    });

    it("returns 404 for unknown project", async () => {
      const app = createApp({ sdk: mockSdk, projectsDir: testDir });

      const res = await app.request(
        "/api/projects/unknown/sessions/sess-123/resume",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Claude-Anywhere": "true",
          },
          body: JSON.stringify({ message: "hello" }),
        },
      );

      expect(res.status).toBe(404);
    });

    it("resumes a session and returns processId", async () => {
      mockSdk.addScenario(createMockScenario("sess-123", "Resumed!"));
      const app = createApp({ sdk: mockSdk, projectsDir: testDir });

      const res = await app.request(
        `/api/projects/${projectId}/sessions/sess-123/resume`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Claude-Anywhere": "true",
          },
          body: JSON.stringify({ message: "continue" }),
        },
      );

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.processId).toBeDefined();
    });

    it("accepts permission mode parameter", async () => {
      mockSdk.addScenario(createMockScenario("sess-123", "Resumed!"));
      const app = createApp({ sdk: mockSdk, projectsDir: testDir });

      const res = await app.request(
        `/api/projects/${projectId}/sessions/sess-123/resume`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Claude-Anywhere": "true",
          },
          body: JSON.stringify({ message: "continue", mode: "plan" }),
        },
      );

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.processId).toBeDefined();
    });
  });

  describe("POST /api/sessions/:sessionId/messages", () => {
    it("returns 404 if no active process", async () => {
      const app = createApp({ sdk: mockSdk, projectsDir: testDir });

      const res = await app.request("/api/sessions/unknown/messages", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Claude-Anywhere": "true",
        },
        body: JSON.stringify({ message: "hello" }),
      });

      expect(res.status).toBe(404);
      const json = await res.json();
      expect(json.error).toBe("No active process for session");
    });
  });

  describe("GET /api/sessions/:sessionId/pending-input", () => {
    it("returns null request when no active process", async () => {
      const app = createApp({ sdk: mockSdk, projectsDir: testDir });

      const res = await app.request("/api/sessions/unknown/pending-input");
      const json = await res.json();

      expect(res.status).toBe(200);
      expect(json.request).toBeNull();
    });
  });

  describe("POST /api/sessions/:sessionId/input", () => {
    it("returns 404 if no active process", async () => {
      const app = createApp({ sdk: mockSdk, projectsDir: testDir });

      const res = await app.request("/api/sessions/unknown/input", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Claude-Anywhere": "true",
        },
        body: JSON.stringify({ requestId: "req-1", response: "approve" }),
      });

      expect(res.status).toBe(404);
      const json = await res.json();
      expect(json.error).toBe("No active process for session");
    });
  });
});
