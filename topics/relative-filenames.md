# Relative filename display

Status: implemented for tool renderer display defaults (2026-06-12)

## Tactical issue: absolute path noise in tool rows

Screenshots from a Windows-backed session showed compact tool renderers leaking
paths like `C:\Users\user\Documents\code\project\...` in transcript rows. The
same class of bug can happen on macOS/Linux whenever a renderer bypasses the
shared display helper, but Windows exposes it more often because several helper
functions only split or compare on `/`.

The root causes are:

- `makeDisplayPath()` only strips a project prefix when both paths are POSIX
  slash strings.
- Several renderers have local `getFileName()` / `compactPath()` helpers that
  split only on `/`.
- Summary generation (`getToolSummary`) has not carried project display
  context, so grouped exploration rows and approval rows cannot choose a
  project-relative label by default.
- `FilePathLink` has an independent project-relative link-target conversion
  that treats only leading `/` paths as absolute.

The durable shape is a single client-side display contract:

1. Keep provider/tool payload paths raw for tool data, API calls, copy actions,
   and debugging.
2. Compute visible labels through one cross-platform display helper.
3. Convert project-local absolute link targets to project-relative viewer paths
   through the same comparison rules.
4. Pass project path context into summary generation so new renderers inherit
   the default instead of re-solving path display locally.

Implemented on 2026-06-12 by routing visible file labels through
cross-platform helpers in `packages/client/src/lib/text.ts`. Raw provider paths
remain the source of truth for tool payloads, file API calls, image loads,
copy/debug affordances, and link `title`/metadata where a full path is useful.

## Contract

File paths shown in the UI must be the shortest unambiguous form:

1. **Project-relative** — if the file is under the session's project root,
   strip the prefix and show `src/foo.ts` (no leading slash).
2. **Home-relative** — if outside the project but under `~`, show `~/...`.
3. **Absolute** — fallback when neither applies.

The compact display label (visible text) may still be filename-only for
space reasons. The full display path must appear in the tooltip (`title`
attribute) so the user can identify the file without opening it.

## Implementation

### Shared utility

`packages/client/src/lib/text.ts` is the display boundary:

- `getProjectRelativePath(path, projectPath)` compares POSIX and Windows paths
  after normalizing separators, including case-insensitive Windows drive/root
  comparisons.
- `makeDisplayPath(path, projectPath)` tries project-relative first, then
  falls back to home-relative display via `shortenPath()`, then absolute.
- `getPathBasename()` and `splitDisplayPath()` are Windows-aware basename and
  path-segment helpers for compact labels.

New renderer code should use these helpers for visible text instead of local
`path.split("/")` logic. It should still pass the original provider path to any
API or file-loading code.

### Tool renderers

| Surface | Compact behavior | Full path preservation |
|---------|------------------|------------------------|
| `Read`, `Write`, `Edit` | Filename labels and path titles use Windows-aware helpers and project-relative display where possible. | Raw paths are still used for file fetches, diffs, edits, and copied path details. |
| `Grep`, `Glob` | Tool-use paths, result previews, file lists, match modals, grouped summaries, and approval summaries receive `projectPath` context and compact project-local paths. | Result metadata still carries provider paths for matching and modal navigation. |
| `ViewImage` | Visible image names and summaries compact project-local absolute paths. | Image fetches continue to use the original file path. |
| `WriteStdin` | File-link labels and linked file lines compact project-local paths. Command/process text remains raw. | Linked path targets and process labels retain original data. |
| `Task` nested content | Manually constructed nested render contexts now include `projectPath` so nested tool output inherits the default. | Task payloads and agent content are unchanged. |
| `ToolCallRow`, `ExploredToolGroup`, `ToolApprovalPanel` | Summary generation receives `projectPath` through `ToolSummaryContext`. | Tool input/result objects remain unchanged. |
| `FilePathLink`, `SessionFilePathLink`, public-share local-file rewrite | Project-local absolute targets become project-relative file-viewer paths with Windows path support. | `title`, modal open payloads, and API calls preserve the raw or resolved path as needed. |

### Fixed-font content (code blocks, diffs)

