# OpenCode 2 installs fail with unexplained protocol errors

YA's OpenCode backend speaks only the 1.x `opencode serve` API. OpenCode 2
(`@opencode/cli`, evaluated at 2.2.5) is reached through
`opencode upgrade --major` or a separate npm package. With a 2.x executable,
`OpenCodeProvider.startSession()` (`packages/server/src/sdk/providers/opencode.ts`)
fails before any session exists:

- an unprotected launch gets 405 from `POST /session` and reports
  `Failed to create session: 405`;
- a protected launch reports `OpenCode server failed to start`, because
  `waitForServer()` expects its invalid-credential `GET /session` probe to
  return 401. In 2.x that path is the web app's HTML with status 200.

Neither message names the version. That breaks
[provider version support](../topics/provider-version-support.md)'s rule
that an unsupported version must not surface as an unexplained protocol
failure. Model discovery partly works. `models --verbose` is refused, so the
plain-list fallback runs and effort variants are lost. Plain `opencode models`
on 2.x also starts a detached `opencode serve --service` background daemon,
which outlives YA's call. Full probe evidence is in
[provider refresh](../topics/provider-refresh.md#opencode).

**Cheap fix (not done here).** Probe `opencode --version`, which 2.x prints
as `opencode v2.2.5` and 1.x as bare `1.19.5`. On a 2.x version, refuse
session start with an error that names the installed and supported versions.
Also skip, or run with `--standalone`, the model-catalog subprocess so it
cannot leave a daemon behind. Name the boundary
`OPENCODE_V2_MIN_VERSION` per that topic.

**Full support** needs a second adapter, gated on the detected major. Its
known inputs:

- routes: `POST /api/session` (`{location:{directory}, model:{providerID,id,variant}}`),
  asynchronous `POST /api/session/{id}/prompt` (`{text, files}`) that returns
  an inbox receipt at once rather than at turn end, `POST .../interrupt`,
  `GET /api/session/active`, `GET /api/event`,
  `POST .../permission/{requestID}/reply` (`decision: once|always|reject`),
  `POST .../form/{formID}/reply`, `POST .../model`, and `GET /api/model` for
  the catalog in place of the CLI;
- events: `session.execution.{started,succeeded,failed,interrupted}` as the
  turn boundary, `session.step.*`, `session.text|reasoning.{started,delta,ended}`,
  `session.tool.{input.*,called,progress,success,failed}`, `permission.asked`
  and `form.created`. OpenAPI types the stream only as JSON strings, so payload
  shapes beyond the captured inbox/execution/step events must be captured;
- durable reads: `session_v2`, `session_message` and `session_part` tables in
  the same `opencode.db`. Migration copied the probe's 1.x session and
  messages into them, left `session_part` empty and kept the legacy rows.
  `session export` replaces top-level `export`;
- the durable-creation contract in [opencode-backend](../topics/opencode-backend.md)
  ties input confirmation to the synchronous 1.x message POST. 2.x
  confirmation would come from `session.inbox.delivered` or the receipt, and
  that needs its own qualification;
- a native-scenario pin for `@opencode/cli`, using a scripted Chat
  Completions provider. The free model returned a 429 usage-limit error, so
  no assistant, tool or permission payload was observed.

Not fixed in place: the evaluation request was conditional on the basics
working, and the adapter is a design refresh, not a version gate.

Found 2026-11-04 while evaluating OpenCode 2.2.5 as a YA provider backend.
