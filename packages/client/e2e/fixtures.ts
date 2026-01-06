import { existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test as base } from "@playwright/test";

const PORT_FILE = join(tmpdir(), "claude-e2e-port");

function getServerPort(): number {
  if (existsSync(PORT_FILE)) {
    return Number.parseInt(readFileSync(PORT_FILE, "utf-8"), 10);
  }
  throw new Error(`Port file not found: ${PORT_FILE}. Did global-setup run?`);
}

// Extend base test with dynamic baseURL
export const test = base.extend({
  // biome-ignore lint/correctness/noEmptyPattern: Playwright fixture pattern requires empty destructure
  baseURL: async ({}, use) => {
    const port = getServerPort();
    await use(`http://localhost:${port}`);
  },
});

export { expect } from "@playwright/test";
