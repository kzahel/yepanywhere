import {
  type ProviderName,
  type UrlProjectId,
  isUrlProjectId,
} from "@yep-anywhere/shared";
import type { SessionMetadataService } from "../metadata/SessionMetadataService.js";
import { encodeProjectId } from "../projects/paths.js";
import type { ProjectScanner } from "../projects/scanner.js";
import { GrokSessionReader } from "../sessions/grok-reader.js";
import { findSessionListSummaryAcrossProviders } from "../sessions/provider-resolution.js";
import { creationStatusForSession } from "../sessions/session-creation-view.js";
import type {
  SessionIdentity,
  SessionIdentityLookup,
} from "../sessions/SessionIdentityStore.js";
import type { Supervisor } from "../supervisor/Supervisor.js";
import type { Project } from "../supervisor/types.js";
import {
  type SessionProviderResolutionDeps,
  providerResolutionDeps,
} from "./session-provider-resolution.js";

/**
 * Decide whether a session request made under `requestProjectId` should be
 * redirected to a different canonical project.
 *
 * Two things can claim a session's canonical project:
 *  - an explicit `workingProjectId` pin (persisted metadata, set e.g. by the
 *    "move session to project" action), and
 *  - the project a live process is currently running the session under.
 *
 * The pin wins. When a pin is present we route to it and, once the request is
 * already AT the pin, we stop — we do NOT bounce to a live process running
 * under some other project. That bounce is what produced an infinite redirect
 * loop: with pin=A and an active process under B, a request for A redirected to
 * B (process rule), and a request for B redirected back to A (pin rule), so the
 * client ping-ponged forever and the session was unviewable. Only when there is
 * no pin does an active process's project become canonical (the session is
 * genuinely owned there).
 */
export function resolveCanonicalProjectRedirect(params: {
  requestProjectId: UrlProjectId;
  workingProjectId: UrlProjectId | undefined;
  activeProcessProjectId: string | undefined;
}): UrlProjectId | null {
  const { requestProjectId, workingProjectId, activeProcessProjectId } = params;

  if (workingProjectId) {
    return workingProjectId === requestProjectId ? null : workingProjectId;
  }

  if (
    typeof activeProcessProjectId === "string" &&
    isUrlProjectId(activeProcessProjectId) &&
    activeProcessProjectId !== requestProjectId
  ) {
    return activeProcessProjectId;
  }

  return null;
}

export interface SessionProjectRoutingDeps
  extends SessionProviderResolutionDeps {
  supervisor: Pick<Supervisor, "getProcessForSession">;
  scanner: Pick<ProjectScanner, "getOrCreateProject">;
  sessionMetadataService?: SessionMetadataService;
}

/**
 * The per-factory project-routing closures shared by the session-detail
 * reads and preview refresh. Called once per sessions route factory, so the
 * lazily created unscoped Grok reader is one instance per factory call.
 */
