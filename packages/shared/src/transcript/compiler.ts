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

/**
 * Compile normalized transcript messages into the current semantic render
 * model without identity caching or web reference stabilization.
 */
export function compileTranscriptProjection(
  messages: Message[],
  augments?: TranscriptProjectionAugments,
  diagnostics?: MessageProjectionDiagnostics,
): RenderItem[] {
  const projected = projectTranscriptMessages(messages, augments, diagnostics);
  const items = augments?.workflowTags
    ? annotateWorkflowTags(messages, projected, augments.workflowSchemaFiles)
    : projected;
  const compactCoalescedItems = coalesceCompactBoundaryItems(items);
  const slashCommandCoalescedItems = coalesceSlashCommandSkillBodies(
    compactCoalescedItems,
  );
  const enrichedItems = enrichWriteStdinWithCommand(slashCommandCoalescedItems);
  const pollCoalescedItems = coalesceDetachedPollContinuations(enrichedItems);
  const backgroundAnnotatedItems =
    annotateBackgroundCommands(pollCoalescedItems);
  const shellPollFilteredItems = hideContextFreeEmptyShellPolls(
    backgroundAnnotatedItems,
  );
  return collapseSessionSetupRuns(shellPollFilteredItems);
}
