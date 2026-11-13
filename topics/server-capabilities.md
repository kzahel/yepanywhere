# Client and server capabilities

> The capability registry names server features, documents what clients do
> without them, and lets code recognize support from a version or explicit bit.

Topic: server-capabilities

## What this solves

A hosted client can update before an installed server. A cached browser bundle
can also lag behind a newly restarted server. Capability checks let each side
use the features the other actually supports. They remain useful even when
every release participates in capability negotiation.

The registry is searchable, browsable documentation alongside executable
definitions: what a capability means, when support began, how to detect it,
and what the client does without it. Most new fixed features are
**version-implied**: the server version establishes support, while the caller
still uses a named capability constant. This avoids scattered version checks
without sending a bit for every feature in every released server.

`capabilities:audit` checks some mistakes in those definitions and their use.
It also enforces a 90-day lifetime for fixed-version client gates and alternate
compatibility code. These are separate jobs: the consistency checks remain
useful indefinitely, while compatibility code has a fixed retirement deadline.
Neither job primarily repairs servers from before capabilities existed.

## Source of truth

| File or symbol | Purpose |
| --- | --- |
| `packages/shared/src/server-capabilities.ts` → `SERVER_CAPABILITIES` | Composes the registry and owns `serverHasCapability`, the encoders and the exported name constants |
| `packages/shared/src/server-capabilities-<area>.ts` | The entries themselves, one module per `area` value: named definitions, support rules, descriptions and client fallbacks |
| `packages/shared/src/server-capability-definition.ts` → `ServerCapabilityDefinition` | Entry shape, including the allowed `area` values |
| `packages/shared/src/server-capability-optional-bits.ts` | Optional-bit aliases of ledger IDs |
| `packages/shared/src/capability-ids.ts` → `CAPABILITY_ID_ALLOCATIONS` | Permanent numeric ID ledger; also owns sparse-bit encoding |
| `serverHasCapability` | Shared interpretation of server version, positive/negative bits and legacy representations |
| `packages/server/src/routes/version.ts` | Chooses supported features and encodes `/api/version` for the client |
| `scripts/audit-server-capabilities.ts` | Static consistency checks and enforced retirement deadlines |
| `scripts/compatibility-sunsets.json` | Dated, source-linked inventory of alternate compatibility code, including protocol paths without a capability |
| `scripts/capability-releases.json` | Stable release dates and unreleased source introductions used to age every registry entry |
| `scripts/capability-inventory.ts` | Complete registry inventory and syntax-based client-reference discovery |

Each registry entry records:

- `name`, `id`, `introducedIn`: stable identity and introduction version.
- `advertisement`: whether version, an explicit bit, or a particular response
  establishes support.
- `description` and `serverContract`: the behavior, routes, fields and events
  covered by that name.
- `clientFallback`: what the client does when support is absent.
- `kind` and `lifecycle`: whether the check is permanent or has a specific
  compatibility cleanup worth revisiting.
- `retired`: a historical reservation whose live client consumers are gone.

These are data about capabilities; “registry metadata” does not name another
layer. Support checks use the identity and advertisement fields. Descriptions,
fallbacks and route lists document the contract; the audit checks selected
parts of that documentation. It does not execute a fallback described in prose.

For example, callers can use:

```ts
serverHasCapability(version, SERVER_CAPABILITIES.sessionContentSearch)
```

The entry documents the search endpoint and the title-only fallback. Its
version-implied rule is interpreted centrally. Exported named string constants
and domain helpers are also supported; do not substitute literal feature names
or ad-hoc version comparisons in callers.

Add a new entry to the area module matching its `area`. Do not duplicate the
registry as a hand-maintained ID table here. Allocate the next unused ID from
the ledger, never from a number copied into prose. IDs are
shared across directions and never reused or renumbered. Retired allocated
server capabilities keep their ledger and registry entries.

## How support is recognized

| `advertisement.kind` | Use when | What establishes support |
| --- | --- | --- |
| `version-implied` | Every official release from `introducedIn` onward provides the contract | Server version, or an explicit positive ID from a source build implementing it early |
| `optional-bit` | Support can vary with build, host, configuration or deliberate removal | Explicit positive bit on this server |
| `scoped` | Support belongs to one object or representation rather than the whole server | A capability in that object's response, such as public-share metadata |

Default fixed new features to `version-implied`. They still have a named entry
and, for global capabilities introduced from 0.7.1 onward, a permanent ID.
An untagged build or a source build whose reported version precedes the feature
must explicitly advertise implemented support rather than relying on semver.
Expected variability belongs in `optional-bit` from the outset.

