# Codex item conversion exists three times and the copies disagree

Three code paths turn Codex items into YA SDK messages, each written
separately:

- live app-server notifications:
  `packages/server/src/sdk/providers/codex-item-conversion.ts`
  (`normalizeThreadItem`, `convertItemToSDKMessages`) and
  `codex-live-event-conversion.ts` (`convertNotificationToSDKMessages`,
  `convertRawResponseItemToSDKMessages`);
- durable rollout JSONL:
  `packages/server/src/sessions/normalization.ts`
  (`convertCodexResponseItem` and its payload converters);
- the Codex OSS exec-JSON adapter: its own private
  `convertItemToSDKMessages` in
  `packages/server/src/sdk/providers/codex-oss.ts`.

Shared pieces exist (`codexToolMessageId`, the `codex/normalization.ts` tool
normalizers), but the message shapes are assembled three times. Differences
checked against the code on 2026-11-08:

- Codex OSS `command_execution` tool results carry no `uuid`; the live path
  uses `<item>-result` ids that match the durable backfill row.
- Codex OSS file-change results have no `declined` branch: a declined change
  reads "File changes failed". The live path says "File changes declined".
- A live `web_search` tool_use keeps only `{ query }`. The durable path also
  copies `action` into the input, so a live row and its durable replacement
  differ.
- `codeModeTurnId` is stamped only on the tool-call context of durable
  `exec` calls (`normalization.ts`, `convertCodexCustomToolCallPayload`).
  This may be deliberate, since only the durable reader joins code-mode
  turns, but nothing records that.
- The `-result` uuid suffix and the durable/live choice of uuid are encoded
  separately in each path, not shared.

Not fixed in place: they were found while landing a move-only split of
`codex.ts` (058 slice 4.4), which may not change behavior. Each difference is
user-visible (row identity or tool text) and needs its own render-parity case.
Do not do the fix as one big merge. Pick one difference at a time, decide
which shape is right with a parity test, then move that piece of shape
assembly into a function both paths call. Codex OSS is the cheapest to align
first, because it has the fewest callers. Codex audit approval rules
(`docs/development/providers.md`) apply where the right shape depends on
Codex protocol fields.

Found 2026-11-08 while splitting Codex live event conversion out of
`codex.ts` (058 slice 4.4); the differences above came from a cross-provider
duplication sweep and were then checked by hand against the code.
