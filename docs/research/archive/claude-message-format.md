# Claude Message Format Analysis

Research document analyzing the JSONL message format used by Claude Code for session transcripts.

**Data source:** 800 JSONL files, 16,792 messages from `~/.claude/projects/`

## Overall Architecture

Each JSONL file represents a single Claude Code session. Each line is a self-contained JSON object representing either a message in the conversation or metadata about the session.

### Message Types by Frequency

| Type | Count | Description |
|------|-------|-------------|
| `assistant` | 10,432 | Claude's responses (including streaming chunks) |
| `user` | 5,413 | User messages and tool results |
| `file-history-snapshot` | 495 | File backup/versioning metadata |
| `queue-operation` | 446 | Session queue management events |
| `system` | 6 | System events (e.g., context compaction) |

## Content Block Types

Within assistant messages, `message.content` is an array of content blocks:

| Type | Count | Description |
|------|-------|-------------|
| `tool_use` | 4,666 | Tool invocations (Read, Bash, Edit, etc.) |
| `tool_result` | 4,660 | Results returned from tools |
| `text` | 3,154 | Plain text responses |
| `thinking` | 3,088 | Extended thinking blocks (signed) |

## Message Structure Details

### Common Fields (All Message Types)

```typescript
interface BaseMessage {
  type: 'user' | 'assistant' | 'system' | 'queue-operation' | 'file-history-snapshot';
  uuid: string;           // Unique message ID
  timestamp: string;      // ISO 8601 timestamp
  sessionId: string;      // Session this belongs to
}
```

### User Message

```typescript
interface UserMessage extends BaseMessage {
  type: 'user';
  parentUuid: string | null;  // Previous message in chain
  isSidechain: boolean;       // False for main conversation
  userType: 'external';       // Always 'external' in observed data
  cwd: string;                // Working directory
  version: string;            // Claude Code version (e.g., "2.0.76")
  gitBranch: string;          // Current git branch
  slug: string;               // Session slug (e.g., "foamy-conjuring-crane")
  message: {
    role: 'user';
    content: string | ContentBlock[];  // Can be simple string or array
  };
}
```

### Assistant Message

```typescript
interface AssistantMessage extends BaseMessage {
  type: 'assistant';
  parentUuid: string | null;
  isSidechain: boolean;
  userType: 'external';
  cwd: string;
  version: string;
  gitBranch: string;
  slug?: string;
  requestId: string;          // Anthropic API request ID (e.g., "req_011CWXEFpwx7MLKtD7u1Czgn")
  message: {
    model: string;            // e.g., "claude-opus-4-5-20251101", "claude-haiku-4-5-20251001"
    id: string;               // Message ID (e.g., "msg_01SQxiSj56kZvabczbt1CGYu")
    type: 'message';
    role: 'assistant';
    content: ContentBlock[];  // Array of content blocks
    stop_reason: 'tool_use' | 'stop_sequence' | 'end_turn' | null;
    stop_sequence: string | null;
    usage: {
      input_tokens: number;
      output_tokens: number;
      cache_creation_input_tokens?: number;
      cache_read_input_tokens?: number;
      cache_creation?: {
        ephemeral_5m_input_tokens: number;
        ephemeral_1h_input_tokens: number;
      };
      service_tier?: 'standard';
    };
  };
}
```

**Key observation:** Assistant messages are streamed incrementally. Multiple messages with the same `requestId` and `message.id` represent streaming chunks. Each chunk contains `content` with the latest content block(s).

### Content Blocks

```typescript
// Text block
interface TextBlock {
  type: 'text';
  text: string;
}

// Thinking block (extended thinking)
interface ThinkingBlock {
  type: 'thinking';
  thinking: string;           // The thinking content
  signature: string;          // Cryptographic signature (base64)
}

// Tool use block
interface ToolUseBlock {
  type: 'tool_use';
  id: string;                 // Tool use ID (e.g., "toolu_01LfqYijoGQSDmDbS5ZWPn46")
  name: string;               // Tool name
  input: Record<string, any>; // Tool-specific input
}

// Tool result block (appears in user messages)
interface ToolResultBlock {
  type: 'tool_result';
  tool_use_id: string;        // References the tool_use.id
  content: string | object;   // Result content (often stringified JSON)
}
```

### System Message

```typescript
interface SystemMessage extends BaseMessage {
  type: 'system';
  subtype: 'compact_boundary';  // Only observed subtype
  content: string;              // e.g., "Conversation compacted"
  level: 'info';
  isMeta: boolean;
  logicalParentUuid: string;
  compactMetadata: {
    trigger: 'auto';
    preTokens: number;
  };
}
```

### Queue Operation

```typescript
interface QueueOperation {
  type: 'queue-operation';
  operation: 'enqueue' | 'dequeue' | 'remove';
  timestamp: string;
  sessionId: string;
  content?: string | ContentBlock[];  // Optional, present on enqueue
}
```