### Exceptional negative overrides

`deniedCapabilityBits` can withdraw a version-implied contract that the reported
version would otherwise promise. A known denied ID wins over the version,
positive bits and legacy names. Unknown IDs and IDs for optional/scoped
capabilities have no effect. The server encoder accepts only registered
version-implied denials and emits them only when its version would imply support.
Legacy name-list responses omit a denied capability's name and also carry
negative override bits when the reported version would imply it. This lets
modern readers use the same withdrawal rule even without encoding negotiation.

This is for an unforeseen withdrawal. Planned experimental or configurable
support uses an optional bit. A possible future compression of permanent
withdrawals remains in [the sketch](server-capabilities.sketches.md).

## What crosses the network

Modern `/api/version` responses carry `current`, `capabilityEncoding: 1`,
sparse `capabilityBits` and, when needed, `deniedCapabilityBits`. Sparse bits
are `[wordIndex, bits]` pairs with empty 32-bit words omitted. Released
version-implied support normally needs no positive bit. The server does not
send registry descriptions, fallback prose, route lists or review dates.

The first application WebSocket notification is `client_capabilities` (after
authentication on encrypted connections). Its version selects the newest
mutually supported encoding; same-origin HTTP supplies that version through
`X-Yep-Client-Version`, and tunneled requests inherit the connection's version.
The version-bearing handshake introduced encoding 1 in 0.7.1. A source build's
git-describe version can establish encoding-1 support even when its preceding
release tag is older. An unparseable server version selects the legacy encoding.

Missing/older client versions select the legacy name list. The intermediate
`compact-v1` encoding, encoder and readers were removed on 2026-10-28. Its
former query parameter is ignored, so an unidentified client receives the
ordinary name list; current client versions receive encoding 1. Transport
`formats` retain their separate namespace and meaning; see
[remote hosted compatibility](remote-hosted-compatibility.md).

## When to add one

Add a capability when a client-visible action requires server behavior that
supported servers may lack, or availability varies at runtime. The named
contract can cover a new route or a changed meaning of existing fields/events.
Never broaden a released capability to include behavior older servers with
that capability do not implement. A new route added to an old feature may need
a new capability even when its source file is already listed in the registry.

A safely optional response field can instead document absence as its fallback.
For example, an absent issue `trackerStatus` means no badge and adds no request.
An existing endpoint can negotiate an additive response format when reviewed
older implementations safely return the ordinary response. Neither pattern
permits an unsupported write or an optimistic new-route request.

Internal refactors need no capability. Required protocol changes belong in
their protocol version or a deliberate hosted compatibility-floor change;
feature checks do not substitute for those decisions.

## Minimum compatibility horizons

Before changing a client/server contract, inspect the applicable stable-server
corpus and read [remote hosted compatibility](remote-hosted-compatibility.md):

- Optional features: latest two stable releases plus every stable release
  from the preceding 14 days.
- Core functionality: latest two stable releases plus every stable release
  from the preceding 60 days.

Present the affected releases, new routes/fields/semantics, support check and
exact absent-support behavior, including why it sends no unsupported request.
Identify any change to an existing capability meaning or working fallback.
Obtain maintainer approval before changing that contract; an originating
instruction or applicable standing approval already covering the decision
satisfies this requirement. Do not ask for the same approval again.

These windows set the minimum review corpus, not an automatic connection
cutoff. The 90-day rule below is standing approval to retire expired
fixed-version gates and alternate implementations, including when an older
release remains among the latest two. Record the affected releases,
user-visible effect and update guidance when removing code; do not request
another approval for that retirement. Other compatibility changes still
require the review above. Security exceptions follow
[hard development rules](hard-development-rules.md).

## October 2026 compatibility retirement

The maintainer approved this cleanup on 2026-10-28. Current clients use
**v0.8.0 as their supported server baseline**, with the existing hosted update
notice recommending that baseline. Older installations should update or use
the client bundled with their server. Transport authentication and resume
protocols retain their separate grace and warning rules; this cleanup adds no
connection-protocol cutoff.

The core release corpus is v0.8.0, v0.8.1, v0.9.0, v0.9.1, v0.9.2,
v0.10.0, v0.10.1, v0.10.2 and v0.11.0. Every release supplies the retired
fixed contracts and aligned Codex transcript IDs. v0.11.0 and v0.10.2 are the
latest two; the optional 14-day corpus also includes v0.10.0 and v0.10.1.
No stable client negotiated the one-day, superseded `compact-v1` experiment.

