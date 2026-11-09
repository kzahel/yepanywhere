# Node 22 And Built-In SQLite Cutover

Status: Implemented and locally verified 2026-09-08; release publication and
Windows Desktop manual verification remain separate operations.

Topic: node-22-builtin-sqlite

## Outcome

Move the standalone Yep Anywhere server from its nominal Node 20.12 floor to
the same supported Node range as T3 Code:

```text
^22.16 || ^23.11 || >=24.10
```

Continue treating Bun as a real server runtime rather than a desktop-only
accident. The public CLI may run under a tested Bun release, and Desktop keeps
shipping its exact private Bun runtime. Node uses `node:sqlite`; Bun uses
`bun:sqlite`. The main server must not gain `better-sqlite3`, a native addon
installer, a compiler prerequisite, or a SQLite sidecar.

Raise the runtime floor now for new server releases. Deploy an advisory notice
in the hosted frontend while continuing to support existing older servers.
An operator updating from a terminal may receive the runtime preflight error;
preventing every incompatible update is not the goal. When the server can report
its runtime, the client gives exact Node/Bun guidance. When an older server
lacks runtime metadata, the client asks the operator to check the runtime
before updating and does not claim to know that it is obsolete.

This plan establishes the runtime, compatibility-notice, packaging, and
release contract needed for built-in SQLite. It does not migrate every existing
YA JSON store. Each durable store still needs an owning schema, migration,
rollback, and recovery contract before its data moves into
`{dataDir}/discovery.sqlite` or another explicitly owned database.

Related: [required SQLite](../../topics/required-sqlite.md),
[remote compatibility](../../topics/remote-hosted-compatibility.md),
[compatibility notices](006-remote-compatibility-notices.md),
[server capabilities](../../topics/server-capabilities.md),
[desktop runtime](../../topics/desktop-v0.md), and
[hard development rules](../../topics/hard-development-rules.md).

## Why Change The Floor

The declared `>=20.12` contract is already costly and partially inaccurate:

- [`gaps/npm-runtime-dependency-node20-floor.md`](../../gaps/npm-runtime-dependency-node20-floor.md)
  records that a fresh npm dependency resolution can select a sanitizer stack
  that requires Node 22.12 and fails on Node 20.
- [`gaps/node20-recursive-watch-deletion.md`](../../gaps/node20-recursive-watch-deletion.md)
  records a Node 20.12 recursive-watcher crash; browser E2E already uses a later
  Node 20 patch to avoid it.
- [`gaps/production-dependency-audit-advisories.md`](../../gaps/production-dependency-audit-advisories.md)
  records two sanitizer fixes blocked by the Node 20 contract.
- The OpenCode database reader and optional discovery store already use
  guarded built-in SQLite adapters, while Node 20 takes the unavailable
  fallback.

Node 22.16 supplies the built-in SQLite APIs used by a conventional generic
adapter, including `StatementSync.columns()`. YA's existing adapter does not
currently require column metadata, but matching T3 Code's floor avoids a
bespoke earlier subset and gives the project one externally legible runtime
baseline. The experimental SQLite warning emitted by supported Node 22
releases is accepted and must not be hidden by a broad warning-suppression
flag.

The bundled desktop is not a reason to retain Node 20. Its shell starts a
hash-pinned Bun runtime and updates the shell, runtime, server, and client as
one tested unit. The relevant compatibility population is npm/source server
operators and remote hosts.

## Runtime Contract

### Node

The npm package, root development package, production bundle manifest, CLI and direct-server
preflight, install documentation, and required CI agree on:

```text
^22.16 || ^23.11 || >=24.10
```

Use a real semver-range check. A major-only `>=22` test is insufficient because
it would accept Node 22.0, Node 23.0, and Node 24.0 even though the package
contract rejects them. An unsupported runtime exits before loading the app,
opening storage, starting provider processes, or binding a public listener.
The diagnostic prints the observed version, accepted range, and official Node
upgrade link.

### Bun

Bun is an alternate supported server runtime. The initial public floor is Bun
1.3.14, already pinned by Desktop and exercised by the optional SQLite
workflow. Before advertising `bunx --bun yepanywhere`, run the complete packaged
startup and representative server suite under that exact version on every
claimed platform. A platform-specific missing capability is detected and
documented; it is not converted into a blanket rejection of Bun on other
platforms.

