Read and follow `CLAUDE.md` for repo context and instructions, and `DEVELOPMENT.md` for dev/contributor policy (setup, commands, contribution ethos). For architectural context (server message routing, client render pipeline, transports, auth state, large-scope refactor proposals), start at `ARCHITECTURE.md` rather than re-deriving from source.

For product priorities, read the [Roadmap](docs/roadmap/README.md) before
proposing or reprioritizing work. It is the canonical initiative overview;
linked tactical plans and topic docs supply implementation detail and
contracts. Keep its status and blockers current when roadmap work changes.
Roadmap priority does not expand the scope of an unrelated user request.

When `AGENTS.local.md` exists here, it is the machine-local final-authority
amendment to these instructions: read it before acting in this repo — it
defines request verbs such as `push` and `publish` and their standing
constraints. A clone without the file loses nothing.

Before planning or implementing new work, search both `tasks/` and the
relevant enclosing `gaps/` directories for pending defects, follow-ups, or
already-planned work. Read and cite matches before defining a new task. A gap
is not generic authorization to expand scope; follow `gaps/README.md`,
including deleting an entry in the commit that closes it.

## Cross-Platform Behavior And Tests

Treat Linux, macOS, and Windows as supported development targets. Code and
tests must not assume that the current host's filesystem, descriptor, process,
or shell behavior is portable. Pay particular attention to path syntax and
case handling, symlinks, `/proc` and `/dev/fd`, permissions and file locking,
signals and process trees, executable discovery, temporary directories, and
shell availability.

For every OS-sensitive change, either use portable APIs and cover all three
platforms, or make the narrower capability explicit: document it, gate native
tests by platform or capability, and test the supported fallback on the other
platforms. Passing on one contributor's OS is not sufficient evidence. When
other-OS validation is unavailable, state that limitation in the handoff.
Never weaken a security boundary merely to make another platform pass.

Before fielding a user request to improve **stability**, **performance**, or **security**, read `ARCHITECTURE.md` first. Check whether the issue is already addressed in the large-scope refactor proposals or the per-doc cleanup tables, and whether a relevant trigger condition has now been met. If the proposed work would touch a load-bearing piece named in `ARCHITECTURE.md` (fan-out, replay buffer, streaming throttle, transport framing, auth state), prefer reading the linked detailed doc and surfacing the existing trade-off to the user before writing code.

## Performance Measurement Hosts

Before treating benchmark output as regression evidence, read
`topics/performance-regression-suite.md`. The host need not be fully
uncontended, but the run must record its automatic capacity key plus start/end
CPU pressure, load, available physical/effective RAM, and swap evidence, with
enough headroom for the scenario. If contention is uncertain, run a small
speculative sample first and expand only when it reproduces. Compare historical
baselines and machine-specific ratchets only within one capacity key; portable
checked-in ceilings may run on any host whose samples show enough headroom, but
they are not same-machine historical evidence.

Small low-cost cloud instances may be created for performance verification
without a separate permission question. The launch still gets the normal
big-effect gate record and must install an external TTL or cleanup guard before
the instance starts. Record provider, region, instance class, and instance ID;
verify deletion after success or failure, including attached disks, reserved
addresses, and other paid resources.

## Architecture Mandates

Before modifying background loops, watchers, polling, retry timers, heartbeat
scheduling, session liveness, client stream/reconnect behavior, or server
catch-up paths, read `topics/architecture-mandates.md`. In particular, an idle
provider session and a closed client tab must never indefinitely consume server
resources.

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

## Client I18n Readiness

When adding or changing client UI copy, prefer `useI18n().t(...)` and entries
in `packages/client/src/i18n/en.json` for user-facing sentences, labels,
headings, placeholders, tooltips, and aria text. Do not force brand names,
provider names, keyboard keys, terminal commands, code tokens, protocol values,
or source-like renderer text into i18n keys unless the surrounding copy needs
translation. For a permissive advisory scan of obvious raw English copy, run
`pnpm i18n:scan`; use `--include-info` to inspect low-priority labels and
`--max-warnings <n>` only when intentionally ratcheting the check toward CI.

