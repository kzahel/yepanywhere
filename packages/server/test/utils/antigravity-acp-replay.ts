import type {
  AntigravityRuntime,
  AntigravityUpdate,
} from "../../src/sdk/providers/antigravity-runtime.js";
import { AntigravityTranscript } from "../../src/sdk/providers/antigravity-transcript.js";
import type { SDKMessage } from "../../src/sdk/types.js";

/**
 * The test oracle for the brain-log projection: ACP `session/load` replay of
 * a stopped conversation, as the messages YA's ACP normalization makes of
 * its frames (one message per text or thinking block, one per tool call).
 * YA itself no longer loads (plan 195 step 8); the native projection case
 * and the census compare the log with what `agy` replays. Frames arriving
 * within `settleMs` after the load response count too.
 */
export async function replayAntigravityConversation(options: {
  runtime: AntigravityRuntime;
  sessionId: string;
  cwd: string;
  onUpdate?: (update: AntigravityUpdate) => void;
  settleMs?: number;
}): Promise<SDKMessage[]> {
  const { runtime, sessionId } = options;
  const transcript = new AntigravityTranscript(sessionId);
  const messages = new Map<string, SDKMessage>();
  const keep = (message: SDKMessage) => {
    const { _isStreaming: _, timestamp: __, ...rest } = message;
    messages.set(String(message.uuid), rest);
  };
  runtime.onUpdate = (update, id) => {
    if (id !== sessionId) return;
    options.onUpdate?.(update);
    for (const message of transcript.accept(update)) keep(message);
  };
  await runtime.call("session/load", {
    sessionId,
    cwd: options.cwd,
    mcpServers: [],
  });
  await new Promise((resolve) => setTimeout(resolve, options.settleMs ?? 500));
  const open = transcript.close();
  if (open) keep(open);
  return [...messages.values()];
}
