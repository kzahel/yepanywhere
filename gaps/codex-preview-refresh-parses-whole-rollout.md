# Codex preview refresh parses the whole long rollout

Opening a non-running Codex session can trigger a complete transcript parse
through `POST /api/projects/:projectId/sessions/:sessionId/refresh-preview`.
In `packages/server/src/routes/sessions.ts`, the excerpt path falls back to
`loadRestartSourceSession` when the bound reader has no `getLastAgentExcerpt`.
This bypasses the bounded detail window and contends with its acquisition.

The profiler-off `qual-be7-codex` cold open (runtime `be7b474c3`) logs a
`codex_entry_read` over 495,332,291 bytes / 154,131 lines with about 493 MB heap
growth. The preview request takes 1,259 ms; a concurrent empty incremental
read takes 1,250 ms despite its bounded cache containing only 584 entries.
Initial open also takes the full-preview path. Native output remains authoritative;
ordinary active writes being incremental does not close this consumer gap.

Route excerpt/summary consumers through a bounded shared reader contract,
including recap overlays and provider resolution. Preserve exact excerpt
semantics and add a real cold-open integration check that observes bytes read,
not just returned message count. Do not introduce a preview-only full-history
cache. The [combined qualification](../docs/research/190-combined-scale-qualification.md)
owns the evidence. Left open because this checkpoint measures combined
behavior rather than changing production readers.

Found 2026-11-11 while qualifying plan 190 at 50,000 idle sessions.