export function createSessionProjectRouting(
  deps: SessionProjectRoutingDeps,
  storedIdentityFor: (sessionId: string) => SessionIdentity | undefined,
) {
  let unscopedGrokReader: GrokSessionReader | null | undefined;
  const getUnscopedGrokReader = (): GrokSessionReader | null => {
    if (unscopedGrokReader !== undefined) {
      return unscopedGrokReader;
    }
    unscopedGrokReader = deps.grokSessionsDir
      ? new GrokSessionReader({ sessionsDir: deps.grokSessionsDir })
      : null;
    return unscopedGrokReader;
  };

  const getGrokNativeProjectId = async (
    sessionId: string,
    currentProjectId: UrlProjectId,
  ): Promise<UrlProjectId | null> => {
    const reader = getUnscopedGrokReader();
    if (!reader) {
      return null;
    }
    const projectPath = await reader.getSessionProjectPath(sessionId);
    if (!projectPath) {
      return null;
    }
    const canonicalProjectId = encodeProjectId(projectPath);
    return canonicalProjectId === currentProjectId ? null : canonicalProjectId;
  };

  const buildGrokNativeRedirectPath = (
    canonicalProjectId: UrlProjectId,
    sessionId: string,
    suffix: "" | "/metadata",
    requestUrl: string,
  ): string => {
    const search = new URL(requestUrl).search;
    return `/api/projects/${canonicalProjectId}/sessions/${encodeURIComponent(
      sessionId,
    )}${suffix}${search}`;
  };

  const buildSessionProjectRedirectPath = (
    canonicalProjectId: UrlProjectId,
    sessionId: string,
    suffix: string,
    requestUrl: string,
  ): string => {
    const search = new URL(requestUrl).search;
    return `/api/projects/${canonicalProjectId}/sessions/${encodeURIComponent(
      sessionId,
    )}${suffix}${search}`;
  };

  const resolveSessionProjectRouting = async (
    requestProjectId: UrlProjectId,
    sessionId: string,
  ): Promise<
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
      }
  > => {
    const identity = storedIdentityFor(sessionId);
    if (
      deps.signal?.aborted ||
      (identity &&
        creationStatusForSession(
          deps.sessionMetadataService,
          identity.sessionId,
          deps.signal,
        )?.state === "deleted")
    ) {
      return { error: "Session not found", status: 404 };
    }
    const workingProjectId =
      deps.sessionMetadataService?.getMetadata(sessionId)?.workingProjectId;
    const activeProcess = deps.supervisor.getProcessForSession(sessionId);
    const redirectProjectId = resolveCanonicalProjectRedirect({
      requestProjectId,
      workingProjectId,
      activeProcessProjectId:
        typeof activeProcess?.projectId === "string"
          ? activeProcess.projectId
          : identity?.projectId,
    });
    if (redirectProjectId) {
      return { redirectProjectId };
    }

    const workingProject =
      await deps.scanner.getOrCreateProject(requestProjectId);
    if (!workingProject) {
      return { error: "Project not found", status: 404 };
    }

    if (identity) {
      const transcriptProject =
        identity.projectId === requestProjectId
          ? workingProject
          : await deps.scanner.getOrCreateProject(identity.projectId);
      return transcriptProject
        ? {
            transcriptProject,
            transcriptProjectId: identity.projectId,
            identityLookup: { kind: "stored", identity },
            workingProject,
            workingProjectId: requestProjectId,
          }
        : { error: "Project not found", status: 404 };
    }

    const metadata = deps.sessionMetadataService?.getMetadata(sessionId);
    const overlayTranscriptProjectId =
      metadata?.workingProjectId === requestProjectId &&
      metadata.transcriptProjectId &&
      metadata.transcriptProjectId !== requestProjectId
        ? metadata.transcriptProjectId
        : undefined;

    // Default: the transcript lives under the working (request) project.
    let transcriptProjectId: UrlProjectId = requestProjectId;
    let transcriptProject: Project = workingProject;

    // Overlay case (session "moved" to a different working project): the
    // transcript may live under a distinct project. Trust the recorded pointer
    // only if the transcript is actually findable there — a stale/wrong pointer
    // must not permanently brick viewing, so fall back to the working project.
    if (overlayTranscriptProjectId) {
      const overlayProject = await deps.scanner.getOrCreateProject(
        overlayTranscriptProjectId,
      );
      const overlayHasTranscript = overlayProject
        ? Boolean(
            await findSessionListSummaryAcrossProviders(
              overlayProject,
              sessionId,
              overlayTranscriptProjectId,
              providerResolutionDeps(deps),
              deps.sessionMetadataService?.getProvider(sessionId) as
                | ProviderName
                | undefined,
            ),
          )
        : false;
      if (overlayProject && overlayHasTranscript) {
        transcriptProjectId = overlayTranscriptProjectId;
        transcriptProject = overlayProject;
      }
    }

    return {
      transcriptProject,
      transcriptProjectId,
      identityLookup: { kind: "legacy" },
      workingProject,
      workingProjectId: requestProjectId,
    };
  };

  return {
    getGrokNativeProjectId,
    buildGrokNativeRedirectPath,
    buildSessionProjectRedirectPath,
    resolveSessionProjectRouting,
  };
}
