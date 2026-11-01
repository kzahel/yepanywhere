import {
  isYaSessionId,
  nativeSessionFamily,
  type ProviderName,
  type UrlProjectId,
  type NativeSessionRef,
} from "@yep-anywhere/shared";
import type { SessionMetadata } from "../metadata/SessionMetadataService.js";
import type { SessionIdentityLookup } from "../sessions/SessionIdentityStore.js";
import { encodeProjectId } from "../projects/paths.js";
import type { ProjectScanner } from "../projects/scanner.js";
import {
  findNativeSessionProjectAcrossProviders,
  getSessionSources,
  getSessionSourceForProvider,
  resolveLegacySessionSource,
  findSessionListSummaryAcrossProviders,
  type ProviderResolutionDeps,
} from "../sessions/provider-resolution.js";
import type { Project } from "../supervisor/types.js";

export interface ExistingSessionIdentity {
  provider: ProviderName;
  transcriptProject: Project;
  transcriptProjectId: UrlProjectId;
  workingProject: Project;
  workingProjectId: UrlProjectId;
  source: "native" | "metadata" | "request" | "identity";
  /** Present only after explicit YA-to-native resolution, never guessed. */
  native?: NativeSessionRef;
}

export async function resolveExistingSessionIdentity(options: {
  sessionId: string;
  requestProjectId: UrlProjectId;
  preferredProvider?: ProviderName;
  requestFallbackProvider?: ProviderName;
  metadata?: SessionMetadata;
  identityLookup?: SessionIdentityLookup;
  scanner: Pick<ProjectScanner, "getOrCreateProject">;
  providerDeps: ProviderResolutionDeps;
}): Promise<ExistingSessionIdentity | null> {
  const {
    sessionId,
    requestProjectId,
    preferredProvider,
    requestFallbackProvider,
    metadata,
    scanner,
    providerDeps,
  } = options;
  if (providerDeps.signal?.aborted) return null;
  const providerPreference = preferredProvider ?? metadata?.provider;

  const storedIdentity =
    options.identityLookup?.kind === "stored"
      ? options.identityLookup.identity
      : options.identityLookup?.kind === "legacy"
        ? undefined
        : isYaSessionId(sessionId)
          ? providerDeps.identities?.resolveYa(sessionId)
          : undefined;
  if (storedIdentity) {
    const identity = storedIdentity;
    if (identity.sessionId !== sessionId || !identity.native) return null;
    const transcriptProject = await scanner.getOrCreateProject(
      identity.projectId,
    );
    if (!transcriptProject || providerDeps.signal?.aborted) return null;
    const workingProjectId = metadata?.workingProjectId ?? identity.projectId;
    const workingProject =
      workingProjectId === identity.projectId
        ? transcriptProject
        : await scanner.getOrCreateProject(workingProjectId);
    return workingProject && !providerDeps.signal?.aborted
      ? {
          provider: identity.provider,
          transcriptProject,
          transcriptProjectId: identity.projectId,
          workingProject,
          workingProjectId,
          source: "identity",
          native: identity.native,
        }
      : null;
  }

  const finish = async (
    transcriptProject: Project,
    transcriptProjectId: UrlProjectId,
    provider: ProviderName,
    source: ExistingSessionIdentity["source"],
    native?: NativeSessionRef,
  ): Promise<ExistingSessionIdentity | null> => {
    if (providerDeps.signal?.aborted) return null;
    const workingProjectId = metadata?.workingProjectId ?? transcriptProjectId;
    const workingProject =
      workingProjectId === transcriptProjectId
        ? transcriptProject
        : await scanner.getOrCreateProject(workingProjectId);
    return workingProject && !providerDeps.signal?.aborted
      ? {
          provider,
          transcriptProject,
          transcriptProjectId,
          workingProject,
          workingProjectId,
          source,
          ...(native ? { native } : {}),
        }
      : null;
  };

  const resolveNativeIdentity =
    async (): Promise<ExistingSessionIdentity | null> => {
      const native = await findNativeSessionProjectAcrossProviders(
        sessionId,
        providerDeps,
        providerPreference,
      );
      if (!native || providerDeps.signal?.aborted) return null;
      const transcriptProjectId = encodeProjectId(native.projectPath);
      const transcriptProject =
        await scanner.getOrCreateProject(transcriptProjectId);
      if (!transcriptProject || providerDeps.signal?.aborted) return null;
      const source = getSessionSourceForProvider(
        transcriptProject,
        providerDeps,
        native.provider,
      );
      const legacy = source
        ? await resolveLegacySessionSource(
            source,
            sessionId,
            transcriptProject,
            providerDeps,
          )
        : undefined;
      if (legacy === null) return null;
      return finish(
        transcriptProject,
        transcriptProjectId,
        providerPreference ?? native.provider,
        "native",
        legacy?.native,
      );
    };
  if (providerPreference) {
    const nativeIdentity = await resolveNativeIdentity();
    if (nativeIdentity) return nativeIdentity;
  }

  const candidateProjectIds = [
    metadata?.transcriptProjectId,
    requestProjectId,
  ].filter(
    (candidate, index, values): candidate is UrlProjectId =>
      candidate !== undefined && values.indexOf(candidate) === index,
  );
  for (const candidateProjectId of candidateProjectIds) {
    if (providerDeps.signal?.aborted) return null;
    const candidateProject =
      await scanner.getOrCreateProject(candidateProjectId);
    if (providerDeps.signal?.aborted) return null;
    if (!candidateProject) continue;
    const resolved = await findSessionListSummaryAcrossProviders(
      candidateProject,
      sessionId,
      candidateProjectId,
      providerDeps,
      providerPreference,
      { kind: "legacy" },
    );
    if (!resolved) continue;
    return finish(
      candidateProject,
      candidateProjectId,
      providerPreference ?? resolved.source.provider,
      candidateProjectId === metadata?.transcriptProjectId
        ? "metadata"
        : "request",
      resolved.native,
    );
  }

  if (!providerPreference) {
    const nativeIdentity = await resolveNativeIdentity();
    if (nativeIdentity) return nativeIdentity;
  }

  const nativeResolutionAvailable =
    providerPreference === "codex" || providerPreference === "codex-oss"
      ? Boolean(providerDeps.codexScanner || providerDeps.codexSessionsDir)
      : providerPreference === "grok"
        ? Boolean(providerDeps.grokSessionsDir)
        : providerPreference === "pi"
          ? Boolean(providerDeps.piSessionsDir)
          : false;
  if (providerDeps.signal?.aborted) return null;
  const fallbackProvider = providerPreference ?? requestFallbackProvider;
  if (fallbackProvider && !nativeResolutionAvailable) {
    const requestProject = await scanner.getOrCreateProject(requestProjectId);
    if (requestProject && !providerDeps.signal?.aborted) {
      let nativeRef: NativeSessionRef | undefined;
      let qualifiedNativeReader = false;
      for (const source of getSessionSources(
        requestProject,
        providerDeps,
        fallbackProvider,
      )) {
        const legacy = await resolveLegacySessionSource(
          source,
          sessionId,
          requestProject,
          providerDeps,
          // Inspect other namespaces for conflicts, but require native proof
          // only for the selected fallback provider below.
          { allowMissingNativeProof: true },
        );
        if (!legacy) return null;
        if (
          nativeSessionFamily(source.provider) ===
          nativeSessionFamily(fallbackProvider)
        ) {
          nativeRef ??= legacy.native;
          qualifiedNativeReader ||=
            source.reader.getNativeSessionRef !== undefined;
        }
      }
      // A missing public resource cannot use provider-side names/format
      // aliases as a substitute for a verified legacy native address.
      if (
        providerDeps.identities &&
        !metadata &&
        qualifiedNativeReader &&
        !nativeRef
      )
        return null;
      return finish(
        requestProject,
        requestProjectId,
        fallbackProvider,
        "request",
        nativeRef,
      );
    }
  }

  return null;
}
