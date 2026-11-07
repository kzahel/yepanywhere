# Session composer refusals are English-only

Some refusals the session composer shows when it will not send are fixed
English strings, not i18n messages:

- `/btw` without a fork path:
  `lib/sessionComposerSendDecisions.ts` (`resolveComposerSubmission`),
  "/btw asides are available only for providers with a wired fork path."
- The session-operation refusals in `lib/slashCommands.ts`
  (`resolveComposerSessionOperation`), for example "Use /archive by itself
  without attachments." and "Remove attachments before using /title."
- The slash-turn errors in `lib/slashCommands.ts`
  (`resolveComposerSlashTurn`), for example "Add a request after /fast or
  /f."

They show unchanged in every locale. They were kept as they were while plan
179 moved the decisions into plain functions, which must not change toasts.
Cheap fix: return a message key (with arguments) from the resolvers and
translate it where the toast is shown, adding the keys to every locale file.

Found 2026-11-07 while landing plan 179 slice 1 (session composer sending as
plain decisions).
