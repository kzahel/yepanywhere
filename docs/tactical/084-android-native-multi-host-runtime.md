# Android Native Multi-Host Runtime And Settings

Topic: android-native-multi-host
Topic: relay-client-mux
Topic: mobile-server-pairing

Status: Implemented and Pixel-validated 2026-08-03. Production relay rollout
remains a deployment follow-up.

## Outcome

Android opens to a unified native view of the user's included YA servers.
Server chips filter that view rather than owning connections. Every session or
attention card identifies its source with the server username and, when the
connected server advertises `host-identity`, its server-owned emoji.

The app stores several paired profiles, lets the user include or exclude each
one from unified views, and connects only while a visible or background owner
demands it. Eligible relay profiles use one physical `/mux` socket per relay
base even when only one circuit is currently demanded. Each circuit retains
independent SRP/NaCl state, request and subscription ids, readiness, retry,
reauthentication, revocation, and cleanup.

Dedicated native settings own add, include/exclude, reauthenticate,
notification state, unregister, and forget behavior. The existing inline
prototype remains only until those settings are usable.

Related contracts:

- [Mobile server pairing](../../topics/mobile-server-pairing.md)
- [Relay client multiplexing](../../topics/relay-client-mux.md)
- [Client source runtime topology](../../topics/client-source-runtime-topology.md)
- [Host identity](../../topics/host-identity.md)
- [Security-client audit](../../topics/security-client-audit.md)
- [Architecture mandates](../../topics/architecture-mandates.md)
- [Bundled-web native transport](083-android-bundled-web-native-transport.md)

## Compatibility contract

This is an optional relay-client feature. On 2026-08-03 the applicable stable
corpus remains:

| Release | Released | Relay contract |
| --- | --- | --- |
| `v0.7.0` | 2026-07-25 | `/ws`; no relay capability field or `/mux` |
| `v0.6.2` | 2026-07-11 | `/ws`; no relay capability field or `/mux` |

Android derives the relay HTTP base from the configured `/ws` URL and probes
the existing `GET /health` with a short bounded timeout. It opens `/mux` only
when `relayCapabilities` contains the existing permanent exact
`client-mux-v1` gate. Missing fields, old responses, HTTP/CORS/proxy failure,
malformed data, timeouts, mux readiness failure, and group degradation use the
existing independent `/ws` path. No YA-server route, response, capability, or
authentication behavior changes.

## Saved, included, demanded, and connected

These are deliberately different states:

- **Saved:** the profile, routes, protected resume credential, and continuity
  binding remain on the phone.
- **Included:** the user wants the profile represented in unified views and
  filters. New and pre-existing profiles default included.
- **Demanded:** a visible screen, full WebView, explicit foreground service, or
  other bounded owner currently holds a lease.
- **Connected:** observed runtime state resulting from current demand and route
  availability; it is never a persisted preference.
- **Notifications enabled:** separately owned per profile and not implied by
  inclusion or a live socket.

Persist inclusion outside the profile codec so absence upgrades safely to all
saved profiles included. Forgetting removes the id from inclusion. A disabled
profile remains saved, can be opened explicitly with a transient lease, and
does not appear in the normal unified filter set.

The visible unified dashboard demands every included profile only while the
screen is started. Stopping it releases those leases. A saved profile alone
never creates an idle socket, retry loop, heartbeat, subscription, or mux
circuit. The mux pool closes after its final circuit with bounded client-side
hysteresis and never relies on the relay's idle reap as its owner.

## Native mux and route ownership

Introduce a process-level relay socket broker keyed by normalized relay base.
It owns capability discovery, one physical mux, circuit allocation, bounded
per-circuit queues, round-robin writes, physical reconnect deduplication, and
exact `/ws` fallback. `YaServerConnectionManager` continues to own one
profile's logical authenticated session and subscriptions.

One eligible demanded host may open one mux circuit. Adding another compatible
host reuses the physical socket. Closing or failing one circuit does not close
peers. A physical loss notifies all affected logical connections; each manager
retries independently through one coordinated pool recovery or the established
legacy fallback.

Android initially carries normal API and session traffic through the logical
circuit. The broker enforces bounded queues and fair writes now. WebView,
media, and 64 KiB upload traffic will use that same circuit when the native
WebView transport lands. Its Pixel exit gate owns the representative large
upload, queue high-water, latency, and memory measurements; see tactical 083
steps 5–7. A dedicated bulk socket remains a measured optimization, not
baseline architecture.

Future authenticated direct discovery remains below the same logical source.
When a direct route proves resume continuity, that profile may close its mux
circuit and reconnect/restore subscriptions directly while peer circuits stay
live. Direct failure reopens a relay circuit. This tactical does not implement
LAN discovery, but it must not make route changes require a new profile.

## Unified native presentation

The home filter defaults to **All servers**. Included profiles appear as chips;
tapping a chip filters already source-tagged cards and does not acquire,
release, or switch global authentication. Every native summary key is composite
across profile id, project id where applicable, and YA-visible session id.

Aggregate attention and recent-session cards display a compact source badge.
When connected and capability-gated settings provide `hostIdentity.icon`, use
the emoji beside the username. Older or cold-offline servers use the username
alone. One profile's loading, offline, sign-in-required, or revoked state is
shown without blocking healthy data from peers.

Opening full web content or a native detail starts with the card's source
profile, not whichever filter is selected later. The later WebView bridge uses
the same source identity.

## Server settings and removal

