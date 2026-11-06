# Core Service API and Embeddable Runtime

> YA's provider/session runtime is already a dependency-injected TypeScript
> library behind an HTTP-shaped surface. This topic proposes exposing that
> surface deliberately — first as a headless Node service and extractable
> core package, later (deferred) as an other-language service — so external
> scripts (e.g. Python prompt-sequence perf experiments) and OpenAI-style
> proxy clients can drive YA's harness abstraction without the full client,
> relay, and auth apparatus.

Topic: core-service-api

The 2026-10-30 [server-addressed HTTP v0 proposal](http-api-v0.md) is the
selected entry point for the new agent/API discussion. It starts with a small
transport-independent application-service seam and unstable HTTP resources.
The Python client, standalone runtime, public package and custom delegation
staging below remain background proposals, not prerequisites for v0.

See also: [`provider-abstraction.md`](provider-abstraction.md),
[`multi-machine-architecture.md`](multi-machine-architecture.md),
[`cross-host-delegation.md`](cross-host-delegation.md),
[`architecture-mandates.md`](architecture-mandates.md),
[`ui-architecture.md`](ui-architecture.md),
[`openai-compatible-helper-sessions.md`](openai-compatible-helper-sessions.md),
[`session-liveness.md`](session-liveness.md),
[`provider-state-machine.md`](provider-state-machine.md),
[`trusted-client-packaging.md`](trusted-client-packaging.md),
[`agent-session-access.md`](agent-session-access.md)
(agent-facing scripts as a consumer of this seam),
[`docs/tactical/053-sessions-route-refactor-ledger.md`](../docs/tactical/053-sessions-route-refactor-ledger.md)
(running ledger of `sessions.ts` extraction refactors that reshape where
this REST surface lives),
[`docs/tactical/177-session-launch-service.md`](../docs/tactical/177-session-launch-service.md)
(folds the route-level copies of "launch a session" into one service, the
first step toward a launch call a headless host can make).

Status: **proposal / not yet built.** The initial shaping decisions are
resolved (see *Decisions*); one (the OpenAI-adapter session mapping) remains
open and only matters if D6 comes into scope.

This topic owns the local runtime and direct-service seam. It does not turn the
existing local REST routes into an arbitrary cross-host proxy. The provisional
target-aware layer for authorized peer work lives in
[`cross-host-delegation.md`](cross-host-delegation.md).

## The core realization: the API mostly already exists

Two facts from the current code make this much smaller than a "big refactor"
framing suggests:

1. **The client already drives the server as REST.** The relay/WS transport
   carries an HTTP-like envelope — `RelayRequest = { method, path, headers,
   body }` (`packages/shared/src/relay.ts`) — and the server dispatches it by
   literally calling `app.fetch(new Request(...))` against the Hono app
   (`handleRequest` in `packages/server/src/routes/ws-relay-handlers.ts`). A
   direct (Tailscale/LAN) client skips the envelope and hits the same routes
   over plain HTTP. So there is **one REST surface** (`/api/*`, ~40 route
   modules in `packages/server/src/routes/`), and the relay is a transport
   around it, not a second API. An external HTTP client is already a
   first-class way to talk to YA. Because the WS envelope already carries full
   HTTP semantics, *bypassing* it with a plain-REST endpoint is not a strong
   benefit — a client can already speak the envelope, and plain REST forgoes
   the WS `subscribe` streaming channel. Offer a direct-REST path as a
   **courtesy to ordinary HTTP tooling** (curl, `requests`, OpenAI SDKs), not
   as a capability the WS surface lacks.

2. **The runtime is already a DI factory + plain classes.** `createApp(options:
   AppOptions)` (`packages/server/src/app.ts`) takes its dependencies as
   arguments — `dataDir`, the `Supervisor`, session services, settings, upload
   staging, etc. The `Supervisor` is a plain `class` with a
   `constructor(options: SupervisorOptions)`. Providers implement a clean
   `AgentProvider` interface (`packages/server/src/sdk/providers/types.ts`)
   with a streaming `AgentSession` (async iterator + message queue + abort /
   interrupt / steer / setModel). None of this is bound to Express-globals or a
   singleton; it is already library-shaped.

