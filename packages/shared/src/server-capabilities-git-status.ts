import { CAPABILITY_ID_ALLOCATIONS } from "./capability-ids.js";
import { OPTIONAL_SERVER_CAPABILITY_BIT_ALLOCATIONS } from "./server-capability-optional-bits.js";
import type { ServerCapabilityDefinition } from "./server-capability-definition.js";

export const GIT_STATUS_SERVER_CAPABILITIES = {
  localSourceBrowse: {
    id: CAPABILITY_ID_ALLOCATIONS.localSourceBrowse.id,
    name: "local-source-browse",
    kind: "permanent",
    area: "gitStatus",
    introducedIn: "0.9.4",
    advertisement: { kind: "version-implied" },
    description:
      "The working-tree file inventory accepts an allowed absolute path outside the project and browses a snapshot of its checkout or directory.",
    clientFallback:
      "Hide Open in Source Control on paths outside the project and send no root request.",
    serverContract: {
      routes: ["GET /api/projects/:projectId/git/working-tree-files"],
      requestFields: ["root"],
      responseFields: ["root"],
    },
    lifecycle: {
      kind: "permanent",
      reason:
        "Older servers ignore root and would list the session project instead of the requested directory.",
    },
  },
  gitStatus: {
    name: "git-status",
    kind: "permanent",
    area: "gitStatus",
    introducedIn: "0.6.0",
    advertisement: { kind: "version-implied" },
    description:
      "Server supports project source-control status summaries for the Source Control page and sidebar entry.",
    clientFallback: "Hide Source Control entry points.",
    serverContract: {
      routes: ["GET /api/projects/:projectId/git"],
    },
    lifecycle: {
      kind: "permanent",
      reason:
        "Source Control availability is a server feature boundary for older servers and environments without the route.",
    },
  },
  gitStatusEnhanced: {
    name: "git-status-enhanced",
    kind: "permanent",
    area: "gitStatus",
    introducedIn: "0.6.0",
    advertisement: { kind: "version-implied" },
    description:
      "Server supports the enhanced Source Control page, including file summaries, branch metadata, and recent commits.",
    clientFallback:
      "Enhanced status is baseline in current clients; repository eligibility still applies.",
    serverContract: {
      routes: [
        "GET /api/projects/:projectId/git",
        "GET /api/projects/:projectId/git/untracked-folder",
        "POST /api/projects/:projectId/git/diff",
      ],
    },
    lifecycle: {
      kind: "permanent",
      reason:
        "The fixed contract remains advertised for older clients; current clients use the supported v0.8.0 baseline.",
    },
  },
  gitStatusRemoteCheck: {
    name: "git-status-remote-check",
    kind: "permanent",
    area: "gitStatus",
    introducedIn: "0.6.0",
    advertisement: { kind: "version-implied" },
    description:
      "Server supports explicit remote fetch/check for Source Control status.",
    clientFallback:
      "Remote checks are baseline in current clients; project eligibility and action serialization still apply.",
    serverContract: {
      routes: ["POST /api/projects/:projectId/git/check-remote"],
    },
    lifecycle: {
      kind: "permanent",
      reason:
        "The fixed contract remains advertised for older clients; current clients use the supported v0.8.0 baseline.",
    },
  },
  gitStatusPull: {
    name: "git-status-pull",
    kind: "permanent",
    area: "gitStatus",
    introducedIn: "0.6.0",
    advertisement: { kind: "version-implied" },
    description: "Server supports Source Control pull actions.",
    clientFallback:
      "Pull is baseline in current clients; repository eligibility, fast-forward policy and action serialization still apply.",
    serverContract: {
      routes: ["POST /api/projects/:projectId/git/pull"],
    },
    lifecycle: {
      kind: "permanent",
      reason:
        "The fixed contract remains advertised for older clients; current clients use the supported v0.8.0 baseline.",
    },
  },
  gitStatusPush: {
    name: "git-status-push",
    kind: "permanent",
    area: "gitStatus",
    introducedIn: "0.6.0",
    advertisement: { kind: "version-implied" },
    description: "Server supports Source Control push/publish actions.",
    clientFallback:
      "Push is baseline in current clients; repository eligibility, explicit action and serialization still apply.",
    serverContract: {
      routes: ["POST /api/projects/:projectId/git/push"],
    },
    lifecycle: {
      kind: "permanent",
      reason:
        "The fixed contract remains advertised for older clients; current clients use the supported v0.8.0 baseline.",
    },
  },
  gitStatusIntegrationOptions: {
    name: "git-status-integration-options",
    kind: "permanent",
    area: "gitStatus",
    introducedIn: "0.6.0",
    advertisement: { kind: "version-implied" },
    description:
      "Server supports read-only Source Control integration-option analysis for diverged branches.",
    clientFallback:
      "Integration options are baseline in current clients and load only following a diverged result.",
    serverContract: {
      routes: ["GET /api/projects/:projectId/git/integration-options"],
    },
    lifecycle: {
      kind: "permanent",
      reason:
        "The fixed contract remains advertised for older clients; current clients use the supported v0.8.0 baseline.",
    },
  },
  gitDirtyFileEditor: {
    id: CAPABILITY_ID_ALLOCATIONS.gitDirtyFileEditor.id,
    name: "git-dirty-file-editor",
    kind: "permanent",
    area: "gitStatus",
    introducedIn: "0.7.1",
    advertisement: { kind: "version-implied" },
    description:
      "Server reports the last YA session observed editing each still-dirty Source Control path.",
    clientFallback:
      "Current clients assume this v0.8.0 baseline contract; older servers should update or use their bundled client. Settings, permissions, source readiness and runtime availability still apply.",
    serverContract: {
      routes: [
        "GET /api/projects/:projectId/git",
        "GET /api/projects/:projectId/git/untracked-folder",
      ],
      responseFields: ["files[].lastEditor", "lastEditors"],
    },
    lifecycle: {
      kind: "permanent",
      reason:
        "Hosted clients can outpace installed servers, and older status responses do not carry editor attribution.",
    },
  },
  gitSourceReview: {
    id: CAPABILITY_ID_ALLOCATIONS.gitSourceReview.id,
    name: "git-source-review",
    kind: "permanent",
    area: "gitStatus",
    introducedIn: "0.7.1",
    advertisement: { kind: "version-implied" },
    description:
      "Server supports the commit/file browser and server-owned source-review workflow.",
    clientFallback:
      "Current clients assume this v0.8.0 baseline contract; older servers should update or use their bundled client. Settings, permissions, source readiness and runtime availability still apply.",
    serverContract: {
      routes: [
        "GET /api/projects/:projectId/git/commits",
        "GET /api/projects/:projectId/git/commit-search-manifest",
        "POST /api/projects/:projectId/git/commit-search-records",
        "GET /api/projects/:projectId/git/commit/:sha",
        "POST /api/projects/:projectId/git/commit-diff",
        "GET /api/projects/:projectId/git/blame",
        "GET /api/projects/:projectId/git/files",
        "GET /api/projects/:projectId/git/search",
        "GET /api/projects/:projectId/review/comments",
        "POST /api/projects/:projectId/review/comments",
        "PATCH /api/projects/:projectId/review/comments/:commentId",
        "DELETE /api/projects/:projectId/review/comments/:commentId",
        "POST /api/projects/:projectId/review/preview",
        "POST /api/projects/:projectId/review/submit",
      ],
      routeModules: [
        "packages/server/src/routes/git-browse.ts",
        "packages/server/src/routes/review-comments.ts",
      ],
      requestFields: ["gitDiff.againstHead", "gitDiff.origPath"],
    },
    lifecycle: {
      kind: "permanent",
      reason:
        "Retains the advertised contract and the update-only guard; the alternate Source Control client implementation is removed.",
    },
  },
  gitSourceReviewSubmissions: {
    id: CAPABILITY_ID_ALLOCATIONS.gitSourceReviewSubmissions.id,
    name: "git-source-review-submissions",
    kind: "permanent",
    area: "gitStatus",
    introducedIn: "0.7.1",
    advertisement: { kind: "version-implied" },
    description:
      "Server supports captured source-review sites, durable submissions, outcomes, and unread review responses.",
    clientFallback:
      "Current clients assume this v0.8.0 baseline contract; older servers should update or use their bundled client. Settings, permissions, source readiness and runtime availability still apply.",
    serverContract: {
      routes: [
        "GET /api/projects/:projectId/review/submissions",
        "GET /api/projects/:projectId/review/submissions/:submissionId",
        "POST /api/projects/:projectId/review/submissions/:submissionId/acknowledge",
        "POST /api/projects/:projectId/review/submissions/:submissionId/refresh-response",
        "POST /api/projects/:projectId/review/sites/:siteId/follow-ups",
        "POST /api/projects/:projectId/review/sites/:siteId/resolve",
        "GET /api/review/inbox",
      ],
      routeModules: [
        "packages/server/src/routes/review-submissions.ts",
        "packages/server/src/routes/review-inbox.ts",
      ],
      requestFields: [
        "reviewComment.anchor.projection",
        "reviewSubmit.submissionId",
        "reviewSubmit.name",
        "settings.sourceReviewSubmissionsEnabled",
        "settings.sourceReviewResponseTurns",
      ],
      responseFields: [
        "gitDiff.reviewProjections",
        "settings.sourceReviewSubmissionsEnabled",
        "settings.sourceReviewResponseTurns",
      ],
      events: ["review-response-changed"],
    },
    lifecycle: {
      kind: "permanent",
      reason:
        "The hosted client may outpace servers that expose version-1 source review but cannot preserve captures, submissions, sites, or response state.",
    },
  },
  gitSourceReviewProjections: {
    id: CAPABILITY_ID_ALLOCATIONS.gitSourceReviewProjections.id,
    name: "git-source-review-projections",
    kind: "permanent",
    area: "gitStatus",
    introducedIn: "0.7.1",
    advertisement: { kind: "version-implied" },
    description:
      "Server supports ignore-whitespace rendering and direct selected-revision-to-HEAD comparisons in Source Control.",
    clientFallback:
      "Current clients assume this v0.8.0 baseline contract; older servers should update or use their bundled client. Settings, permissions, source readiness and runtime availability still apply.",
    serverContract: {
      routes: [
        "GET /api/projects/:projectId/git/compare/:sha",
        "POST /api/projects/:projectId/git/compare-diff",
      ],
      routeModules: ["packages/server/src/routes/git-projections.ts"],
      requestFields: [
        "gitDiff.ignoreWhitespace",
        "gitCommitDiff.ignoreWhitespace",
        "gitCompareDiff.baseSha",
        "gitCompareDiff.headSha",
        "gitCompareDiff.ignoreWhitespace",
      ],
      responseFields: [
        "gitRevisionComparison.baseSha",
        "gitRevisionComparison.headSha",
        "gitRevisionComparison.files",
      ],
    },
    lifecycle: {
      kind: "permanent",
      reason:
        "Hosted clients may reach older servers without Source Control projections; the client only withholds the projection controls there.",
    },
  },
  gitInclusiveToHead: {
    id: CAPABILITY_ID_ALLOCATIONS.gitInclusiveToHead.id,
    name: "git-inclusive-to-head",
    kind: "permanent",
    area: "gitStatus",
    introducedIn: "0.7.1",
    advertisement: { kind: "version-implied" },
    description:
      "Server compares an inclusive selected-commit range from the selected commit's first parent, or the empty tree for a root commit, through pinned HEAD.",
    clientFallback:
      "Current clients assume this v0.8.0 baseline contract; older servers should update or use their bundled client. Settings, permissions, source readiness and runtime availability still apply.",
    serverContract: {
      routes: [
        "GET /api/projects/:projectId/git/range-to-head/:sha",
        "POST /api/projects/:projectId/git/range-to-head-diff",
      ],
      routeModules: ["packages/server/src/routes/git-inclusive-to-head.ts"],
      requestFields: [
        "gitInclusiveComparisonDiff.baseSha",
        "gitInclusiveComparisonDiff.headSha",
        "gitInclusiveComparisonDiff.path",
        "gitInclusiveComparisonDiff.status",
        "gitInclusiveComparisonDiff.origPath",
        "gitInclusiveComparisonDiff.fullContext",
        "gitInclusiveComparisonDiff.ignoreWhitespace",
      ],
      responseFields: [
        "gitInclusiveRevisionComparison.selectedSha",
        "gitInclusiveRevisionComparison.baseSha",
        "gitInclusiveRevisionComparison.headSha",
        "gitInclusiveRevisionComparison.files",
      ],
    },
    lifecycle: {
      kind: "permanent",
      reason:
        "The existing projection capability permanently means direct selected-tree-to-HEAD comparison, and older servers have no inclusive-range route.",
    },
  },
  gitFileDiffProjections: {
    id: CAPABILITY_ID_ALLOCATIONS.gitFileDiffProjections.id,
    name: "git-file-diff-projections",
    kind: "permanent",
    area: "gitStatus",
    introducedIn: "0.7.1",
    advertisement: { kind: "version-implied" },
    description:
      "Server exposes exact per-file HEAD-to-worktree and first-parent-to-worktree diff projections for the shared file viewer.",
    clientFallback:
      "Current clients assume this v0.8.0 baseline contract; older servers should update or use their bundled client. Settings, permissions, source readiness and runtime availability still apply.",
    serverContract: {
      routes: [
        "GET /api/projects/:projectId/git/file-projections",
        "POST /api/projects/:projectId/git/file-projection-diff",
      ],
      routeModules: ["packages/server/src/routes/git-file-projections.ts"],
      requestFields: [
        "gitFileProjectionDiff.mode",
        "gitFileProjectionDiff.path",
        "gitFileProjectionDiff.fullContext",
      ],
      responseFields: [
        "gitFileProjections.headSha",
        "gitFileProjections.baseSha",
        "gitFileProjections.worktreeFiles",
        "gitFileProjections.cumulativeFiles",
      ],
    },
    lifecycle: {
      kind: "permanent",
      reason:
        "Hosted clients can outpace self-hosted servers, and the exact cumulative projection has no safe older-server request fallback.",
    },
  },
  gitFileRevision: {
    id: CAPABILITY_ID_ALLOCATIONS.gitFileRevision.id,
    name: "git-file-revision",
    kind: "permanent",
    area: "gitStatus",
    introducedIn: "0.7.2",
    advertisement: { kind: "version-implied" },
    description:
      "Server resolves a file's last content revision and whether live filesystem content differs from the committed blob.",
    clientFallback:
      "Current clients assume this v0.8.0 baseline contract; older servers should update or use their bundled client. Settings, permissions, source readiness and runtime availability still apply.",
    serverContract: {
      routes: ["GET /api/projects/:projectId/git/file-revision"],
      routeModules: ["packages/server/src/routes/git-file-revision.ts"],
      requestFields: [
        "gitFileRevision.path",
        "gitFileRevision.rev",
        "gitFileRevision.origPath",
      ],
      responseFields: [
        "gitFileRevision.isGitRepo",
        "gitFileRevision.commit",
        "gitFileRevision.dirty",
      ],
    },
    lifecycle: {
      kind: "permanent",
      reason:
        "Hosted clients can outpace installed servers, and older servers have no per-file revision metadata route.",
    },
  },
  gitWorkingTreeFiles: {
    id: CAPABILITY_ID_ALLOCATIONS.gitWorkingTreeFiles.id,
    name: "git-working-tree-files",
    kind: "permanent",
    area: "gitStatus",
    introducedIn: "0.7.1",
    advertisement: { kind: "version-implied" },
    description:
      "Server exposes current-content inventory plus a persistent, searchable non-ignored untracked cache outside the project.",
    clientFallback:
      "Current clients assume this v0.8.0 baseline contract; older servers should update or use their bundled client. Settings, permissions, source readiness and runtime availability still apply.",
    serverContract: {
      routes: [
        "GET /api/projects/:projectId/git/working-tree-files",
        "GET /api/projects/:projectId/git/untracked-files",
      ],
      routeModules: ["packages/server/src/routes/git-working-tree-files.ts"],
      responseFields: [
        "gitWorkingTreeFiles.files[].path",
        "gitWorkingTreeFiles.files[].tracked",
        "gitWorkingTreeFiles.truncated",
        "gitWorkingTreeFiles.limit",
        "gitUntrackedFiles.files",
        "gitUntrackedFiles.folders",
        "gitUntrackedFiles.total",
        "gitUntrackedFiles.refreshedAt",
        "gitUntrackedFiles.truncated",
        "gitUntrackedFiles.limit",
      ],
    },
    lifecycle: {
      kind: "permanent",
      reason:
        "Retains the advertised contract and the update-only guard; the alternate Source Control client implementation is removed.",
    },
  },
  gitWorkingTreeSections: {
    id: CAPABILITY_ID_ALLOCATIONS.gitWorkingTreeSections.id,
    name: "git-working-tree-sections",
    kind: "permanent",
    area: "gitStatus",
    introducedIn: "0.7.2",
    advertisement: {
      kind: "optional-bit",
      index:
        OPTIONAL_SERVER_CAPABILITY_BIT_ALLOCATIONS.gitWorkingTreeSections.index,
    },
    description:
      "Server maintains one project-keyed, lease-owned Working Tree snapshot with requested tracked, untracked, ignored, and filesystem-directory coverage, lazy filesystem-only inventory outside Git repositories, embedded Git facts when available, and sequenced live deltas.",
    clientFallback:
      "Use the released static working-tree inventory and cache-backed status paths without section controls, ignored enumeration, or a worktree subscription.",
    serverContract: {
      routes: ["GET /api/projects/:projectId/git/working-tree-files"],
      requestFields: [
        "gitWorkingTreeFiles.tracked",
        "gitWorkingTreeFiles.untracked",
        "gitWorkingTreeFiles.ignored",
        "relaySubscribe.channel=worktree",
        "relaySubscribe.projectId",
        "relaySubscribe.coverage",
        "relaySubscribe.coverage.expandedPrefixes",
      ],
      responseFields: [
        "gitWorkingTreeFiles.files[].kind",
        "gitWorktreeSnapshot.generation",
        "gitWorktreeSnapshot.coverage",
        "gitWorktreeSnapshot.headSha",
        "gitWorktreeSnapshot.baseSha",
        "gitWorktreeSnapshot.files[].tracked",
        "gitWorktreeSnapshot.files[].kind",
        "gitWorktreeSnapshot.files[].present",
        "gitWorktreeSnapshot.files[].worktreeChanges",
        "gitWorktreeSnapshot.files[].cumulativeChange",
        "gitWorktreeSnapshot.directories[].path",
        "gitWorktreeSnapshot.directories[].pending",
        "gitWorktreeSnapshot.directories[].truncated",
        "gitWorktreeDelta.generation",
        "gitWorktreeDelta.changes",
        "gitWorktreeDelta.directoryChanges",
        "gitWorktreeDelta.truncated",
      ],
      events: ["git-worktree-snapshot", "git-worktree-delta"],
    },
    lifecycle: {
      kind: "permanent",
      reason:
        "Hosted clients can outpace self-hosted servers, and the released inventory route provides neither sectioned ignored coverage nor a resident live snapshot and delta contract.",
    },
  },
  gitWorkingTreeCompleteScan: {
    id: CAPABILITY_ID_ALLOCATIONS.gitWorkingTreeCompleteScan.id,
    name: "git-working-tree-complete-scan",
    kind: "permanent",
    area: "gitStatus",
    introducedIn: "0.7.2",
    advertisement: {
      kind: "optional-bit",
      index:
        OPTIONAL_SERVER_CAPABILITY_BIT_ALLOCATIONS.gitWorkingTreeCompleteScan
          .index,
    },
    description:
      "Server reports total filesystem inventory sizes and accepts an explicit complete-scan worktree lease that removes the bounded client projection.",
    clientFallback:
      "Keep the bounded filesystem inventory and truncation notice without sending a complete-scan request or showing a Show all action.",
    serverContract: {
      requestFields: ["relaySubscribe.coverage.filesystemScan"],
      responseFields: [
        "gitWorktreeSnapshot.totalFiles",
        "gitWorktreeSnapshot.directories[].totalFiles",
        "gitWorktreeDelta.totalFiles",
        "gitWorktreeDelta.directoryChanges[].directory.totalFiles",
      ],
      events: ["git-worktree-snapshot", "git-worktree-delta"],
    },
    lifecycle: {
      kind: "permanent",
      reason:
        "Older servers ignore the new request field and cannot honor a visible request to replace a bounded filesystem listing with its complete contents.",
    },
  },
  gitIncomingCommits: {
    id: CAPABILITY_ID_ALLOCATIONS.gitIncomingCommits.id,
    name: "git-incoming-commits",
    kind: "permanent",
    area: "gitStatus",
    introducedIn: "0.7.1",
    advertisement: { kind: "version-implied" },
    description:
      "Server lists commits on the configured upstream tracking ref but not local HEAD without contacting the remote.",
    clientFallback:
      "Current clients assume this v0.8.0 baseline contract; older servers should update or use their bundled client. Settings, permissions, source readiness and runtime availability still apply.",
    serverContract: {
      routes: ["GET /api/projects/:projectId/git/incoming-commits"],
      routeModules: ["packages/server/src/routes/git-incoming-commits.ts"],
      responseFields: [
        "gitIncomingCommits.upstream",
        "gitIncomingCommits.headSha",
        "gitIncomingCommits.upstreamSha",
        "gitIncomingCommits.commits",
        "gitIncomingCommits.truncated",
        "gitIncomingCommits.limit",
      ],
    },
    lifecycle: {
      kind: "permanent",
      reason:
        "Older servers have no read-only incoming-commit preview, and the client must not trigger an unsupported request or hidden fetch.",
    },
  },
} as const satisfies Record<string, ServerCapabilityDefinition>;
