# macOS provider-host turns can end during long-running test tools

Several macOS Node source-checkout sessions ended active Codex turns while a
test command was running. The durable Codex transcripts recorded generic
`turn_aborted` interruptions, and macOS recorded orderly app-server exit rather
than a crash report. In one later incident, the provider owner exited while a
yielded tool call was emitting a dense Maven output burst. The affected runs
predated persistent YA server logging, so the surviving evidence cannot
distinguish a requested safe reload from a provider-worker or tool-bridge
failure.

macOS development now defaults `YEP_PROVIDER_HOST_ENABLED` off as containment;
explicit opt-in keeps the reload-safe path available for diagnosis. This does
not fix or explain the owner loss. Reproduce with file logging enabled and
correlate the reload request, safe-restart blocker decision, host/worker
detach-or-exit records, app-server lifetime, and tool-runner completion before
re-enabling the host by default.

Qualification update, 2026-11-04: the real source wrapper/Hono/Vite/host and
pinned Claude/Codex executables now have retained scripted-model API and browser
scenarios. Requested reload, abrupt Hono loss, approval reattachment and a real
tool's dense-output burst pass on macOS arm64; three browser repetitions per
provider pass without retries. Owned logs and PID/start identities are captured
on failures. Commands and limits are in
[native provider testing](../topics/native-provider-testing.md#full-source-app-and-dev-reload-qualification).
This does not reproduce the historical owner exit or close this gap. Wrapper/
host loss, sustained runs and terminal signal schedules remain separate work;
macOS stays opt-in.

Found 2026-09-20 while investigating repeated active-turn interruptions during
test execution on the localhost development server.