Add new strings to `en.json` only. Missing keys in the other locale files
fall back to English at runtime, and non-English locales are batch-updated
before a release (a maintainer step). Do not hand-translate per-locale
entries during feature work.

## Biome Import/Export Ordering

Do not apply Biome's organize-imports/exports assist as a routine cleanup.
Keep import/export edits scoped to the symbols needed by the change. Whole-file
ordering churn, especially in barrel files, obscures review and carries no YA
runtime-safety benefit. Run the project lint wrapper for diagnostics, but do not
turn a one-line import or export addition into a broad reorder solely to satisfy
organize-imports advice.

## Biome Formatting Is A Repository Invariant

`pnpm lint` remains a lint-only diagnostic command. `pnpm format:check` is the
separate non-writing formatter check, and CI requires both to pass. `pnpm
format` is the intentional repository-wide writer: the wrapper expands `.` to
the current tracked files and runs `biome format --write` over them.

During feature work in a shared or dirty worktree, format only the exact files
you edited:

```bash
node scripts/biome.cjs format --write path/to/file.ts path/to/other.tsx
```

Do not pass a directory or `.` for routine feature work, and do not use
`biome check --write` as a substitute: `check` combines additional concerns
that are intentionally separate here. A clean whole-repository `pnpm format`
is appropriate only for deliberately establishing a baseline or applying a
formatter-version migration.

Keep a broad mechanical rewrite in its own commit, time it against open PRs and
known in-progress work, and add its full hash to `.git-blame-ignore-revs` in a
follow-up commit. Never add a mixed behavior-and-format commit to that file.
The current checkout may enable the tracked blame metadata with `git config
blame.ignoreRevsFile .git-blame-ignore-revs`.

## Client CSS Architecture

Before adding or changing client styles, read `topics/css-architecture.md`.
Component-owned styles use co-located `*.module.css` files. The existing global
client stylesheets are frozen at ratcheting line-count ceilings: feature work
must extract enough legacy CSS to offset any unavoidable addition and must
never raise a ceiling as routine development.

Run `pnpm css:check` for client style changes. When an extraction lowers a
legacy file's line count, run `pnpm css:check --record` in the same change.
New non-module client stylesheets require an explicit documented exception in
the CSS architecture baseline; generated markdown/provider markup may keep its
narrow global vocabulary, but surrounding React-owned UI still belongs in a
module.

When changing a React component that still emits legacy global classes, or
when editing a legacy stylesheet, run `pnpm css:touched` before finishing. It
uses the current diff to distinguish bounded opportunities from coupled,
scattered, dynamic, or unresolved ownership. Drill into a reported owner with
`pnpm css:inventory -- --owner <component>`. Opportunistically extract a
clearly owned slice when it stays within the task's product surface and can use
the task's existing verification setup. Do not expand the task through
generated markup, open-ended dynamic classes, broad composition, or unprovable
visual states;
state the concrete deferral reason in the final handoff instead. Fresh
inventory, not a standing migration queue, decides whether a later extraction
is worthwhile.

## Vanilla Defaults

