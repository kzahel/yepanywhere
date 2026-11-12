# Code-Fence Language Renderers

> How YA reduces a fenced code block's info string to one normalized language
> name, marks every rendered block with that name, and dispatches a registered
> per-language renderer such as Mermaid instead of syntax highlighting.

Status: implemented. `normalizeCodeBlockLanguage` and the `language-*` marker
run server-side; `useCodeFenceRenderers` labels blocks and dispatches renderers
client-side; `mermaidRenderer` is the one registered renderer. The pre-existing
`ansi` and `toon` cases still live inside `renderCodeWithHighlighter` as
server-side branches rather than registry members.

See also [`rich-text-rendering.md`](rich-text-rendering.md) for the surrounding
render pipeline and [`active-content-security.md`](active-content-security.md)
for which trust class a renderer's output falls into.

## The info string is one language name

In CommonMark everything after the opening fence is an *info string*. Only its
first word is conventionally a language; the rest is renderer-specific
attributes. YA reduces it to a single comparable token: trim, take the first
whitespace-delimited word, lowercase. Anything left is discarded.

`normalizeCodeBlockLanguage` in
`packages/server/src/augments/code-language.ts` is the one implementation.

This applies to **every** code-block language string, not only ones some
renderer claims. `BlockDetector` normalizes at fence detection, for both the
completed-block and streaming-block paths, and both `AugmentGenerator` entry
points normalize before rendering. So the Shiki grammar lookup, the `ansi` and
`toon` special cases, the loaded-language set, and the emitted class all see
the same form, and a fence written ```` ```JavaScript ```` behaves like
```` ```javascript ````.

An info string may hold spaces and punctuation attributes; normalization drops
that tail. The one exception is CommonMark's: a backtick fence's info string may
not contain a backtick, so a line that is an inline code span — ```` ```code```
followed by prose ```` — opens no code block and is a paragraph. A tilde fence
has no such restriction and takes its info string whole. `codeFenceOpening` in
`packages/server/src/augments/block-detector.ts` answers "does this line open a
fence, and with what info string" for every one of the streaming detector's
fence decisions, so block detection, the partial-line lookahead, and the
language read cannot disagree.

## Every rendered block carries its language

A per-language client renderer needs the language in the DOM. The plain
fallback (`renderPlainCodeBlock`) and the ANSI path already emitted
`class="language-<name>"`, but Shiki did not: its output encodes the language
only in token colors, so a highlighted block was indistinguishable from any
other. A Shiki `code` transformer now adds the same class.

That one class is the whole client-facing contract. The client reads the
language from `pre > code[class*="language-"]` and never re-derives it from the
original fence text. The shared sanitizer already allows `class` on `code`, so
this needs no allowlist change.

Not covered: the rendered-Markdown-file path in `renderSafeMarkdown` uses
markdown-it's default fence rule, which emits `language-<first word of info>`
with the original case preserved. Bringing that path onto the same
normalization is unresolved.

`useCodeFenceRenderers` lowercases the name it reads out of the class, so
renderer dispatch and the language label already agree across both paths. That
is a client-side tolerance for the gap above, not a substitute for closing it:
the emitted class itself still differs between the two paths, so anything that
matches on the class text rather than reading it is still exposed.

## The default language affordance

A marked code block names its language on hover and on tap. It adds no visible
badge in the resting state. The label occupies the reserved code-block header
beside Copy, so revealing it does not cover code or change the block height.
A block with no language, or one whose info string normalizes away, shows
nothing.

Three details are load-bearing:

- The label is a CSS pseudo-element fed by the block's own data attribute, so
  it can never enter a text selection or a copied code block. A real element
  inside the `<pre>` would.
- Pointer devices reveal it on hover; keyboards reveal it on focus, which the
  highlighter's `tabindex` already provides. A tap sets a data attribute that
  clears itself, so touch reaches the same label without turning it into
  permanent chrome.
- The block carries an `aria-label` but deliberately no `title`. A native
  tooltip on every code block would fire while reading or selecting code, a
  second behind the label and saying the same word.

## Copy control

