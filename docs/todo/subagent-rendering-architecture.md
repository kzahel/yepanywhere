# Subagent Rendering Architecture

## Problem

Subagent (Task tool) messages currently appear in weird places in the UI:
- During streaming: messages get reordered by `orderByParentChain` and end up at the bottom
- On reload: subagent messages disappear entirely (stored in separate agent JSONL files)
- User has to scroll UP to see recent activity when Tasks are running

## Root Cause

Subagent messages have their own DAG structure (parentUuid chain) in their own session files. When mixed into the parent session's message list:
- `orderByParentChain` treats them as orphans (not connected to parent DAG)
- Orphans get appended at the end
- Creates confusing, unpredictable ordering

## Solution: Nested Task Architecture

**Core principle**: Subagent content is NEVER free-floating in the main message list. It's always rendered inside the Task component that spawned it.

### Data Model

```
Parent Session:
├── messages: Message[]           # Only parent session messages
└── agentContent: Map<agentId, {
      messages: Message[],
      status: 'pending' | 'running' | 'completed' | 'failed'
    }>
```

### Message Flow

```
SSE Message arrives
  ├── isSubagent: false → append to messages[]
  └── isSubagent: true  → append to agentContent[agentId].messages
```

### Task States & Display

| State | Criteria | Display |
|-------|----------|---------|
| **Pending** | tool_use exists, no process, no agent file | Collapsed, "pending" badge |
| **Running** | process active OR agent file growing | Expanded, live preview |
| **Completed** | tool_result exists, status=completed | Collapsed, expandable |
| **Failed** | tool_result with is_error OR status=failed | Collapsed, error badge |

### Live Activity Preview

When collapsed or running, show last N items as a compact preview:

```
▶ Task: Research Trees — running
   ├─ [Read] src/forest.ts
   ├─ [Grep] "photosynthesis"
   └─ Found 3 matches...
```

This surfaces activity without cluttering the main timeline.

### Visual Design

**Collapsed Task (Completed)**
```
┌────────────────────────────────────────────────┐
│ ▶ Task: Research Trees                         │
│   ✓ completed · 12.3s · 48k tokens · 5 tools   │
└────────────────────────────────────────────────┘
```

**Collapsed Task (Running) with Preview**
```
┌────────────────────────────────────────────────┐
│ ▼ Task: Research Trees                    ···  │
│   ◐ running · 3.2s                             │
│   ┊                                            │
│   ├─ [Grep] "tree|forest"                      │
│   ├─ [Read] src/utils/forest.ts                │
│   └─ Analyzing forest utilities...             │
└────────────────────────────────────────────────┘
```

**Expanded Task**
```
┌────────────────────────────────────────────────┐
│ ▼ Task: Research Trees                         │
│   ✓ completed · 12.3s · 48k tokens · 5 tools   │
├────────────────────────────────────────────────┤
│ │ I'll search for tree-related code...         │
│ │                                              │
│ │ ┌─ Grep ─────────────────────────────────┐   │
│ │ │ pattern: "tree|forest"                 │   │
│ │ │ Found 12 files                         │   │
│ │ └────────────────────────────────────────┘   │
│ │                                              │
│ │ Based on my research, trees in this          │
│ │ codebase handle...                           │
└────────────────────────────────────────────────┘
```

---

## Implementation Phases

Each phase is designed to be completed independently. Run all tests after each phase to ensure no regressions.

---

## Phase 1: Filter Subagent Messages from Main Message List

### Goal
Route subagent messages to separate state instead of mixing them into the main `messages[]` array. This fixes the ordering issues caused by `orderByParentChain`.

### Background Context

**How subagent messages currently flow:**
1. Claude calls Task tool → SDK spawns subagent process
2. Subagent writes to `agent-{agentId}.jsonl` (separate file)
3. SSE streams subagent messages with `isSubagent: true` and `session_id` = agent session ID
4. Currently: these get added to main `messages[]` and `orderByParentChain` breaks ordering

