import { projectAccessLevel } from "@yep-anywhere/shared";
import type { ProjectMetadataService } from "../metadata/ProjectMetadataService.js";
import type { SelectedProjectPolicy } from "../projects/launch-project.js";
import type { LimitedUsersService } from "./LimitedUsersService.js";

/**
 * A limited user's ownership and grants name a project by its selected path,
 * so a project one of them owns or may reach keeps that path: a session
 * moved to the folder's real path would leave the project they were given.
 * Without the user list only ownership is known.
 */
export function limitedProjectPolicy(
  users: Pick<LimitedUsersService, "list"> | undefined,
  projects: Pick<ProjectMetadataService, "getProjectOwner"> | undefined,
): SelectedProjectPolicy {
  return {
    namesProject: (projectId, projectPath) =>
      Boolean(projects?.getProjectOwner(projectPath)) ||
      (users?.list() ?? []).some(
        (user) => projectAccessLevel(user, projectId) !== "none",
      ),
  };
}
