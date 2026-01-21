import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { cspPlugin } from "./vite-plugin-csp";
import { reloadNotify } from "./vite-plugin-reload-notify";

// NO_FRONTEND_RELOAD: Disable HMR and use manual reload notifications instead
const noFrontendReload = process.env.NO_FRONTEND_RELOAD === "true";

// Port defaults to 3402 (base port 3400 + 2), can be overridden via VITE_PORT
const vitePort = process.env.VITE_PORT
  ? Number.parseInt(process.env.VITE_PORT, 10)
  : 3402;

// VITE_HOST: Set to "true" to bind to all interfaces (needed in Docker containers)
const viteHost = process.env.VITE_HOST === "true" ? true : undefined;

export default defineConfig({
  clearScreen: false,
  plugins: [
    react(),
    // When HMR is disabled, use reload-notify plugin to tell backend about changes
    reloadNotify({ enabled: noFrontendReload }),
    // Content Security Policy (stricter in production, permissive in dev for HMR)
    cspPlugin({ isRemote: false }),
  ],
  resolve: {
    conditions: ["source"],
  },
  server: {
    port: vitePort,
    host: viteHost,
    allowedHosts: ["localhost", ".yepanywhere.com"],
    // HMR configuration for reverse proxy setup
    // When accessed through backend proxy (port 3400) or Tailscale, HMR needs to
    // connect back through the same proxy path, not directly to Vite's port
    hmr: noFrontendReload
      ? false
      : {
          // Let the client determine host/port from its current location
          // This allows HMR to work through any proxy (backend, Tailscale, etc.)
          // The backend will proxy WebSocket connections to us
        },
    // No proxy needed - backend (port 3400) proxies to us, not the other way around
    // Users access http://localhost:3400 and backend forwards non-API requests here
  },
});
