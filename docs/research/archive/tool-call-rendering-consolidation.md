# Tool Call Rendering Consolidation

## Problem Statement

Currently, tool calls are rendered as two separate visual blocks:
- `> Read` - the tool use (input)
- `< Read` - the tool result (output)

This takes up significant vertical space and doesn't match how users think about tool calls. A file read is conceptually one action: "read this file and show me the contents."

**Desired UX:** A single compact line like `Read index.css (lines 96-120)` where the filename is clickable to reveal the contents in a popup or expandable section.

## Current Architecture

### Message Structure (Claude API)

Tool calls span two separate messages in the Claude API:

1. **Assistant message** with `tool_use` content block:
   ```json
   {
     "role": "assistant",
     "content": [{
       "type": "tool_use",
       "id": "toolu_abc123",
       "name": "Read",
       "input": { "file_path": "/src/index.css", "offset": 96, "limit": 25 }
     }]
   }
   ```

2. **User message** with `tool_result` content block:
   ```json
   {
     "role": "user",
     "content": [{
       "type": "tool_result",
       "tool_use_id": "toolu_abc123",
       "content": "... file contents ..."
     }]
   }
   ```

### Current Rendering Pipeline

```
MessageList
  └── messages.map(msg => <MessageItem>)
        └── msg.content.map(block => <ContentBlockRenderer>)
              └── registry.render(block)
                    ├── toolUseRenderer    → "> Read" block
                    └── toolResultRenderer → "< Read" block
```

Key files:
- `packages/client/src/components/MessageList.tsx` - iterates messages/blocks
- `packages/client/src/components/renderers/blocks/ToolUseRenderer.tsx` - renders `>`
- `packages/client/src/components/renderers/blocks/ToolResultRenderer.tsx` - renders `<`
- `packages/client/src/components/renderers/tools/ReadRenderer.tsx` - Read-specific UI

### Correlation Mechanism

`MessageList.tsx` builds a lookup map of tool_use blocks by ID:
```typescript
function buildToolUseLookup(messages: Message[]) {
  const lookup = new Map<string, { name: string; input: unknown }>();
  for (const msg of messages) {
    if (Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if (block.type === "tool_use" && block.id && block.name) {
          lookup.set(block.id, { name: block.name, input: block.input });
        }
      }
    }
  }
  return lookup;
}
```

This is passed via context, and `ToolResultRenderer` uses it to look up the tool name.

## Proposed Solutions

### Option 1: Preprocessing into Compound Render Items

Transform the message stream into a flat list of render items before rendering, pairing tool_use with tool_result.

```typescript
type RenderItem =
  | { type: 'text'; block: TextBlock; messageId: string }
  | { type: 'thinking'; block: ThinkingBlock; messageId: string }
  | { type: 'tool_call'; toolUse: ToolUseBlock; toolResult?: ToolResultBlock; messageId: string }
  | { type: 'orphan_result'; block: ToolResultBlock; messageId: string };

function preprocessMessages(messages: Message[]): RenderItem[] {
  const items: RenderItem[] = [];
  const pendingToolUses = new Map<string, { block: ToolUseBlock; index: number }>();

  for (const msg of messages) {
    for (const block of msg.content) {
      if (block.type === 'tool_use') {
        // Add as pending, will be completed when result arrives
        const item: RenderItem = { type: 'tool_call', toolUse: block, messageId: msg.id };
        pendingToolUses.set(block.id, { block, index: items.length });
        items.push(item);
      } else if (block.type === 'tool_result') {
        const pending = pendingToolUses.get(block.tool_use_id);
        if (pending) {
          // Attach result to existing tool_call item
          (items[pending.index] as ToolCallItem).toolResult = block;
          pendingToolUses.delete(block.tool_use_id);
        } else {
          // Orphan result (shouldn't happen normally)
          items.push({ type: 'orphan_result', block, messageId: msg.id });
        }
      } else {
        items.push({ type: block.type, block, messageId: msg.id });
      }
    }
  }
  return items;
}
```

