# Large frozen public share is refused on its first CI attempt

`packages/client/e2e/relay-integration.spec.ts` ("large frozen public share
uses bounded relay chunks") failed its first attempt and passed on retry in 5
of the last 60 `main` CI runs (43028714969, 43448873388, 43488413407,
43499970953 and 43518179454), so the job stays green and the defect stays
hidden. Every failure is the same line: `POST /api/public-shares` with
`mode: "frozen"` returns a non-2xx response immediately after the session's
full-history read first returns 200. The case writes a new transcript, polls
that read, then creates the share at once, which suggests the share's frozen
capture can observe the session before whatever the read waited on has
settled; that is a guess. It passed 1 of 1 locally (full suite, four workers,
no retries, 2026-11-14).

The assertion reported only `ok === false`, so no run recorded the status or
error body, and the uploaded trace holds no browser request for a Node-side
`fetch`. It now puts both in the failure message. Read them from the next
failing run before changing the case or the route: a refusal that names an
unsettled transcript is a product race a real user can hit by sharing a
session the moment it appears, and a longer wait in the test would only hide
it.

Found 2026-11-14 while fixing a red `main` CI.
Contributing-model: fable-5.2
