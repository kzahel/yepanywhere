# Source Transport Boundary

> Each client source exposes one stable transport facade for talking to one YA
> server, while preserving visible status for the real channels that back it.

Topic: source-transport

Status: Accepted contract. Implementation slices are tracked in
[`docs/tactical/057-source-transport-boundary.md`](../docs/tactical/057-source-transport-boundary.md).
Read this document before moving session streams, activity streams, remote API
routing, upload routing, or reconnect/readiness state under `YaSourceRuntime`.

## Problem

The client currently has three transport shapes that are all real:

- default localhost mode: same-origin browser requests for normal API calls,
  plus WebSocket channels for subscriptions and some uploads;
- plain multiplex WebSocket mode: one unencrypted `WebSocketConnection` carries
  request/response, uploads, session streams, watch streams, activity, ping,
  and reconnect;
- secure or relay mode: one `SecureConnection` carries the same multiplexed
  operations, adding SRP, encryption, and relay support.

Those shapes grew at different times, so consumers choose transport by reaching
into different globals:

- `api.fetchJSON` checks `getGlobalConnection()` and otherwise uses fetch;
- `useConnection` returns a global secure connection or `directConnection`;
- `useSessionStream`, `useSessionWatchStream`, and `activityBus` choose between
  `getGlobalConnection()` and `getWebSocketConnection()`;
- reconnect/backoff/readiness are exposed through the singleton
  `connectionManager` and `whenConnectionReady`.

That is workable with one current source. It is hard to reason about once a
source runtime owns its own API, streams, activity, summaries, and caches.

## Goal

Introduce an explicit `SourceTransport` contract: the boring, source-bound
facade for "how this browser talks to this YA server."

The facade should make the normal localhost mode fit the same outward shape as
the multiplexed modes, but without inventing false localhost lifecycle
semantics. Localhost source-level readiness is always ready; its stream
WebSocket remains visible as a channel in status/debug snapshots.

## Non-Goals

- Do not remove default localhost HTTP behavior.
- Do not make localhost source-level `reconnect()` secretly reconnect the
  stream WebSocket.
- Do not hide channel state in private objects that cannot be inspected.
- Do not claim two real remote sources can coexist until exercised against real
  servers.
- Do not rework SRP, NaCl, relay pairing, or WebSocket framing as part of this
  boundary.
- **Relocate, do not redesign.** No reconnect, backoff, wake, stale-detection,
  or readiness policy changes ride along with ownership moves. Semantic
  improvements are separate, explicitly flagged slices after parity is proven
  (see the Behavior Parity Contract below).
- Do not make demand-traffic callers gate on readiness before requesting. The
  transport is the single readiness arbiter (see Request Semantics).
- `isRemoteClient()` (build-time flag) stays global. It describes the build,
  not a source, and its polling-gate consumers are out of scope.

## Current Code Facts

- [`WebSocketConnection`](../packages/client/src/lib/connection/WebSocketConnection.ts)
  is a single unencrypted WebSocket transport. It delegates request/response,
  upload, subscription, ping/pong, and reconnect behavior to `RelayProtocol`.
- [`SecureConnection`](../packages/client/src/lib/connection/SecureConnection.ts)
  exposes the same multiplexed surface, with SRP, encryption, session resume,
  and relay support layered around it.
- [`DirectConnection`](../packages/client/src/lib/connection/DirectConnection.ts)
  handles same-origin `fetch`/`fetchBlob` and upload helpers. Its subscription
  methods throw because default localhost subscriptions use the local
  `WebSocketConnection` path.
- [`useConnection`](../packages/client/src/hooks/useConnection.ts) returns a
  global secure connection when present, otherwise `directConnection`.
- [`api.fetchJSON`](../packages/client/src/api/client.ts) routes through the
  global secure connection when present, otherwise same-origin fetch.
- **`SecureConnection` instances are replaced, not reused, across auth
  flows.** `RemoteConnectionContext` constructs a fresh instance for connect,
  stored-session resume, relay connect, and relay re-pair, swapping it into
  `setGlobalConnection` each time. A relay drop can replace the instance with
  no user action. The codebase already absorbs this via a mutable slot: the
  activity bus reconnectFn re-reads `getGlobalConnection()` at call time.
- **Requests self-heal the connection.** Every `RelayProtocol.fetch` first
  awaits `ensureConnected()`: concurrent requests coalesce on one in-flight
  `connectionPromise`, and a request against a dead socket triggers an inline
  reconnect + re-auth (direct: connect + SRP resume; relay: re-pair, throwing
  `RelayReconnectRequiredError` on failure). Requests do not wait for the
  connection manager's backoff timer; they are a parallel recovery driver.
- **The activity bus owns app transport health today.** `ActivityBus.connect()`
  is what calls `connectionManager.start(...)` and supplies the reconnectFn.
  Session/watch stream hooks feed `recordEvent`/`recordHeartbeat`/
  `markConnected`/`handleError` from their own handlers. This layering
  violation and its user-visible failure (stale orange bar while same-transport
  API requests succeed) are documented in
  [`docs/tactical/050-remote-activity-bus-secure-lifecycle.md`](../docs/tactical/050-remote-activity-bus-secure-lifecycle.md);
  the landed fix (`onAuthenticated` → `markConnected`) must be preserved, and
  050's explicitly deferred ownership inversion is delivered by this boundary.
- `RelayProtocol` reaches into the singleton `connectionManager` for
  `beginCriticalOperation` around uploads, as does `api/upload.ts`.