**Key files to understand:**
- `packages/client/src/hooks/useSession.ts` - `handleSSEMessage` function processes incoming SSE
- `packages/client/src/lib/mergeMessages.ts` - `mergeSSEMessage` and `mergeJSONLMessages`
- `packages/server/src/routes/stream.ts` - `markSubagent` function adds `isSubagent: true`

### Implementation Steps

1. **Add `agentContent` state to `useSession.ts`**
   ```typescript
   const [agentContent, setAgentContent] = useState<
     Record<string, { messages: Message[]; status: string }>
   >({});
   ```

2. **Modify `handleSSEMessage` to route subagent messages**
   - Check `incoming.isSubagent`
   - If true, extract `agentId` from `incoming.session_id` (format: agent session ID)
   - Append to `agentContent[agentId].messages`
   - Return early - don't add to main `messages[]`

3. **Extract `agentId` correctly**
   - SSE messages have `session_id` field
   - For subagents, this is the agent's session ID (different from parent)
   - May need to parse or use `parent_tool_use_id` to correlate with Task

4. **Return `agentContent` from hook**
   - Add to return object so components can access it

5. **Clean up on session change**
   - Reset `agentContent` when `sessionId` changes

### Testing Strategy

**Unit Tests** (`packages/client/src/lib/__tests__/subagentRouting.test.ts` - new file)

```typescript
describe('subagent message routing', () => {
  it('identifies subagent messages by isSubagent flag', () => {
    const msg = { id: '1', isSubagent: true, session_id: 'agent-abc' };
    expect(isSubagentMessage(msg)).toBe(true);
  });

  it('extracts agentId from session_id', () => {
    const msg = { session_id: 'agent-abc123' };
    expect(extractAgentId(msg)).toBe('agent-abc123');
  });

  it('groups messages by agentId', () => {
    const messages = [
      { id: '1', isSubagent: true, session_id: 'agent-a' },
      { id: '2', isSubagent: true, session_id: 'agent-b' },
      { id: '3', isSubagent: true, session_id: 'agent-a' },
    ];
    const grouped = groupByAgentId(messages);
    expect(grouped['agent-a']).toHaveLength(2);
    expect(grouped['agent-b']).toHaveLength(1);
  });
});
```

**Integration Test** - Verify SSE routing works end-to-end (can be manual or add to E2E)

### Verification

After this phase:
- [ ] Subagent messages no longer appear in main message list
- [ ] `agentContent` state contains subagent messages grouped by agentId
- [ ] Main session DAG ordering is correct (no orphans at bottom)
- [ ] Existing tests pass

---

## Phase 2: Server Endpoint for Agent Content

### Goal
Add API endpoint to fetch agent session content for lazy-loading completed Tasks.

### Background Context

**Agent JSONL file structure:**
- Location: `~/.claude/projects/{projectId}/agent-{agentId}.jsonl`
- Same format as parent session JSONL
- Each line is a JSON message with `uuid`, `parentUuid`, `type`, etc.
- First line often has `sessionId` field pointing to parent session

**Key files to understand:**
- `packages/server/src/sessions/reader.ts` - `SessionReader` class reads JSONL files
- `packages/server/src/routes/sessions.ts` - Session API routes
- `packages/server/src/sessions/dag.ts` - DAG filtering logic

### Implementation Steps

1. **Add `getAgentSession` method to `SessionReader`**
   ```typescript
   async getAgentSession(
     projectId: string,
     parentSessionId: string,
     agentId: string
   ): Promise<{ messages: Message[]; status: string }>
   ```
   - Construct path: `{projectDir}/agent-{agentId}.jsonl`
   - Read and parse JSONL
   - Apply DAG filtering (get active branch only)
   - Infer status from last message

