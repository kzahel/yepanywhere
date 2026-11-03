# Relay source handoff can retain only a locally typed prefix in CI

CI run 41621863151 on 5b17d3b41 exposed
`session-creation-remote-qualification.spec.ts:331`: after switching from
relay host A to B and releasing A's accepted creation reply, B's editor
retained `OWNED_SOURCE_B_U` instead of `OWNED_SOURCE_B_UNSENT`. The retry
passed. This is a local editor value mismatch across source handoff.

The prefix remained through the unchanged five-second assertion. Capture
that editor's per-key acknowledgements, physical local draft, queued server
writes/version receipts and source-generation transitions together before
changing draft ownership or synchronization. Preserve the existing regression
and distinguish a local lost edit from remote focus protection.

The separately observed independent-browser prefix was a different boundary:
its trace showed the full text accepted by the server and read by browser B.
B had already auto-focused the earlier prefix, so the documented focus rule
held the later version until blur. That creation-acknowledgement fixture now
establishes initial publication before opening B; it supplies no evidence of
local keystroke loss or a common cause with this source-switch observation.

The built native/Claude fixtures do not establish a fix for this remaining
multi-source handoff. Evidence is in ignored
`tasks/ci-recovery-2026-11-03/ci-scanner-shard1-artifacts/` and `ci-green.log`.

Found 2026-11-03 during issue #171 CI recovery and issue #168 scanner repair.
