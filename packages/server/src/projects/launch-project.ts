import { realpath } from "node:fs/promises";
import type { UrlProjectId } from "@yep-anywhere/shared";
import {
  encodeProjectId,
  getProjectIdentityKey,
  isProjectFolder,
} from "./paths.js";

/** Projects that must stay the selected path rather than the folder it names. */
export interface SelectedProjectPolicy {
  namesProject(projectId: UrlProjectId, projectPath: string): boolean;
}

/**
 * The folder a selected path names now, or the path itself when that cannot
 * be established.
 *
 * A symbolic link is a way to reach a folder, not a project: a process
 * started through one runs in the folder it names, Claude records that
 * folder, and a link retargeted later would otherwise send the same
 * conversation to different files. Resolving once, when new work starts,
 * keeps the project, the provider's record and every later resume on one
 * folder.
 *
 * Windows is left alone: its processes keep the path they were given, and
 * resolving there rewrites mapped and `subst` drives to network paths.
 */
export async function physicalProjectPath(selected: string): Promise<string> {
  if (process.platform === "win32") return selected;
  try {
    return await realpath(selected);
  } catch {
    // A missing or unreadable folder is refused by the launch, not here.
    return selected;
  }
}

/**
 * The project and working folder of a new session.
 *
 * A launch that names another project for its working folder is an overlay
 * the caller chose, and a project a limited user's access names must stay
 * that project; both keep what was selected.
 */
export async function launchProject(
  selected: string,
  options?: { projectId?: UrlProjectId },
  policy?: SelectedProjectPolicy,
): Promise<{ projectPath: string; projectId: UrlProjectId }> {
  const selectedId = encodeProjectId(selected);
  const projectId = options?.projectId ?? selectedId;
  const kept = { projectPath: selected, projectId };
  if (projectId !== selectedId || policy?.namesProject(projectId, selected))
    return kept;
  const projectPath = await physicalProjectPath(selected);
  return getProjectIdentityKey(projectPath) === getProjectIdentityKey(selected)
    ? kept
    : { projectPath, projectId: encodeProjectId(projectPath) };
}

/**
 * The refusal for continuing work whose folder is gone. A session never
 * moves to another folder by itself, and its saved history stays readable.
 */
export async function missingProjectFolder(
  projectPath: string,
): Promise<{ error: string; reason: "project-folder-missing" } | undefined> {
  if (await isProjectFolder(projectPath)) return undefined;
  return {
    error: `This session's folder no longer exists: ${projectPath}. Its history is still available. Restore the folder to continue here.`,
    reason: "project-folder-missing",
  };
}
