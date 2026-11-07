# acli-commentary browser tests fail when the suite runs from a worktree

`packages/client/e2e/acli-commentary.spec.ts` cases at lines 223, 359, 422
and 490 fail with "Failed to load resource: the server responded with a
status of 403 (Forbidden)" console errors whenever the client browser suite
runs from a separate git worktree (`git worktree add`, with `node_modules`
symlinked from the main checkout). They fail the same way at commits
without any related change, and all six cases pass in the main checkout.
Tier 3 runs from worktrees therefore report four failures that are not
regressions.

Not investigated: likely a path allow-list or origin check that resolves
the main checkout's path rather than the worktree's (the symlinked
`node_modules` or a cached build directory). Cheap check: log the 403's
request URL and compare its path with the worktree root.

Found 2026-11-07 while running per-slice Tier 3 for plans 178 and 179 in
worktrees.
