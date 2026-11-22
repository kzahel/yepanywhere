import { basename, dirname } from "node:path";
import {
  nativeSessionRef,
  parseNativeSessionId,
  type ProviderName,
} from "@yep-anywhere/shared";
import type { SessionIndexService } from "../indexes/SessionIndexService.js";
import type { SessionMetadataService } from "../metadata/SessionMetadataService.js";
import type { SessionReaderFactory } from "../sessions/types.js";
import { normalizeSession } from "../sessions/normalization.js";
import type { Message } from "@yep-anywhere/shared/transcript/message";
import { selectConversationWindow } from "../sessions/conversation-window.js";
import {
  MAX_PROJECTION_INPUT_BYTES,
  MAX_PROJECTION_RECORDS,
} from "./conversation-projection.js";
import {
  createConversationSource,
  type ConversationSourceDependencies,
} from "./conversation-source.js";

/** Reuse the app's native readers; never create a second parser or index owner. */
export function createProviderConversationSource(
  deps: ConversationSourceDependencies & {
    readerFactory: SessionReaderFactory;
    metadata?: Pick<SessionMetadataService, "getMetadata">;
    sessionIndexService?: Pick<
      SessionIndexService,
      "getCachedSessionSummary" | "getSessionSummaryWithCache"
    >;
  },
) {
  return createConversationSource({
    ...deps,
    async readWindow(row, compactions, signal) {
      signal.throwIfAborted();
      if (
        row.location.kind !== "file" ||
        !["claude", "codex", "antigravity"].includes(row.catalogFamily)
      )
        throw new Error("Unsupported conversation source");
      const nativeId = row.nativeSessionId ?? row.sessionId;
      const scope =
        row.nativeStorageScope ??
        (row.catalogFamily === "claude"
          ? dirname(row.location.path)
          : undefined);
      if (!scope) throw new Error("Conversation native scope unavailable");
      const provider = (row.provider ?? row.catalogFamily) as ProviderName;
      const reader = deps.readerFactory(
        {
          id: row.projectId,
          path: row.projectPath,
          name: basename(row.projectPath),
          provider,
          sessionDir: scope,
          sessionCount: 0,
          activeOwnedCount: 0,
          activeExternalCount: 0,
          lastActivity: row.updatedAt,
        },
        nativeSessionRef(
          row.catalogFamily,
          scope,
          parseNativeSessionId(nativeId),
        ),
      );
      const rewindRecords = deps.metadata?.getMetadata(
        row.sessionId,
      )?.rewindRecords;
      // Codex reads only the compact tail when given an index summary to take
      // head-derived fields from; without one it reads the whole rollout.
      // Same hint as the session detail route (session-detail-routes.ts).
      const index = deps.sessionIndexService;
      const summaryHint =
        row.catalogFamily === "codex" && index
          ? ((await index.getCachedSessionSummary(
              scope,
              row.projectId,
              nativeId,
              reader,
              { acceptAppendedFile: true },
            )) ??
            (await index.getSessionSummaryWithCache(
              scope,
              row.projectId,
              nativeId,
              reader,
            )))
          : null;
      signal.throwIfAborted();
      const loaded = await reader.getSession(
        nativeId,
        row.projectId,
        undefined,
        {
          tailCompactions: compactions,
          rewindRecords,
          ...(summaryHint ? { summaryHint } : {}),
        },
      );
      signal.throwIfAborted();
      if (!loaded) throw new Error("Conversation native source unavailable");
      const window = selectConversationWindow(
        normalizeSession(loaded, { rewindRecords }).messages as Message[],
        {
          tailCompactions: compactions,
          maxBytes: MAX_PROJECTION_INPUT_BYTES,
          maxRecords: MAX_PROJECTION_RECORDS,
          signal,
        },
      );
      return {
        sessionId: row.sessionId,
        activity: "unknown",
        pendingRequests: [],
        ...window,
        sourceCoverage: {
          ...window.sourceCoverage,
          complete: loaded.transcriptComplete ?? window.sourceCoverage.complete,
          earlierOutsideScope: loaded.readWindow?.omittedPrefix
            ? "yes"
            : window.sourceCoverage.earlierOutsideScope,
        },
      };
    },
  });
}
