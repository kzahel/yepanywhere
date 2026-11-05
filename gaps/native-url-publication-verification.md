# Native URL publication still has unresolved full-suite failures

Publication of `fdd7f3d78` succeeded to both source remotes and the hosted
client on 2026-11-05. Its focused startup checks pass, but full verification
is incomplete. Do not describe the release as fully green.

The local browser check reached case 492 of 509 before its 1,800-second
limit. Two failures remain outside the corrected native URL / visible prompt
expectations:

- `packages/client/e2e/artifact-viewer.spec.ts:136`: sequential typing / derived
  file address case failed. Its cause has not been established.
- `packages/client/e2e/session-creation-client.spec.ts:334`: lost creation
  reply and recovery read left `OWNED_PAGE_REQUEST` in the composer where
  the test expected an empty value. Preserve the conditional draft-settlement
  contract; capture admission, recovery, physical draft and revision receipts
  before changing clearing behavior.

The local server suite reported two failures and 7,116 passes. Its full log
was replaced by the next `verify` invocation; only the bounded publisher
summary remains under `.artifacts/publish/run.fxx6ZE/13-verify.out`. One
summary frame points into the native publication fixture. Reproduce and retain
full diagnostics rather than guessing its cause.

Upstream [CI 41995114687](https://github.com/kzahel/yepanywhere/actions/runs/41995114687)
failed the OpenCode relationship watcher case
`coalesces DB/WAL for all 128 sources and reacquires only the changed lineage`
in `packages/server/test/sessions/opencode-child-relationships.test.ts`:
its two-second `vi.waitFor` expired. This is not proof of the same local
failure or of a timing-only cause. The server-runtime/SQLite workflow passed.
The browser CI shard also failed; compare its retained errors before assigning
all failures to the obsolete expectations.

Retain each check's full logs across consecutive `verify` invocations, qualify
the two browser cases, and rerun the remaining full browser cases with an
explicit bounded plan. Do not raise deadlines or add retries to hide failures.
These adjacent failures were captured while correcting the native URL and
visible prompt expectations; no unrelated product repair is included.

Found 2026-11-05 while publishing native viewer URLs and visible saved prompts.
Contributing-model: 6.1-Sol
