# Claude Session JSONL Structure and Resumption

Research findings from investigating how Claude Code persists and resumes sessions.

## JSONL Structure

Claude sessions are stored as JSONL files in `~/.claude/projects/<project-id>/<session-id>.jsonl`. Each line is a JSON object representing a message or event.

### Key Fields

Each entry contains:

```json
{
  "parentUuid": "cfbd11e2-3343-405b-a0f3-b09708928e65",
  "uuid": "0930f2f2-c5f1-41a3-94cf-d326a5872179",
  "type": "user" | "assistant" | "queue-operation" | "file-history-snapshot",
  "sessionId": "c7d5ec07-9d1c-4f5f-839b-c2bac30a7587",
  "isSidechain": false,
  "userType": "external",
  "message": { ... },
  "timestamp": "2025-12-30T09:46:13.355Z"
}
```

### Tree/DAG Structure (Not Linear!)

The JSONL is **not a simple linear log**. The `parentUuid` field creates a directed acyclic graph (DAG) where:

- Each message points to its parent message
- Multiple messages can share the same parent (branching)
- The file is append-only, but the logical structure is a tree

This enables:
1. **Conversation branching** - forking from any point
2. **Dead branches** - abandoned paths remain in file but are unreachable
3. **Clean recovery** - resumption can pick any node as the continuation point

### Message Types

From analysis of a real session:

| Type | Count | Description |
|------|-------|-------------|
| `message` | ~83 | Wrapper type for user/assistant messages |
| `assistant` | ~83 | Claude's responses |
| `user` | ~37 | User messages and tool results |
| `tool_use` | ~34 | Tool invocation requests (inside assistant content) |
| `tool_result` | ~34 | Tool execution results (inside user content) |
| `thinking` | ~32 | Claude's thinking blocks |
| `queue-operation` | ~7 | Internal queue management |
| `file-history-snapshot` | ~7 | File state snapshots |
| `text` | ~34 | Text content blocks |

### Content Block Types

Messages contain content arrays with typed blocks:

```json
{
  "message": {
    "role": "assistant",
    "content": [
      { "type": "thinking", "thinking": "..." },
      { "type": "text", "text": "..." },
      { "type": "tool_use", "id": "toolu_...", "name": "Bash", "input": {...} }
    ]
  }
}
```

Tool results appear in user messages:

```json
{
  "message": {
    "role": "user",
    "content": [
      { "type": "tool_result", "tool_use_id": "toolu_...", "content": "..." }
    ]
  }
}
```

## Tool Execution Flow

### Normal Flow

1. Assistant emits `tool_use` content block (persisted immediately)
2. SDK calls `canUseTool` callback for approval
3. If approved: tool executes, `tool_result` is persisted as user message
4. If denied: `tool_result` with denial message is persisted

### Interrupted Flow (Process Killed Mid-Approval)

When a process is killed while waiting for tool approval:

1. `tool_use` **IS persisted** (written before approval request)
2. `tool_result` is **NOT persisted** (tool never executed)
3. Result: **orphaned tool_use** in the JSONL

Example from real session:
```
Line 109: tool_use (Write to test123.txt) - PERSISTED
Line 110: queue-operation (internal)
Line 111: file-history-snapshot (internal)
Line 112: user text message (new conversation) - NO tool_result!
```

### Why This Doesn't Break Resumption

The `parentUuid` system allows clean recovery:

1. When session resumes, SDK finds the last "complete" message
2. New messages connect to that parent, not to orphaned tool_use
3. Orphaned tool_use becomes a **dead branch** - exists in file but unreachable in active conversation path

```
                    [text response]
                         |
            +------------+------------+
            |                         |
    [orphaned tool_use]        [resumed user message]
         (dead branch)              |
                              [new assistant response]
```

## Idle Timeout Behavior

### Configuration

```typescript
// packages/server/src/config.ts
idleTimeoutMs: parseIntOrDefault(process.env.IDLE_TIMEOUT, 5 * 60) * 1000
```

- Environment variable: `IDLE_TIMEOUT` (in seconds)
- Default: 300 seconds (5 minutes)

### When Timer Runs

The idle timer is **turn-aware**:

1. Timer only starts after a turn completes (`result` message received)
2. Timer is cleared when new message is queued
3. No timer runs while agent is actively processing

This means setting a very low timeout (e.g., 20 seconds) will NOT kill an agent mid-turn. It only terminates after the turn completes and the timeout elapses with no new messages.

### Waiting-Input State

Currently, `waiting-input` state (pending tool approval) **prevents idle timeout**:

```typescript
// Don't transition to idle if we're waiting for input
if (this._state.type !== "waiting-input") {
  this.transitionToIdle();
}
```

**Implication**: A process waiting for tool approval will stay alive indefinitely. If user closes tab during approval prompt, process never terminates.

**Potential improvement**: Apply timeout to waiting-input state, inject synthetic tool_result on timeout.

## Implications for Claude-Anywhere

### Session Reader

When reading sessions from JSONL for display:

1. Must traverse `parentUuid` chain to build conversation
2. Dead branches should be excluded from main view
3. Could optionally show/hide branches in UI

