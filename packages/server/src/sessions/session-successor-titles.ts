import { truncateSessionTitle } from "@yep-anywhere/shared";

/**
 * The title rules of a session made from another one: whether a source title
 * is worth keeping, a fork's numbered prefix, and the title a generated summary
 * or retitle proposes.
 */

function compactRestartTitleText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function stripMarkdownHeading(text: string): string {
  return text.replace(/^#+\s*/, "");
}

function isGeneratedRestartHandoffTitle(text: string): boolean {
  const title = stripMarkdownHeading(compactRestartTitleText(text));
  return (
    /^Restart Handoff\b/i.test(title) ||
    /^Handoff:\s*Restart Handoff\b/i.test(title) ||
    /^Handoff:\s*Yep Anywhere is starting this as a fresh agent session\b/i.test(
      title,
    ) ||
    /^Yep Anywhere is starting this as a fresh agent session\b/i.test(title)
  );
}

export function normalizeRestartTitleCandidate(
  title: string | null | undefined,
): string | undefined {
  if (!title) {
    return undefined;
  }
  const candidate = stripMarkdownHeading(compactRestartTitleText(title));
  if (!candidate || isGeneratedRestartHandoffTitle(candidate)) {
    return undefined;
  }
  return candidate;
}

export function forkSummaryTitleCandidate(summary: string): string | undefined {
  const firstLine = summary
    .split("\n")
    .map((line) => line.trim())
    .find(Boolean);
  const candidate = firstLine
    ?.replace(/^#{1,6}\s*/u, "")
    .replace(/^title:\s*/iu, "")
    .trim()
    .replace(/[.!?]+$/u, "");
  return candidate || undefined;
}

/** An existing fork/clone prefix is replaced by the new one, never stacked. */
const FORK_TITLE_PREFIX_PATTERN = /^(?:fork|clone)(?:\s+\d+)?:\s*/iu;

/**
 * Title a fork so repeated forks of one session are told apart: the first is
 * `Fork: <source>`, the next `Fork 2: <source>`. `ordinal` is the source
 * session's fork count from `nextForkOrdinal`, which counts forks created, so
 * deleting a fork does not hand its number to a later one.
 */
export function forkTitleWithOrdinal(
  base: string,
  ordinal: number,
  prefix: "Fork" | "Clone" = "Fork",
): string {
  const core = base.replace(FORK_TITLE_PREFIX_PATTERN, "").trim() || base;
  return truncateSessionTitle(
    ordinal > 1 ? `${prefix} ${ordinal}: ${core}` : `${prefix}: ${core}`,
  );
}

export function generatedRetitleCandidate(title: string): string | undefined {
  const firstLine = title
    .split("\n")
    .map((line) => line.trim())
    .find(Boolean);
  if (!firstLine) {
    return undefined;
  }
  const candidate = normalizeRestartTitleCandidate(
    firstLine
      .replace(/^title:\s*/iu, "")
      .replace(/^["'“”‘’]+|["'“”‘’]+$/gu, "")
      .replace(/[.!?]+$/u, "")
      .trim(),
  );
  return candidate ? truncateSessionTitle(candidate) : undefined;
}
