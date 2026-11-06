# Session Detail Render Selector Preflight

Topic: session-detail-data-layer

This note supports
[`043-session-detail-data-layer-plan.md`](043-session-detail-data-layer-plan.md).
It records the render-selector boundary split from `MessageList`.

## Extracted Boundary

The pure render boundary is now in the
`packages/client/src/lib/sessionDetail/` concern modules (renderItems,
composerTail, thinking, exploration, timeline, search). Callers import the
concern module that owns each selector; the `renderSelectors.ts` barrel that
re-exported them was removed on 2026-11-06.

Covered inputs:

- `messages`;
- `markdownAugments`;
- `activeToolApproval`;
- `transcriptDisplayObjects`;
- optional `previousRenderItems` for stable object reuse.

Covered outputs:

- preprocessed `RenderItem[]`;
- inserted transcript display objects;
- stable render item object reuse;
- turn grouping for user, assistant, and standalone display-object entries;
- assistant render segments, including explored tool runs;
- user-turn navigation anchors;
- user-turn, all-turn, and full-session search anchors;
- search-driven visible turn-group filtering;
- search match and selected-anchor projection;
- latest correctable prompt derivation;
- visible timeline entry derivation and timestamp ordering for turn groups plus
  `/btw` aside metadata;
- progressive timeline entry weighting and render-item target count derivation;
- progressive timeline visibility projection, including effective entry count,
  sliced entries, and progress percent;
- thinking duration derivation from render items plus `nowMs`;
- thinking count and latest-thinking-id derivation from render items;
- display render item filtering from render items plus the local thinking
  visibility flag;
- thinking id and text-length summary derivation for local expansion/follow
  effects;
- visible thinking text-delta detection from thinking text-length summaries plus
  the local expansion predicate;
- auto-expanded thinking-id reconciliation from previous/observed/current id
  sets plus the historical-seed flag;
- latest visible timestamp derivation across render items, pending sends,
  deferred sends, project queue rows, and `/btw` asides;
- last timestamped render-item lookup and visible-turn ending rules used by
  transcript-position timestamp sampling;
- composer tail ordering and deferred queue lane position derivation;
- composer tail row metadata, including parsed timestamps, stale-age
  visibility, recovered/patient deferred flags, recovered queue ids, project
  queue status kind, and attachment-count badge visibility;
- assistant timeline row metadata, including explored-tool segment timestamps,
  stale-now hints, render-item indexes, and thinking durations;
- timeline entry display row metadata, including `/btw`, empty, standalone,
  user, and assistant row classification plus user-prompt action eligibility,
  latest-correctable flags, row keys, stale-now hints, and assistant timeline
  row metadata for assistant entries;
- assistant timeline item action eligibility, including thinking toggle,
  quote, and user-prompt trim/fork eligibility;
- search readiness, active search anchor selection, search panel labels/counts,
  searchable-user-turn detection, and navigator search-state projection;
- composer tail action eligibility, including project-queue cancel and deferred
  recovered resume/delete plus queued-message cancel eligibility.

`MessageList` still owns the stateful and DOM-local pieces: the previous item
ref, thinking expansion state, search session state and keyboard navigation,
correct-prompt action wiring, progressive reveal, selection, scroll anchoring,
composer tail row labels/rendering/actions, and actual rendering.

## Still Local To MessageList

- Thinking visibility and expansion policy.
- Search session state, keyboard/repeat navigation, selected-match updates, and
  DOM navigation.
- Correct-prompt action wiring and rendering actions for user rows.
- `/btw` aside ownership and rendering.
- Composer tail row labels, rendering, callbacks, and attachment display.
- Assistant timeline row rendering, actions, quote controls, and component
  choice.
- Progressive reveal state, status UI, and timers.
- Scroll snapshots, follow-tail behavior, selection quote UI, and navigation.
- DOM measurement and row anchoring.

## Checkpoint

This preflight is complete enough for store cutover planning. Do not keep
extracting every remaining conditional from `MessageList` unless it directly
unlocks store ownership, fixes a fixture-backed bug, or prevents a known render
shape divergence.

The remaining local responsibilities are intentionally stateful or UI-owned:
DOM measurement, scroll effects, snapshot ownership, labels, callbacks, row
actions, `/btw` ownership, and actual JSX rendering.
