# Codex session lifecycle split

Topic: typescript-module-boundary-refactor

Status: approved 2026-11-09; in progress. Plans row 4.9 of
[058](058-typescript-module-boundary-refactor.md). Progress is recorded in the
Slices section.

## Goal

Make the live Codex session an explicit object instead of the closure bag
that `CodexProvider.startSessionInternal` builds, and split `runSession`
into its three jobs: connect, consume one turn, run the message loop. The
aim is that the code people change most often (goals, steering, compaction,
stale-turn rejection, overload and cyber-access retry, liveness) lives in
small files with named state, so each change touches one place and its
test can reach it.

Non-goals:

- No new event vocabulary. The session still yields `SDKMessage` and still
  returns the existing `AgentSession`. The provider-owner and hosted-runtime
  seam stays where it is (see
  [t3code comparison](../competitive/t3code-provider-architecture.md)).
- No behaviour change, and no fixes to known defects folded in. Defects
  found along the way go to `gaps/`, as in slice 4.4.
- No change to the Codex wire protocol, settings or UI.

## Where the churn is

This is a `git blame -w -M -C` of `codex.ts` at `1df4e2ea4` (4,321 lines).
It counts lines whose last change is on or after 2026-08-01. 106 commits
have touched the file since then.

| Region | Lines | Size | Changed since Aug | Commits |
|---|---|---|---|---|
| Module helpers (turn-error classification, notification ids, overload wait) | 1–578 | 578 | 71% | 53 |
| Provider: install, auth, models | 579–1177 | 599 | 43% | 22 |
| `startSessionInternal` closure bag | 1178–2056 | 879 | **81%** | 37 |
| Fork, liveness probe | 2057–2285 | 229 | 29% | 8 |
| `runSession` setup | 2286–2470 | 185 | 32% | 15 |
| `runSession` `consumeTurn` | 2471–2858 | 388 | **86%** | 21 |
| `runSession` overload retry and message loop | 2859–3294 | 436 | **72%** | 22 |
| Turn helpers (suppress, terminal, classify, background tools) | 3295–3539 | 245 | 33% | 6 |
| Config-dependent param builders, cyber access | 3540–3854 | 315 | 54% | 20 |
| Recap and fork-summary helper threads | 3855–4207 | 353 | 11% | 3 |
| Config ack, message text helpers | 4208–4321 | 114 | 0% | 1 |

The two regions named in row 4.9 are the hot ones. The recap helpers are
almost untouched, so moving them is a matter of tidiness, not a
churn reduction.

## Current shape

`startSession` (`codex.ts:1181`) wraps `startSessionInternal`
(`codex.ts:1187`). That function:

- validates native resume, steering version and the model catalog
  (1190–1231);
- takes an installation lease and builds the per-session state in locals:
  - `queue`, `abortController`;
  - `runtimeState: CodexTurnRuntimeState` (`codex.ts:378`, 21 fields);
  - `activeClient`, `providerWork`, `goalCommandTail`;
  - an `initialActiveClient` latch, so commands sent before connect wait
    for the client;
  - `agentctlSessionEnvBridge` and `skillInventory`;
- calls `this.runSession(...)` with seven positional arguments. Two of them
  are setter callbacks that write `activeClient` and the bridge back into
  the closure;
- returns an `AgentSession` literal of about 700 lines. It covers:
  - `abort`, `isProcessAlive`, `pid` (a getter), `probeLiveness`;
  - `setEffort`, `setModel`, `setServiceTier`, `setSessionOptions`;
  - `supportedModels`, `supportedCommands`, `appendConversationContext`;
  - `mcpAppRequest` (present only when MCP App views were on at start);
  - `steer` and `interrupt` (each with a one-shot turn-id mismatch resync);
  - `runProviderCommand`: `/goal` (serialised through `goalCommandTail`),
    `/status`, `/usage` and `/compact` (with the start-window guard).

`runSession` (`codex.ts:2289`) is one async generator with closures inside:

- **Setup (2300–2470):**
  - env and agentctl bridge, steering args, app-server spawn;
  - approval handler, initialize, skills;
  - thread start or resume, then yields `init` and the config ack.
- **Notification reader (2535–2548):** `peekNotification`/`readNotification`
  share one prefetched promise between the idle wait and the turn consumer.
