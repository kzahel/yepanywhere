# Debug reload browser check sometimes fails to open the sidebar

The full local Node 24.22.1/macOS browser run at `3c6080805` failed the
desktop `browser-debug-reload.spec.ts` case in `clickSidebarSession`: clicking
**Open sidebar** completed, but `[data-sidebar]` did not appear within the
unchanged five-second assertion. Debugging remained active and the composer
was rendered. This happens after the desktop case exercises narrow toolbar
widths and restores its original viewport.

An immediate isolated one-worker run passed both desktop and phone cases
(3.9 and 3.6 seconds). This does not establish a cause or a fix. Preserve the
sidebar click, viewport/sidebar state and preceding resize transitions on
recurrence; do not increase the timeout or retry the click without diagnosing
whether the control was replaced, its event was lost, or state closed again.

The full run passed 614 cases and skipped 14, with separate receipt-lifetime
and public-share menu failures. Local logs are retained under ignored
`tasks/desktop-release-012/{browser-full,browser-debug-isolated}.log`, with
the run's evidence under
`packages/client/test-results/5f89e29c-9ee5-4d0b-b3b0-22b30a0bba35/`.

Found 2026-11-16 during desktop 0.12.0 release preflight.
