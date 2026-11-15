# Comment review: scripts/fixtures, part 1

[Index and review procedure](README.md)

Snapshot: `3fe898ce5`. 24 blocks. Every item starts unreviewed.

Check an item only after recording **remove**, **keep**, or **rewrite/move** and a brief reason. Then apply and verify the corresponding source change.

- [ ] `a567606a60ad258c` [scripts/fixtures/find-unused-css/Dynamic.module.css:1](../../../scripts/fixtures/find-unused-css/Dynamic.module.css#L1) — **unreviewed** — ` /* Both selectors are reached through a computed key, so usage is unknown. */ `
- [ ] `8a1b4d1cf98d1348` [scripts/fixtures/find-unused-css/Orphan.module.css:1](../../../scripts/fixtures/find-unused-css/Orphan.module.css#L1) — **unreviewed** — ` /* No source file imports this module. */ `
- [ ] `ec70846239e288b7` [scripts/fixtures/find-unused-css/Shared.module.css:1](../../../scripts/fixtures/find-unused-css/Shared.module.css#L1) — **unreviewed** — `` /* Reached only through `composes: shared from "./Shared.module.css"`. */ ``
- [ ] `0eafee8ce78a5e15` [scripts/fixtures/find-unused-css/Shared.module.css:6](../../../scripts/fixtures/find-unused-css/Shared.module.css#L6) — **unreviewed** — ` /* No composer and no importer reference. */ `
- [ ] `ef5a9d6d3dcd02aa` [scripts/fixtures/find-unused-css/Sibling.module.css:5–8](../../../scripts/fixtures/find-unused-css/Sibling.module.css#L5-L8) — **unreviewed** — `` /* * Same local name as Widget.module.css `.message`, but a different class. * Widget uses its own; this one is unused. */ ``
- [ ] `1da851636fc2fef0` [scripts/fixtures/find-unused-css/Sibling.ts:3–4](../../../scripts/fixtures/find-unused-css/Sibling.ts#L3-L4) — **unreviewed** — `` // The word "message" appears here as prose, which must not make // Sibling.module.css `.message` look used. ``
- [ ] `a033a450d00733df` [scripts/fixtures/find-unused-css/Widget.module.css:1–2](../../../scripts/fixtures/find-unused-css/Widget.module.css#L1-L2) — **unreviewed** — `` /* A prose reference to Widget.module.css must not create a local `.css` selector. */ ``
- [ ] `c78105bf1a331ab7` [scripts/fixtures/find-unused-css/Widget.module.css:7](../../../scripts/fixtures/find-unused-css/Widget.module.css#L7) — **unreviewed** — ` /* Reached through styles["bracket-access"]. */ `
- [ ] `9a7fe57aef460991` [scripts/fixtures/find-unused-css/Widget.module.css:12](../../../scripts/fixtures/find-unused-css/Widget.module.css#L12) — **unreviewed** — ` /* Composed by .root's sibling below, not referenced from the component. */ `
- [ ] `379a4c10cc82d720` [scripts/fixtures/find-unused-css/Widget.module.css:23](../../../scripts/fixtures/find-unused-css/Widget.module.css#L23) — **unreviewed** — ` /* Same local name as a class in Sibling.module.css; they are distinct. */ `
- [ ] `26e8b5c370efaeee` [scripts/fixtures/find-unused-css/Widget.module.css:28](../../../scripts/fixtures/find-unused-css/Widget.module.css#L28) — **unreviewed** — ` /* Nothing references this. */ `
- [ ] `a7f2b8482c6c71e0` [scripts/fixtures/find-unused-css/Widget.module.css:33](../../../scripts/fixtures/find-unused-css/Widget.module.css#L33) — **unreviewed** — ` /* Imported only from the stylesheet-contract test. */ `
- [ ] `c28c5dd95452d4a0` [scripts/fixtures/find-unused-css/Widget.ts:15](../../../scripts/fixtures/find-unused-css/Widget.ts#L15) — **unreviewed** — ` // fixture-comment-only is prose, not a rendered class. `
- [ ] `21ee13b550925de3` [scripts/fixtures/find-unused-css/global.css:1](../../../scripts/fixtures/find-unused-css/global.css#L1) — **unreviewed** — ` /* Legacy-style global stylesheet. */ `
- [ ] `48b6c1df4a0682aa` [scripts/fixtures/find-unused-css/global.css:11](../../../scripts/fixtures/find-unused-css/global.css#L11) — **unreviewed** — ` /* A longer class must not make its prefix look used. */ `
- [ ] `4608c752f4670c12` [scripts/fixtures/find-unused-css/global.css:20](../../../scripts/fixtures/find-unused-css/global.css#L20) — **unreviewed** — ` /* Source comments must not count as runtime usage. */ `
- [ ] `4eb00db0a18b6a0e` [scripts/fixtures/find-unused-css/global.css:25](../../../scripts/fixtures/find-unused-css/global.css#L25) — **unreviewed** — ` /* Emitted by a producer outside the fixture's pretend client component. */ `
- [ ] `88b376cf511c9b8f` [scripts/fixtures/find-unused-css/global.css:30](../../../scripts/fixtures/find-unused-css/global.css#L30) — **unreviewed** — ` /* Referenced only from Widget.module.css through :global(...). */ `
- [ ] `92421ef54d07e3a1` [scripts/fixtures/find-unused-css/global.css:35](../../../scripts/fixtures/find-unused-css/global.css#L35) — **unreviewed** — ` /* Exists, but InvalidGlobal.module.css reaches it without a local anchor. */ `
- [ ] `06547a8b4cc6192a` [scripts/fixtures/find-unused-css/global.css:40](../../../scripts/fixtures/find-unused-css/global.css#L40) — **unreviewed** — `` /* Referenced only through `composes: ... from global`. */ ``
- [ ] `dd2802b42ae53001` [scripts/fixtures/find-unused-css/global.css:45](../../../scripts/fixtures/find-unused-css/global.css#L45) — **unreviewed** — ` /* Pinned only by an escaped-dot selector inside a regex literal. */ `
- [ ] `16881d385d4a0a9f` [scripts/fixtures/find-unused-css/global.css:50](../../../scripts/fixtures/find-unused-css/global.css#L50) — **unreviewed** — ` /* Named inside the same regex file, but never as a selector. */ `
- [ ] `32b0a7417a693fe4` [scripts/fixtures/find-unused-css/stylesheet-contract.test.ts:5–9](../../../scripts/fixtures/find-unused-css/stylesheet-contract.test.ts#L5-L9) — **unreviewed** — `` /** * A stylesheet-contract test whose selector vocabulary exists only inside * regular-expression literals, like * `packages/client/src/styles/__tests__/turnGalleryNaturalSize.test.ts`. */ ``
- [ ] `ec36acd78ed14a58` [scripts/fixtures/find-unused-css/stylesheet-contract.test.ts:12–15](../../../scripts/fixtures/find-unused-css/stylesheet-contract.test.ts#L12-L15) — **unreviewed** — ` /** * Neither a bare word nor an escaped backslash before the any-character * metacharacter names a class. */ `
