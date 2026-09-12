import { createConnection, type Socket } from "node:net";

export class ComputerDeliveryError extends Error {
  constructor(
    message: string,
    readonly delivery: "unknown" | "refused",
  ) {
    super(message);
  }
}

/** One request per native PipeTransport connection. Never retries a write. */
export function callComputerPipe(
  pipe: string,
  request: Record<string, unknown>,
  timeoutMs = 15_000,
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let dispatched = false;
    let settled = false;
    let bytes = 0;
    const chunks: Buffer[] = [];
    let socket: Socket;
    let connectTimer: ReturnType<typeof setTimeout> | undefined;
    const finish = (error?: Error, result?: Record<string, unknown>) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(connectTimer);
      socket.destroy();
      if (error) reject(error);
      else resolve(result ?? {});
    };
    const fail = (message: string) =>
      finish(
        new ComputerDeliveryError(message, dispatched ? "unknown" : "refused"),
      );
    const timer = setTimeout(
      () => fail("Native request deadline exceeded"),
      timeoutMs,
    );
    const connect = () => {
      if (settled) return;
      socket = createConnection(pipe);
      socket.on("error", (error: NodeJS.ErrnoException) => {
        if (
          !dispatched &&
          ["ENOENT", "EBUSY", "ECONNREFUSED"].includes(error.code ?? "")
        ) {
          socket.destroy();
          connectTimer = setTimeout(connect, 25);
        } else fail("Native pipe unavailable or disconnected");
      });
      socket.on("end", () =>
        fail("Native pipe closed without a complete response"),
      );
      socket.on("connect", () => {
        dispatched = true;
        socket.write(`${JSON.stringify(request)}\n`);
      });
      socket.on("data", (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > 2 * 1024 * 1024)
          return fail("Native response exceeds 2 MiB");
        chunks.push(chunk);
        if (!chunk.includes(10)) return;
        try {
          const value: unknown = JSON.parse(
            Buffer.concat(chunks).toString("utf8").trim(),
          );
          if (!value || typeof value !== "object" || Array.isArray(value))
            throw new Error();
          const result = value as Record<string, unknown>;
          if (
            result.schema !== "machine-control/v0" ||
            result.requestId !== request.requestId ||
            result.operation !== request.operation ||
            typeof result.accepted !== "boolean"
          )
            throw new Error();
          finish(undefined, result);
        } catch {
          fail("Invalid native response envelope");
        }
      });
    };
    connect();
  });
}