- `fetchJSON` and `DirectConnection.fetch` have drifted: `fetchJSON` sends
  `X-Desktop-Token`; `DirectConnection.fetch` does not. The localhost transport
  must match `fetchJSON` behavior and should absorb the drift.

## Proposed Interface

Names are intentionally low-level. This is transport plumbing, not a rich
domain client.

```ts
type SourceTransportKind = "localhost" | "websocket" | "secure";

interface SourceTransport {
  /**
   * Diagnostics and status display only. Feature code must never branch on
   * kind; branch on `capabilities` instead. Branching on kind reintroduces
   * the mode leakage this boundary removes.
   */
  readonly kind: SourceTransportKind;
  readonly status: SourceTransportStatus;
  readonly capabilities: SourceTransportCapabilities;

  fetch<T>(path: string, init?: RequestInit): Promise<T>;
  fetchBlob(path: string): Promise<Blob>;
  upload(
    projectId: string,
    sessionId: string,
    file: File,
    options?: UploadOptions,
  ): Promise<UploadedFile>;
  uploadStagedAttachment(
    file: File,
    options?: UploadOptions & { batchId?: string },
  ): Promise<StagedAttachmentRef>;

  subscribeSession(
    sessionId: string,
    handlers: StreamHandlers,
    lastEventId?: string,
    options?: SessionSubscriptionOptions,
  ): Subscription;
  subscribeSessionWatch(
    sessionId: string,
    handlers: StreamHandlers,
    options?: { projectId?: string; provider?: string },
  ): Subscription;
  subscribeActivity(handlers: StreamHandlers): Subscription;

  /**
   * Source-level reconnect (an action, so it lives here, not on status).
   * For localhost this is a no-op because the source is same-origin HTTP and
   * has no source connection to re-establish.
   */
  reconnect(): Promise<void>;

  /**
   * Release channels this transport instance created. A transport must never
   * close channels it merely borrowed. Disposing a transport with an attached
   * backing connection detaches and closes it.
   */
  dispose(): void;
}

interface SourceTransportCapabilities {
  /**
   * True when same-origin URLs (e.g. <img src="/api/...">) reach this
   * source. Localhost and plain-WebSocket sources are same-origin; the static
   * remote client is not. Media consumers branch on this, never on kind.
   */
  sameOriginUrls: boolean;
  /** Emulator signaling channel; absent when the mode cannot carry it. */
  device?: DeviceSignalingChannel;
  /** Dedicated speech socket; absent when the mode cannot carry it. */
  speech?: SpeechChannelFactory;
}

interface DeviceSignalingChannel {
  send(msg: RemoteClientMessage): void | Promise<void>;
  onMessage(handler: (msg: DeviceServerMessage) => void): () => void;
}

interface SpeechChannelFactory {
  open(): Promise<ConnectionSpeechSocket>;
}
```

Status is deliberately visible and inspectable, and purely observational —
`reconnect()` moved to the transport root:

```ts
type SourceTransportState =
  | "ready"
  | "connecting"
  | "reconnecting"
  | "disconnected";

interface SourceTransportStatus {
  getSnapshot(): SourceTransportStatusSnapshot;

  /**
   * Fires when either the source state or any channel snapshot changes.
   * Localhost can therefore stay source-ready while still publishing stream
   * WebSocket state changes for diagnostics or stream-specific consumers.
   */
  subscribe(listener: () => void): () => void;

  /**
   * Fires when the transport's health manager observes a connected tab
   * becoming visible. Activity refresh listeners use this to refresh in
   * parallel with the wake ping/pong check.
   */
  subscribeVisibilityRestored?(listener: () => void): () => void;
}

interface SourceTransportStatusSnapshot {
  kind: SourceTransportKind;
  state: SourceTransportState;
  channels: SourceTransportChannelSnapshot[];
}

type SourceTransportChannelName =
  | "same-origin-http"
  | "upload-websocket"
  | "stream-websocket"
  | "multiplex-websocket"
  | "secure-websocket"
  | "relay";

type SourceTransportChannelState =
  | "stateless"
  | "idle"
  | "connecting"
  | "connected"
  | "reconnecting"
  | "disconnected"
  | "unsupported";

interface SourceTransportChannelSnapshot {
  name: SourceTransportChannelName;
  state: SourceTransportChannelState;
  activeSubscriptions?: number;
  reconnectAttempts?: number;
  lastError?: string;
}
```

The source-level state answers "can this source be addressed?" Channel
snapshots answer "what is really happening underneath?" They are not private
diagnostics; they are part of the type-level contract for debuggability.
`subscribe` covers the whole snapshot, not only the source-level state.

## Backing Connection Slot

The facade is **stable per source**; the backing connection is **replaceable**.

`RemoteConnectionContext` constructs a fresh `SecureConnection` per connect,
resume, and relay re-pair. If transport identity equaled connection identity,
every re-auth would invalidate `runtime.transport` for every consumer. Instead,
the multiplex transports own a connection slot:

- `SecureSourceTransport.attach(conn: SecureConnection)` /
  `WebSocketSourceTransport.attach(conn: WebSocketConnection)` install or
  replace the backing connection; `detach(reason?)` empties the slot.
- `attach`/`detach` are wiring APIs for connection-establishment flows only.
  They are methods on the concrete classes, not part of `SourceTransport`;
  feature consumers never see them.