**Pros:**
- Clean separation of concerns
- Single source of truth for what gets rendered
- Easy to add other compound patterns later
- Render items are self-contained

**Cons:**
- Larger refactor of MessageList
- Need to handle streaming carefully (tool_use appears before result)
- Breaks the current message-centric rendering model

### Option 2: Render-Time Skip Pattern

Keep the current structure but add skip logic:
- `ToolUseRenderer` looks up if result exists, renders combined view
- `ToolResultRenderer` checks if already rendered, returns `null`

```typescript
// In ToolUseRenderer
function ToolUseRendererComponent({ block, context }) {
  const result = context.getToolResult?.(block.id);

  if (result) {
    // Render combined compact view
    return <ToolCallCompact toolUse={block} toolResult={result} />;
  }

  // Still waiting for result (streaming)
  return <ToolUsePending toolUse={block} />;
}

// In ToolResultRenderer
function ToolResultRendererComponent({ block, context }) {
  const toolUse = context.getToolUse?.(block.tool_use_id);

  // Skip if already rendered by ToolUseRenderer
  if (toolUse && context.getToolResult?.(block.tool_use_id)) {
    return null;
  }

  // Orphan result or special case
  return <ToolResultOrphan block={block} />;
}
```

**Pros:**
- Minimal changes to existing architecture
- Works incrementally
- Easy to implement per-tool

**Cons:**
- Implicit coupling between renderers
- "Magic" skip behavior is hard to follow
- Need bidirectional lookups (getToolUse AND getToolResult)
- Feels hacky

### Option 3: Virtual Block Type at Parse Time

Transform messages when loading from server, creating a synthetic `tool_call` block type.

```typescript
// In session reader or client-side transform
function transformToolBlocks(messages: Message[]): Message[] {
  // Create tool_call blocks that combine use + result
  // Remove original tool_use and tool_result blocks
}
```

**Pros:**
- Cleanest model - renderer sees unified blocks
- Could be done server-side for consistency
- Single block type to render

**Cons:**
- Modifies the canonical message format
- Harder to debug (transformed vs original)
- Need to handle streaming (result arrives later)
- Upstream changes required

### Option 4: CSS/Layout-Based Collapse

Keep both blocks but use CSS grid/flexbox to visually combine them when adjacent.

```css
.tool-use + .tool-result[data-tool-id="same"] {
  margin-top: -1em;
  /* Overlap or inline display */
}
```

**Pros:**
- No JS changes
- Progressive enhancement
- Easy to experiment with

**Cons:**
- Limited control over combined appearance
- Can't truly merge into single interactive component
- Fragile if other blocks appear between

## Recommended Approach: Option 1 (Preprocessing)

Option 1 provides the cleanest architecture for long-term maintainability:

1. **Clear data model** - RenderItems explicitly represent what will be rendered
2. **Streaming support** - Tool calls can show "pending" state until result arrives
3. **Extensible** - Easy to add other compound patterns (e.g., multiple sequential Reads of same file)
4. **Testable** - Preprocessing is a pure function, easy to unit test

### Streaming Considerations

During streaming, a tool_use block appears before its result. The preprocessing should handle this:

```typescript
type ToolCallItem = {
  type: 'tool_call';
  toolUse: ToolUseBlock;
  toolResult?: ToolResultBlock;  // undefined while pending
  status: 'pending' | 'complete' | 'error';
};
```

The renderer shows appropriate UI for each state:
- **Pending**: `Read index.css ...` with spinner
- **Complete**: `Read index.css (25 lines)` clickable
- **Error**: `Read index.css` with error badge

## Compact Tool Call UI Design

### Default Collapsed State

```
┌─────────────────────────────────────────────┐
│ Read  index.css  (lines 96-120, 25 lines)   │
└─────────────────────────────────────────────┘
       ↑          ↑
    clickable   metadata
    to expand
```

