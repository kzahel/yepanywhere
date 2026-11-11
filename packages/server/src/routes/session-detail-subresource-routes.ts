import type { Hono } from "hono";
import {
  type ProviderName,
  type SessionMetadataResponse,
  type SessionOwnership,
  type UrlProjectId,
  isUrlProjectId,
  nativeViewerFields,
} from "@yep-anywhere/shared";
import { nonHumanUserTurnField } from "../metadata/SessionMetadataService.js";
import { tryClaimProjectPathIndex } from "../projects/projectPathIndex.js";
import { augmentPersistedSessionMessages } from "../sessions/persisted-augments.js";
import {
  mergeProviderChildAgentMappings,
  projectProviderChildren,
  resolveProviderChildSessions,
} from "../sessions/provider-child-sessions.js";
import { findSessionSummaryAcrossProviders } from "../sessions/provider-resolution.js";
import {
  applyRecapOverlayToSummary,
  getEffectiveProviderUpdatedAt,
  hasUnreadProviderContent,
} from "../sessions/recap-overlays.js";
import {
  creationStatusForSession,
  savedCreationView,
} from "../sessions/session-creation-view.js";
import { sessionOwnershipFromProcess } from "../sessions/session-runtime-overlay.js";
import type { ISessionReader } from "../sessions/types.js";
import {
  type SessionDetailRouteDeps,
  type SessionDetailRouting,
  effectiveModelSettingsFromMetadata,
  getSessionSlashCommands,
} from "./session-detail-routes.js";
import {
  providerResolutionDeps,
  resolveSessionReader,
} from "./session-provider-resolution.js";
import { sessionQueueSummaries } from "./session-queue-summaries.js";

/**
 * The agent-mapping, agent-content and metadata reads under
 * `/projects/:projectId/sessions/:sessionId`. Registered at their old
 * position in the sessions route factory so route order is unchanged.
 */
