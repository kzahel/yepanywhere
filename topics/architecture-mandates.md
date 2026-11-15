# Architecture Mandates

> YA's load-bearing architecture requirements must be explicit enough that
> future provider, transport, and client changes preserve bounded resource use,
> recoverability, and user-visible state correctness.

Topic: architecture-mandates

See also:

- [`session-catalog-observation.md`](session-catalog-observation.md)

## Resource Quiescence

An idle provider session with no active view of that session must never create
unbounded or repeating server work. Interest in another session or a global app
activity stream is not ownership of its provider process. Closed tabs must
release server subscriptions, file watchers, poll timers, retry timers,
client-owned heartbeats, and queued catch-up work. A provider process may
remain recoverable or queryable, but it must not spin merely because a prior UI
view existed.

The resource owner for every recurring server action must be explicit:

- client-owned watches and streams are reference-counted and torn down on
  disconnect;
- provider-owned processes stop polling once the provider is verified idle or
  terminated, unless a bounded recovery operation is currently running;
- global background jobs have fixed cadence, bounded per-tick work, and no
  per-session loops created by stale client state;
- client retry/catch-up paths coalesce in-flight requests and avoid turning
  one provider event into repeated REST reads.

## Continuous Observation Without Corpus Polling

The server is the long-lived observer for install-wide summary state. Durable
compact indexes plus bounded restart reconciliation preserve that role across
brief outages; a client page request must not become the owner of a provider
corpus scan.

Global background work may continue without connected clients when it keeps a
bounded shared projection useful. One same-user process inventory, one provider
watcher/reconciliation owner, or one next-deadline scheduler is allowed. Its
cost must be bounded independently of stale session count, and changes must
target exact rows. A timer may not sweep or parse every old transcript merely
to prove nothing changed.

Client viewport, hover, and detail interest controls refresh priority and
permitted fidelity. Old offscreen rows may be explicitly stale until promoted;
live processes, provider/file events, and bounded reconciliation still keep the
global baseline moving toward fresh. Identical interest from many components,
tabs, or devices is unioned and joins one keyed asynchronous computation.

Expensive server computations use one in-flight owner per source version and
projection/fidelity key. Waiters share the result, stale completions cannot
publish over newer evidence, and one bounded failure/backoff policy replaces
per-caller retry herds.

Native observation is bounded before acquisition, not merely after failure. A
directory count, client count, or project layout controlled outside YA may not
map one-for-one onto unbounded file descriptors, native watcher registrations,
threads, timers, or subprocesses. Every watcher owner has a process-level
ceiling and a degraded mode that preserves core use without further native
allocation. `EMFILE`, `ENFILE`, `ENOSPC`, and allocation failure open a
circuit; they do not schedule attempts to reconstruct the same oversized
watcher set. An experimental or opt-in label never substitutes for that
invariant.

## Timer Ownership

Every timer in production source has an owner that can stop it. `pnpm lint`
runs `scripts/check-timer-ownership.mjs` (`pnpm timers:check` alone) over the
same production source scope as the
[growth guard](typescript-module-boundary-refactor.md#growth-guard). It
classifies each timer call from the syntax tree and bounds three classes per
file in `scripts/timer-ownership.json`:

- **Repeating** (`setInterval`): each file's entry names what the timers do
  (`kind`), what owns them and what stops them (`stops`). A repeating timer
  belongs to a process-wide owner with a fixed cadence, or to a client-held
  resource that stops when its last holder leaves. Join an existing owner
  before adding one: `lib/processIdleSweep.ts` for server idle release,
  `hooks/useRelativeNow.ts` for client clocks.
- **Zero-delay** (`setTimeout` with no delay or a literal `0`): the timer waits
  for something it does not name. Act on the event, promise or layout pass
  that makes the work ready. The recorded entries are browser event-order
  dependencies, main-thread yields inside long scans, and fallbacks where
  `requestAnimationFrame` or `Worker` is absent.
- **Dropped handle** (a `setTimeout` whose return value nothing keeps):
  nothing can cancel it when its owner goes away. Keep the handle and clear
  it on teardown. A promise that settles on a timer is reported as a sleep
  and is not bounded.

Recorded counts only shrink. A file may not exceed its count, and a file with
no entry may not gain a timer of that class. A new entry or a higher count
needs maintainer approval and a note that states the owner and stop path, or
why the timer stands. `pnpm timers:check --record` lowers counts and retires
empty entries; it never adds or raises. `pnpm timers:check --list [class]`
prints every site, including the unbounded classes: `owned`, `sleep`, `frame`
and `immediate`.

The check establishes that a handle is kept, not that it is cleared. An
`owned` timer still needs the teardown review below. A call on an injected
clock (`this.timers.setTimeout`) is not a site; the default implementation
that calls the real timer is.

The 2026-11-15 baseline recorded 64 repeating, 23 zero-delay and 22
dropped-handle timers among 589 sites. Entries that name a gap are known
defects, not accepted designs.

## Review Checklist

- Every poll, retry, heartbeat, watch, and catch-up path has a teardown path.
- A new repeating, zero-delay or dropped-handle timer is absent, or recorded
  with its owner under [timer ownership](#timer-ownership).
- Closed WebSocket/EventSource subscriptions remove server-side subscribers
  and clear timers.
- Idle sessions do not schedule per-session server work without a live owner or
  a bounded recovery reason.
- Idle process retention is keyed to viewers of that session; global app
  presence and unrelated session viewers cannot renew its deadline.
- Session-detail reads for incremental refreshes reuse cached parse state or
  have instrumentation proving the remaining work is bounded enough.
- Client-side reconnect and catch-up logic cannot create overlapping request
  storms against the same session.
- Multiple tabs/devices requesting the same catalog projection join one
  server-side computation; client-side dedupe is an optimization, not the only
  herd control.
- Watcher fan-out has a hard process-level ceiling, bounded discovery stops at
  that ceiling, and resource exhaustion cannot enter an allocation retry loop.
- Disabling an optional observer releases its existing watches and timers and
  rejects stale-client acquisition at the server boundary.
- Periodic host/process reconciliation performs no unrelated provider
  transcript reads, and unchanged cold sessions receive no timer-driven parse.
