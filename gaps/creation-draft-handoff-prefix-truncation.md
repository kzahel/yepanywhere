# Creation draft handoff can retain only a typed prefix in CI

CI run 41621863151 on 5b17d3b41 and the otherwise green run 41623035865 on
37017c4a3 exposed two related-looking draft observations:

- `session-creation-remote-qualification.spec.ts:331`: after switching from
  relay host A to B and releasing A's accepted creation reply, B's editor
  retained `OWNED_SOURCE_B_U` instead of `OWNED_SOURCE_B_UNSENT`. The retry
  passed. This is a local editor value mismatch across source handoff.
- `session-creation-qualification.spec.ts:298`: a second independent browser
  read `OWNED_DE` instead of `OWNED_DEVICE_DRAFT`, after the first browser's
  sequential typing. This happened before the held creation reply was
  installed; its retry passed. This could involve draft propagation and is
  not evidence that creation acknowledgement caused the mismatch.

The failures retained these prefixes through the unchanged five-second
assertions. They do not establish a common cause or justify raising a budget.
Existing cases already protect these boundaries; preserve their assertions.
Capture the first editor's DOM value, its per-key acknowledgements, queued
server writes/version receipts and source-generation transitions together
before changing draft ownership or synchronization. Distinguish a local lost
edit from a remote reader that accepted an incomplete snapshot.

The CI recovery changes remove cold source graphs from native/Claude creation
fixtures; they do not establish a fix for these separate multi-source/device
handoffs. The frozen run evidence is in ignored
`tasks/ci-recovery-2026-11-03/ci-green.log` and the downloaded shard1 artifacts.

Found 2026-11-03 during issue #171 CI recovery and issue #168 scanner repair.
