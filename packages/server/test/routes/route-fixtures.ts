import { basename } from "node:path";
import { ProjectScanner } from "../../src/projects/scanner.js";
import type { ISessionReader } from "../../src/sessions/types.js";
import { encodeProjectId, type Project } from "../../src/supervisor/types.js";

export function projectForPath(path: string): Project {
  return {
    id: encodeProjectId(path),
    path,
    name: basename(path),
    sessionCount: 0,
    sessionDir: path,
    activeOwnedCount: 0,
    activeExternalCount: 0,
    lastActivity: null,
    provider: "claude",
  };
}

export type ProjectLookups = Partial<
  Pick<ProjectScanner, "getProject" | "getOrCreateProject">
>;

export function stubProjectLookups(lookups?: ProjectLookups): ProjectScanner {
  return Object.assign(
    new ProjectScanner({ enableCodex: false, enableGemini: false }),
    {
      getProject: async () => null,
      getOrCreateProject: async () => null,
      ...lookups,
    } satisfies ProjectLookups,
  );
}

export function stubSessionReader(
  overrides?: Partial<ISessionReader>,
): ISessionReader {
  return {
    listSessions: async () => [],
    getSessionSummary: async () => null,
    getSession: async () => null,
    getSessionSummaryIfChanged: async () => null,
    getAgentMappings: async () => [],
    getAgentSession: async () => null,
    ...overrides,
  };
}
