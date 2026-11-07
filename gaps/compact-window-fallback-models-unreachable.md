# Compact-window fallback models are never consulted

`resolveCompactModelSettings` in
`packages/server/src/sessions/session-compact-thresholds.ts` takes a list of
model ids and uses the first one with a known context window. Most launch
paths pass the requested model followed by fallbacks such as the live
process's resolved model and the source transcript's model:
`buildSuccessorLaunch` and `buildResumeLaunch` in
`sessions/session-launch-settings.ts`, `routes/session-creation-routes.ts`,
`routes/session-resume-routes.ts`, and the queued-message launch in
`routes/sessions.ts`. The fork-summary target already passes only its
requested model.

The fallbacks appear unreachable. A window is only computed when the
requested YA model has a stored compact percent, so that model is named, is
the first candidate, and is not `default`. The window lookup then ends in
`getModelContextWindow`, which falls back to a provider default rather than
zero, and live observations are only recorded when positive. So the first
candidate answers unless `ModelInfoService` holds a non-positive window for
it: windows loaded from its saved file are checked only for being numbers,
and windows from provider model lists only for being non-zero. Code, tests
and docs that keep the lists ordered, including the provider-local rule
restart and the stale-session handoff follow, protect a lookup that should
not happen.

Not fixed in place: step 2 of
[the session launch service plan](../docs/tactical/177-session-launch-service.md)
is a behavior-preserving consolidation. The cheap fix is to make
`ModelInfoService.getContextWindow` ignore non-positive saved or listed
windows, then drop `modelCandidates` and look up only the requested model.
Delete the fallback cases in
`test/routes/session-successor-launch-settings.test.ts`, the compact-window
sentence in
[restart handoff template](../topics/restart-handoff-template.md#launch-settings-inheritance),
and the stale `contextWindowFor` mention in the
`resolveCompactWindow` comment.

Found 2026-11-06 while consolidating successor launch settings for plan 177.