- While the slot is empty, source state is `disconnected` and demand fetches
  wait bounded (see Request Semantics). Subscriptions made through the facade
  before/across a swap are reconciled by the managed-stream layer, not by the
  facade re-routing live subscriptions.
- Construction: the source runtime registry mints one facade per source key.
  Because source keys are opaque, the registry must not parse keys to decide
  transport kind — the code that mints a key (route binding, connection flows)
  supplies the transport construction inputs alongside it.
- Login/pairing/SRP orchestration stays where it is. The context keeps
  building `SecureConnection`s exactly as today and attaches them, instead of
  (during migration: in addition to) calling `setGlobalConnection`.

## Source State Mapping

`ConnectionManager` has no "connecting" state (initial-connection progress
lives in React state today), so the facade synthesizes the mapping. Do not
improvise a different one:

| Slot / manager condition                              | Source state   |
| ----------------------------------------------------- | -------------- |
| No backing connection attached (never, or detached)   | `disconnected` |
| Attach accepted, first connect/auth in flight         | `connecting`   |
| Manager state `reconnecting`                          | `reconnecting` |
| Manager state `connected`                             | `ready`        |
| Manager state `disconnected` (stopped / non-retryable)| `disconnected` |
| Localhost, always                                     | `ready`        |

## File Download Responses

Successful multiplexed WebSocket and relay file responses requested with
`download=true`, or marked `Content-Disposition: attachment`, carry the
existing `{ _binary: true, data: "<base64>" }` body regardless of MIME type.
Decoding that body must reproduce the original bytes, including empty files,
non-UTF-8 text, JSON whitespace, and integers beyond JavaScript's safe range.
Download classification precedes JSON parsing. The file viewer continues to
use the original file name when saving the resulting blob.

Ordinary text and JSON viewing retain their existing response representation;
failed downloads retain their normal error bodies and status codes so clients
can report the cause. Existing legacy public-share response handling and size
limits remain authoritative. This repairs the server's use of an existing
binary contract; it adds no client dependency, capability, or protocol version.

## Request Semantics When Not Ready

Streamed GET requests preserve caller headers, including content negotiation.
The finite New Session startup bundle and the bounded collection NDJSON route
use the existing encrypted response stream. Collection bodies may remain quiet
while the connection is healthy; finite file bodies retain their progress
deadline. Source-local `streamedResponses` capability identifies a usable live
response path, independently of server feature support. Plain multiplex
WebSocket, localhost HTTP and finite-only native bridges retain collection REST
fallback. Localhost collection reads must finish: an endless HTTP/1 response
per tab can occupy every browser connection slot for that origin, blocking
session lists, new tabs and unrelated requests. Finite file/bootstrap response
bodies remain supported. Secure/relay response streams use their multiplexed
connection and do not consume an HTTP slot per tab.
Ordinary live event subscriptions
remain on their subscription protocol. Cancelling a response or closing the
connection interrupts a pending body read as well as a sender waiting for byte
acknowledgements, so a quiet producer cannot retain a closed tab's stream.

The contract splits by traffic type. The transport is the single readiness
arbiter for demand traffic; callers only opt *optional* work out.

- **Demand traffic** (user navigated, tapped, or mounted a screen): call
  `fetch` unconditionally.
  - Backing connection attached and manager ready or reconnecting: the facade
    delegates verbatim to the backing `fetch`, preserving request coalescing on
    the in-flight connect promise and request-driven inline recovery.
  - Backing connection attached but manager terminally `disconnected`: the
    facade rejects immediately with a typed, non-retryable disconnected error
    instead of entering lower transport timeouts.
  - Slot empty (initial connect, teardown, instance being replaced): the
    facade waits bounded (default 15s, matching `whenConnectionReady`) for an
    attach, then delegates; otherwise rejects with a typed, retryable
    not-ready error. This is `whenConnectionReady` made per-source; the
    global waiter is deleted once callers migrate.
- **Elective traffic** (pollers, prefetch, log flushing): gate on
  `transport.status` and pause while not ready, rather than queueing work.
  `ClientLogCollector` already follows this pattern against the singleton
  manager and generalizes to per-source status.
- **UI affordances** (offline banners, composer state, connection bar): read
  `transport.status`. The global connection bar is exceptional-state-only and does not require
  developer mode:
  ready renders no full-width success rule, while reconnecting and disconnected
  remain visible. Users see offline-ness; the plumbing does not reject work it
  could complete in under a second.
- **Subscriptions** while not ready: raw `subscribe*` delivers an async
  `onError` (retryable classification). The managed-stream layer is what
  waits for readiness and installs the subscription; raw primitives stay
  dumb.

Why not gate all callers on readiness: it redistributes transport-state
awareness to every call site, each gated caller then needs its own
refire-on-ready loop (the pre-021 mount-race bug class), the reconnect burst
happens at the ready flip regardless, and it forfeits request-driven recovery
(user action would no longer accelerate reconnection during backoff).

## Health And Recovery Ownership

Each multiplex transport owns a **private `ConnectionManager` instance**. The
manager class owns backoff, ping/pong, stale detection, visibility handling,
and critical-operation suppression. The original ownership migration preserved
policy; the separately approved recovery repair below changes exhausted-retry
and resume-failure behavior. The ownership wiring remains:

- The transport feeds its own manager from protocol-level traffic (an inbound
  frame/event hook on `RelayProtocol`), not from consumer handlers. Today
  health signals flow only through whichever stream hooks happen to be
  mounted; after the move, consumers never call
  `recordEvent`/`recordHeartbeat`/`markConnected`/`handleError`.
