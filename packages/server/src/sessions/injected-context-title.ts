import { truncateSessionTitle, type ProviderName } from "@yep-anywhere/shared";
import { stripAgentApiBootstrapPrefix } from "@yep-anywhere/shared/agent-api-bootstrap";
import { stripMachineControlPrompt } from "@yep-anywhere/shared/machine-control-instructions";

/** Repair older derived indexes without rewriting native history or flushing caches. */
export function contextSummaryTitle(summary: {
  provider: ProviderName;
  title: string | null;
  fullTitle: string | null;
}): { title: string | null; fullTitle: string | null } {
  const original = { title: summary.title, fullTitle: summary.fullTitle };
  if (
    (summary.provider !== "codex" && summary.provider !== "codex-oss") ||
    !summary.fullTitle
  )
    return original;
  const fullTitle = stripMachineControlPrompt(
    stripAgentApiBootstrapPrefix(summary.fullTitle),
  );
  return fullTitle === summary.fullTitle
    ? original
    : { title: truncateSessionTitle(fullTitle) || null, fullTitle };
}
