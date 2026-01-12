import { existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test as base } from "@playwright/test";

const PORT_FILE = join(tmpdir(), "claude-e2e-port");
const MAINTENANCE_PORT_FILE = join(tmpdir(), "claude-e2e-maintenance-port");
const REMOTE_CLIENT_PORT_FILE = join(tmpdir(), "claude-e2e-remote-port");
const RELAY_PORT_FILE = join(tmpdir(), "claude-e2e-relay-port");
const PATHS_FILE = join(tmpdir(), "claude-e2e-paths.json");

function getServerPort(): number {
  if (existsSync(PORT_FILE)) {
    return Number.parseInt(readFileSync(PORT_FILE, "utf-8"), 10);
  }
  throw new Error(`Port file not found: ${PORT_FILE}. Did global-setup run?`);
}

function getMaintenancePort(): number {
  if (existsSync(MAINTENANCE_PORT_FILE)) {
    return Number.parseInt(readFileSync(MAINTENANCE_PORT_FILE, "utf-8"), 10);
  }
  throw new Error(
    `Maintenance port file not found: ${MAINTENANCE_PORT_FILE}. Did global-setup run?`,
  );
}

function getRemoteClientPort(): number {
  if (existsSync(REMOTE_CLIENT_PORT_FILE)) {
    return Number.parseInt(readFileSync(REMOTE_CLIENT_PORT_FILE, "utf-8"), 10);
  }
  throw new Error(
    `Remote client port file not found: ${REMOTE_CLIENT_PORT_FILE}. Did global-setup run?`,
  );
}

function getRelayPort(): number {
  if (existsSync(RELAY_PORT_FILE)) {
    return Number.parseInt(readFileSync(RELAY_PORT_FILE, "utf-8"), 10);
  }
  throw new Error(
    `Relay port file not found: ${RELAY_PORT_FILE}. Did global-setup run?`,
  );
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

/**
 * Helper to configure remote access for tests.
 * Uses the REST API to set up SRP credentials.
 */
export interface RemoteAccessConfig {
  username: string;
  password: string;
}

export async function configureRemoteAccess(
  baseURL: string,
  config: RemoteAccessConfig,
): Promise<void> {
  const response = await fetch(`${baseURL}/api/remote-access/configure`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Yep-Anywhere": "true", // Required by security middleware
    },
    body: JSON.stringify(config),
  });
  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Failed to configure remote access: ${error}`);
  }
}

export async function disableRemoteAccess(baseURL: string): Promise<void> {
  const response = await fetch(`${baseURL}/api/remote-access/clear`, {
    method: "POST",
    headers: {
      "X-Yep-Anywhere": "true", // Required by security middleware
    },
  });
  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Failed to disable remote access: ${error}`);
  }
}

/**
 * Helper to configure relay connection for tests.
 * Uses the REST API to set up relay URL and username.
 */
export interface RelayConfig {
  url: string;
  username: string;
}

export async function configureRelay(
  baseURL: string,
  config: RelayConfig,
): Promise<void> {
  const response = await fetch(`${baseURL}/api/remote-access/relay`, {
    method: "PUT",
    headers: {
      "Content-Type": "application/json",
      "X-Yep-Anywhere": "true", // Required by security middleware
    },
    body: JSON.stringify(config),
  });
  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Failed to configure relay: ${error}`);
  }
}

export async function disableRelay(baseURL: string): Promise<void> {
  const response = await fetch(`${baseURL}/api/remote-access/relay`, {
    method: "DELETE",
    headers: {
      "X-Yep-Anywhere": "true", // Required by security middleware
    },
  });
  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Failed to disable relay: ${error}`);
  }
}

/**
 * Wait for relay client to reach a specific status.
 */
export async function waitForRelayStatus(
  baseURL: string,
  targetStatus: string,
  timeoutMs = 10000,
): Promise<void> {
  const startTime = Date.now();
  while (Date.now() - startTime < timeoutMs) {
    const response = await fetch(`${baseURL}/api/remote-access/relay/status`, {
      headers: {
        "X-Yep-Anywhere": "true",
      },
    });
    if (response.ok) {
      const data = await response.json();
      if (data.status === targetStatus) {
        return;
      }
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(
    `Relay did not reach status "${targetStatus}" within ${timeoutMs}ms`,
  );
}

// Extended test fixtures
interface TestFixtures {
  baseURL: string;
  maintenanceURL: string;
  wsURL: string;
  remoteClientURL: string;
  relayPort: number;
  relayWsURL: string;
}

// Extend base test with dynamic baseURL and maintenanceURL
export const test = base.extend<TestFixtures>({
  // biome-ignore lint/correctness/noEmptyPattern: Playwright fixture pattern requires empty destructure
  baseURL: async ({}, use) => {
    const port = getServerPort();
    await use(`http://localhost:${port}`);
  },
  // biome-ignore lint/correctness/noEmptyPattern: Playwright fixture pattern requires empty destructure
  maintenanceURL: async ({}, use) => {
    const port = getMaintenancePort();
    await use(`http://localhost:${port}`);
  },
  // biome-ignore lint/correctness/noEmptyPattern: Playwright fixture pattern requires empty destructure
  wsURL: async ({}, use) => {
    const port = getServerPort();
    await use(`ws://localhost:${port}/api/ws`);
  },
  // biome-ignore lint/correctness/noEmptyPattern: Playwright fixture pattern requires empty destructure
  remoteClientURL: async ({}, use) => {
    const port = getRemoteClientPort();
    await use(`http://localhost:${port}`);
  },
  // biome-ignore lint/correctness/noEmptyPattern: Playwright fixture pattern requires empty destructure
  relayPort: async ({}, use) => {
    const port = getRelayPort();
    await use(port);
  },
  // biome-ignore lint/correctness/noEmptyPattern: Playwright fixture pattern requires empty destructure
  relayWsURL: async ({}, use) => {
    const port = getRelayPort();
    await use(`ws://localhost:${port}/ws`);
  },
});

export { expect } from "@playwright/test";
