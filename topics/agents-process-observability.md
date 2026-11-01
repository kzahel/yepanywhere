# Agents Process Observability

> Agents is YA's host process observability view, inventorying
> YA-supervised and externally launched local provider processes with bounded
> OS metrics while keeping process health distinct from Inbox attention.

Topic: agents-process-observability

See also:

- [`agents-activity-preview.md`](agents-activity-preview.md) — the separate
  optional answer to “what is each supervised agent doing?”
- [`inbox.md`](inbox.md) — the session-attention view; process existence and
  resource use do not imply that a session needs attention.
- [`session-ownership.md`](session-ownership.md) — today's `external` session
  ownership is a recent-transcript-write heuristic, not OS process evidence.
- [`provider-state-machine.md`](provider-state-machine.md) — provider state and
  safe controls for processes YA supervises.
- [`agent-working-directory-tracking.md`](agent-working-directory-tracking.md)
  — an observed process working directory must not silently reclassify a
  session's effective project.
- [`architecture-mandates.md`](architecture-mandates.md) — sampling must stop
  when no visible client owns it, except for the bounded process-existence
  inventory used by session-catalog observation.
- [`session-catalog-observation.md`](session-catalog-observation.md) — the
  process inventory may remain fresh without turning into transcript polling.
- [`server-capabilities.md`](server-capabilities.md) and
  [`remote-hosted-compatibility.md`](remote-hosted-compatibility.md) — a new
  host-process route requires an exact capability gate.
- [`security.md`](security.md) — authenticated host diagnostics must stay out
  of public-share surfaces.

## Verified Prior Shape

Before this feature, Agents showed the YA Supervisor inventory, not the host's
agent process inventory:

- `AgentsPage` reads `useProcesses`, which fetches
  `GET /api/processes?includeTerminated=true`.
- `Process.getInfo` supplies YA process state, Supervisor start time, queue
  depth, and an optional provider child PID. The route enriches those rows with
  session title, provider, model, context usage, and provider children.
- The page groups YA-owned rows into Active and Idle, plus a bounded list of
  recently Stopped YA rows. It already renders PID and Supervisor uptime when
  available, but it has no CPU or memory sampler.
- `ExternalSessionTracker` marks a session `owner: "external"` after a recent
  provider transcript write and decays that guess after roughly 30 seconds. It
  does not discover a foreign PID, prove that a process remains alive, or feed
  an external row into Agents.

Kyle's “active agent processes” description was therefore the right product
direction but broader than that implementation. The host observation route and
External section close that gap without changing the Supervisor inventory's
control semantics.

## Surface Boundaries

| Surface | Primary question | Source of truth |
| --- | --- | --- |
| Inbox | Which sessions need attention, are active, recent, or unread? | Session, pending-input, queue, and notification state. |
| Agents | Which agent processes exist on this YA host, who supervises them, and what resources are they using? | YA Supervisor state plus the retained process-existence inventory and request-driven metric samples. |
| Agents activity preview | What is each YA-supervised agent doing now? | Bounded normalized provider activity, when explicitly enabled. |
| Session detail | What happened in this conversation, and what can I do next? | Provider transcript and live session control state. |

External process rows must never enter Inbox merely because their PID exists or
their CPU is nonzero. Conversely, an external transcript write may make a
session relevant to Inbox without YA having enough evidence to identify a
corresponding OS process.

## Product Shape

The server-owned **Agents process metrics** option is default-on and can be
disabled under Settings > Performance. This is an explicit product exception
to [`vanilla-defaults.md`](vanilla-defaults.md), authorized by graehl on
2026-07-28: a user who does not want the feature can disable it, while someone
who never opens Agents causes no CPU/RSS metric sampling. With it off:

- Agents remains observably unchanged;
- no host-process route is requested by the client; and
- YA does not enumerate foreign processes or retain CPU samples.

With the option on, the compact process-existence/classification inventory may
continue under one bounded server owner even when Agents is closed. It retains
only the minimized identity needed for provider/root/session correlation and
diffs later snapshots. CPU rate and expanded tree metrics remain request-owned
by visible Agents consumers and stop when their last owner leaves.

