# Module Boundary Refactor Discipline

> Large-file extractions must be provably behavior-preserving: every slice is
> move-only, lands in a narrowly named module, coordinates with the active
> ledgers that already own the touched file, and verifies at a tier matched to
> its blast radius.

Topic: typescript-module-boundary-refactor

Related topics: [architecture mandates](architecture-mandates.md),
[source transport](source-transport.md),
[session detail data layer](session-detail-data-layer.md),
[console chatter](console-chatter.md), and
[hard development rules](hard-development-rules.md).

Tactical worklog: the slice ledger, baseline gate, and large-file inventory
live in
[`docs/tactical/058-typescript-module-boundary-refactor.md`](../docs/tactical/058-typescript-module-boundary-refactor.md).
This topic is the binding contract; the tactical doc records progress against
it. When the two disagree, this topic wins and the tactical doc gets fixed.

## Contract

- The campaign goal is code health: smaller ownership boundaries along seams
  that already exist. It is not a line-count quota, a folder-taxonomy
  redesign, or an abstraction hunt.
- Line-count reduction is supporting evidence, not the reason to move code. A
  move is worthwhile only when it isolates a coherent domain, improves a
  route/test boundary, or separates provider-specific from generic behavior.
- The unit of work is a slice: one cohesive extraction, one commit, ledger row
  updated in the same commit. A slice small enough to review in one pass beats
  a slice that empties a file.
- Behavior is frozen. A behavior problem discovered mid-slice becomes a
  recorded follow-up, never an inline fix.

## What A Slice May Do

- Move symbols verbatim to a new or existing domain-named module.
- Update imports of the moved symbols in production and test files.
- Convert closure-captured dependencies of a moved helper into explicit
  parameters when the move requires it. This is the one permitted signature
  change; it applies to module-private helpers only and must be called out in
  the landing note.
- Move exported-for-test symbols and repoint their focused tests at the new
  module, so utility exports stop widening the big file's surface.

## What A Slice Must Not Do

- Change runtime behavior, response shapes, error strings, log messages,
  ordering, or timing.
- Rename public facades: route factory names, mounted paths, exported
  component props, provider interfaces, API client names, or test helper
  entry points.
- Apply organize-imports or formatting cleanup beyond the moved symbols.
- Delete dead code, fix latent bugs, or tighten types in passing — record
  them as proposed follow-ups instead.
- Add runtime dependencies, new abstractions, or provider-generalizing
  layers.
- Fix baseline test/log chatter inside a move slice. Chatter fixes are their
  own slices so regressions stay attributable.

## Naming And Placement

- No generic buckets. `helpers.ts`, `utils.ts`, `misc.ts`, and an
  `index.ts` grab-bag are all forbidden destinations. A new module gets a
  narrow domain name (`session-compact-thresholds.ts`,
  `session-claude-resume-guard.ts`) or the code stays put.
- Follow the sibling convention of the package being touched. Server routes
  use flat domain-named files in `routes/`; client code uses feature
  directories and hooks under existing homes such as `lib/sessionDetail/`.
  A slice never introduces a new folder taxonomy.
- The new module must not import the file it was extracted from. If the move
  needs a back-reference, the seam is wrong — stop and re-cut.
- Importers update to the new module path. No re-export shims from the old
  location, with one exception: documented public facades (for example the
  client `api` facade) keep their surface until callers migrate deliberately.

## Coordination

- A file already governed by an active ledger or tactical series is refactored
  through that ledger, not around it. Known owners:
  - `packages/server/src/routes/sessions.ts` →
    `docs/tactical/053-sessions-route-refactor-ledger.md` (SRR items);
  - session-detail data layer →
    `docs/tactical/043-session-detail-data-layer-plan.md`;
  - transport → `docs/tactical/057-source-transport-boundary.md`;
  - Project Queue / workstreams files, including route mounting in `app.ts`
    → `docs/tactical/054-workstreams.md` (WS items).
- Before claiming a slice, scan the ledger in doc 058, the owning docs above,
  and recent `git log` for an in-flight series touching the same files. If an
  overlap exists, defer the slice or coordinate in the owning doc first.
- Follow the [commit conventions](../docs/development/commits.md). Every slice
  commit carries `Topic: typescript-module-boundary-refactor`, plus the owning series' topic
  trailer when the slice lands through another ledger.

## Tripwire Matrix

Read the listed material before editing; run the listed extra verification on
top of the tiers below. Relocation is never permission to redesign the
behavior these documents protect.

