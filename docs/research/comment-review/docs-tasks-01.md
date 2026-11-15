# Comment review: docs/tasks, part 1

[Index and review procedure](README.md)

Snapshot: `3fe898ce5`. 23 blocks. Every item starts unreviewed.

Check an item only after recording **remove**, **keep**, or **rewrite/move** and a brief reason. Then apply and verify the corresponding source change.

- [ ] `a001d88f41dec92b` [docs/tasks/archive/analyze-claude-messages.js:3–13](../../../docs/tasks/archive/analyze-claude-messages.js#L3-L13) — **unreviewed** — ` /** * Claude Message Schema Analyzer * * Scans all JSONL files in a directory to build a complete catalog of: * - Message types and their structures * - Content block types * - Tool names and their input/result schemas * * Usage: node analyze-claude-messages.js /path/to/.claude/projects * Output: schema-report.json (detailed) + schema-summary.md (human-readable) */ `
- [ ] `095ed4039200e01a` [docs/tasks/archive/analyze-claude-messages.js:18](../../../docs/tasks/archive/analyze-claude-messages.js#L18) — **unreviewed** — ` // Schema inference helpers `
- [ ] `a9b51195955c920a` [docs/tasks/archive/analyze-claude-messages.js:69](../../../docs/tasks/archive/analyze-claude-messages.js#L69) — **unreviewed** — ` // Recurse into objects (but not arrays - we just note item types) `
- [ ] `fcacb697ccccbd31` [docs/tasks/archive/analyze-claude-messages.js:78](../../../docs/tasks/archive/analyze-claude-messages.js#L78) — **unreviewed** — ` // Main analysis state `
- [ ] `3b562d055ae3dad1` [docs/tasks/archive/analyze-claude-messages.js:82](../../../docs/tasks/archive/analyze-claude-messages.js#L82) — **unreviewed** — ` // type -> count `
- [ ] `faf9bfb932dec288` [docs/tasks/archive/analyze-claude-messages.js:83](../../../docs/tasks/archive/analyze-claude-messages.js#L83) — **unreviewed** — ` // type -> count `
- [ ] `e4ef38de82a0d854` [docs/tasks/archive/analyze-claude-messages.js:84](../../../docs/tasks/archive/analyze-claude-messages.js#L84) — **unreviewed** — ` // toolName -> { count, inputSchema, resultSchema } `
- [ ] `7d1d7a1248ba736a` [docs/tasks/archive/analyze-claude-messages.js:85](../../../docs/tasks/archive/analyze-claude-messages.js#L85) — **unreviewed** — ` // messageType -> schema `
- [ ] `4e87eef477312994` [docs/tasks/archive/analyze-claude-messages.js:112–113](../../../docs/tasks/archive/analyze-claude-messages.js#L112-L113) — **unreviewed** — ` // Tool results reference tool_use by id - we need to find the matching tool // For now, infer schema generically; we'll correlate later `
- [ ] `dd2db9eb8800355b` [docs/tasks/archive/analyze-claude-messages.js:118–119](../../../docs/tasks/archive/analyze-claude-messages.js#L118-L119) — **unreviewed** — ` // We'll need to correlate this with tool_use blocks // Store under a generic key for now `
- [ ] `89969945927eac97` [docs/tasks/archive/analyze-claude-messages.js:121](../../../docs/tasks/archive/analyze-claude-messages.js#L121) — **unreviewed** — ` // Mark for correlation `
- [ ] `f61e5580fed9e731` [docs/tasks/archive/analyze-claude-messages.js:125](../../../docs/tasks/archive/analyze-claude-messages.js#L125) — **unreviewed** — ` // Plain text result `
- [ ] `17db04ec0f863e4c` [docs/tasks/archive/analyze-claude-messages.js:146](../../../docs/tasks/archive/analyze-claude-messages.js#L146) — **unreviewed** — ` // Infer message-level schema `
- [ ] `ec00b82c69e53063` [docs/tasks/archive/analyze-claude-messages.js:152](../../../docs/tasks/archive/analyze-claude-messages.js#L152) — **unreviewed** — ` // Process content blocks for assistant/user messages `
- [ ] `76ed55d357096bc8` [docs/tasks/archive/analyze-claude-messages.js:154](../../../docs/tasks/archive/analyze-claude-messages.js#L154) — **unreviewed** — ` // Build tool_use id -> name map for correlating results `
- [ ] `c80401b6992a9867` [docs/tasks/archive/analyze-claude-messages.js:164](../../../docs/tasks/archive/analyze-claude-messages.js#L164) — **unreviewed** — ` // Second pass: correlate tool_result with tool_use `
- [ ] `171c7e757b00c7f0` [docs/tasks/archive/analyze-claude-messages.js:169](../../../docs/tasks/archive/analyze-claude-messages.js#L169) — **unreviewed** — ` // Parse and infer result schema `
- [ ] `95c7bd4f10018113` [docs/tasks/archive/analyze-claude-messages.js:175](../../../docs/tasks/archive/analyze-claude-messages.js#L175) — **unreviewed** — ` // Keep as string `
- [ ] `3d2c0503faa64d01` [docs/tasks/archive/analyze-claude-messages.js:180](../../../docs/tasks/archive/analyze-claude-messages.js#L180) — **unreviewed** — ` // Handle array results (common for some tools) `
- [ ] `4bffd99cae918cc1` [docs/tasks/archive/analyze-claude-messages.js:255](../../../docs/tasks/archive/analyze-claude-messages.js#L255) — **unreviewed** — ` // First 20 errors only `
- [ ] `14afb2fbf96c8c35` [docs/tasks/archive/analyze-claude-messages.js:258](../../../docs/tasks/archive/analyze-claude-messages.js#L258) — **unreviewed** — ` // Serialize tool schemas `
- [ ] `ad002c4356e0abf1` [docs/tasks/archive/analyze-claude-messages.js:267](../../../docs/tasks/archive/analyze-claude-messages.js#L267) — **unreviewed** — ` // Serialize message schemas `
- [ ] `3ad95f0cc7606805` [docs/tasks/archive/analyze-claude-messages.js:367](../../../docs/tasks/archive/analyze-claude-messages.js#L367) — **unreviewed** — ` // Main `
