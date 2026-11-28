# Provider Authoring (new-provider-for-harness)

> Map for adding a new agent provider (like `pi` recently) to the harness.
> Aims to be sufficient for an expert or agent working from the harness source
> plus a decent SDK doc plus the ability to snoop some session JSONL — without
> reverse-engineering the whole codebase first.

Topic: provider-authoring

See also: [provider-output-contract](provider-output-contract.md) (the
normalized-output half of this map: the spec for what a provider's
normalization must produce), [provider-abstraction](provider-abstraction.md)
(when to promote a
provider/model conditional to the `AgentProvider` seam — distinct from *how to
add a provider*), [stream-persisted-render-parity](stream-persisted-render-parity.md)
(a contract every provider must satisfy), [provider-state-machine](provider-state-machine.md),
[provider-installation-updates](provider-installation-updates.md) (mandatory
coordination before a provider gains an in-app installer/updater),
[provider-session-tree](provider-session-tree.md), [codex-sessions](codex-sessions.md),
[pi-provider](pi-provider.md). Dev doc:
`docs/project/multi-provider-integration.md` (the kzahel-organized architecture
overview — interface, per-provider session formats/storage, comparison table).

## Documentation sufficiency (honest assessment, 2026-07-01)

Adding a provider today is a **read-the-source-plus-snoop-JSONL** exercise, not
a spec-driven one. What exists:

- **Source of truth for normalized objects is code, not prose.** The message /
  content / tool-result shapes YA renders are the Zod schemas in
  `packages/shared/src/claude-sdk-schema/` (`message/`, `content/`, `tool/`,
  `entry/`, `guards.ts`). These are authoritative and validated against real
  sessions; there is no separate hand-written object-format doc that could drift
  from them.
- **Per-provider JSONL/quirk knowledge is scattered** across per-provider
  topics (`codex-sessions`, `codex-metadata-scanner`, `pi-provider`, `grok`,
  `opencode-backend`, …), inline code comments, and the reader/normalizer
  modules — not centralized. `docs/project/multi-provider-integration.md` is the
  best single architectural overview but is a comparison/overview, not a
  step-by-step authoring guide.
- **The interface contract is discoverable but implicit.** `AgentProvider`
  (`packages/server/src/sdk/providers/types.ts`) is the surface; the fastest
  authoring path is to copy the closest existing provider and diff.

This topic is the intended entry point that ties those together. It is a
pointer-hub by design (per the request "even if it's just a pointer"); deepen it
as real authoring friction is found, rather than duplicating the schemas.

## The two halves a provider must implement

1. **Live session** (running turns): implement `AgentProvider`
   (`sdk/providers/types.ts:191`) — install/auth checks, `startSession`
   yielding an `AsyncIterableIterator` of messages, a send `queue`, and `abort`.
   Existing impls: `sdk/providers/{claude,codex,codex-oss,gemini,gemini-acp,opencode,grok-acp,pi}.ts`.
2. **Persisted reader** (reload from disk): a `sessions/<provider>-reader.ts`
   that reads the provider's stored format and produces the same normalized
   `Message` objects the live path yields. Existing: `codex-reader.ts`,
   `pi-reader.ts`, `grok-reader.ts`, plus the shared `reader.ts`.

Both halves converge on the shared `Message`/render-item model via
normalization (`sessions/normalization.ts` dispatch; provider-specific
normalizers like `codex/normalization.ts`). A new provider's normalized output
must validate against the `claude-sdk-schema` Zod types.

## CLI discovery and launch contract

An installed-file check is not proof that Node can launch the file. Windows
`where` commonly returns multiple CRLF-delimited PATHEXT matches, including
extensionless and `.cmd` npm shims. Providers must parse those as ordered
candidates and then apply the launch mechanism's stronger requirements:

- `execFile()` and shell-free `spawn()` require a directly executable target;
  they must not advertise an unresolved `.cmd` shim as usable;
- a provider distributed as JavaScript may represent its launch as the current
  Node executable plus a package entrypoint argument, as Pi does;
- a provider with a packaged native executable should prefer it, as OpenCode
  does for model discovery;
- an existing provider that deliberately owns a shell-compatible process path
  may select a Windows `.cmd` / `.bat` shim, but must skip an extensionless npm
  shell script; and
- explicit configured paths are authoritative. A missing or unsafe explicit
  target fails closed instead of drifting to another PATH installation.