### Process Resumption

When resuming a session:

1. Find the "tip" of the main conversation branch
2. Don't assume last line in file is the continuation point
3. Handle case where tip is an orphaned tool_use (rare but possible)

### SSE Event Replay

When late-joining clients request history:

1. Build history by walking `parentUuid` chain from tip
2. Exclude dead branches and internal events (`queue-operation`, `file-history-snapshot`)
3. Include tool_use/tool_result pairs for complete context

### Handling Interrupted Tool Calls

Options when encountering orphaned tool_use:

1. **Ignore** - Don't show incomplete tool calls
2. **Show as interrupted** - Display with "interrupted" or "timed out" status
3. **Inject synthetic result** - Add tool_result indicating operation was aborted

### Multi-Tab Synchronization

The `parentUuid` structure could enable:

1. Different tabs showing different branches
2. Merging user input from multiple sources
3. Conflict resolution when tabs diverge

## Testing Recommendations

### Session Resumption Tests

1. Normal resumption after idle timeout
2. Resumption after process kill during tool approval
3. Resumption with orphaned tool_use in history
4. Resumption from old branch (not latest message)

### Edge Cases

1. Kill process immediately after tool_use persisted but before approval prompt shown
2. Multiple rapid tool calls with kills in between
3. Session file corruption (missing entries, broken parentUuid chain)
4. Very long sessions with many branches

## File Locations

- Session files: `~/.claude/projects/<project-id>/<session-id>.jsonl`
- Project ID derived from path: `-home-user-code-project` format
- Agent files may use prefix: `agent-<short-hash>.jsonl`

## Open Questions

1. How does Claude API handle orphaned tool_use in conversation history? (Seems tolerant based on testing)
2. What determines `isSidechain: true` vs `false`?
3. Are there other event types beyond message/queue-operation/file-history-snapshot?
4. How are file-history-snapshots used during resumption?
5. What's the maximum supported branch depth/width?

## Sub-Agent (Task Tool) Architecture

When Claude spawns a sub-agent via the Task tool, it creates a separate conversation.

### Storage

**Two historical approaches:**

1. **Legacy** (`isSidechain: true`): Sub-agent embedded in same session JSONL
2. **Current**: Separate `agent-{agentId}.jsonl` files

Current approach stores sub-agents in files like:
```
~/.claude/projects/<project-id>/agent-a033404.jsonl
```

### Linking Parent to Sub-Agent

The Task tool's `tool_result` includes an `agentId` field:

```json
{
  "type": "tool_result",
  "tool_use_id": "toolu_...",
  "content": "...",
  "toolUseResult": {
    "agentId": "a033404"
  }
}
```

This ID links to `agent-a033404.jsonl`.

### Sub-Agent JSONL Structure

Sub-agent files have the **same structure** as main session files:
- `parentUuid` / `uuid` for conversation graph
- `sessionId` **matches parent session** (interesting - shares session ID)
- Same message types (user, assistant, tool_use, tool_result, thinking)

### Sub-Agents CAN Use Tools

Sub-agents are NOT read-only. Example from a real agent file:
- 10 Read calls
- 4 Glob calls
- 2 Bash calls
- 1 Grep call

They primarily do research but can execute any tool.

### Real-Time Updates

VSCode gets sub-agent updates via SSE:
1. Server watches `agent-*.jsonl` files for changes
2. Emits `agentSessionChanged` event with `projectId` and `agentSessionId`
3. Client invalidates React Query cache → triggers refetch
4. UI updates to show new sub-agent messages

### API Endpoint

```
GET /api/projects/:projectId/agent-sessions/:agentId
```

Returns the parsed contents of `agent-{agentId}.jsonl`.

### Implications for Claude-Anywhere

1. **Must watch agent files** - not just main session files
2. **Link via toolUseResult.agentId** - parse tool results to find sub-agent IDs
3. **Consider SSE for agent updates** - separate event type for agent sessions
4. **Same parsing logic** - agent files use identical JSONL schema

## Comparison with claude-code-viewer

claude-code-viewer (separate project) handles JSONL:

| Aspect | Their Approach |
|--------|---------------|
| Main conversation | Line order in JSONL (no tree traversal) |
| Sidechains | Walk `parentUuid` to find root, group by root |
| Dead branches | Not explicitly handled |
| Sub-agents | Fetch via API using `agentId` from tool_result |
| Real-time | SSE events trigger React Query invalidation |

**Their code reference:**
- `src/app/projects/[projectId]/sessions/[sessionId]/hooks/useSidechain.ts` - sidechain grouping
- `src/app/projects/[projectId]/sessions/[sessionId]/components/conversationList/TaskModal.tsx` - sub-agent display
- `src/app/components/SSEEventListeners.tsx` - real-time updates

## References

- Session file analyzed: `c7d5ec07-9d1c-4f5f-839b-c2bac30a7587.jsonl`
- Agent file analyzed: `agent-a033404.jsonl`
- Process management: `packages/server/src/supervisor/Process.ts`
- Configuration: `packages/server/src/config.ts`
- claude-code-viewer: `~/code/claude-code-viewer/`
