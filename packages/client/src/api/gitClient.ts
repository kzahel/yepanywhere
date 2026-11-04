import type {
  GitBlameResult,
  GitCommitDetail,
  GitCommitListResult,
  GitCommitSearchManifest,
  GitCommitSearchRecordsResult,
  GitDiffResult,
  GitFileDiffMode,
  GitFileProjectionManifest,
  GitFileRevision,
  GitIncomingCommitListResult,
  GitInclusiveRevisionComparison,
  GitIntegrationOptionsResult,
  GitPullResult,
  GitPushResult,
  GitRemoteCheckResult,
  GitRevisionComparison,
  GitSearchResult,
  GitStatusInfo,
  GitUntrackedFileListResult,
  GitUntrackedFolderInfo,
  GitWorkingTreeFileListResult,
  GitWorktreeCoverage,
} from "@yep-anywhere/shared";
import { fetchJSON } from "./sourceApiFetch";

export const gitApi = {
  getGitStatus: (
    projectId: string,
    options: {
      omitUntracked?: boolean;
      useUntrackedCache?: boolean;
      /** Skip the server's few-second shared read; older servers ignore it. */
      fresh?: boolean;
    } = {},
  ) => {
    const query = new URLSearchParams();
    if (options.useUntrackedCache) query.set("untracked", "cache");
    else if (options.omitUntracked) query.set("untracked", "none");
    if (options.fresh) query.set("fresh", "1");
    const suffix = query.size > 0 ? `?${query.toString()}` : "";
    return fetchJSON<GitStatusInfo>(`/projects/${projectId}/git${suffix}`);
  },

  getGitUntrackedFolder: (projectId: string, path: string) =>
    fetchJSON<GitUntrackedFolderInfo>(
      `/projects/${projectId}/git/untracked-folder?path=${encodeURIComponent(path)}`,
    ),

  listGitUntrackedFiles: (
    projectId: string,
    params: { path?: string; q?: string } = {},
  ) => {
    const query = new URLSearchParams();
    if (params.path) query.set("path", params.path);
    if (params.q) query.set("q", params.q);
    const suffix = query.size > 0 ? `?${query.toString()}` : "";
    return fetchJSON<GitUntrackedFileListResult>(
      `/projects/${projectId}/git/untracked-files${suffix}`,
    );
  },

  checkGitRemote: (projectId: string) =>
    fetchJSON<GitRemoteCheckResult>(`/projects/${projectId}/git/check-remote`, {
      method: "POST",
    }),

  getGitIncomingCommits: (projectId: string) =>
    fetchJSON<GitIncomingCommitListResult>(
      `/projects/${projectId}/git/incoming-commits`,
    ),

  getGitIntegrationOptions: (projectId: string) =>
    fetchJSON<GitIntegrationOptionsResult>(
      `/projects/${projectId}/git/integration-options`,
    ),

  pullGit: (projectId: string) =>
    fetchJSON<GitPullResult>(`/projects/${projectId}/git/pull`, {
      method: "POST",
    }),

  pushGit: (projectId: string) =>
    fetchJSON<GitPushResult>(`/projects/${projectId}/git/push`, {
      method: "POST",
    }),

  getGitDiff: (
    projectId: string,
    params: {
      path: string;
      staged: boolean;
      status: string;
      /** Compare HEAD directly to the filesystem for the synthetic history entry. */
      againstHead?: boolean;
      origPath?: string;
      fullContext?: boolean;
      ignoreWhitespace?: boolean;
    },
  ) =>
    fetchJSON<GitDiffResult>(`/projects/${projectId}/git/diff`, {
      method: "POST",
      body: JSON.stringify(params),
    }),

  // Stage-3 commit browser (topic: source-review-to-session).
  getGitCommits: (
    projectId: string,
    params?: { limit?: number; skip?: number },
  ) => {
    const query = new URLSearchParams();
    if (params?.limit !== undefined) query.set("limit", String(params.limit));
    if (params?.skip !== undefined) query.set("skip", String(params.skip));
    const suffix = query.toString() ? `?${query.toString()}` : "";
    return fetchJSON<GitCommitListResult>(
      `/projects/${projectId}/git/commits${suffix}`,
    );
  },

  getGitCommit: (projectId: string, sha: string) =>
    fetchJSON<GitCommitDetail>(
      `/projects/${projectId}/git/commit/${encodeURIComponent(sha)}`,
    ),

  getGitCommitSearchManifest: (projectId: string) =>
    fetchJSON<GitCommitSearchManifest>(
      `/projects/${projectId}/git/commit-search-manifest`,
    ),

  getGitCommitSearchRecords: (projectId: string, shas: string[]) =>
    fetchJSON<GitCommitSearchRecordsResult>(
      `/projects/${projectId}/git/commit-search-records`,
      {
        method: "POST",
        body: JSON.stringify({ shas }),
      },
    ),

  getGitCommitDiff: (
    projectId: string,
    params: {
      sha: string;
      path: string;
      status: string;
      origPath?: string;
      fullContext?: boolean;
      ignoreWhitespace?: boolean;
    },
  ) =>
    fetchJSON<GitDiffResult>(`/projects/${projectId}/git/commit-diff`, {
      method: "POST",
      body: JSON.stringify(params),
    }),

  getGitComparison: (projectId: string, sha: string) =>
    fetchJSON<GitRevisionComparison>(
      `/projects/${projectId}/git/compare/${encodeURIComponent(sha)}`,
    ),

  getGitInclusiveComparison: (projectId: string, sha: string) =>
    fetchJSON<GitInclusiveRevisionComparison>(
      `/projects/${projectId}/git/range-to-head/${encodeURIComponent(sha)}`,
    ),

  getGitComparisonDiff: (
    projectId: string,
    params: {
      baseSha: string;
      headSha: string;
      path: string;
      status: string;
      origPath?: string;
      fullContext?: boolean;
      ignoreWhitespace?: boolean;
    },
  ) =>
    fetchJSON<GitDiffResult>(`/projects/${projectId}/git/compare-diff`, {
      method: "POST",
      body: JSON.stringify(params),
    }),

  getGitInclusiveComparisonDiff: (
    projectId: string,
    params: {
      baseSha: string;
      headSha: string;
      path: string;
      status: string;
      origPath?: string;
      fullContext?: boolean;
      ignoreWhitespace?: boolean;
    },
  ) =>
    fetchJSON<GitDiffResult>(`/projects/${projectId}/git/range-to-head-diff`, {
      method: "POST",
      body: JSON.stringify(params),
    }),

  getGitFileProjections: (projectId: string) =>
    fetchJSON<GitFileProjectionManifest>(
      `/projects/${projectId}/git/file-projections`,
    ),

  getGitFileRevision: (
    projectId: string,
    params: { path: string; rev?: string; origPath?: string },
  ) => {
    const query = new URLSearchParams({ path: params.path });
    if (params.rev) query.set("rev", params.rev);
    if (params.origPath) query.set("origPath", params.origPath);
    return fetchJSON<GitFileRevision>(
      `/projects/${projectId}/git/file-revision?${query.toString()}`,
    );
  },

  getGitFileProjectionDiff: (
    projectId: string,
    params: {
      path: string;
      mode: GitFileDiffMode;
      origPath?: string;
      fullContext?: boolean;
    },
  ) =>
    fetchJSON<GitDiffResult>(
      `/projects/${projectId}/git/file-projection-diff`,
      {
        method: "POST",
        body: JSON.stringify(params),
      },
    ),

  getGitBlame: (projectId: string, path: string, rev?: string) => {
    const query = new URLSearchParams({ path });
    if (rev) query.set("rev", rev);
    return fetchJSON<GitBlameResult>(
      `/projects/${projectId}/git/blame?${query.toString()}`,
    );
  },

  listGitWorkingTreeFiles: (
    projectId: string,
    coverage?: GitWorktreeCoverage,
    /** Browse this allowed absolute path instead of the project. */
    root?: string,
  ) => {
    const query = new URLSearchParams();
    if (root !== undefined) query.set("root", root);
    if (coverage) {
      query.set("tracked", String(coverage.tracked));
      query.set("untracked", String(coverage.untracked));
      query.set("ignored", String(coverage.ignored));
    }
    const suffix = query.size > 0 ? `?${query.toString()}` : "";
    return fetchJSON<GitWorkingTreeFileListResult>(
      `/projects/${projectId}/git/working-tree-files${suffix}`,
    );
  },

  searchGit: (
    projectId: string,
    params: { q: string; kind: "filename" | "delta"; limit?: number },
  ) => {
    const query = new URLSearchParams({ q: params.q, kind: params.kind });
    if (params.limit !== undefined) query.set("limit", String(params.limit));
    return fetchJSON<GitSearchResult>(
      `/projects/${projectId}/git/search?${query.toString()}`,
    );
  },
};