With it on:

1. Existing YA-owned Active and Idle cards gain host metrics when their local
   provider PID can be sampled.
2. Agents adds an **External** section between Active and Idle for live,
   high-confidence provider processes not owned by this Supervisor.
3. Recently Stopped remains YA history. YA must not manufacture stopped
   history for a foreign process that simply disappeared between samples.

An External row is explicitly read-only. It carries an **Outside YA** badge and
has no Kill, Interrupt, queue, model, permission, or approval action. Adding
attach/adopt/stop behavior would require a separate provider-specific safety
contract; process discovery does not authorize control.

### Compact metrics and details

The minimum useful glance is:

```text
812 MiB RSS · 3% CPU · 18m
```

The compact cluster may stay inline where it fits. It must also open an
accessible tooltip/popover on pointer rest or keyboard focus and on tap for
touch users. On touch layouts, tapping a non-interactive part of an External
card also toggles that card's metric popover; actual buttons and links keep
their own behavior, and tapping elsewhere dismisses the popover. A native
`title` alone is insufficient because Agents is mobile-first.

The activated detail popover shows:

- managed by YA or Outside YA;
- provider and PID;
- process start time and age;
- recent root-process CPU, including its sample window;
- resident memory for the agent root and its process tree;
- descendant process count;
- sample age; and
- the exact YA Supervisor association when one is known.

The initial delivery stays in Agents. Reusing its metric formatters in Process
Info is appropriate if that surface later adopts the same facts, but this
feature does not add a second polling owner merely to populate that dialog.

## Metric Semantics

Metrics are nullable observations, not provider state:

| Metric | Contract |
| --- | --- |
| Process age | `sampledAt - OS process startedAt`. It is neither session age nor “time since YA detected it.” Existing Supervisor uptime may remain separately available for diagnostics. |
| Recent CPU | Delta of cumulative user + system CPU time over the actual sample interval. The compact metric covers the identified process tree; details separate tree and root rates. `100%` means one logical CPU fully occupied; a multithreaded tree may exceed `100%`. The first observation has no CPU rate. |
| Root RSS | Resident set size of the identified agent root process. It is not V8 heap, virtual memory, context usage, or model memory. |
| Tree RSS | Approximate sum of resident set size for the root and its sampled descendants, available in process details. Shared pages may be counted once per process. |
| Descendants | Count observed in the same process-tree snapshot used for Tree RSS. |
| Sample age | Time since `sampledAt`; stale CPU rates are omitted rather than presented as current. |

Zero CPU does not mean idle, waiting for input, wedged, or safe to stop. Nonzero
CPU does not prove a model turn is progressing. Only YA-owned provider state
may use the existing `in-turn`, `waiting-input`, and `idle` labels.

Do not add virtual memory, host load average, I/O rates, thread count, file
descriptor count, or graphs to the first slice. They can follow when a concrete
diagnostic question needs them; the three requested signals above already
cover footprint, recent work, and lifetime.

### Local development process tree

`pstree.sh` is the Linux operator view for attributing local development
processes; it is not part of the client route or its wire contract. Each run
discovers live YA roots from an exact `scripts/dev.js` argv token in a
`yep-anywhere` working tree, so it survives PID changes and does not trust a
saved PID. It samples `/proc` over the requested interval (one second by
default) and prints:

- PID and `/proc/<pid>/comm`, the same short `COMMAND` name shown by `top`;
- a sanitized YA/provider owner such as `YA server`, `YA host: Codex`,
  `Codex harness`, `YA parser worker`, Vite, or esbuild;
- direct process CPU, virtual allocation, and RSS to the left of `|`; and
- descendant-inclusive `ΣCPU`, `ΣVIRT`, and `ΣRSS` to the right.

`MainThread` is a generic Node process name, not a YA role. PID plus the tree
and owner column supplies the attribution. `100%` sampled CPU is one fully used
core. Direct RSS is resident physical memory for that process; direct VIRT is
its reserved/mapped address space, not physical consumption. Tree sums are
attribution totals: shared pages and mappings may be counted once per process,
so `ΣRSS` is not unique proportional-set memory and `ΣVIRT` is not a host
commitment. The script excludes its own observer process and never prints argv,
environment values, or raw paths.

