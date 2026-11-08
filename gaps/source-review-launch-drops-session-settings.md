# Source Review sessions: permission mode, and routed sources on older servers

Since plan 183 a Source Review new session keeps the opening session's router
selection, sandbox and tier and receives Global Instructions and compact
settings (`review/reviewSessionLauncher.ts`, `sessions/derived-launch-sources.ts`).
It still launches in the default permission mode rather than the opening
session's, so a review from a `bypassPermissions` session asks for approvals.
That may be the safer default; it is undecided.

Against a server that predates plan 183, the client's `newSession.sourceSessionId`
is ignored, so a review from a pool-routed session still starts on the direct
login without a refusal (`lib/sourceControlNavigationState.ts`
`reviewNewSessionFromDefault`). The composer refuses that case; Source Review
cannot yet, because its default-session state does not carry whether the
session is routed. Fix: carry `routerBinding` (or a routed flag) into
`SourceReviewDefaultSession` and refuse with `routerLaunchUnsupported` when
the server lacks `project-queue-router-selection`. Likewise the composer
cannot tell a pre-183 server's unsandboxed session from one whose payload
omits the new `sandboxLevel`.

The reaped follow-up at `resumeSession` (same file) passes no settings, so it
also hits [the resume provider fallback](resume-without-provider-falls-back-to-default.md).

Found 2026-11-08 while auditing launch paths for dropped session settings;
the older-server case was found by the plan 183 review.
