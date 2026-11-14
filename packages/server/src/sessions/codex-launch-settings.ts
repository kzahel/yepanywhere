/**
 * Codex launch-settings recovery (topics/codex-sessions.md): a session with
 * no durable launch settings inherits the model, effort and permission mode
 * of its latest `turn_context`. Codex records one per turn, so the answer is
 * a bounded latest-state point read from the end of the rollout
 * (topics/provider-history-facts.md).
 */
import {
  type CodexTurnContextEntry,
  type EffortLevel,
  type PermissionMode,
  type ThinkingConfig,
  parseCodexSessionEntry,
} from "@yep-anywhere/shared";
import { isCompressedCodexRolloutPath } from "../utils/codexRolloutFiles.js";
import { readCodexSessionMeta } from "./codex-rollout-lineage.js";
import {
  createTailPointQuery,
  readLinesBackward,
  TRANSCRIPT_TAIL_POINT_BYTE_BUDGET,
} from "./transcript-tail.js";
import type { RecoveredSessionLaunchSettings } from "./types.js";

const RECOVERABLE_CODEX_EFFORTS = new Set<EffortLevel>([
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]);

function isRecoverableCodexEffort(value: string): value is EffortLevel {
  return RECOVERABLE_CODEX_EFFORTS.has(value as EffortLevel);
}

function recoverCodexPermissionMode(
  turnContext: CodexTurnContextEntry,
): PermissionMode {
  const approvalPolicy = turnContext.payload.approval_policy;
  const sandboxType = turnContext.payload.sandbox_policy?.type;
  if (approvalPolicy === "never" && sandboxType === "danger-full-access") {
    return "bypassPermissions";
  }
  if (approvalPolicy === "on-request" && sandboxType === "read-only") {
    return "plan";
  }
  return "default";
}

export function recoverCodexLaunchSettings(
  turnContext: CodexTurnContextEntry | undefined,
): RecoveredSessionLaunchSettings | null {
  if (!turnContext) return null;

  const model = turnContext.payload.model?.trim();
  const effort = turnContext.payload.effort;
  let thinking: ThinkingConfig | undefined;
  let recoveredEffort: EffortLevel | undefined;
  if (effort === "none") {
    thinking = { type: "disabled" };
  } else if (effort && isRecoverableCodexEffort(effort)) {
    thinking = { type: "adaptive", display: "summarized" };
    recoveredEffort = effort;
  }

  return {
    permissionMode: recoverCodexPermissionMode(turnContext),
    ...(model ? { requestedModel: model } : {}),
    ...(thinking ? { thinking } : {}),
    ...(recoveredEffort ? { effort: recoveredEffort } : {}),
  };
}

/** `known: false` is unknown; `settings: null` is a known absence. */
type LatestTurnSettings =
  | { known: false }
  | {
      known: true;
      metaId?: string;
      settings: RecoveredSessionLaunchSettings | null;
    };

const latestTurnSettings = createTailPointQuery<LatestTurnSettings>({
  name: "codex-latest-turn-context",
  maxRetainedBytes: 1024 * 1024,
  estimateBytes: () => 512,
  compute: async (filePath, size) => {
    // A failed header read rejects rather than answering, so a transient
    // failure is not retained for this file version.
    const meta = await readCodexSessionMeta(filePath);
    // A fork continues its parent's history, which may hold the latest
    // turn context; this file alone cannot say.
    if (meta.payload.history_base) return { known: false };
    const metaId = meta.payload.id;
    for await (const batch of readLinesBackward(filePath, {
      endByte: size,
      maxBytes: TRANSCRIPT_TAIL_POINT_BYTE_BUDGET,
    })) {
      for (let i = batch.lines.length - 1; i >= 0; i--) {
        const entry = parseCodexSessionEntry(batch.lines[i]!.trim());
        if (entry?.type === "turn_context")
          return {
            known: true,
            metaId,
            settings: recoverCodexLaunchSettings(entry),
          };
      }
      if (batch.reachedStart) return { known: true, metaId, settings: null };
    }
    return { known: false };
  },
});

/**
 * Settings from the rollout's latest turn context, or undefined when the
 * bounded read cannot tell: a compressed or forked rollout, a turn context
 * beyond the byte budget, or a file that changed during the read.
 */
export async function readCodexLatestLaunchSettings(
  filePath: string,
  sessionId: string,
): Promise<RecoveredSessionLaunchSettings | null | undefined> {
  if (isCompressedCodexRolloutPath(filePath)) return undefined;
  let answer: LatestTurnSettings | undefined;
  try {
    answer = await latestTurnSettings(filePath);
  } catch {
    // The named complete read decides, including for a missing header.
    return undefined;
  }
  if (!answer?.known) return undefined;
  // The complete read refuses a rollout whose header names another thread,
  // or none.
  if (answer.metaId !== sessionId) return null;
  return answer.settings;
}