`packages/client/src/components/ui/FixedFontMathToggle.tsx` —
`renderMarkdownFileLink()` handles `[label](href)` patterns inside
fixed-font content. `resolveMarkdownFileLink()` normalizes the href and
strips its leading `/` (a side-effect of `normalizeProjectPath`). The
title reconstructs the absolute path with a `/` prefix, then applies
`makeDisplayPath` with `options.projectPath` so the tooltip shows
project-relative or `~/…` form. `projectPath` is threaded from
`sessionMetadata` into `RenderOptions` at render time.

### Normal markdown text (assistant messages)

`packages/server/src/augments/safe-markdown.ts` — local-file markdown
links (`[label](./path)`) get `title` set to the href (absolute path)
when the markdown does not supply an explicit title.

When a Markdown document is rendered with a known local base, ordinary
relative links are resolved against that document's directory for preview
purposes. Markdown targets route through `/api/local-file?path=...&render=1`
so browser link gestures open a rendered, content-only document. Local media
targets route through `/api/local-image`.

### File path anchors

`packages/client/src/components/FilePathLink.tsx` renders path mentions as
native anchors to `/projects/:projectId/file?path=...`. Plain left click
opens the in-app file modal. Browser link gestures fall through, so middle
click, command/control click, and similar browser gestures open the
standalone file viewer.

After the 2026-06-12 implementation, `FilePathLink` also recognizes decoded
Windows project ids such as `C:\Users\me\repo` as valid absolute project roots.
Project-local absolute targets are converted to relative viewer paths using the
same helper rules as renderer labels.

### `transformFilePathsToHtml` — dead code

`packages/shared/src/filePathDetection.ts` exports this function, but it is
never called anywhere in the live codebase. The `.file-link`
CSS class it would generate appears to be dead styling as well.

## projectPath availability

`projectPath` comes from `SessionMetadataContext` (populated in
`SessionPage` from the project API). It is `null` when no project is
associated with the session. `makeDisplayPath` handles `null` gracefully
by falling back to `shortenPath`.

## Verification

Added focused tests for:

- Windows and POSIX project-relative display helper behavior.
- Windows-aware `FilePathLink` viewer target conversion.
- Read/Grep summary compaction with Windows project paths.
- Explored tool group pending summaries.
- Grep and Glob renderer result display and match modal display.
- Public share local-file link rewriting for Windows paths.

Verification commands run on 2026-06-12:

- `pnpm typecheck`
- `pnpm --filter @yep-anywhere/client test -- src/lib/__tests__/text.test.ts src/components/__tests__/FilePathLink.test.tsx src/components/tools/__tests__/summaries.test.ts src/components/blocks/__tests__/ExploredToolGroup.test.tsx src/components/renderers/tools/__tests__/GrepRenderer.test.tsx src/components/renderers/tools/__tests__/GlobRenderer.test.tsx src/pages/__tests__/PublicSharePage.test.tsx`
- `pnpm lint`
- `pnpm test`

## Non-tool audit

Audited on 2026-06-12 after the tool renderer pass:

- `FileViewer` now uses `makeDisplayPath()` for the header path while keeping
  the raw `filePath` for file loading, raw download URLs, and tooltips.
- `LocalFileModal` now uses `makeDisplayPath()` for metadata text while keeping
  the raw local path for `/api/local-file` fetches and the tooltip.
- `useLocalResourceClick()` now uses the shared project-relative helper instead
  of its local duplicate, including browser-style Windows paths such as
  `/C:/Users/...`.
- `UserPromptBlock` opened-file metadata now benefits from a shared
  backslash-aware `getFilename()` helper.
- Fixed-font markdown links were already covered: they receive `projectPath`,
  compact tooltips through `makeDisplayPath()`, and keep project-relative file
  viewer targets.
- Rendered normal markdown local-file links were already covered on left click:
  project-local absolute paths become project-file viewer targets; browser link
  gestures keep the original local-resource URL.
- Attachment chips intentionally show the uploaded/original filename as visible
  text and keep the raw upload path only in the tooltip/cache key.
- Git status and activity pages did not need changes: git status receives git
  porcelain paths, and activity rows render watcher `relativePath`.

Remaining validation should be product-level rather than another broad code
search: capture a Windows-backed session transcript and check visible path text
in the transcript, file viewer, local resource modal, uploaded attachments, and
user-prompt opened-file chips.
