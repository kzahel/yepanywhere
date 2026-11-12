import { CAPABILITY_ID_ALLOCATIONS } from "./capability-ids.js";
import type { ServerCapabilityDefinition } from "./server-capability-definition.js";

export const COLLECTION_SERVER_CAPABILITIES = {
  collectionMetadataFields: {
    id: CAPABILITY_ID_ALLOCATIONS.collectionMetadataFields.id,
    name: "collection-metadata-fields",
    kind: "transitional",
    area: "sessions",
    introducedIn: "0.12.0",
    advertisement: {
      kind: "optional-bit",
      index: CAPABILITY_ID_ALLOCATIONS.collectionMetadataFields.id,
    },
    description:
      "Collection streams can replace/remove individual metadata fields while retaining unchanged options.",
    clientFallback:
      "Omit metadata=fields and retain complete metadata replacements on collection updates.",
    serverContract: {
      routes: ["GET /api/activity/collections"],
      requestFields: ["metadata"],
      responseFields: ["metaFields", "meta"],
    },
    lifecycle: { kind: "transitional" },
  },
  projectCollectionUpdates: {
    id: CAPABILITY_ID_ALLOCATIONS.projectCollectionUpdates.id,
    name: "project-collection-updates",
    kind: "transitional",
    area: "sessions",
    introducedIn: "0.12.0",
    advertisement: { kind: "version-implied" },
    description:
      "Authoritative bounded project and global ProjectQueue query changes over the shared collection stream.",
    clientFallback:
      "Keep existing project/queue REST revalidation and queue deadline backstop; send no project collection stream queries.",
    serverContract: {
      routes: ["GET /api/activity/collections"],
      requestFields: [
        "queries: /projects?summaryMode=retained, /project-queue",
      ],
      responseFields: [
        "groups.projects",
        "groups.items",
        "groups.recoveredSessionQueues",
        "groups.projectStatuses",
      ],
    },
    lifecycle: { kind: "transitional" },
  },
  collectionQueryUpdates: {
    id: CAPABILITY_ID_ALLOCATIONS.collectionQueryUpdates.id,
    name: "collection-query-updates",
    kind: "transitional",
    area: "sessions",
    introducedIn: "0.12.0",
    advertisement: { kind: "version-implied" },
    description:
      "Authoritative bounded session and Inbox query snapshots followed by row and membership changes.",
    clientFallback:
      "Keep existing retained REST reads and event-driven revalidation; send no collection stream request.",
    serverContract: {
      routes: ["GET /api/activity/collections"],
      requestFields: ["queries"],
      responseFields: [
        "query",
        "revision",
        "base",
        "upserts",
        "removed",
        "groups",
        "meta",
      ],
    },
    lifecycle: { kind: "transitional" },
  },
} as const satisfies Record<string, ServerCapabilityDefinition>;