2. **Add API route**
   ```typescript
   // GET /api/projects/:projectId/sessions/:sessionId/agents/:agentId
   routes.get('/projects/:projectId/sessions/:sessionId/agents/:agentId', async (c) => {
     const { projectId, sessionId, agentId } = c.req.param();
     const result = await reader.getAgentSession(projectId, sessionId, agentId);
     return c.json(result);
   });
   ```

3. **Infer agent status from messages**
   ```typescript
   function inferAgentStatus(messages: Message[]): string {
     if (messages.length === 0) return 'pending';
     const last = messages[messages.length - 1];
     // Check for error indicators
     if (last.type === 'result' && last.is_error) return 'failed';
     if (last.type === 'result') return 'completed';
     // If no result message, still running or interrupted
     return 'running';
   }
   ```

4. **Add client API method**
   ```typescript
   // packages/client/src/api/client.ts
   async getAgentSession(
     projectId: string,
     sessionId: string,
     agentId: string
   ): Promise<{ messages: Message[]; status: string }>
   ```

### Testing Strategy

**Unit Tests** (`packages/server/test/sessions/reader.test.ts` - extend existing)

```typescript
describe('SessionReader.getAgentSession', () => {
  it('reads agent JSONL file', async () => {
    // Create fixture: agent-test123.jsonl with sample messages
    const result = await reader.getAgentSession('proj1', 'session1', 'test123');
    expect(result.messages).toHaveLength(expectedCount);
  });

  it('returns empty for missing agent file', async () => {
    const result = await reader.getAgentSession('proj1', 'session1', 'nonexistent');
    expect(result.messages).toHaveLength(0);
    expect(result.status).toBe('pending');
  });

  it('infers completed status from result message', async () => {
    // Fixture with final result message
    const result = await reader.getAgentSession('proj1', 'session1', 'completed-agent');
    expect(result.status).toBe('completed');
  });

  it('infers failed status from error result', async () => {
    // Fixture with is_error: true
    const result = await reader.getAgentSession('proj1', 'session1', 'failed-agent');
    expect(result.status).toBe('failed');
  });
});
```

**API Tests** (`packages/server/test/api/sessions.test.ts` - extend existing)

```typescript
describe('GET /projects/:projectId/sessions/:sessionId/agents/:agentId', () => {
  it('returns agent messages', async () => {
    const res = await app.request('/api/projects/p1/sessions/s1/agents/a1');
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.messages).toBeDefined();
    expect(data.status).toBeDefined();
  });

  it('returns 200 with empty messages for unknown agent', async () => {
    // Graceful handling - don't 404, just return empty
    const res = await app.request('/api/projects/p1/sessions/s1/agents/unknown');
    expect(res.status).toBe(200);
    expect((await res.json()).messages).toHaveLength(0);
  });
});
```

**Test Fixtures** - Create in `packages/server/test/fixtures/agents/`

```
agent-completed.jsonl   # Agent with successful result
agent-failed.jsonl      # Agent with error result
agent-running.jsonl     # Agent without result (incomplete)
```

### Verification

After this phase:
- [ ] New API endpoint returns agent messages
- [ ] Status inference works correctly
- [ ] Client can call `api.getAgentSession()`
- [ ] Existing tests pass

---

## Phase 3: Update TaskRenderer for Nested Content

### Goal
Modify TaskRenderer to display subagent content inline, with expand/collapse and lazy-loading.

### Background Context

**Current TaskRenderer:**
- Location: `packages/client/src/components/renderers/tools/TaskRenderer.tsx`
- Shows Task input (description, prompt) and result summary
- Already has expand/collapse for result content
- Result contains `agentId`, `status`, `content` (summary), `totalDurationMs`, `totalTokens`

**How data flows to TaskRenderer:**
- `ToolCallRow.tsx` renders tool calls, delegates to tool-specific renderers
- `taskRenderer` object has `renderToolUse` and `renderToolResult` methods
- Currently receives `input` and `result` from preprocessed messages

### Implementation Steps

