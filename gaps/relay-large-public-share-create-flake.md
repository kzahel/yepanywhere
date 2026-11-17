# Frozen share capture reads an unchanged transcript at two lengths

`packages/client/e2e/relay-integration.spec.ts` ("large frozen public share
uses bounded relay chunks") fails its first attempt and passes on retry: 5 of
60 `main` CI runs through 2026-11-13 (43028714969, 43448873388, 43488413407,
43499970953, 43518179454) and again in 43526368642. The retry keeps the job
green, so the defect stays hidden.

The case writes a five-row Claude transcript once, waits for the session's
full-history read to return 200, and immediately posts a frozen share. Run
43526368642 recorded the refusal:

    409 {"error":"Session history moved behind the frozen capture
    boundary; retry","retryable":true}

`PublicShareService.captureCompleteSession` raises that from
`validateBeforeAuthority` when its second `loadCompleteSession()` projects
fewer messages than the first. The file did not change between the two reads,
so the same transcript produced two projections of different lengths within
one request. The case's own comment notes that a newly written transcript
counts as externally active and that frozen capture then excludes its last
user turn; the first read deciding one way and the second the other would
produce exactly this, but that has not been confirmed.

A user can meet this by sharing a session moments after it appears or stops,
and the refusal is retryable, so the cost is one failed share. Establish why
two reads of an unchanged file disagree (activity classification, a cached
against an indexed read, or a provisional tail) before changing the case. A
retry or a longer wait in the test would hide it. It passed locally in three
full-suite runs with four workers (2026-11-14).

Found 2026-11-14 while fixing a red `main` CI.
Contributing-model: fable-5.2

Desktop 0.12.1 source `de811d52b` reproduced the same retryable frozen-boundary
409 in [CI 43903987109, shard 2](https://github.com/kzahel/yepanywhere/actions/runs/43903987109/job/133427778906).
The retry and complete local browser suite passed. No capture-boundary guard
or assertion was relaxed for the release.

The November 13–17 reports contain 22 retry passes across 38 runs with
reports, including 16 with the explicit frozen-boundary refusal. Session
detail reads the external tracker's ownership before loading history. A
catalog read can succeed before that asynchronous tracker sees the write,
so the two capture reads can disagree on whether to include the pending
turn. The relay fixture now waits for external ownership through metadata
and asserts that the public viewer excludes that turn. This preserves the
chunking assertion and leaves the real transition and capture guard in
place. Six local repetitions passed with two workers and retries disabled.
Repeated hosted verification and the user-facing refusal stay open.
