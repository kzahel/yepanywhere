# Architecture

Entry point for understanding how Yep Anywhere is shaped. Read this first
before changing message-flow, transport, or render-path code, and before
proposing cross-cutting refactors.

This file is intentionally short — each link below is the load-bearing
detailed doc. Update this file when the high-level picture changes; update the
linked docs when the details change.

## Shape

```
┌──────────────┐    ┌──────────────────────────┐    ┌────────────────────┐
│ provider CLI │ ── │ Process (per session)    │ ── │ WebSocket clients  │
│ (Claude SDK, │    │  rolling replay buffer + │    │  (browser, mobile, │
│  Codex, ...) │    │  streaming-text catch-up │    │   relay-mediated)  │
└──────────────┘    └──────────────────────────┘    └────────────────────┘
                              │
                              └─ EventBus ── activity subscribers
                                 (file watches, process state,
                                  session lifecycle, network)
```

- **Server** is a Hono app plus a per-session `Process` supervisor and a
  global `EventBus`. Fan-out is synchronous in-process pub/sub. There is no
  central message queue and no per-client outbound buffer; the wire is the
  buffer.
- **Client** is a React app with one `ConnectionManager` singleton coordinating
  reconnect across multiple subscriptions. Distributed hook-and-context state
  (no Redux/Zustand). Streaming text and markdown go through ref-based DOM
  updates with adaptive 100–750 ms throttling, not React state per token.
  [`topics/client-source-runtime-topology.md`](topics/client-source-runtime-topology.md)
  records the desired next source-runtime boundary above the current
  one-source-at-a-time UI.
- **Relay** (optional) is a dumb pipe carrying NaCl-encrypted frames between
  client and server when neither has a routable address to the other.
- **Push broker** (optional, native-app path) is a separate Hono/SQLite service
  under `packages/push-broker/`. It stores revocable device-delivery
  capabilities and submits bounded generic notifications through an injected
  provider. It is not part of provider session routing or the encrypted relay.
- **Mobile companions** use native platform shells and notification delivery.
  Android is a first-class Gradle/Kotlin application with Compose as the first
  native foreground target; its Android-owned WebView keeps the bundled client
  as a permanent full-fidelity alternative for users and surfaces that prefer
  the complete web interface. The Kotlin connection core owns native SRP,
  direct/relay transport, and foreground-service subscriptions. The bundled
  WebView should normally consume that connection through a bounded
  `SourceTransport` adapter so opening the complete interface does not ask the
  user to authenticate twice; Compose, background work, and the WebView hold
  source-scoped logical leases on native-owned connections. Each paired profile
  keeps independent SRP state and failure lifecycle; compatible relay profiles
  may share one physical relay-mux socket below that boundary. Native
  multi-host demand and mux ownership land before the WebView data adapter so
  the adapter never bakes in a single global host. An independently
  authenticated TypeScript WebView transport remains a valid future
  alternative if measurements justify it, but no credential handoff or child
  session is part of the baseline. Tauri Mobile has been removed and is
  unrelated to the separate desktop Tauri application. iOS follows later with
  SwiftUI.

## Provider runtime ownership and reload

On a capable Linux or macOS Node source-checkout non-watch development launch, `scripts/dev.js` owns a shared
provider host outside the replaceable Hono process. One worker per session owns
the real provider adapter, SDK/TUI transport, message queue, callbacks, and
sequenced output; Hono's `Process` talks to it through an `AgentSession` proxy.
When that host is unavailable, provider ownership remains inside Hono and the
ordinary safe-restart behavior applies.

Shared-host use is capability-driven and automatic, not a user toggle. The
former Codex-native setting remains accepted and stored for compatibility, but
is inert and hidden; Codex uses the shared host like every other provider.

**Safe Reload replaces Hono and Vite, preserving the provider host.** Existing
shared-host workers intentionally keep the provider code and launch facts they
started with. A newly launched worker uses current provider code, a targeted
worker relaunch updates that one session, and a provider-host reboot guarantees
every provider worker adopted
provider-layer changes (a full wrapper reboot does this when the wrapper owns
the host). The UI's immediate reload is
available only when each active blocker has a detachable hosted owner and no
volatile queued input; **Reload When Safe** remains the fallback otherwise.

