import { realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, sep } from "node:path";
import {
  isYaSessionId,
  nativeSessionRef,
  parseNativeSessionId,
  parseYaSessionId,
  toUrlProjectId,
  type UrlProjectId,
} from "@yep-anywhere/shared";
import type { SessionMetadataService } from "../metadata/SessionMetadataService.js";
import { readCwdFromSessionFile } from "../projects/paths.js";
import type { ProjectScanner } from "../projects/scanner.js";
import { readClaudeCatalogHead } from "../sessions/claude-summary.js";
import { readCodexRolloutMetadata } from "../sessions/codex-discovery.js";
import type { SessionReaderFactory } from "../sessions/types.js";
import type { ExternalSessionTrackerOptions } from "./ExternalSessionTracker.js";

/**
 * Translates a native file event into the public session it belongs to,
 * before Supervisor ownership and external-decay joins
 * (topics/session-ownership.md#native-file-ingress-and-ya-ownership).
 * `undefined` keeps the tracker's legacy path; `null` is not evidence.
 */
export function createObservedSessionResolver(deps: {
  sessionMetadataService?: SessionMetadataService;
  scanner: ProjectScanner;
  readerFactory: SessionReaderFactory;
  codexSessionsDir: string;
  getCodexDiscoveryIndex: (
    sessionsDir: string,
  ) => Parameters<typeof readCodexRolloutMetadata>[0]["discoveryIndex"];
}): NonNullable<ExternalSessionTrackerOptions["resolveObservedSession"]> {
  const { scanner, readerFactory, codexSessionsDir, getCodexDiscoveryIndex } =
    deps;
  const options = { sessionMetadataService: deps.sessionMetadataService };
  return async (event, signal) => {
    if (event.provider !== "claude" && event.provider !== "codex")
      return undefined;
    if (event.fileType !== "session" || event.changeType === "delete")
      return null;
    const file = await realpath(event.path).catch(() => null);
    if (!file || signal.aborted) return null;
    const scope =
      event.provider === "claude"
        ? dirname(file)
        : await realpath(event.nativeStorageScope ?? codexSessionsDir).catch(
            () => null,
          );
    if (!scope || signal.aborted) return null;
    if (event.provider === "codex") {
      const suffix = relative(scope, file);
      if (
        !suffix ||
        suffix === ".." ||
        suffix.startsWith(`..${sep}`) ||
        isAbsolute(suffix)
      )
        return null;
    }
    const meta =
      event.provider === "codex"
        ? await readCodexRolloutMetadata({
            sessionsDir: scope,
            filePath: file,
            discoveryIndex: getCodexDiscoveryIndex(scope),
          })
        : undefined;
    if (event.provider === "codex" && (!meta || meta.isSubagent)) return null;
    const filename = basename(file);
    const nativeId =
      meta?.id ??
      (filename.endsWith(".jsonl") && !filename.startsWith("agent-")
        ? filename.slice(0, -6)
        : undefined);
    if (!nativeId || !isYaSessionId(nativeId) || signal.aborted) return null;
    const native = nativeSessionRef(
      event.provider,
      scope,
      parseNativeSessionId(nativeId),
    );
    const identities = options.sessionMetadataService?.identities;
    if (!identities) return undefined;
    let identity = identities.lookupNative(native);
    if (!identity && !identities.canDiscoverNative(native)) return null;
    let discoveredProjectId: UrlProjectId | undefined;
    if (!identity) {
      if (identities.resolveYa(parseYaSessionId(nativeId))) return null;
      // Explicit native discovery, using bounded physical source
      // evidence before a legacy public id can enter ownership joins.
      const cwd = meta?.cwd ?? (await readCwdFromSessionFile(file));
      if (!cwd || !isAbsolute(cwd) || signal.aborted) return null;
      discoveredProjectId = toUrlProjectId(cwd);
    }
    const project = await scanner.getOrCreateProject(
      identity?.projectId ?? discoveredProjectId!,
    );
    if (!project || signal.aborted) return null;
    const reader = readerFactory(
      { ...project, provider: identity?.provider ?? event.provider },
      native,
    );
    if (
      reader.observeNativeSessionFile &&
      !(await reader.observeNativeSessionFile(native, file, signal))
    )
      return null;
    if (signal.aborted) return null;
    const selectedFile = await reader.getSessionFilePath?.(native.id);
    if (signal.aborted || !selectedFile) return null;
    const selectedPath = await realpath(selectedFile).catch(() => null);
    if (signal.aborted || selectedPath !== file) return null;
    if (!identity) {
      const createdAt =
        meta?.timestamp ??
        (await readClaudeCatalogHead(file)).createdAt ??
        event.timestamp;
      if (signal.aborted) return null;
      identity = identities.adoptDiscoveredBatch([
        {
          native,
          provider: event.provider,
          legacyProvider: options.sessionMetadataService?.getProvider(nativeId),
          projectId: project.id,
          createdAt,
        },
      ])[0];
      if (!identity) return null;
    }
    return {
      sessionId: identity.sessionId,
      provider: identity.provider,
      projectId:
        options.sessionMetadataService?.getMetadata(identity.sessionId)
          ?.workingProjectId ?? identity.projectId,
    };
  };
}
