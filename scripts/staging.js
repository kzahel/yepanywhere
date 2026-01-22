#!/usr/bin/env node

/**
 * Staging server for yepanywhere.com
 *
 * Serves:
 * - / → site/ (marketing website)
 * - /remote/ → packages/client/dist-remote/ (remote client app)
 *
 * Runs vite build --watch in the background to rebuild on source changes.
 * No HMR - refresh the page to see changes.
 *
 * Usage:
 *   pnpm staging              # Default port 3000
 *   PORT=8080 pnpm staging    # Custom port
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as http from "node:http";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.join(__dirname, "..");

const port = process.env.PORT ? Number.parseInt(process.env.PORT, 10) : 3000;

const sitePath = path.join(rootDir, "site");
const remoteDistPath = path.join(rootDir, "packages/client/dist-remote");

// Content types for static files
const contentTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".webp": "image/webp",
  ".webmanifest": "application/manifest+json",
};

/**
 * Serve a static file, always reading fresh from disk (no caching).
 */
function serveFile(res, filePath, fallbackPath = null) {
  // Security: prevent directory traversal
  const normalizedPath = path.normalize(filePath);

  fs.promises
    .stat(normalizedPath)
    .then((stat) => {
      if (stat.isFile()) {
        return fs.promises.readFile(normalizedPath);
      }
      throw new Error("Not a file");
    })
    .then((content) => {
      const ext = path.extname(normalizedPath).toLowerCase();
      const contentType = contentTypes[ext] || "application/octet-stream";

      res.writeHead(200, {
        "Content-Type": contentType,
        "Cache-Control": "no-cache, no-store, must-revalidate",
      });
      res.end(content);
    })
    .catch(() => {
      if (fallbackPath) {
        serveFile(res, fallbackPath);
      } else {
        res.writeHead(404, { "Content-Type": "text/plain" });
        res.end("Not found");
      }
    });
}

/**
 * Handle incoming requests.
 */
function handleRequest(req, res) {
  const url = new URL(req.url, `http://localhost:${port}`);
  const pathname = url.pathname;

  // /remote/ paths -> serve from dist-remote
  if (pathname.startsWith("/remote")) {
    // Strip /remote prefix
    let remotePath = pathname.slice("/remote".length) || "/";
    if (remotePath === "") remotePath = "/";

    // Map to file
    const filePath = path.join(remoteDistPath, remotePath);

    // If path ends with / or has no extension, try remote.html
    if (remotePath.endsWith("/") || !path.extname(remotePath)) {
      // For SPA, all non-asset routes should serve remote.html
      const indexPath = path.join(remoteDistPath, "remote.html");
      serveFile(res, filePath, indexPath);
    } else {
      serveFile(res, filePath);
    }
    return;
  }

  // Root paths -> serve from site/
  let filePath = path.join(sitePath, pathname);

  // Default to index.html for root
  if (pathname === "/") {
    filePath = path.join(sitePath, "index.html");
  }

  // If no extension and not a file, try .html extension
  if (!path.extname(pathname)) {
    const htmlPath = `${filePath}.html`;
    if (fs.existsSync(htmlPath)) {
      filePath = htmlPath;
    }
  }

  serveFile(res, filePath);
}

// Track child processes for cleanup
const children = [];

function cleanup() {
  console.log("\nShutting down...");
  for (const child of children) {
    if (child && !child.killed) {
      child.kill("SIGTERM");
    }
  }
  process.exit(0);
}

process.on("SIGINT", cleanup);
process.on("SIGTERM", cleanup);

/**
 * Start the vite build watcher for the remote client.
 */
function startViteWatch() {
  console.log("[Staging] Starting vite build --watch for remote client...");

  const vite = spawn(
    "pnpm",
    [
      "--filter",
      "client",
      "exec",
      "vite",
      "build",
      "--watch",
      "--config",
      "vite.config.remote.ts",
      "--base",
      "/remote/",
    ],
    {
      cwd: rootDir,
      stdio: ["ignore", "pipe", "pipe"],
      shell: true,
    },
  );

  children.push(vite);

  vite.stdout.on("data", (data) => {
    const msg = data.toString().trim();
    if (msg) console.log(`[Vite] ${msg}`);
  });

  vite.stderr.on("data", (data) => {
    const msg = data.toString().trim();
    if (msg) console.error(`[Vite] ${msg}`);
  });

  vite.on("exit", (code) => {
    if (code !== null && code !== 0) {
      console.error(`[Vite] Exited with code ${code}`);
    }
  });

  return vite;
}

/**
 * Start the static file server.
 */
function startServer() {
  const server = http.createServer(handleRequest);

  server.listen(port, () => {
    console.log(`[Staging] Server running at http://localhost:${port}`);
    console.log("[Staging]   /         -> site/");
    console.log("[Staging]   /remote/  -> packages/client/dist-remote/");
    console.log("[Staging] No HMR - refresh browser to see changes");
  });

  return server;
}

// Check if dist-remote exists, if not do initial build
async function ensureInitialBuild() {
  const indexPath = path.join(remoteDistPath, "remote.html");
  if (!fs.existsSync(indexPath)) {
    console.log("[Staging] dist-remote not found, running initial build...");
    return new Promise((resolve, reject) => {
      const build = spawn(
        "pnpm",
        [
          "--filter",
          "client",
          "exec",
          "vite",
          "build",
          "--config",
          "vite.config.remote.ts",
          "--base",
          "/remote/",
        ],
        {
          cwd: rootDir,
          stdio: "inherit",
          shell: true,
        },
      );

      build.on("exit", (code) => {
        if (code === 0) {
          resolve();
        } else {
          reject(new Error(`Initial build failed with code ${code}`));
        }
      });
    });
  }
}

// Main
async function main() {
  console.log("[Staging] Yepanywhere staging server");
  console.log("");

  // Check site folder exists
  if (!fs.existsSync(sitePath)) {
    console.error(`[Staging] Error: site/ folder not found at ${sitePath}`);
    process.exit(1);
  }

  // Ensure initial build exists
  await ensureInitialBuild();

  // Start vite watch
  startViteWatch();

  // Start server
  startServer();
}

main().catch((err) => {
  console.error("[Staging] Error:", err.message);
  process.exit(1);
});
