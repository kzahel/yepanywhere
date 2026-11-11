import { SERVER_CAPABILITIES } from "@yep-anywhere/shared";
import { useCollectionUpdates } from "./useCollectionUpdates";
import {
  collectionQueryIsLive,
  pauseCollectionUpdates,
} from "../lib/collectionUpdates";
import type { ProjectsResponse } from "../api/projectsClient";
import { useEffect, useMemo } from "react";
import { api } from "../api/client";
import { createProjectsApi } from "../api/projectsClient";
import { catalogLoadState } from "../lib/clientSummaryCollections";
import { createProjectsQuery } from "../lib/projectsQuery";
import { useOptionalRemoteConnection } from "../contexts/RemoteConnectionContext";
import { useCurrentSourceRuntime } from "../contexts/SourceRuntimeContext";
import {
  activityBus,
  type ProcessStateEvent,
  type SessionCreatedEvent,
  type SessionStatusEvent,
} from "../lib/activityBus";
import {
  createClientQueryKey,
  ensureClientQuery,
} from "../lib/clientQueryController";
import {
  useProjectCollectionRecord,
  useProjectCollectionRecords,
  useProjectCollectionCatalog,
  LOCAL_CLIENT_SUMMARY_SOURCE_KEY,
} from "../lib/clientSummaryStore";
import {
  getSourceRuntimeRegistry,
  type YaSourceRuntime,
} from "../lib/sourceRuntime";
import { isRemoteClient } from "../lib/connection";
import type { ClientQueryBootstrapTier } from "../lib/clientQueryBootstrap";
import { useRetainedClientQuery } from "./useRetainedClientQuery";

const PROJECTS_REVALIDATE_EVENTS = [
  "refresh",
  "reconnect",
  "process-state-changed",
  "session-status-changed",
  "session-created",
  "project-code-names-changed",
  "project-captions-changed",
  "projects-changed",
] as const;

type ProjectResponse = Awaited<ReturnType<typeof api.getProject>>;
interface ProjectQueryMeta {
  projectId: string | undefined;
}

function useRemoteReady(): boolean {
  const remoteConnection = useOptionalRemoteConnection();
  return (
    !isRemoteClient() ||
    (remoteConnection !== null && remoteConnection.connection !== null)
  );
}

/**
 * Fetch a single project by ID.
 */
export function useProject(projectId: string | undefined) {
  const runtime = useCurrentSourceRuntime();
  const sourceKey = runtime.sourceKey;
  const sourceSummary = runtime.summary;
  const project = useProjectCollectionRecord(projectId) ?? null;
  const ready = useRemoteReady();
  const queryKey = useMemo(
    () =>
      createClientQueryKey({
        endpoint: "project",
        projectId: projectId ?? null,
      }),
    [projectId],
  );
  const enabled = Boolean(projectId);

  const { loading, error, scheduleRevalidation } =
    useRetainedClientQuery<ProjectResponse>({
      sourceKey,
      key: queryKey,
      // The selected project is one of the facts the route needs to paint.
      bootstrapTier: "route",
      enabled,
      ready,
      hasData: project !== null,
      meta: { projectId },
      revalidateOn: ["refresh", "reconnect"],
      fetcher: (context) => {
        const requestProjectId = (context.meta as ProjectQueryMeta | undefined)
          ?.projectId;
        if (!requestProjectId) {
          throw new Error("Project id is required");
        }
        return api.getProject(requestProjectId);
      },
      applySnapshot: (data, context) => {
        sourceSummary.reportProjectCollectionSnapshot(
          { project: data.project },
          context.requestStartedAt,
        );
      },
    });

  useEffect(() => {
    if (!projectId) {
      return undefined;
    }

    const maybeRefresh = (
      event: ProcessStateEvent | SessionStatusEvent | SessionCreatedEvent,
    ) => {
      const changedProjectId =
        "session" in event ? event.session.projectId : event.projectId;
      if (changedProjectId === projectId) {
        scheduleRevalidation();
      }
    };

    const unsubscribeProcess = activityBus.on(
      "process-state-changed",
      maybeRefresh,
    );
    const unsubscribeStatus = activityBus.on(
      "session-status-changed",
      maybeRefresh,
    );
    const unsubscribeCreated = activityBus.on("session-created", maybeRefresh);
    const unsubscribeCodeNames = activityBus.on(
      "project-code-names-changed",
      (event) => {
        if (event.projectIds.includes(projectId)) {
          scheduleRevalidation();
        }
      },
    );

    const unsubscribeCaptions = activityBus.on(
      "project-captions-changed",
      (event) => {
        if (event.projectIds.includes(projectId)) {
          scheduleRevalidation();
        }
      },
    );
    const unsubscribeProjects = activityBus.on("projects-changed", (event) => {
      if (event.projectIds.includes(projectId)) {
        scheduleRevalidation();
      }
    });

    return () => {
      unsubscribeProcess();
      unsubscribeStatus();
      unsubscribeCreated();
      unsubscribeCodeNames();
      unsubscribeCaptions();
      unsubscribeProjects();
    };
  }, [projectId, scheduleRevalidation]);

  return useMemo(
    () => ({ project, loading, error }),
    [project, loading, error],
  );
}

function projectsQueryForRuntime(runtime: YaSourceRuntime) {
  const projectsApi = createProjectsApi(
    runtime.transport.fetch.bind(runtime.transport),
  );
  return createProjectsQuery(runtime.sourceKey, projectsApi.getProjects);
}

export function primeLocalProjects() {
  return ensureClientQuery(
    projectsQueryForRuntime(
      getSourceRuntimeRegistry().getOrCreateSourceRuntime(
        LOCAL_CLIENT_SUMMARY_SOURCE_KEY,
      ),
    ),
  );
}

export function useProjects({
  bootstrapTier = "navigation",
}: {
  bootstrapTier?: ClientQueryBootstrapTier;
} = {}) {
  const runtime = useCurrentSourceRuntime();
  const query = useMemo(() => projectsQueryForRuntime(runtime), [runtime]);
  const projects = useProjectCollectionRecords();
  const catalog = useProjectCollectionCatalog();
  const ready = useRemoteReady();
  const { loading, error, refetch } = useRetainedClientQuery({
    ...query,
    bootstrapTier,
    ready,
    hasData: projects.length > 0,
    revalidateOn: PROJECTS_REVALIDATE_EVENTS,
    shouldRevalidateEvent: () => !collectionQueryIsLive(runtime, query.key),
    fetcher: async (context) => {
      const resume = pauseCollectionUpdates(runtime, query.key);
      try {
        return await query.fetcher(context);
      } finally {
        resume();
      }
    },
  });
  const live = useCollectionUpdates<ProjectsResponse>({
    runtime,
    key: query.key,
    path: "/projects?summaryMode=retained",
    capability: SERVER_CAPABILITIES.projectCollectionUpdates.name,
    enabled: ready && projects.length <= 500,
    applySnapshot: (data, context) =>
      runtime.summary.reportProjectsCollectionSnapshot(
        data,
        context.requestStartedAt,
      ),
    fallback: () => {
      void refetch({ force: true, background: true });
    },
  });

  const status = catalogLoadState(catalog, projects.length);
  return {
    projects,
    complete: (live || !loading) && catalog?.complete !== false,
    loading: (!live && loading) || status.awaitingFirstRows,
    error: (live ? null : error) ?? status.refreshError,
    refetch,
  };
}
