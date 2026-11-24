# Yacron

> Yacron is a proposed generally running, same-user local scheduler that lets
> agents and YA create, inspect, revise, and dispatch durable future prompts.
> Its provider-host-integrated variant can address existing or fresh YA
> sessions; its standalone variant may instead launch provider harnesses
> directly.

Topic: yacron

Status: **proposal only; nothing is implemented (2026-08-27).**

Related:
[provider host API](provider-host-api.md),
[Provider-host yacron launch requests](sketches/project-queue-yacron.md),
[agent command runtime sketch](agent-command-runtime.sketches.md),
[new-session agent tooling](new-session-agent-tooling.md),
[Routines](routines.md),
[session sandboxing](session-sandboxing.md),
[session wake](session-wake.md), and
[vanilla defaults](vanilla-defaults.md).

## Maintainer review — 2026-08-30

Review disposition: positive on the core product idea — durable one-shot and
cron-like agent prompts are useful. The service/API and CLI direction is
approved; the required first-version YA management UI still needs a concrete
design before implementation.

### Keep one authoritative API and ship its CLI in v1

The versioned service control API should be the authoritative activation
interface. A successful mutating API call creates or revises the durable
schedule; returning its id is the durability acknowledgment. Persistence,
caller identity, authorization, capability checks, target validation, and
dispatch semantics all belong behind that boundary.

YA's UI, the agent-facing `yacron` CLI, and any other integration are clients of
the same API. The CLI is required in the first version: it is how the system
exposes the Agent API to shell-capable agents. It translates arguments into the
public service API without owning separate scheduling or policy logic. A
successful CLI mutation is therefore an activation act backed by the same
durability acknowledgment as a direct API or UI mutation.

### Compare and design the first-party-shaped UI

The first version also requires complete human CRUD, history, and run
visibility in YA, including desktop and phone flows. The current thin-client
inventory and optional sidebar alarm do not yet establish the information
architecture, creation flow, schedule editor, or relationship between an
occurrence and its resulting session.

As of this review, the closest first-party surfaces establish a stronger
baseline:

| Surface | Creation | Management and results | Relevant YA lesson |
| --- | --- | --- | --- |
| [ChatGPT Scheduled tasks](https://help.openai.com/en/articles/10291617-tasks-in-chatgpt) | A dedicated **Scheduled** page creates one-time or recurring tasks; a user may also describe the task conversationally. | The page reviews results and schedules and supports edit, pause/resume, and delete. A task also has an associated conversation and notification settings. | Scheduling is a normal visible product surface, while task output remains ordinary conversation output. |
| [Claude Code Desktop scheduled tasks](https://code.claude.com/docs/en/desktop-scheduled-tasks) | **Routines → New routine → Local** exposes name, description, instructions, permission mode, model, folder, optional worktree isolation, and friendly schedule presets. A user can ask Claude for schedules outside the presets. | The detail page provides Run now, active/paused state, edit, run history including skipped reasons, saved permissions, and delete. Each due run starts a fresh ordinary session and appears under **Scheduled**. | This is the closest local coding-agent precedent: make project and permission context explicit, use ordinary sessions for output, and explain local liveness and missed-run behavior. |
| [Claude Cowork scheduled tasks](https://support.claude.com/en/articles/13854387-schedule-recurring-tasks-in-claude-cowork) | **Scheduled → New task** offers either conversational creation or a manual form for name, prompt, approval mode, cadence, model, and optional folder. | The Scheduled page shows upcoming and past runs and supports edit, pause/resume, Run now, and delete. Each run is its own Cowork session. | Offer both a direct form and an agent-assisted path over one underlying API; do not invent a separate result-log product. |

The next revision should turn that comparison into an explicit YA surface:

- choose the navigation home and ordinary user-facing name (for example,
  **Scheduled** or **Routines** rather than requiring users to learn the
  implementation name `yacron`);
- specify both manual and agent-assisted creation over the service API;
- lead with friendly one-time, hourly, daily, weekday, and weekly controls,
  while keeping raw cron plus timezone as an advanced form;
- show the resolved timezone and human-readable next-fire preview before save;
- design project, target-session, provider/model, permission, and isolation
  choices without simply projecting the backend entry schema into a form;
- define list and detail states for next run, active/paused, waiting,
  dispatched, skipped, failed, and missed/catch-up behavior;
- provide Run now, edit, pause/resume, delete, and bounded run history with
  direct links to the ordinary YA session/turn produced by each occurrence;
- keep scheduler receipts to dispatch metadata and failure diagnostics rather
  than copying rollout logs or transcripts into a second output store;
- specify notifications and actionable stalled-permission/failure states; and
- show how the surface works at 1000-pixel desktop and 375-pixel phone widths.

The first-party comparison does not require copying cloud-only triggers,
sharing, connectors, or every advanced permission control into the first
version. It does require deciding the visible workflow before backend details
accidentally become the UI. The optional countdown/alarm is an enhancement to
that workflow, not a substitute for it.

## Shared core and deployment variants

Yacron is a fresh design, not an adapter around the existing `~/agents` `at/`
protocol. Both deployment variants share:

1. one service-owned store for entries, occurrences, and receipts;
2. one exact next-deadline scheduler over that store;
3. one `yacron` CLI and versioned local control API;
4. one global config with an optional project-local override; and
5. retained subscriptions plus explicit point-in-time import/export.

Exactly one service owns a given yacron profile and store. An installation
chooses the integrated or standalone owner; the two variants never open the
same live store or run competing deadline timers. CLI and YA clients discover
the selected owner and its advertised capabilities rather than inferring them
from the executable name.

### Provider-host-integrated variant

The integrated variant runs yacron inside a durable, install/profile-scoped YA
provider service. It owns provider workers, session input queues, project
admission, launch/resume, sandbox launch facts, and yacron's timer/store. That
co-location is what permits canonical YA session targets, exact queue-aware
return-to-session delivery, Project Queue integration, and atomic exclusive-
project admission.

The current provider host is not yet this service. It is tied to exact checkout
source/build identity and normally to a wrapper or foreground terminal. The
integrated variant therefore requires either a source-independent installed
provider-service generation or a fenced handoff that drains the old owner,
transfers the store/admission lease, reconciles accepted work, and starts the
new generation before serving calls. Different development checkouts attach as
clients; they do not start profile-competing schedulers.

### Standalone variant

The standalone variant is a source-independent yacron service with no Hono or
YA provider-service dependency. It may launch a fresh provider harness directly
through configured adapters, or use an optional provider-service adapter when
one is available. A direct launch reports a namespaced provider-native identity
and explicitly has no canonical YA session id.

Standalone yacron cannot see YA's patient/deferred message queues, reserve
against all YA launch paths, or enforce the complete Project Queue idle
predicate. It therefore refuses `exclusive-project-session`, is not a Project
Queue implementation candidate, and exposes only target modes its configured
adapter can actually honor. Unsupported target forms fail at schedule creation
or edit, not later at due time.

The shared baseline excludes watched project entry files, automatic `at/`
import, early provider preparation, and sandboxed-session access. The latter is
an explicit initial denial rather than an unimplemented security promise.

## Entry model

An active **entry** is only:

- an instruction;
- a `when` value;
- a target; and
- enabled/paused state plus service-assigned id and revision.

The service-assigned entry id is also the public **schedule id**; these are not
two objects or identifiers.

The first `when` grammar has two explicit forms:

- one RFC 3339 timestamp for a one-shot entry; or
- one five-field cron expression plus an IANA timezone for a recurring entry.

The service calculates and returns the next fire time whenever an entry is
created or revised. It does not infer recurrence from prompt prose.

The three target forms are:

- **current session** — resolved from `AGENTCTL_SESSION_ID` when scheduled and
  accepted only when the active adapter can address that YA session;
- **existing session** — an explicit canonical YA session id; or
- **fresh session** — a project root plus the ordinary provider/model/launch
  choices needed to create a target whose first turn is the instruction. The
  integrated variant creates a YA session; a standalone direct adapter creates
  a provider-harness session.

An integrated fresh-session target also stores an explicit project-session
policy:

- **exclusive-project-session** joins the provider service's per-project FIFO
  admission lane, waits for the complete Project Queue idle predicate and its
  configured recent-activity timeout, then reserves launch atomically; or
- **concurrent-project-session** launches when due without that wait.

The integrated default is exclusive with a 30-second recent-activity timeout,
overridable by global/project config and by the scheduling call. Standalone
direct-harness targets support concurrent mode only. The resolved adapter, mode,
and timeout are saved on the entry and shown everywhere; a later default or
service change cannot silently alter an already scheduled launch.

Current-session identity is resolved and stored at creation time. Dispatch
never guesses a provider session from the environment or filesystem. Existing
YA targets use canonical YA ids, with provider-native resume ids private to the
provider service. A standalone direct target instead stores and reports its
explicitly namespaced provider-native identity.

## CLI is the agent activation interface

The first-version agent-facing binary is available on PATH when yacron tooling
is enabled and the session is eligible to use it. Every command calls the
selected owner's versioned service API. Its conceptual surface is:

```text
yacron schedule --at <timestamp> --prompt <instruction> --session current
yacron schedule --cron <expression> --timezone <zone> \
  --prompt <instruction> --new-session --project <root> \
  --exclusive-project-session --recent-activity 30s
yacron list [--project <root>]
yacron show <id>
yacron edit <id> ...
yacron pause|resume|cancel|delete <id>
yacron history <id>
yacron subscribe '*'|<schedule-id>...|<occurrence-id>
```

The command vocabulary remains `yacron` regardless of deployment. An
integrated YA installation may project that launcher as an alias into the
shared runtime specified by
[agent command runtime sketch](agent-command-runtime.sketches.md), using the same scoped
endpoint discovery as other YA commands. Standalone yacron still includes a
normally installed CLI because it must work without a YA server or supervised
provider session. This is packaging reuse only: neither launcher owns a second
scheduler, store, timer, or authorization policy.

Calling `schedule` creates an enabled entry. That call is the activation act;
there is no later scan, import, approval, or UI enable step. Read commands do
not activate anything.

The CLI offers the same entry operations as YA's UI, including revising the
instruction, target, time/recurrence, timezone, or pause state. Stable ids and
machine-readable output are part of the first contract so agents do not scrape
display text.

The first scheduling mutation attaches to or starts the selected yacron owner
under durable platform service supervision. It fails rather than claiming
success if the entry was not persisted or the service has no credible way to
remain running until the due time. A child left behind by the calling agent
shell is not sufficient.

## Delivery and history

At the due time the active yacron service first persists a **run occurrence**
with its occurrence id, then:

- asks an integrated provider service to queue an ordinary user turn for a
  current/existing YA session;
- asks the integrated provider service to admit and launch a fresh YA session;
  or
- invokes a configured standalone adapter, which may launch a provider harness
  directly or call a provider-service API.

A busy existing session receives the occurrence at its normal queue boundary;
yacron never steers or interrupts it. Unsupported delivery combinations are
rejected when the entry is created or revised. A fresh integrated exclusive-
project occurrence remains `waiting-project-exclusive` until the complete
quiet condition holds, then the provider admission owner atomically reserves
the project while launch starts. Concurrent mode bypasses only this wait; it
does not bypass ordinary provider launch validation or become invisible to
later idle checks.

An occurrence records the entry revision and instruction snapshot, scheduled
and actual times, dispatch/subscription id, resolved target identity, state,
failure reason, and an adapter submission receipt. The receipt makes restart
reconciliation idempotent: yacron does not knowingly submit the same occurrence
twice.

The first missed/overlap policy is intentionally small:

- a missed one-shot occurrence runs once when the service returns;
- recurring entries do not backfill every missed tick; at most the latest
  missed occurrence is materialized;
- if the previous occurrence remains queued or running at the next tick, that
  tick is recorded as skipped; and
- failed delivery is recorded and requires an explicit retry/run-now action
  rather than an automatic retry loop.

History is a bounded index into sessions/turns, not a duplicate transcript.

## Integrated session queues and project admission

The provider-host-integrated variant makes the provider service the durable
owner of accepted per-session input. Its ledger includes ordinary queued,
deferred, or patient user messages and due yacron occurrences. Hono and other
clients project that ledger; they do not retain an authoritative queue that can
disappear across a Hono reload. If migration must temporarily leave a queue in
Hono, the provider service needs an equally durable, exact observation of every
admission and settlement before integrated yacron can claim queue awareness.

A due occurrence for a current/existing session appends behind already accepted
input in that session's FIFO order. It counts as retained session and project
activity from acceptance through submission or terminal failure. This gives a
recurring return-to-session prompt the same patient behavior as ordinary queued
input and prevents a fresh exclusive-project launch from overtaking it.

Fresh automatic launches use one durable FIFO admission lane per project. A
yacron occurrence enters when it becomes due; a Project Queue item enters when
it becomes that project's selected head. The provider service assigns the
monotonic order at that ready boundary, so a far-future schedule does not block
work that is ready now. Existing-session input is not another lane item: any
queued/patient message is an idle blocker that drains before the next fresh
exclusive launch. Ready yacron and Project Queue launches then reserve and start
one at a time in FIFO order.

Eligibility is the complete current
[Project Queue idle predicate](project-queue.md#project-idle-predicate),
including provider state, retained work, direct/deferred/patient input, pending
input, verified-idle liveness, worker/startup admission, external ownership,
admitted user starts, paused-after-restart work, and its explicit `/done`
exception. The provider service performs the final predicate check and project
reservation in one admission operation shared by every integrated automatic
launch path. Concurrent launches bypass this lane but publish activity before
the next exclusive predicate check.

## Dispatch subscriptions

Yacron exposes a retained subscription before a target session necessarily
exists. A caller may subscribe to `*` for every schedule visible under its
cooperative read policy, to one or more schedule ids, or to one concrete
occurrence id after that occurrence exists. Scheduling returns only the stable
schedule id and next-fire time, so pre-due observers subscribe by schedule id.
The occurrence id is minted and persisted when due materializes the occurrence.
A cursor allows reconnect or a later point-in-time query without keeping the
original browser or CLI process open.

Schedule events include `scheduled`, `revised`, `paused`, `resumed`, and
`next-fire-changed`. An occurrence lifecycle begins at `due` and includes
`waiting-project-exclusive`, `starting-or-rejoining`, `session-ready`,
`submitted`, and a terminal outcome. `session-ready` reports:

- whether an adapter started a fresh target, rejoined/resumed an existing one,
  or reused an already-live worker;
- the schedule and occurrence ids, due time, immutable instruction snapshot,
  and any purpose label — what the session was obtained for; and
- the target identity. Integrated delivery reports the canonical YA session id
  and final YA metadata. A standalone direct-harness launch reports its
  provider namespace and provider-native durable id, with no invented YA id.

This is yacron's notification facility for an interested party, not merely a
live provider event stream. The event is retained in yacron history, so an
observer that disconnects before the start/rejoin result can recover it.
Recurring schedules publish their next-fire time and entry revision as each
cycle advances; they do not preallocate the next occurrence id.

The subscription envelope is common to both variants, while target-specific
identity and lifecycle states are capability-advertised. A client never assumes
that a standalone direct launch will eventually acquire a YA session id.

### Integrated launch/join-and-prompt request

The integrated provider service owns one durable launch/join-and-prompt request.
An accepted request bundles the complete project eligibility check, FIFO
admission and atomic reservation when needed, fresh launch or existing-session
join, and initial queued instruction. The provider service returns a request id
only after taking durable responsibility; that id supports status lookup and
the retained stream. External provider operations remain reconcilable rather
than literally transactional, but their one admission owner can fence retries
and preserve receipts.

YA Project Queue can submit the same request as soon as an item is the selected
head and subscribe before the queued session has an id. The provider admission
owner publishes final canonical metadata on `session-ready` and the prompt-
acceptance receipt on `submitted`. Project Queue settles its durable item only
from those states, so Hono reconnects by request id instead of reconstructing a
lost callback. The detailed candidate remains in
[Provider-host yacron launch requests](sketches/project-queue-yacron.md).

### Standalone dispatch

Standalone yacron gives its adapter one durable occurrence request and retains
the adapter result. A direct harness adapter may start a fresh concurrent
session and submit its first prompt; a provider-service adapter may expose
additional target forms. Standalone never labels a preflight check as atomic
project exclusivity and never accepts Project Queue ownership.

## One state owner and one timer

There is one generally running yacron state owner per effective profile, not one
process per session, project, browser, schedule, or source checkout. An install
supplies normal OS service supervision on Linux, macOS, and Windows. The owner
holds a fenced profile/store lease; a replacement must prove the previous
generation stopped before dispatching.

The owner holds one exact next-deadline timer across all entries. Creating,
editing, pausing, resuming, cancelling, or firing an entry recomputes that one
deadline. There is no fixed polling loop or provider process retained per
entry.

The `yacron` CLI talks to the selected owner's versioned local control endpoint.
An integrated provider host exposes it directly. A YA server may also adapt a
standalone service for the optional management UI, but doing so does not grant
that service integrated queue, admission, sandbox, or Project Queue
capabilities. No client owns a second scheduler or copies state into the
browser.

## State and configuration

Entries, revisions, occurrences, and receipts live in one active-service-owned
store under the user's yacron data area. Clients change that state through the
service API. The storage technology is an implementation detail; the important
first-version rule is one writer and one revision truth.

Returning a schedule id is a durability acknowledgment. Before the service
returns that id, it has committed the entry and every fact needed to reconstruct
it after a crash. On restart, yacron rebuilds its in-memory scheduling set from
that authoritative store. The resulting set is complete and exact for every
acknowledged mutation; restart does not scan known project directories for
stray entry files or reconcile changes made outside the service API.

Project files are a secondary, explicit point-in-time interchange and recovery
surface. A future export may produce native-shell-searchable files suitable for
off-machine backup or an intentional Git commit. An explicit import-as-of-now
operation may then create or revise service-owned entries, with conflicts shown
for resolution. After import, later edits, pulls, checkouts, or deletions of
those files are inert until another explicit import. There is no watched source
mode and no promise that filesystem state continuously mirrors live schedules.

The primary machine-loss path should be a coordinated backup of full YA state,
including the authoritative yacron store. YA does not yet provide a meaningful
live full-state snapshot; [`gaps/sketches/live-full-state-backup.md`](../gaps/sketches/live-full-state-backup.md)
tracks that separate recovery requirement. Exported project files remain useful
when the central YA data area was not backed up.

Configuration is simpler and intentionally visible:

- global defaults come from a file conceptually at
  `~/.yep/yacron/config.json`; and
- an optional `<project>/.yacron.json` overrides applicable values for entries
  owned by that project.

The exact platform config root may differ, but the precedence does not. The
service does not create project config merely because YA browsed a project.
YA-created project config also requires the explicit global opt-in for
project-local YA writes. Whether the project file is committed is ordinary
project policy.

YA settings map to keys in the global or selected-project yacron config rather
than keeping a parallel settings truth. The simplest write path is for CLI and
YA clients to ask the active service to update the selected config atomically;
human edits remain readable after reload. UI and CLI show whether an effective
value came from the global or project file.

Agent-oriented cross-project policy has two independent config values:

```json
{
  "agentAccess": {
    "readOtherProjects": true,
    "modifyOtherProjects": true
  }
}
```

Both default to `true`. Read covers list/show/history. Modify covers create,
edit, pause/resume, retry, cancel, and delete. These access values resolve from
global config plus the caller project's override; a target project's config
cannot grant the caller more authority.

Caller-project identity has strict precedence. An authenticated provider-
service session identity wins when available. Otherwise a present
`AGENT_PROJECT_ROOT` is the cooperative YA-launched identity and cannot be
overridden by a CLI target. Only a caller outside YA may fall back to a distinct
explicit `--caller-project` or its canonicalized cwd. `--project` always names a
target/filter and never reclassifies the caller. YA's authenticated operator UI
may show all projects.

These are cooperative behavior settings, not a security boundary. The first
version trusts ordinary unsandboxed same-user local processes and makes no claim
that one can be isolated from another.

Sandboxed sessions are different: a general same-user yacron endpoint would be
a direct escape from their project boundary. Initial integrated and standalone
versions therefore deny all yacron management from a verified sandboxed
session, do not pass a usable management credential, socket, or localhost route
into its execution domain, and fail closed if they cannot distinguish the
caller. Omitting PATH copy or instructions alone is not enforcement. The
project-write sandbox also requires operator authentication, blocks relaxing
that authentication while a launch is pending or active, and gives the child
neither a raw browser-session token nor an ambient YA operator credential.

Later own-project scheduling is an integrated-only capability. It requires the
provider service to own the authenticated session/project identity, yacron
management decision, durable sandbox launch facts, and the scheduled launch
path. A narrow session capability may then allow only same-project entries and
targets; neither CLI arguments nor project config can widen it. Any fresh
session created from that entry inherits at least the caller's enforced sandbox
level and canonical project. The current worker-side Bubblewrap setup is not
enough by itself: queue/admission policy and every relaunch must also remain in
the provider service's trusted control plane. Standalone yacron remains
unavailable to sandboxed callers because it cannot prove or reapply that chain.

## YA session environment

Enabled YA sessions receive:

- `AGENTCTL_SESSION_ID`, already the canonical YA session id; and
- proposed `AGENT_PROJECT_ROOT`, the canonical absolute project root used to
  launch the session.

The project marker uses the launcher-independent `AGENT_*` namespace rather
than a `YEP_*` configuration name. Yacron derives any internal encoded project
id from the root rather than exposing a second public identity. The marker is a
cooperative classification hint, not an authentication capability.

Yacron service enablement does not grant every agent access. A YA session must
separately request its yacron capabilities; only an eligible unsandboxed launch
then receives `yacron` on PATH through the shared server-instance command
directory specified by `agent-command-runtime.sketches.md`, a launch token scoped to its
effective read/modify operations, and any matching instruction fragment.
Process ancestry is not the authorization boundary. A global new-session
default may seed the request but never changes an existing session.

Tool advertisement and the discoverable UI are separate: yacron itself is
opt-in, but its required management UI is always available once the service is
enabled so every entry remains visible and controllable. Per-session PATH and
injected agent instructions remain default-off under YA's vanilla-defaults
contract. Agent access remains inert until granted; after that, a successful
mutation through the CLI, UI, or direct API activates the entry.

## YA management UI

The first-version YA management surface is a required service client. It
provides:

- entry list/detail, create/edit, pause/resume, retry, cancel, and delete;
- next fire, last run, blocker/failure, history, and config-source views; and
- global/project settings that write the corresponding yacron config.

An optional persistent sidebar alarm can show active-entry count and time until
the next fire. Discrete proximity/color buckets are sufficient; continuous
animation and client polling are unnecessary. The indicator is separately
configurable and default-off.

## Headless install

The integrated headless install contains the durable provider service with its
yacron scheduler, provider adapters, CLI, and config/state support. It has no
Hono server, browser client, relay, or web UI. The smaller standalone install
contains only the yacron service, CLI, and selected direct-harness adapters; a
YA server may be absent.

## Deferred extensions

- **Early preparation:** optionally resume/prepare a provider shortly before
  the due time, without sending the turn early. This is explicit and default-
  off because it may consume resources or begin billing.
- **Project-file import/export:** an `at/`-inspired format could export due-later
  instructions as searchable or intentionally committed project files. They
  are point-in-time recovery artifacts, not a watched scheduling source; only
  an explicit import-as-of-now operation can change live service state.
- **Outside-YA callers:** local endpoint discovery plus explicit project and
  target arguments could let another harness use yacron when its CLI is on
  PATH. Lack of a YA session marker must never trigger origin guessing.
- **Routines:** YA Routines can later use yacron as their sole deadline/run
  engine while retaining their separate reusable-source and user-activation
  semantics. A raw yacron entry need not become a Routine.
- **`at/` migration:** `at/` is prior art or an explicit point-in-time import
  source, not a dependency. It can be retired if yacron proves sufficient.

## Design decisions

- **Two explicit variants (vs. topology-neutral promises):** provider-host
  integration earns queue-aware YA guarantees; standalone stays useful without
  pretending it can coordinate Project Queue or sandbox inheritance.
- **Service-owned entry state (vs. editable entry files):** one writer avoids
  concurrency and revision ambiguity; explicit config files retain simple
  global/project customization.
- **CLI call activates (vs. source discovery):** the agent's mutating command
  is the intent boundary.
- **Two schedule forms (vs. natural-language parsing):** one-shot RFC 3339 and
  cron-plus-timezone are familiar, explicit, and serializable.
- **One integrated launch/join request (vs. yacron and Project Queue
  callbacks):** the provider admission owner supplies full queue-aware project
  exclusivity and eventual canonical YA session identity.
- **Permissive ordinary access plus closed sandbox access:** both cross-project
  defaults remain permissive for unsandboxed same-user agents; sandboxed
  sessions receive no ambient yacron authority.

## First implementation sequence

1. Build the versioned service API, shared service-owned store, fenced
   single-owner lease, schedule-level subscriptions, due-time occurrence ids,
   one next-deadline timer, and the agent-facing CLI CRUD/history client.
2. Add YA's Scheduled list/detail, manual and agent-assisted creation, edit,
   pause/resume, Run now, delete, bounded history, failure state, and links to
   resulting ordinary sessions. Keep the sidebar alarm separately optional.
3. Ship the standalone concurrent fresh-harness adapter or choose the integrated
   path; advertise and reject target capabilities exactly.
4. For integration, first promote the provider host to a durable profile-scoped
   service and move accepted patient/deferred input plus project admission under
   its durable ownership.
5. Add current/existing-session delivery and fresh exclusive FIFO admission;
   then let Project Queue use the same provider-owned request and publish
   `AGENT_PROJECT_ROOT` beside the existing session marker.
6. Enforce the initial sandbox denial at the service boundary, then add the
   default-off PATH/instruction integration.
7. Add the separately enabled sidebar indicator; evaluate scoped sandbox
   capabilities and other deferred extensions only after the baseline is
   dependable.