1. **Pass `agentContent` to TaskRenderer**
   - Option A: React Context for agent content
   - Option B: Props drilling through ToolCallRow
   - Recommend Option A for cleaner code

2. **Create AgentContentContext**
   ```typescript
   // packages/client/src/contexts/AgentContentContext.tsx
   const AgentContentContext = createContext<{
     agentContent: Record<string, { messages: Message[]; status: string }>;
     loadAgentContent: (agentId: string) => Promise<void>;
   }>(null);
   ```

3. **Modify TaskRenderer to use context**
   - Get `agentId` from result (already available)
   - Check `agentContent[agentId]` for live streaming data
   - If not available and task completed, offer lazy-load button
   - Show preview (last 3 items) when collapsed

4. **Add lazy-loading**
   ```typescript
   const handleExpand = async () => {
     if (!agentContent[agentId] && result?.agentId) {
       await loadAgentContent(result.agentId);
     }
     setIsExpanded(true);
   };
   ```

5. **Render nested messages**
   - Reuse existing message rendering components
   - Apply indentation/nesting styles
   - Show tool calls, text, thinking blocks from agent

6. **Live preview for running tasks**
   ```typescript
   const previewItems = agentContent[agentId]?.messages.slice(-3) ?? [];
   ```

### Testing Strategy

**Component Tests** (`packages/client/src/components/__tests__/TaskRenderer.test.tsx` - new file)

```typescript
describe('TaskRenderer', () => {
  it('shows collapsed view for completed task', () => {
    render(<TaskRenderer result={{ status: 'completed', agentId: 'abc' }} />);
    expect(screen.getByText('▶')).toBeInTheDocument(); // Collapsed indicator
  });

  it('shows expanded view for running task', () => {
    // Mock agentContent with live messages
    render(
      <AgentContentProvider value={{ 'abc': { messages: [...], status: 'running' } }}>
        <TaskRenderer result={{ status: 'running', agentId: 'abc' }} />
      </AgentContentProvider>
    );
    expect(screen.getByText('▼')).toBeInTheDocument(); // Expanded
  });

  it('lazy-loads content on expand click', async () => {
    const loadFn = vi.fn();
    render(
      <AgentContentProvider value={{ loadAgentContent: loadFn }}>
        <TaskRenderer result={{ status: 'completed', agentId: 'abc' }} />
      </AgentContentProvider>
    );
    await userEvent.click(screen.getByRole('button', { name: /expand/i }));
    expect(loadFn).toHaveBeenCalledWith('abc');
  });

  it('shows preview of last 3 items when collapsed', () => {
    // Mock agentContent with 5 messages
    // Verify only last 3 shown in preview
  });
});
```

**Visual/Manual Testing**
- Run dev server, trigger Task tool
- Verify collapsed/expanded states
- Verify lazy-loading works
- Verify live preview updates

### Verification

After this phase:
- [ ] Running Tasks show expanded with live content
- [ ] Completed Tasks show collapsed with expand button
- [ ] Expanding loads content via API
- [ ] Preview shows last N items
- [ ] Existing tests pass

---

## Phase 4: Handle Reload Mid-Task

### Goal
When page reloads while Tasks are running, correctly restore state and resume streaming.

### Background Context

**Current reload behavior:**
- Parent JSONL loaded → Task tool_use visible, no tool_result
- Agent JSONL exists but not read → subagent content missing
- SSE connects → new subagent messages stream but nowhere to show them

**What should happen:**
1. Load parent session → detect pending Tasks (tool_use without tool_result)
2. For each pending Task, check if agent file exists
3. Load agent content-so-far
4. Resume SSE streaming into existing agent content

### Implementation Steps

1. **Detect pending Tasks on session load**
   ```typescript
   // In useSession.ts, after loading messages
   const pendingTasks = findPendingTasks(messages);
   // Returns: [{ toolUseId, agentId }]
   ```