The gap is not "build an API." It is: **the one REST surface and the runtime
library are entangled with concerns an external script does not want** — SRP/
NaCl relay auth, cookie/session auth, push subscriptions, the web client's
event-subscription model, VAPID, device bridge — and there is no supported,
documented, minimal way to stand up "just the runtime + routes" or to `import`
the runtime as a package. This topic is about *drawing that seam deliberately*
rather than leaving it implicit.

## Relationship To The Coordination API

The following custom coordination-service design predates the
[v0 direction](http-api-v0.md). V0 exposes authorized topology and ordinary
session operations, with creation provenance but no required worker/delegation
lifecycle. It routes only its supported surface to authorized targets; it does
not add arbitrary host selectors to existing `/api/*` routes. The older
delegation-handle design below is not a prerequisite for this work.

Cross-host delegation adds a higher-level consumer of this runtime rather than
a second provider harness abstraction. Its provisional coordination service
normalizes target discovery, session creation, observation, messaging,
interruption, and teardown across a local target and an authorized peer.

The layers remain distinct:

- the core service owns local provider/session execution;
- the coordination service owns explicit local/peer targeting and delegation
  records;
- the peer layer owns server identity, authentication, directional grants,
  authorized project inventory/resolution, and remote failure semantics; and
- REST, CLI, Claude tools, Codex tools, MCP, and skills are consumers or
  adapters rather than independent orchestration implementations.

Existing `/api/*` routes retain their current-server meaning. A coordination
implementation should call the same local application service used for a
remote target where semantics match, but it should not add a universal
`?host=` parameter to existing resource routes or proxy arbitrary remote YA
requests. After remote creation, a delegation handle identifies the
supervision relationship while the worker keeps its own target-owned YA
session id.

This layering lets the direct API remain rich and inspectable while giving
delegated agents only the bounded operations authorized by their grants. The
coordination contract must also be discoverable without a YA source checkout
through machine-readable schemas/capabilities and stable structured errors.

## Two directions (ordered)

**Direction A — TypeScript-first (preferred, do this first).** Factor the
existing runtime into a reusable core and stand up thin Node route hosts on top
of it. No rewrite; this is extraction + a new entrypoint. All of the staged
steps below are Direction A.

**Direction B — other-language service/library (deferred).** A Rust/Go
reimplementation of the service (or a subset). Explicitly *later*: it only earns
its cost once the TS seam is proven, the wire contract is frozen, and there is a
concrete pull (deployment footprint, embedding target, perf) that TS can't meet.
See *Deferred: other-language rewrite* for what it would actually take. Do not
let Direction B shape Direction A's factoring beyond "keep the wire contract
language-agnostic."

## Target use cases

These are the two consumers driving the shape; the design should serve both
without a bespoke path per feature.

### 1. Scripted prompt-sequence perf experiments (Python)

Drive N sessions programmatically: pick provider + model + cwd, send an ordered
sequence of turns, await each turn's completion, and collect per-turn timing,
token/cache usage, and the resulting transcript — with YA's harness abstraction
doing the provider-specific work (SDK vs CLI vs ACP, resume, steering,
compaction, liveness). The value YA adds over calling each vendor SDK directly
is exactly the provider-agnostic seam (`AgentProvider`) plus session
persistence, liveness/probe, and usage accounting already built.

**Concrete output contract (the "minimal all-in-one" the user wants).** For an
input sequence of user turns, emit per assistant turn:
- the assistant turn text (and, optionally, tool activity);
- **timestamps** — turn-submitted and turn-completed wall-clock, so the script
  derives latency (and inter-token / first-token latency if the stream is
  observed);
- **backend-reported token accounting** — `inputTokens`, `cacheReadTokens`,
  `cacheCreationTokens`, `outputTokens`. The shared types already have fields
  for these values (`CacheMissBillingUsage` in `packages/shared/src/types.ts`,
  `ContextUsage` in `app-types.ts`), but today's exposed route/stream contract
  is not a normalized per-turn accounting API. D0 may scrape provider/session
  data as an exploratory client, but the
  first shippable "all-in-one" runner must either expose reliable turn-boundary
  attribution or explicitly mark the missing fields as unavailable.