## Host Discovery And Identity

Discovery is isolated in the server sampler, not embedded in the route or
`AgentsPage`. The initial high-confidence classifier recognizes exact provider
executables and known entrypoints launched through generic runtimes. The
scanner:

1. takes one same-user host process snapshot;
2. identifies canonical provider roots;
3. joins known YA child PIDs to Supervisor process IDs;
4. removes duplicate helper/wrapper descendants; and
5. reports unmatched canonical roots as external.

A provider-looking descendant of another recognized agent root is not a second
top-level Agents row in the first version. Its resources remain in the
ancestor's Tree RSS. This avoids duplicate app-server/helper rows and
double-counted process trees while still finding independently launched CLI or
desktop agents.

Use PID plus OS start time as observation identity. PID alone is unsafe because
the OS may reuse it after a process exits.

False negatives are preferable to false positives. A basename collision or
ambiguous wrapper must not expose an unrelated host process as an agent.
Matcher additions must be tested against the actual launch shapes YA supports
on each platform.

### Session correlation

Process discovery and session correlation are separate:

- A YA-owned PID has an exact Supervisor process/session join.
- A foreign process may link to a session only when a provider-native session
  ID, verified pid/lock record, or other exact provider contract establishes
  the association.
- Transcript mtime proximity, matching project directory, low CPU, and “only
  one candidate exists” are not enough.
- An uncorrelated external row remains useful as
  `Codex · Outside YA · PID 1234`; it must not invent a session title or make
  the whole card a broken session link.

The current `ExternalSessionTracker` may decorate a future exact join, but its
30-second write window cannot create one.

Claude Code provides the first exact record: it writes
`<CLAUDE_CONFIG_DIR>/sessions/<pid>.json` with the session id, cwd and start
time of each live process. The native classifier reads it for an external
Claude root and accepts it only when its pid matches and its start time is
within two seconds of the observed process's, so a reused PID never inherits a
dead process's session. The record's cwd stays on the server and does not
select a transcript project. Scoped catalogue evidence supplies the public
title and, only when the public and native ids agree, a legacy project link
as described below. A recorded session YA does not know shows as
`Claude session <id prefix>` without a link; other providers
stay uncorrelated until they offer an exact record. Correlation and the title
lookup are reused per process identity for a minute, so metric refreshes do not
repeat session enrichment.

Claude Code also runs its bundled `ugrep` and `rg` by re-executing its own
binary under those names. The kernel command name then reads `claude`, so the
classifier trusts the invoked name and does not report them as agents.

### Continuous inventory extension

Accepted 2026-08-05; not yet implemented. When Agents process metrics are
enabled, YA takes one same-user process snapshot after retained provider
runtimes reattach. It classifies every known provider harness root, subtracts
exact Supervisor/runtime-host ownership, and retains the unmatched external
inventory before any client route asks for it. On the measured Linux host, the
underlying whole-table `ps` snapshot took 0.01 seconds and about 4.1 MiB maximum
RSS.

One process-wide bounded cadence keeps that existence inventory current. Each
pass diffs PID plus OS start identity and targets changed recognized roots; it
does not open provider transcript stores or create a loop per session. It
supplies process existence, provider, and exact association when available.
Opening Agents may continue the existing five-second request-owned CPU/RSS tree
sampling, and leaving Agents stops that richer sampler.

Process discovery does not open provider transcript stores. Command/entrypoint
classification and exact native session-id extraction belong to the provider
adapter described in [provider-abstraction](provider-abstraction.md). A
recognized root is correlated to a session only when its provider exposes the
id through argv, a pid/lock record, or another exact contract. The raw command
text is discarded immediately. A provider never used to start a YA session may
still appear as an uncorrelated external process; its native session store
remains excluded from boot Inbox discovery until first successful YA use.
Implementation is handed off in
[`docs/tactical/093-provider-session-reconciliation.md`](../docs/tactical/093-provider-session-reconciliation.md).

## Data And Route Boundary

