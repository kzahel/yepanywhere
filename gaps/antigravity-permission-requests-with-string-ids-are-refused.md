# Antigravity refuses `agy`'s permission requests, which deny the tool

`agy` 1.5.13 and 1.5.14 send ACP `session/request_permission` with a string
JSON-RPC ID (`"id":"1"`). YA's transport only treats a numeric ID as a
permission request
([`receive`](../packages/server/src/sdk/providers/antigravity-runtime.ts#L448)).
It answers the string-ID request with "Unsupported client method", and `agy`
records that as the user's denial: the tool step ends `ERROR` with "user
denied permission", and in the observed cases the prompt then ended
(`end_turn`) without another model request. YA never shows a prompt. Every session that is not launched with bypass permissions is
affected for every tool `agy` asks about, such as `write_file` and
`run_command`. Auto-approved reads are not.

Reproduced 2026-11-22 with the plan 195 probe
(`scripts/perf-repro/antigravity-native-probe.mjs measure --verbose`) in
`agy`'s default mode. Before the probe answered string-ID requests itself, a
`write_file` and a `run_command` were each denied without a prompt. The
controlled ACP peer in `antigravity.test.ts` uses a numeric ID, and the native
fixture launches with bypass permissions, so no test covers this.

Not fixed here: plan 195 step 2 ships only tests and evidence. The cheap fix
is to accept string and numeric IDs for client-bound requests and echo the ID
back unchanged. The test is a native default-mode case in which a scripted
`write_file` reaches `onToolApproval` and the file is written after Allow.

Found 2026-11-22 while measuring Antigravity's native log for plan 195 step 2.
