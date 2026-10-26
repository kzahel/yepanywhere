# Project summary

Yep Anywhere is a mobile-first supervisor for coding agents. The TypeScript
Hono server discovers provider-native history, normalizes transcripts, and
maintains project/session indexes. React consumes HTTP/WebSocket views.
Provider execution and transcript observation are separate concerns.

## Native history architecture

- `packages/server/src/projects`: discovery and accepted project views.
- `packages/server/src/sessions`: provider readers and metadata parsers.
- `packages/server/src/indexes`: persistent discovery and summary caches.
- `packages/server/src/watcher`: file observation and invalidation.
- `packages/server/src/routes`: project/session APIs for clients.

## 2026-10-26: native session discovery fixes

1. Retain accepted project/index rows during transient I/O failures and retry.
2. Select usable Claude replicas consistently for lists, indexes, and detail.
3. Revalidate Codex heads after size/activity changes, including rewrites.
4. Discover/watch Codex archives with active-copy and plain precedence.

Validation includes 17 isolated real-file/HTTP scenarios: archive watcher
events reach the index, and transient locks recover without another event.

No credentials, personal transcripts, or deployment changes are included.
See `docs/development/native-session-discovery-verification.md` for checks
and local validation limits.
