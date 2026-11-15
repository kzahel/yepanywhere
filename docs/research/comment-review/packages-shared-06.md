# Comment review: packages/shared, part 6

[Index and review procedure](README.md)

Snapshot: `3fe898ce5`. 7 blocks. Every item starts unreviewed.

Check an item only after recording **remove**, **keep**, or **rewrite/move** and a brief reason. Then apply and verify the corresponding source change.

- [ ] `2e1058a82f5ccdba` [packages/shared/test/skill-invocations.test.ts:48–49](../../../packages/shared/test/skill-invocations.test.ts#L48-L49) — **unreviewed** — ` // Case-preserving so Codex's exact-name loader still recognizes it, while a // lowercased authored spelling is corrected up to the canonical name. `
- [ ] `90ea6ceac7ee5319` [packages/shared/test/skill-invocations.test.ts:69](../../../packages/shared/test/skill-invocations.test.ts#L69) — **unreviewed** — ` // Exact spellings each resolve to their own skill... `
- [ ] `0749e8c2e27c8f8b` [packages/shared/test/skill-invocations.test.ts:75–76](../../../packages/shared/test/skill-invocations.test.ts#L75-L76) — **unreviewed** — ` // ...but a spelling that matches neither exactly is left literal rather // than arbitrarily selecting one of the colliding skills. `
- [ ] `22a7a696f8454a3f` [packages/shared/test/skill-invocations.test.ts:126](../../../packages/shared/test/skill-invocations.test.ts#L126) — **unreviewed** — ` // Typed in front of existing text: the token ends at the caret. `
- [ ] `ce0572960132e39b` [packages/shared/test/skill-invocations.test.ts:188–189](../../../packages/shared/test/skill-invocations.test.ts#L188-L189) — **unreviewed** — ` // A path, a mid-text token, and an indented command all reach the provider // as prose, so none of them may bypass correction framing. `
- [ ] `6745f9a69f9d8c2b` [packages/shared/test/sqlite-statement-ceiling.test.ts:4–9](../../../packages/shared/test/sqlite-statement-ceiling.test.ts#L4-L9) — **unreviewed** — ` /** * The ceiling exists to make one Bun-only defect visible on Node: a caller that * prepares the same SQL per call retains every statement until close under Bun, * while Node's collector hides it. These tests assert the check itself, since a * guard nobody exercises is indistinguishable from a guard that never fires. */ `
- [ ] `acc9efc737a4d551` [packages/shared/vitest.config.ts:3–5](../../../packages/shared/vitest.config.ts#L3-L5) — **unreviewed** — ` // Without a config here, vitest would find the repository root config and // run its multi-project setup from this package. tsc emits compiled test // copies into dist/, which vitest 4 no longer excludes by default. `