When `process.versions.bun` is present, validate the Bun version and do not
apply Node's compatibility version to the Node range. Runtime-specific
services select Bun before Node-compatible builtins. The CLI help and install
docs may present both `npx yepanywhere` and `bunx --bun yepanywhere` only after the
artifact-level Bun gate passes.

Desktop continues to support only its pinned private Bun, regardless of a
broader standalone Bun range. A user-installed Bun is never substituted for
the private desktop runtime.

### Separate artifacts

Do not raise unrelated execution floors mechanically:

- The managed runner may retain Node 20.12 while it remains a separate,
  SQLite-free artifact with its own declared and tested range.
- Android build tooling changes only when its JavaScript tasks actually need
  the new runtime.
- Relay and push broker were separate `better-sqlite3` consumers when this plan
  was written. This plan removed native SQLite pressure from the main server
  only. The owning migration landed on 2026-09-10 and moved both onto the same
  built-in adapter, so the monorepo now ships no SQLite addon; see
  [required SQLite](../../topics/required-sqlite.md).

## Immediate Cutover And Remote Warning Contract

The Maintainer revised the rollout on 2026-09-08: raise the engine floor now.
Do not wait for a Node-20-compatible warning release or a 14-day npm delay.
The breathing room is for remote users to SSH to their server or ask an agent
to upgrade the runtime while their existing YA server remains usable.

No frontend minimum-server cutoff is introduced. Any future core cutoff needs
its own compatibility review, support-horizon assessment, explicit approval,
and advance notice of at least two weeks; elapsed time does not authorize it.
Internal SQLite cache changes can preserve existing APIs. New product features
use their exact capabilities when older servers lack their contracts.

Extend the authenticated, source-scoped `GET /api/version` response with
additive runtime metadata. Keep actual storage state and runtime eligibility
distinct:

```ts
interface ServerRuntimeInfo {
  kind: "node" | "bun" | "unknown";
  version: string | null;
}

interface VersionInfo {
  serverRuntime?: ServerRuntimeInfo;
  sqlite?: {
    state: "disabled" | "unsupported" | "ready" | "error";
  };
}
```

`serverRuntime` reports facts and does not load SQLite. It must not import a
SQLite module, create a database, or emit Node's experimental warning merely
because a client fetched version information. The client compares reported runtimes with this cutover's fixed supported
range. Unknown runtime metadata gets honest check-before-updating guidance.
There is no target-release requirements service or dynamic release table. This
avoids freezing a temporary future requirement into a long-lived server field
and avoids falsely calling Node 22.13's existing SQLite builtin unavailable
merely because the approved YA floor is Node 22.16. The existing
`sqlite.state` remains the authoritative result of configuration and actual
initialization; a compatible runtime does not promise that a future open or
migration cannot fail.

Do not allocate a generic SQLite capability. Runtime metadata is an additive
diagnostic used for advisory update guidance; it enables no route or feature.
Future SQLite-backed product routes still receive their own exact capability
and readiness gate as required by the optional SQLite contract.

## Hosted And Local Notice Behavior

Generalize the existing source-scoped compatibility-notice engine rather than
adding a standalone modal. Render the notice after a source is authenticated
and connected in localhost, direct remote, and relay-hosted clients. Also show
the current notice in Settings -> About. Do not cover login, reconnect, or
host-offline states, and do not stack it above a more severe security or
protocol notice.

This maintenance notice is deliberately default-visible. The Maintainer
approved that product decision on 2026-09-08 to give remote operators time to arrange a runtime upgrade. It remains
non-blocking and does not change provider behavior or submitted
text.

### Reported obsolete Node runtime

When an authenticated server reports Node outside the supported range,
show a high-priority, snoozable `recommended` notice:

> **Upgrade Node.js before the next YA update**
>
> This server still works. New Yep Anywhere server releases require
> Node.js 22.16 or a supported newer release for built-in SQLite. Upgrade the
> server runtime before updating YA.

Show the observed runtime version when available. Offer **Upgrade
instructions** and **Remind me later**. Do not run a runtime installer or
silently modify a version manager. Existing source/npm update actions remain available. This is advisory
maintenance guidance, not an update-action gate or runtime installer.

### Reported obsolete Bun runtime

