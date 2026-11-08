import type { Hono } from "hono";
import { performance } from "node:perf_hooks";
import {
  type DurableLocalCommandMessage,
  type DurableRecapMessage,
  type DurableSyntheticDoneMessage,
  type NativeSessionRef,
  type ProviderName,
  type SessionEffectiveModelSettings,
  type UrlProjectId,
  isUrlProjectId,
  withKnownGoal,
} from "@yep-anywhere/shared";
import { isRealUserTurn } from "@yep-anywhere/shared/transcript/messageProjection";
import {
  augmentTaskListSnapshots,
  projectTaskListSnapshots,
  pruneTaskListSnapshotsToLatest,
} from "../augments/task-list-augments.js";
import { getLogger } from "../logging/logger.js";
import type { ToolResultMediaStore } from "../media/ToolResultMediaStore.js";
import type {
  SessionMetadata,
  SessionMetadataService,
} from "../metadata/index.js";
import {
  goalCommandOf,
  nonHumanUserTurnField,
} from "../metadata/SessionMetadataService.js";
import type { NotificationService } from "../notifications/index.js";
import { tryClaimProjectPathIndex } from "../projects/projectPathIndex.js";
import type { ProjectScanner } from "../projects/scanner.js";
import { getStaticSlashCommandsForProvider } from "../sdk/providers/staticSlashCommands.js";
import type { ClearloopService } from "../services/ClearloopService.js";
import type { ModelInfoService } from "../services/ModelInfoService.js";
import type { SessionQueuePersistenceService } from "../services/SessionQueuePersistenceService.js";
import { BoundSessionReads } from "../sessions/bound-session-reader.js";
import type { NestedHarnessRelationshipService } from "../sessions/NestedHarnessRelationshipService.js";
import {
  detachSessionMessageProjection,
  getCodexMessageSourceByteCursor,
  normalizeSession,
} from "../sessions/normalization.js";
import {
  type PaginationInfo,
  sliceAfterMessageIdWithMatch,
  sliceAtCompactAndUserTurnBoundaries,
  sliceAtCompactBoundaries,
  sliceAtUserTurnBoundary,
} from "../sessions/pagination.js";
import {
  type PersistedAugmentDiagnostics,
  augmentEditToolUses,
  augmentPersistedSessionMessages,
} from "../sessions/persisted-augments.js";
import {
  projectProviderChildren,
  resolveProviderChildSessions,
} from "../sessions/provider-child-sessions.js";
import {
  getSessionSources,
  resolveLegacySessionSource,
} from "../sessions/provider-resolution.js";
import {
  applyRecapOverlayToSummary,
  applySessionOverlaysToSession,
  getEffectiveProviderUpdatedAt,
  hasEquivalentRecapMessage,
  hasUnreadProviderContent,
  latestRecapMessage,
  mergeLocalCommandMessages,
  mergeSessionOverlayMessages,
} from "../sessions/recap-overlays.js";
import {
  creationStatusForSession,
  savedCreationView,
} from "../sessions/session-creation-view.js";
import { sessionOwnershipFromProcess } from "../sessions/session-runtime-overlay.js";
import type {
  SessionIdentity,
  SessionIdentityLookup,
} from "../sessions/SessionIdentityStore.js";
import type {
  GetSessionOptions,
  ISessionReader,
  LoadedSession,
} from "../sessions/types.js";
import type { ExternalSessionTracker } from "../supervisor/ExternalSessionTracker.js";
import type { Process } from "../supervisor/Process.js";
import type { Supervisor } from "../supervisor/Supervisor.js";
import type { Message, Project } from "../supervisor/types.js";
import { resolveExistingSessionIdentity } from "./session-existing-identity.js";
import { messageId } from "./session-message-id.js";
import {
  type SessionProviderResolutionDeps,
  isClaudeSdkProviderName,
  providerResolutionDeps,
} from "./session-provider-resolution.js";
import { sessionQueueSummaries } from "./session-queue-summaries.js";
import {
  extractContextUsageFromSDKMessages,
  sdkMessagesToClientMessages,
} from "./session-sdk-history.js";

const SESSION_DETAIL_SLOW_LOG_MS = 250;
const DEFAULT_SESSION_DETAIL_TAIL_COMPACTIONS = 2;
const LARGE_FULL_HISTORY_MESSAGE_THRESHOLD = 1000;

export function effectiveModelSettingsFromMetadata(
  metadata: SessionMetadata | undefined,
): SessionEffectiveModelSettings | undefined {
  const settings = metadata?.effectiveLaunchSettings;
  if (!settings) return undefined;

  return {
    requestedModel: settings.requestedModel,
    thinking: settings.thinking,
    effort: settings.effort,
  };
}

export async function getSessionSlashCommands(
  process: Process | undefined,
  provider: ProviderName | undefined,
  metadata: SessionMetadata | undefined,
) {
  let commands = getStaticSlashCommandsForProvider(provider);
  if (process?.supportsDynamicCommands) {
    try {
      commands = (await process.supportedCommands()) ?? commands;
    } catch (error) {
      getLogger().warn(
        {
          event: "session_dynamic_commands_unavailable",
          sessionId: process.sessionId,
          processId: process.id,
          provider,
          error: error instanceof Error ? error.message : String(error),
        },
        "Falling back to static commands for session read",
      );
    }
  }
  // A stopped session has no provider to ask, so the last observed goal stands
  // in for live state.
  return withKnownGoal(commands, goalCommandOf(metadata));
}

function roundedMs(value: number): number {
  return Math.round(value * 10) / 10;
}

