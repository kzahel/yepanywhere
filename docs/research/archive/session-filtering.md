# Session Filtering: What Counts as a "Real" Session?

Claude Code stores session data in `~/.claude/projects/` as JSONL files. Not all files represent user-facing sessions - many are internal metadata, agent sidechains, or empty placeholders. This document describes how we filter these out and compares our approach to claude-code-viewer.

## Claude Code Session File Structure

### Directory Layout
```
~/.claude/projects/
├── -home-user-project/                    # Old format (direct)
│   ├── abc123.jsonl                       # Regular session
│   ├── agent-a1b2c3.jsonl                 # Agent sidechain
│   └── def456.jsonl                       # Regular session
└── hostname/                              # New format (with hostname)
    └── -home-user-project/
        └── ...
```

### JSONL Message Types

Each line in a session file is a JSON object with a `type` field:

| Type | Description | User-facing? |
|------|-------------|--------------|
| `user` | User messages | Yes |
| `assistant` | Claude responses | Yes |
| `system` | System messages | Sometimes |
| `summary` | Conversation summaries | No |
| `file-history-snapshot` | File state tracking | No |
| `queue-operation` | Internal queue state | No |

### Special Files

| Pattern | Description |
|---------|-------------|
| `agent-*.jsonl` | Subagent sidechain sessions (Task tool) |
| Empty files (0 bytes) | Placeholder files, never used |
| Files with only metadata | Sessions that never had real conversation |

## Our Current Approach (claude-anywhere)

### File-Level Filtering

In `scanner.ts` and `reader.ts`:
```typescript
// Exclude agent-* files (internal subagent warmup sessions)
files.filter(f => f.endsWith(".jsonl") && !f.startsWith("agent-"))
```

### Session-Level Filtering

In `reader.ts` `getSessionSummary()`:
1. Skip empty files (no content after trim)
2. Parse all JSONL lines
3. Filter to only `user`/`assistant` messages
4. Skip sessions with 0 conversation messages

```typescript
const conversationMessages = messages.filter(
  (m) => m.type === "user" || m.type === "assistant",
);
if (conversationMessages.length === 0) {
  return null;  // Don't show this session
}
```

### Title Extraction

We use the first user message content as the title (truncated to 50 chars).

**Not currently filtered:**
- "Warmup" messages
- Sidechain messages (`isSidechain: true`)
- System commands (`/clear`, `/login`, etc.)

## claude-code-viewer's Approach

### File-Level Filtering

Same as ours:
```typescript
// isRegularSessionFile.ts
export const isRegularSessionFile = (filename: string): boolean =>
  filename.endsWith(".jsonl") && !filename.startsWith("agent-");
```

### Session-Level Filtering

**Key difference:** They show ALL sessions, even empty/metadata-only ones. They don't filter out sessions with no conversation messages.

### Title/Preview Filtering

They filter the **first message preview** more aggressively:

```typescript
// isValidFirstMessage.ts
if (conversation.isSidechain === true) return undefined;
if (firstUserText === "Warmup") return undefined;
if (firstUserText === "Caveat: The messages below...") return undefined;

// Filter system commands
const ignoreCommands = ["/clear", "/login", "/logout", "/exit", "/mcp", "/memory"];
if (command.kind === "command" && ignoreCommands.includes(command.commandName)) {
  return undefined;
}
```

## Comparison

| Aspect | claude-anywhere | claude-code-viewer |
|--------|-----------------|-------------------|
| **Agent files** | Excluded | Excluded |
| **Empty files** | Excluded | Shown (no title) |
| **Metadata-only sessions** | Excluded | Shown (no title) |
| **Message count** | User/assistant only | All lines |
| **"Warmup" title** | Shows "Warmup" | Shows no title |
| **Sidechain title** | Not filtered | Filtered out |
| **System commands** | Not filtered | Filtered out |

## Rationale for Our Approach

We chose to **exclude empty/metadata-only sessions entirely** because:
1. They provide no value to users
2. They clutter the session list
3. The session count becomes more accurate

Trade-offs:
- More aggressive than claude-code-viewer
- Might hide sessions that have unusual structures
- Requires reading file content (slightly slower)

## What Sessions Get Filtered

Based on actual data from `~/.claude/projects/-home-kgraehl-gigabyte-pwm/`:

| Category | Count | Example |
|----------|-------|---------|
| Total .jsonl files | 75 | |
| Agent files (filtered) | 50 | `agent-a08c4f0.jsonl` - Contains "Warmup" |
| Empty files (filtered) | 15 | 0 bytes |
| Metadata-only (filtered) | 5 | Only `file-history-snapshot` entries |
| **Valid sessions** | **5** | Real user conversations |

## Future Considerations

1. **Title filtering:** Consider filtering "Warmup" from titles like claude-code-viewer does
2. **Sidechain awareness:** Check `isSidechain` field when extracting titles
3. **System commands:** May want to filter `/clear`, `/login` etc. from titles
4. **Agent session linking:** claude-code-viewer links agent sessions to their parent for cost tracking

## Related Files

- `packages/server/src/projects/scanner.ts` - `countSessions()` method
- `packages/server/src/sessions/reader.ts` - `listSessions()`, `getSessionSummary()`
- `packages/server/test/api/projects.test.ts` - Tests for project listing
- `packages/server/test/api/sessions.test.ts` - Tests for session listing
