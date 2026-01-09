#!/usr/bin/env tsx

/**
 * Build script for npm package distribution
 *
 * This script prepares a single bundle for npm publishing by:
 * 1. Building the shared package (types)
 * 2. Building the client (React app)
 * 3. Building the server (Node.js app)
 * 4. Copying client dist into server package for embedded serving
 *
 * The resulting server package contains everything needed for distribution.
 */

import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

const ROOT_DIR = path.resolve(import.meta.dirname, "..");
const CLIENT_DIST = path.join(ROOT_DIR, "packages/client/dist");
const SERVER_PACKAGE = path.join(ROOT_DIR, "packages/server");
const SERVER_DIST = path.join(SERVER_PACKAGE, "dist");
const SHARED_DIST = path.join(ROOT_DIR, "packages/shared/dist");

// Staging directory for npm publishing (keeps workspace package.json intact)
const STAGING_DIR = path.join(ROOT_DIR, "dist/npm-package");

// Version for npm package - update this when releasing
const NPM_VERSION = "0.1.1";

interface StepResult {
  step: string;
  success: boolean;
  error?: string;
}

const results: StepResult[] = [];

function log(message: string): void {
  console.log(`[build-bundle] ${message}`);
}

function error(message: string): void {
  console.error(`[build-bundle] ERROR: ${message}`);
}

function execStep(command: string, cwd?: string): void {
  execSync(command, {
    stdio: "inherit",
    cwd: cwd || ROOT_DIR,
  });
}

function step(name: string, fn: () => void): void {
  log(`\n${"=".repeat(60)}`);
  log(`Step: ${name}`);
  log("=".repeat(60));

  try {
    fn();
    results.push({ step: name, success: true });
    log(`✓ ${name} completed`);
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    results.push({ step: name, success: false, error: errorMsg });
    error(`✗ ${name} failed: ${errorMsg}`);
    throw err;
  }
}

// Clean previous build artifacts
step("Clean previous builds", () => {
  log("Removing old dist directories...");

  const dirsToClean = [
    SHARED_DIST,
    CLIENT_DIST,
    SERVER_DIST,
    STAGING_DIR,
  ];

  for (const dir of dirsToClean) {
    if (fs.existsSync(dir)) {
      fs.rmSync(dir, { recursive: true, force: true });
      log(`  Removed: ${path.relative(ROOT_DIR, dir)}`);
    }
  }
});

// Build shared package (types/schemas)
step("Build shared package", () => {
  log("Building @yep-anywhere/shared (TypeScript compilation)...");
  execStep("pnpm --filter @yep-anywhere/shared build");
});

// Build client
step("Build client", () => {
  log("Building @yep-anywhere/client (Vite production build)...");
  execStep("pnpm --filter @yep-anywhere/client build");

  // Verify client dist exists
  if (!fs.existsSync(CLIENT_DIST)) {
    throw new Error(
      `Client dist not found at ${CLIENT_DIST} after build. Vite build may have failed.`,
    );
  }

  const indexHtml = path.join(CLIENT_DIST, "index.html");
  if (!fs.existsSync(indexHtml)) {
    throw new Error(
      "Client dist exists but index.html not found. Incomplete build?",
    );
  }

  log(`  Client built successfully: ${path.relative(ROOT_DIR, CLIENT_DIST)}`);
});

// Build server
step("Build server", () => {
  log("Building @yep-anywhere/server (TypeScript compilation)...");
  execStep("pnpm --filter @yep-anywhere/server build");

  // Verify server dist exists
  const serverDist = path.join(SERVER_PACKAGE, "dist");
  if (!fs.existsSync(serverDist)) {
    throw new Error(
      `Server dist not found at ${serverDist} after build. TypeScript compilation may have failed.`,
    );
  }

  log(`  Server built successfully: ${path.relative(ROOT_DIR, serverDist)}`);
});

// Create staging directory structure
step("Create staging directory", () => {
  log(`Creating staging directory at ${path.relative(ROOT_DIR, STAGING_DIR)}...`);
  fs.mkdirSync(STAGING_DIR, { recursive: true });
});

// Copy server dist to staging
step("Copy server dist to staging", () => {
  const stagingDist = path.join(STAGING_DIR, "dist");
  log(`Copying server dist to ${path.relative(ROOT_DIR, stagingDist)}...`);
  copyRecursive(SERVER_DIST, stagingDist);
  log("  Server dist copied to staging");
});

// Copy shared dist into staging (for @yep-anywhere/shared imports)
// We put it in 'bundled/' instead of 'node_modules/' because npm ignores node_modules
step("Bundle shared into staging", () => {
  const bundledSharedPath = path.join(STAGING_DIR, "bundled/@yep-anywhere/shared");
  const bundledSharedDist = path.join(bundledSharedPath, "dist");

  log(`Copying shared dist to ${path.relative(ROOT_DIR, bundledSharedDist)}...`);

  // Create directory structure
  fs.mkdirSync(bundledSharedDist, { recursive: true });

  // Copy shared dist files
  copyRecursive(SHARED_DIST, bundledSharedDist);

  // Create a minimal package.json for the shared package
  const sharedPackageJson = {
    name: "@yep-anywhere/shared",
    version: NPM_VERSION,
    type: "module",
    main: "dist/index.js",
    types: "dist/index.d.ts",
  };
  fs.writeFileSync(
    path.join(bundledSharedPath, "package.json"),
    JSON.stringify(sharedPackageJson, null, 2),
  );

  log("  Shared types and runtime bundled into staging");
});

