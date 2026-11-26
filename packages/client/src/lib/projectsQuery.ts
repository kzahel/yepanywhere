import { SERVER_CAPABILITIES, serverHasCapability } from "@yep-anywhere/shared";
import type { ProjectsResponse } from "../api/projectsClient";
import type { ClientSummarySourceKey } from "./clientSummarySourceKey";
import {
  createClientQueryKey,
  type ClientQueryRequestContext,
} from "./clientQueryController";
import { readVersionInfo } from "./versionQuery";

export const PROJECTS_QUERY_KEY = createClientQueryKey({
  endpoint: "projects",
});

/** Acquire the project collection before the UI store's code has loaded. */
export function createProjectsQuery(
  sourceKey: ClientSummarySourceKey,
  fetchProjects: (summaryMode?: "retained") => Promise<ProjectsResponse>,
) {
  return {
    sourceKey,
    key: PROJECTS_QUERY_KEY,
    fetcher: async (context: ClientQueryRequestContext) => {
      const version = readVersionInfo(context.sourceKey);
      const summaryMode =
        version === null ||
        serverHasCapability(version, SERVER_CAPABILITIES.retainedProjects.name)
          ? "retained"
          : undefined;
      const [response, store] = await Promise.all([
        fetchProjects(summaryMode),
        import("./clientSummaryStore"),
      ]);
      return { response, report: store.reportProjectsCollectionSnapshot };
    },
    applySnapshot: (
      {
        response,
        report,
      }: {
        response: ProjectsResponse;
        report: typeof import("./clientSummaryStore").reportProjectsCollectionSnapshot;
      },
      context: ClientQueryRequestContext,
    ) => report(context.sourceKey, response, context.requestStartedAt),
  };
}
