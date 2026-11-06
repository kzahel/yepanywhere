import { CAPABILITY_ID_ALLOCATIONS } from "./capability-ids.js";
import type { ServerCapabilityDefinition } from "./server-capability-definition.js";

export const RENDERING_SERVER_CAPABILITIES = {
  unicodeProseMath: {
    id: CAPABILITY_ID_ALLOCATIONS.unicodeProseMath.id,
    name: "unicode-prose-math",
    kind: "permanent",
    area: "rendering",
    introducedIn: "0.9.4",
    advertisement: { kind: "version-implied" },
    description:
      "Rendered Markdown marks undelimited math in prose with a hidden KaTeX alternative that the client can reveal.",
    clientFallback:
      "Hide the Unicode math Appearance setting; prose math stays as written.",
    lifecycle: {
      kind: "permanent",
      reason:
        "Servers through 0.9.2 emit no math markers, so the setting would have no effect there.",
    },
  },
  glossaryTooltips: {
    id: CAPABILITY_ID_ALLOCATIONS.glossaryTooltips.id,
    name: "glossary-tooltips",
    kind: "permanent",
    area: "rendering",
    introducedIn: "0.7.1",
    advertisement: { kind: "version-implied" },
    description:
      "Server resolves governing project glossaries, returns compiled phrase automata, and streams project glossary-path changes.",
    clientFallback:
      "Current clients assume this v0.8.0 baseline contract; older servers should update or use their bundled client. User preferences and runtime availability still apply.",
    serverContract: {
      routes: ["GET /api/projects/:projectId/glossary-artifact"],
      routeModules: ["packages/server/src/routes/glossary-artifacts.ts"],
      requestFields: ["glossaryArtifact.sourcePath"],
      responseFields: [
        "glossaryArtifact.status",
        "glossaryArtifact.governingPath",
        "glossaryArtifact.sourceVersion",
        "glossaryArtifact.dependencies",
        "glossaryArtifact.artifact",
        "glossaryArtifact.diagnostics",
      ],
      events: ["glossary-paths-snapshot", "glossary-path-changed"],
    },
    lifecycle: {
      kind: "permanent",
      reason:
        "Hosted clients may outpace installed servers, and glossary discovery must remain server-owned.",
    },
  },
} as const satisfies Record<string, ServerCapabilityDefinition>;
