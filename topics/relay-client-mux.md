# Relay Client Multiplexing

> One browser or future Android client may carry several independently
> authenticated YA host connections over one physical WebSocket to a shared
> relay. The relay remains an opaque router: it learns circuit-to-username
> routing, but never SRP secrets, session keys, or YA payload contents.

Topic: relay-client-mux

Status: Landed 2026-07-30 after compatibility approval. The experimental
monitor uses mux when the relay advertises it and preserves exact `/ws`
fallback. The Android native extension was approved 2026-08-03: its
demand-owned relay pool makes even one eligible host mux-capable and measures
ordinary/full traffic over the circuit before adding a dedicated-socket policy.

Related:

- [Multi-host monitor and coexistence harness](../docs/tactical/066-multi-host-monitor-coexistence-harness.md)
- [Client source-runtime topology](client-source-runtime-topology.md)
- [Source transport](source-transport.md)
- [Server capabilities](server-capabilities.md)
- [Remote hosted compatibility](remote-hosted-compatibility.md)
- [Hard development rules](hard-development-rules.md)
- [Relay design](../docs/project/relay-design.md)

## Product Boundary

Mux is an optional transport optimization for the experimental multi-host
monitor. It is not federation, an account system, a server membership model,
or a prerequisite for viewing multiple hosts.

The observable contract preserves the fallback:

- each saved relay host owns an independent SRP identity, resume session,
  NaCl key, source runtime, and readiness state;
- one host may connect, fail, retry, or sign out without changing its peers;
- ordinary `/ws` client-to-relay connections continue to work unchanged; and
- a client using a relay without mux support opens one ordinary WebSocket per
  selected relay host.

Mux changes only the number of browser-to-relay sockets. YA servers keep their
existing server-to-relay waiting sockets and receive the same inner text and
binary frames they receive today.

The first client consumer is `/-/monitor`, which is already deliberate-entry
and default-hidden. Ordinary single-host routes keep using the legacy path.
The later Android client reuses the proven transport behind a separate native
pool; it does not change the browser consumer's selection policy.

## Stable-Release Compatibility Audit

This is narrow optional functionality, so the minimum corpus is the latest two
stable releases plus every stable release from the preceding 14 days.

As of 2026-07-30 the corpus is:

| Release | Released | Why included |
| --- | --- | --- |
| `v0.7.0` | 2026-07-25 | latest stable and inside 14 days |
| `v0.6.2` | 2026-07-11 | second-latest stable |

Both tags have the same relevant relay contract:

- `GET /health` exists and returns `status`, `uptime`, `waiting`, and `pairs`;
- WebSocket upgrades accept `/ws` and reject other paths;
- one `client_connect` or `client_connect_channel` claims one waiting server
  socket and turns the two sockets into one opaque pair; and
- neither tag has a relay mux capability, `/mux`, outer circuit frames, or
  client-side circuit pool.

No YA `/api` route, response field, or activity event needs to change. Old YA
servers can participate behind a new relay because each logical circuit still
claims one ordinary waiting server socket and forwards the existing SRP/NaCl
stream unchanged.

## Discovery And Compatibility Contract

Mux uses a relay-owned capability, not the YA server capability registry:

```ts
export const RELAY_CLIENT_MUX_V1_CAPABILITY = "client-mux-v1";

interface RelayHealthResponse {
  status: "ok";
  uptime: number;
  waiting: number;
  pairs: number;
  relayCapabilities?: string[];
}
```

The new relay adds `client-mux-v1` to the additive
`relayCapabilities` field on its existing `GET /health` route.

The client:

1. derives the relay HTTP base from the configured terminal `/ws` URL;
2. probes `GET /health` once per normalized relay base for the page lifetime,
   with a short bounded timeout;
3. opens `/mux` only when `relayCapabilities` contains
   `client-mux-v1`; and
4. treats an absent field, old response, HTTP error, CORS/proxy failure,
   malformed response, or timeout as "mux unavailable."

Thus `v0.7.0`, `v0.6.2`, and older compatible relays receive only a request to
an endpoint they already support. The client makes no `/mux` request when its
gate is absent.

Exact absent-capability behavior is ordinary independent `/ws` sockets with
the already-proven monitor behavior. No control disappears and no host becomes
unusable.

This does not add or broaden a YA server capability, does not change an
existing capability's meaning, and does not raise
`remoteCompatibilityLevel`. Old client + new relay, new server + old relay,
and old server + new relay all retain the legacy path.

## Grouping And Selection

- Group saved relay hosts by normalized relay base URL.
- Use one physical `/mux` socket for up to five selected app-channel hosts in
  a group.
- Direct hosts and hosts on relays without the capability remain independent.
- A group containing only one selected host stays on `/ws`; mux has no socket
  count benefit there in the browser monitor. Android intentionally differs:
  one demanded eligible relay host may use mux so adding a peer or moving one
  host to an authenticated direct route never requires replacing the group's
  physical relay transport.