- **`consumeTurn` (2549–2858):** a nested `async function*` that takes
  `provider` because generator functions do not bind `this`. It owns:
  - stale-turn rejection (receipt barrier, plus suppressed-notification
    summary logging);
  - subagent thread filtering and goal/skill command observation;
  - token usage, background tools and the failure trace;
  - turn-id resync, retryable-error capture, cyber-access interrupt;
  - terminal detection and the fallback error and `result`.
- **`prepareOverloadRetry` (2860–2909):** the backoff wait, interruptible
  through `runtimeState.overloadRetryController`.
- **Message loop (2911–3259):**
  - races queued input against unsolicited notifications, including
    `turn/started` from a compaction, with a compaction overload retry;
  - assembles the prompt (agent API and global context on the first
    message, skills);
  - resolves permission and cyber access, builds turn params;
  - applies a per-message `turnEffort` and restores it afterwards;
  - flushes MCP model context, sets the `pendingTurnStart` latch, calls
    `turn/start`;
  - retries cyber-access and overload failures without resending input.
- **Teardown (3260–3293):** reports a process-exit error, closes the client,
  cleans up the bridge, yields `result`.

`CodexProvider` members that the session reaches through `this`:

- process and environment: `resolveCodexCommand`, `getCodexEnv`,
  `initializeAppServer`, `refreshCodexSkills`;
- models: `getAvailableModels`, `getInstalledCodexCliVersion`,
  `mapEffortToReasoningEffort` (reads `modelCache`);
- settings getters:
  - read once at start: steering mode, MCP App views;
  - read at thread start: reasoning summary, plan tool mode, subagent depth;
  - read every turn: cyber access program;
- provider-wide state: `cyberAccessDenials`, which is shared across
  sessions on purpose, and `config.overloadRetryWait`, a test hook;
- the installation lease, taken from `installationCoordinator` at start.

The session depends on the provider for these few things. Today that
dependency is implicit in `this`.

## Target shape

| File | Owns | Approx. lines |
|---|---|---|
| `codex-provider-host.ts` | `CodexProviderHost` interface: the provider services listed above, as late-bound functions | 60 |
| `codex-helper-threads.ts` | `generateSideSessionRecap`, `generateForkBackedSummary`, `handleRecap/Fork/NonTurnServerRequest` | 350 |
| `codex-session-config.ts` | `mapEffortToReasoningEffort`, `buildThreadConfigOverrides`, `createThreadStart/Resume/ForkParams`, `createTurnStartParams` | 280 |
| `codex-session.ts` | `class CodexSession`: state, the client latch, controls, `toAgentSession()`, `run()` (setup and message loop) | ~1,100 |
| `codex-session-commands.ts` | `/goal`, `/status`, `/usage`, `/compact` against a session | 330 |
| `codex-turn-consumer.ts` | the shared notification reader, `consumeTurn`, overload retry, turn-error and notification-id helpers | ~750 |
| `codex.ts` | install, auth, models, fork, `startSession` (builds a `CodexSession`) | ~1,500 |

`CodexSession` follows the existing per-concern classes
(`CodexAppServerClient`, `CodexProviderWorkTracker`, `ClaudeGoalTracker`,
`ClaudeTurnEffort`): private fields, methods for the controls, no
inheritance. `toAgentSession()` returns the same literal as today, with the
same members, the same conditional `mcpAppRequest` spread and the `pid`
getter. Callers that test for a member's presence see no difference.

`CodexProviderHost` is passed in, never imported. It is built in the
provider as arrow functions that call `this.x()` at call time. A
`vi.spyOn(provider, "x")` applied after construction then still takes
effect, which `codex-dynamic-results.test.ts` relies on. Settings are
passed as getters, not snapshots, so each keeps its current freshness
(start, thread start, every turn). `cyberAccessDenials` is passed by
reference.

## Slices

Each slice lands and is reviewed on its own, in the same flow as 4.4–4.10:
a reviewer commits it, the ledger row is updated, a landing note is added,
budgets are recorded. Slices 0–2 are nearly move-only. Slices 3–5 change
how state is shared, so each one states the invariants it holds and the
reviewer checks them against the list below.

### 0. Tripwires first (tests only)