If YA can mutate the installation, discovery and launch are also readers of a
shared installation family. The updater must use the coordinator in
[provider-installation-updates](provider-installation-updates.md); do not add an
independent `update()` method to one provider row when aliases may share the
same executable.

`parseCommandLookupOutput()` owns only CRLF/LF splitting, trimming, blank-line
removal, and order. `selectCommandLookupTarget()` adds the coarse Windows
direct-versus-shell extension rule; provider-specific package layouts and
executable preferences remain with the provider. When a provider has more than
one process call site, resolve one launch descriptor and use it for version
probes, catalogs, sessions, and contract tests so detection cannot disagree
with startup.

The shared [CLI installation service](provider-cli-installations.md) owns
server/profile selection, managed overrides and cached execution verification.
An adapter supplies discovery, provenance/ranking, launch descriptors, relevant
installation files and an optional offline execution recipe. Unsupported
verification is distinct from failure. Codex and both Antigravity launch forms
use this boundary; integrating another provider does not authorize an updater,
auth flow or new platform qualification.

## The convergence contract: paired stream items settle to persisted shape

The live and reader halves are two producers of the *same* session, so they
must strongly converge for items present in both — see
[stream-persisted-render-parity](stream-persisted-render-parity.md). Concretely,
structured facts that define a durable tool call's identity, ordering,
grouping, parameters, result, or settled layout must be recoverable into the
same fields on reload. Useful live-only tail events may render transiently;
they are tested as a lifecycle rather than forced into provider persistence.
Add a stream+persisted fixture to `test/render-parity.test.ts` for paired tool
items; a green unit test on one path is not proof the settled render converges.

## Snooping real session JSONL

- **Validate a provider's persisted sessions** against the schemas:
  `npx tsx scripts/validate-jsonl.ts [path]` (see
  [session validation](../docs/development/providers.md#validating-session-data)).
  This is the fastest way to learn a format's real shape and catch schema gaps.
- **Capture live SDK objects**: run with `LOG_SDK_MESSAGES=true` →
  `~/.yep-anywhere/logs/sdk-raw.jsonl`, then
  `npx tsx scripts/validate-tool-results.ts` to check `tool_use_result` shapes.
- **Storage locations** per provider are tabulated in
  `docs/project/multi-provider-integration.md` (e.g. Codex `~/.codex/sessions/`,
  OpenCode SQLite under `~/.local/share/opencode/`).

## Gaps worth closing (if authoring friction recurs)

- A short "minimum viable provider" checklist (interface methods, reader,
  normalizer, parity fixture, session-tree/liveness hooks) would turn this hub
  into a guide.
- Per-provider "JSONL object shapes" are only in code/schemas; a generated
  schema reference (from the Zod types) would document the normalized objects
  without a drift risk.

## Adding a specialized tool display

Provider validity does not prove renderability. Add the consumed fields to a
bounded client display schema in `components/renderers/tools/displayContracts.ts`,
declare its input/result/failure, supported variants and standalone policy in
`toolDisplayContracts.ts`, then bind callbacks with `defineTool`. Callback
arguments are schema outputs. Do not import a renderer outside the registry,
retrieve callbacks, assert payloads into display types, or use permissive
schemas to grant rich access. Shared utilities belong in owned helper modules.

Add independent positive controls for every variant to the exhaustive
`__fixtures__/displayFixtures.ts` manifest. Describe source provenance or the
reason a variant is synthetic. Add per-operation expectations to the exhaustive
`displayExpectations.ts` manifest, including explicit intentionally empty
operations and meaningful standalone output. Include a failure control when a
failure contract is declared. Keep provider-shape controls independent of the
display fixtures: `observed-tool-display-specimens.ts` distinguishes sanitized
observed JSONL shapes, SDK-declaration controls, and synthetic adapter probes.
Reconstructed SDK envelopes are not captured live traffic.
The registry suite mounts all operations,
mutates nested fields, and checks lifecycle, raw inspection and zero unexpected
exception catches. Add native live/durable pairs to
`server/test/utils/native-tool-display-corpus.ts` for distinct provider seams.
Both the server parity suite and the mounted client suite execute those pairs;
synthetic variants and unavailable native facts must have explicit coverage
notes in the parity topic. Keep developer diagnostic inventory separate.

Root `typecheck` includes client positive/negative type fixtures, the mounted
client tool-display suite and all server TypeScript tests. Root `test` runs
registry and native suites.
Root `lint` includes `tools:check`, with parser-backed negative probes for
private imports, callback access and concrete payload assertion patterns.
These gates detect specific escapes, not arbitrary TypeScript unsoundness.