The provider host listens on private mode-0600 Unix sockets using
token-authenticated, versioned JSONL. Stable same-user discovery, foreground
headless startup, attach-or-start recovery, bounded host-mediated session
turns, and the authenticated Hono adapter are implemented. Worker sockets
remain private; auxiliary clients submit through the incumbent worker queue,
never acknowledge Hono's replay stream, and never become a second Hono
controller. See
[`topics/provider-host-api.md`](topics/provider-host-api.md) and
[`topics/reload-safe-provider-runtimes.md`](topics/reload-safe-provider-runtimes.md).

Single-user / small-team scale is assumed throughout — see the cleanups
section below for what would have to change at higher fan-out.

## Detailed docs

- [`docs/project/server-message-routing.md`](docs/project/server-message-routing.md)
  — provider event → Process → fan-out → wire; late-join replay; the small
  per-file cleanup proposals.
- [`packages/client/RENDERING_PERFORMANCE.md`](packages/client/RENDERING_PERFORMANCE.md)
  — the React render/update pipeline, what's coalesced, what stays immediate,
  the streaming-markdown ref pattern, and the review checklist.
- [`topics/client-source-runtime-topology.md`](topics/client-source-runtime-topology.md)
  — vision for explicit per-source client runtimes so local/direct/relay YA
  servers can own their API transport, activity stream, summary stores, and
  session-detail services without hidden current-source globals.
- [`topics/managed-remote-executors.md`](topics/managed-remote-executors.md)
  — default-off manual-SSH baseline for controller-owned remote sessions:
  injected provider-neutral runners, controller-prepared Git workspaces,
  Codex-first validation, and fetched incoming heads without target upstream
  credentials; staged implementation is tracked in
  [`docs/tactical/119-managed-ssh-executor-baseline.md`](docs/tactical/119-managed-ssh-executor-baseline.md).
- [`topics/managed-runner-execution-targets.md`](topics/managed-runner-execution-targets.md)
  — broader target-provider proposal extending managed remote execution with
  Machine Control discovery, claims, VM lifecycle, and location-correct project
  UI boundaries; its implementation tactical is deferred until the manual-SSH
  baseline works.
- [`topics/federated-super-sessions.md`](topics/federated-super-sessions.md)
  — proposal for one canonical, single-writer YA session that can transfer a
  provider-specific portable bundle and active ownership between trusted YA
  peers while the client follows the same session identity.
- [`topics/reload-safe-provider-runtimes.md`](topics/reload-safe-provider-runtimes.md)
  — implemented wrapper-lifetime provider ownership, Hono reattachment,
  replay, cleanup, availability gates, and verification matrix.
- [`topics/provider-host-api.md`](topics/provider-host-api.md) — current private
  host/worker protocols, stable same-user discovery, headless bootstrap,
  attach-or-start recovery, bounded session turns, receipts, and the
  authenticated Hono adapter.
- [`topics/agent-command-runtime.sketches.md`](topics/agent-command-runtime.sketches.md) —
  proposal for one npm/desktop-bundled `ya-agent` dispatcher, per-session PATH
  and scoped-authority projection, private input, and reuse by session-access
  and yacron clients without parallel service logic.
- [`topics/yacron.md`](topics/yacron.md) — proposal for a generally running
  scheduler/CLI with provider-host-integrated and standalone variants. Only the
  integrated variant owns YA queues, atomic project admission, canonical
  session dispatch, and the retained launch request usable by Project Queue.
- [`topics/provider-installation-updates.md`](topics/provider-installation-updates.md)
  — shared installation-family lifecycle for provider update mutation,
  runtime leases, verified generations, and catalog/cache convergence.
- [`topics/cross-host-delegation.md`](topics/cross-host-delegation.md) — broad
  product direction for browser-known hosts, directed server-to-server grants,
  and separate native worker sessions as a useful step before session
  migration.
- [`topics/session-id-remap.md`](topics/session-id-remap.md) — problem
  statement for startup-time temporary session IDs that later canonicalize,
  including the activity event and client summary-store merge shape needed to
  avoid duplicate sidebar/list rows.
- [`topics/source-transport.md`](topics/source-transport.md) — proposal for a
  source-bound transport facade that makes localhost, plain multiplex
  WebSocket, and secure/relay modes explicit without hiding channel status.
