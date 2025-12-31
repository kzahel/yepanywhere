/**
 * Frontend serving module.
 *
 * This module provides both development and production modes:
 * - Development: Proxy to Vite dev server (with HMR support)
 * - Production: Serve static files from the built client
 */
export {
  createFrontendProxy,
  attachFrontendProxyUpgrade,
  attachUnifiedUpgradeHandler,
  type FrontendProxyOptions,
  type FrontendProxy,
  type UnifiedUpgradeOptions,
} from "./proxy.js";
export { createStaticRoutes, type StaticServeOptions } from "./static.js";