// Copy client dist into staging
step("Bundle client into staging", () => {
  const stagingClientDist = path.join(STAGING_DIR, "client-dist");
  log(`Copying client dist to ${path.relative(ROOT_DIR, stagingClientDist)}...`);

  // Create staging client-dist directory
  fs.mkdirSync(stagingClientDist, { recursive: true });

  // Copy all client dist files
  copyRecursive(CLIENT_DIST, stagingClientDist);

  // Verify critical files were copied
  const copiedIndexHtml = path.join(stagingClientDist, "index.html");
  if (!fs.existsSync(copiedIndexHtml)) {
    throw new Error("Failed to copy client dist: index.html not found");
  }

  log("  Client assets bundled into staging");
});

// Copy postinstall script to staging
step("Copy postinstall script to staging", () => {
  const srcScript = path.join(SERVER_PACKAGE, "scripts/postinstall.js");
  const destScriptsDir = path.join(STAGING_DIR, "scripts");
  const destScript = path.join(destScriptsDir, "postinstall.js");

  log(`Copying postinstall script to ${path.relative(ROOT_DIR, destScript)}...`);

  fs.mkdirSync(destScriptsDir, { recursive: true });
  fs.copyFileSync(srcScript, destScript);

  log("  Postinstall script copied to staging");
});

// Generate package.json for publishing (in staging, not modifying original)
step("Generate package.json for npm", () => {
  log("Generating package.json for npm publishing...");

  const sourcePackageJsonPath = path.join(SERVER_PACKAGE, "package.json");
  const sourcePackageJson = JSON.parse(fs.readFileSync(sourcePackageJsonPath, "utf-8"));

  // Create a new package.json for publishing
  const npmPackageJson: Record<string, unknown> = {
    name: "yepanywhere",
    version: NPM_VERSION,
    description: "A mobile-first supervisor for Claude Code agents",
    type: "module",
    bin: {
      yepanywhere: "./dist/cli.js",
    },
    main: "./dist/index.js",
    exports: {
      ".": "./dist/index.js",
    },
    files: ["dist", "client-dist", "bundled", "scripts", "README.md"],
    scripts: {
      postinstall: "node scripts/postinstall.js",
    },
    // Copy dependencies from source, excluding workspace deps
    dependencies: Object.fromEntries(
      Object.entries(sourcePackageJson.dependencies || {}).filter(
        ([name]) => !name.startsWith("@yep-anywhere/"),
      ),
    ),
    repository: {
      type: "git",
      url: "git+https://github.com/kgraehl/yepanywhere.git",
    },
    homepage: "https://github.com/kgraehl/yepanywhere#readme",
    bugs: {
      url: "https://github.com/kgraehl/yepanywhere/issues",
    },
    keywords: ["claude", "ai", "agent", "supervisor", "mobile"],
    license: "MIT",
    engines: {
      node: ">=20",
    },
  };

  // Write to staging directory
  const stagingPackageJsonPath = path.join(STAGING_DIR, "package.json");
  fs.writeFileSync(
    stagingPackageJsonPath,
    `${JSON.stringify(npmPackageJson, null, 2)}\n`,
  );

  log("  Package name: yepanywhere");
  log(`  Version: ${NPM_VERSION}`);
  log("  Written to: dist/npm-package/package.json");
  log("  (Original packages/server/package.json unchanged)");
});

// Copy README to staging
step("Copy README to staging", () => {
  const readmeSrc = path.join(ROOT_DIR, "README.md");
  const readmeDest = path.join(STAGING_DIR, "README.md");

  if (fs.existsSync(readmeSrc)) {
    fs.copyFileSync(readmeSrc, readmeDest);
    log("  Copied README.md from repo root");
  } else {
    // Create a basic README if none exists
    const basicReadme = `# yepanywhere

A mobile-first supervisor for Claude Code agents.

## Installation

\`\`\`bash
npm install -g yepanywhere
\`\`\`

## Usage

\`\`\`bash
yepanywhere
\`\`\`

Then open http://localhost:3400 in your browser.

## Features

- **Server-owned processes** — Claude runs on your dev machine; client disconnects don't interrupt work
- **Multi-session dashboard** — See all projects at a glance, no window cycling
- **Mobile supervision** — Push notifications for approvals, respond from your lock screen
- **Zero external dependencies** — No Firebase, no accounts, just Tailscale for network access

## License

MIT
`;
    fs.writeFileSync(readmeDest, basicReadme);
    log("  Created basic README.md (no repo README found)");
  }
});

// Helper: Recursive copy
function copyRecursive(src: string, dest: string): void {
  const stats = fs.statSync(src);

  if (stats.isDirectory()) {
    fs.mkdirSync(dest, { recursive: true });
    for (const file of fs.readdirSync(src)) {
      copyRecursive(path.join(src, file), path.join(dest, file));
    }
  } else {
    fs.copyFileSync(src, dest);
  }
}

// Print summary
log(`\n${"=".repeat(60)}`);
log("Build Summary");
log("=".repeat(60));

for (const result of results) {
  const status = result.success ? "✓" : "✗";
  log(`${status} ${result.step}`);
  if (result.error) {
    log(`  Error: ${result.error}`);
  }
}

const allSuccess = results.every((r) => r.success);
if (allSuccess) {
  log("\n✓ All build steps completed successfully!");
  log("\nThe npm package is ready for publishing:");
  log(`  Location: ${path.relative(ROOT_DIR, STAGING_DIR)}`);
  log("\nNext steps:");
  log("  1. cd dist/npm-package");
  log("  2. Test: npm pack");
  log("  3. Publish: npm publish");
  log("\nNote: packages/server/package.json is unchanged (workspace intact)");
} else {
  error("\n✗ Build failed. See errors above.");
  process.exit(1);
}
