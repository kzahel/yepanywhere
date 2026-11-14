# Per-session tool permission rules are lost when the provider process restarts

`ModelSettings.permissions` (allow/deny rules) is saved only in the creation
snapshot (`packages/server/src/sessions/session-creation-launch.ts`), not in
session metadata, and `buildResumeLaunch` takes it only from the request
body. Every resume that does not resend it drops the rules: `/resume` without
a body, Project Queue, wake, Source Review follow-up, `/clearloop`, and
recovered-queue reactivation. The tier/effort live restart in `Supervisor.ts`
also passes `body.permissions` without falling back to the live process's
`permissions`.

Consequence: deny rules stop applying after the first restart, which matters
most under `bypassPermissions`. Only the Agent API sets these rules today; the
YA client does not.

Fix: persist the rules with the session's launch settings and restore them in
`resolveColdLaunchSettings`; fall back to `process.permissions` on live
restarts.

Found 2026-11-08 while auditing resume paths for dropped session settings
(reviewer-traced; storage location confirmed directly).

The 2026-11-14 orderly queue handoff now captures live tool rules for automatic
cold patient recovery, and refuses automatic cold recovery without that
evidence. Project Queue also uses captured rules for existing-session owners
stopped by that handoff, preferring a current live owner's rules if available.
This bounded exception does not fix ordinary manual resume, already-cold
Project Queue targets or other restart paths above; their durable
rule-restoration defect remains.
