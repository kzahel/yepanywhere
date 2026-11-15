# Comment review: scripts/agent-api-eval, part 1

[Index and review procedure](README.md)

Snapshot: `3fe898ce5`. 23 blocks. Every item starts unreviewed.

Check an item only after recording **remove**, **keep**, or **rewrite/move** and a brief reason. Then apply and verify the corresponding source change.

- [ ] `eedcc7632bbd8892` [scripts/agent-api-eval/cases.ts:127–131](../../../scripts/agent-api-eval/cases.ts#L127-L131) — **unreviewed** — `` /** * One spelling per request, so a grader compares what was asked for and not * how the agent typed it: decoded path segments, no trailing slash, the * `self` alias resolved, and query parameters decoded and sorted. */ ``
- [ ] `8bb038ff5702d227` [scripts/agent-api-eval/cases.ts:176](../../../scripts/agent-api-eval/cases.ts#L176) — **unreviewed** — ` // self is interpreted at the access server; normalize for evidence matching. `
- [ ] `dea73c852988fd0b` [scripts/agent-api-eval/compare.ts:37](../../../scripts/agent-api-eval/compare.ts#L37) — **unreviewed** — ` /** Compare complete paired task matrices; a missing/failed trial cannot improve cost. */ `
- [ ] `fde01d9d1f9498ff` [scripts/agent-api-eval/documentation-metrics.ts:15](../../../scripts/agent-api-eval/documentation-metrics.ts#L15) — **unreviewed** — ` /** Derive from recorded HTTP bytes, including historical reports with old aggregates. */ `
- [ ] `ac2a584e875c2d78` [scripts/agent-api-eval/fixture.ts:31](../../../scripts/agent-api-eval/fixture.ts#L31) — **unreviewed** — ` /** Real private adapter, deterministic source functions, no app/profile/scanners. */ `
- [ ] `31e2b89c656cb18a` [scripts/agent-api-eval/fixture.ts:194–195](../../../scripts/agent-api-eval/fixture.ts#L194-L195) — **unreviewed** — ` // The scripted worker owns progress independently of observer lifetime. // A finite timer starts on first observation and ends with this fixture. `
- [ ] `edacc1b514510221` [scripts/agent-api-eval/fixture.ts:341–342](../../../scripts/agent-api-eval/fixture.ts#L341-L342) — **unreviewed** — ` // A test-only transparent front records actual HTTP outcomes and repeated doc // bytes, including failed requests. It forwards authentication to production. `
- [ ] `6b7e8d217a66cf5e` [scripts/agent-api-eval/fixture.ts:406](../../../scripts/agent-api-eval/fixture.ts#L406) — **unreviewed** — ` /* Not a successful follow response. */ `
- [ ] `47d692495dd6a90e` [scripts/agent-api-eval/fixture.ts:426](../../../scripts/agent-api-eval/fixture.ts#L426) — **unreviewed** — ` /* Non-JSON documentation has no domain evidence. */ `
- [ ] `613f103fa38355ba` [scripts/agent-api-eval/native-peer-control.ts:1](../../../scripts/agent-api-eval/native-peer-control.ts#L1) — **unreviewed** — ` /** Fixture-only cross-host controller; never load a configured user peer credential. */ `
- [ ] `e8f65747e79258c7` [scripts/agent-api-eval/peer-fixture.ts:26](../../../scripts/agent-api-eval/peer-fixture.ts#L26) — **unreviewed** — ` /** Real private profiles and encrypted owned relay, with scripted native work. */ `
- [ ] `4ce64b5845260892` [scripts/agent-api-eval/process.ts:18](../../../scripts/agent-api-eval/process.ts#L18) — **unreviewed** — ` /** A leader exiting must not cancel termination of its remaining descendants. */ `
- [ ] `fb9d612bd6c14e15` [scripts/agent-api-eval/process.ts:29–30](../../../scripts/agent-api-eval/process.ts#L29-L30) — **unreviewed** — ` // The exec runner attaches its close handler immediately; keep an early // rejection handled too if the OS fails before close is emitted. `
- [ ] `4ad3cbac49dbe84b` [scripts/agent-api-eval/process.ts:47–48](../../../scripts/agent-api-eval/process.ts#L47-L48) — **unreviewed** — ` // Kill the remaining group before clearing escalation, even on normal // leader exit. 'close' may itself wait for inherited descendant pipes. `
- [ ] `40b480fc4406e054` [scripts/agent-api-eval/run.ts:175–176](../../../scripts/agent-api-eval/run.ts#L175-L176) — **unreviewed** — ` // Read only the operator's saved ChatGPT sign-in. Never copy config, skills, // instructions or API-key auth; never mutate the original credential file. `
- [ ] `2b53517ec5e8258f` [scripts/agent-api-eval/run.ts:241](../../../scripts/agent-api-eval/run.ts#L241) — **unreviewed** — ` // Rotate variant order per case/sample to reduce systematic warm-up bias. `
- [ ] `688a85df3fc3fdb1` [scripts/agent-api-eval/run.ts:396](../../../scripts/agent-api-eval/run.ts#L396) — **unreviewed** — ` /* missing/invalid output is a failed trial */ `
- [ ] `d365cd234f06e296` [scripts/agent-api-eval/selection.ts:8](../../../scripts/agent-api-eval/selection.ts#L8) — **unreviewed** — ` /** Fixed domain truth; the worker's inspection is derived from submitted controls. */ `
- [ ] `a6fc4fef7fd91679` [scripts/agent-api-eval/support.ts:1](../../../scripts/agent-api-eval/support.ts#L1) — **unreviewed** — ` /** Only provider failures establish quota exhaustion; model prose is not one. */ `
- [ ] `7bf90bdf7ad90e91` [scripts/agent-api-eval/support.ts:15](../../../scripts/agent-api-eval/support.ts#L15) — **unreviewed** — ` /** Disposable access-only auth: a trial must never rotate the operator's refresh token. */ `
- [ ] `6c92253d91b2bad0` [scripts/agent-api-eval/support.ts:38](../../../scripts/agent-api-eval/support.ts#L38) — **unreviewed** — ` /* rejected below */ `
- [ ] `a149484d8008e358` [scripts/agent-api-eval/support.ts:41–42](../../../scripts/agent-api-eval/support.ts#L41-L42) — **unreviewed** — ` // Current Codex refreshes near expiry or after eight days. Require margin; // omit the actual refresh authority even if the CLI attempts recovery. `
- [ ] `6aa8c5c3e1d92cf2` [scripts/agent-api-eval/target-contract.ts:12](../../../scripts/agent-api-eval/target-contract.ts#L12) — **unreviewed** — ` /** This operation deliberately does not exist in the access server's operation table. */ `