- More than five selected hosts do not fail. The first five may use one mux;
  overflow hosts use legacy sockets until a later, measured reason justifies
  multiple mux sockets or a higher limit.
- Readiness remains progressive. One physical connection does not make five
  SRP/resume handshakes atomic or simultaneous.

The initial host order is saved-host order, matching the monitor's current
selection policy. Persisted active/inactive host selection remains separate
future product work.

## Mux V1 Wire Contract

### Physical connection

The browser upgrades the discovered relay base at `/mux`. On open, the relay
sends:

```ts
interface RelayMuxReady {
  type: "mux_ready";
  protocolVersion: 1;
  maxCircuits: 5;
  maxFrameBytes: number;
}
```

A missing, malformed, mismatched, or late `mux_ready` fails the mux attempt
before any logical socket is handed to `SecureConnection`.

### Circuit control

Control frames are JSON text frames:

```ts
interface RelayMuxOpen {
  type: "mux_open";
  circuitId: number; // nonzero uint32, client allocated
  username: string;
  channel: RelayChannel;
}

interface RelayMuxOpened {
  type: "mux_opened";
  circuitId: number;
}

interface RelayMuxError {
  type: "mux_error";
  circuitId: number;
  reason:
    | "unknown_username"
    | "server_offline"
    | "circuit_limit"
    | "rate_limited"
    | "invalid_request";
}

interface RelayMuxClose {
  type: "mux_close";
  circuitId: number;
}

interface RelayMuxClosed {
  type: "mux_closed";
  circuitId: number;
  reason: "client_closed" | "server_closed" | "relay_closed";
}
```

An open either claims one existing waiting server socket and returns
`mux_opened`, or returns a circuit-scoped `mux_error`. It never closes healthy
circuits because another username is offline or invalid.

Closing a circuit closes its claimed server socket, allowing the YA relay
supervisor to replenish it exactly as after a legacy client disconnect.
A claim, by circuit or legacy `/ws` socket, must carry a client frame within
20 seconds (`RELAY_PAIR_FIRST_MESSAGE_TIMEOUT_MS`). The server learns of a
claim only from that frame, so the relay closes a silent claim and its server
socket; the server then registers a fresh waiting socket. A circuit closed this
way receives `mux_closed` and its mux socket stays open.
Closing the physical mux closes all claimed server sockets. A server-side
disconnect closes only its circuit and emits `mux_closed`.

Circuit ids cannot be reused until their close/error lifecycle is complete.
Unknown ids and malformed control frames are rejected without being forwarded.
Repeated malformed frames close the physical socket with a policy error.

### Opaque data

Data uses binary outer frames so inner encrypted binary payloads do not incur
base64 expansion:

```text
byte 0      mux protocol version (1)
byte 1      flags (bit 0: inner frame was binary)
bytes 2..5  circuit id, unsigned big-endian
bytes 6..n  opaque inner payload
```

The relay does not parse bytes `6..n`. It uses the flag only to preserve the
inner WebSocket frame type when forwarding to the legacy YA server socket.
Frames from a server are wrapped with the same header before entering the
physical mux.

Each circuit runs the existing SRP/resume handshake and derives its own NaCl
transport key. A valid credential for one username grants no authority over a
second circuit.

## Scheduling, Bounds, And Abuse Resistance

TCP-level head-of-line blocking remains possible on one physical socket. Mux
V1 accepts that for the monitor's small summary/activity messages, while
preventing application-level starvation:

- outgoing frames are queued per circuit and drained round-robin, one frame per
  ready circuit per pass;
- the browser and relay stop draining while the physical socket's
  `bufferedAmount` is above a high-water mark;
- an outer data frame is capped at 2 MiB;
- queued data is capped at 2 MiB per circuit and 8 MiB per physical socket;
  overflow closes the offending circuit rather than every peer; and
- upload/media/full-transcript traffic stays on legacy sockets in the first
  consumer. The monitor leaves its mux route before opening a full session.

The Android extension begins with one source connection per host, not separate
summary and full-session connections. Its normal API, WebView, media, and
64 KiB upload frames use that host's mux circuit when the relay advertises the
capability. The 2 MiB frame cap already bounds every upload chunk. Physical
Pixel tests must measure a large upload beside another host's activity stream;
only observed starvation, memory, or lifecycle problems justify later
dedicated-socket promotion.

Initial configurable relay defaults:

- at most 5 live circuits per mux socket;
- at most 20 live mux circuits per effective client IP;
- at most 20 circuit-open attempts per minute per mux socket;
- at most 60 opens per minute per effective client IP; and
- at most 6 opens per minute for one effective-IP/username pair.

The existing trusted-proxy resolution, Origin policy, and unauthenticated
physical-socket cap apply to `/mux`. A zero-circuit mux closes after 30 seconds;
that timer restarts when its last circuit closes. Opening or abandoning a mux
must never create an indefinite idle relay resource.

These limits reduce amplification relative to opening arbitrary logical
circuits while preserving the expected three-to-five machine use case.
They do not claim to solve the legacy username-claim denial already possible
through separate `/ws` sockets, although a silent claim now holds a server for
at most the first-frame timeout.

