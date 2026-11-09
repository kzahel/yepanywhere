# Session Cache Strategy Review and Phase 1 Plan

Date: 2026-02-22

## Summary

Current request-time behavior is dominated by filesystem validation work rather than JSONL parsing:

- `ProjectScanner.listProjects()` performs on-demand discovery with no top-level snapshot cache.
- `SessionIndexService.getSessionsWithCache()` avoids re-parsing unchanged sessions, but still performs `stat` on every `.jsonl` file during full validation.
- Codex and Gemini scanners have short TTL caches, but route fan-out still duplicates work.
- Watchers exist (`FileWatcher` + `EventBus`) but cache invalidation is only partially connected to query-time cache reuse.

This leaves list endpoints (`/api/sessions`, `/api/projects/:id/sessions`, `/api/inbox`) sensitive to large session trees.

## Key Observations

1. Full-cache validation remains O(N files) per full scan in `SessionIndexService`.
2. `ProjectScanner` lookups (`getProject`, `getProjectBySessionDirSuffix`) can force full rescans.
3. Route logic sometimes does provider scan checks and then reader rescans for the same provider.
4. Client can trigger duplicate heavy requests (`useProjects`, multiple `useGlobalSessions` consumers, extra inbox count fetches).
5. Existing watcher events can support dirty-aware invalidation but were not directly driving index fast paths.

## Recommendations (Phased)

### Phase 1 (this implementation)

- Add request coalescing for `SessionIndexService` in-flight calls.
- Add watcher-driven dirty tracking for Claude session files.
- Add incremental dirty-session refresh path.
- Add fast-path cache returns when:
  - no dirty signals, and
  - full validation was run recently.
- Keep periodic full validation as safety net against missed watch events.
- Add basic instrumentation (mode, duration, stat calls, parse calls) and debug stats.

### Phase 2

- Add coalescing/snapshot cache for `ProjectScanner`.
- Avoid Codex/Gemini double-scan route patterns by reusing one provider catalog per request.
- Reuse provider readers/scanners across route handlers to make TTLs effective.

#### Phase 2 implementation (completed)

- `ProjectScanner` now has:
  - short-lived snapshot cache (`PROJECT_SCAN_CACHE_TTL_MS`, default `5000`)
  - in-flight coalescing for concurrent `listProjects()` calls
  - indexed lookup maps used by `getProject()` and `getProjectBySessionDirSuffix()`
  - watcher-driven invalidation through `EventBus` file-change events
  - explicit `invalidateCache()` for metadata-driven project additions
- Added per-request provider catalogs in routes (`provider-catalog.ts`) so Codex/Gemini path discovery runs once per request instead of once per project.
- Removed route-level Codex/Gemini scan-then-rescan checks; session detail fallback now reads directly through provider readers.
- `createApp()` now reuses reader instances with a bounded cache so Codex/Gemini reader TTL caches apply across requests.

### Phase 3

- Split expensive global stats from `/api/sessions` listing response (or cache stats separately).
- Add atomic index writes and optional single-writer lock for multi-instance safety.
- Expand perf and integration tests (watcher loss/recovery, call-count regression, concurrency).

#### Phase 3 implementation (current)

- `/api/sessions` now supports `includeStats=true`.
  - Default request path skips global stats aggregation.
  - Global stats are only computed when explicitly requested (used by the global sessions page).
- Added dedicated `/api/sessions/stats` endpoint with in-memory caching and event-driven invalidation.
  - Stats cache TTL: 5s.
  - Invalidated on session file/metadata/update/read events.
- UI consumers that do not render global counts now request sessions with stats disabled:
  - sidebar session lists
  - recent sessions dropdown
- Global sessions page now fetches stats separately via `/api/sessions/stats`.
- `SessionIndexService` index persistence now uses atomic write+rename to avoid partially-written cache files.
- Added cross-process session index write coordination:
  - lock directory per index file (`.lock`)
  - configurable lock timeout and stale-lock cleanup
  - env knobs `SESSION_INDEX_WRITE_LOCK_TIMEOUT_MS` and
    `SESSION_INDEX_WRITE_LOCK_STALE_MS` (removed 2026-11 with the JSON writer;
    summaries live in SQLite)
- Added tests for:
  - `includeStats` behavior in global sessions route
  - no temporary index files left after atomic writes
  - stale lock cleanup during index writes

## Phase 1 Implementation Notes

Implemented in this session:

- `SessionIndexServiceOptions` now supports:
  - `fullValidationIntervalMs`
  - `eventBus`
- Runtime default full validation interval:
  - `SESSION_INDEX_FULL_VALIDATION_MS=30000` (30s)
  - `0` preserves legacy “validate every request” behavior.
- Added watcher-driven invalidation path for Claude `file-change` session events.
- Added internal dirty tracking:
  - dirty dirs (require full reconcile)
  - dirty sessions (eligible for incremental refresh)
- Added in-flight coalescing maps for:
  - session list loads
  - title loads
- Added call-path instrumentation:
  - mode: `fast`, `incremental`, `full`
  - duration, stat count, parse count
  - aggregate debug stats accessor.

## Validation and Follow-up

Suggested validation after deploy:

1. Enable `SESSION_INDEX_LOG_PERF=true` temporarily and capture mode mix under normal navigation.
2. Compare median and p95 latency for `/api/sessions` before/after with large session trees.
3. Verify correctness on create/modify/delete churn and restart behavior.
4. If mode mix still skews heavily toward `full`, move to Phase 2 (`ProjectScanner` snapshot/coalescing).
