import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export function setupMockProjects() {
  const claudeDir = path.join(os.homedir(), ".claude", "projects");
  const hostname = os.hostname();
  // Project path encoded with / replaced by - (per scanner.ts)
  // Using /mockproject (no dashes in name) since - is used as path separator
  const mockProjectDir = path.join(claudeDir, hostname, "-mockproject");

  // Create directory if needed
  fs.mkdirSync(mockProjectDir, { recursive: true });

  // Create a mock session file
  const sessionFile = path.join(mockProjectDir, "mock-session-001.jsonl");
  if (!fs.existsSync(sessionFile)) {
    const mockMessages = [
      {
        type: "user",
        message: { role: "user", content: "Previous message" },
        timestamp: new Date().toISOString(),
        uuid: "1",
      },
    ];
    fs.writeFileSync(
      sessionFile,
      mockMessages.map((m) => JSON.stringify(m)).join("\n"),
    );
  }

  return { projectDir: mockProjectDir, sessionFile };
}