Current clients no longer gate approval-log editing, additional Claude models,
host identity, host-awake controls, bang execution, Project Queue or its
new-session shortcut, enhanced Git status, remote checks, Pull, Push and
integration options on their old fixed capabilities. The redundant Project
Queue hosted-generation check is also removed. Persisted opt-ins, permissions,
platform availability, queue admission and Git operation serialization still
apply. Capability IDs, introduction versions and server advertisement remain
available for maintained older clients.

The separately approved Source Control follow-up removes the action-only
legacy shell and tracked-only Files loader/rendering. Both browse and
working-tree inventory contracts are present throughout the same core corpus.
That first pass retained an update-only missing-contract guard; the subsequent
Source Control slice below retires it. Optional live sections retain their
static working-tree alternative;
permanent IDs and server routes needed by older clients remain unchanged.

The 2026-10-29 settings/display slice retires thirteen more fixed-version
checks: Gateway configuration/autostart and agent/plan controls, Codex reasoning
summaries, idle harness lifetime, subagent depth, both cache-billing controls,
both Storage policies, glossary hints and project code names. These contracts
ship throughout the same v0.8.0+ corpus. Settings writes and Undo retain the
full supported payload; expected-expiry reads and events no longer wait for
version metadata. Defaults, opt-ins, provider status, permissions, shared-store
ownership and subscription cleanup remain authoritative. The later Gateway
services editor and newer provider settings retain their separate guards.

The subsequent Source Control slice retires ten fixed checks: browse/review,
working-tree inventory, both diff projection families, inclusive To HEAD, file
revision and dirty-file provenance, incoming commits, review submissions and
the live-monitoring setting. All ten ship throughout the same core corpus.
Current clients remove the update-only entry screen, projection upgrade
notices and support-prop plumbing. Valid project/source inputs can start reads
before version metadata arrives. Optional live sections/complete scans, server
settings, permissions, response-field absence and request cancellation remain
authoritative. Review visibility retains the server's fresh-install default and
stored values, with false as the missing-field fallback. The static inventory
alternative and historical server contracts for older clients remain.

Codex reconciliation always uses the aligned-ID contract, including while
version metadata is pending: equal content and timestamps cannot collapse
distinct provider IDs, and replay suppression uses persisted identity.
Codex OSS, Pi, OpenCode and Claude retain their independently required scoped
reconciliation. Neither provider formats nor durable user data are migrated.

## Capability lifecycle classes

Lifecycle is independent of version implication. A permanent capability can
be version-implied; a transitional capability can also be version-implied.
“Permanent” is not an exemption from fixed-version expiry. Named identities,
ID reservations and runtime-variable availability can outlive a client gate.

Choose the lifecycle at commit time:

- **Permanent:** a simple hide/disable check or runtime-variable availability.
  Document its fallback. All fixed-version checks still receive an automatic
  90-day deadline, including cheap hide-only checks. Truly optional runtime
  availability and scoped representation checks remain necessary.
- **Transitional:** keeping compatibility requires substantial alternate
  behavior that must be deleted within 90 days: an older parser,
  reconciliation algorithm, alternate data-loading path or emulation.
  Record the actual code and removal instructions in the sunset inventory.

### 90-day retirement rule

**Every fixed-version client gate and alternate compatibility path expires
90 calendar days after its replacement first ships in a stable release.
Remove it by default, without asking for maintainer approval again.** An
unreleased experiment starts its clock on the
date it is superseded. For new code whose replacement is not stable yet, use
the first source commit exposing that replacement; a later stable release
does not restart an existing clock. Use actual release or commit evidence,
not `introducedIn` alone: that field can name an unreleased version. The
deadline is UTC midnight on
`supportedSince + 90 days`, independent of release frequency.

The maintainer authorized this policy on 2026-10-27. `supportedSince` is a
historical fact, not a renewable lease. Do not advance it, add a grace period,
relabel code as permanent, or delete an inventory entry to silence expiry.
There is no per-entry lifetime override or routine extension. Earlier
retirement remains possible under the normal release-corpus review.

The audit enumerates **every** `SERVER_CAPABILITIES` definition; fixed features
are selected by `advertisement.kind === "version-implied"`, independently of
`kind` or fallback cost. It ages each from the first actual stable release at
or above `introducedIn` using `scripts/capability-releases.json`. Append real
release dates when publishing; dates are historical facts and cannot be moved
to renew a deadline. New unreleased fixed features require a source introduction
date in that file. An earlier source introduction continues to win when a
stable release is added, so publishing cannot reset an existing clock.