type DurableSessionOverlayMessage =
  | DurableRecapMessage
  | DurableLocalCommandMessage
  | DurableSyntheticDoneMessage;

function findDurableOverlayCursor(
  afterMessageId: string | undefined,
  overlays: readonly DurableSessionOverlayMessage[],
): DurableSessionOverlayMessage | undefined {
  if (!afterMessageId) {
    return undefined;
  }
  return overlays.find(
    (overlay) =>
      overlay.uuid === afterMessageId || overlay.id === afterMessageId,
  );
}

function sliceAfterDurableOverlayCursor(params: {
  messages: Message[];
  overlay: DurableSessionOverlayMessage;
  cursorId: string;
}): { messages: Message[]; found: boolean } {
  const index = params.messages.findIndex((message) => {
    const id = messageId(message);
    return (
      id === params.cursorId ||
      id === params.overlay.uuid ||
      id === params.overlay.id ||
      (params.overlay.type === "system" &&
        params.overlay.subtype === "away_summary" &&
        hasEquivalentRecapMessage([message], params.overlay))
    );
  });
  if (index < 0) {
    return { messages: params.messages, found: false };
  }
  return { messages: params.messages.slice(index + 1), found: true };
}

function completedPublicShareMessageCount(options: {
  messages: Message[];
  process?: Process;
  sourceIsExternal: boolean;
  sourceUpdatedAt: string;
  hasDurableHistory: boolean;
}): number {
  const { messages, process } = options;
  const sourceIsBusy =
    options.sourceIsExternal ||
    process?.state.type === "in-turn" ||
    process?.state.type === "waiting-input";
  if (!sourceIsBusy) {
    return messages.length;
  }

  // Replay-only messages are a live catch-up buffer, not a durable completed
  // turn. Before the provider creates its transcript, the stable prefix is
  // therefore empty.
  if (!options.hasDurableHistory) {
    return 0;
  }

  // A newly resumed process can be active before its first input reaches the
  // existing transcript. In that window, every persisted row predates the
  // active turn and is already safe to capture.
  const sourceUpdatedAt = Date.parse(options.sourceUpdatedAt);
  if (
    process &&
    !Number.isNaN(sourceUpdatedAt) &&
    sourceUpdatedAt < process.startedAt.getTime()
  ) {
    return messages.length;
  }

  // Provider transcripts are append-only within a turn. While a source is
  // busy, the latest user-authored request begins the only incomplete suffix;
  // retaining everything before it captures every completed turn.
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message && isRealUserTurn(message)) {
      return index;
    }
  }
  return 0;
}

/** The project routing a session-detail read resolved for its request. */
export type SessionProjectRouting =
  | { error: string; status: 404 }
  | {
      redirectProjectId: UrlProjectId;
    }
  | {
      transcriptProject: Project;
      transcriptProjectId: UrlProjectId;
      workingProject: Project;
      workingProjectId: UrlProjectId;
      identityLookup: SessionIdentityLookup;
    };

/**
 * Route-factory closures the session-detail reads share with routes that stay
 * in `createSessionsRoutes`; passed in rather than imported back.
 */
export interface SessionDetailRouting {
  resolveSessionProjectRouting: (
    requestProjectId: UrlProjectId,
    sessionId: string,
  ) => Promise<SessionProjectRouting>;
  buildSessionProjectRedirectPath: (
    canonicalProjectId: UrlProjectId,
    sessionId: string,
    suffix: string,
    requestUrl: string,
  ) => string;
  getGrokNativeProjectId: (
    sessionId: string,
    currentProjectId: UrlProjectId,
  ) => Promise<UrlProjectId | null>;
  buildGrokNativeRedirectPath: (
    canonicalProjectId: UrlProjectId,
    sessionId: string,
    suffix: "" | "/metadata",
    requestUrl: string,
  ) => string;
  rewindRecordIdsFor: (sessionId: string) => string[] | undefined;
  storedIdentityFor: (sessionId: string) => SessionIdentity | undefined;
}

/** The `SessionsDeps` fields the session-detail reads use. */
export interface SessionDetailRouteDeps extends SessionProviderResolutionDeps {
  supervisor: Supervisor;
  scanner: ProjectScanner;
  harnessRelationships?: Pick<
    NestedHarnessRelationshipService,
    "observeTranscript"
  >;
  onIssueWindow?: (
    source: { sessionId: string; projectId: string },
    messages: readonly Message[],
  ) => void;
  externalTracker?: ExternalSessionTracker;
  notificationService?: NotificationService;
  sessionMetadataService?: SessionMetadataService;
  modelInfoService?: ModelInfoService;
  sessionQueuePersistenceService?: SessionQueuePersistenceService;
  clearloopService?: ClearloopService;
  toolResultMediaStore?: ToolResultMediaStore;
  persistedAugmentDelayMs?: number;
  resolveAbsoluteFilePaths?: (
    paths: readonly string[],
  ) => Promise<ReadonlySet<string>>;
}

/**
 * `GET /projects/:projectId/sessions/:sessionId`, the session-detail read,
 * with the provider-session loader only it uses. Registered at the route's
 * old position in the sessions route factory so route order is unchanged.
 */
