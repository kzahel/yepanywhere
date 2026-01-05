# File Browser Feature Implementation Plan

## Overview
Add the ability to view and download files from the repository through the web UI. This includes:
1. **File viewer API** - Server endpoint to fetch file contents
2. **File viewer modal** - Click file paths to view in modal
3. **Standalone file page** - Open files in new tab
4. **Clickable file paths** - Detect and link file paths in messages
5. **Download support** - Download files to device

## Phase 1: Backend API

### New Route: `/packages/server/src/routes/files.ts`

**Endpoints:**
```
GET /api/projects/:projectId/files?path=<relative-path>
  - Returns file metadata and content
  - Text files: { type: "text", content: string, mimeType: string, size: number }
  - Binary files: { type: "binary", url: string, mimeType: string, size: number }

GET /api/projects/:projectId/files/raw?path=<relative-path>
  - Returns raw file content with appropriate Content-Type
  - Used as img src, download link, etc.
```

**Security:**
- Validate projectId format
- Resolve path relative to project cwd (no absolute paths)
- Prevent directory traversal (no `..` components after normalization)
- Check file exists and is a file (not directory)
- Size limit for text content (e.g., 1MB inline, larger files get URL only)

**File Type Detection:**
- Use file extension to determine MIME type
- Text types: .txt, .md, .ts, .js, .json, .html, .css, .py, .go, .rs, etc.
- Image types: .png, .jpg, .jpeg, .gif, .svg, .webp
- Binary types: everything else

### Files to Create/Modify:
- `packages/server/src/routes/files.ts` (new)
- `packages/server/src/app.ts` (mount route)
- `packages/server/test/api/files.test.ts` (new)

---

## Phase 2: Client Components

### 2.1 File Viewer Modal Component
**File:** `packages/client/src/components/FileViewer.tsx`

Features:
- Display text files with syntax highlighting
- Display images inline
- Display markdown rendered
- Show file metadata (path, size, type)
- Download button
- "Open in new tab" button
- Line number display for code files
- Copy content button

### 2.2 Standalone File Page
**File:** `packages/client/src/pages/FilePage.tsx`

Route: `/projects/:projectId/file?path=<path>`

Features:
- Full-page file viewer (reuses FileViewer component internals)
- Header with file path, download button
- Back navigation
- Shareable URL

### 2.3 File Path Link Component
**File:** `packages/client/src/components/FilePathLink.tsx`

- Renders detected file paths as clickable links
- Click → open modal
- Long press / right-click → context menu (open in new tab, copy path)
- Styled with existing `.file-link-inline` class

### Files to Create/Modify:
- `packages/client/src/components/FileViewer.tsx` (new)
- `packages/client/src/components/FilePathLink.tsx` (new)
- `packages/client/src/pages/FilePage.tsx` (new)
- `packages/client/src/main.tsx` (add route)
- `packages/client/src/styles/renderers.css` (styles)

---

## Phase 3: File Path Detection in Messages

**Scope:** Text blocks only (Claude's text responses). Tool outputs already have their own file display via renderers.

### 3.1 Detection Utility
**File:** `packages/client/src/lib/filePathDetection.ts`

Patterns to detect:
- Absolute paths: `/path/to/file.ts`
- Relative paths: `./src/file.ts`, `src/file.ts`
- With line numbers: `file.ts:42`, `file.ts:42:10`
- Common patterns from Claude output

Heuristics:
- Must have file extension OR be a known file
- Avoid false positives (URLs, prose that looks like paths)
- Skip paths inside code blocks (already formatted)

### 3.2 Custom Markdown Renderer
**Files:**
- `packages/client/src/components/blocks/TextBlock.tsx`

Use react-markdown's `components` prop to intercept text nodes and wrap detected file paths with `<FilePathLink>`. Only apply to TextBlock (Claude's text responses), not tool output renderers.

### Files to Create/Modify:
- `packages/client/src/lib/filePathDetection.ts` (new)
- `packages/client/src/components/blocks/TextBlock.tsx` (modify)

---

## Phase 4: Shared Types

**File:** `packages/shared/src/types.ts`

```typescript
export interface FileMetadata {
  path: string;
  size: number;
  mimeType: string;
  isText: boolean;
}

export interface FileContentResponse {
  metadata: FileMetadata;
  content?: string;  // For text files under size limit
  rawUrl: string;    // URL to fetch raw content
}
```

---

## Phase 5: Tests

### Server Tests
**File:** `packages/server/test/api/files.test.ts`

Test cases:
- Fetch text file content
- Fetch image file (returns URL)
- Fetch raw file (correct content-type)
- 404 for missing file
- 400 for invalid path
- 403 for path traversal attempt
- Large file handling
- Various file types

### Client Tests
**File:** `packages/client/src/lib/filePathDetection.test.ts`

Test cases:
- Detect absolute paths
- Detect relative paths
- Detect paths with line numbers
- Avoid false positives (URLs, prose)
- Handle edge cases

### E2E Test
**File:** `packages/server/test/e2e/file-browser.e2e.test.ts`

Test flow:
1. Create test project with sample files
2. Start server
3. Navigate to session
4. Verify file path in message is clickable
5. Click file path → modal opens with content
6. Click "open in new tab" → standalone page
7. Click download → file downloads

---

## Implementation Order

1. **Shared types** - Add FileMetadata, FileContentResponse types
2. **Server API** - Create files route with security checks
3. **Server tests** - Comprehensive API tests
4. **FileViewer component** - Modal-based file viewer
5. **FilePage** - Standalone file page
6. **Client routing** - Add file page route
7. **FilePathLink** - Clickable link component
8. **File path detection** - Detection utility
9. **Integrate into TextBlock** - Hook into markdown rendering
10. **E2E test** - Full integration test

---

## Key Files Summary

**New Files:**
- `packages/server/src/routes/files.ts`
- `packages/server/test/api/files.test.ts`
- `packages/client/src/components/FileViewer.tsx`
- `packages/client/src/components/FilePathLink.tsx`
- `packages/client/src/pages/FilePage.tsx`
- `packages/client/src/lib/filePathDetection.ts`
- `packages/client/src/lib/filePathDetection.test.ts`
- `packages/server/test/e2e/file-browser.e2e.test.ts`

**Modified Files:**
- `packages/shared/src/types.ts` (add types)
- `packages/server/src/app.ts` (mount route)
- `packages/client/src/main.tsx` (add route)
- `packages/client/src/components/blocks/TextBlock.tsx` (file path linking)
- `packages/client/src/styles/renderers.css` (styles)