| Touched area | Read first | Extra verification |
|---|---|---|
| Queues, timers, liveness, reconnect, catch-up, heartbeat, replay, fan-out | `topics/architecture-mandates.md` and its linked docs | `pnpm test:e2e:sdk` |
| Client transcript/rendering, scroll, row identity | `packages/client/RENDERING_PERFORMANCE.md`, `topics/scrollback-view-stability.md` | `pnpm --filter client test:e2e --grep-invert "physical Android"`; manual browser pass for scroll slices |
| Transport, relay, SRP, NaCl, readiness | `topics/source-transport.md` | full transport test files |
| Codex provider source/protocol | [Codex version bump audit rules](../docs/development/providers.md#codex-version-bump-audit) | Codex provider tests; stream/persisted render parity where relevant |
| `app.ts` mounting, middleware, auth | `topics/hard-development-rules.md` | route tests asserting preserved public paths |
| Moved user-visible copy | — | `pnpm i18n:scan` |
| Client console call sites | `topics/console-chatter.md` | `pnpm console:scan` must not exceed the committed budget |

## Verification Tiers

Every slice records which tier ran and why it suffices.

- **Tier 1 — every slice.** `pnpm --filter @yep-anywhere/shared build` plus
  the touched package's `tsc --noEmit`, the focused tests for the touched
  area, `node scripts/biome.cjs lint` on the changed files, and
  `git diff --check`. Before committing, review the staged move with
  `git diff --cached --color-moved=dimmed-zebra`: moved blocks should render
  as moves, and any non-move hunk must be explainable as an import edit or a
  declared dependency-parameter conversion.
- **Tier 2 — any slice at medium+ risk, and before ending a work session
  that landed slices.** Root `pnpm lint`, `pnpm typecheck`, `pnpm test`.
- **Tier 3 — route registration moves, client-visible surface moves, and
  phase completion.** Run the relevant full E2E suite plus the
  tripwire-matrix extras. For client/browser coverage, the default gate is
  `pnpm --filter client test:e2e --grep-invert "physical Android"`: this is
  the full client Playwright suite except the environment-gated physical
  Android device smoke. Run `pnpm test:e2e:android` only for slices that touch
  physical-device streaming, device bridge behavior, or Android-specific
  transport assumptions. For server/provider coverage, use
  `pnpm test:e2e:sdk` as relevant.

Skipping a required tier is allowed only with a recorded reason and a named
substitute check in the landing note.

## Stop Conditions

Halt the slice — shrink it, or revert and record — when any of these
surfaces:

- The code does not compile after a verbatim move without editing logic
  (anything beyond import paths and the permitted dependency-parameter
  conversion).
- The extraction exposes shared mutable state, module-init side effects, or an
  ordering dependency between the old and new module.
- The move would create an import cycle or a back-import into the source
  file.
- Tests need assertion changes, not just import-path changes.
- The file turns out to be owned by an in-flight series (see Coordination).

A stopped slice is not a failure; it is the discipline working. Record what
was found as a proposed follow-up with enough detail that a later session can
decide.

## Review Checklist

- Diff reads as moves under `--color-moved`; non-move hunks are imports or
  declared parameter conversions only.
- New module name states a domain, not a category of code.
- No re-export shim left behind; no import back into the source file.
- Public facades, mounted paths, response shapes, and error strings
  unchanged.
- Ledger row updated in the same commit; landing note lists moved symbols and
  the verification tier that ran.
- Console budget, i18n scan, and owning-ledger process respected where the
  tripwire matrix requires them.

## Growth Guard

Extraction alone lost to inflow: between 2026-07-07 and 2026-11-06 the hubs
this campaign had just trimmed grew by 30–190%, because each new feature
landed in the file that composes it. The guard addresses the inflow.

**Authoring rule.** A feature or fix that needs code in a file over the
threshold puts its logic in a domain-named module (the
[naming rules](#naming-and-placement) apply) and adds only the wiring to the
hub — the import, the call, the mount, the prop. If the wiring itself would
push the hub over its budget, offset it with a move-only extraction from the
same file, ideally along a seam already named in the tactical ledger, in a
separate commit ahead of the feature.

**Mechanism.** `pnpm lint` runs `scripts/check-source-file-budgets.mjs`
(`pnpm source:budgets` alone; `--list` prints every budgeted file with its
count and budget). Scope: tracked and untracked-not-ignored TS/JS files in
direct package source roots (`:(glob)packages/*/src/**`, so nested trees
such as `packages/android/app/src` are out), excluding tests, `__tests__/`,
`test/`, `*.test-support.*`, `generated/` trees and `.d.ts` files.

- Every in-scope file over the threshold (1,500 lines) needs an entry in
  `scripts/source-file-budgets.json`, and may not exceed its `maxLines`.
  The threshold is a constant in the script, not a budget-file field, so
  changing it is a reviewed code change rather than a one-number edit that
  would switch off the new-file ceiling. The 2026-11-06 baseline
  grandfathered the 55 files then over the threshold at their current
  length.
- A new file over the threshold fails. Split it before landing rather than
  adding an entry.
- `--record` only lowers budgets to current counts and retires entries for
  files now at or under the threshold. Run it in the same commit as any
  extraction, so freed lines cannot silently regrow.
- Raising a budget, or adding an entry, needs maintainer approval and a
  `"raise": { "from": <base maxLines or null>, "reason": "..." }` record on
  that entry. Raises are compared with a base revision: `HEAD` locally, so an
  unrecorded raise fails before commit, and in CI the pull request base or
  the commit before the push (`SOURCE_BUDGET_BASE`, fetched explicitly into
  the shallow checkout), so committing the raise does not hide it. An
  unavailable explicit base fails the check rather than skipping the
  comparison. In review the record is the visible, greppable trace of the
  exception.
- A stale entry (file deleted or moved out of scope) fails until removed.

Tests are outside the guard: scenario-ledger tests may stay long (see the
Phase 6 rules in the tactical worklog).

## Non-Goals

- Enforcing a hard repository-wide LOC limit. The growth guard is a
  per-file ratchet on existing oversized files plus a ceiling for new ones;
  it does not require shrinking any file to a target.
- Introducing a new folder taxonomy across the repo.
- Converting large components to compound component patterns.
- Replacing existing store/transport/session-detail plans.
- Adding virtualization, new queues, new transport buffering, or new provider
  abstractions as part of file-size cleanup.
- A shared pub/sub abstraction: `ARCHITECTURE.md` says wait for a third
  pub/sub.
