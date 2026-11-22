# Antigravity patient messages can send while provider work remains pending

The composer preserves `deliveryIntent: "patient"` for an Antigravity queue
item, but [the delivery decision](../packages/server/src/supervisor/Process.ts#L253)
uses verified idle and the per-item quiet interval only for Claude. Antigravity
uses ordinary turn-end delivery, including when a known shell command,
schedule, or subagent can wake the root conversation on its own. A user who
chooses **Wait until fully done** or **Next topic when done** can start the
queued topic while Antigravity is still working on the previous one.

Reproduced on 2026-11-22 at `eb520d058` with the
[opt-in native app cases](../packages/server/test/native-app/app-antigravity-gap-repros.test.ts).
The composer endpoint accepted an item with patient intent and 120 seconds of
patience. Finishing the parent's foreground response immediately delivered the
queued text to the native model while the child's request was still held open.

Live Gemini 3.8 Flash Low through `agy` 1.5.14 reproduced early delivery with
a native schedule. Submit a patient message during the initial foreground
turn that schedules a wake,
with 120 seconds of patience. The native transcript recorded the patient
input and its reply one second after the foreground reply and thirteen seconds
before the scheduled wake. The patient message asked for a distinct reply
marker and left the scheduled wake in place.

The item should stay queued through the child's completion and the parent's
autonomous reply. After the root settles and the quiet interval elapses, it
should deliver once. Ordinary queued sends keep their existing timing.

Found 2026-11-22 while reviewing the Antigravity detached-wake and reload
reports.
