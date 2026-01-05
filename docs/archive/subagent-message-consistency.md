# Subagent Message Consistency

## Current State

When Claude spawns subagents via the Task tool, messages from those subagents now appear in the parent session's stream with visual distinction (purple left border, slight dimming).

**SSE streaming**: Works correctly - subagent messages are marked with `isSubagent: true` and displayed inline.

**JSONL on reload**: Subagent messages do NOT appear after page reload because they're stored in separate `agent-*.jsonl` files, not the parent session's JSONL file.

## The Problem

The SDK writes subagent messages to separate files:
- Parent session: `{sessionId}.jsonl`
- Subagent sessions: `agent-{agentId}.jsonl`

Our `SessionReader.getSession()` only reads the parent session's file, so subagent messages are missing on page reload.

### Observed Issue (Dec 2024)

When viewing session `2307204a-5b88-47f7-900a-c5d826b08cd0`, two Task tools were called:
1. "Research VS Code git integration" (`toolu_01VUH9CX9R2uc4muy7r4dajE`) - general-purpose agent
2. "Explore current codebase git handling" (`toolu_01QZxiwdJZCCu2bURuRxEyEe`) - Explore agent

**What happened:**
- The Explore agent completed and its result was written to the parent session JSONL
- The general-purpose agent's JSONL exists at `agent-a34f87f.jsonl` but:
  - It hit errors ("Tool permission stream closed before response received")
  - Its result was **never written back** to the parent session
- UI shows the first Task as "pending" forever because there's no matching `tool_result`

### How Subagent Files Work

Each subagent file has:
```json
{
  "agentId": "a34f87f",           // Unique agent ID (short hash)
  "sessionId": "2307204a-...",     // Parent session ID
  "isSidechain": true,             // Indicates subagent context
  "parentUuid": "...",             // DAG parent in the agent's conversation
  ...
}
```

The parent session receives a `tool_result` with:
```json
{
  "toolUseResult": {
    "agentId": "a86e430",          // Links to agent-a86e430.jsonl
    "status": "completed",
    "content": [...],
    "totalDurationMs": 55129,
    "totalTokens": 48005
  }
}
```

## Recommended Solution: Read Agent Files for Status

### Goal
Show accurate Task status (pending/running/completed/failed) by reading subagent files.

### Implementation Plan

#### Phase 1: Detect Subagent State from Files

1. **Update `SessionReader` to discover related agent files**
   - When reading a session, scan for `agent-*.jsonl` files in the same directory
   - Parse first line of each to get `sessionId` field
   - Filter to agents that belong to the current session

2. **Add `getAgentStatus(agentId)` method**
   ```typescript
   interface AgentStatus {
     agentId: string;
     state: 'running' | 'completed' | 'failed' | 'unknown';
     error?: string;
     messageCount: number;
     lastUpdated: string;
   }
   ```

   Logic:
   - Check if `agent-{agentId}.jsonl` exists
   - Parse last few lines to determine state:
     - If last message is `tool_result` with `is_error: true` → `failed`
     - If last message is assistant with final content → `completed`
     - If file exists but no conclusion → `running` or `unknown`

3. **Enhance `getSession()` response**
   - For each `tool_use` with `name: "Task"`, include its agent status
   - Add `agentStatuses: Record<string, AgentStatus>` to session response

#### Phase 2: Link to Subagent Conversations

1. **Add endpoint to fetch subagent session**
   ```
   GET /api/projects/:projectId/sessions/:sessionId/agents/:agentId
   ```
   Returns the agent's conversation history (parsed from agent-{agentId}.jsonl)

2. **UI: Add "View agent conversation" link**
   - TaskRenderer shows expand button for agents with data
   - Opens modal or side panel with full subagent conversation

#### Phase 3: Real-time Subagent Updates (Optional)

1. **Watch agent files during streaming**
   - When a Task tool_use is emitted, start watching `agent-{agentId}.jsonl`
   - Stream agent messages to client with `isSubagent: true`

2. **File watcher integration**
   - EventBus could emit `AgentFileChangeEvent`
   - Client subscribes to agent-specific updates

## Alternative: Orphan Detection Enhancement

If full agent file reading is too complex, a simpler fix:

1. **Improve orphan detection for external sessions**
   - Current: `includeOrphans: wasEverOwned && !process`
   - Fix: `includeOrphans: !process && !isExternal`
   - This marks Task tools as "aborted" when session is idle

2. **Check agent file existence**
   - Before marking orphaned, check if `agent-{agentId}.jsonl` exists
   - If it exists, check its last message for actual status
   - Only mark as "aborted" if agent file also shows interrupted state

## Implementation Priority

1. **Quick Win**: Fix orphan detection to work for idle external sessions
2. **Phase 1**: Read agent files for accurate status display
3. **Phase 2**: Allow viewing subagent conversations
4. **Phase 3**: Real-time subagent streaming (nice to have)

## Related Files

- `packages/server/src/routes/sessions.ts` - Session API, orphan detection logic
- `packages/server/src/sessions/reader.ts` - Reads JSONL files (currently filters out agent-* files)
- `packages/server/src/sessions/dag.ts` - DAG building, orphan detection
- `packages/client/src/components/renderers/tools/TaskRenderer.tsx` - Task tool display
- `packages/client/src/lib/preprocessMessages.ts` - Tool call status logic
- `packages/client/src/styles/renderers.css` - CSS for `.subagent-item` class

## Test Cases

1. **Completed subagent**: Task result in parent JSONL, agent file exists with completion
2. **Failed subagent**: Agent file shows error, no result in parent JSONL
3. **Running subagent**: Agent file exists and growing, no result yet
4. **Orphaned subagent**: No agent file, no result (process killed before agent started)
5. **Multiple parallel agents**: Two Task calls in same message, different completion states
