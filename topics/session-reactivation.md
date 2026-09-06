# Session Reactivation (message-less resume)

> Reactivation is a server primitive that spawns a live harness process
> for an existing session id **without delivering a user turn**, flipping the
> session back to owned/`self` and idle so the client can read live process
> state (model options, config) before any message is sent.

Topic: session-reactivation

Status: **implemented** (2026-06-17, after the kzahel merge; lifecycle corrected
2026-07-31; durable settings restored 2026-08-03). The message-less spawn
primitive already existed in the
supervisor; this work exposed it as a public `Supervisor.reactivateSession`, a
`POST …/reactivate` route, and a client Activate button. See *As built* below.

Naming: the model panel's button label is **"Activate"** because it makes an
inactive process available for configuration. Older clients labeled the now-
retired sidebar shortcut **"Resume"** because its user intent was to continue
an interrupted session. Both called the server **reactivate** primitive. Avoid
"reattach" — there is no live process to attach to; reactivation spawns a
*fresh* harness process bound to the session id and replays its history.
"Revive" is an acceptable synonym. Candidate glossary row.
<!-- unconfirmed: 2026-06-16 -->

## Motivation

A YA-launched session whose harness process was reaped reports as not-owned
(ownership is purely "is there a live process right now":
`getProcessForSession` → `self`, else `external`/`none`,
`routes/sessions.ts:1965-1980`). On such a session the model panel can only
show **"No active process"**, because the full model options come from
`getProcessModels(processId)` — a *process*-level call (`client.ts:865`); there
is no provider-level model list. So today the only way to make a reaped session
configurable again is to **send a turn**, which is the wrong gesture when the
user just wants to change the model.

We want a button that brings the process live with no turn, then reveals the
full options once the process exists. The UI it plugs into is the unified model
panel in `ModelSwitchModal` (Model/Info tabs).

## What already existed (the plan overstated the server work)

The message-less spawn primitive was **already present**, just not exposed for
resume:

- `Supervisor.createSession` spawns a process that idles on the queue with **no
  initial message** (the two-phase "create then send" flow), and the private
  `createProviderSession`/`createRealSession` it calls already accept a
  `resumeSessionId` and start with no message
  (`Supervisor.ts:1313-1337, 727-748`), registering it as owned
  (`registerProcess(process, !resumeSessionId)`). So it is **provider-agnostic** —
  Claude and Codex reactivate with no synthetic turn; no empty-turn fallback was
  needed.
- What was missing was only a **public** entry point combining the two (resume
  an existing session id, no message) and a route. `POST …/resume` mandates a
  message (`routes/sessions.ts:2890`), but that requirement lives in the route,
  not the supervisor.
- Still true: **no provider-level model list** — only
  `getProcessModels(processId)` — so a live process is genuinely required to show
  options; reactivate is the right primitive, not a client-only shortcut.

## As built

- **`Supervisor.reactivateSession(projectPath, resumeSessionId, mode?, settings?)`**
  — serializes activation and configuration by session id. A request that joins
  an existing or in-flight process reconciles its explicit overrides after
  earlier requests; live-supported changes apply in place, while a launch-only
  change returns conflict during an active turn. A cold request preempts an idle
  worker at capacity, else throws, then calls
  `createProviderSession`/`createRealSession` with the `resumeSessionId` and no
  message.
- **Activation/configuration ownership:** `SessionActivationCoordinator` owns
  each session's activation promise, ordered configuration tail, pending durable
  launch snapshot, cold-setting recovery, and live-versus-restart decision.
  `Supervisor` supplies capacity and provider launch/restart operations and
  receives the single settled `Process` result; launch, queue, recap, heartbeat,
  and provider-event concerns no longer mutate the coordinator's transition
  state directly.
- **Message-less lifecycle:** both create-only factories construct the process
  as idle before the provider emits anything. Passive provider initialization
  does not wake it; the first accepted user/provider-work message transitions
  it to `in-turn`. The normal idle-reaping timer starts immediately, subject to
  the same explicit retention rules as every other idle process.
- **Recovered patient queue:** restoring a patient entry onto a message-less
  reactivation observes `verified-idle`, waits the entry's patience window, and
  then promotes it. It cannot be blocked forever by a synthetic `in-turn`
  state when no provider turn was actually submitted.