The complete text report lists age, first release, classification, deadline
and client-reference count. `pnpm --silent capabilities:audit --json` additionally
returns descriptions, lifecycle reasons, exact file/line references and
fallback prose for every entry, including optional bits, scoped features,
retired reservations and fixed entries with no remaining client consumers.
Optional/scoped entries show informational age without a blanket time cutoff.
`retired: true` preserves the historical definition and ID; any remaining
client reference to it is an error.

An expired fixed entry with remaining client references fails the audit; a
definition with no client references is reported as `NO-CLIENT-GATE`, rather
than treating its reserved ID as compatibility code to delete. The scan follows
exported constant imports and aliases, registry lookups, namespace imports and
domain-helper references. Comments, unused imports, type-only imports and
server advertisements do not count. This is syntax-based discovery, not a
proof of arbitrary computed lookups or full cross-module data flow; review
unusual indirection instead of using it to evade expiry.

Every transitional capability must also have an entry in
`scripts/compatibility-sunsets.json`. Register substantial alternate parsers,
reconciliation algorithms, loading paths, settings editors and protocol
encodings even when their current registry classification is permanent or
they have no capability. Each entry names the capability, first replacement
release/date evidence, exact file/marker locations and removal instructions.
Markers must identify the alternate path, not the permanent capability ID or
common code shared by current consumers. Add entries in the same change as
new compatibility code; renaming or moving a path must preserve its tracking.

`pnpm capabilities:audit` prints all deadlines, exits nonzero on or after
expiry while any recorded marker remains, and rejects missing transitional
entries, invalid dates, future anchors, unknown capabilities and stale
inventory. It checks tracked code regardless of its lifecycle label. CI
already runs this command. `pnpm capabilities:audit --as-of 2026-11-08`
previews a future run without changing the machine clock or source. The script
reports deletion work; it does not rewrite arbitrary runtime code itself.

At expiry, remove the fixed-version gate or alternate implementation and its
exclusive tests and plumbing. Unsupported peers get update guidance before
unsupported requests; document the resulting supported baseline in the owning
topic. Keep negative overrides, runtime-variable availability, permanent ID
reservations and server
advertisement still needed by maintained clients. Remove the inventory entry
once all alternate paths are gone. Relabelling a remaining fixed-version
hide/disable gate as permanent does not stop the automatic audit.

Persisted-data imports, old share-link representations and provider formats
that current supported tools still produce are not time-limited wire
compatibility. Neither are runtime-dependent optional feature paths. Removing
an entire core connection protocol must still satisfy the grace/warning
contract in [hard development rules](hard-development-rules.md); a feature
fallback deadline is not a silent whole-server cutoff.

## What the audit checks

`pnpm capabilities:audit` (also `verify --only capabilities:audit`) reads source
and registry data. It checks:

- Permanent ID validity, uniqueness, ledger continuity and server-entry
  agreement, including introduction versions and optional-bit aliases.
- Required global IDs for capabilities introduced from 0.7.1 onward.
- Certain raw name-based checks in runtime source, encouraging named constants
  and the shared helper.
- Agreement between `serverContract.routes` and declarations in explicitly
  listed `serverContract.routeModules`.
- 90-day compatibility deadlines, with expiry reported as an error.
- Every fixed-version client gate, including permanent hide-only checks, with
  exact client references and release-based age; optional/scoped/retired
  entries remain visible in the complete inventory.

For a route file wholly covered by one capability, list it in `routeModules`.
The audit scans literal `routes.get/post/put/patch/delete` declarations and
compares method plus path suffix against `serverContract.routes`. An added or
removed declaration then prompts an update to the documented route contract.
This works equally for version-implied and optional capabilities. It changes
nothing sent to the client.

This is a limited static check: unlisted files and other declaration forms are
not comprehensively discovered. It does not prove that a route is mounted,
authorized correctly, implemented in the claimed release, or guarded at every
client call site. Nor does it validate the prose describing fallbacks or detect
every possible ad-hoc version comparison. It cannot infer alternate behavior
from arbitrary source, so inventory coverage still requires review. Use
behavior tests for those claims.

In particular, adding a route to an old entry can satisfy the audit while still
breaking old-server compatibility. Review the introduction boundary before
deciding whether the new route belongs in that entry or needs a separate one.

## Client Use

