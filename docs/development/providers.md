# Provider development

[Contributor guide](../../DEVELOPMENT.md) · [Development docs](README.md)

Commands and code paths below are relative to the repository root unless stated
otherwise.

Read the applicable [provider refresh](../../topics/provider-refresh.md)
sections for provider-specific sources, probes, and refresh evidence. This
guide owns the shared contributor procedures and Codex audit approval rule.

## Native behavior qualification

Before provider or shared scheduling refactors, establish the relevant behavior
with [native provider scenarios](../../topics/native-provider-testing.md).
`pnpm test:providers` runs real executables with scripted local model responses,
without inference. Extend shared actions/assertions where semantics match and
keep provider-specific capabilities explicit. Missing local routing or binaries
must remain an explicit qualification gap, not a successful fake/paid fallback.
Run applicable scenarios when upgrading a qualified executable and keep its
test pin aligned with the audited target.

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

`CODEX_CLI_MINIMUM_SUPPORTED_VERSION` in
`packages/server/src/services/CodexUpdateChecker.ts` is the opposite bound:
the oldest Codex CLI that YA's integration works with, or `null` when no such
floor is known. It is the only trigger for the update dialog an administrator
sees, so raise it only for a known incompatibility, such as removing an older
protocol fallback, never merely because a newer release exists. Per-feature
version gates that degrade gracefully do not raise it. See
[provider installation updates](../../topics/provider-installation-updates.md#update-notices).

This marker is the committed "compatible through / up to date as of" answer for
future minor-version checks. For Codex, keep `expectedVersion` in sync with
source/protocol refreshes that change the audited app-server target; a no-op
audit may advance only `compatibleThroughVersion` if the checked-in source did
not need to change.

## Reference Source

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

The Codex Rust source is `codex-rs` under `references/codex`.
`pnpm clone-references` remains an alias for the sync command.

## Validating Session Data

Validate JSONL session files against Zod schemas:

```bash
# Validate all sessions in ~/.claude/projects
npx tsx scripts/validate-jsonl.ts

# Validate a specific file or directory
npx tsx scripts/validate-jsonl.ts /path/to/session.jsonl
```

Run this after schema changes to verify compatibility with existing session data.

## Validating Tool Results

Validate `tool_use_result` fields from SDK raw logs against ToolResultSchemas:

```bash
# Validate sdk-raw.jsonl (default location)
npx tsx scripts/validate-tool-results.ts

# Summary only (no error details)
npx tsx scripts/validate-tool-results.ts --summary

# Filter by tool name
npx tsx scripts/validate-tool-results.ts --tool=Edit
```

The SDK provides structured `tool_use_result` objects alongside tool results. These are logged to `~/.yep-anywhere/logs/sdk-raw.jsonl` when `LOG_SDK_MESSAGES=true` is set. Run this script after adding new tool schemas or when debugging tool result parsing.

## Type System

Types are defined in `packages/shared/src/claude-sdk-schema/` (Zod schemas as source of truth).

Key patterns:
- **Message identification**: Use `getMessageId(m)` helper which returns `uuid ?? id`
- **Content access**: Prefer `message.content` over top-level `content`
- **Type discrimination**: Use `type` field (user/assistant/system/summary)
