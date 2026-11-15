# Comment review: research/relay-artifact-frame-spike, part 1

[Index and review procedure](README.md)

Snapshot: `3fe898ce5`. 10 blocks. Every item starts unreviewed.

Check an item only after recording **remove**, **keep**, or **rewrite/move** and a brief reason. Then apply and verify the corresponding source change.

- [ ] `15e6b3e3808c0f11` [research/relay-artifact-frame-spike/spike.mjs:1–14](../../../research/relay-artifact-frame-spike/spike.mjs#L1-L14) — **unreviewed** — ` // Spike: can a service worker on a separate content origin serve a scripted // HTML artifact whose bytes come only from the embedding YA page? // // The "YA page" origin holds the artifact files (standing in for reads over // the encrypted relay). The content origin serves only a bootstrap page and // a service worker; every artifact path 404s on its network. An artifact that // renders therefore proves its bytes went parent -> broker frame -> worker. // // Run: node research/relay-artifact-frame-spike/spike.mjs [--headed] // Needs Google Chrome installed (Playwright channel "chrome"). // Optional env: SPIKE_MODE (3pc-allowed | 3pc-blocked | playwright-context), // SPIKE_KIND (same-site | cross-site), SPIKE_STOP (all | idle; default stops // this case's worker by version), SPIKE_OAC=1 (send Origin-Agent-Cluster: ?1 // on the bootstrap). Results print as JSON. `
- [ ] `57bf2c09ce8cc40c` [research/relay-artifact-frame-spike/spike.mjs:37](../../../research/relay-artifact-frame-spike/spike.mjs#L37) — **unreviewed** — ` // --- artifact fixture, readable only through the parent page -------------- `
- [ ] `fca9b801be9b5c36` [research/relay-artifact-frame-spike/spike.mjs:81](../../../research/relay-artifact-frame-spike/spike.mjs#L81) — **unreviewed** — ` // --- pages ----------------------------------------------------------------- `
- [ ] `d3ca5fb26cae0ce1` [research/relay-artifact-frame-spike/spike.mjs:211](../../../research/relay-artifact-frame-spike/spike.mjs#L211) — **unreviewed** — ` // --- servers --------------------------------------------------------------- `
- [ ] `de986815555cc650` [research/relay-artifact-frame-spike/spike.mjs:269](../../../research/relay-artifact-frame-spike/spike.mjs#L269) — **unreviewed** — ` // Artifact paths must never be answered by the network. `
- [ ] `66ea504debfd7c8e` [research/relay-artifact-frame-spike/spike.mjs:292](../../../research/relay-artifact-frame-spike/spike.mjs#L292) — **unreviewed** — ` // --- browser runs ---------------------------------------------------------- `
- [ ] `8b50580faeae9edf` [research/relay-artifact-frame-spike/spike.mjs:389](../../../research/relay-artifact-frame-spike/spike.mjs#L389) — **unreviewed** — ` // Throughput of a streamed body through parent -> broker -> worker. `
- [ ] `0d79e97c689e83f4` [research/relay-artifact-frame-spike/spike.mjs:408](../../../research/relay-artifact-frame-spike/spike.mjs#L408) — **unreviewed** — ` // Navigate inside the artifact, then reload the inner frame. `
- [ ] `7b868231f496356c` [research/relay-artifact-frame-spike/spike.mjs:430](../../../research/relay-artifact-frame-spike/spike.mjs#L430) — **unreviewed** — ` // Kill the worker; the next request must restart it and still find the broker. `
- [ ] `cc11218e0b7ef780` [research/relay-artifact-frame-spike/spike.mjs:515](../../../research/relay-artifact-frame-spike/spike.mjs#L515) — **unreviewed** — ` // Playwright's default (off-the-record) browser context. `
