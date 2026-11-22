import { createConnection } from "node:net";
import { getModuleEnv } from "./yaModuleEnv.js";

const REQUEST_TIMEOUT_MS = 2_000;
const SAFE_RELOAD_TIMEOUT_MS = 120_000;

interface WrapperRequest {
  op: "reload" | "safeReload" | "registerBackend" | "backendListening";
  generation?: string;
  pid?: number;
  host?: string;
  port?: number;
}

function requestDevWrapper(
  request: WrapperRequest,
  unavailableValue: boolean,
  approve?: (signal: AbortSignal) => Promise<boolean>,
): Promise<boolean> {
  const wrapperEnv = getModuleEnv("dev-wrapper");
  const rawPort = wrapperEnv.PORT?.trim();
  const token = wrapperEnv.TOKEN?.trim();
  if (!rawPort || !token) return Promise.resolve(unavailableValue);

  const port = Number.parseInt(rawPort, 10);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    return Promise.reject(
      new Error("Invalid development wrapper control port"),
    );
  }

  return new Promise<boolean>((resolve, reject) => {
    const socket = createConnection({ host: "127.0.0.1", port });
    socket.setEncoding("utf8");
    let buffer = "";
    let settled = false;
    let approvalStarted = false;
    const controller = new AbortController();
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      controller.abort();
      socket.destroy();
      fn();
    };
    const timeout = setTimeout(
      () => {
        finish(() =>
          reject(new Error(`Development wrapper ${request.op} timed out`)),
        );
      },
      approve ? SAFE_RELOAD_TIMEOUT_MS : REQUEST_TIMEOUT_MS,
    );

    socket.on("connect", () => {
      socket.write(`${JSON.stringify({ token, ...request })}\n`);
    });
    socket.on("data", (chunk) => {
      buffer += chunk;
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      try {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        const response = JSON.parse(line) as {
          ok?: boolean;
          error?: string;
          declined?: boolean;
        };
        if (response.ok === true) {
          if (!approve) {
            finish(() => resolve(true));
          } else if (approvalStarted && response.declined === true) {
            finish(() => resolve(false));
          } else if (!approvalStarted) {
            approvalStarted = true;
            void approve(controller.signal).then(
              (authorized) => {
                if (settled) return;
                if (!authorized) {
                  socket.write(
                    `${JSON.stringify({ token, op: "declineSafeReload" })}\n`,
                  );
                  return;
                }
                socket.end(
                  `${JSON.stringify({ token, op: "commitSafeReload" })}\n`,
                  () => finish(() => resolve(true)),
                );
              },
              (error) => finish(() => reject(error)),
            );
          }
          return;
        }
        finish(() =>
          reject(
            new Error(
              response.error ??
                `Development wrapper rejected ${request.op} request`,
            ),
          ),
        );
      } catch {
        finish(() =>
          reject(
            new Error(`Invalid development wrapper ${request.op} response`),
          ),
        );
      }
    });
    socket.on("error", (error) => finish(() => reject(error)));
    socket.on("close", () => {
      if (!settled) {
        finish(() =>
          reject(
            new Error(
              `Development wrapper closed during ${request.op} request`,
            ),
          ),
        );
      }
    });
  });
}

/**
 * Ask the stable development wrapper to replace this server generation.
 * Returns false outside the wrapper so production supervisors keep their
 * established process-exit restart contract.
 */
export function requestDevWrapperReload(): Promise<boolean> {
  return requestDevWrapper({ op: "reload" }, false);
}

/** The wrapper prepares its replacement before the backend fences and checks work. */
export function requestDevWrapperSafeReload(
  approve: (signal: AbortSignal) => Promise<boolean>,
): Promise<boolean> {
  const generation = process.env.YEP_SERVER_GENERATION?.trim();
  if (!generation) return Promise.resolve(false);
  return requestDevWrapper(
    { op: "safeReload", generation, pid: process.pid },
    false,
    approve,
  );
}

/** Register the actual Hono PID behind pnpm's launcher process. */
export function registerDevWrapperBackend(): Promise<boolean> {
  const generation = process.env.YEP_SERVER_GENERATION?.trim();
  if (!generation) return Promise.resolve(false);
  return requestDevWrapper(
    { op: "registerBackend", generation, pid: process.pid },
    false,
  );
}

/** Tell the wrapper that this generation proved ownership of its main bind. */
export function reportDevWrapperListening(args: {
  host: string;
  port: number;
}): Promise<boolean> {
  const generation = process.env.YEP_SERVER_GENERATION?.trim();
  if (!generation) return Promise.resolve(false);
  return requestDevWrapper(
    {
      op: "backendListening",
      generation,
      pid: process.pid,
      host: args.host,
      port: args.port,
    },
    false,
  );
}
