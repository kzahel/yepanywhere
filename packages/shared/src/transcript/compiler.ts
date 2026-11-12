import {
  createTranscriptProjectionMemo,
  type TranscriptProjectionMemo,
} from "./projectionMemo.js";
import type { Message } from "./message.js";
import type { RenderItem } from "./items.js";
import { coalesceCompactBoundaryItems } from "./compactBoundaries.js";
import {
  type MessageProjectionDiagnostics,
  projectTranscriptMessages,
} from "./messageProjection.js";
import { collapseSessionSetupRuns } from "./sessionSetup.js";
import { coalesceSlashCommandSkillBodies } from "./slashCommandBodies.js";
import {
  annotateBackgroundCommands,
  coalesceDetachedPollContinuations,
  enrichWriteStdinWithCommand,
  hideContextFreeEmptyShellPolls,
} from "./shellFolding.js";
import type { TranscriptProjectionAugments } from "./types.js";
import { annotateWorkflowTags } from "./workflowTags.js";

/** Compile a full window without retaining intrinsic facts between calls. */
export function compileTranscriptProjection(
  messages: Message[],
  augments?: TranscriptProjectionAugments,
  diagnostics?: MessageProjectionDiagnostics,
): RenderItem[] {
  return compileWithMemo(
    messages,
    augments,
    diagnostics,
    createTranscriptProjectionMemo(),
  );
}

function compileWithMemo(
  messages: Message[],
  augments: TranscriptProjectionAugments | undefined,
  diagnostics: MessageProjectionDiagnostics | undefined,
  memo: TranscriptProjectionMemo,
): RenderItem[] {
  const projected = projectTranscriptMessages(
    messages,
    augments,
    diagnostics,
    memo,
  );
  const items = augments?.workflowTags
    ? annotateWorkflowTags(messages, projected, augments.workflowSchemaFiles)
    : projected;
  const compactCoalescedItems = coalesceCompactBoundaryItems(items);
  const slashCommandCoalescedItems = coalesceSlashCommandSkillBodies(
    compactCoalescedItems,
  );
  const enrichedItems = enrichWriteStdinWithCommand(
    slashCommandCoalescedItems,
    memo,
  );
  const pollCoalescedItems = coalesceDetachedPollContinuations(
    enrichedItems,
    memo,
  );
  const backgroundAnnotatedItems = annotateBackgroundCommands(
    pollCoalescedItems,
    memo,
  );
  const shellPollFilteredItems = hideContextFreeEmptyShellPolls(
    backgroundAnnotatedItems,
  );
  return collapseSessionSetupRuns(shellPollFilteredItems);
}

/**
 * Own one instance across a consumer's snapshots (the web adapter shares one).
 * Messages, nested blocks and returned result payloads must stay immutable.
 * Weak input keys reuse intrinsic decoding without holding windows or history;
 * pairing, status, ordering and all other window rules run again on every call.
 */
export function createTranscriptProjectionCompiler(): typeof compileTranscriptProjection {
  const memo = createTranscriptProjectionMemo();
  return (messages, augments, diagnostics) =>
    compileWithMemo(messages, augments, diagnostics, memo);
}
