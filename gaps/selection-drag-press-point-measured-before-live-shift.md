# Selection drag case measures its press point before the first live shift

`packages/client/e2e/selection-during-activity.spec.ts:283` ("a drag keeps its
press point when the browser loses it mid-drag") failed first attempts in four
CI runs from 2026-11-10 to 11-12 (`43280666871`, `43167914478`,
`43143187840`, `42857468170`). The selection anchored in "User message 20"
(once "Off") instead of a Reply.

The retry trace of `43280666871` shows the transcript jumping down 86 px, one
Reply bubble, about 90 ms after the fixed 400 ms wait (`spec.ts:297`), in step
with the first `Live message 1` event `startActivity` emits (`spec.ts:230-245`).
When `textPoint` (`spec.ts:298`) measures before that jump, the press lands one
row higher. This is a test race; do not lengthen the fixed wait. Wait for the
first live message to render and the target's position to hold across two
frames, then re-measure immediately before `mouse.down`.

Open product question: in the same trace the live row replaces `Reply 23` and
renders empty (no "Live message" text appears). That may be a rendering defect
or an artifact of the fixture emitting `content_block_delta` without
`message_start`; it is unverified. The 252 px initial-bottom miss in
[browser follow scroll initial activity retry](browser-follow-scroll-initial-activity-retry.md)
covers the same spec and is plausibly the same early layout shift.

Found 2026-11-13 while diagnosing first-attempt CI failures.