This is a small, self-contained record shape: a list of
`{ turnIndex, submittedAt, completedAt, text, usage:{input,cachedRead,
cacheCreation,output} }`. It should be a first-class output mode, not something
each experiment re-derives from raw transcript scraping.

**Input authoring: a `---`-separated turn script.** Rather than a bespoke
send-loop, express the whole sequence as one document with `---` separators
between user turns, parsed into an ordered turn list. Delivery is the key
distinction the user drew: each parsed turn is enqueued as a regular
**per-session queued/deferred user turn** (the existing delivery that waits for
the prior turn to complete, then sends the next), **not** as steering/interrupt
input. This reuses YA's per-session queue machinery
(`SessionQueuePersistenceService`, `topics/queued-messages.md`,
`topics/message-control-steer-queue-btw-later-interrupt.md`) rather than
inventing an await-turn primitive. The Project Queue is a separate project-level
backlog and is not the delivery target for one scripted session. **Decided: the
`---` parser is a server-side input-script format** (a new "turn-script parser"
that expands `---` into queued turns), so any client — web, Python, curl —
benefits,
not just the Python lib. A client-side split (D0) is an acceptable interim before
that server parser lands; the delivery contract (queued user turns, not
steering) is the same either way.

**Experiment execution policy.** Experiment-created sessions must not inherit
privileged UI defaults implicitly. The API request should specify provider,
model, cwd, permission/tool policy, and thinking/effort. For the local perf
experiments driving this topic, tool calls are blocked by default and thinking
is enabled only when requested explicitly. These options can live on session
create for the experiments proposed so far; because this largely exposes YA's
existing API shape, the request schema should also allow per-turn overrides for
the same fields so later experiments can vary them without a second surface.

Minimum surface this needs:
- start/resume a session (`Supervisor.startSession` / `resumeSession`);
- enqueue the parsed turns as queued/deferred messages and let existing delivery
  advance them turn-by-turn (no new await-completion primitive required);
- read the transcript + per-turn usage/timing (session readers under
  `packages/server/src/sessions/`, `ProcessInfo`, the token fields above), with
  any D0 gaps treated as requirements for D1 rather than silently papered over;
- tear down deterministically (`abortProcess`), honoring *Resource
  Quiescence* (`architecture-mandates.md`) — a finished experiment must leave
  no polling/watch/heartbeat behind.

**Decided: session-store coupling is configurable per run.** Default a perf run
to isolated/ephemeral (clean list, reproducible, no dashboard clutter); a flag
opts a run into the normal jsonl store when you want to inspect it in the YA UI
(dashboard/index/recents, liveness, reader caching).

### 2. OpenAI-compatible proxy in front of providers

An OpenAI Chat Completions-shaped endpoint (`POST /v1/chat/completions`, SSE
streaming, `/v1/models`) that maps a request onto a YA session turn and streams
provider output back in OpenAI delta format. This lets any OpenAI-client tool
point at YA and reach whatever provider/model YA is configured for.

**Do not confuse this with `openai-compatible-helper-sessions.md`.** That topic
is YA *consuming* OpenAI-compatible endpoints (helper targets for tailed
recaps). This is the **reverse**: YA *serving* an OpenAI-compatible API. They
share only the wire vocabulary. The serving adapter is a thin translation layer
over the same core (messages → turn, stream → SSE deltas, usage → `usage`),
*not* a new runtime.

Design tension to record up front: OpenAI Chat Completions is nominally
stateless-per-request, but YA sessions are stateful, file-backed, and
long-lived. The adapter must decide how a `messages[]` array maps to session
identity (new ephemeral session per call? a caller-supplied session id? a hash
of the prefix?). This is the load-bearing decision for that surface and is
`OPEN:`.

## Current surface inventory (what a core package would export)

Grounding for the extraction — these already exist and are already
library-shaped:

- **`Supervisor`** (`packages/server/src/supervisor/Supervisor.ts`): the
  process/session lifecycle owner. Public methods already read like an API:
  `startSession`, `createSession`, `resumeSession`, `forkSession`,
  `getProcess`, `getProcessForSession`, `getAllProcesses`,
  `getProcessInfoList`, `abortProcess`, `interruptProcess`,
  `getRecentlyTerminatedProcesses`, `getQueueInfo`, `getWorkerPoolStatus`.
