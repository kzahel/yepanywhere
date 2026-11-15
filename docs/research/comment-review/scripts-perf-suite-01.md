# Comment review: scripts/perf-suite, part 1

[Index and review procedure](README.md)

Snapshot: `3fe898ce5`. 13 blocks. Every item starts unreviewed.

Check an item only after recording **remove**, **keep**, or **rewrite/move** and a brief reason. Then apply and verify the corresponding source change.

- [ ] `639f12db32db1b43` [scripts/perf-suite/browser-driver.mjs:1206–1207](../../../scripts/perf-suite/browser-driver.mjs#L1206-L1207) — **unreviewed** — ` // Lifecycle state outlives navigation/append timing-buffer resets. // Unmount deletes entries, bounding this to mounted fixture sessions. `
- [ ] `64623325d801e0d2` [scripts/perf-suite/browser-driver.mjs:1301](../../../scripts/perf-suite/browser-driver.mjs#L1301) — **unreviewed** — ` // The real request remains authoritative. `
- [ ] `1ada011eaf3d36a5` [scripts/perf-suite/host-profile.mjs:214–216](../../../scripts/perf-suite/host-profile.mjs#L214-L216) — **unreviewed** — ` // Darwin's free pages exclude reclaimable inactive/purgeable memory. Node's // availableMemory uses libuv's separate availability API for those pages; // os.freemem incorrectly made a cached host fail a 1 GiB availability gate. `
- [ ] `a908702efbc3989f` [scripts/perf-suite/process-fixture.mjs:55–59](../../../scripts/perf-suite/process-fixture.mjs#L55-L59) — **unreviewed** — ` /** * Console log level every measured server runs at, so a timed leg pays only * the logging cost a production server pays. Raising it for one leg makes that * leg's latency and memory numbers incomparable with the rest. */ `
- [ ] `fba4388df34963b4` [scripts/perf-suite/process-fixture.mjs:61–62](../../../scripts/perf-suite/process-fixture.mjs#L61-L62) — **unreviewed** — `` /** Accepted `LOG_LEVEL` names; `LOG_LEVELS` in * packages/server/src/logging/logger.ts owns this list. */ ``
- [ ] `e106b22df20c0051` [scripts/perf-suite/runner-modules.test.mjs:285](../../../scripts/perf-suite/runner-modules.test.mjs#L285) — **unreviewed** — ` // stopServer or the process-group assertion remains the primary result. `
- [ ] `7228814bd5a93d65` [scripts/perf-suite/simulated-provider-worker.mjs:34](../../../scripts/perf-suite/simulated-provider-worker.mjs#L34) — **unreviewed** — ` // Negotiate before launch stdin: the host sends managed identities only after hello. `
- [ ] `cd53ed18a4179196` [scripts/perf-suite/simulated-transcript.mjs:4–5](../../../scripts/perf-suite/simulated-transcript.mjs#L4-L5) — **unreviewed** — ` // Fixture persistence for the browser's REST refreshes. This is not the real // provider SDK writer; it preserves exactly the simulated turn's identities. `
- [ ] `13b933b69b08e561` [scripts/perf-suite/specialized-driver.mjs:33–39](../../../scripts/perf-suite/specialized-driver.mjs#L33-L39) — **unreviewed** — `` /** * Console log level for the owned-provider leg's server. Defaults to the level * every other measured server runs at, so its latency and memory numbers stay * comparable; `YA_PERF_OWNED_PROVIDER_LOG_LEVEL` raises it for a diagnostic * rerun whose failure tail needs more than errors, and the resolved level is * recorded with the leg's numbers. */ ``
- [ ] `760345d9b1116ffc` [scripts/perf-suite/specialized-driver.mjs:585](../../../scripts/perf-suite/specialized-driver.mjs#L585) — **unreviewed** — ` // Browser setup/replay is independent of the accelerated reap clock. `
- [ ] `a20dea1e3189a7f4` [scripts/perf-suite/specialized-driver.mjs:621–622](../../../scripts/perf-suite/specialized-driver.mjs#L621-L622) — **unreviewed** — ` // Match the browser's canonical setting. Leaving this unspecified // makes its first send a launch-setting change and restarts the worker. `
- [ ] `1557a358ecab45ea` [scripts/perf-suite/specialized-driver.mjs:802–803](../../../scripts/perf-suite/specialized-driver.mjs#L802-L803) — **unreviewed** — ` // The raw observer remains subscribed after Chromium closes. Prove that // viewer retention survives a full deadline before timing unsubscribe. `
- [ ] `22fed01b06dae967` [scripts/perf-suite/telemetry.mjs:83](../../../scripts/perf-suite/telemetry.mjs#L83) — **unreviewed** — ` // Older execution revisions have no separate metadata clock. `
