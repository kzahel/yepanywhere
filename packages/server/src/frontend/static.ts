/**
 * Static file serving for production mode.
 *
 * In production, we serve the built Vite output directly from the backend.
 * This provides a single-port deployment without needing a separate web server.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { Hono } from "hono";

export interface StaticServeOptions {
  /** Path to the built client dist directory */
  distPath: string;
}

/**
 * Create Hono routes for serving static files.
 *
 * This serves:
 * - Static assets (JS, CSS, images) with appropriate headers
 * - index.html for all other routes (SPA fallback)
 */
export function createStaticRoutes(options: StaticServeOptions): Hono {
  const { distPath } = options;
  const app = new Hono();

  // Check if dist directory exists
  if (!fs.existsSync(distPath)) {
    console.warn(
      `[Static] Warning: dist directory not found at ${distPath}. Run 'pnpm build' first.`,
    );
  }

  // Read index.html once at startup for SPA fallback
  const indexPath = path.join(distPath, "index.html");
  let indexHtml: string | null = null;
  try {
    indexHtml = fs.readFileSync(indexPath, "utf-8");
  } catch {
    // Will be handled per-request
  }

  // Serve static files
  app.get("*", async (c) => {
    const reqPath = c.req.path;

    // Try to serve the exact file
    const filePath = path.join(distPath, reqPath);

    // Security: ensure we're not escaping the dist directory
    const normalizedFilePath = path.normalize(filePath);
    if (!normalizedFilePath.startsWith(distPath)) {
      return c.text("Forbidden", 403);
    }

    try {
      const stat = await fs.promises.stat(filePath);

      if (stat.isFile()) {
        const content = await fs.promises.readFile(filePath);
        const ext = path.extname(filePath).toLowerCase();
        const contentType = getContentType(ext);

        // Cache static assets (they have hashed filenames)
        const cacheControl = isHashedAsset(reqPath)
          ? "public, max-age=31536000, immutable"
          : "public, max-age=0, must-revalidate";

        return c.body(content, 200, {
          "Content-Type": contentType,
          "Cache-Control": cacheControl,
        });
      }
    } catch {
      // File doesn't exist, fall through to SPA fallback
    }

    // SPA fallback: serve index.html for all other routes
    if (indexHtml) {
      return c.html(indexHtml);
    }

    return c.text(
      "Not found. Did you run 'pnpm build' to build the client?",
      404,
    );
  });

  return app;
}

/**
 * Get content type for a file extension.
 */
function getContentType(ext: string): string {
  const types: Record<string, string> = {
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
    ".eot": "application/vnd.ms-fontobject",
    ".map": "application/json",
  };

  return types[ext] || "application/octet-stream";
}

/**
 * Check if a path is a hashed asset (can be cached forever).
 * Vite adds hashes to filenames like: index-abc123.js
 */
function isHashedAsset(reqPath: string): boolean {
  // Match patterns like: /assets/index-abc123.js or /assets/style-xyz789.css
  return /\/assets\/[^/]+-[a-f0-9]+\.[a-z]+$/i.test(reqPath);
}
