import type { GitFileChange } from "@yep-anywhere/shared";
export type WorktreeState = "staged" | "unstaged" | "both" | "untracked";

export type WorktreeFileChange = GitFileChange & {
  worktreeState: WorktreeState;
};

/** Whether two merged rows describe the same working-tree state for a path. */
export function sameWorktreeRow(
  previous: WorktreeFileChange,
  next: WorktreeFileChange,
): boolean {
  return (
    previous.path === next.path &&
    previous.status === next.status &&
    previous.staged === next.staged &&
    previous.worktreeState === next.worktreeState &&
    previous.linesAdded === next.linesAdded &&
    previous.linesDeleted === next.linesDeleted &&
    previous.origPath === next.origPath &&
    previous.lastEditor?.sessionId === next.lastEditor?.sessionId &&
    previous.lastEditor?.observedAt === next.lastEditor?.observedAt
  );
}

/** Collapse index/worktree layers into one HEAD-to-filesystem row per path. */
export function mergeWorkingTreeFiles(
  files: GitFileChange[],
): WorktreeFileChange[] {
  const byPath = new Map<string, GitFileChange[]>();
  for (const file of files) {
    const entries = byPath.get(file.path);
    if (entries) entries.push(file);
    else byPath.set(file.path, [file]);
  }

  return Array.from(byPath.values(), (entries) => {
    const untracked = entries.find((file) => file.status === "?");
    const staged = entries.find((file) => file.staged);
    const unstaged = entries.find(
      (file) => !file.staged && file.status !== "?",
    );
    const rename = entries.find(
      (file) => file.status === "R" || file.status === "C",
    );
    const representative =
      untracked ?? rename ?? unstaged ?? staged ?? entries[0]!;
    const worktreeState: WorktreeState = untracked
      ? "untracked"
      : staged && unstaged
        ? "both"
        : staged
          ? "staged"
          : "unstaged";
    const singleLayer = entries.length === 1;
    const origPath = entries.find((file) => file.origPath)?.origPath;
    const lastEditor = entries.find((file) => file.lastEditor)?.lastEditor;
    return {
      path: representative.path,
      status: representative.status,
      staged: worktreeState === "staged",
      linesAdded: singleLayer ? representative.linesAdded : null,
      linesDeleted: singleLayer ? representative.linesDeleted : null,
      ...(origPath ? { origPath } : {}),
      ...(lastEditor ? { lastEditor } : {}),
      worktreeState,
    };
  });
}
