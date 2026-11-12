import type { MiddlewareHandler } from "hono";
import { cors } from "hono/cors";
import { isAllowedHost, isAllowedOrigin } from "./allowed-hosts.js";

/**
 * Host header validation middleware.
 * Protects against DNS rebinding attacks by ensuring the Host header
 * matches an allowed hostname. Skipped when ALLOWED_HOSTS=*.
 */
export const hostCheckMiddleware: MiddlewareHandler = async (c, next) => {
  const host = c.req.header("host");
  if (!isAllowedHost(host)) {
    console.warn(`[Security] Rejected request with Host: ${host}`);
    const hostname = host ?? "(unknown)";
    return c.text(
      [
        `Blocked request: "${hostname}" is not an allowed host.`,
        "",
        "To fix this, add it to the ALLOWED_HOSTS environment variable:",
        "",
        `  ALLOWED_HOSTS=${hostname.replace(/:\d+$/, "")}`,
        "",
        "Or allow all hosts (less secure):",
        "",
        "  ALLOWED_HOSTS=*",
        "",
        "Multiple hosts can be comma-separated:",
        "",
        `  ALLOWED_HOSTS=${hostname.replace(/:\d+$/, "")},other.example.com`,
      ].join("\n"),
      403,
    );
  }
  await next();
};

export const corsMiddleware = cors({
  origin: (origin, c) =>
    isAllowedOrigin(origin, c.req.header("host")) ? origin : null,
  credentials: true,
  allowMethods: ["GET", "POST", "PUT", "DELETE"],
  allowHeaders: ["Content-Type", "Authorization", "X-Yep-Anywhere"],
});

// Only require header on mutating requests (SSE uses native EventSource which can't send headers)
export const requireCustomHeader: MiddlewareHandler = async (c, next) => {
  const method = c.req.method;
  if (method !== "GET" && method !== "HEAD" && method !== "OPTIONS") {
    if (c.req.header("X-Yep-Anywhere") !== "true") {
      return c.json({ error: "Missing required header" }, 403);
    }
  }
  await next();
};
