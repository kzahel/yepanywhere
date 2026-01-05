# Claude Message Format Analysis — Enhanced

This document extends the original `claude-message-format.md` with additional findings from deeper analysis of 806 JSONL files containing 16,878 messages.

## Critical Finding: `toolUseResult` Field

**The original analysis missed this key structure.** Tool results have a `toolUseResult` field at the **message level** (not just inside `message.content`). This field contains structured, typed data that's much easier to render than parsing the stringified `tool_result.content`.

```typescript
interface UserMessageWithToolResult {
  type: 'user';
  message: {
    role: 'user';
    content: ToolResultBlock[];  // Stringified content
  };
  toolUseResult: StructuredToolResult;  // <-- TYPED STRUCTURED DATA
}
```

## Complete Tool Result Schemas

### Bash Tool

```typescript
interface BashResult {
  stdout: string;
  stderr: string;
  interrupted: boolean;
  isImage: boolean;
  // For background tasks:
  backgroundTaskId?: string;  // e.g., "bfd84a8"
  // Sometimes present on exit:
  returnCodeInterpretation?: string;
}
```

**Rendering notes:**
- Show `stdout` in a code block
- Show `stderr` in error styling (red/warning)
- Display badge if `interrupted === true`
- `backgroundTaskId` indicates async execution

### Read Tool

```typescript
interface ReadResult {
  type: 'text' | 'image';
  file: TextFile | ImageFile;
}

interface TextFile {
  filePath: string;
  content: string;
  numLines: number;
  startLine: number;
  totalLines: number;
}

interface ImageFile {
  base64: string;          // Base64-encoded image data
  type: string;            // MIME type, e.g., "image/png"
  originalSize: number;    // File size in bytes
  dimensions: {
    originalWidth: number;
    originalHeight: number;
    displayWidth: number;
    displayHeight: number;
  };
}
```

**Rendering notes:**
- For text: syntax-highlighted code block with line numbers
- For images: render as `<img src="data:${type};base64,${base64}" />`
- Show file path as header
- Display line range if partial read (offset/limit used)

### Edit Tool

```typescript
interface EditResult {
  filePath: string;
  oldString: string;
  newString: string;
  originalFile: string;    // Full file content before edit
  replaceAll: boolean;
  userModified: boolean;   // True if user modified the edit
  structuredPatch: PatchHunk[];
}

interface PatchHunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: string[];  // Prefixed with ' ', '-', or '+'
}
```

**Rendering notes:**
- Use `structuredPatch` for diff visualization
- Lines starting with `-` are deletions (red)
- Lines starting with `+` are additions (green)
- Lines starting with ` ` are context
- Show `userModified` badge if true

### Write Tool

```typescript
interface WriteResult {
  type: 'text';
  file: {
    filePath: string;
    content: string;
    numLines: number;
    startLine: number;
    totalLines: number;
  };
}
```

**Rendering notes:**
- Similar to Read, show the written content
- Consider showing file path prominently

### TodoWrite Tool

```typescript
interface TodoWriteResult {
  oldTodos: Todo[];
  newTodos: Todo[];
}

interface Todo {
  content: string;       // Task description
  status: 'pending' | 'in_progress' | 'completed';
  activeForm: string;    // Present-tense description for display
}
```

**Rendering notes:**
- Show todo list with status icons (checkbox, spinner, checkmark)
- Highlight changes between old and new
- Use `activeForm` when showing "Currently working on..."

### Glob Tool

```typescript
interface GlobResult {
  filenames: string[];
  durationMs: number;
  numFiles: number;
  truncated: boolean;
}
```

**Rendering notes:**
- Show file list (collapsible if many)
- Display count and truncation warning if applicable
- Can show as tree structure by parsing paths

### Grep Tool

```typescript
interface GrepResult {
  mode: 'files_with_matches' | 'content' | 'count';
  filenames: string[];
  numFiles: number;
  // When mode is 'content':
  content?: string;
  numLines?: number;
  appliedLimit?: number;
}
```

**Rendering notes:**
- For `files_with_matches`: show file list
- For `content`: show search results with highlighting
- For `count`: show file -> count mapping

### Task Tool (Agent)

```typescript
interface TaskResult {
  status: 'completed' | 'failed' | 'timeout';
  prompt: string;
  agentId: string;
  content: ContentBlock[];  // Agent's response content
  totalDurationMs: number;
  totalTokens: number;
  totalToolUseCount: number;
  usage: {
    input_tokens: number;
    output_tokens: number;
    cache_creation_input_tokens: number;
    cache_read_input_tokens: number;
    // ... other usage fields
  };
}
```

**Rendering notes:**
- Render as nested conversation or collapsible section
- Show agent summary stats (tokens, duration, tools)
- Content blocks follow same rendering as main messages

### TaskOutput Tool

```typescript
interface TaskOutputResult {
  retrieval_status: 'completed' | 'timeout' | 'running';
  task: {
    task_id: string;
    task_type: 'local_bash' | 'agent';
    status: 'running' | 'completed' | 'failed';
    description: string;
    output: string;
    exitCode: number | null;
  };
}
```

**Rendering notes:**
- Show task status with appropriate indicator
- Render output similar to Bash result

### BashOutput Tool

