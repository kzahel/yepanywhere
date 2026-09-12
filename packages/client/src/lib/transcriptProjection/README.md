# Web transcript projection cache

The browser-free compiler and its structural types/parsers now live in
[`packages/shared/src/transcript`](../../../../shared/src/transcript/README.md).
Both the web adapter and the experimental server producer consume that one core.

This directory retains the same-input identity cache in `cache.ts` and its
existing tests. `../webTranscriptProjection.ts` owns browser diagnostics,
confirmed-path DOM annotations, and cached web assembly. Display objects,
previous-row stabilization, grouping, selectors, React and interaction state
remain in the existing web adapters and renderer.

- Production web projection goes through `getCachedWebTranscriptProjection`.
- Define every augment's cache identity in `cache.ts`; the exhaustive key map
  makes omissions a type error.
- Tests and server projection may call the shared compiler directly.
- Do not add compatibility re-exports, restore `preprocessMessages.ts`, or
  introduce a second production web compilation pipeline.

`../__tests__/transcriptProjectionBoundary.test.ts` checks the shared semantic
core's browser independence and the web consumers' adapter ownership.
