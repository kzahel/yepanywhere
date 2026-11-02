import { randomUUID } from "node:crypto";
import { chmod, rm } from "node:fs/promises";
import { createServer, type Socket } from "node:net";
import {
  type ProviderSessionOwner,
  providerSessionErrorMessage,
} from "./provider-session-owner.js";

function writeSocket(socket: Socket, message: unknown): void {
  if (socket.destroyed) return;
  socket.write(`${JSON.stringify(message)}\n`);
}

export class ProviderRuntimeSocketAdapter {
  private server: ReturnType<typeof createServer> | null = null;
  private connections = new Set<Socket>();
  private controllerIds = new Map<Socket, string>();

  constructor(
    private readonly socketPath: string,
    private readonly token: string,
    private readonly owner: ProviderSessionOwner,
  ) {}

  async listen(): Promise<void> {
    await rm(this.socketPath, { force: true });
    this.server = createServer((socket) => this.handleConnection(socket));
    await new Promise<void>((resolve, reject) => {
      const server = this.server;
      if (!server) {
        reject(new Error("Provider worker socket server is unavailable"));
        return;
      }
      server.once("error", reject);
      server.listen(this.socketPath, resolve);
    });
    await chmod(this.socketPath, 0o600);
  }

  private handleConnection(socket: Socket): void {
    const controllerId = randomUUID();
    this.connections.add(socket);
    this.controllerIds.set(socket, controllerId);
    socket.setEncoding("utf8");
    let buffer = "";
    let attached = false;
    socket.on("data", (chunk) => {
      buffer += chunk;
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const rawLine of lines) {
        if (!rawLine.trim()) continue;
        let request: Record<string, unknown>;
        try {
          request = JSON.parse(rawLine) as Record<string, unknown>;
        } catch {
          writeSocket(socket, { type: "error", error: "Invalid JSON request" });
          continue;
        }
        if (!attached) {
          try {
            this.attach(socket, controllerId, request);
            attached = true;
          } catch (error) {
            writeSocket(socket, {
              type: "error",
              error: providerSessionErrorMessage(error),
            });
            socket.end();
          }
          continue;
        }
        void this.owner
          .handleControllerRequest(controllerId, request)
          .catch((error) => this.owner.emitControllerError(request, error));
      }
    });
    socket.on("close", () => {
      this.connections.delete(socket);
      this.controllerIds.delete(socket);
      this.owner.detach(controllerId);
    });
    socket.on("error", () => {});
  }

  private attach(
    socket: Socket,
    controllerId: string,
    request: Record<string, unknown>,
  ): void {
    if (request.type !== "attach" || request.token !== this.token) {
      throw new Error("Unauthorized provider worker attach");
    }
    if (request.protocolVersion !== this.owner.protocolVersion()) {
      throw new Error("Incompatible provider worker protocol");
    }
    const generation =
      typeof request.generation === "string" ? request.generation : "";
    this.owner.attach(
      controllerId,
      generation,
      (message) => writeSocket(socket, message),
      {
        creation: request.creation,
        binding: request.binding,
        isActive: () => !socket.destroyed,
        agentApiAllowed: request.agentApiAllowed === true,
        agentApiPeersAllowed: request.agentApiPeersAllowed === true,
        agentApiPeerGrantId:
          typeof request.agentApiPeerGrantId === "string"
            ? request.agentApiPeerGrantId
            : undefined,
      },
    );
  }

  async close(): Promise<void> {
    for (const socket of this.connections) socket.destroy();
    this.connections.clear();
    this.controllerIds.clear();
    if (this.server) {
      await new Promise<void>((resolve) => this.server?.close(() => resolve()));
      this.server = null;
    }
    await rm(this.socketPath, { force: true });
  }
}