Use Bun-specific copy and the tested Bun floor. Never tell a Bun process to
install Node merely because `process.versions.node` exposes a compatibility
version. A supported Bun server receives no Node notice.

### Older server without runtime metadata

An older server cannot prove which runtime launched it. The updated hosted
client shows advisory preflight copy even when update checking is offline:

> **Check Node.js before updating this server**
>
> This YA server predates runtime checks. Before updating, verify that its host
> has a supported runtime: Node.js 22.16 or a supported newer release, or a
> supported Bun release.

This notice must say **check**, not **upgrade**: the host may already run a
compatible Node or Bun. Its action opens instructions that begin with
`node --version` and `bun --version`. It makes no new request to the old server.

### Dismissal and escalation

Use the existing browser-local dismissal store, scoped by source installation,
notice id, reported runtime/version or `metadata-absent`, and requirement
epoch. Reuse the existing bounded snooze. A dismissal must not suppress a future
runtime-floor epoch. There is no post-cutover update-blocked state.

The cutover does not intentionally break an already connected old server.
Hosted clients continue to operate against supported older protocol contracts;
the notice gives operators time to prepare and imposes no remote connection
cutoff.

## Compatibility Decision

This is core compatibility work. The reviewed stable server corpus on
2026-09-08 is:

| Release | Date | Runtime metadata | Declared Node floor |
| --- | --- | --- | --- |
| `v0.8.1` | 2026-09-05 | absent | `>=20.12` |
| `v0.8.0` | 2026-08-31 | absent | `>=20.12` |
| `v0.7.0` | 2026-07-25 | absent | `>=20.12` |
| `v0.6.2` | 2026-07-11 | absent | `>=20.12` |
| `v0.6.1` | 2026-07-10 | absent | `>=20.12` |

These are the latest two stable releases and every stable release in the
preceding 60 days. They lack `serverRuntime` but already expose the existing
version route.

The approved compatibility behavior is:

- The cutover release adds `serverRuntime` to the existing response and changes
  no route, event, capability meaning, or protocol level.
- Older clients ignore the field.
- A new client treats an absent field as unknown, never as proof of an obsolete
  runtime, and makes no unsupported request.
- An absent or unknown field produces conservative check-before-updating
  guidance; it never proves that a runtime is obsolete.
- Notices do not block ordinary use or remove existing update commands.
- New server releases reject unsupported runtimes immediately, before app
  loading; old servers continue to work with the hosted frontend.
- Existing remote compatibility levels, capability meanings, relay protocol
  behavior, and older capable fallbacks remain unchanged.

This originating plan records the Maintainer's approval of the new metadata,
missing-field fallback, user-visible notices, Node range, Bun support, and
immediate server cutover with continued old-server frontend compatibility. Implementation does not require a second
compatibility-approval pause unless one of those decisions changes.

## Ordered Implementation

### 1 — raise the server runtime floor and report runtime identity

Update the root/server engine range, generated npm manifest, setup docs,
containers, required server CI and release validation together. Reject an
unsupported runtime through both CLI and direct index entry points before
loading application dependencies, opening storage or starting processes.
Keep the guard dependency-light and test actual subprocess rejection.

Add additive `serverRuntime` to the version response and source snapshots.
Use Bun identity before Node compatibility identity. Keep SQLite reporting
independent. Node's experimental SQLite warning remains visible and justified.
Do not change `YEP_SQLITE` defaults or migrate JSON stores in this cutover.

### 2 — show advisory runtime guidance in connected clients

Extend the existing pure notice engine with known-Node, known-Bun and unknown
runtime guidance. Reuse severity ordering and source-scoped dismissal state;
show it in connected shells and Settings -> About. Supported Bun gets no Node
warning. Login, reconnect and offline gates remain unchanged. A higher-priority
security/protocol notice wins. Existing update commands remain available.

Use English i18n keys and existing component-owned CSS. Verify source switching,
snooze, old responses without metadata, offline update checks, and ordinary
use against an older server contract. No generic SQLite capability or frontend
minimum-server requirement is added.

### 3 — verify packaged runtimes and document platform evidence

Exercise fresh npm installation and packaged startup at Node 22.16, 23.11 and
24.10, plus a maintained LTS. Verify the generated manifest and negative
startup immediately below each disjoint boundary. Check both CLI and direct
index entry points. Recommend a maintained Node LTS to operators.