- `sendPing`/`receivePong` wiring is internal to the transport.
- `beginCriticalOperation` is injected into `RelayProtocol` and the localhost
  upload path by the owning transport, replacing singleton reach-ups.
- The backing connection's `onAuthenticated`/`onDisconnect` callbacks route to
  the **owning transport's** manager — preserving the 050 fix (out-of-band
  fetch-driven recovery marks the manager connected and cancels the stale,
  destructive backoff reconnect). The nested speech-socket connection must not
  touch any manager (see 050).
- The activity bus stops starting the manager and stops owning the
  reconnectFn. This is 050's deferred ownership inversion, delivered.
- On tab-visible, each attached transport health-checks its own socket. When
  more than one live runtime exists later, suspended (non-current) sources
  skip the wake ping — the suspension policy in the topology topic plugs in
  here.

## Recovery after a temporary outage

A relay route retains its already-confirmed host's page through a temporary
outage. Switching to a different relay host shows the connection startup shell
until that destination's first connection succeeds. The previous host's
connected state must never commit the destination's page or briefly expose an
editor that will disappear when the new handshake starts. This changes no
principal, credential, grant or server protocol.


A retained source remains `reconnecting` after its ten-attempt rapid retry
budget is exhausted. Budget exhaustion is not an authentication verdict and
must not discard the context's connection or status subscription. While visible,
the exhausted source probes every 60–78 seconds (jittered); hidden exhausted
sources have no scheduled reconnect probe. Returning to visibility, focus,
network-online, or keyboard/pointer/history-navigation activity may request one
immediate probe. Signals coalesce with an in-flight attempt and are rate-limited
to one signal-triggered probe per five seconds. A signal is a recovery opportunity,
not proof of network reachability. Healthy connections retain wake ping/pong;
ordinary exponential backoff is not reset by every focus or key event.

The source transport remains the recovery owner after authentication. Before
there is an attached connection, the context or relay route's failed acquisition
can retry on the same signals or visible slow cadence, never both concurrently.
A failed acquisition makes exactly one attempt; re-renders caused by that
failure, including a rebuilt but equal authentication scope, never start
another. Success restores the existing route and live managed subscriptions. Recovery
must preserve in-memory drafts and acknowledge sequential typing within 100 ms.
Intentional disconnect, host switching, disposal and terminal verification/auth
failures stop automatic recovery. Late completions cannot revive stopped or
superseded attempts.

Native bridge state observations also supersede an earlier reconnect command's
reply. A delayed success cannot mark a newer native retry ready, and a delayed
failure cannot regress a newer connected or connecting state. Without a newer
native observation, the command reply retains its compatibility behavior.

Native socket observations own Android reachability; WebView `navigator.onLine`
cannot override a connected native source. After initial readiness, lease
suspension, connecting and retrying publish one `reconnecting` interval until
native is ready again. Duplicate mapped states remain quiet. A new native lease
generation forces one reattachment even when intermediate state messages were
coalesced; departed generations cannot affect the current document. A native
connection epoch also preserves replacement-socket reattachment when retry
observations were coalesced before reaching the document. Duplicate connected
observations in the same epoch stay quiet. Visible safe
reads wait through suspension within the existing readiness budget. Hidden reads
fail with the typed recovery error. Shells advertising `stateQuery` reconcile a
current unavailable operation against native state before retrying; delayed
operation errors cannot regress a newer native observation. Exhausted recovery
signals coalesce for five seconds, including native network-available events. A visible demand
signal arriving within that cooldown retains one attempt for its boundary,
rather than being lost until the 60-second backstop. Returning ready, beginning
a retry, hiding, disposal and terminal failure cancel that deferred demand.

Native bridge catch-up waits in a bounded event lane. Small lifecycle state and
control replies take priority between complete logical messages; frame credit
still bounds local delivery. Closing a document releases queued bytes and blocked
producers. Event pressure may end the affected subscription with a recoverable
overflow; it must not fail the entire document or become a proof failure.
Subscription restore precedes publishing a new connected transport, so a newly
admitted subscription is never restored a second time. Abandoning a caller after
its encrypted request frame starts must allow that frame to finish; it cannot
replace the socket used by sibling leases.


### Resume credentials and failure evidence

A local handshake timeout, socket failure, relay outage, unknown error, or
exhausted retry budget must not delete a saved SRP resume credential or claim the
server rejected it. Both global remembered credentials and per-host storage
retain the session during acquisition, including unsuccessful relay resumes.

Client-owned typed errors preserve the distinction between a timeout, explicit
`srp_invalid`/authentication rejection, known unsupported stored protocol,
server-side error, and proof/protocol verification failure. Relay wrappers retain
the original cause. Authentication policy never depends on finding words like
"session", "auth", or "invalid" in an error's display message. A server-side
`server_error` is retryable and is not credential rejection.

An explicit applicable rejection or proven incompatibility removes only the
attempted session from active storage and shows the existing sign-in explanation.
A plaintext pre-authentication `srp_invalid` is a received refusal, not
authenticated proof that the credential is permanently invalid. Credential
retirement belongs to SecureConnection, including password fallback, not to UI
catch handlers reading mutable host state. Superseded attempts cannot retire a
newer login or another endpoint/principal's session.
Timeouts show that the server did not respond and the session was retained.
Proof verification, protocol downgrade and malformed resume responses refuse
connection, preserve the credential, explain the failure, and stop automatic
retries. They do not weaken verification or silently fall back to a password
prompt. Explicit login remains available; entering login is not itself evidence
that a credential was rejected. Closing an outage notice must not silently
redirect to login.