- Tool icon/name on left
- Primary identifier (filename) is clickable
- Metadata (line range, line count) in muted style
- Entire row could be clickable, or just the filename

### Expanded State Options

**A. Inline expansion:**
```
┌─────────────────────────────────────────────┐
│ Read  index.css  (lines 96-120)        [−]  │
├─────────────────────────────────────────────┤
│  96 │ .tool-block {                         │
│  97 │   padding: 8px;                       │
│ ... │ ...                                   │
└─────────────────────────────────────────────┘
```

**B. Popup/modal:**
- Click filename → modal with full content
- Better for large files
- Doesn't disrupt message flow

**C. Side panel:**
- Click filename → content appears in side panel
- Can keep multiple files open
- More complex but powerful

### Per-Tool Compact Summaries

Each tool renderer would provide a `getCompactSummary()` function:

| Tool | Compact Summary Example |
|------|------------------------|
| Read | `index.css (lines 96-120)` |
| Write | `index.css (created, 45 lines)` |
| Edit | `index.css (+3/-2 lines)` |
| Bash | `npm install` → `exit 0` |
| Glob | `**/*.tsx` → `23 files` |
| Grep | `"TODO"` → `15 matches` |
| Task | `Explore: find auth code` → `completed` |

## Implementation Plan

### Phase 1: Preprocessing Infrastructure
1. Define `RenderItem` types
2. Implement `preprocessMessages()` function
3. Update `MessageList` to use render items
4. Ensure existing rendering still works (no visual change yet)

### Phase 2: Compact Tool Call Component
1. Create `ToolCallCompact` component
2. Implement collapsed view with summary
3. Add click-to-expand with inline expansion
4. Update tool renderers to provide `getCompactSummary()`

### Phase 3: Enhanced Expansion UX
1. Add popup/modal option for large content
2. Keyboard navigation (Enter to expand, Escape to collapse)
3. Persist expansion state during session

### Phase 4: Polish
1. Animations for expand/collapse
2. Loading states during streaming
3. Error state styling
4. Accessibility audit

## Open Questions

1. **Expansion behavior**: Should clicking expand inline, or open a popup? Or make it configurable per-tool?

2. **Multiple tool calls**: If Claude makes 5 Read calls in a row, should they be grouped? `Read: 5 files` with expandable list?

3. **Error display**: Errors need to be visible. Should failed tool calls auto-expand? Show inline error badge?

4. **Streaming UX**: While waiting for result, show spinner? Pulsing animation? "Running..." text?

5. **Keyboard navigation**: How to navigate between collapsed tool calls? Tab through? Vim-style j/k?

6. **State persistence**: Remember which tool calls user expanded? Per-session? Per-conversation?

7. **Copy behavior**: When user copies text, should collapsed tool calls be included? In what format?

8. **Search**: If user searches conversation, should it search inside collapsed tool results?

## Related Work

- VSCode's "collapsed regions" for long output
- GitHub's PR review collapsed file diffs
- Jupyter notebook cell collapse
- Chrome DevTools network request rows → detail panel

## Appendix: Current File Locations

```
packages/client/src/
├── components/
│   ├── MessageList.tsx              # Main message iteration
│   └── renderers/
│       ├── index.ts                 # Registry setup
│       ├── registry.ts              # Renderer registry
│       ├── types.ts                 # ContentBlock, RenderContext
│       ├── ContentBlockRenderer.tsx # Dispatcher
│       ├── blocks/
│       │   ├── ToolUseRenderer.tsx  # "> Tool" rendering
│       │   └── ToolResultRenderer.tsx # "< Tool" rendering
│       └── tools/
│           ├── index.ts             # Tool registry
│           ├── types.ts             # ToolRenderer interface
│           ├── ReadRenderer.tsx     # Read-specific UI
│           ├── BashRenderer.tsx     # Bash-specific UI
│           └── ...
└── types.ts                         # Message, ContentBlock types
```