- [`topics/relay-client-mux.md`](topics/relay-client-mux.md) — compatibility-
  gated optional transport carrying several independently authenticated YA host
  circuits over one browser-to-relay WebSocket while preserving `/ws`.
- [`topics/session-detail-data-layer.md`](topics/session-detail-data-layer.md)
  — lower-level vision for a canonical client session-detail data layer
  between provider stream/REST inputs and transcript DOM rendering; see the
  linked tactical plan before reshaping `useSession`, `useSessionMessages`,
  transcript augments, subagents, or same-tab message caches.
- [`topics/portable-transcript-compiler.md`](topics/portable-transcript-compiler.md)
  — approved direction for a stable server ingest kernel, bounded transcript
  windows with prefix facts, and a versioned presentation compiler shared by
  web, Android, and iOS while platform renderers remain native to each surface.
- [`topics/conversation-view.md`](topics/conversation-view.md) — compact default
  transcript projection that preserves user/agent text, media, and important
  failures while summarizing routine per-turn activity; selected as the first
  native session-detail presentation.
- [`docs/project/mobile-companion-app.md`](docs/project/mobile-companion-app.md)
  — Android-first native companion product shape, permanent bundled full-web
  alternative, notification/inbox scope, and later SwiftUI iOS counterpart.
- [`topics/mobile-server-pairing.md`](topics/mobile-server-pairing.md) —
  approved boundary between app-local paired-server profiles, durable paired
  devices, expiring SRP resume credentials, native Kotlin transport,
  a bundled-web lease over that transport, resume-authenticated direct/relay
  discovery, and push enrollment; an independent bundled-web session remains
  a possible later optimization and public installation identity is deferred.
- [`topics/security-client-audit.md`](topics/security-client-audit.md) —
  unified cross-platform client registration, P-256 continuity keys,
  recognizable audit fingerprints, bounded per-client history plus a
  revocation-surviving server security ledger, legacy web projection,
  cascading revocation, opt-in new-client alerts, native push ownership, and
  future WebAuthn/platform-attestation assurance.
- [`docs/tactical/080-first-class-android-shell.md`](docs/tactical/080-first-class-android-shell.md)
  — removal of Tauri Mobile, first-class Gradle/Compose ownership, explicit
  bundled/hosted WebView channels, and the exact-origin native-host message
  contract.
- [`topics/stream-persisted-render-parity.md`](topics/stream-persisted-render-parity.md)
  — graded convergence contract between the active live tail and the durable
  provider transcript: strong structural stability for paired tool calls,
  bounded optimistic/live-only detail near the tail, and no YA shadow
  transcript replacing provider persistence as source of truth.
- [`topics/project-directory-storage.md`](topics/project-directory-storage.md)
  — app-data-only default for YA-managed state, explicit global project-local
  opt-in, the complete project/Git writer audit, and hosted capability rollout.
- [`topics/storage-settings.md`](topics/storage-settings.md) — first-pass
  Storage Settings contract: YA data directory vs. project `.yep`, lazy media
  by default, and unbounded preservation of new managed-session images as a
  separate opt-in.
- [`topics/session-media-handles.md`](topics/session-media-handles.md) —
  authenticated lazy transcript media handles, default-off durable
  preservation, and the correction to unconditional project materialization.
- [`topics/disk-full-degraded-mode.md`](topics/disk-full-degraded-mode.md)
  — problem statement and latent proposal for keeping relay/local control
  paths alive when optional disk writers hit `ENOSPC`.
- [`docs/project/connection-matrix.md`](docs/project/connection-matrix.md) —
  the four client transport modes (Direct / WS / SecureConnection /
  SecureConnection-via-relay) and which auth/encoding each uses.
- [`docs/project/ws-auth-state-model.md`](docs/project/ws-auth-state-model.md)
  — admission policy (`local_unrestricted` / `local_cookie_trusted` /
  `srp_required`) and the SRP transport state machine.
- [`topics/active-content-security.md`](topics/active-content-security.md) —
  confirmed browser-assisted privilege path from same-origin agent-authored
  HTML, the source-first active-file contract, and the isolated-origin
  requirement for executable project applications.
