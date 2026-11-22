import { stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  readLinesBackward,
  TRANSCRIPT_TAIL_POINT_BYTE_BUDGET,
} from "../../sessions/transcript-tail.js";
import type { ProviderCommandResult } from "../types.js";
import type { AntigravityRuntime } from "./antigravity-runtime.js";

async function readPosition(path: string, after?: number) {
  const end = await stat(path).then(
    (info) => info.size,
    (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return 0;
      throw error;
    },
  );
  if (!end) return { index: -1, checkpoint: false };
  let latest: number | undefined;
  for await (const batch of readLinesBackward(path, {
    endByte: end,
    maxBytes: TRANSCRIPT_TAIL_POINT_BYTE_BUDGET,
  })) {
    for (const line of batch.lines.reverse()) {
      let step: unknown;
      try {
        step = JSON.parse(line);
      } catch {
        continue;
      }
      if (!step || typeof step !== "object" || !("step_index" in step))
        continue;
      const index = step.step_index;
      if (typeof index !== "number" || !Number.isSafeInteger(index)) continue;
      latest ??= index;
      if (after === undefined || index <= after)
        return { index: latest, checkpoint: false };
      if (
        "type" in step &&
        step.type === "CHECKPOINT" &&
        "status" in step &&
        step.status === "DONE" &&
        "source" in step &&
        step.source === "SYSTEM"
      )
        return { index: latest, checkpoint: true };
    }
    if (batch.reachedStart && latest !== undefined)
      return { index: latest, checkpoint: false };
  }
}

/** A native prompt can end normally even when it did not compact. */
export async function compactAntigravity(
  runtime: AntigravityRuntime,
  scope: string,
  id: string,
  argument: string,
): Promise<ProviderCommandResult> {
  if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(id))
    return {
      handled: true,
      error: "Antigravity has no valid native session ID",
    };
  const path = join(
    dirname(scope),
    "brain",
    id,
    ".system_generated",
    "logs",
    "transcript.jsonl",
  );
  const before = await readPosition(path).catch(() => undefined);
  if (!before)
    return {
      handled: true,
      error: "Cannot confirm the native compaction starting point",
    };
  const text = argument ? `/compact ${argument}` : "/compact";
  try {
    const result = await runtime.call<{ stopReason?: string }>(
      "session/prompt",
      { sessionId: id, prompt: [{ type: "text", text }] },
      0,
    );
    if (result?.stopReason !== "end_turn")
      return { handled: true, error: "Antigravity did not finish compaction" };
    const after = await readPosition(path, before.index);
    if (after?.checkpoint) return { handled: true, completion: "completed" };
    if (after)
      return {
        handled: true,
        error: "Antigravity did not record a new compaction checkpoint",
      };
  } catch {
    // An interrupted transport can lose the reply after native compaction.
  }
  return {
    handled: true,
    uncertain: true,
    error: "Antigravity compaction outcome is unconfirmed",
  };
}