Test Bun 1.3.14 with `bunx --bun`, including an absent or obsolete Node on PATH,
and assert reported Bun identity. Exercise the packaged HTTP/WebSocket server,
provider-owned child shell/CLI, shutdown and shared SQLite files. Keep
Desktop's exact bundled Bun unchanged. Public standalone platform claims must
match actual evidence, not merely SQLite module tests.

The isolated Windows npm-startup gap was resolved on 2026-09-10 with bounded
process-identity probes, asynchronous process-tree cleanup and full startup
coverage. The [restored matrix](https://github.com/kzahel/yepanywhere/actions/runs/34485119811)
passed without bypassing process identity or owner-only ACL checks. This is
packaged runtime evidence; Windows Desktop manual verification remains a
separate Maintainer follow-up.

### 4 — close the runtime and dependency debt

Fix the fresh npm peer/dependency contract and take sanitizer security updates.
Delete the npm runtime-floor and Node-20 recursive-watch gaps in the commits
that close them. Remove only resolved sanitizer audit exceptions; the remaining
production advisories stay open. The Rocky Linux relay/push-broker gap was
closed on 2026-09-10 by moving both onto the built-in adapter.

Update now-false runtime comments and active CI lanes. Preserve the separate
managed-runner Node 20 floor, unrelated artifact floors, and historical
performance evidence. Backend caches may migrate later under their owning
schema, rollback and recovery contracts without changing frontend APIs.

### 5 — hand off the immediate cutover for release

Record the new runtime requirement and continued older-server frontend support
in release notes. There is no required Node-20 warning release or delayed npm
promotion. Commit and push implementation; npm/site publication remains its own
release operation. Deploy the hosted advisory with the release so remote users
can arrange their runtime upgrade while continuing ordinary sessions.

Recovery guidance distinguishes runtime upgrade from YA upgrade, verifies the
runtime actually used by the service after restart, and preserves data/profile
and remote pairing. Do not describe an old npm artifact as guaranteed recovery
without testing its fresh dependency resolution. Future frontend cutoff work
requires a separate approved plan and advance notice.

## Verification And Acceptance

- Runtime metadata adds no SQLite load, storage write, route or capability.
- Runtime checks enforce the exact Node range and Bun floor before app loading,
  including direct server startup; generated engines agree with the guard.
- Older servers remain usable with advisory, source-scoped runtime guidance.
  Unknown metadata is never interpreted as proof of an obsolete runtime.
- Existing update actions, protocol levels and older capable fallbacks remain.
- Required CI exercises the Node boundaries and pinned Bun; platform exclusions
  and the separate Windows Desktop verification are explicit.
- Node and Bun open the same SQLite database without a new native dependency.
- No implicit SQLite enablement or JSON migration is introduced.
- UI captures are inspected at 1000x600 and 375x812 against a fresh server.
- Focused tests, lint, format, typecheck, relevant unit/E2E suites, CSS, i18n and
  console checks pass; accepted Node experimental warnings are documented.

## Explicitly Deferred

- Frontend minimum-server cutoff and removal of older capability fallbacks.
- Selecting or implementing individual JSON-to-SQLite migrations.
- Migrating relay or push broker away from `better-sqlite3` (deferred here;
  done separately on 2026-09-10).
- Suppressing SQLite warnings or automatically installing Node/Bun.
- Raising managed-runner or provider-host execution-target floors without a
  concrete dependency on the main server's runtime.
- Windows Desktop verification, owned by the Maintainer's separate session.

## Implementation evidence

Durable behavior and platform evidence live in
[server runtimes](../../topics/server-runtime.md). The immediate engine change,
CLI/direct bootstrap guard, additive metadata, advisory notices, packaging peer
fix, sanitizer update and CI boundary matrix are implemented. Local checks cover
Node 22.16.0, 23.11.0, 24.10.0 and 24.20.0, pinned Bun 1.3.14, fresh npm installs,
Node/Bun SQLite interoperability and freshly built macOS Desktop bootstrap/auth.
The old npm dependency and Node-20 watcher gaps are closed. The Windows startup
fixture gap and Bun Vitest loader limitation remain explicit; neither is masked
by a weaker production boundary. Hosted/npm release publication is not part of
the originating commit-and-push instruction.
