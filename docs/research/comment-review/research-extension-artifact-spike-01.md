# Comment review: research/extension-artifact-spike, part 1

[Index and review procedure](README.md)

Snapshot: `3fe898ce5`. 17 blocks. Every item starts unreviewed.

Check an item only after recording **remove**, **keep**, or **rewrite/move** and a brief reason. Then apply and verify the corresponding source change.

- [ ] `b091ff29ddfe135c` [research/extension-artifact-spike/ArtifactPreview.tsx:1](../../../research/extension-artifact-spike/ArtifactPreview.tsx#L1) — **unreviewed** — ` // Research-only replacement, selected by spike.vite.config.ts. Never shipped. `
- [ ] `efa36d52fd34b0e8` [research/extension-artifact-spike/ArtifactPreview.tsx:66–67](../../../research/extension-artifact-spike/ArtifactPreview.tsx#L66-L67) — **unreviewed** — ` // Existing server access checks still apply. Production needs an additional // server-enforced artifact-root grant, especially for symlinks. `
- [ ] `b3cdbd4253652827` [research/extension-artifact-spike/ArtifactPreview.tsx:101–102](../../../research/extension-artifact-spike/ArtifactPreview.tsx#L101-L102) — **unreviewed** — ` // No send action: a production adapter can insert this undoably into // the session composer, like the existing MCP Apps message bridge. `
- [ ] `074dcdd0896a6ec8` [research/extension-artifact-spike/acceptance.mjs:74](../../../research/extension-artifact-spike/acceptance.mjs#L74) — **unreviewed** — ` // Generate an ordinary PNG asset without an image generation service. `
- [ ] `cc97860c0f81aa99` [research/extension-artifact-spike/acceptance.mjs:344](../../../research/extension-artifact-spike/acceptance.mjs#L344) — **unreviewed** — ` // The app's composer accessible name can change; this is the existing stable class. `
- [ ] `e525aa4bb6da1273` [research/extension-artifact-spike/acceptance.mjs:418](../../../research/extension-artifact-spike/acceptance.mjs#L418) — **unreviewed** — ` // Real sequential keyboard input in the live artifact, with a 100 ms acknowledgement ceiling. `
- [ ] `2e12fb420414afe9` [research/extension-artifact-spike/acceptance.mjs:442](../../../research/extension-artifact-spike/acceptance.mjs#L442) — **unreviewed** — ` // Preserve the actual YA composer when the modal is open; read it even if covered. `
- [ ] `0ffdcda947d06ddd` [research/extension-artifact-spike/acceptance.mjs:474](../../../research/extension-artifact-spike/acceptance.mjs#L474) — **unreviewed** — ` // A second independent viewer can use the same relay login without sharing widget state. `
- [ ] `bdf35a0142b5811f` [research/extension-artifact-spike/acceptance.mjs:529](../../../research/extension-artifact-spike/acceptance.mjs#L529) — **unreviewed** — ` // The artifact's host port and source connection survive explicit extension worker termination. `
- [ ] `f4cbc194f835db7d` [research/extension-artifact-spike/acceptance.mjs:558](../../../research/extension-artifact-spike/acceptance.mjs#L558) — **unreviewed** — ` // Authenticate from fresh extension profiles using the direct encrypted transport. `
- [ ] `359b2354265fe0f3` [research/extension-artifact-spike/acceptance.mjs:619](../../../research/extension-artifact-spike/acceptance.mjs#L619) — **unreviewed** — ` // Close the viewer, then navigate afresh: no worker-resident artifact grants are used. `
- [ ] `7f46cd6658bf9c47` [research/extension-artifact-spike/acceptance.mjs:627](../../../research/extension-artifact-spike/acceptance.mjs#L627) — **unreviewed** — ` // Reopen and park the live artifact so the real session composer remains usable. `
- [ ] `71919a16ae3167f5` [research/extension-artifact-spike/probe.mjs:1](../../../research/extension-artifact-spike/probe.mjs#L1) — **unreviewed** — ` // One-off browser boundary experiment. No YA production code is changed. `
- [ ] `6e25ce9706ea71b4` [research/extension-artifact-spike/sandbox.mjs:1–2](../../../research/extension-artifact-spike/sandbox.mjs#L1-L2) — **unreviewed** — ` // Bundled into the isolated packaged sandbox. Parsers are existing pinned // development dependencies; this is explicitly not a production dependency choice. `
- [ ] `baec6b999c31c6d4` [research/extension-artifact-spike/sandbox.mjs:52](../../../research/extension-artifact-spike/sandbox.mjs#L52) — **unreviewed** — ` // Sequential work bounds request concurrency for the research host. `
- [ ] `e2af6ce92f016911` [research/extension-artifact-spike/sandbox.mjs:161](../../../research/extension-artifact-spike/sandbox.mjs#L161) — **unreviewed** — ` // Use a script URL to avoid HTML parser end-tag handling in arbitrary JS. `
- [ ] `4663a3a7999ff7a8` [research/extension-artifact-spike/spike.vite.config.ts:4–5](../../../research/extension-artifact-spike/spike.vite.config.ts#L4-L5) — **unreviewed** — ` // Build-only replacement: the real ArtifactPreview and extension manifest // assembly remain unchanged in this worktree. `
