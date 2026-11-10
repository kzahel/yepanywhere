# Broad checks blocked during Local Access notice removal

On 2026-11-10, removing the Apps migration link from Local Access encountered
unrelated concurrent source edits. Do not mechanically rewrite these files
while their owner is editing them.

- `pnpm lint` stopped at the source budget: `EditRenderer.tsx` was 1,812
  lines against its 1,808-line budget. Its owner must extract or reduce growth;
  do not raise the budget for this copy removal.
- `pnpm format:check` reported 14 files: `design/controlOverrides.ts`,
  `NewSessionProjectQueue.tsx`, `ProviderChildSessionControl.module.css`,
  `ProviderChildSessionControl.tsx`, `renderers/tools/EditRenderer.tsx`,
  `renderers/tools/WriteStdinRenderer.tsx`, `ui/Button.module.css`,
  `ui/Button.tsx`, `extension/sidepanel/SidePanel.tsx`,
  `pages/ConversationPreviewPage.tsx`, `pages/ReviewSubmissionsPanel.module.css`,
  `pages/ReviewSubmissionsPanel.tsx`, `pages/settings/SettingsCategoryItem.tsx`,
  and `styles/index.css` (all under `packages/client`). Format those exact
  files after coordinating with the concurrent owner.
- `pnpm test` reported failures in `MessageList.rendering.test.tsx`
  ("offers correction only for the latest real user message") and
  `RiskAffordance.test.tsx`. Both production owners have concurrent edits;
  diagnose against that work before attributing these failures to the notice.

The touched Local Access source passes its individual Biome lint/format
checks, all 13 existing Local Access component tests pass in 2.83 seconds,
and root typechecking passes. Desktop and phone artifact captures confirm
the notice is absent. The capture harness reports its expected "Service Worker
registration blocked by Playwright" warning, so this is visual evidence rather
than certification of a warning-free browser session.

CSS ownership extraction was deferred: `css:touched` reports LocalAccessSettings
has 54 owned lines spread across a 675-line span with 15 coupled rules. Removing
an import and link does not open a safely isolated style slice.

Found 2026-11-10 while removing the Local Access Apps migration notice.
