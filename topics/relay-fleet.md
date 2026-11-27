# Relay Fleet

> A relay fleet is a small set of relay nodes in different regions, run by one
> operator, that behave as one relay: a YA server stays reachable under one
> relay username, a client reaches it through a nearby node, and losing a node
> costs a reconnect rather than an outage. Each node remains an opaque router.

Topic: relay-fleet

Status: **proposal, 2026-11-27. Nothing here is implemented.** It records the
design discussion that had existed only in conversations, re-evaluated against
the current relay, and recommends a direction. The decisions in
[Decisions needed](#decisions-needed) are the maintainer's; the wire shapes are
illustrative until those are made. Implementation also requires the
[compatibility review](server-capabilities.md#minimum-compatibility-horizons)
and the relay-selection rules in
[hard development rules](hard-development-rules.md).

Related:

- [Relay client multiplexing](relay-client-mux.md)
- [Source transport](source-transport.md)
- [Security trust boundaries](security.md#authenticated-remote-access-and-the-relay)
- [Relay origin and share gating](relay-origin-and-share-gating.md)
- [Hard development rules](hard-development-rules.md)
- [Remote hosted compatibility](remote-hosted-compatibility.md)
- [Android host battery-aware relay liveness](android-host.md#battery-aware-relay-liveness)
- [Relay design](../docs/project/relay-design.md) and
  [relay observability](../docs/project/2026-03-10-relay-observability-and-compatibility.md)

## Why

The default public relay is one process in one European location. Every Remote
Access byte crosses it, so a user whose phone and YA server are both in North
America or Australia pays two ocean crossings per round trip. Latency is the
main reason for this work.

Scale and availability are the second reason. On 2026-11-27 that node held 142
waiting server sockets and 26 active pairs, up from 62 and 8 on 2026-03-07. It
is nowhere near a capacity limit, but a restart or outage of the one node
disconnects every relay user at once, and there is no way to add capacity or
take a node out of service gracefully.

## Current behavior this must preserve

- A YA server registers a relay username with its `installId` over
  `server_register` and holds one waiting socket per channel. A client claim
  consumes that socket; the server opens a replacement immediately
  (`packages/server/src/services/RelayClientService.ts`).
- Username ownership is first come, first served per node, in that node's
  SQLite `usernames` table. The same `installId` may re-register; a different
  one is refused; a name unseen for 90 days is reclaimed
  (`packages/relay/src/registry.ts`).
- Pairing state is in process memory (`packages/relay/src/connections.ts`).
  Two relay processes therefore share nothing.
- A client knows a host as a configured relay URL plus a relay username.
  Saved browser credentials are bound to mode, endpoint, relay server name and
  SRP identity ([source transport](source-transport.md#browser-tab-credential-ownership)).
  Relay login and share URLs can carry the relay URL in their `r` parameter;
  some omit it when it is the default.
- Relay capabilities are discovered from the additive `relayCapabilities`
  field of `GET /health`; `client-mux-v1` is the only one today. Mux groups a
  client's hosts by normalized relay URL and carries up to five circuits per
  socket.
- Explicit relay configuration is authoritative. YA must not silently repoint
  a user at different infrastructure.
- The relay is a dumb pipe: SRP and NaCl run end to end and no node holds keys.

## History

- January 2026: the original relay design listed multiple regions as a
  non-goal and sketched a central lookup service in a few lines.
- March 2026: two design conversations, never written down. They concluded on
  a trusted, operator-managed fleet of two to four nodes; unchanged behavior
  with a single node; each YA server sticky to one home node chosen by
  latency; a client redirected from any node to the home node; a full registry
  copy on every node with best-effort peer checks at registration and
  first-timestamp-wins conflict resolution that evicts the loser; slow,
  jittered failover with no automatic move back; and an operator-triggered
  rebalance message. Node-to-node transport and peer discovery were left open.
- March 2026: relay telemetry gained a node id (`RELAY_NODE_ID`) so that
  events from several nodes could later be aggregated.

Three later changes make that model worth revisiting rather than implementing
as discussed:

- Mux shipped. With one home node per server, a client whose hosts live on
  different nodes needs one mux socket per node, and the pool has to regroup
  when a host moves.
- Native clients shipped. Android, iOS and the Chrome extension bundle their
  client code, so they update far more slowly than the hosted web client.
  A redirect only helps a client that understands it; an older bundled client
  reaching the entry node for a server homed elsewhere would simply see it
  offline.
- Saved credentials are bound to the configured relay endpoint. Any design in
  which the client's notion of "the relay" changes after a redirect risks
  invalidating saved sessions.

## Comparison with other projects

Read from local checkouts on 2026-11-27; the Paseo and Happy checkouts date
from February and March 2026.

| Project | How both ends meet | Regions | End to end encrypted | Lesson for YA |
| --- | --- | --- | --- | --- |
| RustDesk | The host registers with every configured rendezvous server. The client latency-tests the list and picks one, which names the relay and a session id for both ends. | Operator-run servers; the client chooses | Yes | The closest precedent for a small set of plain servers. No directory is needed when the host is present everywhere. |
| Paseo | A Cloudflare Durable Object named after a random server id; both ends address the same object. The pairing link embeds the relay endpoint. | Wherever the platform places the object | Yes (NaCl box) | Random ids need no ownership registry, but the id is a capability: any holder can displace the daemon's socket. |
| T3 Code | A Cloudflare Worker control plane stores account and environment to tunnel hostname in Postgres. Data flows through Cloudflare Tunnel, not the relay. | The platform's edge; the control plane is pinned beside its database | No | Fence ownership with a generation counter so delayed cleanup cannot remove a newer registration. A self-hosted relay exists only on an unmerged branch, limited to one replica by its in-memory channel map. |
| Happy | One server replica with in-memory per-account maps, Postgres behind it. | Single instance | Yes (blind store and forward) | In-memory routing forces one replica until something else carries the routing. |
| opencode share | A Durable Object per session id. | Platform | No | Not comparable: one-way publishing. |

Two approaches recur. Hosted platforms give a globally addressable stateful
object or tunnel and let the provider place it. That conflicts with YA's
self-hostable Node relay, its preference for few runtime dependencies, and
user-chosen relay usernames, and it puts a third party in the path of every
connection. Operators of plain servers either run one instance or, as RustDesk
does, make the host present on all of them.

## Recommended design

The recommendation differs from the March conclusions in two places: where a
YA server waits, and how username ownership is kept unique. Both changes
remove moving parts. The March model is kept as the main
[alternative](#alternatives).

### Vocabulary

- **Fleet**: the nodes one operator runs as one relay.
- **Node**: one relay process with its own public URL, id and region.
- **Entry URL**: the relay URL the user configured, for example the default
  `wss://relay.yepanywhere.com/ws`. It stays the identity of the relay in
  saved hosts, credentials, share links and settings.
- **Authority**: the one node whose registry decides username ownership. The
  entry URL resolves to it.

### Discovery

A fleet node adds `fleet-v1` to `relayCapabilities` and serves its manifest:

```ts
interface RelayFleetManifest {
  nodes: Array<{
    id: string; // matches RELAY_NODE_ID
    region: string; // display only, for example "eu" or "us"
    url: string; // that node's /ws URL
  }>;
}
```

Every node serves the same static manifest from its configuration. A relay
with no fleet configured advertises nothing and behaves exactly as today,
which is also how every self-hosted relay behaves unless its operator
configures one.

The manifest is trusted because it came over TLS from the relay the user
configured. It grants nothing new: that relay could already drop or delay
traffic, and cannot read it. Clients and servers accept only `wss:` node URLs
and never follow a node address obtained any other way. Settings show the
node list so that the extra connections are visible.

### A YA server waits on every node

A fleet-aware YA server fetches the manifest from its entry URL and runs its
existing registration loop against each node: one waiting socket per node per
channel, replenished after each claim as today.

Consequences:

- A client can use whichever node is nearest to it. No lookup, redirect or
  home-node record exists.
- Losing a node moves no server and writes nothing to any registry. Servers
  keep retrying the lost node on their existing backoff while remaining
  reachable through the others.
- Adding a node needs no migration. Servers start waiting on it when they next
  read the manifest.
- An older bundled client, which knows only the entry URL, still finds every
  fleet-aware server there. No compatibility shim is needed.

The cost is one more idle socket and keepalive per node for each server, and
every node carries the whole idle population. Idle sockets are cheap at the
current size, and data traffic, which is the real load, spreads by client
location. If the idle population ever becomes the limit, a server can wait on
only its nearest few nodes; the client behavior below already tolerates that.

The server's reconnect backoff currently has no jitter, so every server
retries a restarted node on the same schedule. Add jitter as part of this
work.

### A client picks a node and stays on it

A fleet-aware client that sees `fleet-v1` on its entry URL fetches the
manifest and measures `GET /health` round-trip time to each node.

- It uses the fastest node for every host on that fleet, so mux still needs
  only one socket per fleet. The mux pool groups by entry URL as today and
  connects to the chosen node.
- It is sticky. The chosen node is remembered per entry URL and reused until
  it fails or a later measurement shows another node clearly better. The
  margin and re-measurement interval are tuning values to settle by
  measurement, not part of the contract.
- If the chosen node answers `server_offline` or `unknown_username` for one
  host, the client tries that host on the remaining nodes, always including
  the entry URL, before reporting it offline. This covers YA servers that
  predate the fleet and wait only on the entry node, servers that wait on a
  subset, and a server whose link to one node is down. Such a host gets its
  own socket to the node that has it; the rest stay on the shared one.
- The node is routing state only. It is not stored in saved hosts, bound into
  credentials, or written into URLs and share links. A session resumes through
  any node because resume state lives on the YA server.

Known limitation: the client measures only its own leg. When the client and
the YA server are in different regions and a third node sits between them, the
client's nearest node is not always the best one for the pair. The error is
bounded by the detour through one node. Publishing each server's measured
round-trip time per node would fix it and is deferred until measurement shows
it matters.

### One node owns usernames

Uniqueness must hold across the fleet. Otherwise a second installation could
register an existing username on a node where it was not yet known and
intercept that user's connection attempts. SRP would stop it from reading or
impersonating anything, but the real server would be unreachable from that
node.

The authority's registry is the single source of truth. This matches the
present situation: every existing server already registers on the entry node.

- The authority handles `server_register` exactly as today.
- Another node keeps the same table as a cache. On a registration it accepts a
  cached row for the same `installId` that it validated recently. Otherwise it
  asks the authority, which applies the normal first-come rule, and caches the
  answer. A cached row for a different `installId` is never trusted without
  asking.
- That validation doubles as the activity report. Only the authority reclaims
  inactive usernames, using activity from every node.
- If the authority is unreachable, a node keeps accepting servers it has
  already validated and refuses unknown claims with a retryable reason. An
  authority outage therefore blocks only first-time claims of a new username
  and takes the entry URL down for clients and servers that predate the fleet.
  Fleet-aware servers and clients continue through the other nodes.

Node-to-authority calls are HTTPS requests authenticated with a fleet secret
that the operator installs on each node. Nothing calls from the authority to a
node, and nodes do not talk to each other, so there is no peer mesh, no
replication protocol and no conflict to resolve.

### Operations

- **Deploys and restarts** become rolling. Pairs on the restarted node drop
  and resume through another node; today a restart disconnects everyone.
- **Draining**: a node reports `draining` on `/health`. Clients and servers
  stop choosing it for new connections; existing pairs finish.
- **Observability**: `/health` and `/status` report the node id and region.
  Per-node statistics exist already; a combined view across nodes is separate
  later work.
- **Limits** such as per-IP circuit caps stay per node. A client retrying an
  offline host now makes one attempt per node, which stays inside each node's
  existing per-username limit.

### What a node can observe

Nothing new about content. Every node now sees the presence and compatibility
metadata of every fleet-aware server, where one node saw it before, and the
authority sees which usernames are active on which node. All nodes belong to
the operator the user already trusts with that metadata. Remote Access remains
content-private from the relay operator and not metadata-private.

## Compatibility

The change is additive. No existing route, message or field changes meaning.

| Client | YA server | Relay | Behavior |
| --- | --- | --- | --- |
| Fleet-aware | Fleet-aware | Fleet | Nearest node; survives a node loss |
| Fleet-aware | Older | Fleet | Nearest node reports offline, client falls back to the entry node; same path as today plus one extra attempt |
| Older | Fleet-aware | Fleet | Entry node, as today |
| Older | Older | Fleet | Entry node, as today |
| Any | Any | No fleet | Unchanged; no manifest request is made |

The entry URL must keep resolving to the authority for as long as older
servers and bundled clients are supported. Steering that name by geography
would send an older server and its client to different nodes.

## Alternatives

**Sticky home node with redirect (the March model).** Each server waits on one
node; clients are redirected to it; every node replicates the registry with
best-effort peer checks and first-timestamp-wins conflicts. It shards the idle
population, which waiting everywhere does not. It also needs a home-node
directory, a redirect or locate step in every client, a mux socket per node,
slow failover that moves servers and writes the registry, an eviction message
and screen for the losing side of a conflict, a rebalance command, and a
separate answer for older bundled clients. Prefer it only if idle connection
count, rather than latency or availability, turns out to be the constraint.

**Replicated registry without an authority.** Keeps first-time username claims
working while any single node is unreachable. The price is the conflict path
above: an installation can later be told its working username belongs to
someone else. Refusing a brand-new claim for the length of an outage is the
smaller harm.

**Nodes forward to each other.** Needs no client change and allows a
geographically steered entry name, but adds a node-to-node data plane, doubles
relayed bytes for cross-node pairs and gives every node a new trusted peer
role.

**A hosted platform object or tunnel.** Covered in the comparison above.

## Decisions needed

1. Wait on every node, as recommended, or keep the sticky home node from
   March.
2. A single authority, as recommended, or a replicated registry that accepts
   rare conflicts in exchange for claims during an outage.
3. Whether a YA server uses a discovered fleet by default or only after an
   opt-in during qualification. Recommended: opt-in first, then default for
   relays that advertise a fleet, with the node list always visible.
4. Battery-profile hosts. Recommended: keep today's single entry-node socket
   until the cost of extra sockets is measured on a phone.
5. Order of client work. Recommended: the web client first, then the shared
   mobile core, since the bundled clients keep working through the entry node
   in the meantime.
6. The form of the fleet secret. Recommended: one shared bearer secret over
   TLS; move to per-node credentials only if the fleet grows.
7. Which node is the authority and what hosting the nodes use. This is
   deployment configuration and belongs in the operator's private runbooks.

## Suggested order of work

1. **Fleet manifest and capability on the relay.** Configuration, `fleet-v1`,
   the manifest route, node id and region on `/health`. No behavior changes.
2. **Authority-backed registration on other nodes.** The cache, the validation
   call, authority-only reclaim, and behavior with the authority unreachable.
3. **YA server waits on every node**, behind its setting, with reconnect
   jitter and per-node status in Remote Access settings.
4. **Web client node choice**, sticky selection, per-host fallback, and mux
   connecting to the chosen node.
5. **Shared mobile core parity** for Android and iOS.
6. **Draining and a combined operator view.**
7. **Default-on decision** after measured latency and failover results.

Steps 1 and 2 are relay-only and can be exercised by tests that start two
relay processes. The acceptance evidence should include: an existing username
refused on every node for a different installation; a server reachable through
a second node while the first is stopped, with its session resumed; first-time
claims refused and known servers accepted while the authority is stopped; the
compatibility table above with a pre-fleet server and client; one mux socket
for several hosts on one fleet; and measured round-trip time before and after
for a same-region pair. Client node failover exercises the reconnect paths in
the open [background reconnect](../gaps/background-relay-reconnect-blank-page.md)
and [raw socket error](../gaps/browser-reconnect-shows-raw-websocket-error.md)
gaps, so check those first.

## Non-goals

- Federation between relays run by different operators.
- Accounts, host lists or any application data on a relay.
- Changing SRP, NaCl, the mux wire format or the `/ws` pairing contract.
- Removing or re-pointing the entry URL.
- Automatic rebalancing of servers or clients.
- Choosing a node for the user's custom relay; a relay that advertises no
  fleet is used exactly as configured.