Use `serverHasCapability` with a named registry entry, exported constant or
domain helper. Gate a visible action before mounting consumers that would send
unsupported requests. A defensive request-error handler remains useful but
does not replace that check. Missing support follows the documented fallback.

The client shares one `/api/version` snapshot per connected source. Mounting
another component does not trigger another version request; reconnect or
explicit refresh can revalidate it. One source-level owner handles a pending
readiness follow-up. Fixtures for modern global capabilities should use server
versions or allocated bits; tests of legacy encodings can use their old forms.

## Server Use

The version route assembles the implemented set using registry constants and
runtime availability, then chooses the appropriate encoder for the client.
Ordinary reads use retained state: process/build facts are cached per server
generation, and dynamic services own bounded snapshots and in-flight work.
`fresh=1` explicitly bypasses applicable caches. Do not launch Git, package
manager, provider, bridge or sandbox probes for every consumer's normal read.

When acquisition is needed, build metadata, device-bridge status and sandbox
preflight begin concurrently; update lookup begins once the version is known.
Wait for required results before advertising support. Concurrent discovery must
not turn unfinished preflight into an affirmative capability.

`sourceRevision` reports the startup commit/date and changes under `packages/`
for About's display; it does not establish feature support. Likewise optional
`sqlite.state` is a diagnostic, not proof that a discovery endpoint exists.
See [required SQLite](required-sqlite.md) for storage readiness.

## Feature-specific contracts

The registry documents individual capabilities. Keep detailed behavior and
release-review evidence in the owning feature topic rather than growing another
registry in this guide. The previous topic's dated reviews are preserved in
[the trims record](server-capabilities.trims.md); they are not today's support
corpus. The following exceptions remain useful entry points.

### Most remaining router policy

`agent-auth-router-most-remaining` covers AAR's reported policy IDs/labels,
per-session policy overrides and admission-refresh evidence. Its unreleased
meaning was broadened on 2026-10-11 without changing a released contract.
See [router policy](agent-auth-router.md#most-remaining-and-admission-refresh).

### New Session bundle negotiation

An existing settings GET negotiates `bootstrap=new-session-v1` with
`Accept: text/event-stream`. Only an event-stream response selects that
protocol; ordinary JSON selects existing-route fallbacks. An interrupted or
invalid stream fails missing parts rather than replaying the bundle as legacy
requests. See [session catalog observation](session-catalog-observation.md#retained-project-discovery-owner).

### Collection reads

`progressive-session-catalog` owns conditional `knownGeneration` reads, not
retained-mode acquisition. Send a generation only for identical query parameters
and when retained rows cover the requested window; cursor pages cannot use it.
Explicit refresh asks for rows. Without support, keep complete enumeration.

`retained-session-collections` separately covers retained sessions/Inbox.
`retained-projects` and `retained-recents` cover their respective collections.
For the latter two existing GET endpoints only, an unknown server version may
receive `summaryMode=retained` as a read preference: reviewed old handlers ignore
it, and absent `catalog` selects the complete-response interpretation. Once the
version is known, absent/denied support omits the parameter. This does not
authorize writes or relax the sessions/Inbox gate. See
[session catalog observation](session-catalog-observation.md).

### Other contract owners

- [YA-owned session identity](session-identity.md#compatibility-research--2026-11-01)
  and [creation/navigation](session-creation.sketches.md): selected pre-launch
  session ownership, the dated legacy-route/refresh audit, and a proposed exact
  gate for durable web acceptance/recovery. Internal id translation alone is
  not a capability; new writes/status semantics are. Implementation is pending.
- [Public shares](public-share-persistence.md): representation capabilities belong
  to the selected share/revision; global server support cannot prove one
  stored object has chunk integrity data. Live and frozen chunk support are
  distinct. Unsupported clients retain the bounded ordinary response path.
- [Session sandboxing](session-sandboxing.md): a status API, host availability
  and network-firewall support are separate facts. Launch still rechecks.
- [Project directory storage](project-directory-storage.md) and
  [storage settings](storage-settings.md): advertise complete writer/timing
  semantics, not merely the presence of settings fields.
- [Issues & PRs](issue-session-associations.md): discovery requires ready SQLite;
  GitHub status controls have their own optional capability. Additive content,
  cache-policy and status response fields document their absence behavior there.
- [Computer Control](optional-computer-control.md): retired IDs 70/71 stay
  reserved; Installed Machine Control uses distinct ID 112, and its server
  default setting uses ID 160.
- [Hosted compatibility](remote-hosted-compatibility.md): broad protocol/floor
  decisions, transient client/server skew and separate transport formats.