- [`docs/project/2026-01-05-server-side-rendering.md`](docs/project/2026-01-05-server-side-rendering.md)
  — server-rendered markdown / diff / file-highlight augments that the client
  consumes through the streaming path.
- [`docs/project/relay-design.md`](docs/project/relay-design.md) — the
  end-to-end-encrypted relay; the "dumb pipe" contract.
- [`topics/android-fcm-push.md`](topics/android-fcm-push.md) — approved
  direction and current credential-free service contract for native Android
  notification subscriptions, the hosted FCM push broker, privacy modes, and
  deliberately deferred registration-lifecycle details.

## Bespoke vs. standard — and what to learn from it

There are three options for any small mechanism, not two:

1. **Pull in an external library.** Best when the library is audited,
   broadly used, and YA has no need to fix or change it. The Contribution
   Ethos in [`DEVELOPMENT.md`](DEVELOPMENT.md) lists the standing exemptions
   (NaCl, bcrypt, SRP-6a, Hono, Shiki, official provider SDKs). New deps
   beyond those need a clear bug-avoidance vs. complexity-exposure argument —
   familiarity of the name is not enough.
2. **Hand-rolled minimal version using the popular library's names and
   concepts.** Often the best choice for narrow utilities (debounce, ring
   buffer, EventEmitter, adaptive throttle, simple cache). YA owns the code
   so the "can't fix upstream" blocker vanishes; new contributors still see
   familiar vocabulary and learn transferable concepts. This is *not* a hard
   fork — implement only the surface YA actually uses, not a competing
   reimplementation of the upstream library's full API.

   **Where it lives:**
   - **Single function** (debounce, formatBytes, parseSGR, …) — an
     independent file, either in a small `utils/` neighborhood or co-located
     next to its one use. No package boundary; no test infrastructure beyond
     a unit test alongside.
   - **Multi-function mini-library mirroring a standard concept** (an
     EventEmitter-shaped `Topic<T>`, a `RingBuffer`, an
     `AdaptiveThrottle` hook) — its own module with a clear boundary:
     a single file under `packages/shared/src/` (or a workspace package if
     reuse across packages warrants it), with its own test file. The
     boundary is what makes "this is the standard concept, named the
     standard way, scoped to what we need" legible to a new reader.
   The size threshold between the two is judgment, not a number; if a
   utility grows multiple related functions or holds state, it's earned its
   own module.
3. **Bespoke names and shape.** Reserve for code where the YA-specific
   semantics genuinely don't match any standard pattern (e.g. the
   server-rendered streaming-markdown augment path, or the SRP+NaCl relay
   envelope). When you do this, document the closest standard concept the
   reader should think of, even if it's a loose analogy.

The goal of the per-mechanism notes in `server-message-routing.md` and
`RENDERING_PERFORMANCE.md` is to make those mappings explicit — EventEmitter
pub/sub, ring buffer for replay, adaptive throttling, ref-based DOM patching,
SRP-6a authenticated key exchange — so that:

- a contributor new to web dev recognizes what they're reading and picks up
  vocabulary that transfers to other React/Node projects, not only to YA;
- an agent (or future-us) given an unfamiliar file has the standard keywords
  to search for, reason about, and discuss with the user.

If you spot bespoke code without a clear mapping back to a standard concept,
adding that mapping to the relevant doc is welcome on its own — independent
of any decision to refactor.

## Large-scope refactor proposals

These are **proposals, not commitments.** They record direction so a future
reader can tell what's been considered and under what conditions it would
become worth doing — not so the next contributor enacts them.

Small, file-local cleanups live next to their code (e.g. the table at the end
of `server-message-routing.md`). This section is for **architectural** changes
— ones that cross packages, change a cross-cutting invariant, alter the
fan-out or persistence contract, or need design-level discussion before
implementation. Each entry should make the trigger explicit so the proposal
isn't enacted prematurely. Where an entry mentions a possible library, treat
that as one option among the three above (library / minimal hand-rolled /
bespoke), not a recommendation.

### Outbound buffering / per-listener async dispatch

**Problem today.** `Process.emit()` calls every listener inline on the main
event loop. A listener whose body does real work (rather than just `ws.send`)
stalls all peers for that Process for the duration of its work.