export function registerSessionDetailSubresourceRoutes(
  routes: Hono,
  deps: SessionDetailRouteDeps,
  routing: SessionDetailRouting,
) {
  const {
    resolveSessionProjectRouting,
    buildSessionProjectRedirectPath,
    getGrokNativeProjectId,
    buildGrokNativeRedirectPath,
    rewindRecordIdsFor,
    storedIdentityFor,
  } = routing;

  // GET /api/projects/:projectId/sessions/:sessionId/agents - Get agent mappings
  // Used to find agent sessions for pending Tasks on page reload
  routes.get("/projects/:projectId/sessions/:sessionId/agents", async (c) => {
    const projectId = c.req.param("projectId");

    // Validate projectId format at API boundary
    if (!isUrlProjectId(projectId)) {
      return c.json({ error: "Invalid project ID format" }, 400);
    }

    const routing = await resolveSessionProjectRouting(
      projectId as UrlProjectId,
      c.req.param("sessionId"),
    );
    if ("redirectProjectId" in routing) {
      return c.redirect(
        buildSessionProjectRedirectPath(
          routing.redirectProjectId,
          c.req.param("sessionId"),
          "",
          c.req.url,
        ),
        307,
      );
    }
    if ("error" in routing) {
      return c.json({ error: routing.error }, routing.status);
    }

    const source = await resolveSessionReader({
      deps,
      project: routing.transcriptProject,
      sessionId: c.req.param("sessionId"),
      projectId: routing.transcriptProjectId,
    });
    if (!source) return c.json({ error: "Session not found" }, 404);
    const accepted = source.native
      ? deps.providerChildRelationships?.accepted(
          source.native,
          c.req.param("sessionId"),
        )
      : undefined;
    let fresh: Awaited<ReturnType<ISessionReader["getAgentMappings"]>>;
    try {
      fresh = await source.reader.getAgentMappings(source.nativeSessionId);
    } catch (error) {
      if (accepted === undefined) throw error;
      fresh = [];
    }
    const mappings = mergeProviderChildAgentMappings(fresh, accepted);

    return c.json({ mappings });
  });

  // GET /api/projects/:projectId/sessions/:sessionId/agents/:agentId - Get agent session content
  // Used for lazy-loading completed Tasks
  routes.get(
    "/projects/:projectId/sessions/:sessionId/agents/:agentId",
    async (c) => {
      const projectId = c.req.param("projectId");
      const agentId = c.req.param("agentId");

      // Validate projectId format at API boundary
      if (!isUrlProjectId(projectId)) {
        return c.json({ error: "Invalid project ID format" }, 400);
      }

      const routing = await resolveSessionProjectRouting(
        projectId as UrlProjectId,
        c.req.param("sessionId"),
      );
      if ("redirectProjectId" in routing) {
        return c.redirect(
          buildSessionProjectRedirectPath(
            routing.redirectProjectId,
            c.req.param("sessionId"),
            "",
            c.req.url,
          ),
          307,
        );
      }
      if ("error" in routing) {
        return c.json({ error: routing.error }, routing.status);
      }

      const source = await resolveSessionReader({
        deps,
        project: routing.transcriptProject,
        sessionId: c.req.param("sessionId"),
        projectId: routing.transcriptProjectId,
      });
      if (!source) return c.json({ error: "Session not found" }, 404);
      const agentSession = await source.reader.getAgentSession(
        agentId,
        source.nativeSessionId,
      );

      if (!agentSession) {
        return c.json({ error: "Agent session not found" }, 404);
      }

      // Add server-rendered HTML to text blocks for markdown display
      const pathIndex = await tryClaimProjectPathIndex(
        routing.workingProject.path,
      );
      try {
        await augmentPersistedSessionMessages(agentSession.messages, {
          projectFileLinks: {
            projectId: routing.workingProjectId,
            projectPath: routing.workingProject.path,
            ...(pathIndex ? { index: pathIndex } : {}),
            resolveAbsoluteFilePaths: deps.resolveAbsoluteFilePaths,
          },
        });
      } finally {
        pathIndex?.release();
      }

      return c.json(agentSession);
    },
  );

  // GET /api/projects/:projectId/sessions/:sessionId/metadata - Get session metadata only (no messages)
  // Lightweight endpoint for refreshing title, status, etc. without re-fetching all messages
  routes.get("/projects/:projectId/sessions/:sessionId/metadata", async (c) => {
    const projectId = c.req.param("projectId");
    const sessionId = c.req.param("sessionId");

    // Validate projectId format at API boundary
    if (!isUrlProjectId(projectId)) {
      return c.json({ error: "Invalid project ID format" }, 400);
    }

    const routing = await resolveSessionProjectRouting(
      projectId as UrlProjectId,
      sessionId,
    );
    if ("redirectProjectId" in routing) {
      return c.redirect(
        buildSessionProjectRedirectPath(
          routing.redirectProjectId,
          sessionId,
          "/metadata",
          c.req.url,
        ),
        307,
      );
    }
    if ("error" in routing) {
      return c.json({ error: routing.error }, routing.status);
    }
    if (
      routing.identityLookup.kind === "stored" &&
      !routing.identityLookup.identity.native
    ) {
      const saved = savedCreationView(
        deps.sessionMetadataService,
        routing.identityLookup.identity,
        routing.workingProjectId,
        deps.signal,
      );
      if (saved) return c.json(saved);
    }
    const project = routing.workingProject;
    const transcriptProject = routing.transcriptProject;
    const transcriptProjectId = routing.transcriptProjectId;

    // Check if session is actively owned by a process
    const process = deps.supervisor.getProcessForSession(sessionId);

    // Check if session is being controlled by an external program
    const isExternal = deps.externalTracker?.isExternal(sessionId) ?? false;

    // Determine the session ownership
    const ownership: SessionOwnership = sessionOwnershipFromProcess(process, {
      isExternal,
    });

    // Get session metadata (custom title, archived, starred)
    const metadata = deps.sessionMetadataService?.getMetadata(sessionId);
    // Get notification data (lastSeenAt, hasUnread)
    const lastSeenEntry = deps.notificationService?.getLastSeen(sessionId);
    const lastSeenAt = lastSeenEntry?.timestamp;

    // Get pending input request from active process
    const pendingInputRequest =
      process?.state.type === "waiting-input" ? process.state.request : null;
    const providerRuntimeStatus =
      deps.supervisor.getProviderRuntimeStatusForSession?.(sessionId) ??
      process?.getProviderRuntimeStatus() ??
      null;

    // Read minimal session info from disk (just for title/timestamps, no messages)
    const metadataProvider =
      (routing.identityLookup.kind === "stored"
        ? routing.identityLookup.identity.provider
        : undefined) ??
      (metadata?.provider as ProviderName | undefined) ??
      (deps.sessionMetadataService?.getProvider(sessionId) as
        | ProviderName
        | undefined);
    const slashCommands = await getSessionSlashCommands(
      process,
      process?.provider ?? metadataProvider ?? project.provider,
      metadata,
    );
    const deferredMessages = sessionQueueSummaries(deps, sessionId, process);
    const sessionSummaryResult = await findSessionSummaryAcrossProviders(
      transcriptProject,
      sessionId,
      transcriptProjectId,
      providerResolutionDeps(deps),
      metadataProvider ?? process?.provider,
      undefined,
      routing.identityLookup,
    );
    const rawSessionSummary = sessionSummaryResult?.summary ?? null;
    const providerUpdatedAt = getEffectiveProviderUpdatedAt(
      rawSessionSummary?.updatedAt ?? "",
      process,
    );
    const recapMessages =
      deps.sessionMetadataService?.getRecapMessages?.(sessionId) ?? [];
    const sessionSummary = rawSessionSummary
      ? applyRecapOverlayToSummary(
          { ...rawSessionSummary, updatedAt: providerUpdatedAt },
          recapMessages,
        )
      : null;

    if (!sessionSummary && !process) {
      if (routing.identityLookup.kind === "stored") {
        const saved = savedCreationView(
          deps.sessionMetadataService,
          routing.identityLookup.identity,
          routing.workingProjectId,
          deps.signal,
          true,
        );
        if (saved) return c.json(saved);
      }

      const canonicalProjectId = await getGrokNativeProjectId(
        sessionId,
        projectId as UrlProjectId,
      );
      if (canonicalProjectId) {
        return c.redirect(
          buildGrokNativeRedirectPath(
            canonicalProjectId,
            sessionId,
            "/metadata",
            c.req.url,
          ),
          307,
        );
      }
      return c.json({ error: "Session not found" }, 404);
    }

    const hasUnread = providerUpdatedAt
      ? hasUnreadProviderContent(
          deps.notificationService,
          sessionId,
          providerUpdatedAt,
        )
      : undefined;

    const providerChildren = projectProviderChildren(
      await resolveProviderChildSessions(
        sessionSummaryResult?.source.reader,
        sessionSummaryResult?.nativeSessionId ?? sessionId,
        "fresh",
        deps.providerChildRelationships && sessionSummaryResult?.native
          ? {
              service: deps.providerChildRelationships,
              native: sessionSummaryResult.native,
              publicSessionId: sessionId,
            }
          : undefined,
      ),
      sessionId,
    );

    const response = {
      session: {
        id: sessionId,
        projectId: routing.workingProjectId,
        title: sessionSummary?.title ?? null,
        fullTitle: sessionSummary?.fullTitle ?? null,
        createdAt: sessionSummary?.createdAt ?? new Date().toISOString(),
        updatedAt:
          sessionSummary?.updatedAt ||
          providerUpdatedAt ||
          new Date().toISOString(),
        messageCount: sessionSummary?.messageCount ?? 0,
        provider:
          metadataProvider ??
          process?.provider ??
          sessionSummary?.provider ??
          project.provider,
        model: sessionSummary?.model,
        originator: sessionSummary?.originator,
        cliVersion: sessionSummary?.cliVersion,
        source: sessionSummary?.source,
        approvalPolicy: sessionSummary?.approvalPolicy,
        sandboxPolicy: sessionSummary?.sandboxPolicy,
        contextUsage: sessionSummary?.contextUsage,
        effectiveModelSettings: effectiveModelSettingsFromMetadata(metadata),
        effectiveLaunchSettings: metadata?.effectiveLaunchSettings,
        nonHumanUserTurn: nonHumanUserTurnField(
          deps.sessionMetadataService,
          sessionId,
        ),
        customTitle: metadata?.customTitle,
        isArchived: metadata?.isArchived,
        isStarred: metadata?.isStarred,
        clearloop: deps.clearloopService?.getBadge(sessionId),
        rewindRecordIds: rewindRecordIdsFor(sessionId),
        parentSessionId:
          metadata?.parentSessionId ?? sessionSummary?.parentSessionId,
        parentSessionKind:
          metadata?.parentSessionKind ?? sessionSummary?.parentSessionKind,
        forkedFromSessionId:
          metadata?.forkedFromSessionId ?? sessionSummary?.forkedFromSessionId,
        creationProvenance: metadata?.creationProvenance,
        creation: creationStatusForSession(
          deps.sessionMetadataService,
          sessionId,
          deps.signal,
        ),
        routerBinding: metadata?.routerBinding,
        sandboxLevel: metadata?.sandboxLevel,
        sandboxNetworkFirewall: metadata?.sandboxNetworkFirewall,
        initialPrompt:
          metadata?.initialPrompt ?? sessionSummary?.fullTitle ?? undefined,
        ...nativeViewerFields(storedIdentityFor(sessionId)?.native),
        wakeTurnsEnabled: metadata?.wakeTurnsEnabled,
        promptSuggestionMode: metadata?.promptSuggestionMode,
        recapAfterSeconds: metadata?.recapAfterSeconds,
        workingProjectId: metadata?.workingProjectId,
        transcriptProjectId: metadata?.transcriptProjectId,
        transcriptDisplayObjects: metadata?.transcriptDisplayObjects,
        lastSeenAt,
        hasUnread,
        ...(providerChildren ? { providerChildren } : {}),
      },
      ownership,
      processState: process?.state.type ?? null,
      providerRuntimeStatus,
      pendingInputRequest,
      slashCommands,
      ...(deferredMessages.length > 0 ? { deferredMessages } : {}),
    } satisfies SessionMetadataResponse;

    return c.json(response);
  });
}
