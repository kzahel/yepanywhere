# Development

This is the shared contributor guide for humans and agents. Read it before
planning implementation or making repository changes, including documentation
and configuration changes. Read every applicable entry in **Required reading
by task** before choosing an approach; those linked requirements are binding
when their trigger applies. Recheck the table if the task expands.
General discussion and read-only orientation do not require the full development
workflow; applicable topic-reading triggers still apply.
[AGENTS.md](AGENTS.md) supplies the agent entry rules.

This file owns the common rules and reading triggers. Contributor procedures
live in [docs/development/](docs/development/README.md); product behavior and
technical contracts live in their owning `topics/` documents. Follow direct
links for the task at hand; reading the whole development directory is not
required.

## Project Context

Yep Anywhere is a mobile-first, multi-session supervisor for coding agents.
Server-owned provider processes keep running when clients disconnect. A Hono
server and React client exchange live events over WebSockets; provider-native
transcripts preserve session history. Direct access uses Tailscale/LAN; relay
access uses SRP authentication and end-to-end NaCl encryption.

The server/web core needs no hosted account or Firebase dependency. The optional
published native app uses its separate hosted push broker for notifications.
See [project context](docs/project/) for detail, [historical vision](docs/archive/)
for background, and `~/code/dotfiles/projects/README.md` for cross-project context.

## Quick Start

Use Node.js `^22.16 || ^23.11 || >=24.10` (a maintained LTS is recommended).
From the repository root:

```bash
pnpm install          # Or pnpm setup:core to skip the relay workspace
pnpm dev              # Open http://localhost:3400
pnpm lint             # Lint diagnostics
pnpm format:check     # Non-writing formatter verification
pnpm typecheck        # TypeScript checking, no emit
pnpm test             # Non-Android workspace unit tests
pnpm test:e2e         # Full browser suite; CI runs it, local scope is risk-based
```

See [local development](docs/development/local-development.md) for cloning,
commands, ports, profiles, and environment variables, and
[server runtimes](topics/server-runtime.md) for Bun and remote upgrades.

## Contribution Ethos: Minimalist Runtime

Running code — everything outside test/build tooling — is hand-built and lean on
dependencies. Before adding a runtime dep:

- **Narrow-scope utilities**: prefer a ~100-line hand-rolled implementation over
  a package. SGR parsers, debounces, small date helpers, tiny encoders — code
  them. A dep's long-term reading/audit cost usually exceeds the one-time write.
- **Exemptions**: don't hand-roll crypto (bcrypt, NaCl), auth protocols
  (SRP-6a), web frameworks (Hono), syntax highlighting (Shiki), or the official
  provider SDKs. Use the audited/canonical implementation.
- **Client bundle**: mobile-first — anything entering the client bundle must
  justify its payload. Prefer server-side rendering.
- **Mobile interaction**: visible controls and list rows must remain practical
  touch targets. Compact desktop density is acceptable only if mobile users can
  still tap the intended item without precision aiming; verify spacing-sensitive
  UI on a narrow viewport before landing.
- **Client rendering**: rich renderers should operate on block/tool-sized input
  and return cheap metadata they already know, such as whether output changed.
  Reuse a first completed scan for both control decisions and display instead
  of rendering once to decide whether a toggle exists and again to show it. See
  [packages/client/RENDERING_PERFORMANCE.md](packages/client/RENDERING_PERFORMANCE.md).
- **Dev-deps**: tooling (vitest, biome, playwright, tsx, types) doesn't ship to
  users; lower bar applies.

Rule of thumb: if a dep is essentially a one-file helper, write the file.

## Architecture

See [`ARCHITECTURE.md`](ARCHITECTURE.md) for the entry-point map of how
provider events flow through the server to the client, the transport modes,
and the large-scope refactor proposals. Read it before changing message-flow
or render-path code.

Before fielding a user request to improve **stability**, **performance**, or **security**, read `ARCHITECTURE.md` first. Check whether the issue is already addressed in the large-scope refactor proposals or the per-doc cleanup tables, and whether a relevant trigger condition has now been met. If the proposed work would touch a load-bearing piece named in `ARCHITECTURE.md` (fan-out, replay buffer, streaming throttle, transport framing, auth state), prefer reading the linked detailed doc and surfacing the existing trade-off to the user before writing code.

## Architecture Mandates

Before modifying background loops, watchers, polling, retry timers, heartbeat
scheduling, session liveness, client stream/reconnect behavior, or server
catch-up paths, read `topics/architecture-mandates.md`. In particular, an idle
provider session and a closed client tab must never indefinitely consume server
resources.

## Oversized Source Files

Production source files over 1,500 lines are frozen at a recorded budget, and
`pnpm lint` fails when one grows or a new file crosses the threshold. When a
change needs code in such a hub (`app.ts`, `routes/sessions.ts`,
`SessionPage.tsx`, `Supervisor.ts`, `Process.ts`, `codex.ts`, and the rest of
`scripts/source-file-budgets.json`):

