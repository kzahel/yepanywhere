# New Session options and start split

Topic: session-defaults

Status: in progress. Slice 0 (the pins) landed 2026-11-07: 26 cases in
`NewSessionForm.test.tsx` (148 tests in the file) and
`new-session-option-paths.spec.ts`. The browser spec drives the real form
and real settings; sandbox support reaches `/new-session` over the socket,
not HTTP, so T8 and the sandbox save are pinned by the component tests.
Tier 2 passed; Tier 3 in a worktree had 514 passed, 13 skipped and 4
failed, all `acli-commentary.spec.ts`, which fails from a worktree.
Slice 1 (the reducer, `lib/newSessionOptionsState.ts`) landed 2026-11-07;
the model fills became two functions, `fillGatewayModel` and
`fillCatalogModel`, one per effect. Slice 2 (the options hook,
`hooks/useNewSessionOptions.ts`) landed 2026-11-07 with two departures from
the target shape below: the `isStarting` guards stay with the markup, so
the hook takes no `isStarting` and returns one stable `customizeOptions`
(set the customization ref, then dispatch) in place of the ten inline
ref-then-dispatch pairs; and `launch` is passed through as an object, so
the moved memo keeps its dependency on it unchanged. Slice 3 (the options
panel, `components/NewSessionOptionsPanel.tsx`) landed 2026-11-07; it takes
the hook's result as one `options` prop, reads `t` from `useI18n`, and also
takes `providerSlotFilled` (computed once in the form for its layout class
and passed in, so the panel and the form cannot disagree) and
`clientSummarySourceKey` and `versionInfo` for the pool selector. Slice 4
(start and Queue decisions, `lib/newSessionStartDecisions.ts`) landed
2026-11-07. Queue's decision is two functions on either side of the
defer, `projectQueueRefusalBeforeDefer` and `planNewSessionProjectQueue`,
and `proceed` also carries `hasCommand`, which `supportsSessionCreation`
reads.

Proposal 3 of the
[session page React hub gap](../../gaps/session-page-react-hub.md), owned by
[doc 058](058-typescript-module-boundary-refactor.md) priority-queue item 2.
Commits carry `Topic: typescript-module-boundary-refactor` and
`Topic: session-defaults`.

`components/NewSessionForm.tsx` (5,526 lines at `66ebf019a`) holds three
things that change for different reasons:

- **The option state.** Sixteen `useState` fields (450-491), seeded,
  locked, refilled and saved by seven effects and a dozen handlers spread
  over 460-2590, plus about 300 lines of values derived from them
  (532-536, 656-682, 1208-1526, 2223-2278).
- **The options markup.** About 1,000 lines of sections, label maps and the
  advanced-options toggle (1159-1206, 4417-5130, 5400-5522).
- **Starting and queueing.** `handleStartSession` (2788-3347, 560 lines)
  and `handleQueueProjectSession` (3349-3529, 180 lines). Each mixes
  deciding (refusals, the settings sent, the error shown) with doing it
  (requests, draft capture, navigation, toasts).

This plan gives the option state one owner (a reducer in one hook), moves
the markup into an options panel, and gives starting and queueing the shape
plan 179 gave the session composer: plain decision functions with unit
tests, and a plain module that runs the effects in today's order.

It follows the rules of [plan 177](177-session-launch-service.md),
[plan 178](178-shared-composer-dictation.md) and
[plan 179](179-session-composer-send-decisions.md):

- Each slice keeps every path's behavior, including the order of its
  effects, and lands on its own with its budget ratchet and doc 058 row.
- Before a slice changes a path, a check pins what that path does today
  where coverage is missing (slice 0).
