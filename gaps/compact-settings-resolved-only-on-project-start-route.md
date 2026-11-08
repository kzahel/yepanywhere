# Compact settings are applied only by the project session-creation route

`resolveCompactModelSettings` (per-model compact-early percent,
`forceYaOrchestratedCompaction`, `claudeAutoCompactPercentOverride`) is spread
into launch settings only in
`packages/server/src/routes/session-creation-routes.ts` (project route) and the
resume routes' `buildResumeLaunch`. `Supervisor.startSession` does not fill
defaults, so these launches run without the configured compaction behaviour:

- Detached session creation (same file, sibling handler).
- Project Queue new-session and existing-session items
  (`ProjectQueueScheduler.toModelSettings`).
- Agent API createSession (`core-api/native-session-commands.ts`).

Project Queue items also drop recap, prompt-suggestion and helper-model
settings (already noted as N2 in
[new-session-start-and-queue-differences](new-session-start-and-queue-differences.md)),
and wake/review follow-up resumes drop them plus `globalInstructions`.

Source Review new sessions resolve them since plan 183
(`sessions/derived-launch-sources.ts`).

Fix: resolve compact (and helper) settings in one place every launch passes
through, rather than per route.

Found 2026-11-08 while auditing launch paths for dropped session settings.
