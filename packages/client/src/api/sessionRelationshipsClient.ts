import type { SessionRelationshipPage } from "@yep-anywhere/shared";
import type { fetchJSON } from "./sourceApiFetch";

export function createSessionRelationshipsApi(fetcher: typeof fetchJSON) {
  return {
    read(
      projectId: string,
      sessionId: string,
      cursor?: string,
      signal?: AbortSignal,
    ) {
      const query = new URLSearchParams({ limit: "50" });
      if (cursor) query.set("cursor", cursor);
      return fetcher<SessionRelationshipPage>(
        `/projects/${encodeURIComponent(projectId)}/sessions/${encodeURIComponent(sessionId)}/relationships?${query}`,
        { signal },
      );
    },
  };
}
