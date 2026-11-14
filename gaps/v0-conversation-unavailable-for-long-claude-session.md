# v0 conversation reads are unavailable for a long-running Claude session

`GET /v0/servers/self/sessions/{id}/conversation` returns
`503 conversation_unavailable` ("exceeds its acquisition bounds") in about
0.26 s for an active, YA-owned Claude session whose transcript is 25 MB
(Fable 5.2, one manual compaction at roughly 470k tokens). Ordinary session
reads and the web UI work. The session agent therefore cannot read its own
conversation through v0, and neither can a supervising agent.

Suspected cause: the scoped intake cap for the conversation producer, 10,000
normalized records and 8 MiB within the recent-two-compaction scope
([Simple Client API](../topics/simple-client-api.md)), applied before routine
tool bodies and thinking are dropped. The quick failure rules out the
four-second first-publication deadline. Not diagnosed further because it was
found while investigating self-compaction.

Likely direction: count the budget after the projection discards content the
response excludes, or acquire only the requested visible-prose window, while
keeping truthful coverage and truncation flags.

Found 2026-11-14 while reviewing a tilefun session's self-compaction through
the v0 API.