These are frontend policy changes over existing messages and proof checks; no
new server capability or minimum version is required. The existing protocol-2
grace and authenticated protocol pinning remain unchanged.

### Optional rejected-session diagnosis

Settings → Development → **Retain rejected SRP sessions for debugging** is a
browser-local, default-off opt-in independent of Browser Diagnostics. It and its
description are the only UI additions. When enabled and Web Locks is available,
retirement first writes the attempted base key and authenticated protocol pin to
`yep-anywhere-rejected-srp-resume-v1`. No automatic resume reader consults this
separate store, including older cached clients. Without cross-tab coordination,
retention is unavailable and emits a diagnostic event; normal retirement continues.

Retain one credential per exact mode, endpoint, relay server name and SRP identity,
at most eight overall, for 72 hours from first quarantine of that credential.
Repeated failures and probes do not extend expiry. Each record holds at most eight
safe observations: attempt/session IDs, phase, event kind, build, protocol pin,
timestamps and elapsed time. Diagnostic event endpoints omit URL userinfo, query
and fragment. Keys, proofs, passwords, frames and arbitrary exception text never
enter these structured events, debugger results or portable settings backups.
Prune on startup and reads/writes; a closed or suspended origin cannot physically
delete data until it runs again. Timeouts, unknown errors and verification failures
do not quarantine or change active-session policy.

Active authentication writes and retirement coordinate through the same Web Lock.
Transitions re-read and compare exact scope and session ID before clearing the
global and saved-host copies. Explicit erasure writes a generation tombstone
before queued cleanup; in-flight attempts cannot resurrect the diagnostic key.
Cooperation applies to current clients; cached older versions cannot participate
in new locking/erasure rules. Fresh password login keeps the archive. Host removal,
explicit logout, disabling retention and debugger deletion erase diagnostic
material; Switch Host remains navigation. Logout conservatively purges this
origin's entire diagnostic archive.