**Proposal.** Introduce a per-subscription microtask queue between
`Process.emit` and the WS send, so the listener body can return immediately
and the actual encode/send happens off the emit hot path.

**Cost.** Real complexity: ordering guarantees across `message`, `state-change`,
and `tool-approval`; drain semantics on unsubscribe; error propagation when
the queue overflows.

**Benefit.** Subscriber isolation; a single slow tab or augmenter call can't
delay other tabs.

**Trigger.** Defer until a witnessed regression where one client's work
visibly slows others. Today the SDK iterator paces input and `ws.send` is
non-blocking; no observed pain.

### Auth on the maintenance server

**Problem today.** `packages/server/src/maintenance/server.ts` (port `+1`)
relies on localhost binding plus a CORS-aware origin check. On a single-user
dev box this is fine. On a shared or multi-user host, any local user can
toggle log levels, force `/reload`, or open the inspector.

**Proposal.** Add a token model (one-time token written to the data dir at
startup, read by curl/scripts that need it). Keep the localhost binding;
treat the token as defense in depth.

**Cost.** Designing the token model (rotation, format, persistence path,
`--no-auth` escape hatch for tests) plus updating every documented `curl`
example.

**Benefit.** Defense in depth; YA can be safely enabled on multi-user dev
hosts or transient cloud VMs.

**Trigger.** Defer until YA actually runs somewhere multi-user, or a
threat-model review flags the gap. Note in `AGENTS.md`/`DEVELOPMENT.md` if
multi-user becomes a target.

### Unified pub/sub abstraction

**Problem today.** `Process.listeners` and `EventBus.subscribers` are both
`Set<(event) => void>` with the same subscribe/emit/cleanup shape, defined
independently. A third pub/sub would tempt a copy.

**Proposal.** Extract a tiny `Topic<T>` helper (~30 LOC) with `subscribe`,
`emit`, `size`, and a hook for metrics/limits. Migrate both call sites.

**Cost.** Small in lines; the cost is conceptual — making the simplest
possible thing (a `Set`) one indirection less obvious.

**Benefit.** One place to add fan-out metrics, per-subscriber rate limits, or
async dispatch (see "Outbound buffering" above) when the time comes.

**Trigger.** **Wait for the third pub/sub.** Two call sites does not justify
the abstraction; introducing it now is the kind of premature reshape the
Contribution Ethos warns against.

### Higher-scale fan-out (queue / shared bus)

**Problem today.** Synchronous `for (const listener of this.listeners)` works
to maybe ~100 concurrent listeners per Process. A user with many open tabs or
a multi-user deployment with broadcasted activity events would eventually feel
this on the main loop.

**Proposal.** Move fan-out off the main loop (worker thread, or yield via
`setImmediate` between batches), and/or coalesce activity events on the server
side rather than relying entirely on client-side debouncing.

**Cost.** Significant. Worker threads change the ownership model for Process
state; server-side coalescing of activity events changes a current invariant
("client sees every event").

**Benefit.** Headroom for multi-user / many-tab deployments.

