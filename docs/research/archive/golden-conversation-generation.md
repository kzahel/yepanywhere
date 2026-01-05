# Golden Conversation Generation Guide

## Purpose

Generate sample conversations from each provider that exercise all tool types. These become test fixtures for:
- Mock provider development
- Event normalization testing
- UI rendering verification
- Schema validation

## Tool Types by Provider

### Claude SDK

| Tool | Description | Fixture Priority |
|------|-------------|------------------|
| `Bash` | Shell command execution | High |
| `Read` | Read file contents | High |
| `Write` | Create/overwrite file | High |
| `Edit` | Partial file edit (old_string → new_string) | High |
| `Glob` | Find files by pattern | Medium |
| `Grep` | Search file contents | Medium |
| `WebFetch` | Fetch URL content | Medium |
| `WebSearch` | Web search | Medium |
| `Task` | Spawn subagent | High |
| `TodoWrite` | Task list management | Low |
| `LSP` | Language server operations | Low |
| `NotebookEdit` | Jupyter notebook editing | Low |

**Special message types:**
- Thinking/reasoning blocks
- Tool approval requests
- Multi-turn conversations
- Error/failure states
- Token usage stats

### Codex CLI

| Tool | Description | Fixture Priority |
|------|-------------|------------------|
| Shell execution | Run commands | High |
| File read | Read file contents | High |
| File write | Create/modify files | High |
| File edit | Partial edits | High |
| Web search | Search the web | Medium |
| MCP tools | External tool servers | Low |

**Special message types:**
- `session_meta` - Session initialization
- `response_item.reasoning` - Encrypted thinking
- `event_msg.agent_reasoning` - Reasoning summary
- `ghost_snapshot` - Git state tracking
- `turn_context` - Per-turn metadata
- `token_count` - Usage with rate limits

### Gemini CLI

| Tool | Description | Fixture Priority |
|------|-------------|------------------|
| `write_file` | Create/modify files | High |
| `replace` | In-place file edits | High |
| Shell execution | Run commands | High |
| Web search | Search queries | Medium |
| MCP tools | External integrations | Low |

**Special message types:**
- `thoughts` array - Reasoning with subject/description
- `tokens` breakdown - Per-message token counts
- `info` messages - Status/auth messages

---

## Generation Prompts

Run each prompt with the respective CLI and save the output as fixtures.

### Prompt 1: Simple Response (All Providers)

```
Say "Hello, I am ready to help!" and nothing else.
```

**Expected:** Single assistant message, no tool calls.
**Fixture:** `simple-response.jsonl`

### Prompt 2: File Read + Analysis

```
Read the file package.json and tell me what the project name is.
```

**Expected:** File read tool call → assistant response with analysis.
**Fixture:** `file-read.jsonl`

### Prompt 3: File Write

```
Create a new file called test-output.txt with the content "Hello from [provider name]".
```

**Expected:** File write tool call → success confirmation.
**Fixture:** `file-write.jsonl`

### Prompt 4: File Edit

```
In the file test-output.txt, replace "Hello" with "Greetings".
```

**Expected:** File edit tool call → success confirmation.
**Fixture:** `file-edit.jsonl`

### Prompt 5: Shell Command

```
Run the command "echo hello world" and show me the output.
```

**Expected:** Shell/bash tool call → output → assistant summary.
**Fixture:** `shell-command.jsonl`

### Prompt 6: Multi-Step Task

```
Create a new file called counter.txt with "0", then read it, increment the number, and write "1" back to it.
```

**Expected:** Write → Read → Write sequence with assistant narration.
**Fixture:** `multi-step.jsonl`

### Prompt 7: Search + Read

```
Find all TypeScript files in the src directory and read the first one you find.
```

**Expected:** Glob/find → Read → Analysis.
**Fixture:** `search-read.jsonl`

### Prompt 8: Error Handling

```
Try to read a file called /nonexistent/path/file.txt and handle the error gracefully.
```

**Expected:** Failed tool call → error handling → graceful response.
**Fixture:** `error-handling.jsonl`

### Prompt 9: Thinking/Reasoning (if supported)

```
Think step by step about how you would implement a simple HTTP server in Node.js, then create a file with the implementation.
```

**Expected:** Visible thinking/reasoning → File write.
**Fixture:** `reasoning.jsonl`

### Prompt 10: Tool Approval Required

```
Delete the file test-output.txt.
```

**Expected:** Tool call requiring approval → (approve) → success.
**Fixture:** `tool-approval.jsonl`

---

## Capture Process

### Claude

```bash
# Claude SDK captures to ~/.claude/projects/ automatically
# Run interactively and save the session ID
claude

# Or use our supervisor which already captures
pnpm dev
# Start session, run prompts, session is saved
```

### Codex

```bash
# Capture JSONL output directly
codex exec "your prompt here" --json > fixtures/codex/output.jsonl

# Or run interactively (saves to ~/.codex/sessions/)
codex
# Then copy the session file
```

### Gemini

```bash
# Capture JSON stream
gemini "your prompt here" -o stream-json > fixtures/gemini/output.json

# Or run interactively (saves to ~/.gemini/tmp/<hash>/chats/)
gemini
# Then copy the session file
```

---

## Fixture Organization

```
packages/server/test/fixtures/
├── claude/
│   ├── simple-response.jsonl
│   ├── file-read.jsonl
│   ├── file-write.jsonl
│   ├── file-edit.jsonl
│   ├── shell-command.jsonl
│   ├── multi-step.jsonl
│   ├── search-read.jsonl
│   ├── error-handling.jsonl
│   ├── reasoning.jsonl
│   └── tool-approval.jsonl
├── codex/
│   ├── simple-response.jsonl
│   ├── file-read.jsonl
│   ├── ... (same structure)
│   └── tool-approval.jsonl
└── gemini/
    ├── simple-response.json
    ├── file-read.json
    ├── ... (same structure)
    └── tool-approval.json
```

---

## Validation Checklist

For each fixture, verify:

- [ ] Contains session initialization message
- [ ] Has correct provider-specific format (JSONL vs JSON)
- [ ] Tool calls have input parameters
- [ ] Tool results have output/error
- [ ] Assistant messages have content
- [ ] Token usage is present (if provider includes it)
- [ ] Timestamps are present
- [ ] UUIDs/IDs are present for message linking

---

## Normalization Testing

After capturing, test that normalization works:

```typescript
import { loadFixture } from '../test-utils';
import { normalizeCodexMessage, normalizeGeminiMessage } from '../sdk/providers/normalize';

describe('Message normalization', () => {
  it('normalizes Codex file-read to SDKMessage', () => {
    const raw = loadFixture('codex/file-read.jsonl');
    const normalized = raw.map(normalizeCodexMessage);

    // Should have standard SDKMessage shape
    expect(normalized[0]).toHaveProperty('type');
    expect(normalized[0]).toHaveProperty('uuid');
  });
});
```

---

## Sensitive Data

Before committing fixtures:

1. Replace real file paths with generic ones (`/test/project/...`)
2. Remove any API keys or tokens
3. Sanitize usernames/emails if present
4. Replace real session IDs with fake ones (optional)
