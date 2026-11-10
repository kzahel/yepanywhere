import { execSync } from "node:child_process";
import { resolve } from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { designDataPlugin } from "./design/vite-plugin-design-data";
import { warningFreeBuildLogger } from "./vite-build-policy";
import { cspPlugin, shouldInlineClientAsset } from "./vite-plugin-csp";
import { prebootComposerPlugin } from "./vite-plugin-preboot-composer";
import { newSessionPreloadPlugin } from "./vite-plugin-new-session-preload";
import { reloadNotify } from "./vite-plugin-reload-notify";

// NO_FRONTEND_RELOAD: Suppress application updates with reloadNotify.
const noFrontendReload = process.env.NO_FRONTEND_RELOAD === "true";

// Port defaults to 3402 (base port 3400 + 2), can be overridden via VITE_PORT
const vitePort = process.env.VITE_PORT
  ? Number.parseInt(process.env.VITE_PORT, 10)
  : 3402;

// VITE_HOST: Set to "true" to bind to all interfaces (needed in Docker containers)
const viteHost = process.env.VITE_HOST === "true" ? true : undefined;

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

export default defineConfig(({ command }) => ({
  // Other dev servers must not replace this server's optimized React graph.
  cacheDir: `node_modules/.vite-local-${vitePort}`,
  build: {
    assetsInlineLimit: shouldInlineClientAsset,
    // Mermaid's core and its per-diagram-type chunks are each near 700 kB and
    // arrive only when a transcript actually contains a ```mermaid fence, so
    // they never touch the initial load this warning exists to protect. The
    // ceiling still has to catch an entry chunk growing past that size.
    chunkSizeWarningLimit: 750,
    rollupOptions: {
      output: {
        // Match the hosted build's stable framework boundary so application
        // growth does not rebuild one near-limit entry chunk.
        manualChunks: {
          "react-runtime": ["react", "react-dom/client"],
          katex: ["katex"],
        },
      },
    },
  },
  clearScreen: false,
  customLogger:
    command === "build" ? warningFreeBuildLogger("Client") : undefined,
  define: {
    __APP_VERSION__: JSON.stringify(getGitVersion()),
    // Injected so the client can detect direct access to the Vite dev port
    // (e.g. localhost:3402) and point users at the real app on the main server.
    // See WrongPortNotice in main.tsx. __BACKEND_PORT__ mirrors the server's own
    // derivation (config.ts: PORT ?? 3400) so it stays correct for custom ports.
    __VITE_DEV_PORT__: JSON.stringify(vitePort),
    __BACKEND_PORT__: JSON.stringify(
      process.env.PORT ? Number.parseInt(process.env.PORT, 10) : 3400,
    ),
  },
  plugins: [
    react(),
    // Manual mode suppresses application updates inside the HMR hook.
    reloadNotify({ enabled: noFrontendReload }),
    // Typeable /new-session before the app loads; must precede the CSP hash.
    prebootComposerPlugin(),
    newSessionPreloadPlugin(),
    // Content Security Policy (stricter in production, permissive in dev for HMR)
    cspPlugin({ isRemote: false }),
    // Census data for the separate design playground (design.html).
    designDataPlugin(resolve(__dirname, "src")),
  ],
  resolve: {
    alias: {
      crypto: resolve(__dirname, "src/lib/connection/browserCrypto.ts"),
    },
    conditions: ["source"],
  },
  server: {
    port: vitePort,
    strictPort: true,
    host: viteHost,
    allowedHosts: ["localhost", ".yepanywhere.com"],
    // HMR configuration for reverse proxy setup
    // When accessed through backend proxy (port 3400) or Tailscale, HMR needs to
    // connect back through the same proxy path, not directly to Vite's port
    // Keep HMR machinery alive for config restarts and reloadNotify's hook.
    // An empty config derives the WebSocket address from the browser URL.
    hmr: {},
    // No proxy needed - backend (port 3400) proxies to us, not the other way around
    // Users access http://localhost:3400 and backend forwards non-API requests here
  },
}));