- **`POST /api/projects/:projectId/sessions/:sessionId/reactivate`** — validates
  the complete optional body before project or process lookup, then separates
  exact request overrides from cold-launch fallbacks. Explicit mode, model,
  service tier, thinking, provider, executor, permission rules, recap, prompt suggestion, and sandbox fields reconcile even when a process already exists;
  explicit empty helper settings reset to their normal process defaults. The
  browser-only **Show thinking** preference remains outside process launch
  state. The route returns the process identity and mode; the established
  process-info request/stream supplies authoritative live configuration without
  adding a new wire dependency. Provider selection follows explicit request,
  durable session metadata, then exact native reader evidence. If none identifies
  the existing session, activation returns `404` without starting the project's
  default provider.
- **Client:** `api.reactivateSession`; `ModelSwitchModal`'s "No active process"
  note becomes an Activate button (`onActivate`); `SessionPage` calls reactivate
  and flips `status` to `{ owner: "self", processId }`, after which the existing
  `processId`-keyed effect loads models and the full options replace the note.
- **Sidebar recovery retired:** current clients keep session rows as navigation
  and status surfaces; they never issue message-less reactivation from the
  sidebar. Explicit activation remains in the full session's model panel, and
  sending a message still resumes an unowned session with that turn. Servers
  continue advertising the permanent `sidebar-session-resume` capability and
  its manual-termination field so older clients remain compatible.
- **Durable settings:** `SessionMetadata.effectiveLaunchSettings` is a complete,
  versioned snapshot of the last successfully applied process launch policy.
  Resolution is explicit request, complete durable snapshot, pre-snapshot YA
  requested-model metadata and provider evidence, then conservative
  server/provider defaults. For Codex, the first cold launch of a session with
  no snapshot recovers its latest rollout model, unambiguous approval/sandbox
  pair, and supported reasoning effort. Ask/Accept-Edits ambiguity resolves to
  Ask and incomplete evidence never grants Bypass. Recovery itself is
  read-only; the settings used by a successful launch become authoritative and
  are saved through the normal snapshot boundary, while a failed launch writes
  nothing. Configuration success waits for provider application and for the
  coalesced metadata writer to flush the snapshot containing that state.
  Explicit provider, executor, recap, prompt suggestion, and sandbox metadata
  uses the same per-session transaction and receives a final durability flush
  before the response. A failed write leaves the live state in place and
  pending for retry; it is not reported as rolled back or successful. Identical
  reattach snapshots do not advance the session-local revision, but do retry a
  prior failed write.
- Coverage: `supervisor.test.ts` asserts message-less resume, immediate idle
  liveness, ownership, idempotency, first-message wake, ordinary idle reaping,
  and recovered patient-message promotion.

## Restart provider

The full session's options menu offers **Restart provider** beside Terminate
when YA owns a process and the server supports `sidebar-session-resume`.
It stops current provider work, waits for verified termination, then reactivates
the same saved session without a user message or launch-setting overrides.
The page reloads after activation so provider transcript reads include turns
saved by a separately resumed TUI. The composer draft is flushed before the
operation and survives the reload. The session id and saved launch policy stay
the same; this action neither forks nor creates a handoff.

Failure to verify termination prevents reactivation and shows the error. A
reactivation failure leaves the session stopped and shows the error; it does
not silently restart another session. Restart does not set Terminate's durable
auto-resume exemption. Existing stop behavior pauses recap automation until a
subsequent user turn. Provider goal state is preserved, so an active native goal
may autonomously continue after the provider resumes.

Restart controls only the YA-owned process. A separate TUI process is neither
stopped nor continuously synchronized; the action reads its saved work at the
new provider attachment. Late writes still require another refresh/restart.
The menu measures its rendered size, stays within the viewport, and scrolls
when its actions exceed the available height.

This composes existing verified-abort and message-less-reactivation routes.
Both are supported by the optional-feature corpus `v0.8.1` (2026-09-05) and
`v0.8.0` (2026-08-31). Older servers without `sidebar-session-resume` omit the
action; no capability meaning or server wire contract is expanded.

## Direct-message resume readiness

`POST …/sessions/:sessionId/resume` reports `resume.outcome: "started"` only
after the provider emits its initialization boundary for the requested native
session. `Process` retains that one-shot settlement, so a load error or iterator
completion that occurs before the route begins waiting is still observed. The
provider-reported id must equal the requested resume id; a provider fallback
that silently creates a replacement session is rejection, not attachment.

