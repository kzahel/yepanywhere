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

## Potential Solutions

### Option 1: Read agent-*.jsonl files too
Update `SessionReader` to:
1. Read the parent session's JSONL
2. Find related `agent-*.jsonl` files (matching by `parent_tool_use_id` or timestamp range)
3. Merge them chronologically
4. Mark merged messages with `isSubagent: true`

Complexity: Medium - need to figure out which agent files belong to which parent session.

### Option 2: Accept the inconsistency
Live streaming shows subagent messages, page reload doesn't. Users who want to see subagent details can expand the Task tool result which contains a summary.

Complexity: None - it's the current state.

### Option 3: Store subagent session IDs in parent JSONL
When a Task tool completes, the result could include the subagent's session ID. The reader could then fetch that session's messages.

Complexity: Requires SDK changes or post-processing.

## Related Files

- `packages/server/src/routes/stream.ts` - Marks subagent messages in SSE stream
- `packages/server/src/sessions/reader.ts` - Reads JSONL files (currently filters out agent-* files)
- `packages/client/src/components/RenderItemComponent.tsx` - Applies visual styling for subagent items
- `packages/client/src/styles/renderers.css` - CSS for `.subagent-item` class
