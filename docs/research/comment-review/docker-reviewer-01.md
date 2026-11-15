# Comment review: docker/reviewer, part 1

[Index and review procedure](README.md)

Snapshot: `3fe898ce5`. 3 blocks. Every item starts unreviewed.

Check an item only after recording **remove**, **keep**, or **rewrite/move** and a brief reason. Then apply and verify the corresponding source change.

- [ ] `d4a096f80fcda9f9` [docker/reviewer/Dockerfile:1–2](../../../docker/reviewer/Dockerfile#L1-L2) — **unreviewed** — ` # Build the application first with pnpm build:bundle, then use the repo root: # docker build -f docker/reviewer/Dockerfile -t yep-reviewer . `
- [ ] `e07a5d28c9e22277` [docker/reviewer/provider.mjs:1](../../../docker/reviewer/provider.mjs#L1) — **unreviewed** — ` // Loaded only by the reviewer image. Keep the production mock and SDK unchanged. `
- [ ] `e7646246ee01d634` [docker/reviewer/seed.mjs:1–2](../../../docker/reviewer/seed.mjs#L1-L2) — **unreviewed** — ` // Feed {username,password,relayUrl} on stdin; never put credentials in arguments. // Run once in an empty /demo volume, with no network access. `
