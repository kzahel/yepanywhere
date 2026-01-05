# Streaming vs Reload Rendering Consistency

## Summary

Investigation into ensuring consistent rendering between streaming (SSE) and reload (REST) paths for tool renderers and content blocks.

## Completed: EditRenderer

Fixed the Edit tool to render consistently:

1. **Server** (`edit-augments.ts`): Computes `diffHtml` with shiki highlighting and line-type classes (`line-deleted`, `line-inserted`, `line-hunk`, `line-context`)
2. **Client** (`EditRenderer.tsx`): Uses `diffHtml` when available, with CSS for background colors
3. **Context fix** (`EditAugmentContext.tsx`): Fixed `useEditAugment` to subscribe to version changes so components re-render when augments load from REST

Tests added in `test/augments/edit-augments.test.ts`:
- Verifies line type classes are present
- Verifies deterministic output (same input → same output)

## Completed: TextBlock

Fixed markdown rendering consistency using Option 2 (re-render on load):

1. **Server** (`markdown-augments.ts`):
   - `renderMarkdownToHtml()` - Renders markdown using same BlockDetector + AugmentGenerator as streaming
   - `computeMarkdownAugments()` - Extracts all text blocks from messages, renders to HTML
   - Returns `Record<string, MarkdownAugment>` keyed by `${messageId}-${blockIndex}`

2. **Server** (`sessions.ts`):
   - GET `/sessions/:id` now returns `markdownAugments` alongside `editAugments`

3. **Client** (`MarkdownAugmentContext.tsx`):
   - New context to store pre-rendered HTML
   - `useMarkdownAugment(blockId)` hook for components

4. **Client** (`TextBlock.tsx`):
   - Now accepts `id` prop (from RenderItemComponent)
   - Uses `useMarkdownAugment(id)` to get pre-rendered HTML
   - Rendering priority: streaming augments → markdown augments → plain text fallback
   - Removed react-markdown dependency for rendering

5. **Tests** (`test/augments/markdown-augments.test.ts`):
   - Verifies `renderMarkdownToHtml` produces expected output
   - Verifies streaming path === reload path for various markdown inputs

## Completed: Server-Side File Path Detection

Moved file path detection from client-side react-markdown components to server-side rendering:

1. **Shared** (`packages/shared/src/filePathDetection.ts`):
   - Moved file path detection logic from client to shared package
   - Added `transformFilePathsToHtml()` function for server-side link generation
   - Generates `<a class="file-link" data-file-path="..." data-line="...">` tags

2. **Server** (`augment-generator.ts`):
   - Created `createFilePathExtension()` marked extension
   - Overrides `text` and `codespan` renderers to detect and linkify file paths
   - Updated `renderInlineFormatting()` for pending text during streaming

3. **Client** (`TextBlock.tsx`):
   - Added click handler (`handleContentClick`) for server-rendered `.file-link` elements
   - Uses event delegation to intercept clicks and open FileViewer modal
   - Middle-click opens file in new tab
   - Removed react-markdown, remark-gfm imports and usage

4. **Client** (`lib/filePathDetection.ts`):
   - Now re-exports from shared package for backward compatibility

5. **CSS** (`renderers.css`):
   - Added `.file-link` styles matching existing `.file-path-link` styles

## Remaining: Remove Unused Dependencies

The following dependencies can now be removed from `packages/client/package.json`:
- `react-markdown` - No longer used (server renders markdown)
- `remark-gfm` - Only used with react-markdown
- `react-syntax-highlighter` - Check if used elsewhere before removing
- `@types/react-syntax-highlighter` - Dev dependency for above

## Lower Priority: TaskRenderer

Uses `agentContent` from both SSE (streaming) and `loadAgentContent` (reload). Both paths feed into the same `TaskNestedContent` renderer, so should be consistent. Worth a test to verify.

## Test Strategy

For each renderer with dual paths:
1. Unit test that same input produces identical output
2. Integration test comparing streaming capture vs reload render