export function registerSessionDetailRoute(
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
  const boundSessionReads = new BoundSessionReads({
    readerFactory: deps.readerFactory,
    sessionIndexService: deps.sessionIndexService,
  });

  const loadProviderSession = async (
    project: Project,
    sessionId: string,
    projectId: UrlProjectId,
    preferredProvider: ProviderName | undefined,
    afterMessageId?: string,
    options?: GetSessionOptions,
    lookup?: SessionIdentityLookup,
  ): Promise<{
    session: LoadedSession | null;
    identity?: SessionIdentity;
    nativeSource?: {
      reader: ISessionReader;
      nativeSessionId: string;
      native?: NativeSessionRef;
    };
  }> => {
    if (deps.signal?.aborted) return { session: null };
    const identity =
      lookup?.kind === "stored"
        ? lookup.identity
        : lookup?.kind === "legacy"
          ? undefined
          : storedIdentityFor(sessionId);
    if (identity) {
      const resolved = await resolveExistingSessionIdentity({
        sessionId,
        requestProjectId: projectId,
        identityLookup: { kind: "stored", identity },
        metadata: deps.sessionMetadataService?.getMetadata(sessionId),
        scanner: deps.scanner,
        providerDeps: providerResolutionDeps(deps),
      });
      return {
        identity,
        nativeSource: resolved?.native
          ? {
              reader: deps.readerFactory(
                { ...resolved.transcriptProject, provider: resolved.provider },
                resolved.native,
              ),
              nativeSessionId: resolved.native.id,
              native: resolved.native,
            }
          : undefined,
        session: resolved?.native
          ? await boundSessionReads.read({
              sessionId: identity.sessionId,
              provider: resolved.provider,
              native: resolved.native,
              transcriptProject: resolved.transcriptProject,
              projectId,
              afterMessageId,
              options,
            })
          : null,
      };
    }

    // Explicit retained legacy reader boundary. No managed/unbound identity
    // reaches this path or substitutes its public id for a native address.
    for (const candidate of getSessionSources(
      project,
      providerResolutionDeps(deps),
      preferredProvider,
    )) {
      const legacy = await resolveLegacySessionSource(
        candidate,
        sessionId,
        { ...project, id: projectId },
        providerResolutionDeps(deps),
      );
      if (!legacy) continue;
      const source = legacy.source;
      const summaryHint =
        options?.tailCompactions !== undefined &&
        source.provider === "codex" &&
        deps.sessionIndexService
          ? ((await deps.sessionIndexService.getCachedSessionSummary(
              source.sessionDir,
              projectId,
              legacy.nativeSessionId,
              source.reader,
              // A live Codex rollout grows between index passes, so requiring
              // an exactly-current index meant every mid-turn open of a long
              // session lost the compact-tail window and fell back to reading
              // and normalizing the whole file. The reader takes only
              // head-derived fields from this hint and reads the tail itself.
              { acceptAppendedFile: true },
            )) ??
            (await deps.sessionIndexService.getSessionSummaryWithCache?.(
              source.sessionDir,
              projectId,
              legacy.nativeSessionId,
              source.reader,
            )))
          : null;
      const loaded = await source.reader.getSession(
        legacy.nativeSessionId,
        projectId,
        afterMessageId,
        summaryHint ? { ...options, summaryHint } : options,
      );
      if (loaded) {
        return {
          session: loaded,
          nativeSource: {
            reader: source.reader,
            nativeSessionId: legacy.nativeSessionId,
            native: legacy.native,
          },
        };
      }
    }

    return { session: null };
  };

  // GET /api/projects/:projectId/sessions/:sessionId - Get session detail
  // Optional query params:
  //   ?afterMessageId=<id> - incremental forward-fetch (append new messages)
  //   ?tailCompactions=<n> - return only last N compact boundaries worth of messages
  //   ?beforeMessageId=<id> - cursor for loading older chunks (used with tailCompactions)
  //   ?tailTurns=<n> - recent-turn selector within the authorized history scope
  //   ?tailFrom=<id> - start selector within the authorized history scope
  //   ?fullHistory=1 - explicitly authorize selectors to inspect full history
  routes.get("/projects/:projectId/sessions/:sessionId", async (c) => {
    const requestStartMs = performance.now();
    const projectId = c.req.param("projectId");
    const sessionId = c.req.param("sessionId");
    const afterMessageId = c.req.query("afterMessageId");
    const publicShare = c.req.query("publicShare") === "1";
    const fullHistory = c.req.query("fullHistory") === "1";
    const fullHistoryReason = c.req.query("fullHistoryReason");
    const tailCompactionsParam = c.req.query("tailCompactions");
    const beforeMessageId = c.req.query("beforeMessageId");
    const tailTurnsParam = c.req.query("tailTurns");
    const tailFrom = c.req.query("tailFrom");
    const tailCompactions =
      tailCompactionsParam !== undefined
        ? Number.parseInt(tailCompactionsParam, 10)
        : undefined;
    const tailTurns =
      tailTurnsParam !== undefined
        ? Number.parseInt(tailTurnsParam, 10)
        : undefined;
    const requestedTailCompactions =
      tailCompactions !== undefined &&
      !Number.isNaN(tailCompactions) &&
      tailCompactions > 0
        ? tailCompactions
        : undefined;
    const requestedTailTurns =
      tailTurns !== undefined && !Number.isNaN(tailTurns) && tailTurns > 0
        ? tailTurns
        : undefined;
    const defaultedToCompactTail =
      !fullHistory && !afterMessageId && requestedTailCompactions === undefined;
    const unboundedRequestDefaultedToCompactTail =
      defaultedToCompactTail && !tailFrom && requestedTailTurns === undefined;
    const effectiveTailCompactions =
      requestedTailCompactions ??
      (defaultedToCompactTail
        ? DEFAULT_SESSION_DETAIL_TAIL_COMPACTIONS
        : undefined);

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
          "",
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
      if (saved)
        return c.json({
          ...saved,
          messages: [],
          transcriptSnapshotUpdatedAt: "",
        });
    }
    const project = routing.workingProject;
    const effectiveProjectId = routing.workingProjectId;
    const transcriptProject = routing.transcriptProject;
    const transcriptProjectId = routing.transcriptProjectId;
    const projectResolvedMs = performance.now();

    // Check if session is actively owned by a process
    const process = deps.supervisor.getProcessForSession(sessionId);

    // Check if session is being controlled by an external program
    const isExternal = deps.externalTracker?.isExternal(sessionId) ?? false;

    // Check if we've ever owned this session (for orphan detection)
    // Only mark tools as "aborted" if we owned the session and know it terminated
    const wasEverOwned = deps.supervisor.wasEverOwned(sessionId);
    const metadataProvider =
      (routing.identityLookup.kind === "stored"
        ? routing.identityLookup.identity.provider
        : undefined) ??
      (deps.sessionMetadataService?.getProvider(sessionId) as
        | ProviderName
        | undefined);
    const recapMessages =
      deps.sessionMetadataService?.getRecapMessages?.(sessionId) ?? [];
    const syntheticDoneMessages =
      deps.sessionMetadataService?.getSyntheticDoneMessages?.(sessionId) ?? [];
    const localCommandMessages =
      deps.sessionMetadataService?.getLocalCommandMessages?.(sessionId) ?? [];
    const overlayCursor = findDurableOverlayCursor(afterMessageId, [
      ...recapMessages,
      ...syntheticDoneMessages,
      ...localCommandMessages,
    ]);
    const providerAfterMessageId = overlayCursor ? undefined : afterMessageId;
    const primaryReaderAfterMessageId =
      isClaudeSdkProviderName(project.provider) ||
      isClaudeSdkProviderName(metadataProvider)
        ? undefined
        : providerAfterMessageId;

    const {
      session: loadedSession,
      identity: resolvedIdentity,
      nativeSource,
    } = await loadProviderSession(
      transcriptProject,
      sessionId,
      transcriptProjectId,
      metadataProvider ?? process?.provider,
      primaryReaderAfterMessageId,
      {
        // Only include orphaned tool info if:
        // 1. We previously owned this session (not external)
        // 2. No active process (tools aren't potentially in progress)
        // When we own the session, tools without results might be pending approval
        includeOrphans: wasEverOwned && !process,
        ...(process?.state.type === "in-turn" ||
        process?.state.type === "waiting-input"
          ? { ownedTurnInProgress: true }
          : {}),
        ...(!fullHistory &&
        ((!afterMessageId && effectiveTailCompactions !== undefined) ||
          primaryReaderAfterMessageId)
          ? {
              tailCompactions:
                effectiveTailCompactions ??
                DEFAULT_SESSION_DETAIL_TAIL_COMPACTIONS,
              ...(!afterMessageId && beforeMessageId
                ? { beforeMessageId }
                : {}),
            }
          : {}),
      },
      routing.identityLookup,
    );

    const readEndMs = performance.now();
    if (
      !publicShare &&
      loadedSession &&
      loadedSession.committedEntries !== undefined &&
      loadedSession.transcriptSourceVersion !== undefined &&
      !loadedSession.readWindow &&
      resolvedIdentity &&
      (loadedSession.data.provider === "claude" ||
        loadedSession.data.provider === "claude-gateway" ||
        loadedSession.data.provider === "claude-ollama")
    )
      deps.harnessRelationships?.observeTranscript(
        {
          sessionId: resolvedIdentity.sessionId,
          provider: resolvedIdentity.provider,
          projectPath: transcriptProject.path,
        },
        loadedSession.data.session.messages,
        loadedSession.committedEntries,
        loadedSession.transcriptSourceVersion,
      );

    let session = loadedSession
      ? normalizeSession(loadedSession, {
          rewindRecords:
            deps.sessionMetadataService?.getRewindRecords?.(sessionId),
        })
      : null;
    const explicitProvider = metadataProvider ?? process?.provider;
    if (session && explicitProvider) {
      session = { ...session, provider: explicitProvider };
    }
    const normalizedMessageCount = session?.messages.length ?? 0;
    const normalizeEndMs = performance.now();
    if (session && isClaudeSdkProviderName(session.provider)) {
      session = {
        ...session,
        messages: projectTaskListSnapshots(session.messages),
      };
    }
    let incrementalAnchorFound = false;
    if (session && providerAfterMessageId) {
      const sliced = sliceAfterMessageIdWithMatch(
        session.messages,
        providerAfterMessageId,
      );
      session = {
        ...session,
        messages: sliced.messages,
      };
      incrementalAnchorFound = sliced.found;
    }

    // Determine the session ownership
    const ownership = sessionOwnershipFromProcess(process, {
      isExternal,
      fallback: session?.ownership,
    });

    // Get pending input request from active process (for tool approval prompts)
    // This ensures clients get pending requests immediately without waiting for SSE
    const pendingInputRequest =
      process?.state.type === "waiting-input" ? process.state.request : null;
    const providerRuntimeStatus =
      deps.supervisor.getProviderRuntimeStatusForSession?.(sessionId) ??
      process?.getProviderRuntimeStatus() ??
      null;

    // Get available slash commands (for "/" button and typed slash menu)
    // The init message that normally carries these gets discarded from the SSE buffer
    // after ~30s, so we attach them to the REST response. Providers with known
    // native built-ins, such as Codex, can expose those while stopped.
    const metadataStartMs = performance.now();
    const slashCommands = await getSessionSlashCommands(
      process,
      process?.provider ??
        session?.provider ??
        metadataProvider ??
        project.provider,
      deps.sessionMetadataService?.getMetadata(sessionId),
    );
    const deferredMessages = sessionQueueSummaries(deps, sessionId, process);
    const providerChildren = projectProviderChildren(
      await resolveProviderChildSessions(
        nativeSource?.reader,
        nativeSource?.nativeSessionId ?? sessionId,
        "fresh",
        deps.providerChildRelationships && nativeSource?.native
          ? {
              service: deps.providerChildRelationships,
              native: nativeSource.native,
              publicSessionId: sessionId,
            }
          : undefined,
      ),
      sessionId,
    );

    const metadataMs = performance.now() - metadataStartMs;

    if (!session) {
      // Session file doesn't exist yet - only valid if we own the process
      if (process) {
        // Keep Process history as provider-owned replay state. Presentation fields
        // are computed on a detached client projection, as on file-backed reads.
        const sdkMessages = process.getMessageHistory();
        const transcriptSnapshotUpdatedAt =
          process.lastProviderContentTime?.toISOString() ??
          process.startedAt.toISOString();
        const processMessages = sdkMessagesToClientMessages(
          structuredClone(sdkMessages),
        );
        if (isClaudeSdkProviderName(process.provider)) {
          augmentTaskListSnapshots(processMessages);
        }
        if (publicShare) {
          await augmentEditToolUses(processMessages);
        } else {
          const pathIndex = await tryClaimProjectPathIndex(project.path);
          try {
            await augmentPersistedSessionMessages(processMessages, {
              projectFileLinks: {
                projectId: effectiveProjectId,
                projectPath: project.path,
                ...(pathIndex ? { index: pathIndex } : {}),
                resolveAbsoluteFilePaths: deps.resolveAbsoluteFilePaths,
              },
            });
          } finally {
            pathIndex?.release();
          }
        }
        // Extract context usage from raw SDK messages (has usage field)
        // Use process.contextWindow (captured from result messages) as primary source
        const mis = deps.modelInfoService;
        const sdkContextWindow = process.contextWindow;
        const contextUsage = extractContextUsageFromSDKMessages(
          sdkMessages,
          process.resolvedModel,
          process.provider,
          sdkContextWindow
            ? () => sdkContextWindow
            : mis
              ? (m, p) => mis.getContextWindow(m, p)
              : undefined,
        );
        // (Durable recording happens at the observation point in Process via
        // onContextWindowObserved, not as a side effect of this GET.)
        // Get metadata even for new sessions (in case it was set before file was written)
        const metadata = deps.sessionMetadataService?.getMetadata(sessionId);
        const recapMessages =
          deps.sessionMetadataService?.getRecapMessages?.(sessionId) ?? [];
        const syntheticDoneMessages =
          deps.sessionMetadataService?.getSyntheticDoneMessages?.(sessionId) ??
          [];
        const visibleProcessMessages = mergeSessionOverlayMessages(
          processMessages,
          recapMessages,
          syntheticDoneMessages,
          localCommandMessages,
        );
        // Get notification data for new sessions too
        const lastSeenEntry = deps.notificationService?.getLastSeen(sessionId);
        const latestRecap = latestRecapMessage(recapMessages);
        const newSessionUpdatedAt =
          latestRecap?.timestamp ?? new Date().toISOString();
        const publicShareCompletedMessageCount =
          publicShare && fullHistory
            ? completedPublicShareMessageCount({
                messages: visibleProcessMessages,
                process,
                sourceIsExternal: false,
                sourceUpdatedAt: newSessionUpdatedAt,
                hasDurableHistory: false,
              })
            : undefined;
        const hasUnread = deps.notificationService
          ? deps.notificationService.hasUnread(sessionId, newSessionUpdatedAt)
          : undefined;
        return c.json({
          session: {
            id: sessionId,
            projectId: effectiveProjectId,
            title: null,
            createdAt: new Date().toISOString(),
            updatedAt: newSessionUpdatedAt,
            messageCount: processMessages.length,
            ownership,
            nonHumanUserTurn: nonHumanUserTurnField(
              deps.sessionMetadataService,
              sessionId,
            ),
            customTitle: metadata?.customTitle,
            isArchived: metadata?.isArchived,
            isStarred: metadata?.isStarred,
            clearloop: deps.clearloopService?.getBadge(sessionId),
            rewindRecordIds: rewindRecordIdsFor(sessionId),
            parentSessionId: metadata?.parentSessionId,
            parentSessionKind: metadata?.parentSessionKind,
            forkedFromSessionId: metadata?.forkedFromSessionId,
            creationProvenance: metadata?.creationProvenance,
            creation: creationStatusForSession(
              deps.sessionMetadataService,
              sessionId,
              deps.signal,
            ),
            routerBinding: metadata?.routerBinding,
            sandboxLevel: metadata?.sandboxLevel,
            sandboxNetworkFirewall: metadata?.sandboxNetworkFirewall,
            initialPrompt: metadata?.initialPrompt,
            nativeSessionId: storedIdentityFor(sessionId)?.native?.id,
            wakeTurnsEnabled: metadata?.wakeTurnsEnabled,
            promptSuggestionMode: metadata?.promptSuggestionMode,
            recapAfterSeconds: metadata?.recapAfterSeconds,
            workingProjectId: metadata?.workingProjectId,
            transcriptProjectId: metadata?.transcriptProjectId,
            transcriptDisplayObjects: metadata?.transcriptDisplayObjects,
            lastSeenAt: lastSeenEntry?.timestamp,
            hasUnread,
            provider: process.provider,
            model: process.resolvedModel,
            effectiveModelSettings:
              effectiveModelSettingsFromMetadata(metadata),
            effectiveLaunchSettings: metadata?.effectiveLaunchSettings,
            contextUsage,
            ...(providerChildren ? { providerChildren } : {}),
          },
          messages: visibleProcessMessages,
          transcriptSnapshotUpdatedAt,
          ownership,
          providerRuntimeStatus,
          pendingInputRequest,
          slashCommands,
          ...(publicShareCompletedMessageCount !== undefined
            ? {
                publicShareCapture: {
                  completedMessageCount: publicShareCompletedMessageCount,
                },
              }
            : {}),
          ...(deferredMessages.length > 0 ? { deferredMessages } : {}),
        });
      }
      if (routing.identityLookup.kind === "stored") {
        const saved = savedCreationView(
          deps.sessionMetadataService,
          routing.identityLookup.identity,
          routing.workingProjectId,
          deps.signal,
          true,
        );
        if (saved)
          return c.json({
            ...saved,
            messages: [],
            transcriptSnapshotUpdatedAt: "",
          });
      }
      const canonicalProjectId = resolvedIdentity
        ? null
        : await getGrokNativeProjectId(sessionId, projectId as UrlProjectId);
      if (canonicalProjectId) {
        return c.redirect(
          buildGrokNativeRedirectPath(
            canonicalProjectId,
            sessionId,
            "",
            c.req.url,
          ),
          307,
        );
      }
      return c.json({ error: "Session not found" }, 404);
    }
    if (!loadedSession) {
      throw new Error("Normalized session is missing its reader snapshot");
    }

    // Get session metadata (custom title, archived, starred)
    const metadata = deps.sessionMetadataService?.getMetadata(sessionId);

    // Get notification data (lastSeenAt, hasUnread)
    const lastSeenEntry = deps.notificationService?.getLastSeen(sessionId);
    const lastSeenAt = lastSeenEntry?.timestamp;

    // Apply pagination BEFORE expensive augmentation. Compact boundaries set
    // the authorized history scope by default; turn selectors may narrow that
    // scope but cannot broaden it unless fullHistory=1 removed the default.
    // Skip initial-window slicing for incremental forward fetches. A provider-
    // bounded older page already ends before its requested cursor.
    const providerBoundedOlderPage =
      loadedSession.readWindow?.kind === "compact-page";
    let paginationInfo: PaginationInfo | undefined;
    if (
      !afterMessageId &&
      effectiveTailCompactions !== undefined &&
      !beforeMessageId &&
      (tailFrom || requestedTailTurns !== undefined)
    ) {
      const sliced = sliceAtCompactAndUserTurnBoundaries(
        session.messages,
        effectiveTailCompactions,
        requestedTailTurns ?? 20,
        tailFrom,
      );
      session = { ...session, messages: sliced.messages };
      paginationInfo = sliced.pagination;
    } else if (
      !afterMessageId &&
      effectiveTailCompactions === undefined &&
      (tailFrom || requestedTailTurns !== undefined)
    ) {
      const sliced = sliceAtUserTurnBoundary(
        session.messages,
        requestedTailTurns ?? 20,
        tailFrom,
      );
      session = { ...session, messages: sliced.messages };
      paginationInfo = sliced.pagination;
    } else if (effectiveTailCompactions !== undefined && !afterMessageId) {
      const sliced = sliceAtCompactBoundaries(
        session.messages,
        effectiveTailCompactions,
        providerBoundedOlderPage ? undefined : beforeMessageId,
      );
      session = { ...session, messages: sliced.messages };
      paginationInfo = sliced.pagination;
    }
    if (
      loadedSession.readWindow &&
      paginationInfo?.hasOlderMessages &&
      (session.provider === "codex" || session.provider === "codex-oss")
    ) {
      const firstMessage = session.messages[0];
      const sourceCursor = firstMessage
        ? getCodexMessageSourceByteCursor(firstMessage)
        : undefined;
      if (!sourceCursor) {
        throw new Error(
          "Provider compact-window read did not expose its source cursor",
        );
      }
      paginationInfo = {
        ...paginationInfo,
        truncatedBeforeMessageId: sourceCursor,
      };
    }
    if (
      loadedSession.readWindow &&
      !incrementalAnchorFound &&
      (paginationInfo?.hasOlderMessages !==
        loadedSession.readWindow.omittedPrefix ||
        (loadedSession.readWindow.omittedPrefix &&
          paginationInfo.truncatedBeforeMessageId === undefined))
    ) {
      throw new Error(
        "Provider compact-window read did not preserve its older-history boundary",
      );
    }
    // Codex normalized IDs can drift between stream and JSONL. If an
    // incremental request misses its anchor, never return the full historical
    // session into a compact-tail client; bound the fallback to the same tail
    // window used for initial loads.
    if (providerAfterMessageId && !incrementalAnchorFound) {
      const sliced = sliceAtCompactBoundaries(
        session.messages,
        effectiveTailCompactions ?? DEFAULT_SESSION_DETAIL_TAIL_COMPACTIONS,
      );
      session = { ...session, messages: sliced.messages };
      paginationInfo = sliced.pagination;
    }
    const sliceEndMs = performance.now();

    if (!publicShare) {
      deps.onIssueWindow?.(
        {
          sessionId: process?.sessionId ?? session.id,
          projectId: effectiveProjectId,
        },
        session.messages,
      );
    }

    // Normalization carries sanitized inline image bytes as private symbol
    // metadata. Consume those candidates before generic response detachment,
    // which intentionally retains only serializable fields. The materializer
    // is copy-on-write and does not mutate provider-reader cache objects.
    if (!publicShare && deps.toolResultMediaStore) {
      session = {
        ...session,
        messages: await deps.toolResultMediaStore
          .createMaterializer({
            provider: session.provider,
            projectId: effectiveProjectId,
            projectPath: project.path,
            getSessionId: () => sessionId,
          })
          .materializeMessages(session.messages),
      };
    }

    // Normalized messages may be shared by the parsed-transcript cache, and
    // several provider readers expose stable message objects directly.
    // Route-specific HTML, tool, media, and pruning fields belong only to this
    // response projection.
    session = {
      ...session,
      messages: detachSessionMessageProjection(session.messages),
    };
    if (isClaudeSdkProviderName(session.provider)) {
      pruneTaskListSnapshotsToLatest(session.messages);
    }

    // Keep persisted rendering in lockstep with stream augmentation behavior.
    let augmentDiagnostics: PersistedAugmentDiagnostics | undefined;
    if (publicShare) {
      await augmentEditToolUses(session.messages);
    } else {
      const pathIndex = await tryClaimProjectPathIndex(project.path);
      try {
        augmentDiagnostics = await augmentPersistedSessionMessages(
          session.messages,
          {
            projectFileLinks: {
              projectId: effectiveProjectId,
              projectPath: project.path,
              ...(pathIndex ? { index: pathIndex } : {}),
              resolveAbsoluteFilePaths: deps.resolveAbsoluteFilePaths,
            },
          },
          { delayMs: deps.persistedAugmentDelayMs },
        );
      } finally {
        pathIndex?.release();
      }
    }
    // The overlay reassigns `session` below; hasUnreadProviderContent needs
    // the pre-overlay timestamp.
    const preRecapUpdatedAt = getEffectiveProviderUpdatedAt(
      session.updatedAt,
      process,
    );
    session = {
      ...session,
      updatedAt: preRecapUpdatedAt,
      messages: mergeLocalCommandMessages(
        session.messages,
        localCommandMessages,
        {
          hasOlderMessages: Boolean(
            (afterMessageId && !overlayCursor) ||
              paginationInfo?.hasOlderMessages ||
              loadedSession.readWindow?.omittedPrefix,
          ),
          hasNewerMessages: Boolean(beforeMessageId),
        },
      ),
    };
    if (!beforeMessageId) {
      session = applySessionOverlaysToSession(
        session,
        recapMessages,
        syntheticDoneMessages,
      );
      if (overlayCursor && afterMessageId) {
        const sliced = sliceAfterDurableOverlayCursor({
          messages: session.messages,
          overlay: overlayCursor,
          cursorId: afterMessageId,
        });
        session = { ...session, messages: sliced.messages };
        incrementalAnchorFound = sliced.found;
      }
    } else {
      session = applyRecapOverlayToSummary(session, recapMessages);
    }
    const augmentEndMs = performance.now();

    const hasUnread = hasUnreadProviderContent(
      deps.notificationService,
      sessionId,
      preRecapUpdatedAt,
    );

    // Override context usage with SDK-reported context window from live process
    // The reader uses hardcoded defaults; the process captures the real value at runtime
    let { contextUsage } = session;
    if (process?.contextWindow && contextUsage) {
      const cw = process.contextWindow;
      contextUsage = {
        ...contextUsage,
        percentage: Math.round((contextUsage.inputTokens / cw) * 100),
        contextWindow: cw,
      };
      // Durable recording happens at the observation point in Process via
      // onContextWindowObserved; this block only overrides the displayed value.
    }

    const { messages: _messages, ...sessionMetadata } = session;
    const totalMs = performance.now() - requestStartMs;
    const detailTimings = {
      augment: roundedMs(augmentEndMs - sliceEndMs),
      metadata: roundedMs(metadataMs),
      normalize: roundedMs(normalizeEndMs - readEndMs),
      project: roundedMs(projectResolvedMs - requestStartMs),
      read: roundedMs(readEndMs - projectResolvedMs),
      route: roundedMs(sliceEndMs - normalizeEndMs - metadataMs),
      total: roundedMs(totalMs),
    };
    c.header(
      "Server-Timing",
      Object.entries(detailTimings)
        .map(([name, duration]) => {
          const description =
            name === "augment" && augmentDiagnostics
              ? `;desc="messages=${augmentDiagnostics.inputMessages} changed=${augmentDiagnostics.changedMessages} cache-hit=${augmentDiagnostics.cacheHits} cache-join=${augmentDiagnostics.cacheJoins} cache-miss=${augmentDiagnostics.cacheMisses}"`
              : "";
          return `ya-${name};dur=${duration}${description}`;
        })
        .join(", "),
    );
    if (
      unboundedRequestDefaultedToCompactTail &&
      normalizedMessageCount >= LARGE_FULL_HISTORY_MESSAGE_THRESHOLD
    ) {
      getLogger().warn(
        {
          beforeMessageId: beforeMessageId ?? null,
          defaultTailCompactions: DEFAULT_SESSION_DETAIL_TAIL_COMPACTIONS,
          event: "session_detail_unbounded_defaulted_to_tail",
          normalizedMessageCount,
          projectId: effectiveProjectId,
          transcriptProjectId,
          provider: session.provider,
          publicShare,
          returnedMessageCount: session.messages.length,
          sessionId,
          timings: {
            augmentMs: roundedMs(augmentEndMs - sliceEndMs),
            metadataMs: roundedMs(metadataMs),
            normalizeMs: roundedMs(normalizeEndMs - readEndMs),
            projectMs: roundedMs(projectResolvedMs - requestStartMs),
            readMs: roundedMs(readEndMs - projectResolvedMs),
            routeMs: roundedMs(sliceEndMs - normalizeEndMs - metadataMs),
            totalMs: roundedMs(totalMs),
          },
          totalMessageCount: session.messageCount,
        },
        "SESSION_DETAIL: defaulted unbounded request to compact tail",
      );
    }
    if (
      fullHistory &&
      session.messages.length >= LARGE_FULL_HISTORY_MESSAGE_THRESHOLD
    ) {
      getLogger().warn(
        {
          event: "session_detail_full_history_large",
          fullHistoryReason: fullHistoryReason ?? null,
          normalizedMessageCount,
          projectId: effectiveProjectId,
          transcriptProjectId,
          provider: session.provider,
          publicShare,
          returnedMessageCount: session.messages.length,
          sessionId,
          timings: {
            augmentMs: roundedMs(augmentEndMs - sliceEndMs),
            metadataMs: roundedMs(metadataMs),
            normalizeMs: roundedMs(normalizeEndMs - readEndMs),
            projectMs: roundedMs(projectResolvedMs - requestStartMs),
            readMs: roundedMs(readEndMs - projectResolvedMs),
            routeMs: roundedMs(sliceEndMs - normalizeEndMs - metadataMs),
            totalMs: roundedMs(totalMs),
          },
          totalMessageCount: session.messageCount,
        },
        "SESSION_DETAIL: large explicit full-history request",
      );
    }
    if (totalMs >= SESSION_DETAIL_SLOW_LOG_MS) {
      getLogger().warn(
        {
          afterMessageId: afterMessageId ?? null,
          beforeMessageId: beforeMessageId ?? null,
          event: "session_detail_slow",
          defaultedToCompactTail,
          fullHistory,
          fullHistoryReason: fullHistoryReason ?? null,
          incrementalAnchorFound: afterMessageId
            ? incrementalAnchorFound
            : null,
          normalizedMessageCount,
          owned: Boolean(process),
          processState: process?.state.type ?? null,
          projectId: effectiveProjectId,
          transcriptProjectId,
          provider: session.provider,
          publicShare,
          returnedMessageCount: session.messages.length,
          sessionId,
          tailCompactions: effectiveTailCompactions ?? null,
          tailTurns: requestedTailTurns ?? null,
          timings: {
            augmentMs: roundedMs(augmentEndMs - sliceEndMs),
            metadataMs: roundedMs(metadataMs),
            normalizeMs: roundedMs(normalizeEndMs - readEndMs),
            projectMs: roundedMs(projectResolvedMs - requestStartMs),
            readMs: roundedMs(readEndMs - projectResolvedMs),
            routeMs: roundedMs(sliceEndMs - normalizeEndMs - metadataMs),
            totalMs: roundedMs(totalMs),
          },
          totalMessageCount: session.messageCount,
        },
        "SESSION_DETAIL: slow request",
      );
    }

    const publicShareCompletedMessageCount =
      publicShare && fullHistory
        ? completedPublicShareMessageCount({
            messages: session.messages,
            process,
            sourceIsExternal: isExternal,
            sourceUpdatedAt: session.updatedAt,
            hasDurableHistory: true,
          })
        : undefined;

    return c.json({
      session: {
        ...sessionMetadata,
        projectId: effectiveProjectId,
        nonHumanUserTurn: nonHumanUserTurnField(
          deps.sessionMetadataService,
          sessionId,
        ),
        ownership,
        contextUsage,
        customTitle: metadata?.customTitle,
        isArchived: metadata?.isArchived,
        isStarred: metadata?.isStarred,
        clearloop: deps.clearloopService?.getBadge(sessionId),
        rewindRecordIds: rewindRecordIdsFor(sessionId),
        parentSessionId: metadata?.parentSessionId ?? session.parentSessionId,
        parentSessionKind:
          metadata?.parentSessionKind ?? session.parentSessionKind,
        forkedFromSessionId:
          metadata?.forkedFromSessionId ?? session.forkedFromSessionId,
        creationProvenance: metadata?.creationProvenance,
        creation: creationStatusForSession(
          deps.sessionMetadataService,
          sessionId,
          deps.signal,
        ),
        routerBinding: metadata?.routerBinding,
        sandboxLevel: metadata?.sandboxLevel,
        sandboxNetworkFirewall: metadata?.sandboxNetworkFirewall,
        initialPrompt: metadata?.initialPrompt ?? session.fullTitle,
        nativeSessionId: storedIdentityFor(sessionId)?.native?.id,
        wakeTurnsEnabled: metadata?.wakeTurnsEnabled,
        promptSuggestionMode: metadata?.promptSuggestionMode,
        recapAfterSeconds: metadata?.recapAfterSeconds,
        workingProjectId: metadata?.workingProjectId,
        transcriptProjectId: metadata?.transcriptProjectId,
        transcriptDisplayObjects: metadata?.transcriptDisplayObjects,
        // Model comes from the session reader (extracted from JSONL)
        model: session.model,
        effectiveModelSettings: effectiveModelSettingsFromMetadata(metadata),
        effectiveLaunchSettings: metadata?.effectiveLaunchSettings,
        lastSeenAt,
        hasUnread,
        ...(providerChildren ? { providerChildren } : {}),
      },
      messages: session.messages,
      transcriptSnapshotUpdatedAt: loadedSession.transcriptSnapshotUpdatedAt,
      ownership,
      providerRuntimeStatus,
      pendingInputRequest,
      slashCommands,
      ...(publicShareCompletedMessageCount !== undefined
        ? {
            publicShareCapture: {
              completedMessageCount: publicShareCompletedMessageCount,
            },
          }
        : {}),
      ...(paginationInfo && { pagination: paginationInfo }),
      ...(deferredMessages.length > 0 ? { deferredMessages } : {}),
    });
  });
}