The wire shape is intentionally unable to carry process command metadata:

```ts
interface HostAgentProcessObservation {
  observationId: string; // stable for PID + OS start time
  pid: number;
  provider: ProviderName;
  supervision: "ya" | "external";
  supervisorProcessId?: string; // exact YA join only
  sessionId?: string; // external: from the provider's pid record only
  projectId?: UrlProjectId; // verified legacy backlink: YA id equals native id
  sessionTitle?: string; // its YA display title, beyond "Untitled"
  startedAt: string;
  sampledAt: string;
  cpu?: {
    rootPercent: number;
    treePercent: number;
    windowMs: number;
  };
  memory: {
    rootRssBytes: number;
    treeRssBytes: number;
    descendantCount: number;
  };
}
```

This is exposed through the authenticated
`GET /api/host-agent-processes` route, guarded by a permanent
`host-agent-process-observability` server capability. Keep
`GET /api/processes` authoritative and unchanged for Supervisor state and
control. The client joins an owned observation through
`supervisorProcessId`; it does not reinterpret external observations as
`ProcessInfo`.

This separation avoids three compatibility failures:

- an older client never receives an external row with controls intended for a
  YA-owned `ProcessInfo`;
- a new client makes no unsupported request to an older server; and
- metric refresh does not repeatedly invoke the existing process route's
  session-summary enrichment.

The implementation audit covered stable releases `v0.7.0` (2026-07-25) and
`v0.6.2` (2026-07-11), neither of which exposes this route or capability.
Without the new capability, the client hides host metrics and External
entirely, retains current Agents, and makes no host-process request. Existing
capability meanings and older capable behavior remain unchanged.

### Native PID correlation and permanent YA ids

An external observation's `sessionId` remains the provider-native id from its
PID record. It is not changed to a YA id when those ids differ. The optional
YA title comes from the scoped reverse binding's public metadata. A native
spelling that is another public metadata key supplies no title to this join.
The optional `projectId` forms a legacy URL with `sessionId`, so it is emitted
only when the verified YA id equals that native id. With unequal ids, the row
keeps its native diagnostic id and optional title without that unsafe backlink.
No new capability or wire field is needed for these optional omissions.

PID/start-time evidence establishes the native id. Catalogue evidence must
then establish one matching source within the PID reader's configured,
canonical native projects namespace. Current cwd cannot select a birth project
or distinguish duplicate native ids in that namespace. Missing namespace,
missing scoped catalogue evidence or duplicate matches leave the process
unlinked. Other providers and unconfigured private namespaces keep their
existing raw/unavailable correlation behavior; YA does not search unrelated
configuration homes or infer a source from timing or cwd.

Eligible uncached process records share one retained catalogue read and bounded
operation-scoped matching pass, within the existing per-PID/start-time
correlation TTL. Sampling opens no native transcript store and starts no new
scanner or recurring timer. This optional read neither initializes native
discovery nor schedules a refresh; normal collection observation owns that
work. A catalogue not yet published can leave optional
facts absent until a later correlation refresh. Disabling observation or
closing the app cancels pending native/catalogue work before identity storage
teardown; delayed completion cannot adopt or query a retired identity owner.

## Sampling And Resource Lifetime

Recent CPU needs two samples, but it does not need a permanent server timer.
Lifecycle:

- once after retained-runtime reattach, the server takes one boot snapshot
  when host process observability is enabled;
- while Agents is visible, the client requests one lightweight host snapshot
  about every five seconds;
- pause when the page is unmounted or the document is hidden;
- each request reads the process table once, never once per row;
- the server coalesces simultaneous requests into one short-lived snapshot;
- a bounded previous-sample map keyed by PID + start time supplies CPU deltas
  and prunes vanished identities; and
- disabling the option drops the sample cache.

The server performs no repeating work when no client asks. A remote or hosted
client observes the host running its connected YA server; it does not inspect
the browser device. SSH executor processes, containers outside the YA host
namespace, and other YA servers are out of scope for the first version.