### File History Snapshot

```typescript
interface FileHistorySnapshot {
  type: 'file-history-snapshot';
  messageId: string;
  isSnapshotUpdate: boolean;
  snapshot: {
    messageId: string;
    timestamp: string;
    trackedFileBackups: {
      [filePath: string]: {
        backupFileName: string | null;  // e.g., "1485d2949381e3df@v1"
        version: number;
        backupTime: string;
      };
    };
  };
}
```

## Tool Catalog

Tools observed in the data, sorted by frequency:

| Tool | Uses | Key Input Fields |
|------|------|------------------|
| Read | 1,386 | `file_path`, `offset?`, `limit?` |
| Bash | 1,287 | `command`, `description?`, `timeout?`, `run_in_background?` |
| Edit | 735 | `file_path`, `old_string`, `new_string`, `replace_all?` |
| TodoWrite | 342 | `todos` (array of todo objects) |
| Grep | 249 | `pattern`, `path?`, `glob?`, `output_mode?`, context flags |
| Write | 245 | `file_path`, `content` |
| Glob | 230 | `pattern`, `path?` |
| Task | 60 | `description`, `prompt`, `subagent_type`, `model?` |
| ExitPlanMode | 57 | `plan?` |
| AskUserQuestion | 23 | `questions` (array) |
| WebSearch | 16 | `query` |
| WebFetch | 16 | `url`, `prompt` |
| BashOutput | 10 | `bash_id`, `block?`, `wait_up_to?` |
| KillShell | 5 | `shell_id` |
| TaskOutput | 5 | `task_id`, `block?`, `timeout?` |

## Streaming Behavior

**Critical for rendering:** Claude Code uses streaming, which means:

1. A single logical "turn" from Claude produces **multiple assistant messages**
2. These share the same `message.id` and `requestId`
3. Each message contains the latest content block(s)
4. `stop_reason` is `null` during streaming, set to a value on completion

Example streaming sequence:
```
message 1: { content: [{ type: 'thinking', thinking: '...' }], stop_reason: null }
message 2: { content: [{ type: 'text', text: 'I will...' }], stop_reason: null }
message 3: { content: [{ type: 'tool_use', name: 'Read', ... }], stop_reason: 'tool_use' }
```

## Rendering Considerations for React

### 1. Message Deduplication

Since streaming produces multiple messages with the same `message.id`, the renderer should:
- Group messages by `message.id` for assistant messages
- Take the latest content for each block type, or concatenate text blocks
- Only show completed messages (where `stop_reason` is set)

### 2. Message Threading

The `parentUuid` field creates a linked list structure:
- First user message has `parentUuid: null`
- Each subsequent message references its parent
- Can be used to build a tree structure for sidechains (though `isSidechain: false` in all observed data)

### 3. Content Block Rendering

Each content block type needs a different renderer:

| Block Type | Rendering Approach |
|------------|-------------------|
| `text` | Markdown rendering (GitHub flavored) |
| `thinking` | Collapsible section, monospace/dimmed style |
| `tool_use` | Tool name + input display (syntax highlighted JSON) |
| `tool_result` | Output display, often with syntax highlighting |

### 4. Tool Use/Result Correlation

Tool results appear in **user messages** following the assistant message:
- Match `tool_result.tool_use_id` to `tool_use.id`
- Display them together in the UI for context
- Consider inline expansion (collapsed by default)

### 5. Filtering Non-Renderable Messages

Skip rendering for:
- `queue-operation` messages (internal)
- `file-history-snapshot` messages (internal)
- Streaming intermediate messages (same `message.id`, `stop_reason: null`)

### 6. Model Information

The `message.model` field indicates which model responded:
- `claude-opus-4-5-20251101` - Full Opus
- `claude-haiku-4-5-20251001` - Fast Haiku
- `<synthetic>` - Generated internally (rare)

Can display as a badge/indicator.

### 7. Token Usage

The `message.usage` field provides cost/usage data:
- `input_tokens`, `output_tokens`
- Cache hit information (`cache_read_input_tokens`)
- Could display in a session summary or per-message

## Proposed React Component Structure

```tsx
// Top-level
<SessionRenderer messages={messages} />

// Filters and deduplicates
<MessageList messages={processedMessages} />

// Per-message
<Message message={msg}>
  <MessageHeader model={msg.message.model} timestamp={msg.timestamp} />
  <ContentBlocks blocks={msg.message.content} />
</Message>

// Content blocks
<TextBlock text={block.text} />
<ThinkingBlock thinking={block.thinking} collapsed={true} />
<ToolUseBlock name={block.name} input={block.input} result={matchedResult} />
```

## Next Steps

1. Build message processor to deduplicate streaming messages
2. Create content block renderers
3. Implement tool use/result correlation
4. Add markdown rendering (with code syntax highlighting)
5. Test with real session data
