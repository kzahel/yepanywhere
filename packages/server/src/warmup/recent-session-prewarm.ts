import type { UrlProjectId } from "@yep-anywhere/shared";
import type { Project } from "../supervisor/types.js";
import type { RecentEntry } from "../recents/RecentsService.js";
import { sliceAtCompactBoundaries } from "../sessions/pagination.js";
import { augmentPersistedSessionMessages } from "../sessions/persisted-augments.js";
import {
  buildPersistedSessionResponseCacheKey,
  primePersistedSessionResponse,
} from "../sessions/persisted-response-cache.js";
import type { ProviderResolutionDeps } from "../sessions/provider-resolution.js";
import { findLoadedSessionAcrossProviders } from "../sessions/provider-resolution.js";
import { normalizeSession } from "../sessions/normalization.js";

export interface RecentSessionPrewarmDeps {
  resolveProject: (projectId: UrlProjectId) => Promise<Project | null>;
  providerDeps: ProviderResolutionDeps;
  recentEntries: RecentEntry[];
  limit?: number;
}

export async function prewarmRecentSessions(
  deps: RecentSessionPrewarmDeps,
): Promise<void> {
  if (deps.recentEntries.length === 0) {
    return;
  }

  const seenSessionIds = new Set<string>();
  const limit = Math.max(0, deps.limit ?? 10);

  for (const entry of deps.recentEntries) {
    if (seenSessionIds.size >= limit) {
      break;
    }
    if (seenSessionIds.has(entry.sessionId)) {
      continue;
    }

    const projectId = entry.projectId as UrlProjectId;
    const project = await deps.resolveProject(projectId);
    if (!project) {
      continue;
    }

    seenSessionIds.add(entry.sessionId);
    try {
      const loaded = await findLoadedSessionAcrossProviders(
        project,
        entry.sessionId,
        projectId,
        deps.providerDeps,
      );
      if (!loaded) {
        continue;
      }

      // 预热与会话页首屏一致的正文链路，避免用户首开时再付出渲染初始化成本。
      const normalized = normalizeSession(loaded.loaded);
      const sliced = sliceAtCompactBoundaries(normalized.messages, 1, undefined, 300);
      await augmentPersistedSessionMessages(sliced.messages);
      primePersistedSessionResponse(
        buildPersistedSessionResponseCacheKey({
          projectId,
          sessionId: entry.sessionId,
          provider: loaded.loaded.summary.provider,
          updatedAt: loaded.loaded.summary.updatedAt,
          messageCount: loaded.loaded.summary.messageCount,
          tailCompactions: 1,
          maxMessages: 300,
        }),
        {
          session: { ...normalized, messages: sliced.messages },
          messages: sliced.messages,
          pagination: sliced.pagination,
        },
      );
    } catch {
      // Best-effort prewarm only.
    }
  }
}
