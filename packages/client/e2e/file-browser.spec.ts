import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { e2ePaths, expect, test } from "./fixtures.js";

// Set up test files in a temp directory (avoid permission issues with /mockproject)
const mockProjectPath = join(tmpdir(), "claude-e2e-mockproject");
// Project ID is base64url encoded path (no need to URL encode - it's already URL-safe)
const projectId = Buffer.from(mockProjectPath).toString("base64url");
// Session dir name uses the path with slashes replaced by dashes
const sessionDirName = mockProjectPath.replace(/\//g, "-");

// Create test files before tests run
test.beforeAll(() => {
  // Clean up any previous test artifacts
  try {
    rmSync(mockProjectPath, { recursive: true, force: true });
  } catch {
    // Ignore if doesn't exist
  }

  // Create the mock project directory and subdirectories
  mkdirSync(mockProjectPath, { recursive: true });
  mkdirSync(join(mockProjectPath, "src"), { recursive: true });

  // Create test files
  writeFileSync(join(mockProjectPath, "test.txt"), "Hello from test file!");
  writeFileSync(
    join(mockProjectPath, "README.md"),
    "# Test Project\n\nThis is a **test** markdown file.",
  );
  writeFileSync(
    join(mockProjectPath, "src", "index.ts"),
    'export const hello = "world";\nconsole.log(hello);',
  );
  writeFileSync(join(mockProjectPath, "data.json"), '{"key": "value"}');

  // Create a session file so the project is discoverable
  // Use isolated test directory from e2ePaths (not real ~/.claude/)
  const claudeSessionDir = join(
    e2ePaths.claudeSessionsDir,
    hostname(),
    sessionDirName,
  );
  mkdirSync(claudeSessionDir, { recursive: true });
  writeFileSync(
    join(claudeSessionDir, "e2e-file-test.jsonl"),
    JSON.stringify({
      type: "user",
      cwd: mockProjectPath,
      message: { role: "user", content: "test" },
    }),
  );
});

// Clean up after tests
test.afterAll(() => {
  // Clean up mock project directory
  try {
    rmSync(mockProjectPath, { recursive: true, force: true });
  } catch {
    // Ignore cleanup errors
  }
  // Note: No need to clean up claude session - it's in the isolated test directory
  // which is cleaned up by global-setup on next run
});

test.describe("Files API", () => {
  test("returns file content for text files", async ({ request }) => {
    const response = await request.get(
      `/api/projects/${projectId}/files?path=test.txt`,
    );

    expect(response.ok()).toBe(true);
    const data = await response.json();
    expect(data.metadata.path).toBe("test.txt");
    expect(data.metadata.isText).toBe(true);
    expect(data.content).toBe("Hello from test file!");
    expect(data.rawUrl).toContain("/files/raw");
  });

  test("returns raw file with correct content-type", async ({ request }) => {
    const response = await request.get(
      `/api/projects/${projectId}/files/raw?path=data.json`,
    );

    expect(response.ok()).toBe(true);
    expect(response.headers()["content-type"]).toBe("application/json");
    const text = await response.text();
    expect(text).toBe('{"key": "value"}');
  });

  test("sets attachment disposition for downloads", async ({ request }) => {
    const response = await request.get(
      `/api/projects/${projectId}/files/raw?path=test.txt&download=true`,
    );

    expect(response.ok()).toBe(true);
    expect(response.headers()["content-disposition"]).toContain("attachment");
    expect(response.headers()["content-disposition"]).toContain("test.txt");
  });

  test("rejects path traversal attempts", async ({ request }) => {
    const response = await request.get(
      `/api/projects/${projectId}/files?path=../../../etc/passwd`,
    );

    expect(response.status()).toBe(400);
    const data = await response.json();
    expect(data.error).toBe("Invalid file path");
  });

  test("returns 404 for non-existent files", async ({ request }) => {
    const response = await request.get(
      `/api/projects/${projectId}/files?path=does-not-exist.txt`,
    );

    expect(response.status()).toBe(404);
    const data = await response.json();
    expect(data.error).toBe("File not found");
  });
});