Attachment failure aborts and unregisters the admitted process, and the route
returns `409` with the provider startup error. The wait is bounded to 60
seconds. Queue admission remains distinct: a capacity-delayed request still
returns `resume.outcome: "queued"`, which makes no attachment claim.

Message-less reactivation retains its narrower contract. It may return an idle
process before the provider is initialized because it delivers no turn and
claims only process activation, not native-session attachment.

Compatibility review covered core releases `v0.6.0`, `v0.6.1`, `v0.6.2`, and
`v0.7.0`, all of which return the same success payload before attachment. The
fix changes only when the existing success response is allowed and uses the
existing error-response convention, so no capability gate or client request
change is required. A current client against an older server retains the
legacy early acknowledgement.

## The plan

### Server primitive

Expose a message-less reactivate. Two shapes considered; pick at implementation:

- **`POST …/reactivate`** (new route), or
- **`warmOnly: true` flag on the existing resume route** that skips the
  `UserMessage` requirement and the turn delivery.

Behavior:

1. Start the harness process for the session id (provider resolved as resume
   does: metadata provider → reader), load history, **deliver no user turn**.
2. Leave it in the post-turn **idle** state; subject it to the **same reaping /
   idle-lifecycle** as any other idle owned process (don't leak an immortal
   idle process).
3. Return `{ processId }`; ownership for the session becomes
   `{ owner: "self", processId }`.

Server files this touches: `supervisor/Process.ts`, `supervisor/types.ts`, and a
route in `routes/sessions.ts` or `routes/processes.ts`.

### Client integration (the planned UI half)

In `ModelSwitchModal`, the `!processId` Model-tab branch becomes an **Activate**
button (replacing the static "No active process" note) with an in-flight
"Activating…" state; the modal stays open. `SessionPage` supplies an
`onActivate` that calls the reactivate endpoint and, on success, flips
`status` to `{ owner: "self", processId }`.

No extra client reveal logic is needed: `ModelSwitchModal`'s existing
`processId`-keyed `useEffect` fires when `processId` appears, fetches models, and
the full options replace the spinner. (Minor: set `loading = true` at the start
of that fetch so the transition shows a spinner rather than a flash.)

## Cost surfacing

[[provider-context-economics]] requires that **no session action hide a
full-replay price**. Clarify before shipping: a message-less reactivate spawns
the process but likely incurs **no provider billing until the first real turn**
(stateless providers replay+bill per turn; idling the process invokes no model).
If that holds, reactivation's marginal cost over "just send your next message"
is ~zero on the provider side (local process resources only). Confirm this
against the provider's resume/load path; if reactivation itself triggers any
billed provider call, the button must surface it per the economics rule.

## Resolved decisions

- Reactivate applies validated request overrides when present and otherwise
  inherits the durable effective configuration. A successful override becomes
  the next durable snapshot; a rejected provider change does not.
- Sibling concern (task029): requested-model persistence may let a model choice
  take effect on the *next* natural turn without reactivating at all —
  reactivation is for users who want the process live *now*. Keep both; they
  serve different intents.

## Design decisions

- **Retain provider initialization as a one-shot settlement** (vs. subscribing
  only when the route is ready to wait): lazy provider iterators can reject
  before process construction and route execution converge, so readiness must
  preserve both success and failure for a later observer.
- **One per-session coordinator state** (vs. independent activation,
  configuration, and persistence maps on `Supervisor`): activation,
  configuration ordering, and snapshot retry are transitions of the same
  session owner. Keeping them together makes cleanup conditional on the whole
  state and leaves `Supervisor` with one settled `Process` result rather than
  partially applied configuration facts.

## Coordination (resolved)

Built after task029 landed and the kzahel merge settled, so the supervisor was
stable and uncontended. The initial implementation reused the existing
`createProviderSession` resume path. A 2026-07-31 restart exposed that the
shared `Process` constructor still defaulted every process to `in-turn`: a
message-less Claude process emits no result boundary until it receives a turn,
so recovered patient work could wait forever. The follow-up added explicit
idle construction for both message-less factories while preserving the
`in-turn` default for turn-bearing starts.

## See also

- [[session-context-actions]] — the recovery/fork/handoff action family
  reactivation belongs to.
- [[session-ownership]] — why a reaped session reports not-owned; reactivation
  flips it back to `self`.
- [[provider-context-economics]] — the full-replay-price disclosure rule.
- [[resume-compaction]] — compact-before-resume; reactivation should respect the
  same resume-mode considerations.
