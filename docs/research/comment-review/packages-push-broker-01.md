# Comment review: packages/push-broker, part 1

[Index and review procedure](README.md)

Snapshot: `3fe898ce5`. 11 blocks. Every item starts unreviewed.

Check an item only after recording **remove**, **keep**, or **rewrite/move** and a brief reason. Then apply and verify the corresponding source change.

- [ ] `c0e38be5aba4a233` [packages/push-broker/src/app.ts:142–143](../../../packages/push-broker/src/app.ts#L142-L143) — **unreviewed** — ` // Recheck after the awaited body read so revocation during upload cannot // authorize a target mutation from an earlier credential snapshot. `
- [ ] `43b487bdd714f984` [packages/push-broker/src/app.ts:248–250](../../../packages/push-broker/src/app.ts#L248-L250) — **unreviewed** — ` // The first authentication supplies stable rate-limit keys. Recheck // after reading the body so a concurrently revoked send capability // cannot reach the provider. `
- [ ] `6f95456969672cd5` [packages/push-broker/src/client-ip.ts:34–37](../../../packages/push-broker/src/client-ip.ts#L34-L37) — **unreviewed** — ` /** * Resolve a source address without trusting caller-controlled forwarding * headers unless the immediate peer is explicitly configured as a proxy. */ `
- [ ] `6463d4b8765e6fb1` [packages/push-broker/src/credentials.ts:23](../../../packages/push-broker/src/credentials.ts#L23) — **unreviewed** — ` // SQLite hands back BLOB columns as Uint8Array on both supported runtimes. `
- [ ] `3405a68652eb7f31` [packages/push-broker/src/providers/firebase.ts:86](../../../packages/push-broker/src/providers/firebase.ts#L86) — **unreviewed** — ` // Android owns filtering and tray presentation even without an Activity. `
- [ ] `68aeeb4c560e3264` [packages/push-broker/src/providers/firebase.ts:88](../../../packages/push-broker/src/providers/firebase.ts#L88) — **unreviewed** — ` // Apple presents the bounded generic alert while the app is suspended. `
- [ ] `af410d3e80ca1fc2` [packages/push-broker/src/rate-limiter.ts:18–23](../../../packages/push-broker/src/rate-limiter.ts#L18-L23) — **unreviewed** — ` /** * A bounded, process-local fixed-window rate limiter. * * Map insertion order acts as a small LRU. There is no cleanup timer, so an * idle broker retains no scheduled work. Restarting the process resets limits. */ `
- [ ] `63beaf32f5828d62` [packages/push-broker/src/repository.ts:80–84](../../../packages/push-broker/src/repository.ts#L80-L84) — **unreviewed** — ` /** * One prepared statement per distinct SQL, reused for the repository's life. * Preparing per call repeats SQLite's parse and plan work on every request, * and under Bun each statement also stays alive until the database closes. */ `
- [ ] `cf967d6ef6148016` [packages/push-broker/test/repository.test.ts:21](../../../packages/push-broker/test/repository.test.ts#L21) — **unreviewed** — ` // The shared adapter's close is idempotent, so no open check is needed. `
- [ ] `9a3d840dac500545` [packages/push-broker/test/repository.test.ts:48](../../../packages/push-broker/test/repository.test.ts#L48) — **unreviewed** — ` // Built-in SQLite returns BLOB columns as Uint8Array, not Node Buffer. `
- [ ] `3d4b7b31925be5b7` [packages/push-broker/vitest.config.ts:6–8](../../../packages/push-broker/vitest.config.ts#L6-L8) — **unreviewed** — ` // See packages/relay/vitest.config.ts: the broker reuses one prepared // statement per SQL, and only a ceiling makes a regression to preparing // per call visible on Node, where it looks free. `
