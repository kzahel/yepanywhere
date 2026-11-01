import { stat } from "node:fs/promises";
import type {
  NativeSessionRef,
  ProviderName,
  UrlProjectId,
  YaSessionId,
} from "@yep-anywhere/shared";
import type { ISessionIndexService } from "../indexes/types.js";
import { SourceVersionedSingleFlight } from "../lib/sourceVersionedSingleFlight.js";
import type { Project } from "../supervisor/types.js";
import type {
  GetSessionOptions,
  LoadedSession,
  SessionReaderFactory,
} from "./types.js";

interface BoundSessionRead {
  sessionId: YaSessionId;
  provider: ProviderName;
  native: NativeSessionRef;
  transcriptProject: Project;
  projectId: UrlProjectId;
  afterMessageId?: string;
  options?: GetSessionOptions;
}

/** Native readers belong to the incumbent bounded app pool, never a request. */
export class BoundSessionReads {
  // Only active native reads are tracked; no completed transcript is retained.
  private readonly reads = new SourceVersionedSingleFlight<
    string,
    LoadedSession | null
  >({
    maxRetainedBytes: 0,
    estimateBytes: () => 0,
    shouldRetain: () => false,
    acceptUnretainedWhenStale: true,
  });

  constructor(
    private readonly deps: {
      readerFactory: SessionReaderFactory;
      sessionIndexService?: Pick<
        ISessionIndexService,
        "getCachedSessionSummary"
      >;
    },
  ) {}

  async read(input: BoundSessionRead): Promise<LoadedSession | null> {
    const reader = this.deps.readerFactory(
      { ...input.transcriptProject, provider: input.provider },
      input.native,
    );
    const summaryHint =
      input.native.family === "codex" &&
      input.options?.tailCompactions !== undefined &&
      this.deps.sessionIndexService
        ? await this.deps.sessionIndexService.getCachedSessionSummary(
            input.native.storageScope,
            input.projectId,
            input.native.id,
            reader,
            { acceptAppendedFile: true },
          )
        : null;
    const options = summaryHint
      ? { ...input.options, summaryHint }
      : input.options;
    const filePath = await reader.getSessionFilePath?.(input.native.id);
    const observed = filePath ? await stat(filePath).catch(() => null) : null;
    if (!observed || !filePath) return null;
    const sourceVersion = (value: {
      size: number;
      mtimeMs: number;
      ctimeMs: number;
    }) => `${value.size}:${value.mtimeMs}:${value.ctimeMs}`;
    const result = await this.reads.run({
      key: JSON.stringify([
        input.native.family,
        input.native.storageScope,
        input.native.id,
        filePath,
        input.projectId,
        input.afterMessageId,
        options,
      ]),
      sourceVersion: sourceVersion(observed),
      compute: () =>
        reader.getSession(
          input.native.id,
          input.projectId,
          input.afterMessageId,
          options,
        ),
      isCurrent: async (version) => {
        const current = await stat(filePath).catch(() => null);
        return current !== null && sourceVersion(current) === version;
      },
    });
    const loaded = result.status === "stale" ? null : result.value;
    return loaded
      ? {
          ...loaded,
          summary: {
            ...loaded.summary,
            id: input.sessionId,
            provider: input.provider,
          },
        }
      : null;
  }
}
