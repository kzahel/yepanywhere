# Comment review: packages/browser-extension, part 1

[Index and review procedure](README.md)

Snapshot: `3fe898ce5`. 16 blocks. Every item starts unreviewed.

Check an item only after recording **remove**, **keep**, or **rewrite/move** and a brief reason. Then apply and verify the corresponding source change.

- [ ] `f262526789eb7231` [packages/browser-extension/scripts/assemble.mjs:1–3](../../../packages/browser-extension/scripts/assemble.mjs#L1-L3) — **unreviewed** — `` // Complete the client build in dist/ as a loadable Manifest V3 extension. // `pnpm build:extension` runs the client's extension and worker Vite builds // first. ``
- [ ] `929d75821a905a32` [packages/browser-extension/scripts/assemble.mjs:24](../../../packages/browser-extension/scripts/assemble.mjs#L24) — **unreviewed** — ` // The store identity: its public key gives unpacked builds the store's id. `
- [ ] `7da4a776b07581a5` [packages/browser-extension/scripts/assemble.mjs:32](../../../packages/browser-extension/scripts/assemble.mjs#L32) — **unreviewed** — ` // The extension has its own store versions, independent of YA server tags. `
- [ ] `3ab0f939624aafd2` [packages/browser-extension/scripts/assemble.mjs:49–50](../../../packages/browser-extension/scripts/assemble.mjs#L49-L50) — **unreviewed** — ` // Web-host files the extension does not use. The web app manifest would also // collide with the extension's manifest.json. `
- [ ] `66b2601112cd8b60` [packages/browser-extension/scripts/assemble.mjs:83–85](../../../packages/browser-extension/scripts/assemble.mjs#L83-L85) — **unreviewed** — ` // None of these shows an install warning (docs/tactical/151 design rule). // activeTab lets a toolbar click read that one page's address; // contextMenus adds items to the toolbar button's right-click menu. `
- [ ] `668f5f9bb135e040` [packages/browser-extension/scripts/assemble.mjs:87–88](../../../packages/browser-extension/scripts/assemble.mjs#L87-L88) — **unreviewed** — ` // Requested per site from the side panel or options, never at install: // reading a granted site's addresses drives automatic lookup. `
- [ ] `a5a31afd5913d0df` [packages/browser-extension/scripts/package-store.mjs:1–2](../../../packages/browser-extension/scripts/package-store.mjs#L1-L2) — **unreviewed** — ` // Audit the actual loadable build, then create a store ZIP with its manifest // at the archive root. Python's standard ZIP library works without npm deps. `
- [ ] `a19a607f5493ddd3` [packages/browser-extension/scripts/publish-store.mjs:1](../../../packages/browser-extension/scripts/publish-store.mjs#L1) — **unreviewed** — ` // Submit the already accepted ZIP. Google owns review and final publication. `
- [ ] `fd4f9b26cfe1bea3` [packages/browser-extension/scripts/publish-store.mjs:59](../../../packages/browser-extension/scripts/publish-store.mjs#L59) — **unreviewed** — ` // The release job has a ten-minute bound. Never poll for Google's review. `
- [ ] `dfa356948e1cbd8d` [packages/browser-extension/scripts/publish-store.mjs:80](../../../packages/browser-extension/scripts/publish-store.mjs#L80) — **unreviewed** — ` // Never emit credentials, headers or arbitrary API response bodies. `
- [ ] `ccf2fc31f1bbb014` [packages/browser-extension/scripts/publish-store.mjs:85](../../../packages/browser-extension/scripts/publish-store.mjs#L85) — **unreviewed** — ` // cancelSubmission has an empty success response (including HTTP 204). `
- [ ] `074157de43944357` [packages/browser-extension/scripts/publish-store.mjs:102](../../../packages/browser-extension/scripts/publish-store.mjs#L102) — **unreviewed** — ` // The API returns PEM; Chrome manifests store the same SPKI bytes as base64. `
- [ ] `e42e382fd882bf00` [packages/browser-extension/scripts/publish-store.mjs:160–161](../../../packages/browser-extension/scripts/publish-store.mjs#L160-L161) — **unreviewed** — ` // The exact candidate has already passed CI and local integrity checks. // Cancel once; never burn the publisher's daily quota by retrying this POST. `
- [ ] `217d1081c3a0ce86` [packages/browser-extension/scripts/publish-store.mjs:178](../../../packages/browser-extension/scripts/publish-store.mjs#L178) — **unreviewed** — ` // Approval can race cancellation. Never upload over a newer publication. `
- [ ] `591e19197a20491a` [packages/browser-extension/scripts/publish-store.test.mjs:138](../../../packages/browser-extension/scripts/publish-store.test.mjs#L138) — **unreviewed** — ` // Cancellation may not be visible immediately. `
- [ ] `8a26c7f1824f0d11` [packages/browser-extension/src/options.js:1–2](../../../packages/browser-extension/src/options.js#L1-L2) — **unreviewed** — ` // Chrome's "Extension options" entry. The options live in YA Settings, under // the default host's route, so open that in this tab (docs/tactical/151). `
