# Boot instructions are refused for sandboxed sessions

A session cannot have both [boot instructions](../topics/session-boot-instructions.md)
and a session sandbox: the launch is refused. Each mechanism redirects the
provider's home on its own terms. For Codex, the sandbox sets `CODEX_HOME` to
its private provider state directory (`packages/server/src/session-sandbox.ts`,
`sandboxEnv.CODEX_HOME = providerStateDir`), and its one-time bootstrap copies
the operator's `skills/` into that directory; a boot home would need a second
`CODEX_HOME`. For Claude, the sandbox's private `CLAUDE_CONFIG_DIR` bootstrap
also copies `skills/`, which leaving out the `user` setting source would
suppress, but the composition has not been probed.

Not fixed with the feature because v0 creation, its only entry point, does not
request a sandbox, and the sandbox bootstrap is shared with limited-user
launches whose instruction policy differs.

Likely fix: make the sandbox state directory the boot home. Skip `skills/` in
its bootstrap when the session has boot instructions, keep the same
`developer_instructions` and per-skill disabling, and probe that a sandboxed
Claude session with the `user` source left out still reads its bound
credentials.

Found 2026-11-25 while specifying session boot instructions.
