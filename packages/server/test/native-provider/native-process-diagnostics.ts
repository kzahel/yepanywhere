import type { ChildProcess } from "node:child_process";
import { vi } from "vitest";
import { AntigravityRuntime } from "../../src/sdk/providers/antigravity-runtime.js";

const originalConnect = AntigravityRuntime.prototype.connect;

export interface NativeProcessDiagnostic {
  exitCode?: number | null;
  signal?: NodeJS.Signals | null;
  stderr?: string;
  truncated?: boolean;
  unavailable?: boolean;
}

/** Only owned synthetic profiles use this observer; production stderr stays drained. */
export function observeOwnedAntigravity(
  diagnostics: NativeProcessDiagnostic[],
) {
  let observed = 0;
  return vi
    .spyOn(AntigravityRuntime.prototype, "connect")
    .mockImplementation(function (
      this: AntigravityRuntime,
      ...args: Parameters<typeof originalConnect>
    ) {
      const pending = originalConnect.apply(this, args);
      if (++observed > 16) return pending;
      // Observe the actual child started synchronously by connect, without
      // changing its command, environment, protocol or process ownership.
      const child = (this as unknown as { child?: ChildProcess }).child;
      if (!child?.stderr) {
        diagnostics.push({ unavailable: true });
        return pending;
      }
      let tail = "",
        truncated = false;
      const capture = (chunk: Buffer | string) => {
        tail += String(chunk);
        if (tail.length > 16_384) {
          truncated = true;
          tail = tail.slice(-16_384);
        }
      };
      child.stderr.on("data", capture);
      child.once("close", (exitCode, signal) => {
        child.stderr?.off("data", capture);
        diagnostics.push({
          exitCode,
          signal,
          stderr: safeOwnedStderr(tail, truncated),
          truncated,
        });
      });
      return pending;
    });
}

/** Drop whole private/URL lines before truncating, including split URL tails. */
export function safeOwnedStderr(text: string, truncated = false): string {
  const lines = text.replace(/\\+\//g, "/").split(/\r?\n/);
  if (truncated) lines.shift();
  return lines
    .map((line) => {
      const library = line.match(
        /error while loading shared libraries: ([a-z0-9_.+-]+)/i,
      )?.[1];
      if (library) return `Missing native library: ${library}`;
      if (
        /[a-z][a-z0-9+.-]*:\/\/|oauth|authorization|bearer|token|secret|password|credential|cookie|api[_ -]?key|\b(?:key|code|state)["']?\s*[=:]\s*["']?[a-z0-9._~+/-]{20,}|^\s*[?&][a-z_]+=/i.test(
          line,
        )
      )
        return "[private native diagnostic omitted]";
      return line;
    })
    .join("\n")
    .slice(-4000);
}