- Put the new logic in a domain-named module beside the hub, and keep only the
  wiring (import, call, mount, prop) in the hub. `helpers.ts`/`utils.ts`
  buckets are not domain names.
- If even the wiring exceeds the budget, first land a separate move-only
  extraction from that file, preferably a seam already named in the
  [refactor ledger](docs/tactical/058-typescript-module-boundary-refactor.md).
- After any extraction, run `pnpm source:budgets --record` in the same commit
  so the freed lines stay freed.
- Never raise a budget to get lint green. A raise needs maintainer approval
  and a `raise` record; see the
  [growth guard](topics/typescript-module-boundary-refactor.md#growth-guard).
- Do not shorten a barrel with `export *`; lint rejects it. Name re-exports
  explicitly ([code quality](docs/development/code-quality.md#name-re-exports-explicitly)).

## Project Directory Storage

Before adding or changing any YA-managed write inside a selected project or
its Git metadata, read `topics/project-directory-storage.md`. App-data-only is
the default: browsing, rendering, replaying, indexing, caching, and preserving
viewer state must not create `.yep`, `.attachments`, Git excludes, or YA-owned
refs. A helper that creates or excludes a directory is not authorization;
project-local storage requires the explicit global opt-in, and feature-level
retention choices remain separate.

## Provider Session Identity

YA URL session ids are the canonical user-facing session ids. Provider-native
ids such as OpenCode `ses_*`, Codex thread ids, or other backend resume handles
may be stored and passed back to the provider for resume, export, or debugging,
but they must not silently replace the YA-visible session id in URLs, persisted
YA metadata, REST/WebSocket payloads, or UI copy. If a provider truly requires
using its own id as a public/session id, document that exception in the
provider contract and make the mapping explicit in the UI/debug surfaces.

[YA-owned session identity](topics/session-identity.md) records the selected
pre-launch session/startup ownership follow-up and its compatibility audit;
read it before changing session identity, native-id translation or creation
recovery. The current remap behavior remains until that migration is qualified.

## Vanilla Defaults

YA-novel user-visible behavior, including changes to submitted provider text,
ships configurable and default-off. Novel features remain welcome; a plausible
benefit earns an option, not a default. Before adding or enabling any user-visible
feature that is not configurable default-off, read
[vanilla defaults](topics/vanilla-defaults.md) for the first-party UX contract
and its explicitly bounded exceptions.

## Client/Server Compatibility Review

Hosted clients can update before installed servers. Before making a client
depend on a route, field, event, or semantic absent from a supported stable
release, read [server capabilities](topics/server-capabilities.md#minimum-compatibility-horizons)
and [hosted compatibility](topics/remote-hosted-compatibility.md).
Present the required release-corpus, gate, and fallback plan and obtain
maintainer approval before editing the contract. An originating request that
already approves those decisions satisfies the gate; do not ask twice.
Never broaden an advertised capability to include a contract older servers lack.
The [90-day retirement rule](topics/server-capabilities.md#90-day-retirement-rule)
is standing authorization to remove expired fixed-version gates and alternate
compatibility code without asking again. Other support horizons alone do not
authorize removal.

## Hard Development Rules

Follow `topics/hard-development-rules.md` for binding upstream-facing
development rules. Read it before changing deployment-sensitive defaults,
configuration precedence, relay or endpoint selection, provider/model settings,
hosted-client endpoint selection, migrations, or maintainer-specific deploy
configuration.

## Required Reading By Task

These triggers apply in addition to the common rules above. A task can match
several rows. Read the named guide or topic before the affected planning,
implementation, verification, or commit action; linked background references
are not a requirement to read every neighboring document.

| When the task involves… | Read / required action |
| --- | --- |
| Source edits or OS-sensitive behavior | [Testing](docs/development/testing.md): required checks, Linux/macOS/Windows coverage, and platform limitations. |
| Adding, reviewing, removing, or accelerating tests at any level | [Test value and CI cost](docs/development/testing.md#test-value-and-ci-cost): retention by likely regression value, authority to remove shallow tests, and runtime in seconds. |
| Choosing a test level, adding or changing browser tests, or deciding local E2E scope | [E2E testing](topics/e2e-testing.md): unique boundary, cost, retry evidence, and focused local verification. |
| Source formatting, warning cleanup, or a commit | [Code quality](docs/development/code-quality.md): warning-free checks, exact-file formatting, no routine import/export reordering, and explicit re-exports (no `export *`). |
| Authentication, named principals, project/session access grants, hosted issuer trust, or peer authorization | [Security](topics/security.md) and [principals and grants](topics/principals-and-grants.md): state how the proposed slice relates to the shared vocabulary before choosing a feature-local identity or authorization shape. |
| Any change in `packages/client`, UI copy, or a chatty client console | [Client development](docs/development/client.md): English-only i18n additions and `pnpm console:scan`. |
| Client styles, a legacy stylesheet, or a React component emitting legacy global classes | [CSS architecture](topics/css-architecture.md): CSS Modules, containment, and the `css:touched` ownership check. Run `pnpm css:check` for style changes. |
| UI appearance/interaction proposals or mockup authoring/export | [UI design](topics/ui-design.md), before choosing fixtures or rendering/export commands. Prose-only requests remain prose-only. |
| UI tweaks or browser verification | [UI testing](topics/ui-testing.md): final desktop/phone captures by default, produced through the repository's artifact capture facility so the images are presented rather than only archived; browser fallback and explicit user-owned visual verification. |
| A test timeout, or a CI-only test failure | [Test time budgets](topics/test-time-budgets.md): budgets come from measured runs at 2-4x the observed maximum, counting a limit a run timed out at; rewrite an assertion whose subject was never the clock. |
| UI rendering boundaries or shared views | [UI architecture](topics/ui-architecture.md). |
| React state ownership, effects that publish state, external-store snapshots, or subscriptions | [React state patterns](topics/react-state-patterns.md): convergence, stable snapshots, narrow subscriptions, and lifecycle ownership. |
| Rendering or rich-renderer changes | [Rendering performance](packages/client/RENDERING_PERFORMANCE.md). |
| Benchmark/regression evidence or measurement-host selection | [Performance regression suite](topics/performance-regression-suite.md#performance-measurement-hosts), before treating measurements as regression evidence. |
| Device streaming, `/api/devices`, `deviceBridge`, or `packages/device-bridge` | [Device control testing](docs/development/testing.md#device-control-testing): emulator testing is scoped to this feature. |
| Chromebook testing or debugging | [ChromeOS debugging](docs/development/testing.md#chromeos-debugging): use the chromeos-testbed CLI. |
| Codex provider schemas, scanner, normalization, app-server protocol, or target-version/API/protocol refreshes | [Provider development](docs/development/providers.md): inspect pinned upstream source; read-only audits may proceed, but enacting Codex compatibility edits requires user approval. |
| Provider integration tests or refactors to scheduling, steering, tools, cancellation or native persistence | [Native provider testing](topics/native-provider-testing.md): prefer actual executables against scripted local model APIs, semantic action/assertion scenarios, and explicit qualification limits. |
| Any provider refresh, transcript schema, or tool-result schema change | [Provider development](docs/development/providers.md) and the applicable [provider refresh](topics/provider-refresh.md) sections; preserve audited-through version markers and run schema validation. |
| SQLite adapter changes, SQL callers, statement lifetimes, or test ceilings | [Runtime-portable SQLite](topics/required-sqlite.md#runtime-portable-sqlite): use the shared runtime intersection, reuse prepared statements, and obtain maintainer consensus before widening the boundary. |
| Dependencies, install scripts, lockfile updates, or audit findings | [Dependency maintenance](docs/development/dependencies.md): install-script allowlist and advisory justifications/revisit triggers. |
| Creating/editing tactical plans or retiring completed plans/gaps | [Documentation and plans](docs/development/documentation.md): descriptive step names and durable-content migration before retirement. |
| Moving code between modules, splitting a large file, or a `source-file-budgets` lint failure | [Module boundary refactor discipline](topics/typescript-module-boundary-refactor.md): move-only slices, naming, tripwires, and the growth guard. |
| Creating a commit | [Commit conventions](docs/development/commits.md): motivation, wrapping, provenance, and series trailers. |
| Local instances, ports, profiles, or provider/feature environment configuration | [Local development](docs/development/local-development.md). |
| Server/client logs or maintenance diagnostics | [Debugging](docs/development/debugging.md). |
| npm or website releases, or staging deployment | [Releasing](docs/development/releasing.md), then the applicable linked runbook. |

## Before Finishing

After editing TypeScript or other source files, pass `pnpm lint`,
`pnpm format:check`, `pnpm typecheck`, and `pnpm test`; for UI changes, run
relevant focused browser checks under [E2E testing](topics/e2e-testing.md).
The full E2E suite remains a CI gate and a local check for changes whose
affected browser cases cannot be bounded reliably. Site source changes require
`pnpm site:build`.
Fix errors before considering the task complete. Follow the
[testing guide](docs/development/testing.md) for platform-specific requirements.
Before committing, checks must be warning-free; follow
[code quality](docs/development/code-quality.md) for isolated cleanup and
recording debt that cannot safely be isolated. Preserve unrelated concurrent
edits and format only the exact files changed by the task.

## Observable Behavior Contracts

Before an implementation is complete, verify that every intentional observable
behavior it adds or changes is covered by a contract in the owning
`topics/*.md`; update or create that contract when it is not. State externally
testable outcomes and constraints, including deliberate failure or fallback
behavior, rather than implementation narration. Tests and commit messages are
evidence and history, not substitutes for the product contract.

## Keeping This Guide Small

Keep common rules, short reminders of consequential constraints, and explicit
reading triggers here. Put detailed commands, examples, exceptions, and
maintenance records in their owning topic or development guide. Extend an
existing owner before creating a new document; do not duplicate a procedure in
both places. Keep mandatory current requirements distinct from proposals and
historical evidence. When moving a section, preserve its requirements and
update incoming links and section references.