- **`AgentProvider` / `AgentSession`** (`sdk/providers/types.ts`): the
  harness-abstraction seam. Streaming iterator, message queue, abort,
  interrupt, steer, setModel, runProviderCommand, generateSummary, forkSession,
  liveness/activity/retention probes. This is precisely the "harness-abstracting
  infrastructure" the use cases want.
- **Session readers** (`sessions/reader.ts`, `codex-reader.ts`,
  `opencode-*-reader.ts`, `gemini-reader.ts`, `grok-reader.ts`,
  `pi-reader.ts`): provider-specific jsonl/db → normalized transcript.
- **`createApp(options)`** (`app.ts`): the DI composition root that mounts the
  REST routes onto a `Supervisor` + services. The routes are thin wrappers over
  the Supervisor; e.g. `routes/sessions.ts`, `routes/providers.ts`,
  `routes/provider-catalog.ts`, `routes/global-sessions.ts`,
  `routes/session-index.ts`, `routes/recents.ts`, `routes/settings.ts`.
- **Shared types** (`packages/shared/src/`): `app-types.ts`, `types.ts`,
  `session/`, the per-provider Zod schemas — already the cross-package contract.

## Named deliverables

Collected from the discussion so far, cheapest-first. Each is an independently
useful increment; "shippable" for the experiment path means its stated
accounting, execution-policy, auth, and teardown contracts are actually met.

- **D0 — Python client library / probe** wrapping the existing WS-REST surface,
  so experiment scripts can proceed with **no (or minimal) server change**. This
  is the quickest path to a working loop and gap-finder, not proof that the
  all-in-one output, auth, or quiescence contracts are already satisfied.
