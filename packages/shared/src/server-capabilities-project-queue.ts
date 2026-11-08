import { CAPABILITY_ID_ALLOCATIONS } from "./capability-ids.js";
import type { ServerCapabilityDefinition } from "./server-capability-definition.js";

export const PROJECT_QUEUE_SERVER_CAPABILITIES = {
  projectQueue: {
    name: "projectQueue",
    kind: "permanent",
    area: "projectQueue",
    introducedIn: "0.5.0",
    advertisement: { kind: "version-implied" },
    description:
      "Server supports durable project-scoped queue creation, listing, mutation, dispatch pause/resume, and promotion.",
    clientFallback:
      "Project Queue is baseline in current clients; preserve queue admission, source readiness and configured affordance visibility.",
    serverContract: {
      routes: [
        "GET /api/project-queue",
        "POST /api/project-queue/pause",
        "POST /api/project-queue/resume",
        "POST /api/project-queue/:projectId/promote-now",
        "GET /api/projects/:projectId/queue",
        "POST /api/projects/:projectId/queue",
        "PATCH /api/projects/:projectId/queue/:itemId",
        "DELETE /api/projects/:projectId/queue/:itemId",
        "POST /api/projects/:projectId/queue/:itemId/retry",
        "POST /api/projects/:projectId/queue/:itemId/move-to-top",
      ],
      events: ["project-queue-changed"],
    },
    lifecycle: {
      kind: "permanent",
      reason:
        "The fixed contract remains advertised for older clients; current clients use the supported v0.8.0 baseline.",
    },
  },
  projectQueueRouterSelection: {
    id: CAPABILITY_ID_ALLOCATIONS.projectQueueRouterSelection.id,
    name: "project-queue-router-selection",
    kind: "permanent",
    area: "projectQueue",
    introducedIn: "0.11.1",
    advertisement: { kind: "version-implied" },
    description:
      "New-session Project Queue items carry an Agent Auth Router pool or account selection, allocated when the item dispatches; a router refusal retries and then pauses the item, never launching on the direct login.",
    clientFallback:
      "Refuse to queue a new session while a router pool or account is selected, restored or inherited, so it cannot run on the direct login.",
    serverContract: {
      routes: [
        "POST /api/projects/:projectId/queue",
        "PATCH /api/projects/:projectId/queue/:itemId",
      ],
      requestFields: [
        "target.routerPoolId",
        "target.routerAccountId",
        "target.routerPolicy",
        "target.routerClaudeAiConnectors",
      ],
    },
    lifecycle: {
      kind: "permanent",
      reason:
        "Older servers drop the router fields from queued items and launch them on the direct login.",
    },
  },
  projectQueueReadinessCheck: {
    id: CAPABILITY_ID_ALLOCATIONS.projectQueueReadinessCheck.id,
    name: "project-queue-readiness-check",
    kind: "permanent",
    area: "projectQueue",
    introducedIn: "0.8.2",
    advertisement: { kind: "version-implied" },
    description:
      "Server persists an optional global executable that gates Project Queue readiness, with bounded polling and Force start bypass.",
    clientFallback:
      "Hide the readiness executable setting and omit its field from settings updates.",
    serverContract: {
      routes: ["GET /api/settings", "PUT /api/settings"],
      requestFields: ["settings.projectQueueReadinessCheck"],
      responseFields: ["settings.projectQueueReadinessCheck"],
    },
    lifecycle: {
      kind: "permanent",
      reason:
        "Older servers cannot persist or execute an external Project Queue readiness command.",
    },
  },
  projectQueueAttachmentEditing: {
    id: CAPABILITY_ID_ALLOCATIONS.projectQueueAttachmentEditing.id,
    name: "project-queue-attachment-editing",
    kind: "permanent",
    area: "projectQueue",
    introducedIn: "0.8.1",
    advertisement: { kind: "version-implied" },
    description:
      "Server atomically updates queued-message attachment sets containing retained queue-owned refs and newly uploaded draft refs.",
    clientFallback:
      "Keep Project Queue inline editing text-only and make no attachment upload or attachment mutation request.",
    serverContract: {
      routes: ["PATCH /api/projects/:projectId/queue/:itemId"],
      requestFields: [
        "projectQueue.message.attachments",
        "projectQueue.message.stagedAttachments",
      ],
    },
    lifecycle: {
      kind: "permanent",
      reason:
        "Hosted clients may outpace installed servers that cannot combine queue-owned and draft-owned attachment refs in one update.",
    },
  },
  projectQueueNewSessionShortcutSetting: {
    name: "project-queue-new-session-shortcut-setting",
    kind: "permanent",
    area: "projectQueue",
    introducedIn: "0.6.3",
    advertisement: { kind: "version-implied" },
    description:
      "Server accepts and persists the active-composer new-session Project Queue shortcut presence setting.",
    clientFallback:
      "The new-session shortcut setting is baseline; its configured presence still controls visibility.",
    serverContract: {
      routes: ["GET /api/settings", "PUT /api/settings"],
      responseFields: [
        "settings.clientDefaults.sessionToolbarPresence.projectQueueNewSessionShortcut",
      ],
    },
    lifecycle: {
      kind: "permanent",
      reason:
        "The fixed contract remains advertised for older clients; current clients use the supported v0.8.0 baseline.",
    },
  },
} as const satisfies Record<string, ServerCapabilityDefinition>;
