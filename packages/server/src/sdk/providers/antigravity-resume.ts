import { getLogger } from "../../logging/logger.js";
import { readAntigravityResumePoint } from "../../sessions/antigravity-log-window.js";
import { EMPTY_ANTIGRAVITY_LOG } from "./antigravity-live-projection.js";
import type {
  AntigravityHistoryGap,
  AntigravityLogBoundary,
} from "./antigravity-owners.js";
import type {
  AntigravityRuntime,
  AntigravitySessionSetup,
} from "./antigravity-runtime.js";

/**
 * Reopens a stopped conversation for a new owner with `session/resume`,
 * which replays no history (plan 195 step 5; qualified on `agy` 1.5.13 and
 * 1.5.14, including a conversation with no log and one whose log YA cannot
 * read, in step 8). The log's last record when it returns is the owner's
 * boundary: readers serve the log through it and the owner's live
 * projection after it.
 *
 * Without a readable log, `agy` still keeps the conversation's context in
 * its database, but YA cannot show the history before the resume point:
 * `earlier` says why. A conversation with no log that was never prompted
 * (`neverPrompted`) has no earlier history, so it starts at an empty log
 * as a new session does. An unknown log's boundary is its last complete
 * line when that line's head reads, so the owner's rows join after it.
 */
export async function resumeAntigravitySession(options: {
  runtime: AntigravityRuntime;
  scope: string;
  params: { sessionId: string; cwd: string; mcpServers: []; _meta?: unknown };
  /** Whether a conversation with no log was never prompted. */
  neverPrompted: () => Promise<boolean>;
  /** Checked right before the native call. */
  authorize: () => boolean;
}): Promise<{
  setup: AntigravitySessionSetup;
  boundary: AntigravityLogBoundary;
  earlier?: AntigravityHistoryGap;
} | null> {
  const { runtime, scope, params } = options;
  const point = await readAntigravityResumePoint(scope, params.sessionId);
  const earlier: AntigravityHistoryGap | undefined =
    point.status === "unknown"
      ? "unknown"
      : point.status === "missing" && !(await options.neverPrompted())
        ? "missing"
        : undefined;
  if (earlier)
    getLogger().info(
      {
        conversationId: params.sessionId,
        log: earlier,
        ...(point.status === "unknown" ? { reason: point.reason } : {}),
      },
      "Antigravity log not readable; resuming without showing earlier history",
    );
  if (!options.authorize()) return null;
  const setup = await runtime.call<AntigravitySessionSetup>(
    "session/resume",
    params,
  );
  if (point.status !== "known")
    return {
      setup: setup ?? {},
      boundary:
        point.status === "unknown" && point.boundary
          ? point.boundary
          : EMPTY_ANTIGRAVITY_LOG,
      ...(earlier ? { earlier } : {}),
    };
  // The fact at resume: `session/resume` was measured to leave the log
  // unchanged, so this is the same record unless something appended.
  const resumed = await readAntigravityResumePoint(scope, params.sessionId);
  return {
    setup: setup ?? {},
    boundary: resumed.status === "known" ? resumed.boundary : point.boundary,
  };
}