- **D1 — Minimal all-in-one turn-sequence runner**: input = ordered user turns;
  output = per assistant turn `{ text, submittedAt, completedAt, usage }` (see
  use case 1's output contract).
- **D2 — `---`-separated turn-script format** parsed into queued/deferred user
  turns (not steering); reuses existing queued-message delivery.
- **D3 — User doc for the REST/WS API**, including how to reach it on
  **localhost** (default: already open; the only guard is the loopback bind —
  see below).
- **D4 — Headless Node route host** (`createApp` with a minimal `AppOptions`).
- **D5 — Extracted `@yep-anywhere/core` package.**
- **D6 — OpenAI-compatible adapter** (`/v1/chat/completions`, `/v1/models`).
- **D7 (deferred) — other-language service** (Direction B).

D0 can land as an exploratory client against today's server. D1–D3 may still
require small server additions if today's routes cannot attribute per-turn
usage/timing, enforce the experiment execution policy, or add the inter-turn
reaper for deterministic teardown (the default localhost access posture needs
no addition — it is already open). D4–D6 are the TS extraction; D7 is Direction
B.

## Documentation deliverable (D3)

A user-facing reference for the REST/WS API is itself a deliverable, and a
prerequisite for anyone (including the Python client) to use the surface
deliberately. It must cover:
- the `/api/*` route surface an HTTP client can call directly;
- the WS `request`/`response` (+ `subscribe`) envelope for the relayed path;
- **how to access it on localhost** — for the *default* server there is nothing
  to relax. YA is localhost-first and ships with auth **off** (`AuthService`
  starts `enabled === false`; the middleware passes `/api/*` straight through
  when auth is not enabled), so a direct localhost client is already
  unauthenticated and supplies **no credentials**. The only trust boundary that
  matters is the **bind address**: the invariant the doc must state is
  *loopback-bound only* — never a bind reachable off-host. Cookie/session auth
  applies only when the operator has explicitly enabled password auth, and even
  then YA already has a `localhostOpen` / `setLocalhostOpen()` setting that
  permits unauthenticated localhost access — so **no new no-auth machinery is
  proposed**; the doc points at that existing knob. (The relay path's SRP+NaCl
  is WS/relay-only and orthogonal to the direct path.)

## Proposed staging (Direction A)

Each step is independently useful and ships value before the next; do not treat
this as one atomic refactor.

### Step 0 — Python client over the existing WS-REST surface (no server change)

The lowest-cost first deliverable (D0): a Python library that speaks the
existing surface — plain HTTP against `/api/*`, or the WS `request`/`response`
(+ `subscribe` for streaming) envelope — starts/resumes a session, enqueues a
client-split `---` turn script as queued/deferred messages, observes whatever
turn-boundary and transcript facts the current stream/routes expose, and
attempts to collect `{ text, timestamps, usage }` records. This needs **no
server refactor** only as an exploratory client. Any unreliable boundary,
usage-attribution, auth, execution-policy, or teardown behavior becomes a
concrete D1–D4 requirement rather than a client-side workaround.

**Teardown in D0 is not optional — it is the only path.** Because D0 makes *no
server change*, the inter-turn reaper (see *Resource Quiescence*) does not exist
yet: nothing on the server will clean up an idle scripted session. So a D0
script must itself call the close()-equivalent — **`POST
/api/processes/:processId/abort`** (→ `Supervisor.abortProcess`) — in a
`finally`/on-crash handler for **every** session it starts, or it orphans that
session's process and watchers. In D0 this is not yet a courtesy; a script that
can exit without aborting its sessions is a D0 bug. The configurable inter-turn
reaper that later demotes this explicit close to a mere courtesy is D1+ server
work.

### Step 1 — Headless route host (D4)

Stand up a Node entrypoint that calls `createApp(...)` with a **minimal
`AppOptions`** — real `Supervisor` + session services, but relay/SRP/push/device
disabled — and serves `/api/*` over plain HTTP on localhost. This is "the
service host that simply uses the implied TypeScript library surface," and it is
mostly *configuration and a new `main`*, not new runtime code.

Deliverables: a documented `AppOptions` profile for headless use; an entrypoint
(`packages/server/src/headless.ts` or a `--headless` flag on the existing CLI);
a note on which routes are meaningful without a browser client. Auth posture is
decided as opt-in loopback trust (see *Decisions*): normal server defaults stay
unchanged, and a no-auth REST listener/security policy is enabled only by an
explicit env var or launch argument while binding `127.0.0.1`.

Risk to watch: `createApp` currently assumes several services are present.
Extraction means making each injected dependency genuinely optional with a
safe no-op, per the *Anti-slop* rule (fail clearly on a missing precondition;
don't silently half-wire). Expect to discover routes that hard-depend on
client-only services.

### Step 2 — Extract `@yep-anywhere/core` (D5)

Move the runtime (Supervisor, providers, session readers, the services they
need) into a package with an explicit, documented export surface, separate from
the HTTP layer. `createApp` and the headless host both consume it; the web
server keeps working unchanged. This is the point at which "import YA's runtime"
becomes a supported thing.

**Decided: internal factoring only** — no external stability promise; the
in-repo headless host imports it and the API stays free to change. Skip the
semver/versioning ceremony until a real out-of-repo Node consumer exists (revisit
then). This keeps Step 2 a pure extraction, not a contract-freezing exercise.

### Step 3 — Promote the experiment runner server-side (D1/D2)

Step 0 proves how much can be driven from an external client by riding the
existing per-session queue. The first shippable all-in-one runner should fold
the `---`-parse + enqueue + collect-`{text,timestamps,usage}` loop into a
first-class server surface (a small `/api/experiments`-style route, or a
documented `@yep-anywhere/core` recipe) if the current wire path cannot observe
turn boundaries and per-turn usage reliably. This is still a small promotion:
"send the next turn when this one finishes" is already what queued delivery
does, so the runner mostly needs to *read back* boundaries and usage, apply the
execution policy, and own the teardown lease, not invent a new send-and-await
primitive.

### Step 4 — OpenAI-compatible adapter (D6)

A separate route module (`/v1/chat/completions`, `/v1/models`) translating to/
from the core. Thin; depends entirely on resolving the stateless-request →
stateful-session `OPEN:` mapping decision. Ships last because it is the most
opinionated and the least load-bearing for the primary (experiment) use case.

## Session launch metadata owners

A headless host or script that launches a session needs to know which layer
saves what a later resume reads, so the launch call can live below the REST
routes. Decided 2026-11-06 in
[plan 177 step 5](../docs/tactical/177-session-launch-service.md#part-1-one-owner-per-field):

- **Creation admission** (`SessionCreationStore.admit`) owns everything a
  new session or transcript copy is created with: provider, requested model
  and launch settings, prompt-suggestion and recap preferences, sandbox
  level, a copy's title and source, a `/btw` link to the copy's source, an
  internal helper's archiving and a limited user as creator. It saves them
  before the session exists, so a queued launch or a server restart keeps
  them.
- **The Supervisor** owns what a running process changes: the launch
  settings it runs with, and the sandbox it confines once it starts.
- **The launch caller** owns only what admission is not told: a handoff's
  title, a fork's lineage root, the fork-summary target's archiving, a
  `/btw` link to a parent other than the source, the preferences a restart
  fork or fork-summary continuation resolved when it started, and a restart
  handoff's started recap delay. It announces new
  sessions to open lists without writing admission's fields again.

The sandbox record still has a caller write alongside the Supervisor's until
plan 177 verifies one owner on Linux.

## Design tensions and mandates that constrain this

- **Resource Quiescence is non-negotiable** (`architecture-mandates.md`). Every
  API-created session is a resource owner; a script that starts 100 sessions
  and exits must not leave 100 polling/watch/heartbeat loops. A headless script
  has no browser tab or WS heartbeat to act as the client-liveness owner that
  normally releases resources on disconnect, so the teardown signal must come
  from the API itself. **Decided mechanism: the script declares a max time
  between turns** at session start; YA arms that deadline whenever the session
  goes idle awaiting the next turn (i.e. after a turn completes), and **reaps —
  deterministic teardown via `abortProcess`, honoring quiescence — if the next
  turn doesn't arrive in time.** The declared budget is a coarse, pre-committed
  substitute for a live heartbeat: instead of the client pinging, it promises an
  upper bound and forfeits the session if it overruns. Two teardown paths, both
  documented:
  - **Explicit manual `done`/teardown call — the courtesy fast path.** A
    well-behaved script calls it when finished to release the session
    immediately, rather than waiting out the reaper deadline. This is the
    intended normal ending; document it as the expected script etiquette.
  - **The declared inter-turn reaper — the backstop.** For scripts that crash,
    hang, or skip the courtesy call, the max-inter-turn budget — a configurable
    per-session deadline with a conservative default (~60s) — guarantees
    eventual quiescence. The two are complementary: `done` is the fast, polite
    release; the reaper ensures resources are never orphaned when `done` never
    comes.
  - The deadline measures *client-owed idle* (turn-complete → next-turn-submit),
    not turn duration — an agent still working keeps the session alive by
    provider activity, so a long turn never trips the reaper.
  - In fully-enqueued `---` batch mode the queue drives itself, so there are no
    client-owed gaps; the budget still backstops a stalled/never-draining queue,
    and the explicit `done` call is the clean ending.
  - Cross-ref `session-liveness.md`; this is the scripted-session analogue of
    the client-owned heartbeat named in `architecture-mandates.md`.
  This is the single most likely way a naive external API violates an existing
  YA invariant. The reaper needs server work, so it lands with the first
  shippable runner (D1+), not in the no-server-change D0. Until it exists, D0
  has **no backstop** and the explicit close is the sole teardown path (see
  *Step 0*); the reaper is precisely what later demotes that close to a
  courtesy.
- **Provider abstraction seam** (`provider-abstraction.md`): the API should
  express provider/model *capabilities* (steer? interrupt? recaps? thinking?)
  via the existing `AgentProvider` flags, not hardcode per-provider branches in
  the new surface. New API callers must not have to know "claude runs at 1M."
- **Backward compatibility** (`backward-compat.md`): the existing `/api/*` REST
  surface is already consumed by the shipped web client. Extraction must not
  change those routes' observable contract; the headless host reuses them
  as-is. Any new surface (`/api/experiments`, `/v1/*`) is additive. Cross-host
  coordination likewise uses an additive, capability-gated namespace rather
  than changing an existing route to mean either local or remote depending on
  a host parameter.
- **Auth / trust boundary** (`trusted-client-packaging.md`, relay/SRP docs): the
  default server is localhost-first with auth **off**, so the direct `/api/*`
  path is *already* unauthenticated — an external localhost client sends no
  credentials. Cookie/session auth applies only when the operator turns password
  auth on (and that case reuses the existing `localhostOpen` knob); the relay
  path's SRP+NaCl is separate. The real invariant for an external client is the
  *loopback bind*, not a credential; the resolved posture lives in
  *Documentation deliverable (D3)*.
- **Session-store coupling**: YA sessions are jsonl-file-backed and surface in
  the dashboard, index, recents, and liveness. An experiment API that reuses the
  store gets all of that for free but pollutes the user's session list with
  synthetic runs; an isolated store keeps experiments clean but forfeits the UI
  and the readers' incremental-parse caching.

## Decisions

### Resolved (2026-07-01)

Index only — each entry states the resolved outcome; the section in parentheses
holds the reasoning and full detail, so a decision is specified in exactly one
place.

1. **`---` turn-script parser location → server-side** (§ *Input authoring*).
   A server-side expander turns `---` into queued/deferred turns — not steering
   — so any client benefits; a client-side split is an acceptable D0 interim.
2. **Experiment session-store coupling → configurable per run**
   (§ *Design tensions* → session-store coupling). Default isolated/ephemeral;
   a flag opts a run into the visible jsonl store for UI inspection.
3. **Localhost access posture → default is already open; guard the bind, not the
   credential** (§ *Documentation deliverable (D3)*). The default server ships
   auth-off, so a direct localhost client needs no credential; the only
   invariant is loopback-bound (never off-host). The password-enabled case
   reuses the existing `localhostOpen` knob, not new machinery.
4. **`@yep-anywhere/core` packaging → internal factoring only** (§ *Step 2*).
   No external semver promise until a real out-of-repo consumer exists.
5. **Teardown contract → explicit `done`/abort call + inter-turn reaper backstop**
   (§ *Design tensions* → Resource Quiescence). The reaper (configurable
   inter-turn deadline, default ~60s) is D1+ server work; in the no-server-change
   D0 the explicit `POST /api/processes/:id/abort` close is the *only* teardown
   path, not yet a courtesy.
6. **Experiment execution policy → explicit and conservative**
   (§ *Experiment execution policy*). Provider/model/cwd, tool policy, and
   thinking/effort ride the request; tools blocked and thinking off unless
   explicitly asked; per-turn overrides allowed.

### Resolved (2026-11-06)

7. **Session launch metadata → one owner per field**
   (§ *Session launch metadata owners*). Creation admission saves what a
   session is created with, the Supervisor what a running process changes,
   and the launch caller only what admission is not told.

### Still open

8. **OpenAI adapter session mapping** (only if D6 is in scope soon): how does a
   stateless `messages[]` request map to session identity — ephemeral per call,
   caller-supplied id, or prefix-hash reuse?

## Deferred: other-language rewrite (Direction B)

Recorded so the TS work doesn't accidentally foreclose it, not as near-term
work.

What a Rust/Go service would actually have to reproduce — and why it's large:
- **Provider harness integration.** The hard part isn't the HTTP; it's that
  each provider is integrated through its *own* mechanism — the Claude/Codex
  TypeScript SDKs, ACP clients, CLI process management, provider-specific jsonl/
  sqlite readers. A non-TS service either reimplements each provider integration
  (large, and re-chases every provider quirk YA already solved) or shells out to
  a TS worker (at which point the "rewrite" is really a thin front over the TS
  core — which argues for Direction A's headless host instead).
- **Session model + readers.** Provider transcript formats, normalization,
  incremental parsing, liveness inference — currently substantial TS.
- **The invariants.** Resource quiescence, provider capability seams, and the
  auth/crypto (SRP + NaCl) surfaces are all currently TS and load-bearing.

Sane form for Direction B *if* it ever happens: keep the frozen wire contract
(the REST/`/v1` surface) as the language boundary and let a Rust/Go host front a
TS core worker, rather than porting the provider integrations. That is the
version that reuses, rather than re-chases, YA's harness abstraction — and it is
only worth doing once Direction A has frozen that contract and a concrete pull
(footprint/embedding/perf) exists.