Landed 2026-11-09 as 058 slice 4.9.0. Two of the four items below were
already covered; the other two are new tests. Writing them found a
pre-initialize command window, fixed in its own commit after slice 3 (see
058's "Codex requests wait for the ready thread" note).

The coverage the later slices need:

- `/compact` sent during the `turn/start` round trip is refused. This
  closed the former `codex-compact-start-window-untested` gap.
- Two concurrent `/goal <objective>` calls are serialised (already
  covered). A `/goal` sent before connect was not pinned: against real
  Codex it failed, and the fix after slice 3 now pins it.
- The `AgentSession` surface is pinned: which optional members exist with
  MCP App views on and off, `effortUpdatesActiveTurn`, and `pid` read after
  connect. One table-style test.
- `interrupt` during an overload backoff ends the wait and returns `true`
  (already covered).

### 1. Provider host interface and helper threads

Landed 2026-11-09 as 058 slice 4.9.1. `codex.ts` went from 4,321 to
3,982 lines.

- Add `codex-provider-host.ts`.
- Move the recap and fork-summary helper threads into
  `codex-helper-threads.ts`. They take the host as their only new
  parameter, since they only need command, env, initialize and models.
- No test references these privates. The `generateSummary` tests go
  through the provider and are unchanged.
- `codex.ts`: about −340 lines.

### 2. Config-dependent builders

Landed 2026-11-09 as 058 slice 4.9.2. `codex.ts` went from 3,982 to
3,740 lines. The wiring test also gained the Codex subagent-depth check
that the rewritten provider tests used to give.

- Move `mapEffortToReasoningEffort` and the five builders into
  `codex-session-config.ts`. They take a `CodexConfigSource`:
  `{ reasoningSummary(), planToolMode(), subagentMaxDepth(), cachedModels() }`.
- The provider keeps one `CodexConfigSource` built from its getters.
- About 70 test references currently call these through a provider whose
  getters the test set. They change to call the module with a literal
  config source. One remaining test proves that the provider setters reach
  the source (see the decisions).
- `codex.ts`: about −260 lines.

### 3. Session object for the controls

Landed 2026-11-09 as 058 slice 4.9.3. `codex.ts` went from 3,740 to
2,710 lines. Two departures from the text below: `runSession` kept its
seven arguments until slice 5, so its one direct test is rewritten once;
and the state that the session loop, the session and the commands share
went to a small `codex-session-state.ts`.

- Add `CodexSession`. The closure locals in 1232–1328 become fields.
- Each `AgentSession` control becomes a method, and the four provider
  commands go to `codex-session-commands.ts`.
- `probeCodexLiveness` and its two formatters move onto the session.
- `runSession` stays on the provider for now. It receives the session in
  place of its four state arguments and two setter callbacks.
- No test calls `startSessionInternal`. The 53 `startSession` call sites
  run against the fake app-server fixture and should pass unchanged. That
  is the tripwire.
- `codex.ts`: about −900 lines.

### 4. Turn consumer

Landed 2026-11-09 as 058 slice 4.9.4. `codex.ts` went from 2,696 to
2,038 lines. The context also carries `appServer`, `sessionId`,
`logRawNotification` and `overloadRetryWait`, which the closures read,
and the reader is a small class.

- Move into `codex-turn-consumer.ts`:
  - the shared notification reader;
  - `consumeTurn` and `prepareOverloadRetry`;
  - the module helpers for turn errors and notification ids (412–552);
  - the overload delay functions (249–298);
  - the turn helpers (`shouldSuppressLiveDeltaNotification`,
    `isTurnTerminalNotification`, `classifyRetryableTurnError`,
    `updateBackgroundProcessTracking`, `logRawCodexNotification`).
- The consumer gets an explicit context instead of closed-over variables:
  `{ reader, runtimeState, failureTrace, usageByTurnId, liveEventState,
  observeCommands, options, signal }`.
- The reader keeps its single prefetched promise. The idle wait and the
  consumer must share it, or a notification is lost between turns.
- Seven test references move to a namespace cast.
- `codex.ts`: about −900 lines.

### 5. Setup and message loop on the session

- `runSession` becomes `CodexSession.run()`, in three steps: `connect()`
  (setup, yielding `init` and the ack), the message loop, and teardown.
- Turn start goes with it: prompt assembly, permission, cyber access,
  `turnEffort`, the `pendingTurnStart` latch, and the retry loop.
- Also moving: `resolveTurnCyberAccess`, `readCyberAccessAccountKey`,
  `flushMcpAppModelContext`, `createSessionConfigAckMessage` with
  `describeAcknowledgedSessionReasoningEffort`, `getPermissionModeFromMessage`,
  `extractTextFromMessage`, and `startOrResumeThread`, which reads no
  provider state.
- If `codex-session.ts` would pass 1,500 lines, turn start goes to its own
  `codex-turn-start.ts`.
- The one test that calls `provider.runSession` directly
  (`codex-dynamic-results.test.ts:41`) is rewritten to build a
  `CodexSession`.
- `codex.ts`: about −450 lines. It should end near 1,500.

## Invariants every slice holds

- **`AgentSession` surface:** members, presence conditions and getter
  semantics are identical (slice 0 pins them).
- **Abort order:**
  1. settle the client latch;
  2. interrupt the active turn, with a 750 ms cap;
  3. abort the controller;
  4. close the client;
  5. release the lease.

  The iterator's `finally` also releases the lease. Both calls stay.
- **Generator order:**
  - `init` is yielded before the config ack;
  - teardown closes the client, then cleans up the bridge, then yields the
    final `result`;
  - a process error is reported only when the session was not aborted.
- **Stale-turn rejection:**
  - the receipt barrier is taken before every `turn/start`, retries
    included;
  - token-usage replay is never adopted as a turn id;
  - subagent thread notifications never reach the parent's state.
- **One prefetched notification** is shared between the idle wait and the
  consumer, and a failed `turn/start` swallows the prefetch rejection.
- **Turn-start window:**
  - `pendingTurnStart` is set before `turn/start` is sent, settles with the
    turn id (or `null` on failure), and is cleared only by the turn that
    set it;
  - mid-turn model and effort updates await it; `/compact` refuses while it
    is set (slice 0 pins this).
- **Controls:**
  - `/goal` calls run one at a time through the goal command tail;
  - `steer` and `interrupt` resync the turn id and retry at most once
    after a turn-id mismatch;
  - when a new client is published, the previous client's notification
    observer is detached and provider work is reset before the new
    observer attaches.
- **Late binding:** the host and the config source call the provider at
  call time (`() => this.x()`), never a captured method or getter. The
  settings setters replace the getter fields after construction, and tests
  spy on provider methods after construction.
- **Retries:**
  - overload retries never resend input;
  - `interrupt` during a backoff aborts it;
  - compaction overload retry re-issues `thread/compact/start`;
  - a cyber-access denial is recorded provider-wide and the turn reruns
    without the program.
- **Setting freshness:**
  - read once at start: steering mode, MCP App views;
  - read at thread start: reasoning summary, plan tool mode, subagent
    depth;
  - read every turn: cyber access program;
  - read at use: the model cache.
- **Hosted ownership and reload:** `codex.ts` has no reload code of its
  own. Surviving a server reload depends on `provider-runtime-host` and
  `provider-session-owner` wrapping an unchanged `AgentSession`, so the
  surface invariant above covers it.

## Verification per slice

- **Tier 1:**
  - server `tsc` (both configs);
  - no new `tsconfig.test.json` errors in touched files;
  - biome;
  - `git diff --check`.
- **Focused Codex set:** the 4.10 command plus
  `test/provider-runtime-settings.test.ts`, `test/api/codex-compact.test.ts`,
  `test/routes/mcp-apps.test.ts` and `test/process.runtime-status.test.ts`.
- **Repo-wide:** `pnpm lint`, `pnpm format:check`, `pnpm typecheck`.
- **Real Codex (slices 2–5):**
  - `pnpm test:providers`, with the pinned Codex binary, the local model
    server and 11 Codex cases;
  - `pnpm test:e2e:sdk`.

  Slice 2 needs these because its params go on the wire.

## Risks

- **Turn-start races.** `pendingTurnStart`, the receipt barrier and the
  shared prefetch were each added after a race was observed under load.
  Moving them between files is where a lost notification or a stale id
  would appear. Slice 4 moves the reader and the consumer together for
  that reason.
- **`this` in generators.** `consumeTurn` takes `provider` explicitly
  today. As a class method or a context-taking function it must not
  silently capture a different `this`.
- **Fake-process test flakiness**
  ([gap](../../gaps/codex-provider-unit-startup-timeouts.md)). A timeout
  during these slices must be checked against that gap's timeline output
  before it is blamed on the refactor.
- **Concurrent edits.** The hot regions change often. Each slice should
  land within a day to keep rebase pain small.

## Decisions

Settled with the maintainer on 2026-11-09:

1. **Config builder tests (slice 2).** The ~70 references call the module
   with a literal config source. One test proves the provider's setters
   reach that source.
2. **Order.** Slices land in order 0 to 5. Slices 1 and 2 go first because
   they set up the host interface.
3. **Slice 0** is tests only and closes the compact-start-window gap.
4. **End size.** About 1,500 lines for `codex.ts` is the target. Moving
   install, auth and models out is not part of this plan.
