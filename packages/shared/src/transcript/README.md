# Shared transcript semantics

This directory owns the browser-free semantic compiler used by the existing web
adapter and the server's experimental condensed-conversation producer. Import
from the owning module through `@yep-anywhere/shared/transcript/<module>`.
These are internal package interfaces, not the experimental wire schema.

| Concern | Owner |
| --- | --- |
| Ordered stage orchestration | `compiler.ts` |
| Per-message/block interpretation and user-input classification | `messageProjection.ts` |
| Normalized structural input and record identity | `message.ts` |
| Internal semantic rows and their source relationships | `items.ts` |
| Agent results, command/task parsing and shell-output metadata | `agentResults.ts`, `commandTurn.ts`, `parseTaskNotification.ts`, `shellToolOutput.ts` |
| Compact boundaries, slash-command bodies, shell folding, setup | Corresponding modules in this directory |
| Workflow markers | `workflowTags.ts` |
| Typed projection augment inputs | `types.ts` |
| Confirmed path-link data decoding | `projectPathLinks.ts` |
| Web identity cache, diagnostics, DOM path linking and UI grouping | `packages/client/src/lib/` and its existing adapters |
| New bounded Conversation model | `packages/server/src/experimental/conversation-projection.ts` |
| Provider storage and normalization | Existing server provider/session modules |

Preserve the existing web semantics when changing this shared core. Do not add
React, browser globals, state stores, transport, timers, filesystem access or
server APIs here. Do not bring web reconciliation or renderer registration into
the compiler. Internal HTML augment fields remain data for the web adapter; the
experimental producer never serializes them.

Web production callers continue through `getCachedWebTranscriptProjection`.
The same-input cache stays web-owned and must account for every augment field.
Server projection and parity tooling call the compiler directly. New semantic
stages belong in the narrowest owning module and run exactly once in
`compiler.ts`; do not create compatibility facades or a second web pipeline.

The source boundary test under the client now checks this shared directory and
still enforces the canonical web adapter. Existing compiler, cache, workflow,
shell and native/live parity tests exercise these same modules after extraction.
The optional unmatched-tool-result diagnostic lets a scoped server projection
report unavailable content without emitting one warning per view; the default
web diagnostic behavior remains intact.
