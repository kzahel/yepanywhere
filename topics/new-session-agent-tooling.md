# New-Session Agent Tooling

> Proposal: launch-time tooling for supervised sessions — enabled YA commands
> on PATH, capability fragments, scoped server endpoint channels, and options
> that shape the instruction environment — addressed throughout by canonical
> YA session ids.

Topic: new-session-agent-tooling

Status: broader direction proposal, updated 2026-09-08. Opt-in own-session
command delivery is implemented in [Agent Own-Session Inspection](agent-self.md).
The remaining tooling and instruction controls here are proposals. The
consumer-side story (what the scripts do against the server) is
[`agent-session-access.md`](agent-session-access.md); this topic owns
what YA injects into a session at launch. Packaging, desktop delivery, the
shared `ya-agent` dispatcher, and private input live in
[`agent-command-runtime.sketches.md`](agent-command-runtime.sketches.md). The one concrete missing
feature — the virgin instruction-scope option — is tracked in
[`gaps/virgin-new-session-option.md`](../gaps/virgin-new-session-option.md).

The [command runtime's first milestone](agent-command-runtime.sketches.md#first-milestone-inspect-the-owning-session)
is now read-only `ya-agent self` (2026-09-08). It retains command-path and scoped
connection delivery, but initially uses operator-managed Claude/Codex global
instructions for advertisement. The capability fragments, New Session UI,
private input, and broader session tooling described here remain later work.

See also:
[optional computer control](optional-computer-control.md) — session-selective,
on-demand native control and the Codex/Sky execution reference;
[`agent-context-injection.md`](agent-context-injection.md) — current
instruction placement and the dormant personal-launch-integration
sketch this overlaps;
[`ya-env-vars.md`](ya-env-vars.md) and
[`subprocess-environment.md`](subprocess-environment.md) — the injection
channels and namespace contract;
[`session-wake.md`](session-wake.md) — the existing env-published
per-session credential precedent;
[`session-sandboxing.md`](session-sandboxing.md) — the existing
per-session provider-state redirection precedent;
[`agent-command-runtime.sketches.md`](agent-command-runtime.sketches.md) — command packaging,
server-instance PATH launchers, desktop behavior, and capability-scoped
dispatch;
[`ask-session.md`](ask-session.md) — the first planned consumer of the
capability fragment and PATH scripts;
[`yacron.md`](yacron.md) — its proposed provider-host-integrated variant is a
scheduled-prompt consumer that also requires the launch project marker;
[`vanilla-defaults.md`](vanilla-defaults.md).

## PATH, authority, and tool advertisement

Ship the agent-facing implementation with the YA server artifacts used by both
the npm and desktop distributions. The agent-command runtime sketch owns one private
server-instance command directory and the `ya-agent` dispatcher. When at least
one requested command capability is effective for a provider launch, expose
that directory to the supervised session through the channels that already
deliver `AGENTCTL_SESSION_ID` and the wake credential pair: the provider spawn
environment (Codex-family) and the `BASH_ENV` bridge (Claude). PATH extension
is one more value on those existing channels, not a global install or a new
desktop sidecar. New environment names follow the `AGENT_*` agent-facing
convention; the live publisher migration in
`gaps/agent-facing-env-markers.md` is the naming reference.

The same provider-owned launch step publishes `AGENT_YA_API_URL`, the exact
child-reachable base URL for the originating YA server, and
`AGENT_YA_API_TOKEN`, an ephemeral credential scoped to that session's
effective operations and current provider-process launch. It mints the token
for this provider session rather than passing through an operator login or
relying on unauthenticated localhost. The values are absent when the launch has
no effective grant and are allowlisted through the same restricted child
environment path as the wake pair. The token's server-side scope is the
portable authorization boundary; process-tree inspection is not.

Ordinary Codex `default` and `plan` turns use a network-disabled sandbox
policy. A separately selected, explicitly reviewed agent-tool profile may set
`networkAccess: true` after resolving a reachable API URL, but enabling an
individual command such as private input must not silently widen the sandbox.
A launch without an approved direct channel or later host bridge is ineligible
and receives neither command authority nor an instruction advertising it.

The "prompt saying how to use these tools" is a `[Client capabilities]`
fragment composed by `buildEffectiveAgentContext`
(`agent-context-injection.md`): a short exact-preview block naming only the
enabled and launch-eligible commands plus their authority boundary. An MCP
server exposing the same operations is a possible later adapter — the layering
rule in `cross-host-delegation.md` already classifies MCP as one consumer among
REST/CLI/skills — but the capability fragment plus PATH is provider-neutral
and needs no per-harness tool wiring, so it comes first.

Per `vanilla-defaults.md`, each command capability is requested per session and
ships default-off: an out-of-the-box session sees no new PATH entries, env
values, or context fragment. A global setting may only seed future New Session
forms. Private input's proposed first session control enables its narrow scope
and exact fragment together when the launch is eligible; later consumers may
choose a different product-level pairing when their owning contracts justify
it.

## Command identity contract

Commands and fragments identify sessions by canonical YA session id —
which is usually the provider session id — never by provider-native
resume handles (`DEVELOPMENT.md` § Provider Session Identity). A session's
own id is already delivered as `AGENTCTL_SESSION_ID`; the fragment
should say so rather than introduce a second name for the same value.

## Instruction-scope options ("virgin" sessions)

A new-session option should let a launch skip the user-global
instruction layer while keeping project instructions, auth, and provider
configuration — a *virgin* session. *Vanilla* remains reserved for unchanged
first-party provider behavior, which normally includes the user's global
instruction layer; this option deliberately removes that layer. The
per-provider mechanics differ:

- **Claude**: the Agent SDK's `settingSources` option already controls
  which filesystem settings tiers load; YA currently passes
  `["user", "project", "local"]` in
  `packages/server/src/sdk/providers/claude.ts`. Virgin drops
  `"user"`. <!-- assumed: that the user tier owns user-global CLAUDE.md
  as well as user settings; probe before implementation -->
- **Codex**: no per-file switch exists; the mechanism is a redirected
  `CODEX_HOME` replica root that omits the user `AGENTS.md`. The
  concrete replica design, auth handling, session discovery, and route
  threading are specified in `gaps/virgin-new-session-option.md`.

The option must persist in session metadata and be reapplied on resume
and fork — like the sandbox `stateKey` — or a resumed session silently
regains the user instruction layer (and, for Codex, loses sight of its
own rollout).

Session sandboxing already redirects `CODEX_HOME`/`CLAUDE_CONFIG_DIR`
per session (`session-sandbox.ts`); a sandboxed virgin session composes
by controlling which instruction files exist in the sandbox provider
state dir, not by double-redirecting.

## Open decisions

- Exact direct-network versus provider-host bridge profiles for sandboxed
  launches; individual command settings do not silently widen access.
- MCP adapter timing after the command runtime proves each service surface.
