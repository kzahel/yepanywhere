import { connect, createServer, type Server, type Socket } from "node:net";
import type { ProjectAppAutoStart } from "./ProjectAppAutoStart.js";
import type {
  ProjectServices,
  ProjectServiceUpstream,
} from "./ProjectServiceManager.js";

const MAX_CONNECTIONS = 256;

interface Held {
  port: number;
  server: Server;
  listening: boolean;
  error?: string;
}

export interface HostPortStatus {
  listening: boolean;
  error?: string;
}

/**
 * Host loopback ports forwarded to running process apps
 * (topics/project-service.md § Direct serving). A declared `hostPort` lets
 * a host-side proxy such as Tailscale Funnel reach a sandboxed app, whose
 * own port lives in its private network namespace. Each connection is
 * spliced through the app's sandbox broker as raw TCP, with no YA access
 * check: anything that reaches the port reaches the app. A connection that
 * finds the app stopped starts it only when its auto-start on visit is on.
 */
export class ProjectAppHostPorts {
  private readonly held = new Map<string, Held>();
  private readonly pending = new Map<string, Promise<void>>();
  private closed = false;

  constructor(
    private readonly deps: {
      services: Pick<ProjectServices, "upstream">;
      autoStart?: Pick<ProjectAppAutoStart, "recover">;
    },
  ) {}

  status(projectId: string): HostPortStatus | undefined {
    const held = this.held.get(projectId);
    return held && { listening: held.listening, error: held.error };
  }

  /**
   * Hold `port` for the project, or release it when undefined. A port that
   * was busy is tried again, so freeing it needs no YA restart.
   */
  reconcile(projectId: string, port: number | undefined): Promise<void> {
    const previous = this.pending.get(projectId) ?? Promise.resolve();
    const next = previous
      .catch(() => undefined)
      .then(() => this.apply(projectId, port));
    this.pending.set(projectId, next);
    const clear = () => {
      if (this.pending.get(projectId) === next) this.pending.delete(projectId);
    };
    void next.then(clear, clear);
    return next;
  }

  private async apply(projectId: string, port: number | undefined) {
    const current = this.held.get(projectId);
    if (current && current.port === port && current.listening) return;
    if (current) await this.release(projectId);
    if (port === undefined || this.closed) return;
    const server = createServer({ allowHalfOpen: false }, (client) =>
      this.forward(projectId, client),
    );
    server.maxConnections = MAX_CONNECTIONS;
    const held: Held = { port, server, listening: false };
    this.held.set(projectId, held);
    await new Promise<void>((settle) => {
      server.once("error", (error: NodeJS.ErrnoException) => {
        held.error =
          error.code === "EADDRINUSE"
            ? `Port ${port} is already in use on this host`
            : error.message;
        settle();
      });
      server.listen({ host: "127.0.0.1", port }, () => {
        held.listening = true;
        settle();
      });
    });
  }

  private async release(projectId: string): Promise<void> {
    const held = this.held.get(projectId);
    if (!held) return;
    this.held.delete(projectId);
    if (!held.listening) return;
    await new Promise<void>((done) => held.server.close(() => done()));
  }

  private forward(projectId: string, client: Socket): void {
    client.pause();
    client.on("error", () => client.destroy());
    void this.upstream(projectId).then(
      (upstream) => {
        if (!upstream || client.destroyed) {
          client.destroy();
          return;
        }
        const target = connect(upstream.brokerSocket);
        target.on("error", () => {
          target.destroy();
          client.destroy();
        });
        client.on("close", () => target.destroy());
        target.on("close", () => client.destroy());
        target.write(`${upstream.port}\n`);
        client.pipe(target);
        target.pipe(client);
      },
      () => client.destroy(),
    );
  }

  private async upstream(
    projectId: string,
  ): Promise<ProjectServiceUpstream | null> {
    const running = await this.deps.services.upstream(projectId);
    if (running) return running;
    return (
      (await this.deps.autoStart?.recover(projectId, "not-running", null)) ??
      null
    );
  }

  async close(): Promise<void> {
    this.closed = true;
    await Promise.all([...this.held.keys()].map((id) => this.release(id)));
  }
}
