# Provider Version Support

> YA is built and audited against the current release of each provider
> harness (the tip) and never forces a user's installation forward; when an
> older installed version would behave differently and the difference is cheap
> to detect, YA gates on the detected version instead of assuming the tip.

Topic: provider-version-support

Related topics: [provider-refresh](provider-refresh.md) (the maintainer audit
that moves the tip markers), [provider-installation-updates](provider-installation-updates.md)
(any YA command that mutates an installation),
[backward-compat](backward-compat.md) (YA's own public surfaces, a separate
concern), [pi-provider](pi-provider.md), [claude](claude.md),
[codex-sessions](codex-sessions.md).

## Support Contract

Maintainer direction, 2026-10-11: requiring a user to stay on the provider
harness tip is acceptable, but where YA can cheaply match the actual installed
version it should.

- **The tip is the tested target.** Root `package.json` `yepAnywhere.*`
  markers record the newest provider release whose YA-consumed surface was
  audited ([provider-refresh](provider-refresh.md)). They are audited-through
  markers, not pins or minimums. Older installations are best-effort.
- **YA does not force an update.** It runs the user's installed executable
  where the provider is user-installed, reports an available update, and
  mutates an installation only under an explicit user choice
  ([provider-installation-updates](provider-installation-updates.md)).
- **Gate when it is cheap and the behavior differs.** If a newer protocol
  shape would make an older harness hang, misreport state, or silently do the
  wrong thing, and YA already knows or can cheaply probe the installed
  version, branch on that version. Name the boundary as a
  `<PROVIDER>_<FEATURE>_MIN_VERSION` constant next to the code that uses it.
- **Do not gate what older versions already tolerate.** An added optional
  request field that an older provider ignores needs no gate when ignoring it
  degrades only to the old behavior. Verify the tolerance in the older source
  rather than assuming it. Example: Codex goal `origin` (below).
- **Otherwise, the tip is required.** When gating would need a second
  implementation or cannot be detected cheaply, YA follows the tip and the
  refresh record says which older versions lose what. Prefer a clear startup
  or request failure to silently wrong behavior.

A detected version that cannot be parsed is not treated as the tip when the
decision matters; Pi's startup refusal below is the model.

## Per-Provider Facts

| Provider | Executable YA runs | Version knowledge | Update behavior |
|---|---|---|---|
| Claude | The Claude Code binary bundled with YA's `@anthropic-ai/claude-agent-sdk` dependency, unless `CLAUDE_CODE_EXECUTABLE` / `CLAUDE_CODE_PATH` names another; the PATH `claude` only when no bundled binary resolves (`resolveLocalClaudeCodeExecutable`) | Moves with YA's SDK dependency, so the user's own `claude` version normally does not matter | Updated by YA dependency refreshes, never at runtime |
| Codex | The user's installed `codex` (configured path, then discovery; [windows-codex-cli-detection](windows-codex-cli-detection.md)) | Probed `codex --version`; startup logs an advisory warning when it differs from `expectedVersion` | `codexUpdatePolicy` defaults to `notify`; `auto` or a confirmed prompt runs the npm update |
| Pi | The user's installed `pi` (`PI_EXECUTABLE` / `PI_PATH`, then configured path, then common install paths, then PATH) | Probed `pi --version` before every RPC start | No YA updater |

An environment override wins over a newly updated package. A server whose
environment names a local fork through `PI_EXECUTABLE` keeps running that fork
after the npm package updates. Check the server's effective target, not
`pi --version` in a shell, before concluding which version YA runs.

Other user-installed providers (Grok, OpenCode, Gemini) follow the same
contract; their topics own their specifics.

## Current Version Gates

- **Pi turn boundary.** `PI_AGENT_SETTLED_MIN_VERSION` (0.80.4): newer Pi ends a
  YA turn on `agent_settled`, older Pi on `agent_end`. An unrecognized version
  string fails startup rather than guessing, because either guess can hang or
  prematurely settle a session ([pi-provider](pi-provider.md)).
- **Codex discovery-failure model fallbacks.** `codex-model-catalog.ts`
  `CODEX_CLI_*_MIN_VERSION` constants choose which fallback catalog to show
  when authenticated `model/list` discovery fails, so an older CLI is not
  offered models it cannot run.
- **Pi prompt disposition, gated by field presence.** A `handled` prompt
  ends the YA turn only when Pi reports that disposition (0.99+). Older Pi
  omits the field and keeps the settled-event-only behavior.
- **Codex goal provenance, deliberately ungated.** YA sends
  `origin: "user"` on every user-typed `/goal` set or clear. Codex 0.161.0
  introduced the field; earlier app-servers deserialize goal params without
  `deny_unknown_fields`, so they ignore it and keep their old behavior.

## Dropping Support For An Older Version

YA has no general minimum-version mechanism, and no provider has a declared
floor today. Only two version facts reach the user:

- Pi refuses to start a session when `pi --version` is unrecognizable, and
  shows that error in the session.
- Codex's mismatch with `expectedVersion` is a server-log advisory only. Its
  update prompt says a newer release exists, not that one is required.

Raising a floor is therefore a deliberate product change, not a refresh side
effect. It must make the requirement visible where the user acts: provider
status and a refused session start should both name the installed version,
the required version, and the update path. A floor must never surface as an
unexplained protocol failure. Until such a surface exists, prefer the
version gate or tip-only record above to raising a floor.

## Known Tip-Only Behavior

None is recorded as of the 2026-10-11 audits. Add an entry when a refresh
adopts a tip-only surface, stating which older versions lose what, and
especially when that loss is worse than a clear failure.
