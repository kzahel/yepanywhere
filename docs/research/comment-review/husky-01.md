# Comment review: .husky, part 1

[Index and review procedure](README.md)

Snapshot: `3fe898ce5`. 3 blocks. Every item starts unreviewed.

Check an item only after recording **remove**, **keep**, or **rewrite/move** and a brief reason. Then apply and verify the corresponding source change.

- [ ] `aac429349fe3b073` [.husky/pre-push:1–11](../../../.husky/pre-push#L1-L11) — **unreviewed** — `` #!/usr/bin/env sh # Clone-durable push guard: no commit may credit an agent as an author. # # `package.json`'s prepare script runs husky, which points core.hooksPath here, # so this is active in any clone after an install. The check itself is # scripts/check-no-agent-attribution.mjs; see AGENTS.md § Agent Attribution. # # Git supplies the destination on argv and the refs on stdin. Both are passed # through, because what counts as outgoing depends on which remote is being # pushed to — the whole point is to fail before a violation reaches the first # destination that accepts it. ``
- [ ] `c6d405f13166d5e8` [.husky/pre-push:21](../../../.husky/pre-push#L21) — **unreviewed** — ` # Tee stdin so a machine-local guard can read the same ref lines. `
- [ ] `c2eb4081029cf571` [.husky/pre-push:26–27](../../../.husky/pre-push#L26-L27) — **unreviewed** — ` # A machine-local guard may enforce more than this repository requires; run it # too when present. Absence is normal and not a failure. `
