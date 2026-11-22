import { getLogger } from "../../logging/logger.js";
import { readAntigravityResumePoint } from "../../sessions/antigravity-log-window.js";
import type { SDKMessage } from "../types.js";
import type { AntigravityLogBoundary } from "./antigravity-owners.js";
import { loadAntigravityReplay } from "./antigravity-replay.js";
import type {
  AntigravityRuntime,
  AntigravitySessionSetup,
  AntigravityUpdate,
} from "./antigravity-runtime.js";
import { AntigravityTranscript } from "./antigravity-transcript.js";

/**
 * Reopens a stopped conversation for a new owner (plan 195 step 5).
 *
 * With a known log, `session/resume` reopens it without replaying history
 * (qualified on `agy` 1.5.13 and 1.5.14), and the log's last record when it
 * returns is the owner's boundary: readers serve the log through it and the
 * owner's live projection after it. A missing or unknown log has no
 * boundary, so the named fallback runs: `session/load`, whose replay
 * (checked against the saved tail) becomes the owner's retained history,
 * as before this step, so the history a viewer could see is not lost.
 */
export async function resumeAntigravitySession(options: {
  runtime: AntigravityRuntime;
  scope: string;
  params: { sessionId: string; cwd: string; mcpServers: []; _meta?: unknown };
  onUpdate: (update: AntigravityUpdate) => void;
  /** Checked right before the native call. */
  authorize: () => boolean;
}): Promise<{
  setup: AntigravitySessionSetup;
  boundary?: AntigravityLogBoundary;
  replay?: SDKMessage[];
} | null> {
  const { runtime, scope, params } = options;
  const point = await readAntigravityResumePoint(scope, params.sessionId);
  if (point.status !== "known") {
    getLogger().info(
      {
        conversationId: params.sessionId,
        log: point.status,
        ...(point.status === "unknown" ? { reason: point.reason } : {}),
      },
      "Antigravity log not readable; resume falls back to ACP replay",
    );
    const transcript = new AntigravityTranscript(params.sessionId);
    const loaded = await loadAntigravityReplay({
      runtime,
      scope,
      params,
      transcript,
      onUpdate: options.onUpdate,
      authorize: options.authorize,
    });
    return loaded ? { setup: loaded.setup, replay: transcript.messages } : null;
  }
  if (!options.authorize()) return null;
  const setup = await runtime.call<AntigravitySessionSetup>(
    "session/resume",
    params,
  );
  // The fact at resume: `session/resume` was measured to leave the log
  // unchanged, so this is the same record unless something appended.
  const resumed = await readAntigravityResumePoint(scope, params.sessionId);
  return {
    setup: setup ?? {},
    boundary: resumed.status === "known" ? resumed.boundary : point.boundary,
  };
}
