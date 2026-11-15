# Comment review: sharing-worker/src, part 1

[Index and review procedure](README.md)

Snapshot: `3fe898ce5`. 3 blocks. Every item starts unreviewed.

Check an item only after recording **remove**, **keep**, or **rewrite/move** and a brief reason. Then apply and verify the corresponding source change.

- [ ] `1bf36377e076ba78` [sharing-worker/src/index.ts:1–15](../../../sharing-worker/src/index.ts#L1-L15) — **unreviewed** — `` /** * Cloudflare Worker for serving and uploading shared session snapshots. * * R2 binding provides direct bucket access — no API tokens or sigv4 needed. * Uploads are authenticated with a shared secret (set via `wrangler secret put UPLOAD_SECRET`). * * Setup: * cd sharing-worker * npm install * npx wrangler deploy * npx wrangler secret put UPLOAD_SECRET # pick any secret * * Then create ~/.yep-anywhere/sharing.json: * { "workerUrl": "https://yep-sharing.<account>.workers.dev", "secret": "<same secret>" } */ ``
- [ ] `a5a7c22a3d253ce7` [sharing-worker/src/index.ts:25](../../../sharing-worker/src/index.ts#L25) — **unreviewed** — ` // strip leading / `
- [ ] `b990bfcea082aeb9` [sharing-worker/src/index.ts:41–42](../../../sharing-worker/src/index.ts#L41-L42) — **unreviewed** — ` // If stored gzipped (legacy), decompress before serving. // Cloudflare edge handles compression automatically for browsers. `
