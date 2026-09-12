# Claude history is empty for a macOS /tmp project alias

An isolated real-Claude session created through `POST /api/projects` with a
`/tmp/ya-live-*/project` path kept its original worker and completed commands
across Hono reload. Claude SDK 0.3.258 resolved the working directory to
`/private/tmp/ya-live-*/project` and wrote the complete native transcript under
`~/.claude/projects/-private-tmp-ya-live-*-project/`.

YA's session-detail route for the selected `/tmp` project returned an empty
`messages` array and null title while the native JSONL retained the turns. The
browser consequently showed only the surviving live tail after reload.
Registering the canonical path afterward did not repair the existing session's
working-project routing. A fresh alias-project probe initially returned its two
live user/assistant records, then returned `404 Session not found` after an
ordinary terminal shutdown and restart despite its native JSONL remaining on
disk (`evidence/alias-baseline.json`). This also affects ordinary durable
history lookup, not only active-turn reattachment. The SDK query and its pending
approval promises still survive the reload.

`packages/server/src/routes/projects.ts` uses the synchronous
`canonicalizeProjectPath` before assigning the project id; investigate physical
path resolution and the session reader/working-project mapping together. A
repair must preserve existing YA URL ids and avoid creating duplicate catalog
rows or rewriting unrelated project membership.

The provider-host validation uses a canonical `realpath` fixture and now asserts
persisted history in addition to live continuity. General symlink/project-id
migration is outside that lifecycle test change; do not treat the fixture
correction as a fix for this defect. Run evidence is in
`.artifacts/ui-testing/2026-09-12-provider-host/alias-fixture-state.json` and its
isolated native transcript.

Found 2026-09-12 while validating tactical 128 with real Claude sessions on macOS.
