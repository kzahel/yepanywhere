/**
 * Vite config for remote (static) client build.
 *
 * This builds a standalone static site that can be deployed to GitHub Pages.
 * It uses remote.html as the entry point instead of index.html.
 */

import { resolve } from "node:path";
import react from "@vitejs/plugin-react";
import { type Plugin, defineConfig } from "vite";
import { cspPlugin } from "./vite-plugin-csp";

// Port for dev server (different from regular client to allow parallel dev)
const remoteDevPort = process.env.REMOTE_PORT
  ? Number.parseInt(process.env.REMOTE_PORT, 10)
  : 3403;

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
  plugins: [serveRemoteHtml(), react(), cspPlugin({ isRemote: true })],
  resolve: {
    conditions: ["source"],
  },
  // Define build-time flag for remote client mode
  define: {
    "import.meta.env.VITE_IS_REMOTE_CLIENT": JSON.stringify(true),
  },
  // Build configuration for static site
  build: {
    outDir: "dist-remote",
    emptyOutDir: true,
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
