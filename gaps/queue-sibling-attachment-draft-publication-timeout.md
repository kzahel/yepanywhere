# Queue sibling attachment can miss the durable publication check

On source `de811d52b`, [CI 43903987109, shard 1](https://github.com/kzahel/yepanywhere/actions/runs/43903987109/job/133427778694)
retried `Project Queue acceptance preserves a sibling attachment-only edit
across reload`. The sibling file chip appeared, but `/drafts/read` did not
contain `sibling.txt` within the existing five-second poll. The queued response
was still held, so this failure occurred before conditional acknowledgement
and does not establish that acknowledgement erased the edit.

The retry passed. The same source passed the complete local browser suite and
ten subsequent focused repetitions with two workers, without retries. No
assertion or timeout changed. First-attempt artifacts retain screenshots and
error context; the available trace is from the passing retry. The upload,
local envelope, sync scheduling and durable snapshot need a failing trace
before assigning a cause or changing production behavior.

Keep this distinct from the remaining asynchronous clear callers in
[new-session draft clearing](new-session-draft-clear-captures-after-submission.md).

Found 2026-11-16 while reviewing failed attempts for Desktop 0.12.1.
