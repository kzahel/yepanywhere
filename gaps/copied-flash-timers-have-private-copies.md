# Seven copy buttons reset their "copied" state with an uncancellable timer

`components/CopyButton.tsx` and `components/ui/CopyTextButton.tsx` each own a
reset timer they clear. Seven other sites in `packages/client/src` set a
copied flag and then call `setTimeout(() => setCopied(false), …)` without
keeping the handle:

`components/FileViewer.tsx`, `components/RemoteAccessSetup.tsx`,
`components/blocks/TextBlock.tsx`, `components/blocks/ToolHeaderCopyButton.tsx`,
`components/renderers/tools/EditDiffPresentation.tsx`,
`components/renderers/tools/outputPreview.tsx`, and the code-fence copy button
in `hooks/useCodeFenceRenderers.tsx`, which sets a DOM attribute instead.

A second copy inside the window is reset early by the first copy's timer, so
the confirmation can vanish almost at once. The durations also differ (1.2,
1.8, 2 and 3 seconds) for no recorded reason.

Cheap fix: use `CopyTextButton` where the markup allows, and otherwise one
hook that owns the flag and its timer. Remove each converted file's `detached`
entry from `scripts/timer-ownership.json` in the same commit.

Found 2026-11-15 while recording the timer ownership baseline.