2. **Helper to find pending Tasks**
   ```typescript
   function findPendingTasks(messages: Message[]): PendingTask[] {
     const toolUses = new Map<string, { agentId?: string }>();
     const completedIds = new Set<string>();

     for (const msg of messages) {
       // Find Task tool_use blocks
       if (msg.content && Array.isArray(msg.content)) {
         for (const block of msg.content) {
           if (block.type === 'tool_use' && block.name === 'Task') {
             toolUses.set(block.id, { agentId: block.input?.agentId });
           }
           if (block.type === 'tool_result') {
             completedIds.add(block.tool_use_id);
           }
         }
       }
     }

     return [...toolUses.entries()]
       .filter(([id]) => !completedIds.has(id))
       .map(([toolUseId, { agentId }]) => ({ toolUseId, agentId }));
   }
   ```

3. **Load agent content on session load**
   ```typescript
   useEffect(() => {
     const loadPendingAgents = async () => {
       const pending = findPendingTasks(messages);
       for (const { agentId } of pending) {
         if (agentId) {
           const data = await api.getAgentSession(projectId, sessionId, agentId);
           setAgentContent(prev => ({
             ...prev,
             [agentId]: data
           }));
         }
       }
     };
     loadPendingAgents();
   }, [messages, projectId, sessionId]);
   ```

4. **Handle SSE reconnection**
   - When SSE connects, existing subagent messages may replay
   - Dedupe by message ID in `agentContent` update logic

5. **Infer agentId from Task tool_use**
   - Issue: `agentId` is in tool_result, not tool_use
   - May need server to return agent file mappings
   - Or: scan agent files, match by `parent_tool_use_id`

### Testing Strategy

**E2E Test** (`packages/server/test/e2e/real-sdk.e2e.test.ts` - extend)

This is the critical test that verifies the full flow with real SDK:

```typescript
it('should handle parallel Tasks and reload correctly', async () => {
  if (!cliAvailable) return;

  // Step 1: Start session that spawns parallel Tasks
  const { iterator, abort } = await sdk.startSession({
    cwd: testDir,
    initialMessage: {
      text: `I need you to research two topics IN PARALLEL using the Task tool.
             Launch BOTH tasks at the same time in a single response:
             1. Task to research "prime numbers" - use Explore agent
             2. Task to research "fibonacci sequence" - use Explore agent
             After both complete, give me a one-sentence summary of each.`
    },
    permissionMode: 'bypassPermissions',
  });

  const allMessages: SDKMessage[] = [];
  const taskToolUses: string[] = [];
  const subagentMessages: Map<string, SDKMessage[]> = new Map();

  const timeout = setTimeout(() => abort(), 120000);

  try {
    for await (const message of iterator) {
      allMessages.push(message);
      logMessage(message);

      // Track Task tool uses
      if (message.type === 'assistant' && message.message?.content) {
        for (const block of message.message.content) {
          if (block.type === 'tool_use' && block.name === 'Task') {
            taskToolUses.push(block.id);
            log(`[Task tool_use] ${block.id}: ${block.input?.description}`);
          }
        }
      }

      // Track subagent messages
      if (message.isSubagent && message.session_id) {
        const agentId = message.session_id;
        if (!subagentMessages.has(agentId)) {
          subagentMessages.set(agentId, []);
        }
        subagentMessages.get(agentId)!.push(message);
      }

      if (message.type === 'result') break;
    }
  } finally {
    clearTimeout(timeout);
  }

  // Verify parallel Tasks were created
  log(`[Task count] ${taskToolUses.length}`);
  expect(taskToolUses.length).toBeGreaterThanOrEqual(2);

  // Verify subagent messages were received from multiple agents
  log(`[Agent count] ${subagentMessages.size}`);
  expect(subagentMessages.size).toBeGreaterThanOrEqual(2);

  // Verify each agent produced messages
  for (const [agentId, messages] of subagentMessages) {
    log(`[Agent ${agentId}] ${messages.length} messages`);
    expect(messages.length).toBeGreaterThan(0);
  }

  // Verify agent files exist on disk
  const initMessage = allMessages.find(m => m.type === 'system');
  const sessionId = (initMessage as any)?.session_id;

  // Find project directory and check for agent files
  const claudeDir = join(process.env.HOME || '', '.claude', 'projects');
  let agentFilesFound = 0;

  const projectDirs = readdirSync(claudeDir);
  for (const projectDir of projectDirs) {
    try {
      const files = readdirSync(join(claudeDir, projectDir));
      agentFilesFound += files.filter(f => f.startsWith('agent-')).length;
    } catch {}
  }

  log(`[Agent files on disk] ${agentFilesFound}`);
  expect(agentFilesFound).toBeGreaterThanOrEqual(2);

}, 180000); // 3 minute timeout for parallel tasks
```

