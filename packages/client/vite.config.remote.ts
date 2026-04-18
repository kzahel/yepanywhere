/**
 * Vite config for remote (static) client build.
 *
 * This builds a standalone static site that can be deployed to GitHub Pages.
 * It uses remote.html as the entry point instead of index.html.
 */

import { execSync } from "node:child_process";
import { resolve } from "node:path";
import react from "@vitejs/plugin-react";
import { type Plugin, defineConfig } from "vite";
import { cspPlugin } from "./vite-plugin-csp";

function getGitVersion(): string {
  try {
    return execSync("git describe --tags --always", {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    })
      .trim()
      .replace(/^v/, "");
  } catch {
    return "dev";
  }
}

// Port for dev server (different from regular client to allow parallel dev)
const remoteDevPort = process.env.REMOTE_PORT
  ? Number.parseInt(process.env.REMOTE_PORT, 10)
  : 3403;

// In watch mode (staging), don't empty the output dir to avoid race conditions
const isWatchMode = process.argv.includes("--watch");

// Base path for built assets. Defaults to "/" (for deployment at the server root,
// e.g. GitHub Pages). Self-hosters who serve the remote SPA under a sub-path
// (e.g. https://example.com/remote/) should build with VITE_BASE=/remote/ so the
// emitted HTML references /remote/assets/* instead of /assets/*. See issue #27.
const basePath = process.env.VITE_BASE || "/";

/**
 * Plugin to serve remote.html instead of index.html in dev mode.
 * This makes the dev server behave like the production build.
 * We need to intercept ALL HTML requests (for SPA routing), not just root.
 */
function serveRemoteHtml(): Plugin {
  return {
    name: "serve-remote-html",
    configureServer(server) {
      // Add middleware BEFORE Vite's internal middleware (no return statement)
      server.middlewares.use((req, _res, next) => {
        // Skip actual file requests (assets, source files)
        if (
          req.url?.startsWith("/@") || // Vite internal
          req.url?.startsWith("/src/") || // Source files
          req.url?.startsWith("/node_modules/") || // Node modules
          req.url?.includes(".") // Files with extensions
        ) {
          return next();
        }

        // For SPA routes, serve remote.html
        // This handles /projects, /settings, etc.
        req.url = "/remote.html";
        next();
      });
    },
  };
}

export default defineConfig({
  clearScreen: false,
  base: basePath,
  plugins: [serveRemoteHtml(), react(), cspPlugin({ isRemote: true })],
  resolve: {
    conditions: ["source"],
  },
  // Define build-time constants
  define: {
    "import.meta.env.VITE_IS_REMOTE_CLIENT": JSON.stringify(true),
    __APP_VERSION__: JSON.stringify(getGitVersion()),
  },
  // Build configuration for static site
  build: {
    outDir: "dist-remote",
    emptyOutDir: !isWatchMode, // Don't empty in watch mode to avoid race conditions
    rollupOptions: {
      input: {
        main: resolve(__dirname, "remote.html"),
      },
    },
  },
  // Dev server configuration
  server: {
    // When REMOTE_PORT=0, let Vite pick an available port (for E2E tests)
    port: remoteDevPort === 0 ? undefined : remoteDevPort,
    strictPort: remoteDevPort !== 0,
    // Allow connections from any host (for LAN testing)
    host: true,
    // Allow these hosts to connect
    allowedHosts: ["localhost", ".yepanywhere.com"],
  },
});
