import {
  type AntigravityReplayTail,
  readAntigravityReplayTail,
} from "../../sessions/antigravity-subagent-links.js";
import type {
  AntigravityRuntime,
  AntigravitySessionSetup,
  AntigravityUpdate,
} from "./antigravity-runtime.js";
import type { AntigravityTranscript } from "./antigravity-transcript.js";

const REPLAY_TAIL_TIMEOUT_MS = 10_000;

function hasReplayTail(
  transcript: AntigravityTranscript,
  tail: Extract<AntigravityReplayTail, { status: "known" }>,
): boolean {
  for (let i = transcript.messages.length - 1; i >= 0; i--) {
    const message = transcript.messages[i];
    const content = message?.message?.content;
    if (message?.type === tail.kind && typeof content === "string")
      return content.trimEnd().endsWith(tail.text);
  }
  return false;
}

/**
 * ACP requires the load response to follow all history. agy 1.5 can answer
 * before the saved tail arrives. Require both the response and the persisted
 * content when available, with a deadline for an incomplete replay.
 */
export async function loadAntigravityReplay(options: {
  runtime: AntigravityRuntime;
  scope: string;
  params: { sessionId: string; cwd: string; mcpServers: []; _meta?: unknown };
  transcript: AntigravityTranscript;
  authorize?: () => boolean;
  onUpdate?: (update: AntigravityUpdate) => void;
}): Promise<{ setup: AntigravitySessionSetup; complete: boolean } | null> {
  const { runtime, scope, params, transcript } = options;
  const tail = await readAntigravityReplayTail(scope, params.sessionId);
  if (options.authorize && !options.authorize()) return null;

  let completeTail: (() => void) | undefined;
  runtime.onUpdate = (update, id) => {
    if (id !== params.sessionId) return;
    options.onUpdate?.(update);
    transcript.accept(update);
    if (
      completeTail &&
      tail.status === "known" &&
      hasReplayTail(transcript, tail)
    )
      completeTail();
  };
  const setup = await runtime.call<AntigravitySessionSetup>(
    "session/load",
    params,
  );
  const result = { setup, complete: tail.status !== "unavailable" };
  if (tail.status !== "known" || hasReplayTail(transcript, tail)) return result;

  let deadline: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      new Promise<void>((resolve, reject) => {
        completeTail = resolve;
        deadline = setTimeout(
          () =>
            reject(new Error("Antigravity saved replay tail did not arrive")),
          REPLAY_TAIL_TIMEOUT_MS,
        );
      }),
      runtime.closed.then(() => {
        throw new Error(
          "Antigravity closed before its saved replay tail arrived",
        );
      }),
    ]);
    return result;
  } finally {
    clearTimeout(deadline);
    completeTail = undefined;
  }
}