**Trigger.** Defer until concrete fan-out numbers (instrument `/status` first
— see proposal #2 in `server-message-routing.md`) show the main loop is being
pinned by emit.

### Client transcript bounding and virtualization

**Current shape.** The server retains the canonical transcript. The client
keeps a contiguous loaded semantic window, while `MessageList` mounts only a
measured-height viewport window once the loaded rows cross the activation
threshold. Off-window loaded rows remain searchable and navigable through
render-id wake requests; native browser Find can see only mounted rows.

The semantic data window drops an old prefix only at safe turn boundaries while
preserving pagination and associated state. The render window keeps semantic
rows loaded while replacing off-window runs with height-model spacers. Search,
recall, route restoration, keyboard turn navigation, and the turn rail wake a
target row before aligning against real DOM geometry. Live quote anchors remain
mounted as sparse islands. See
[`topics/transcript-virtualization.md`](topics/transcript-virtualization.md).

**Cost.** Medium for semantic window trimming because pagination, scroll
following, and message-associated maps must change atomically. Higher for row
virtualization because it interacts with auto-scroll, find-on-page, search
anchors, and the augment-on-DOM streaming path.

**Benefit.** A session that stays mounted for days does not retain every message
since mount, while full provider history remains recoverable through Load older.

**Accepted trade-off.** A 360-turn trace reduced the final mounted state from
722 rows and 18,985 elements to eight rows and 435 elements. Native browser Find
cannot discover an off-window row; that accepted limitation remains tracked in
[`gaps/transcript-render-window-native-find.md`](gaps/transcript-render-window-native-find.md),
while YA's in-session search must continue to wake off-window matches.

### Portable transcript compiler / native render boundary

**Problem today.** Provider normalization, transcript reconciliation,
presentation grouping, and React/DOM rendering are separated incompletely. The
hosted client can update ahead of installed YA servers, while future Android and
iOS clients would otherwise have to duplicate the same provider interpretation
or embed the web UI. Moving all work to clients is also unacceptable because
ordinary mobile rendering must never require a full provider transcript.

**Proposal.** Keep a stable server ingest kernel responsible for provider
storage/protocol access, identity, bounded window selection, and whole-history
prefix facts. Put bounded transcript-to-presentation derivation in a versioned,
platform-neutral compiler that may run server-side by preference or from a
client bundle for compatibility. Web, Android, and iOS use separate renderers
over the same semantic projection. See
[`topics/portable-transcript-compiler.md`](topics/portable-transcript-compiler.md).

**Cost.** High and cross-cutting: new envelope/projection schemas, compatibility
negotiation, server/client parity fixtures, a web adapter migration, careful
unknown-record filtering, and eventually native renderers. A whole-session
rewrite would also duplicate the current session-detail migration, so work must
land adapter-first in small parity-proven slices.

**Benefit.** Provider presentation fixes can often ship with frequently updated
clients; compatible servers can still do the expensive/history-aware work;
mobile compilation remains bounded; and native clients can render real sessions
without inheriting the DOM-heavy component tree.

**Current checkpoint.** The conservative web-only foundation completed on
2026-07-19: current `Message[]` input is transformed into the existing internal
`RenderItem[]` by a browser-free TypeScript compiler, with cache, web
diagnostics, display-object insertion, reference stabilization, and React
rendering kept as explicit adapters. The primary session-detail path uses this
boundary, protected by semantic, browser, private-artifact, and performance
tripwires. See the completed
[`foundation plan`](docs/tactical/061-portable-transcript-foundation-plan.md).
This is useful web architecture but is not yet the versioned envelope or
platform-neutral projection proposed above.

**Next consumer and decisions.** The 2026-09-12 direction selects a minimal
multi-server web demo of a [Simple Client API](topics/simple-client-api.md),
followed closely by Kotlin/Compose and Swift/SwiftUI consumers. It uses finished
server projections, message-based limits, and a new small client state machine.
The [three-client plan](docs/tactical/130-simple-client-api-and-three-client-demo.md)
must settle concrete schemas, history semantics, packaging/runtime, and
capability/fallback review before protocol implementation. The earlier extraction
alone does not authorize a public/versioned IR or a client compiler runtime.

### Disk-pressure degraded mode

**Problem today.** Optional disk writers can still be process-fatal if they
emit an unhandled Node stream `error`. A local `ENOSPC` can therefore kill the
YA server and drop relay access even though the relay client reconnects while
the process is alive.

**Proposal.** Treat optional diagnostics as degradable, fail upload/user-action
writes explicitly, and surface disk-pressure state through diagnostics when the
same policy starts appearing across multiple writers. See
[`topics/disk-full-degraded-mode.md`](topics/disk-full-degraded-mode.md).

**Cost.** Small for stream hardening; larger if YA adds log rotation, shared
persistence policy, or remote-visible disk health.

**Benefit.** Remote and local control paths stay available under disk pressure,
and users get clear write-failure errors instead of a dead server.

**Trigger.** The narrow stream-hardening trigger has been met by an observed
`ENOSPC` process exit. Broader degraded-mode work should wait for the triggers
listed in the topic doc.

---

Add new entries here when a contributor identifies an architectural shift
worth recording but not yet enacting. Keep each entry to the same shape:
**problem today → proposal → cost → benefit → trigger.** The trigger is the
load-bearing field — it's how a future reader knows whether the proposal is
still latent or now actionable.
