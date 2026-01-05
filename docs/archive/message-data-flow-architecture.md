# Message Data Flow Architecture

## Status: Discussion Needed

This document captures the current message data flow architecture and identifies areas for potential improvement.

---

## Current Architecture

### Three Data Paths

```
┌─────────────────────────────────────────────────────────────────────────┐
│                          OWNED SESSIONS                                  │
│                    (we spawned the Claude process)                       │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                          │
│  Path 1: SSE Stream (real-time SDK messages)                            │
│  ┌────────────────────────────────────────────────────────────────┐     │
│  │  Claude SDK → Process.subscribe() → SSE /sessions/:id/stream   │     │
│  │                                                                 │     │
│  │  Events: message, status, mode-change, error, complete          │     │
│  │  Latency: ~immediate                                            │     │
│  │  Source: SDK iterator only                                      │     │
│  └────────────────────────────────────────────────────────────────┘     │
│                                                                          │
│  Path 2: REST API (JSONL from disk)                                     │
│  ┌────────────────────────────────────────────────────────────────┐     │
│  │  GET /api/projects/:id/sessions/:id                            │     │
│  │                                                                 │     │
│  │  Source: SessionReader → ~/.claude/projects/.../session.jsonl  │     │
│  │  Used: Initial load, incremental fetch (afterMessageId param)  │     │
│  │  Latency: On-demand only                                        │     │
│  └────────────────────────────────────────────────────────────────┘     │
│                                                                          │
└─────────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────────┐
│                         EXTERNAL SESSIONS                                │
│                (owned by CLI or another claude-anywhere instance)        │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                          │
│  Path 3: File Watcher → Throttled REST Fetch                            │
│  ┌────────────────────────────────────────────────────────────────┐     │
│  │  chokidar watches ~/.claude/projects/                          │     │
│  │       ↓                                                         │     │
│  │  File change detected → "file-change" SSE event                │     │
│  │       ↓                                                         │     │
│  │  Client throttled fetch (500ms) → REST API → JSONL             │     │
│  │                                                                 │     │
│  │  Latency: ~500ms+ (throttle + file write delay)                │     │
│  └────────────────────────────────────────────────────────────────┘     │
│                                                                          │
└─────────────────────────────────────────────────────────────────────────┘
```

### Client-Side Merge

The client receives data from multiple paths and merges in React state:

```typescript
// useSession.ts - current merge logic
setMessages((prev) => {
  // Dedup by ID - skip if already exists
  if (prev.some((m) => m.id === id)) return prev;

  // Replace temp messages with real ones
  if (role === "user" && existingTemp) { /* replace */ }

  // Add new message
  return [...prev, newMessage];
});
```

**Problem:** First arrival wins. If stripped SDK message arrives before JSONL, we keep the stripped version.

---

## Issues to Address

### 1. Message Field Stripping

**Current:** SDK messages are aggressively transformed in `real.ts:convertMessage()`, losing:
- `parentUuid` - DAG structure for branching
- `parent_tool_use_id` - nested tool call tree
- `isSynthetic`, `isReplay` - message origin flags
- `error` - assistant error details
- Result metadata (cost, tokens, duration)

**Impact:** Frontend cannot inspect full message data for debugging or future features.

**Fix (implemented):** Pass through all fields, use loose typing.

### 2. Duplicate Data (rawJsonl)

**Current:** `reader.ts` adds `rawJsonl: raw` to every message, duplicating all fields.

**Impact:** Wasteful, confusing.

**Fix (implemented):** Remove rawJsonl, the message IS the raw data.

### 3. Merge Strategy

**Current:** Client deduplicates by ID, first arrival wins.

**Better:** When JSONL version arrives for existing message:
- Merge fields with JSONL as base (authoritative)
- Preserve any SDK-only fields
- Warn if SDK has fields JSONL doesn't (validates assumption)

**Fix (implemented):** Updated client merge logic.

---

## Future Considerations

### Should SSE Watch JSONL?

**Current:** SSE only forwards SDK events, doesn't watch disk.

**Alternative:** SSE could also watch JSONL and emit unified messages.

**Pros:**
- Single source of truth from server
- Server-side merge ensures consistency
- Simpler client logic

**Cons:**
- File watch latency vs SDK immediacy
- More complex server (watch + merge + dedup)
- Potential duplicate events if SDK and file change overlap

**Recommendation:** Keep current architecture for now. The client-side merge is simple and works. Revisit if we need server-side features like:
- Message editing/deletion
- Cross-client sync
- Offline support

### Should We Stream JSONL Diffs?

**Current:** Incremental fetch uses `afterMessageId` param.

**Alternative:** Stream JSONL changes via SSE (like a tail -f).

**Pros:**
- Real-time external session updates
- No polling/throttling needed

**Cons:**
- Need to handle file truncation, rotation
- More complex than REST fetch
- May not be necessary if external session latency is acceptable

### DAG-Aware Streaming

**Current:** Messages stream linearly. DAG structure (parentUuid) exists but isn't used for ordering.

**Issue:** When conversation branches, old branch messages are in the stream but shouldn't render.

**Current Fix:** `buildDag()` in `dag.ts` filters to active branch on disk load.

**Gap:** SDK streaming doesn't know about branches - it emits all messages.

**Potential Fix:**
- Track active branch on server
- Filter SDK messages to active branch before emitting
- Or: let client handle via parentUuid chain

---

## File Reference

| File | Role |
|------|------|
| `packages/server/src/sdk/real.ts` | SDK wrapper, message passthrough |
| `packages/server/src/routes/stream.ts` | SSE endpoint for owned sessions |
| `packages/server/src/sessions/reader.ts` | JSONL disk reader |
| `packages/server/src/sessions/dag.ts` | DAG builder, branch filtering |
| `packages/client/src/hooks/useSession.ts` | Client message state, merge logic |
| `packages/client/src/hooks/useFileActivity.ts` | File watcher SSE consumer |

---

## Questions for Discussion

1. **Is 500ms throttle right for external sessions?** Could be too slow for pair programming, too fast for battery.

2. **Should we expose DAG structure to frontend?** Would enable branch visualization, navigation.

3. **Do we need offline support?** Would require IndexedDB caching, conflict resolution.

4. **Should status events (running/idle) also come from JSONL?** Currently SDK-only, so external sessions don't show status.

5. **Memory bounds?** Process.messageHistory grows unbounded for long sessions. Should we cap and rely on JSONL?