While opted in, `window.__YA_RESUME_DEBUG__` provides `list()`, `probe(id)`,
`cancel(id)` and `forget(id)` for console/CDP use, including on login routes.
Listing returns safe metadata only. Probing allows one attempt per scope, uses
fresh nonces and the existing protocol pinning/server-proof verifier, verifies an
encrypted `/auth/status` request, and closes the temporary connection in `finally`.
It never publishes a source, replaces active credentials or navigates. Erasure,
disabling and cancellation abort probes and invalidate late evidence. The helper
is removed when retention is disabled. See the [debugging runbook](../docs/development/debugging.md#rejected-srp-resume-credentials).

Browser Diagnostics queues the bounded structured `SrpResume` events through its
existing upload path when enabled. Server-local `srp_resume_refused` events name
the init/proof phase and known reason (missing/expired session, identity/nonce or
challenge mismatch, expired challenge, invalid/malformed proof, timestamp skew).
Public refusals stay generic; no new protocol or minimum server version is required.

## Managed Streams

One shared helper above the interface — not resubscription magic inside each
transport implementation, and not three bespoke per-hook copies.

Session, focused-watch, activity, glossary, and worktree streams use one
`createManagedStream(transport, spec)` helper. It owns:

- wait-for-ready before first subscribe; resubscribe on ready transitions and
  across backing-connection swaps;
- `lastEventId` capture and resume;
- non-retryable errors terminal, surfaced as stream state;
- teardown exactly once; stale-handler and StrictMode double-mount guards;
- **subscription retry over a healthy transport without transport teardown**
  (050's other deferred item): a subscription-level failure retries the
  subscription with its own small backoff instead of escalating to a full
  transport reconnect. Transport-level failures still flow to the manager via
  the transport's own health feed;
- a subscription-local inactivity deadline for server streams with a periodic
  heartbeat. The deadline starts when the subscribe request is installed, and
  an open or event rearms it. The current 30-second heartbeat uses a 75-second
  deadline, so a request that never opens or two missed heartbeats plus
  scheduling slack close and retry only that logical subscription even when
  traffic from other subscriptions keeps the shared transport healthy.

Raw `subscribe*` primitives on the transport stay dumb and return a plain
`Subscription`, so fakes remain trivial.

Every managed-stream state change publishes a snapshot to subscribers, so a
consumer that mirrors stream state into React should derive it in the
`subscribe` callback alone. Reading the snapshot from inside a `spec` handler
observes the pre-transition value: `onError` and `onClose` run before the
retry or terminal snapshot is set.

`isManagedStreamResubscribing(snapshot)` distinguishes a transient gap —
waiting on the transport, subscribing, or backing off before a retry — from a
pipe that will stay down. A terminal or closed stream is not resubscribing.
`restart()` is a no-op for those two states, so a reconnect request must derive
its state from the published snapshot rather than assuming a subscription is on
the way back.

## Session Connection Bar

The per-session bar (`getSessionConnectionBarStatus`) is narrower than the
global diagnostic bar above. A session with no live update stream is `idle`.
Otherwise `disconnected` is always visible, because a broken live pipe is
something the user must see; `connected` and `connecting` render only under
developer connection bars.

A stream that is resubscribing, or a transport that is reconnecting, is
`connecting` — not `disconnected`. Without that distinction a routine
resubscribe paints a red bar, most visibly on the frontend-changed resubscribe
that `useResubscribeOnFrontendSourceChange` triggers while the main transport
is still ready.

## Design decisions

- **Use a subscription-local heartbeat deadline** (vs. relying only on shared
  transport health): one active subscription must not conceal another dead
  subscription on the same multiplexed WebSocket. Recovery stays at the
  narrowest failed layer and does not tear down healthy peer subscriptions.

## Activity Stream Lifecycle

Generalizing the 050 product invariant from "the remote app" to any source:

> For a source runtime with a mounted activity lease: transport `ready`
> implies the source's activity subscription is installed or actively
> converging. Backing-connection swaps, reconnects, and out-of-band recoveries
> converge the subscription without app-level re-wiring.

- The existing `runtime.summary` retain/release leases remain the demand
  signal. The app shell holds a lease for the current source whenever the UI
  is up, so "secure connection established ⇒ activity stream up" falls out of
  lease + ready, encoded in one place instead of React mount timing against a
  mutable global.
- The compatibility `activityBus` facade still owns process-wide `on()` fanout
  for current-source consumers during migration, while source summary reducers
  subscribe to source-keyed fanout from the same retained stream.
- Local and remote follow the identical rule; they differ only in when the
  lease is held. Local gates the lease on auth state (the 401-avoidance in
  `useActivityBusConnection`); the remote shell holds it whenever mounted
  (its gate guarantees auth).
- A retained document suspends its activity streams on `pagehide`, closing the
  raw subscriptions before navigation, discard, or browser caching can leave
  a logical tab registered. If that same document returns through `pageshow`,
  each still-retained source installs one fresh managed stream. The lease
  counts survive suspension; the underlying subscriptions do not.
- `SecureConnection` itself never auto-subscribes to activity (050 non-goal
  stands); the runtime layer owns the invariant.
- Suspension of non-current sources is expressed by releasing or downgrading
  the lease, per the topology topic's resource policy.
- `activityBus.connected` is derived from those stream records, so it changes
  only on stream open, error, close, and retain changes. It is therefore
  observable: `subscribeConnected` notifies on change, and consumers must use
  it rather than polling the getter on an interval. A polled consumer pays a
  wakeup per period per mounted instance forever and still reports the change
  up to a period late; a hook mounted by the app shell, Settings, and a
  settings pane pays that three times over for a value that is usually
  constant for the life of the tab.

## Behavior Parity Contract

The bespoke signals in the current code encode real, user-visible policy —
mobile wake, backoff, coalescing — that must survive relocation. Every row
below is pinned by a test that runs against the facade before any consumer
migrates. **A row may only change with an explicit decision recorded in this
document**, never as a side effect of a move.

| # | Behavior | Mechanism today | Pinned by |
|---|----------|-----------------|-----------|
| 1 | Wake ping/pong: tab-visible sends ping, 2s pong timeout forces reconnect; suppressed during critical ops | `ConnectionManager._handleBecameVisible` | `ConnectionManager.test.ts` |
| 2 | Data refresh fires in parallel with the wake health check, not behind it | `visibilityRestored` event before ping resolution; bus refresh events | `ConnectionManager.integration.test.ts` |
| 3 | Stale detection: 45s without events (heartbeat-gated), 10s check cadence | `_checkStale` | `ConnectionManager.test.ts` |
| 4 | Backoff: 1s base, ×2 per attempt, 0.3 jitter, 30s cap, 10 attempts, then `disconnected` + `reconnectFailed` | `_scheduleReconnect` | `ConnectionManager.test.ts` |
| 5 | Non-retryable errors terminal: close 4001/4003, subscription 4xx, terminal relay causes | `isNonRetryableError` | connection type tests |
| 6 | Reconnect dedup: one in-flight reconnect; superseded outcomes ignored | `_reconnectPromise` guard | `ConnectionManager.test.ts` |
| 7 | Concurrent requests coalesce on one in-flight connect | `ensureConnected` / `connectionPromise` | new parity test |
| 8 | Request-driven recovery: fetch on a dead socket triggers inline reconnect + re-auth, independent of backoff timing | `RelayProtocol.fetch` → `ensureConnected` | new parity test |
| 9 | Out-of-band recovery visible to manager: auth success marks connected, cancels stale backoff (no destructive reconnect of a healthy socket) | `onAuthenticated` → `markConnected` (050 fix) | `ConnectionManager.test.ts` |
| 10 | Detached window: demand fetch waits bounded 15s, then typed rejection | `whenConnectionReady` → facade slot wait | `whenConnectionReady.test.ts`, ported |
| 11 | Uploads suppress health-check reconnects | `beginCriticalOperation` | `ConnectionManager.test.ts` |
| 12 | Relay re-pair replaces the backing connection; consumers keep working through the same facade | context flows + slot | `ReconnectSubscriptions.test.ts` + new slot test |
| 13 | Session/watch resubscribe resumes from `lastEventId` | hooks (moves to managed stream) | `ReconnectSubscriptions.test.ts` |
| 14 | Teardown exactly once; late handler fire from a replaced subscription cannot clear the new one; StrictMode double-mount safe | hook guards (move to managed stream) | hook tests |
| 15 | Activity resubscribes on connected transition; connect is idempotent | `ActivityBus` stateChange listener (moves to managed stream) | `ReconnectSubscriptions.test.ts` |
| 16 | `forceReconnect()` overlapping an in-flight `ensureConnected()` joins the in-flight recovery before deciding whether forced teardown is still needed | `SecureConnection.forceReconnect()` serialization | `SecureConnection.compatibility.test.ts` |
| 17 | Terminal disconnected demand traffic fails fast without blocking reconnecting or empty-slot behavior | multiplex facade demand guard | `MultiplexSourceTransport.test.ts` |
| 18 | Same-server API redirects remain fetch-compatible through relay: `Location` is forwarded and followed within `/api`; missing, external, or excessive redirect chains fail instead of returning a null success body | `ws-relay-handlers` + `RelayProtocol.fetch` | `ws-relay-request-concurrency.test.ts`, `RelayProtocol.hooks.test.ts` |
| 19 | A heartbeat-capable logical subscription that receives no events for 75 seconds retries itself even while peer traffic keeps the shared transport ready | `ManagedStream` inactivity deadline | `ManagedStream.test.ts` |

Explicitly deferred semantic improvements (each its own future slice, opted
into deliberately): per-source auth-required signaling replacing the global
`authEvents` broadcast; transport-owned `lastEventId` tracking.

## Mode Semantics

### Default Localhost Transport

`LocalhostSourceTransport` is the primary local mode.

- `fetch`/`fetchBlob` call same-origin browser fetch with `fetchJSON`-parity
  behavior (desktop token header, 401 → login-required signal,
  `X-Setup-Required`). The drifted `DirectConnection.fetch` is absorbed.
- uploads use the existing upload helper path, with the critical-operation
  guard pointed at this transport's manager.
- `subscribeSession`, `subscribeSessionWatch`, and `subscribeActivity` use a
  **privately owned** `WebSocketConnection` instance (not the process
  singleton), with a private manager for that stream channel.
- `status.getSnapshot().state` is always `ready`; `reconnect()` is a no-op.
- channels include `same-origin-http` as `stateless`, the stream WebSocket
  with its real observable state, and `upload-websocket` reported ephemerally
  (present with an active count while uploads run; no long-lived bookkeeping).
- `capabilities.sameOriginUrls = true`; `device` present via the stream
  WebSocket.
- `capabilities.streamedResponses = false` for live collection acquisition.
  Lists use finite retained SQL reads and existing WebSocket invalidations.
  Multiple tabs must remain able to load lists and issue ordinary HTTP requests.

At most one localhost source can exist per app: same-origin fetch is pinned to
`window.location`. This asymmetry is by construction — multi-source means one
optional localhost source plus N websocket/secure sources — and it collapses
the dispose questions the old singletons would otherwise raise.

### Plain Multiplex WebSocket Transport

`WebSocketSourceTransport` wraps one attached `WebSocketConnection` at a time.

- `fetch`, uploads, session streams, watch streams, activity, ping/pong, and
  reconnect all use the same unencrypted WebSocket.
- `reconnect()` delegates to `WebSocketConnection.reconnect()` through the
  manager.
- the channel snapshot exposes one `multiplex-websocket` channel.
- `capabilities.sameOriginUrls` is true only when the WS URL is same-origin.

This is the unencrypted sibling of secure mode, not a variant of the localhost
composite path. It is also the cheapest real second source for coexistence
testing: a second local server (`PORT`/`YEP_PROFILE`) reachable at
`ws://localhost:<port>/api/ws` with no relay or SRP setup.

### Secure Or Relay Transport

`SecureSourceTransport` wraps the source's current `SecureConnection` via the
slot.

- `fetch`, uploads, session streams, watch streams, activity, ping/pong, and
  reconnect all use the attached secure connection.
- `reconnect()` delegates to `SecureConnection.forceReconnect()` through the
  manager.
- relay re-pair failures (`RelayReconnectRequiredError`) still surface to the
  connection-flow owner, which builds and attaches a replacement connection;
  the facade and its consumers are unaffected.
- the channel snapshot exposes `secure-websocket`, plus relay details when the
  connection is relay-backed.
- `capabilities.sameOriginUrls = false`; `speech` and `device` present.

## Relationship To ConnectionManager

`ConnectionManager` remains the reconnect/backoff state machine, unchanged in
policy, but instantiated **per transport** and never exported as an app
singleton. It is an implementation detail used by transport implementations
and surfaced through `SourceTransportStatus` and channel snapshots.

Callers stop importing the singleton `connectionManager` for source-owned
work. They observe `runtime.transport.status` instead. The status surface
exposes reconnect attempts, state, and errors without forcing callers to know
which concrete manager instance exists underneath.

## Runtime Placement

`YaSourceRuntime` carries one transport:

```ts
interface YaSourceRuntime {
  sourceKey: ClientSummarySourceKey;
  transport: SourceTransport;
  api: SourceApiClient;
  summary: SourceSummaryRuntime;
  sessionDetails: SessionDetailRuntime;
}
```

The existing narrow `SourceApiClient` remains as a session-detail-facing
subset while the broader transport boundary lands; over time it delegates to
`runtime.transport.fetch`. The registry mints facades; connection flows attach
backing connections; `fetchJSON` becomes a compatibility shim over the current
runtime's transport until callers migrate.

## Validation

- Unit-test the three transport implementations with fake underlying
  connections.
- Run the Behavior Parity Contract suite against the facade before any
  consumer migrates; every row above maps to a test.
- Prove localhost source status is ready and `reconnect()` is a no-op, while
  channel snapshots still expose stream/upload channel state and snapshot
  subscribers can observe channel changes.
- Prove plain multiplex WebSocket and secure transport both route fetch,
  uploads, activity, session streams, watch streams, ping/pong, and reconnect
  through one backing connection, and that attaching a replacement backing
  connection preserves facade identity and converges managed streams.
- Reproduce the 050 divergence in simulation (fetch-driven recovery during
  manager backoff) and assert the bar/state converges and no destructive
  reconnect fires.
- Add hook tests with two fake source runtimes: reconnect/status changes in
  one runtime must not resubscribe or clear subscriptions in the other.
- Preserve teardown behavior: closing a tab/component releases the session or
  watch subscription exactly once.
- Prove `pagehide` closes every retained activity subscription, `pageshow`
  recreates one per retained source, and repeated reloads never raise the
  server tab count above the actual document count.
- Preserve non-retryable subscription-error behavior.
- Before claiming real coexistence support, run two YA servers with
  independent transports and show that disposing one source does not affect
  the other.

## Resolved Questions

- **Channel-control methods on status?** No. Source-level `reconnect()` plus
  channel snapshots are the surface; add channel control only when a real
  consumer appears.
- **Managed subscriptions inside the transport?** Above it: one shared
  managed-stream helper over (`subscribe*`, `status`). Raw primitives stay
  dumb; implementations stay simple; the resubscribe engine exists exactly
  once.
- **Localhost upload-channel bookkeeping?** Ephemeral: the `upload-websocket`
  channel appears with an active-upload count while uploads run, `idle`/absent
  otherwise. No long-lived per-upload state.
- **Where does "secure connection implies activity bus" live?** In the source
  runtime layer as lease + ready convergence (see Activity Stream Lifecycle),
  not inside `SecureConnection` and not in React mount timing.

## Relationship To Existing Documents

- [`client-source-runtime-topology.md`](client-source-runtime-topology.md) is
  the parent topology vision; this document is its transport boundary.
- [`docs/tactical/057-source-transport-boundary.md`](../docs/tactical/057-source-transport-boundary.md)
  is the implementation runbook for this contract.
- [`docs/tactical/050-remote-activity-bus-secure-lifecycle.md`](../docs/tactical/050-remote-activity-bus-secure-lifecycle.md)
  documents the activity/transport lifecycle divergence, the landed
  `onAuthenticated` fix (parity row 9), and the deferred ownership inversion
  this boundary delivers.
- [`docs/tactical/021-client-connection-readiness-vs-state-consistency.md`](../docs/tactical/021-client-connection-readiness-vs-state-consistency.md)
  explains the bounded-wait readiness behavior preserved by parity row 10.
- [`docs/project/connection-matrix.md`](../docs/project/connection-matrix.md)
  explains the historical transport modes these implementations wrap.
- [`docs/project/ws-auth-state-model.md`](../docs/project/ws-auth-state-model.md)
  and [`docs/project/relay-design.md`](../docs/project/relay-design.md) remain
  the detailed auth/relay transport references.

### Browser tab credential ownership

Saved-host records are the authoritative browser resume credentials. Each
credential is bound to its transport mode, endpoint, relay server name (when
applicable), and SRP identity; source/cache identity remains separate from this
authentication scope. A relay URL resumes the host named in that URL. Direct
and unqualified navigation retain a tab-local host selection, while the
origin-wide last-host preference selects only an initial destination.

Authentication attempts capture their host, scope, and credential generation
before asynchronous acquisition. Successful resume may update only that
captured record. A newer password login, identity change, logout, rejection, or
host removal prevents older attempts from replacing or resurrecting its saved
credential. Concurrent resumes cannot lower an authenticated protocol pin.
A rejection or disconnect notice belongs to the attempted scope, independently
of the host subsequently selected by the UI.

The legacy single-connection record remains a compatibility mirror for cached
clients. Current clients prefer the saved-host credential, and import legacy
credentials only when identity and direct endpoint agree with their envelope.
A mixed legacy record cannot override a valid saved host. Updating its session
requires the exact captured scope and last mirrored session; another tab's
reconnect cannot attach a session to the mirror's unrelated destination. A
verified password fallback may replace an absent session after rejection,
provided its authoritative authentication intent remains current. Switch Host
changes tab selection without erasing another tab's credential. Explicit web
logout erases only the credential generation owned by that tab; native login
and credential storage remain owned by the installed application's transport.

Cross-tab generation ordering applies to cooperating current clients. Cached
older clients do not participate in these checks and should be refreshed; their
legacy single-connection mirror is never authoritative for current saved hosts.
Persistence and erasure remain best effort when browser storage is unavailable.

Verified session establishment distinguishes full password authentication from
resume. A resumed key is saved only while its exact session remains active;
received refusal cannot be undone by a delayed resume callback. A connection
still holding its password may store a newly verified full-SRP fallback under
the same authentication intent. Explicit erasure and newer password attempts
invalidate that intent, so fallback cannot undo logout or replace a newer login.

The active browser connection publishes the exact source key to route binding.
A temporary login without a matching saved host uses an in-memory runtime key
bound to its full authentication scope, including principal. Sharing a relay
name or direct endpoint with a saved host cannot borrow that host's transport
or caches. Temporary login creates no saved host or credential. Native source
binding remains owned by the installed shell.

Recovery retains the attempted authentication scope and runtime ownership.
Automatic and explicit retry may use only credentials from that scope; a
same-name host under another endpoint or principal cannot substitute for a
temporary login. When that scope has no saved credential, explicit sign-in
retains its relay endpoint and principal rather than selecting a saved account.
