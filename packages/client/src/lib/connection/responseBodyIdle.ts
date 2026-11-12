import { RELAY_RESPONSE_STREAM_IDLE_TIMEOUT_MS } from "@yep-anywhere/shared";

// Weak ownership: no controller survives its response body through this set.
const liveBodies = new WeakSet<ReadableStreamDefaultController<Uint8Array>>();

export function markLiveResponseBody(
  path: string,
  controller: ReadableStreamDefaultController<Uint8Array>,
): void {
  try {
    if (decodeURI(path.split("?", 1)[0]!) === "/api/activity/collections")
      liveBodies.add(controller);
  } catch {
    // A malformed path retains the finite-response policy.
  }
}

export function armResponseBodyIdle(
  stream: {
    controller: ReadableStreamDefaultController<Uint8Array>;
    idleTimer: ReturnType<typeof setTimeout> | null;
  },
  retire: () => void,
): void {
  if (stream.idleTimer) clearTimeout(stream.idleTimer);
  if (liveBodies.has(stream.controller)) return;
  stream.idleTimer = setTimeout(() => {
    retire();
    stream.controller.error(new Error("Request timeout"));
  }, RELAY_RESPONSE_STREAM_IDLE_TIMEOUT_MS);
}
