# SSE Message Handling Investigation

Research findings on how SSE handles new agent messages, SDK-to-frontend data flow, disk persistence merging, and hidden fields.

## Summary

| Question | Answer |
|----------|--------|
| Messages returned directly from SDK? | **No** - transformed via `convertMessage()` |
| Merged with disk? | **Yes** - dual-source with client-side dedup |
| Disk/SDK consistency check? | **No** - independent paths, no verification |
| Hidden fields? | **Yes** - `parentUuid`, `parent_tool_use_id`, metadata |

---

## Q1: Do we return messages to frontend directly from the SDK?

**No. Messages are transformed before being sent to the frontend.**

### Transformation Pipeline

```
SDK (AgentSDKMessage) → RealClaudeSDK.convertMessage() → SDKMessage → SSE → Frontend
```

The transformation in `packages/server/src/sdk/real.ts:130-173` aggressively filters SDK messages:

| SDK Message Type | What's Kept | What's Dropped |
|------------------|-------------|----------------|
| `system` | type, subtype, session_id | all init metadata (agents, tools, mcp_servers, betas, etc.) |
| `assistant` | type, uuid, session_id, message.content, role | parent_tool_use_id, error |
| `user` | type, uuid, session_id, message.content, role | parent_tool_use_id, isSynthetic, tool_use_result |
| `result` | type, subtype, session_id | cost, tokens, duration, model usage, permission_denials |
| `stream_event` | (passed through) | - |
| `tool_progress` | (passed through) | - |
| Others | passed through as-is | - |

Content blocks are also simplified via `extractContent()` - only `text`, `tool_use`, `tool_result`, and `image` types are preserved; others become JSON stringified text.

---

## Q2: Do we merge messages with what's on disk?

**Yes. The system uses dual-source loading with client-side merging.**

### Data Sources

1. **Disk (JSONL)**: Initial load via `SessionReader.getSession()` (`packages/server/src/sessions/reader.ts:133-175`)
2. **SSE (live SDK)**: Real-time updates via `process.subscribe()` (`packages/server/src/routes/stream.ts:64-125`)

### Merge Strategy (Client-Side)

From `packages/client/src/hooks/useSession.ts:224-263`:

1. **ID-based deduplication**: Skip if message with same ID exists
2. **Temp message replacement**: Optimistic user messages (temp-*) replaced with real UUIDs
3. **Incremental fetching**: Uses `afterMessageId` to fetch only new messages

### Message History Replay

The SSE endpoint replays buffered messages for late-joining clients:

```typescript
// stream.ts:40-46
for (const message of process.getMessageHistory()) {
  await stream.writeSSE({ event: "message", data: JSON.stringify(message) });
}
```

---

## Q3: Do we check if disk matches what SDK returns?

**No. There's no verification that disk-persisted data matches SDK emissions.**

- The SDK writes to disk independently (via Claude CLI process)
- `SessionReader` reads from disk independently
- No reconciliation or consistency check between the two
- Deduplication is purely by message ID, not content comparison
- If SDK emits a message with ID "abc" and disk has a different message with ID "abc", the first one wins (whichever is seen first)

---

## Q4: Are there hidden fields the SDK hides from us?

**Yes. Critical fields are filtered out, including `parentUuid` for tree structure.**

### Fields Present in JSONL but NOT in SDK Messages to Frontend

From the JSONL structure (see `claude-session-jsonl-structure.md`):

| Field | Purpose | Impact of Missing |
|-------|---------|-------------------|
| **`parentUuid`** | Creates DAG/tree structure for conversation | Cannot properly traverse conversation branches |
| **`sessionId`** | Session identifier (per-message) | Available via different path |
| **`isSidechain`** | Marks sub-agent/sidechain messages | Cannot distinguish main vs sidechain |
| **`userType`** | "external" vs internal | Cannot identify synthetic messages |

### Fields in SDK but Filtered by convertMessage()

| Field | SDK Has | We Keep |
|-------|---------|---------|
| `parent_tool_use_id` | Yes | No (dropped) |
| `isSynthetic` | Yes | No (dropped) |
| `isReplay` | Yes | No (dropped) |
| `error` (on assistant) | Yes | No (dropped) |
| `tool_use_result` | Yes | No (dropped in streaming, preserved on disk) |

### SDK Message Types Completely Ignored

These types from the SDK never make it to SSE as meaningful events:

- `stream_event` - Raw streaming chunks
- `tool_progress` - Long-running tool updates
- `auth_status` - Authentication state changes
- `hook_response` - Hook callback results
- `compact_boundary` / `status` - Context compaction events

### Result Message Metadata Lost

When a `result` message comes in, we only keep `type`, `subtype`, `session_id`. Lost:

- `duration_ms`, `duration_api_ms`
- `total_cost_usd`
- `usage`, `modelUsage`
- `num_turns`
- `permission_denials[]`

---

## Architectural Observations

### The parentUuid Problem

The JSONL is a **DAG, not linear**:

```
                    [text response]
                         |
            +------------+------------+
            |                         |
    [orphaned tool_use]        [resumed user message]
         (dead branch)              |
                              [new assistant response]
```

But `SessionReader` treats it as linear - it processes lines sequentially and ignores `parentUuid`:

```typescript
// reader.ts:148-158 - Sequential line processing
for (const line of lines) {
  const raw = JSON.parse(line) as RawSessionMessage;
  const message = this.convertMessage(raw, messageIndex++);
  if (message) messages.push(message);
}
```

**Impact**: Dead branches, orphaned tool_uses, and branching conversations are not properly handled.

### No Comparison Between Sources

```
SDK Iterator → Process.messageHistory → SSE
                    ↓
              (no link)
                    ↓
JSONL File  → SessionReader → API Response
```

The SDK stream and disk are completely independent paths. If they diverge, the system doesn't detect it.

---

## Key Files

| File | Role |
|------|------|
| `packages/server/src/sdk/real.ts` | SDK wrapper, message transformation |
| `packages/server/src/routes/stream.ts` | SSE endpoint |
| `packages/server/src/sessions/reader.ts` | JSONL disk reader |
| `packages/client/src/hooks/useSession.ts` | Client-side message handling/dedup |
| `packages/server/src/supervisor/Process.ts` | Message history buffer |

---

## Potential Improvements

1. **Expose `parentUuid`** - Enable proper DAG traversal for conversation branching
2. **Expose `parent_tool_use_id`** - Better nested tool call visualization
3. **Consistency checking** - Verify SDK emissions match disk writes
4. **Tree-aware SessionReader** - Walk `parentUuid` chain instead of linear processing
5. **Expose result metadata** - Show cost/token usage to users
