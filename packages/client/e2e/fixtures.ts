import { existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test as base } from "@playwright/test";

const PORT_FILE = join(tmpdir(), "claude-e2e-port");
const PATHS_FILE = join(tmpdir(), "claude-e2e-paths.json");

function getServerPort(): number {
  if (existsSync(PORT_FILE)) {
    return Number.parseInt(readFileSync(PORT_FILE, "utf-8"), 10);
  }
  throw new Error(`Port file not found: ${PORT_FILE}. Did global-setup run?`);
}

interface E2EPaths {
  testDir: string;
  claudeSessionsDir: string;
  codexSessionsDir: string;
  geminiSessionsDir: string;
  dataDir: string;
}

function getTestPaths(): E2EPaths {
  if (existsSync(PATHS_FILE)) {
    return JSON.parse(readFileSync(PATHS_FILE, "utf-8"));
  }
  throw new Error(`Paths file not found: ${PATHS_FILE}. Did global-setup run?`);
}

// Export paths for tests to use instead of hardcoded homedir() paths
export const e2ePaths = {
  get testDir() {
    return getTestPaths().testDir;
  },
  get claudeSessionsDir() {
    return getTestPaths().claudeSessionsDir;
  },
  get codexSessionsDir() {
    return getTestPaths().codexSessionsDir;
  },
  get geminiSessionsDir() {
    return getTestPaths().geminiSessionsDir;
  },
  get dataDir() {
    return getTestPaths().dataDir;
  },
};

// Extend base test with dynamic baseURL
export const test = base.extend({
  // biome-ignore lint/correctness/noEmptyPattern: Playwright fixture pattern requires empty destructure
  baseURL: async ({}, use) => {
    const port = getServerPort();
    await use(`http://localhost:${port}`);
  },
});

export { expect } from "@playwright/test";
