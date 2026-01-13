import { Hono } from "hono";

export interface ServerInfoOptions {
  host: string;
  port: number;
}

export interface ServerInfo {
  /** The host/interface the server is bound to (e.g., "127.0.0.1" or "0.0.0.0") */
  host: string;
  /** The port the server is listening on */
  port: number;
  /** Whether the server is bound to all interfaces (0.0.0.0) */
  boundToAllInterfaces: boolean;
  /** Whether the server is localhost-only */
  localhostOnly: boolean;
}

export function createServerInfoRoutes(options: ServerInfoOptions) {
  const app = new Hono();

  app.get("/", (c) => {
    const info: ServerInfo = {
      host: options.host,
      port: options.port,
      boundToAllInterfaces: options.host === "0.0.0.0" || options.host === "::",
      localhostOnly:
        options.host === "127.0.0.1" ||
        options.host === "localhost" ||
        options.host === "::1",
    };
    return c.json(info);
  });

  return app;
}
