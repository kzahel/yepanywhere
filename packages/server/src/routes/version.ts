import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { Hono } from "hono";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Get version from git describe (for dev mode)
 * Returns something like "v0.1.7" or "v0.1.7-3-g050bfd2" (3 commits after tag)
 */
function getGitVersion(): string | null {
  try {
    const version = execSync("git describe --tags --always", {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
    return version || null;
  } catch {
    return null;
  }
}

/**
 * Read the current package version from package.json
 */
function getCurrentVersion(): string {
  try {
    // In production (npm package), package.json is in the parent of dist/
    // In development, it's in packages/server/
    const packageJsonPath = path.resolve(__dirname, "../../package.json");
    const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf-8"));
    const version = packageJson.version || "unknown";

    // 0.0.1 is the workspace version - we're in dev mode, use git instead
    if (version === "0.0.1") {
      return getGitVersion() || "dev";
    }

    return version;
  } catch {
    return "unknown";
  }
}

// Cache for npm registry check (5 minute TTL)
let cachedLatestVersion: { version: string; timestamp: number } | null = null;
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Fetch the latest version from npm registry
 */
async function getLatestNpmVersion(): Promise<string | null> {
  // Return cached value if fresh
  if (
    cachedLatestVersion &&
    Date.now() - cachedLatestVersion.timestamp < CACHE_TTL_MS
  ) {
    return cachedLatestVersion.version;
  }

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 5000); // 5s timeout

    const response = await fetch(
      "https://registry.npmjs.org/yepanywhere/latest",
      {
        signal: controller.signal,
        headers: {
          Accept: "application/json",
        },
      },
    );

    clearTimeout(timeoutId);

    if (!response.ok) {
      return null;
    }

    const data = (await response.json()) as { version?: string };
    const version = data.version || null;

    if (version) {
      cachedLatestVersion = { version, timestamp: Date.now() };
    }

    return version;
  } catch {
    // Network error, timeout, etc. - fail silently
    return null;
  }
}

/**
 * Compare semver versions
 * Returns true if latest is newer than current
 */
function isNewerVersion(current: string, latest: string): boolean {
  if (current === "unknown" || !latest) return false;

  const parseVersion = (v: string) => {
    const match = v.match(/^(\d+)\.(\d+)\.(\d+)/);
    if (!match || !match[1] || !match[2] || !match[3]) return null;
    return {
      major: Number.parseInt(match[1], 10),
      minor: Number.parseInt(match[2], 10),
      patch: Number.parseInt(match[3], 10),
    };
  };

  const currentParsed = parseVersion(current);
  const latestParsed = parseVersion(latest);

  if (!currentParsed || !latestParsed) return false;

  if (latestParsed.major > currentParsed.major) return true;
  if (latestParsed.major < currentParsed.major) return false;

  if (latestParsed.minor > currentParsed.minor) return true;
  if (latestParsed.minor < currentParsed.minor) return false;

  return latestParsed.patch > currentParsed.patch;
}

export interface VersionInfo {
  current: string;
  latest: string | null;
  updateAvailable: boolean;
}

export const version = new Hono();

version.get("/", async (c) => {
  const current = getCurrentVersion();
  const latest = await getLatestNpmVersion();

  // For dev versions like "v0.1.7-3-g050bfd2", extract base version "v0.1.7"
  // to compare against npm. This tells devs if they're behind the latest release.
  const baseVersion = current.split("-")[0] || current;
  const updateAvailable = latest ? isNewerVersion(baseVersion, latest) : false;

  const info: VersionInfo = {
    current,
    latest,
    updateAvailable,
  };

  return c.json(info);
});