Every fenced block — labeled, `text`, or bare — carries a copy button in a
reserved header row above the source that copies the block's content verbatim:
exactly the fence body, with indentation, blank lines, and entity-decoded
characters, and nothing added. It is an established first-party convention (claude.ai code
blocks), so it ships visible under
[vanilla defaults](vanilla-defaults.md#contract) rather than behind an option,
revealed the way the language label is: on hover or focus for pointers, and
always shown without a hover pointer, where it grows to a touch-sized target.
The language label shares that row. Neither control may overlap the source,
including wrapped first lines on narrow phones. Source text retains the full
content width below the header; no right-hand control gutter reduces it.
Keep padding and the gap before source compact; the button's touch target,
not extra whitespace, determines the mobile header height. Touch targets
remain at least 44×44 CSS pixels.

It is a real `<button>` inside the `<pre>`, which the label deliberately is
not, so it is built to leave every copy path untouched: icon-only (no text in
the block's `textContent` or a plain selection), marked
`data-markdown-copy-ignore` for Markdown copy, and stripped by the semantic
HTML clipboard with the rest of the active content. A confirmation state
lasts about a second after a successful write.

Fenced-code syntax comments must have at least 4.5:1 contrast against the
code-block background in light, dark, verydark, and both automatic color schemes.

## Fixed-width Unicode grids

`useCodeFenceRenderers` also normalizes grid typography through
`lib/codeFence/gridFont.ts`. A multiline block with at least four box, block,
geometric, Braille, or legacy-computing symbols, or an ASCII box border, uses
the already shipped Fira Mono for the entire block. Its wider cells better
fit grid art than Iosevka. No new font asset or preference is required.

Other blocks switch when a standalone Unicode punctuation or symbol glyph's
measured advance differs from one ordinary cell. This detects both browser
font fallback and double-width symbols supplied by the selected font itself:
the shipped Iosevka draws `◎●○◯∞∑→` at twice its digit advance.

Iosevka supplies symbols missing from Fira, followed by the browser's
monospace fallback. After fonts load, any remaining mismatched symbol gets a
one-cell inline wrapper and proportional scaling. The cell controls advance;
scaling preserves the glyph's shape. Highlight spans, links, and source text
remain intact, including verbatim copying. The client enhancement covers
streamed and historical assistant blocks and rendered Markdown previews.

This is a symbol-grid contract, not a terminal emulator. Chinese, Japanese,
Korean, fullwidth punctuation, emoji-presentation characters, and multi-codepoint
graphemes retain natural layout. Authors mixing these with single-cell symbols
remain responsible for spacing. Inline code and ordinary code without a width
mismatch retain the chosen output font.

Unicode classifications use a process-wide sparse array of lazily allocated
256-codepoint byte pages, with cached property flags per codepoint. Font/glyph
measurements are shared within each mounted renderer and capped at 4096 pairs.
Output appearance changes invalidate those measurements and rebuild wrappers;
async results are discarded after source replacement or unmount.

Raw message source remains React-owned: Unicode grid normalization must not
replace its text nodes or issue links. Metadata refreshes and live text updates
must preserve readable source without a React reconciliation error. The raw
view retains verbatim copying and its selected output font; grid wrappers apply
to rendered HTML code blocks.

The browser regression uses the real enhancement hook and shipped fonts:
`pnpm --filter @yep-anywhere/client exec playwright test --config playwright.code-grid.config.ts`.
It checks symbol/reference row alignment, fallback for an isolated double-width
circle, verbatim copy, and sequential typing during streamed updates with 100
additional mounted grids. Captures cover desktop and phone widths.

## The renderer registry

Dispatch is a lookup in a map keyed by normalized language name. Two properties
matter more than the shape of the map:

- **Registration happens once.** Explicit registration at module load is the
  preferred form because it is the simplest thing that works and it keeps the
  set of renderers greppable. Scanning a directory once at startup to
  auto-register is also acceptable.
- **A code block never scans.** Rendering a block must cost a map lookup.
  No filesystem probe, no asset discovery, no dynamic resolution per block.
  Whatever a renderer needs, it acquires at registration or on its own first
  use, not per occurrence.

`registry.ts` holds the map, `renderers.ts` holds the one call per member, and
`mermaidRenderer.ts` holds the only member today. A renderer takes the source
text and either returns markup or declines. Declining leaves the highlighted
source in place, so an unparseable diagram is still readable.

`ansi` and `toon` remain language-keyed branches inside
`renderCodeWithHighlighter` rather than registry members. They belong here
eventually — the registry is where language-keyed rendering should live — but
they run server-side and produce HTML for the augment stream, so folding them
in means the registry has to span both halves. That is a separate change.

## Mermaid

Mermaid is the motivating case and the reason the registry has a client half:
it lays diagrams out against a live DOM, so it cannot run in the server augment
generator. The split is therefore:

- The server emits nothing special. A ```` ```mermaid ```` fence produces the
  ordinary marked code block. No new server dependency, no sanitizer
  relaxation, and a client that does not implement the renderer still shows
  readable diagram source.
- `useCodeFenceRenderers` finds `pre > code.language-mermaid` inside an
  already-rendered container and wraps the block so the diagram and its source
  can each be the visible view. Mermaid itself is a dynamic import, so a
  session with no diagrams never downloads it.
- On a parse or render failure the code block is left exactly as it was.

Two consequences of the dynamic import are worth knowing before touching the
build. Mermaid's core chunk and its per-diagram-type chunks each sit near
700 kB, which is above Vite's default 500 kB warning and therefore above YA's
warning-free build policy. Both client configs raise
`chunkSizeWarningLimit` to 750 kB on the grounds that these chunks arrive only
when a transcript contains a diagram and never enter the initial load. The
ceiling still has to catch an *entry* chunk reaching that size, which is what
the policy was protecting.

The render cache is keyed on renderer, source text, and resolved light/dark
appearance. Keying on appearance is what makes a theme switch redraw a diagram
with the new palette instead of reusing stale SVG; the hook watches
`data-theme` and the system color-scheme query to trigger that pass. Entries
hold rendered SVG, so the cache is bounded and evicts the oldest rather than
growing for the life of the tab.

That appearance has one owner, `getResolvedTheme` in `hooks/useTheme.ts`, which
is the same answer every other client surface asks for: the stored preference,
with `auto` following the OS and `verydark` resolving to dark. The cache key and
Mermaid's own theme configuration both read it, so a diagram cannot be drawn in
one appearance and then cached under another. The page's `data-theme` follows
the same stored preference, including a change saved in another tab, so a
diagram drawn after that change matches the page around it and the attribute
change redraws the diagrams already shown.

### Inline SVG from a reviewed renderer is allowed

Mermaid's SVG is displayed inline as ordinary reviewed-renderer output. No new
allowlist, no rasterization, no sandbox. Mermaid is a reviewed renderer, and
its own `securityLevel: "strict"` stays on because it costs nothing.

The untrusted-active-document rule that SVG follows the active-document policy
even when the UI calls it an image governs SVG *bytes* YA received and cannot
reason about — a project file, an upload, a share. It does not govern markup a
renderer YA chose and ships produced from text. KaTeX is the standing example
of the latter: `renderSafeMarkdown` buffers its `span`/`svg` output past the
sanitizer rather than growing the allowlist to cover it. Trust rests on
renderer selection and upkeep, so an advisory against such a renderer is an
upgrade-or-drop decision rather than a reason to add a second sanitizer.

YA has no SVG sanitization path for the case where the renderer is *not*
reviewed, and nothing mechanically distinguishes the two classes. That is
captured in
[`gaps/svg-sanitization-for-unreviewed-renderers.md`](../gaps/svg-sanitization-for-unreviewed-renderers.md)
and does not affect Mermaid.

### Control is the source/render toggle

The user-facing control for a rendered diagram is the ordinary source-or-
rendered choice YA already offers everywhere else, not a security setting. A
Mermaid block renders as a diagram by default and toggles back to its
highlighted source on demand, reusing the Σ affordance and hover behavior of
the fixed-font panels rather than introducing a per-language control. Reusing
it is literal: this toggle is built in plain DOM rather than by React, and both
surfaces draw the glyph from the one definition beside `RenderModeGlyph`, so
the two controls cannot come to look different.
Rendering by default is the deliberate choice here: showing diagram source
where a diagram was requested is the defect this feature exists to fix, so it
is not a case of disturbing a sound default.

The toggle's accessible name says which thing it switches — "Show diagram
source", not "Show source". An assistant message carries its own
source/rendered toggle, so the bare label leaves two same-named buttons in one
message. Any renderer added later needs a distinguishing noun for the same
reason.

Where a hover pointer does not exist, the toggle is always visible instead of
fading in, because it is then the only way back to source.

### Fullscreen inspection

Tapping a rendered diagram or its visible **Expand diagram** button opens a
fullscreen viewer in transcripts and rendered Markdown file previews. Keyboard
users can activate the diagram with Enter or Space. The shared image viewer
starts fitted and offers pinch zoom, one-finger panning, Ctrl/trackpad-wheel
zoom and visible Fit, actual-size and zoom buttons. The diagram remains SVG,
including HTML labels, so enlarging it does not rasterize its text.

Close, Escape or mobile Back dismisses only the diagram viewer and returns to
the same underlying transcript or file preview without changing its scroll
position. Opening a diagram from a file viewer keeps that parent viewer open.
The Σ source/render toggle remains independent and never opens the viewer.
Expansion reuses the already rendered diagram; it performs no server request
and creates no project file. Temporary vector URLs are released on dismissal.
This extends the established image-viewing interaction to diagrams and is
always available, as approved by the maintainer on 2026-10-31.

## Streaming

A client may re-render on each streaming augment, but that is not the usual
case and no renderer should be designed around it. Streaming code blocks
deliberately take the plain fallback path with no highlighting, so a partial
Mermaid source would simply fail to parse.

Two consequences for the renderer contract: an incomplete source is "not yet",
never an error, and a renderer must not do expensive work per token. The
natural point to attempt a render is the completed-block augment; a client that
does attempt earlier should gate retries on the source actually having changed.

`useCodeFenceRenderers` implements that with one attempt per exact source text,
recorded on the block. A growing source produces a new key and is retried; a
source that declined is not retried in a loop. Mutation bursts coalesce to one
pass per animation frame, so per-token cost is a scan rather than a render.