Linux and macOS use one whole-table `ps` snapshot per sample, never one command
per PID. The snapshot is reduced immediately to PID/parent/start time,
cumulative CPU, RSS, and a high-confidence provider classification. Linux then
reads high-resolution CPU ticks from `/proc` only for the identified roots and
their descendants; this avoids presenting whole-second `ps` CPU time as a
five-second rate. Windows returns an explicit unsupported state and can follow
behind the same route contract.

## Security And Privacy

Host process enumeration is an authenticated operator feature:

- never expose the route through public session shares;
- never send a full command line, command fragment, environment variable,
  executable path, or working directory to the client;
- inspect argv only long enough to classify a provider, then discard it;
- never put raw argv in logs, errors, test fixtures, or result captures because
  prompts, paths, and credentials may appear there; and
- omit a row or metric when OS permissions prevent a reliable observation.

An authenticated client with interactive session write access can already ask
an agent to inspect same-user processes, subject to the provider's permission
and sandbox policy. Public-share viewers cannot submit such a request. That
bounds the incremental sensitivity of normalized agent identity and ordinary
CPU/RSS/age metrics, but it does not justify sending argv: a command line can
contain prompts, secrets, and paths unrelated to what the Agents view needs.
Relay encryption protects the transport but does not weaken this server-side
minimization rule.

## Observable Contract

- With Agents process metrics off, Agents retains its Supervisor inventory and
  makes no host-process request.
- Without the server capability, the client makes no unsupported request. An
  advertised but unsupported host returns one unsupported response and the
  visible page stops polling.
- YA-owned rows retain their existing state, controls, ordering, and stopped
  history; host metrics only decorate them.
- Every external row corresponds to a currently observed, high-confidence
  provider process not owned by this Supervisor.
- External rows are read-only and never appear in Inbox merely due to process
  existence.
- CPU is labeled as a recent sampled root-process rate, memory distinguishes
  root RSS from approximate process-tree RSS, and age is OS process age.
- Missing or stale metrics render as unavailable, never zero.
- No row infers provider activity, attention, ownership, or safety from CPU or
  memory.
- Session links and titles appear only after exact process/session
  correlation. Every row names its session id in a tooltip and in its metric
  details when one is known.
- A YA row's age is its OS process age when host metrics observe it; a hosted
  provider process outlives YA restarts, so YA's attach time appears only in
  the age tooltip.
- The session fields are optional and absent from older servers, so a newer
  client shows `<Provider> process` for their external rows as before; no
  capability gates them.
- With host process observability enabled, one post-reattach boot snapshot
  exists before Agents first opens; it starts no repeating sampler and opens no
  provider transcript store.
- On touch layouts, a non-control tap on an External row toggles its metric
  details; controls are never intercepted and an outside tap dismisses them.
- Leaving or hiding Agents stops client sampling; no stale page leaves a
  server poller, timer, watcher, or retry loop behind.
- Full or partial argv, environment data, executable paths, working
  directories, and unrelated host processes never cross the API boundary.

## Delivered Scope

The first delivery includes owned metrics, high-confidence external inventory,
the capability-gated route, CPU delta cache, read-only External cards, and
pointer/keyboard/touch metric details. External rows intentionally have no
session links: exact provider correlation remains future provider-specific
work and must use verified native evidence rather than timing or cwd guesses.

The activity-preview proposal can proceed independently. It consumes provider
events for YA-owned sessions; host observability consumes OS snapshots and must
not become a second transcript/activity pipeline.

## Non-Goals

- A general-purpose host task manager.
- Killing, interrupting, adopting, or reconfiguring external processes.
- Guessing provider state or user attention from resource use.
- Listing every provider transcript or recently modified external session.
- Showing every tool subprocess as its own agent row.
- Persisting metric history or drawing long-term resource graphs.
- Inspecting remote SSH hosts or arbitrary containers.
- Exposing command lines, environments, or unknown working directories.

## Future Questions

- Which external launch shapes can each provider identify with sufficiently
  low false-positive risk on Linux and macOS?
- Should the compact card always show all three metrics, or show age inline
  and keep CPU/memory in the detail popover on narrow layouts?
- Which providers expose exact external PID/session correlation without
  relying on transcript timing or open-file heuristics?