**Unit Tests for Pending Task Detection**

```typescript
describe('findPendingTasks', () => {
  it('finds Task tool_use without matching tool_result', () => {
    const messages = [
      {
        type: 'assistant',
        content: [
          { type: 'tool_use', id: 'task-1', name: 'Task', input: {} },
          { type: 'tool_use', id: 'task-2', name: 'Task', input: {} },
        ]
      },
      {
        type: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'task-1', content: '...' }
        ]
      }
    ];
    const pending = findPendingTasks(messages);
    expect(pending).toHaveLength(1);
    expect(pending[0].toolUseId).toBe('task-2');
  });

  it('returns empty array when all Tasks complete', () => {
    // All tool_use have matching tool_result
  });
});
```

### Verification

After this phase:
- [ ] Reload mid-task shows agent content-so-far
- [ ] SSE resumes streaming into correct agent
- [ ] No duplicate messages after reconnect
- [ ] Parallel tasks both restore correctly
- [ ] E2E test passes

---

## E2E Testing Notes

### Running E2E Tests

```bash
# Run all E2E tests (requires Claude CLI + auth)
REAL_SDK_TESTS=true pnpm test:e2e

# Run with verbose output
REAL_SDK_TESTS=true FOREGROUND=1 pnpm test:e2e

# Run specific test
REAL_SDK_TESTS=true pnpm test:e2e -- --grep "parallel Tasks"
```

### Test Environment Requirements

- Claude CLI installed (`claude` command available)
- Valid authentication (API key or OAuth)
- Tests create temp directories, clean up after

### What E2E Tests Verify

1. **Real SDK integration** - actual Claude CLI subprocess
2. **SSE message streaming** - real async iteration
3. **Subagent spawning** - Task tool creates real agent processes
4. **File system state** - agent JSONL files created on disk
5. **Parallel execution** - multiple Tasks run concurrently

---

## Migration Notes

- Existing sessions work (no tool_result = pending, with result = collapsed)
- Live streaming behavior changes but improves
- No data migration needed - just rendering logic changes
- Backwards compatible: old sessions without subagent content still work

---

## Related Files

| File | Purpose |
|------|---------|
| `packages/client/src/hooks/useSession.ts` | Session state, SSE handling, agentContent state |
| `packages/client/src/lib/mergeMessages.ts` | Message merging (subagent filtering) |
| `packages/client/src/components/renderers/tools/TaskRenderer.tsx` | Task display, expand/collapse |
| `packages/client/src/components/ToolCallRow.tsx` | Routes to tool renderers |
| `packages/server/src/routes/sessions.ts` | Session API, new agent endpoint |
| `packages/server/src/routes/stream.ts` | SSE streaming, `markSubagent` |
| `packages/server/src/sessions/reader.ts` | JSONL reading, new `getAgentSession` |
| `packages/server/src/sessions/dag.ts` | DAG filtering logic |
| `packages/server/test/e2e/real-sdk.e2e.test.ts` | E2E tests with real SDK |
| `docs/todo/subagent-message-consistency.md` | Original problem analysis |
