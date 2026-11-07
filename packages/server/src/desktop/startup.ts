import { createInterface } from "node:readline";
import {
  DESKTOP_BOOTSTRAP_PROTOCOL_VERSION,
  DesktopBootstrapService,
} from "./DesktopBootstrapService.js";

const STARTUP_TIMEOUT_MS = 15_000;
const STARTUP_MODE = "stdin-v1";

interface DesktopStartupFrame {
  protocol: number;
  nativeUpdates?: boolean;
  masterSecret: string;
}

function parseStartupFrame(line: string): DesktopStartupFrame {
  const value = JSON.parse(line) as Partial<DesktopStartupFrame>;
  if (
    value.protocol !== DESKTOP_BOOTSTRAP_PROTOCOL_VERSION ||
    typeof value.masterSecret !== "string" ||
    value.masterSecret.length < 32
  ) {
    throw new Error("Invalid desktop bootstrap startup frame");
  }
  return {
    protocol: value.protocol,
    masterSecret: value.masterSecret,
    nativeUpdates: value.nativeUpdates === true,
  };
}

async function readStartupLine(): Promise<string> {
  return new Promise((resolve, reject) => {
    const input = createInterface({
      input: process.stdin,
      crlfDelay: Number.POSITIVE_INFINITY,
      terminal: false,
    });
    const timer = setTimeout(() => {
      input.close();
      reject(
        new Error("Timed out waiting for desktop bootstrap startup frame"),
      );
    }, STARTUP_TIMEOUT_MS);
    timer.unref?.();

    input.once("line", (line) => {
      clearTimeout(timer);
      input.close();
      resolve(line);
    });
    input.once("close", () => {
      clearTimeout(timer);
    });
    input.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

export async function readDesktopBootstrapServiceFromStdin(): Promise<
  DesktopBootstrapService | undefined
> {
  if (process.env.YEP_DESKTOP_BOOTSTRAP !== STARTUP_MODE) {
    return undefined;
  }

  const frame = parseStartupFrame(await readStartupLine());
  return new DesktopBootstrapService({
    masterSecret: frame.masterSecret,
    ...(frame.nativeUpdates
      ? {
          onCheckUpdates: () => {
            process.stdout.write(
              'YEP_DESKTOP_ACTION {"action":"check-updates"}\n',
            );
          },
        }
      : {}),
  });
}