```typescript
interface BashOutputResult {
  shellId: string;
  command: string;
  status: 'running' | 'completed' | 'failed';
  exitCode: number | null;
  stdout: string;
  stderr: string;
  stdoutLines: number;
  stderrLines: number;
  timestamp: string;  // ISO 8601
}
```

**Rendering notes:**
- Show running indicator if `status === 'running'`
- Include timestamp for long-running commands

### KillShell Tool

```typescript
interface KillShellResult {
  message: string;
  shell_id: string;
}
```

### AskUserQuestion Tool

```typescript
interface AskUserQuestionInput {
  questions: Question[];
}

interface Question {
  question: string;
  header: string;        // Short label (max 12 chars)
  options: Option[];
  multiSelect: boolean;
}

interface Option {
  label: string;
  description: string;
}

interface AskUserQuestionResult {
  questions: Question[];
  answers: Record<string, string>;  // question -> selected label
}
```

**Rendering notes:**
- Render as radio buttons or checkboxes
- Show selected answers highlighted
- Match question to answer by question text

### WebSearch Tool

```typescript
interface WebSearchResult {
  query: string;
  results: SearchResultBlock[];
  durationSeconds: number;
}

interface SearchResultBlock {
  tool_use_id: string;
  content: SearchResult[];
}

interface SearchResult {
  title: string;
  url: string;
}
```

**Rendering notes:**
- Show query prominently
- Render results as clickable links
- May include AI summary after results

### WebFetch Tool

```typescript
interface WebFetchResult {
  bytes: number;
  code: number;        // HTTP status code
  codeText: string;    // e.g., "OK"
  result: string;      // Processed/summarized content
  durationMs: number;
  url: string;
}
```

**Rendering notes:**
- Show URL as header
- Display HTTP status
- Render result as markdown

### ExitPlanMode Tool

```typescript
interface ExitPlanModeResult {
  plan: string;        // Full plan content
  isAgent: boolean;
  filePath: string;    // Path to plan file
}
```

**Rendering notes:**
- Render plan as markdown
- Show file path for reference

## Error Handling

Tool results can indicate errors in two ways:

1. **In `tool_result.content`**: Check for `is_error: true`
```typescript
interface ToolResultBlock {
  type: 'tool_result';
  tool_use_id: string;
  content: string;
  is_error?: boolean;  // Present and true for errors
}
```

2. **In result content**: Error messages often start with "Exit code 1" or similar

**Rendering notes:**
- Check `is_error` flag first
- Style error results differently (red border, error icon)
- Parse common error patterns for better display

## Streaming Behavior Update

Beyond what the original analysis noted, there are additional streaming patterns:

1. **Multiple tool_use in single response**: A single assistant turn can have multiple `tool_use` blocks streamed across multiple messages
2. **Tool results appear in next user message**: The `tool_result` blocks and `toolUseResult` appear in the following user message
3. **Correlation**: Match `tool_result.tool_use_id` to `tool_use.id` to pair calls with results

## Tool Input Schemas

### Common Optional Fields

| Tool | Required | Optional |
|------|----------|----------|
| Bash | `command` | `description`, `timeout`, `run_in_background` |
| Read | `file_path` | `offset`, `limit` |
| Edit | `file_path`, `old_string`, `new_string` | `replace_all` |
| Write | `file_path`, `content` | - |
| Glob | `pattern` | `path` |
| Grep | `pattern` | `path`, `glob`, `type`, `output_mode`, `-A`, `-B`, `-C`, `-i`, `-n`, `head_limit` |
| Task | `description`, `prompt`, `subagent_type` | `model`, `run_in_background` |
| WebSearch | `query` | `allowed_domains`, `blocked_domains` |
| WebFetch | `url`, `prompt` | - |
| TodoWrite | `todos` | - |
| AskUserQuestion | `questions` | - |

## Rendering Priority Recommendations

Based on usage frequency:

### Tier 1 (Core - implement first)
1. `text` - Markdown rendering
2. `thinking` - Collapsible with signature hidden
3. Bash - Command + output with syntax highlighting
4. Read - File content with line numbers and image support
5. Edit - Diff view using structuredPatch

### Tier 2 (Essential tools)
6. Write - Similar to Read
7. TodoWrite - Interactive todo list
8. Grep/Glob - File listings

### Tier 3 (Less common)
9. Task - Nested agent responses
10. WebSearch/WebFetch - Web content
11. AskUserQuestion - Q&A interface
12. ExitPlanMode - Plan display

### Tier 4 (Background/async)
13. BashOutput/TaskOutput - Async results
14. KillShell - Simple message

## Summary of Key Differences from Original Analysis

| Aspect | Original Finding | Enhanced Finding |
|--------|------------------|------------------|
| Tool results | Documented `tool_result.content` only | Added `toolUseResult` structured field |
| Read images | Not mentioned | Full base64 + dimensions support |
| Edit diffs | Not detailed | `structuredPatch` with line prefixes |
| Background tasks | Briefly mentioned | Full BashOutput/TaskOutput schemas |
| TodoWrite | Input only | Both `oldTodos` and `newTodos` |
| WebSearch | Not detailed | Full result structure with duration |
| Error handling | Not covered | `is_error` flag documented |
