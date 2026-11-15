# Comment review: research/content-worker-localhost-spike, part 1

[Index and review procedure](README.md)

Snapshot: `3fe898ce5`. 3 blocks. Every item starts unreviewed.

Check an item only after recording **remove**, **keep**, or **rewrite/move** and a brief reason. Then apply and verify the corresponding source change.

- [ ] `2ee5652e4d5eef2c` [research/content-worker-localhost-spike/spike.mjs:314](../../../research/content-worker-localhost-spike/spike.mjs#L314) — **unreviewed** — ` // Relay origin policy compares complete origins, including dynamic port. `
- [ ] `34d345106d32c588` [research/content-worker-localhost-spike/worker.js:1](../../../research/content-worker-localhost-spike/worker.js#L1) — **unreviewed** — ` // The network serves this fixed script; artifact bytes only come from a live broker. `
- [ ] `2a19eff729f03384` [research/content-worker-localhost-spike/worker.js:38](../../../research/content-worker-localhost-spike/worker.js#L38) — **unreviewed** — ` // No in-memory registration map: a stopped worker rediscovers the owner. `