`topics/vanilla-defaults.md` is the overarching UX theory governing every new
user-visible feature. Out of the box, YA must feel exactly like the first-party
provider UIs users already know (Claude Code TUI, claude.ai, Codex): a
first-time user must not have to learn, or even notice, a new concept. Any
YA-novel user-visible behavior — including anything that modifies the user's
submitted text before it reaches the provider — ships configurable and
default-off. Narrow carve-out: an established cross-harness convention that
stays invisible until the user deliberately invokes it (e.g. a `!!`
shell-escape prefix, echoing Claude Code's `!` bash mode) is not YA-novel and
may ship always-on; any discoverable surface it adds (a sidebar entry) still
ships default-off. A configurable, visible resource-protection limit may also
default safer than the first-party harness only when invisible nested fan-out
can cause unpredictable token or quota burn, the provider default remains an
explicit choice, and the Maintainer has authorized the exact exception. See
`topics/vanilla-defaults.md` § Known Exceptions. A believed-but-unproven
benefit earns an option, never a default.
Novel features remain welcome; do not assume first-party harnesses already
cover all useful behavior. Read the topic before adding or enabling any
user-visible feature that is not configurable default-off.

## UI Tweak Visual Verification

By default, any UI tweak or layout/control-placement request ends with rendered
browser captures of the final result at 1000×600 and a phone width (375×812),
inspected by the agent against the request before claiming completion. Read and
inspect the captures sequentially, one image at a time; never batch image reads.
In-progress captures are optional.

Run final captures against a fresh dev-server process started from the current
worktree; do not reuse an already-running server. Use an unused port and, when
needed, a disposable data directory so the user's live server stays untouched.
A capture containing the `Server changed` banner or another stale-runtime
indicator is invalid: restart fresh and recapture.

An explicit user handoff overrides this default. If the user says they will
visually verify the result or asks to skip screenshots or visual validation, do
not capture screenshots or launch a browser solely for visual QA. Continue
relevant nonvisual checks, and state in the final response that visual
verification was left to the user rather than claiming it was performed. Do
not cite this repository default as a reason to disregard that handoff.
Protocol, commands, scope, and archive paths: `topics/ui-testing.md`.

## Observable Behavior Contracts

Before an implementation is complete, verify that every intentional observable
behavior it adds or changes is covered by a contract in the owning
`topics/*.md`; update or create that contract when it is not. State externally
testable outcomes and constraints, including deliberate failure or fallback
behavior, rather than implementation narration. Tests and commit messages are
evidence and history, not substitutes for the product contract.

## Naming Steps In Tactical Plans

Name every step in a `docs/tactical/*.md` plan for the product surface or the
work it covers — "source-control chrome", "delete the dead git-status rules",
"teach the unused-CSS report about modules". Number them in recommended order
if a handle is useful, matching the house form `### 4 — map source-control CSS
ownership`.

Do not invent a private code scheme. Lettered lanes with numbered slices
(`A1`, `C1.5`, `F0`) force every reader — including the maintainer who asked
for the plan — to hold a lookup table in their head before they can discuss the
work, and the letters convey nothing on their own. Group related steps under a
plain heading instead. If a step's name is hard to write, that usually means
its boundary is not yet decided.

Reusing a scheme that already exists in a document you are editing is fine;
extending it into a new document is not. When you rename, leave one compact
mapping table so older commit messages stay traceable.

## Retiring Completed Tacticals And Gaps

A `docs/tactical/*.md` whose work is landed, validated, and working has no
remaining job as a plan. Retire it by first migrating its durable content —
the contracts, invariants, and design reasoning a later reader still needs —
into the owning `topics/*.md`, then deleting the file in that same commit.
What does not survive the migration is a finished todo list and its recon
notes, which the tree and git history already record. Migration first is the
whole procedure: a deletion that skips it loses knowledge nothing else holds.

Retiring is periodic or at-will, never obligatory — a completed plan may be
kept, and some carry enough durable design to serve as a topic doc would.
Retire only plans you authored; leave another author's completed plans alone
unless they ask.

`gaps/*.md` is stricter: the entry is deleted in the commit that fixes it
(`gaps/README.md`).

A `topics/*.md` or a code comment that names a retired file needs no scrub.
The path stays a searchable handle:
`git log --diff-filter=D -- docs/tactical/<name>.md` finds the removal, and
`git show <sha>^:docs/tactical/<name>.md` prints the file back.

## Client/Server Backwards Compatibility

Before making the client depend on a server route, response field, event, or
changed semantic that is absent from a supported stable release, read
`topics/server-capabilities.md` and `topics/remote-hosted-compatibility.md`.
Identify whether the feature is core or optional and inspect every stable
server release in the applicable minimum horizon:

- optional features: the latest two stable releases and every stable release
  from the preceding 14 days;
- core functionality: the latest two stable releases and every stable release
  from the preceding 60 days.

Then present a compatibility plan before editing the client/server contract:
name the releases, new routes/fields/events, proposed capability or protocol
gate, exact behavior when it is absent, and whether any existing capability
meaning or older capable fallback changes. Pause for maintainer approval. An
originating request that already states and approves those decisions satisfies
the pause; do not ask twice.

Never expand an already-advertised capability to cover a contract older servers
do not provide. A new client must not call a new endpoint until its gate is
known present. Passing a support horizon permits human review only; it never
automatically removes a fallback or raises a compatibility floor. Security
exceptions follow `topics/hard-development-rules.md`.

Default a new global capability to `version-implied` when every official build
from its introducing release onward provides the contract. Use an explicit
sparse capability bit only when support is clearly experimental or
withdrawable, or can vary by build, host, or configuration. A version-implied
capability still receives a permanent ID for registry identity and source-ahead
advertisement, but released peers normally infer it from the version and do not
send a positive ID. An exceptional withdrawal uses the standard negative
capability set; do not classify anticipated variability as version-implied.

Suggested approval prompt:

> Compatibility review for `<feature>`: releases `<corpus>` lack
> `<routes/fields/events>`. I propose `<capability/protocol>`; without it the
> client `<fallback>` and makes no unsupported requests. Existing capability
> meanings and older capable behavior remain unchanged. Approve?

## Hard Development Rules

Follow `topics/hard-development-rules.md` for binding upstream-facing
development rules. Read it before changing deployment-sensitive defaults,
configuration precedence, relay or endpoint selection, provider/model settings,
hosted-client endpoint selection, migrations, or maintainer-specific deploy
configuration.

## Codex Version Bump Audit

Treat `package.json` `yepAnywhere.codexCli.expectedVersion` as the repo's
declared Codex CLI target version. When that value increases, or when Codex
API/protocol docs or checked-in Codex protocol files have changed in a way that
plainly implies a newer target version, do a routine compatibility check before
making YA source changes that respond to the Codex-side change.

The routine check may be automatic and read-only at first: inspect the
Codex-facing surfaces that are most likely to drift, especially
`packages/server/src/sdk/providers/codex*`,
`packages/shared/src/codex-schema/`, generated protocol files, and related
tests/scripts such as `scripts/update-codex-protocol.mjs`. A preliminary audit
that only identifies likely drift can happen immediately without asking first.

Before actually editing YA code for that compatibility work, pause and ask the
user whether they want the audit enacted now. Quote a prompt they can approve
or reuse, for example: "Audit YA for Codex CLI/API changes from <old> to <new>:
compare the changed Codex docs/files against our Codex-facing types, protocol
definitions, generated files, and tests; update whatever is needed for
compatibility; then summarize the behavioral changes, risks, and follow-on work."

Also state the likely benefit in one sentence, e.g. that this catches protocol
or schema drift early and reduces silent breakage in YA's Codex integration.

After any provider-refresh pass for Codex or Claude, update the tracked
compatibility marker in root `package.json`:

- `yepAnywhere.codexCli.compatibleThroughVersion` records the latest Codex CLI
  version whose YA-visible app-server protocol, model catalog, and runtime
  assumptions were checked or updated.
- `yepAnywhere.claudeCode.compatibleThroughVersion` records the latest Claude
  Code runtime version whose YA-visible SDK/package, model/command, and
  transcript/control assumptions were checked or updated; keep
  `yepAnywhere.claudeCode.claudeAgentSdkVersion` paired with the committed
  `@anthropic-ai/claude-agent-sdk` dependency when the SDK is refreshed.

This marker is the committed "compatible through / up to date as of" answer for
future minor-version checks. For Codex, keep `expectedVersion` in sync with
source/protocol refreshes that change the audited app-server target; a no-op
audit may advance only `compatibleThroughVersion` if the checked-in source did
not need to change.

## Reference Source (local-only)

`references/` holds upstream source cloned for local reading. It is gitignored
and absent on a fresh checkout, so never assume a given repo is present. When
working on the Codex provider — schema, scanner, normalization, app-server
protocol (`packages/server/src/sdk/providers/codex*`,
`packages/shared/src/codex-schema/`, generated protocol files) — inspect the
Codex Rust source rather than guessing from YA behavior. Run `pnpm
references:sync` to shallow-clone or align `references/codex` with the official
`rust-v<expectedVersion>` tag derived from `package.json`, then grep it
directly. `pnpm references:check` verifies alignment without changing the
checkout. The sync command refuses to overwrite local changes. When
deliberately comparing a newer Codex version, state that mismatch explicitly
and do not treat it as evidence for the pinned runtime without checking the
matching tag. The Claude SDK is not open source, so it is not included.

## Zero-Warning Commits

Before committing, the checks you run must be warning-free, not merely
passing: `pnpm lint` reports zero warnings, and test runs covering the
touched areas emit no runtime warnings (React "cannot update while
rendering", "not wrapped in act(...)", and similar). Fix the cause rather
than suppressing the report; a warning that must stand needs an inline
justification. DEVELOPMENT.md carries the contributor-facing statement of
the same policy.

“Pre-existing” is provenance, not an exemption. When a task's checks expose
warnings or source-format debt that can be safely isolated, clear them in a
separate cleanup commit instead of carrying them forward or folding them into
the behavior change. Use the owning formatter for source rewrites (Biome in
the current TypeScript/JavaScript tree; Ruff wherever a Python surface adopts
it). If the cleanup cannot be isolated safely, record the exact warning or
format check and the reason it remains in `gaps/`.

## Client Console Chatter Budget

When a change touches `packages/client`, or a client console looks
chatty, run `pnpm console:scan` with the pre-commit checks and read
[`topics/console-chatter.md`](topics/console-chatter.md) — it carries
the budget policy, the remediation preference order, the measurement
tools, and the ratcheting baseline.

The working tree may contain concurrent human or agent edits. Avoid reverting
or tidying unrelated changes unless the task directly requires them.

## Commit Message Guidance

Aim for a <=65 char subject, and strictly enforce a 72-column line wrap
for the body. Prefer bullet lists in the commit body when items are
numerous or complex; prose when the content is short and simple.

**Maintainer**, here, means the human reviewer or a future agent
(possibly you) re-reading this commit to understand or re-derive the
change.

For non-trivial commits, include a concise excerpt or synthesis of the
originating instruction (or motivating observation, when the change
wasn't user-prompted) that is feasible to land in the committed
changes. Summarize the motivating request and key implementation
direction so a Maintainer could paste the message, add their own
adjustments, and recreate something close to the intended result. Prune
digressions, secrets, and low-signal chat detail; do not aim for a
verbatim or exhaustive transcript.

The subject line is the conventional scannable headline result — keep
it scannable in `git log --oneline`. The synthesis lives in the body.
The 72-column body wrap applies to synthesis prose as well.

**Exemption**: skip the synthesis for mechanical or small + self-evident
changes — formatter passes, typo fixes, version bumps, trivial renames
with no substantive user direction. The conventional one-line message
alone is sufficient there.

**Series threading**: when a commit is part of a related series, append one
or more `Topic: <string>` trailers at the bottom of the body. The topic
string is freeform (descriptive phrasing fine; not constrained to a short
UPPERCASE codename). A series shares the exact same topic string across
its commits for each topic name you include; "first in wins": later
commits copy their topic lines verbatim so `git log --grep "Topic: ..."`
finds the chain. Use multiple `Topic:` lines when one commit touches
multiple topics, and switch a given topic only when it's obviously time for a
new one. Standalone commits with no expected follow-up: no trailer.

Example:
```
... body text ...
Topic: session-liveness
Topic: provider-model-glyphs
```

To avoid accidentally reusing a topic for an unrelated series, keep a
project-level `topics.md` log at the repo root and append each new
topic string to it when the series begins. The log is appended to
whether or not it's tracked in git. Format is freeform (not a
traditional ChangeLog) — typically a bulleted list with optional
one-line notes. Scan `topics.md` before opening a new series.