The native client treats any refused circuit open, `rate_limited` included, as
a failed mux setup and connects that host through a legacy `/ws` socket in the
same attempt. The bundled app's
[exhausted recovery](source-transport.md#one-exhausted-recovery-scheduler) is
paced against the six-a-minute pair limit and can exceed it by one open, or by
more when the user keeps prompting retries; the cost is that connection's
place on the shared socket until it next reconnects.

## Client Ownership And Fallback

Introduce a narrow socket interface used by `SecureConnection`; native
`WebSocket` and a mux logical circuit both implement it. Do not cast a partial
object to the full browser `WebSocket` class.

A page-scoped pool owns discovery, one physical mux per eligible relay group,
circuit allocation, fair client-side writes, and physical reconnect
deduplication. Individual `SecureConnection`s still own their SRP state,
encrypted request protocol, and per-source connection managers.

Fallback rules:

- discovery absent or failed: open legacy sockets immediately;
- `/mux` upgrade or `mux_ready` fails before exposure: mark that relay group
  degraded for the page lifetime and open legacy sockets;
- one circuit open fails: report only that host's existing offline/error state;
- one circuit later closes: its normal reconnect asks the pool for a new
  circuit while peers stay live;
- physical mux loss: close all logical sockets, make one coordinated bounded
  mux reconnect attempt, and let per-host reconnects fall back to independent
  legacy sockets if that attempt fails; and
- once a group degrades, do not oscillate between mux and legacy until remount.

No connection is exposed through both a circuit and a legacy socket at once.
Teardown aborts discovery, closes every circuit, stops the physical reconnect
owner, and releases the source runtimes already owned by the monitor.

## Observability

Relay `/status` adds mux physical-socket and live-circuit counts plus bounded
open/error/close counters by reason. Structured telemetry distinguishes
physical mux lifecycle from logical circuit lifecycle so socket reduction and
failure concentration can be measured.

The relay stats page reads daily telemetry as LF-delimited JSON. A valid row
counts even when a field contains U+2028 or U+2029.

The monitor continues to expose source readiness, not relay internals. Debug
logging may show relay grouping and fallback only behind the existing relay
debug preference.

Mux makes a set of usernames on one physical client connection explicit to the
relay. The relay could already correlate separate sockets by IP and timing, but
this is a modest privacy change and should be stated in remote-access docs
before promoting mux beyond an experimental surface.

## Verification Gate

Lower-level relay tests use one raw mux client and three ordinary registered
server sockets to prove:

- text and binary frame-type preservation;
- independent open, data, close, and error lifecycle;
- unknown/offline username isolation;
- duplicate/unknown circuit rejection;
- max-circuit, frame, queue, idle, and rate bounds;
- round-robin scheduling; and
- physical close cleanup.

The existing browser matrix then runs in both modes:

- legacy relay discovery without `client-mux-v1`: exactly three `/ws` sockets;
- mux relay discovery: exactly one `/mux` and no browser `/ws` sockets for
  three selected hosts;
- three independent real SRP resumes with colliding YA ids and distinct data;
- offline, stale-session, connected-drop, explicit-disposal, and route-teardown
  isolation; and
- the same visible `Connected N of M` behavior in both modes.

Tests must observe paths as well as socket count so Vite/HMR sockets and mixed
fallback cannot satisfy the mux assertion accidentally.

## Implementation Slices

1. **B0 — contract and approval:** land this topic, stable-release audit, and
   exact compatibility plan. Landed 2026-07-30 after maintainer approval.
2. **B1 — relay protocol:** add shared mux types/framing, health discovery,
   generalized relay pairing, bounds, telemetry, and raw relay tests. Preserve
   `/ws`. Landed 2026-07-30.
3. **B2 — client pool:** add the narrow socket boundary, relay discovery,
   logical circuits, grouped monitor connector, and exact legacy fallback.
   Landed 2026-07-30.
4. **B3 — browser exit gate:** run the full matrix in legacy and mux modes,
   retain the existing independent-socket proof, and update this status from
   experimental implementation to landed. Landed 2026-07-30.

The lower-level suite proves routing, frame-type preservation, per-circuit
failure, physical cleanup, fair scheduling, and the configured circuit,
queue, rate, and idle bounds. The browser suite runs all seven multi-host
coexistence scenarios in both legacy and mux modes: legacy observes exactly
three `/ws` sockets, while mux observes exactly one `/mux` socket for the same
three independently authenticated sources.

## Non-Goals

- Sharing SRP or NaCl state across hosts.
- One username representing several YA servers.
- Relay-owned accounts, host lists, notification aggregation, or application
  data.
- Changing server-to-relay registration in V1.
- Sending bulk uploads, device media, or full-session traffic through mux
  from the first experimental browser-monitor consumer. Android is the
  separately measured next consumer and may send this traffic under the bounds
  above.
- Removing `/ws`, its current framing, or the old-client/new-relay path.
- Building Android before browser mux behavior is proven.