- Where the paths differ, the difference stays as it is: a named option when
  deliberate; a decision below when a user could see it. The maintainer has
  said to prefer one behavior over per-path differences where that is the
  simpler result (plan 179's "Settled" paragraph), so the decisions below
  recommend one, and slice 6 lands the agreed ones, each in its own commit
  with a test.
- No change to request bodies, saved-defaults bodies, toasts and their
  keys, traces, draft capture and recovery, return values or navigation
  state.
- `handleStartSession` is a `useCallback` today and its identity matters:
  `handleSmartTurnSend` and the voice button's callbacks depend on it, and
  `NewSessionForm.test.tsx` pins that those callbacks survive a typed
  character. It keeps the same dependency list. `handleQueueProjectSession`
  stays a plain arrow rebuilt each render.
- Slices 1, 2 and 4 change hook order, effect order or code shape, so their
  doc 058 rows say "Not move-only: a consolidation under plan 180", as rows
  2.16 to 2.19 did. Slices 3 and 5 are move-only apart from the parameters
  and the declared hunks they list.

Related gap: [remaining creation paths can clear a newer unsent
draft](../../gaps/new-session-draft-clear-captures-after-submission.md)
names three `clearDraft()` callers in this file (the legacy fallback,
`launch.submit` and the template `onStarted`). This plan moves the first two
verbatim and does not fix them; the gap stays open.

## Contracts these paths carry

- [Session defaults](../../topics/session-defaults.md) (12-142):
  all-provider versus provider-specific defaults; switching provider
  restores that provider's defaults without touching the all-provider ones;
  restored display defaults seed untouched controls and an explicit
  selection survives the settings that arrive later; Start, Queue and the
  automatic save wait for current settings.
- [Limited users](../../topics/limited-users.md): a principal's lock is
  applied last on every seeding path, is not saved as a preference, and its
  overrides are the last word in the launch options.
- [Agent auth router](../../topics/agent-auth-router.md#new-session-defaults):
  a restored pool is used only when usable; Project Queue and template
  creation launch direct.
- [Session sandboxing](../../topics/session-sandboxing.md): sandboxing turns
  the firewall on and a side-session recap off.
- [Draft synchronization](../../topics/draft-synchronization.md#sending-and-clearing):
  durable creation and Queue capture the submitted text and files before the
  request and confirm only that capture.

## The option state today

Line numbers are at `66ebf019a`.

**Fields** (450-491): `mode`, `selectedProvider`, `routerPreference`,
`routerSelectionCustomized`, `routerConnectorsChoice`, `selectedModel`,
`selectedServiceTier`, `selectedThinkingMode`, `selectedEffortLevel`,
`selectedRecapMode`, `sandboxLevel`, `machineControlSelected`,
`sandboxNetworkFirewall`, `recapAfterSeconds`,
`selectedPromptSuggestionMode`, `helperSideModel`. Three refs steer
seeding: `hasSeededDefaultsRef`, `hasInitializedDefaultsRef` and
`hasUserCustomizedDefaultsRef` (588-590).

**Transitions that change several fields together:**

| # | Transition | Where | Fields |
| --- | --- | --- | --- |
| T1 | Source change | effect 462 | router preference (kept only for the same source), customized false, connectors null |
| T2 | Seed from defaults (`applyInitialDefaults`) | 1894, from effects 2021 and 2036 | all but machine control and connectors; ends with T3 |
| T3 | Apply the launch lock (`applyLaunchLock`) | 1868, also effect 2064 | provider, model, effort and thinking on, sandbox, firewall on, side-session recap off |
| T4 | Provider switch (`handleProviderSelect`) | 2117 | provider, tier, router preference, customized false, model, thinking, effort, helper model |
| T5 | Gateway model fill | effect 2161 | model, helper model |
| T6 | Model fill when the catalog arrives | effect 2196 | model, helper model |
| T7 | Thinking choice | 4773 | thinking, effort |
| T8 | Sandbox toggle | 5006 | sandbox, firewall on, side-session recap off (read from the render's `selectedRecapMode`) |
| T9 | Router choice | 5487 | router preference, customized true |

Single-field choices: model (2275), permission mode (2501), service tier
(4722), recap mode (4846), recap delay (4878), helper model (4897),
suggestions (4927), firewall (5053), connectors (5500), machine control
(480).

**Effects.** Seven change or save option state: 462 (T1), 2021 and 2036
(T2), 2064 (T3), 2161 (T5), 2196 (T6) and 2512 (the automatic save). An
eighth, 1153-1156, copies `settings.newSessionDefaults` into
`newSessionDefaultsRef`, which the save reads as its base.

**Customization and guards.** Every user choice except machine control sets
`hasUserCustomizedDefaultsRef` before its state change. Three things read
it: the two seeding effects skip once it is set, and the automatic save
runs only once it is set. The effort choice sets it even when the selection
matches no option and nothing changes (4775). Seven choices return while
starting before they set the ref: provider (4481), permission mode (4965),
thinking (4774), recap mode (4847), suggestions (4928), sandbox (5007) and
firewall (5054). Model, tier, recap delay, helper model, router and
connectors have no such guard.

**Handler identity.** `selectMachineControl` (480) and `handleModelSelect`
(2275) are stable callbacks; the other choice handlers are rebuilt each
render. `MachineControlSessionSelection` resets the choice in an effect
keyed on its `onChange` (`MachineControlSessionSelection.tsx` 23-39), so
that handler must stay stable or the choice would reset on every render.

**Automatic save** (2512-2590). It takes the saved defaults from
`newSessionDefaultsRef`, drops the saved `sandboxLevel` and
`sandboxNetworkFirewall` and the legacy top-level `helperSideModel` and
`serviceTier`, and writes `newSessionDefaults` with:
- the provider, the raw permission mode (an unsupported Auto stays saved),
  recap mode, recap delay and suggestions;
- the sandbox level, and the firewall when sandboxed, only when the server
  supports sandboxing, so a save on a host without it erases a saved
  sandbox default;
- under the provider: the raw model, tier, thinking and effort, the
  current-source router preference (not the restored selection), the
  connectors choice only for Claude, and the helper model.

**Derived values.** Effective sandbox, firewall and local-auth warning
(656-682); the selected provider's row (532-536); provider choices
(1208-1215); router enablement, selection,
restore-pending, accounts, models and aliases (1216-1311); visible models,
catalog currency, routed model, tiers and the effective tier (1312-1370);
pool members, account and policy, connectors support and choice
(1371-1404); readiness, `hasDirectProviderModel` and
`hasSelectedProviderModel` (1405-1435); helper model options, permission,
effort and thinking options and their effective values,
`showThinkingControls` (1436-1497); machine control eligibility
(1501-1514); the legacy default seed (1515); the model options (2223-2272).

**Hooks with one caller.** `useModelSettings` and `useRouterDiscovery` keep
state per caller, so each must keep exactly one caller.
`useServerSettings`, `useProviders`, `useProviderRow`,
`useProviderDescriptors` and `useProviderSubscriptionUsage` read shared
stores, but they too keep one caller here so the hook owns them.

## Starting and queueing today

**`handleStartSession(override, speechTriggered, propagateFailure,
background)`** (2788-3347), in order:

1. Background without background support returns. Then, with no override,
   `deferSpeechDelivery` runs: it clears any pending delivery when no
   speech is pending, or records the delivery and stops the microphone and
   returns when speech is pending (2760-2786). The decision cannot be
   separated from this effect.
2. Refusals: a routed selection this launch cannot use (toast
   `routerLaunchUnsupported`); silently, no content outside a muted
   composer, a template being made, already starting, defaults pending, no
   usable provider and model, project pending, capabilities pending (throws
   `composerMemoCannotStart` when `propagateFailure`); a turn-effort command
   the server or provider cannot take (`turnEffortUnavailable`) or with no
   message (`turnEffortNeedsMessage`); an attachment-only draft for an old
   server (`attachmentOnlyRequiresServerUpdate`). The content check counts
   files from `pendingFilesRef` (2821-2823); the attachment-only refusal
   (2880), the launch attachment refusal (3031) and the trace (3025) count
   the `pendingFiles` state.
3. The text: the speech prefix, then a turn-effort command's argument with
   `direct` delivery metadata.
4. Durable or legacy (`supportsSessionCreation`) and a captured submission
   when durable; then the accepting flag, interim cleared, speech
   attribution consumed, the starting flag, and the prompt recorded in
   composer history (2916-2926).
5. The project (`resolveProjectIdForSubmission`); with none and no detached
   launch allowed, a throw ("Choose a project to start a session.") into the
   failure path. Then the session options (2954-3006) and the
   `new-session-submit` trace.
6. One of three ends: `launch.submit` (refuses attachments, then
   `clearDraft`); durable acceptance (staging local files first, owner
   checks before and after, conditional confirm and settle, then
   background recovery, newer-draft recovery or navigation); legacy
   `createLegacySession` (a missing project id throws "Missing project ID
   for new session" into the failure path; otherwise clear files and draft,
   navigate with the initial status, which carries `recapAfterSeconds`, and
   the routed model).
7. On failure: cancel the capture or restore from storage, clear the flags,
   map the error to a toast (queue full, provider authentication, 503, 404,
   network, the raw message, or `newSessionStartError` for a thrown value
   that is not an `Error`), rethrow when `propagateFailure`.

**Return values.** The audio memo path throws `composerMemoCannotStart`
when start does not return true (3864). Start returns `true` for a durable
success (3178), a legacy success (3238) and an owner lost after acceptance
(3130), and `undefined` for every refusal, for `launch.submit` (3041),
for an owner lost before acceptance (3111), and for a handled failure
without `propagateFailure` (the catch at 3239-3284 has no return).

**`handleQueueProjectSession(override)`** (3349-3529):

1. Refusals: a customized routed selection (toast
   `routerQueueUnsupported`); then silently: machine control selected and
   eligible, a template being made; then `deferSpeechDelivery` as in start;
   then silently no text, files not all staged, already starting, defaults
   pending, project pending, no direct provider model. It does not check
   capabilities or the principal; the toolbar's gating does
   (`allowProjectQueue`, `showProjectQueueAction`, 3759-3769), and the
   deferred-speech dispatch (3546) skips that gating.
2. The text with the speech prefix (never speech-triggered), a capture only
   when the draft still matches, the owner check, attribution consumed, then
   interim cleared and the accepting and starting flags (3414-3416).
3. The project; with none, a throw (`projectQueueNewSessionNeedsProject`)
   into the failure path.
4. Thinking, effort and tier resolved against the direct catalog, since
   Queue never routes; then the target (mode, model, tier, thinking,
   `showThinking`, provider, sandbox and firewall, lock overrides, title),
   the message (`deferred` metadata and composition times) and `createdFrom`.
5. Success: report the queue snapshot, the `new-session-project-queued`
   trace, confirm the capture and drop the submitted files, a success toast.
   Failure: return silently when the owner is gone; otherwise cancel the
   capture and toast `projectQueueSubmitFailed` with the raw message. The
   `finally` clears the flags only while the form is mounted. Owner checks
   after each await.

## Differences between the paths

| # | Difference | Handling |
| --- | --- | --- |
| N1 | Routing: start launches a usable routed selection and refuses an unusable one; Queue refuses only a customized routed selection and resolves a restored one against the direct catalog. | Deliberate (Queue never routes). Named. |
| N2 | Settings sent: Queue's target carries no recap mode, recap delay, suggestions, helper model, machine control or router fields; the Project Queue target type (`shared/src/project-queue.ts` 229-241) has no fields for them. Provenance does reach queue items, from request headers (`server/src/routes/project-queue.ts` 231). | Kept; a protocol limit, not in scope. Recorded as a gap (slice 6). |
| N3 | Machine control: start sends it; Queue refuses silently, and the toolbar disables Queue with `machineControlImmediateLaunchOnly`. | Deliberate. Named. |
| N4 | Turn-effort commands: start strips the command into `direct` metadata or refuses; Queue sends the command as literal text. | Decision Q1. |
| N5 | Composer history: start records the prompt; Queue does not. | Decision Q2. |
| N6 | Failure toast: start maps errors to friendly messages; Queue shows the raw message inside `projectQueueSubmitFailed`. | Kept: the mapping's provider and 404 branches describe a launch, which Queue does not perform. |
| N7 | Content: start accepts attachment-only and muted-composer starts; Queue needs text and staged files. | Kept; Queue's message needs text and staged refs. |
| N8 | Owner checks: Queue checks the form's owner after every await and clears its flags in a `finally`; start checks only on the durable path, and an owner lost before acceptance leaves its flags set. | Kept here; the stuck flags are a follow-up (see Not in scope). |
| N9 | The template form's `sessionSettings` (5361-5382) are a third copy: raw thinking and effort (unresolved under a restored pool) beside the direct model; no tier, machine control or lock overrides; the sandbox level sent even without server sandboxing, and the firewall even when the level is `none`. | Decision Q3. |
| N10 | Readiness: start refuses while capabilities are pending and needs the principal for durable creation; Queue's body checks neither and relies on the toolbar's gating, which the deferred-speech dispatch skips. | Named; the deferred dispatch only follows a Queue press the gating allowed. |

Behaviors to keep that are not differences: the speech prefix rule (both
paths call `prependSpeechMessagePrefix`, which trims; an attachment-only
start with a prefix sends the prefix as its text); the trace fields,
including start's trace logging the selected rather than routed model;
`showThinking` read from local settings at the press.

## Decisions for the maintainer

Each recommendation is the simpler, unified behavior; slice 6 lands the
ones agreed.

- **Q1 (N4).** Recommended: Queue handles a turn-effort command as the
  session composer's Project Queue already does
  (`lib/sessionComposerSendDecisions.ts` 631-632): strip the command and
  send `{ deliveryIntent: "deferred", turnEffort }`, refusing with start's
  toasts when the server or provider cannot take it or there is no message.
  The server already carries this: the queue stores message metadata as
  sent (`server/src/services/ProjectQueueService.ts` 447), the scheduler
  passes it to the first turn (`ProjectQueueScheduler.ts` 1311-1327) and
  `turnEffort` reaches the provider message (`sdk/messageQueue.ts`
  425-441). Today `/fast …` is queued as prompt text
  (`shared/src/queued-ya-commands.ts` 132). The queued item shows the text
  without the command, as the session composer's does.
- **Q2 (N5).** Recommended: Queue records the prompt in New Session's
  composer history (`rememberComposerPrompt`), as start and the template
  form do, so a queued prompt can be recalled like a started one.
- **Q3 (N9).** Recommended: the template's settings share Queue's
  direct-catalog resolution of thinking, effort and tier (template creation
  does not route, per the router topic) and start's sandbox field rule, and
  add the tier and lock overrides. Machine control stays out, as for Queue:
  [optional computer control](../../topics/optional-computer-control.md)
  (77-87) gives `machineControl` only to immediate explicit launches. The template route accepts these fields
  (`server/src/projects/TemplateCreationService.ts` 52 forwards the
  session record to `/session-creations`).

## Target shape

New `lib/newSessionOptionsState.ts`: no React, no I/O.

- `NewSessionOptionsState`, the sixteen fields under today's names, so the
  form destructures them and its reads stay as they are.
- `newSessionOptionsReducer(state, action)`, one action per transition T1-T9
  and one `choose` action for the single-field choices. Each multi-field
  transition is also a plain function (`seedNewSessionOptions`,
  `lockNewSessionOptions`, `switchNewSessionProvider`,
  `fillNewSessionModel`, `chooseNewSessionThinking`,
  `toggleNewSessionSandbox`), so T2 and T4's catalog and defaults lookups
  happen before the dispatch and the reducer stays pure. T8 reads the
  recap mode from the reducer's current state rather than the render's,
  which is the same value because nothing else changes it between the
  render and the click.
- Rules, each unit-tested: an action that changes nothing returns the
  previous state object, so React skips the children and effects (T1 on
  mount, T3 when the lock is re-applied, T2 while providers settle);
  unlike an equal `useState` write, the dispatch still re-runs the form
  once, so `applyLaunchLock` keeps its early return for a principal who is
  not limited;
  every memo and effect depends on individual fields, never the state
  object; one dispatch per transition matches today's batching of the
  setter calls inside one event or effect.
- `newSessionDefaultsToSave(saved, state, context)`: the automatic save's
  body, with a case for each point listed under "Automatic save".
- Customization stays a ref, set before each user dispatch exactly where it
  is set today, after the same `isStarting` guards (including the unmatched
  effort choice), because the seeding effects and the save read it at
  commit time; making it state would add a render and change when the
  seeding effects stop.

New `hooks/useNewSessionOptions.ts`: owns `useReducer`, the five store
reads and `useRouterDiscovery`, every derived value listed above except
the model options, the eight effects in today's order, and the router
catalog refresh. It takes the source key, `launch` presence, `launchLock`,
the four preferred-option props, version info and `versionLoading`,
`isStarting`, `t`, and the legacy thinking and effort from the form's
single `useModelSettings` call. It returns the state, the derived values
(including `selectedProviderInfo`, which the form's attachment, start,
Queue and template code read; `aggregateProviderInfo` stays inside), the choice handlers (each guarding
on `isStarting` and setting the customization ref as today, then
dispatching; the guarded ones are rebuilt each render as now, and the
machine-control and model handlers, which have no guard, stay stable),
`providers`, `providersLoading`, `providersStale`,
`refetchProviders`, `selectedProviderQuery`, `routerDiscovery`,
`routerCatalogRefresh`, `refreshRouterCatalog`, `subscriptionUsage`,
`routerModelList` and the settings fields the form uses
(`displayDefaultsPending`, `settingsError`, `settingsLoading`,
`refetchSettings`).

The form calls the hook where `launchLock` and the version are known
(about line 656), so every read in it starts there. Moving the effects
there runs them before the form's effects declared after the hook (the
`creationViewOwner` effect at 435 still runs first). That is safe: none of
the form's effects that would now run after them (807, 936, 940, 1126,
1611, 1763, 2089, 2429) or its layout effects (716, 2070, 2390, 2394)
reads option state. What does change is request order: `useProviders` and
`useProviderRow` (526-531) now start after the hooks between 537 and 656,
and `useProviderDescriptors`, `useServerSettings`, `useRouterDiscovery`
and `useProviderSubscriptionUsage` (1138-1271) start before
`useBrowserXaiSttApiKey` and the form's effects from 716 on.

New `components/NewSessionOptionsPanel.tsx`: the provider slot, the
advanced-options toggle and summary, and the secondary options, which are
three adjacent elements at the end of the full form (5400-5522), returned
as a fragment so the grid layout is unchanged (the compact branch renders
none of them, and no caller passes `compact`). It owns `sessionDefaultCopy`
(395), the label maps (1159-1206), the recap and suggestion mode lists and
`showHelperSideModel` (1524-1526), `modelOptions` with
`ROUTER_MODEL_UNAVAILABLE` (282), the section builders, `optionPlaceholder`, the catalog notice, the captions
toggle and the advanced-options state with its `localStorage` key. It takes
the hook's result, `isStarting`, `isProjectChooserExpanded`,
`showProviderPicker` and `showModelPicker` (703-706, which stay in the
form), the fixed-launch values and `showThinking`/`setShowThinking`. The
form keeps `providerSlotFilled` (5101-5106) for its layout class. That
expression reads the section elements, so slice 3 rewrites it, as a
declared hunk, over the values those elements depend on:
`launchLock.limited || showProviderPicker || showModelPicker ||
showThinkingControls || !launchLock.effort`. The provider and model
sections always render (each falls back to a placeholder, 4513-4520 and
4555-4566), and the effort slot renders when `showThinkingControls` or
`!launchLock.effort` (4732, 4815-4823).

New `lib/newSessionStartDecisions.ts`: no React, no I/O.

- `planNewSessionStart(input)`, run after `deferSpeechDelivery`, returns
  `refuse { toastKey }`, `silent { throwCannotStart }` or
  `proceed { text, metadata }`, in today's refusal order. Its input keeps
  both file counts (the ref's and the state's).
- `buildNewSessionStartOptions(input)`: the session options object, lock
  overrides last.
- `planNewSessionProjectQueue(input)`, split around `deferSpeechDelivery`
  as start is, and `buildProjectQueueNewSessionTarget(input)`: Queue's
  refusals and its direct-catalog target.
- `newSessionStartErrorMessage(error, provider, displayName, t)`: the
  failure toast, including the non-`Error` case.

New `lib/newSessionStart.ts`: `startNewSession(deps, override,
speechTriggered, propagateFailure, background)` and
`queueNewSessionForProject(deps, override)`, plain async functions that run
the effects in today's order and keep today's return values. They call
`deferSpeechDelivery` from the deps at today's point. The form keeps
`handleStartSession` as a `useCallback` with today's dependency list whose
body builds the deps object and calls `startNewSession`, and keeps
`handleQueueProjectSession` as a plain arrow calling
`queueNewSessionForProject`.

Types the new modules need from the form move first, so no module imports
`NewSessionForm.tsx` (the boundary topic forbids it): the `launch` prop's
inline type (338-365) becomes the exported `NewSessionLaunch` in
`lib/newSessionStart.ts`, with the prop's shape unchanged;
`PendingNewSessionSpeechDeliveryIntent` (288) moves there too; and
`ROUTER_MODEL_UNAVAILABLE` moves into the panel.

## Slices

0. **Pins.** Unit tests in `NewSessionForm.test.tsx`, which renders the
   real form, for the branches nothing tests at `66ebf019a`:
   - the seven failure toasts, including a thrown non-`Error`;
   - "Choose a project to start a session." and "Missing project ID for new
     session";
   - `routerLaunchUnsupported`, and `routerQueueUnsupported` for a
     customized pool;
   - both turn-effort refusals and the attachment-only refusal;
   - the audio memo's start (through a mocked `AudioMemoPanel`): a refusal
     throws `composerMemoCannotStart`, a legacy success resolves;
   - the launch attachment refusal;
   - the routed model in the legacy navigation state;
   - Queue: the failure toast with the raw reason, the machine-control
     gating, and the target under a restored pool (direct thinking, effort
     and tier);
   - composer history recorded on start and not on Queue;
   - T1 (a source change clears a chosen pool), T3 re-applied when a
     limited principal arrives after the seed, and the saved body after T8
     and on a host without sandboxing.
   A browser spec, `new-session-option-paths.spec.ts`, pins over the real
   form and real settings: the saved defaults after a provider switch (T4)
   and the durable start's request body with the options off their
   defaults. Sandbox support reaches that page over the socket, so T8 stays
   with the unit tests. Test-only.
1. **The reducer.** `lib/newSessionOptionsState.ts` with unit tests per
   transition (T1-T9, including T2's lock-last and side-session rules, the
   unmatched effort choice and the no-op identity) and for
   `newSessionDefaultsToSave`. The form replaces its sixteen `useState`
   calls with one `useReducer` in place, destructures the state under the
   same names, dispatches where it set state, and builds the save body
   with `newSessionDefaultsToSave`; nothing moves out of the form yet.
2. **The options hook.** The reducer, store reads, derived values and
   effects move into `useNewSessionOptions`, called at about line 656.
   Not move-only (hook and effect order change, as above); otherwise the
   moved code is verbatim apart from parameters and returned fields,
   reviewed with `git diff --color-moved`.
3. **The options panel.** The markup moves into `NewSessionOptionsPanel`.
   Move-only apart from props and the `providerSlotFilled` hunk;
   `pnpm i18n:scan` for the moved copy.
4. **Start and Queue decisions.** The four decision functions with unit
   tests per branch and per N1, N3 and N10 (the N3 test is also the pin
   for Queue's own machine-control check, which only a deferred speech
   delivery reaches past the toolbar's gating); the form's two functions call
   them and keep their effects, including `deferSpeechDelivery`, in place.
5. **The start module.** The launch and intent types move, then the two
   bodies move into `lib/newSessionStart.ts`. Move-only apart from turning
   closure reads into a deps object; `pnpm console:scan` for the moved
   `console.error` calls.
6. **Settle.** The agreed decisions, one commit each with a test, and a gap
   for N2.

## Checks

- Unit: the reducer and transitions, the save body, and the decision
  functions, one case per branch. `NewSessionForm.test.tsx` (122 tests at
  `66ebf019a`, plus slice 0's) passes unchanged at every slice.
- Browser, per slice: slice 0's spec and the existing New Session specs
  (`new-session-defaults`, `session-defaults-layout`,
  `limited-browser-defaults`, `router-pools`, `durable-session-creation`,
  `session-creation-client`, `session-creation-attachments`,
  `session-creation-recovery`, `new-session-draft-windows`,
  `project-queue-new-session-options`, `new-session-project-queue`,
  `new-session-new-project`, `new-session-preboot-composer`,
  `project-template-creation`).
- Typing: the option state is read on every keystroke's render, and the
  panel re-renders with the form as the inline sections do today. The
  keystroke checks in `session-creation-client.spec.ts`,
  `durable-session-creation.spec.ts` (200 saved sessions),
  `new-session-defaults.spec.ts` (typing during discovery) and
  `speech-caret-insertion.spec.ts` run per slice.
- Budgets: `NewSessionForm.tsx` ratchets down each slice; new modules stay
  under 1,500 lines.
- Tier 2 and Tier 3 per slice; Opus 5.5 review of this plan and of each
  slice.

## Not in scope

- Carrying recap, suggestions and helper settings through Project Queue
  (N2), which needs the target type and scheduler to take them.
- The draft-clear gap's three callers.
- Start leaving its flags set when the form's source or account changes
  before durable acceptance (N8), which would leave the form showing
  "starting" until it remounts; slice 6 records it as a gap.
- Saving defaults in the choice's event instead of an effect
  ([React state patterns](../../topics/react-state-patterns.md) prefers the
  event); the effect moves as it is.
- The project chooser, attachments and dictation code in the form.
