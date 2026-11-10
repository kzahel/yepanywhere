/**
 * Vite config for remote (static) client build.
 *
 * This builds a standalone static site that can be deployed to GitHub Pages.
 * It uses remote.html as the app entry and also publishes the design playground.
 */

import { execSync } from "node:child_process";
import { resolve } from "node:path";
import react from "@vitejs/plugin-react";
import { type Plugin, defineConfig } from "vite";
import { designDataPlugin } from "./design/vite-plugin-design-data";
import { warningFreeBuildLogger } from "./vite-build-policy";
import { cspPlugin, shouldInlineClientAsset } from "./vite-plugin-csp";
import { prebootComposerPlugin } from "./vite-plugin-preboot-composer";

function getGitVersion(): string {
  try {
    return execSync(
      "git describe --tags --always --match 'v[0-9]*.[0-9]*.[0-9]*'",
      {
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
      },
    )
      .trim()
      .replace(/^v(?=\d)/, "");
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
        const pathname = req.url?.split("?", 1)[0];
        // Skip actual file requests (assets, source files)
        if (
          pathname?.startsWith("/@") || // Vite internal
          pathname?.startsWith("/src/") || // Source files
          pathname?.startsWith("/node_modules/") || // Node modules
          pathname?.includes(".") // Files with extensions
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

export default defineConfig(({ command }) => ({
  // Keep remote development independent of the local app's dependency graph.
  cacheDir: `node_modules/.vite-remote-${remoteDevPort}`,
  clearScreen: false,
  customLogger:
    command === "build" ? warningFreeBuildLogger("Remote client") : undefined,
  // Remote builds should not serialize dev-only VITE_* shell variables such as
  // VITE_PORT into the hosted bundle. Keep this to intentional public inputs.
  envPrefix: ["VITE_DEFAULT_RELAY_URL"],
  plugins: [
    serveRemoteHtml(),
    react(),
    prebootComposerPlugin(),
    cspPlugin({ isRemote: true }),
    designDataPlugin(resolve(__dirname, "src")),
  ],
  resolve: {
    alias: {
      crypto: resolve(__dirname, "src/lib/connection/browserCrypto.ts"),
    },
    conditions: ["source"],
  },
  // Define build-time constants
  define: {
    "import.meta.env.VITE_IS_REMOTE_CLIENT": JSON.stringify(true),
    __APP_VERSION__: JSON.stringify(getGitVersion()),
    __EXTENSION_DEV_BUILD_ID__: JSON.stringify(""),
    __EXTENSION_DEV_WORKER_HASH__: JSON.stringify(""),
  },
  // Build configuration for static site
  build: {
    assetsInlineLimit: shouldInlineClientAsset,
    outDir: "dist-remote",
    // Emit external .map files (+ sourceMappingURL comments) so production stack
    // traces in the hosted /remote bundle are debuggable. Safe to expose: the
    // client source is already public (open-source repo + npm package).
    sourcemap: true,
    emptyOutDir: !isWatchMode, // Don't empty in watch mode to avoid race conditions
    // Same reason as the local client build: Mermaid's lazily imported chunks
    // sit just under 700 kB and are never part of the initial load.
    chunkSizeWarningLimit: 750,
    rollupOptions: {
      input: {
        main: resolve(__dirname, "remote.html"),
        play: resolve(__dirname, "play.html"),
        design: resolve(__dirname, "design.html"),
      },
      output: {
        manualChunks: {
          "react-runtime": ["react", "react-dom/client"],
          katex: ["katex"],
        },
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
}));