A settings gear opens a dedicated native settings surface. Its Servers section
lists every saved profile, including excluded ones, with username, optional
connected emoji, inclusion toggle, connection state, and route summary. It
offers Add server and per-profile details for reauthentication, notifications,
advanced routes, unregister, and forget. No extra required server-name field is
introduced; route text disambiguates equal usernames when necessary.

Removal separates two operations:

- **Unregister** deletes the capable server security-client record, causing its
  resume sessions, connections, and push children to be revoked. It preserves
  a local route/username row only when the user deliberately intends to pair it
  again.
- **Forget from this phone** releases native demand and deletes local profile,
  resume credential, continuity key, and inclusion state. It cannot claim the
  server record was removed.

When the host is online and has a registered capable security client, the
recommended Remove action unregisters first and forgets locally after the
successful response. Because revocation may close the transport after the
response, cleanup must tolerate that expected close. If the host is offline or
unregister fails, a second confirmation offers **Forget anyway** and warns that
the server-side device and push record may remain. Older servers without
`security-client-audit-v1` expose only honest local forgetting.

## Implementation plan

### 1 — persist included-server policy

Add default-all inclusion storage, atomic add/forget updates, repository tests,
and state projection that never mistakes selected/filter state for demand.

### 2 — give Android a relay mux socket broker

Port the landed framing, discovery, circuit lifecycle, fair queues, bounds,
fallback, and cleanup semantics behind the narrow native socket abstraction.
Make one eligible host mux-capable and retain per-profile authentication.

### 3 — keep included source summaries concurrent

Replace the one-selected-profile ViewModel lease with a visible-screen owner
for all included profiles. Maintain per-profile connection, error, settings,
and session summaries; release every lease and subscription on stop.

### 4 — render the unified filtered dashboard

Add All/default and per-profile filters, source badges, capability-gated emoji,
progressive healthy data, and per-host retry/sign-in state. Keep cards keyed and
routed by source profile.

### 5 — move server CRUD into native settings

Add the gear, saved-server list, inclusion toggles, add and reauthentication
flows, advanced route facts, notification placeholders/status, and profile
details. Remove the crowded inline CRUD prototype after parity is proven.

### 6 — unregister and forget honestly

Add capable online unregister, response-before-cascade handling, local cleanup,
offline/older-server Forget anyway, key deletion, demand teardown, and focused
tests for every partial failure.

### 7 — prove multi-host behavior locally and on Pixel

Use disposable YA profiles with colliding session ids and one failing source to
prove isolation, exact `/mux` versus `/ws` paths, one-host mux, inclusion
changes, restart persistence, and teardown. Then use the attached Pixel's three
existing profiles for real relay validation. Clear app data only for explicit
clean-install/restart cases, and restore/re-pair only with maintainer-provided
credentials.

## Validation record

The primary implementation slices landed as independently reviewable commits:

| Slice | Commit |
| --- | --- |
| relay mux broker and socket abstraction | `12469117` |
| saved inclusion policy | `cb209ea7` |
| concurrent sources, unified view, and settings | `20e0190d` |
| unregister-before-forget removal | `9e11f748` |

The 2026-08-03 attached-Pixel pass preserved the phone's three existing
profiles and added two disposable local profiles. The local profiles used two
standalone YA data directories behind one local relay. Relay status observed
one physical `/mux`, two live circuits, and two paired servers. Excluding only
`mux-beta` reduced live circuits to one while `mux-alpha` remained connected;
including it again restored two circuits on the same physical socket. Stopping
one standalone server left the other source and the phone's three existing
sources usable. The Pixel also proved All-server projection, source filters,
server emoji, persisted inclusion across process restart, capable unregister,
and local cleanup. Both disposable profiles were removed afterward.

Validation found and fixed two defects before completion: the health probe had
treated an ordinary short response as premature EOF, and retrying one source
had restarted every source binding. A bounded small-response probe test now
covers the former, while runtime binding revisions and retry actions are
profile-scoped. Settings Back navigation was also corrected during the device
pass.

The public relay inspected during this pass did not yet advertise
`client-mux-v1`, so the three existing production profiles honestly exercised
the exact legacy `/ws` fallback. Deploying a mux-capable relay is operational
follow-up, not an Android compatibility blocker. The 100 MiB upload and
Compose/WebView contention benchmark remains explicitly assigned to tactical
083 because this native summary slice has no WebView proxy or native upload
consumer yet.

## Commit and review checkpoints

Land the contract first, then independently reviewable commits for inclusion
storage, mux broker, concurrent state, unified UI/settings, and removal. Every
slice runs warning-free Android unit/lint/build checks appropriate to its
surface.

The first human checkpoint was reached with the Pixel's three existing
profiles plus two disposable mux-capable local profiles: one physical mux,
isolated profile failure, persisted inclusion, and successful removal were all
observed. WebView work may now proceed from this source/runtime boundary.

## Conversation consumer checkpoint — 2026-09-12

The [simple-client plan](130-simple-client-api-and-three-client-demo.md#first-android-compose-preview--2026-09-12)
now adds a read-only Compose Conversation activity to native session cards.
It consumes the experimental snapshot contract through a selected profile's
foreground lease; it does not change home catalog/grouping or introduce a
WebView transport proxy. Unlike activity subscriptions, Conversation bindings
close on disconnect and require a fresh binding/sequence after reconnect.
Direct encrypted AVD navigation, live updates, rotation and lifecycle release
are covered by the new instrumentation test. Full-session handoff retains the
selected endpoint and uses the web client's separate authentication.
