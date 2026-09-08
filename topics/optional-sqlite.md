# Optional discovery SQLite storage

> YA can initialize its own SQLite database for future session discovery without
> requiring a native package build or raising the Node runtime floor. Storage
> readiness does not advertise a search or indexing feature.

Topic: optional-sqlite

Verified: 2026-09-08

## Startup policy

`YEP_SQLITE` accepts `off` or `auto`. An unset value means `off`; invalid values
are configuration errors. Changes take effect after restarting the server.

- `off` does not load either SQLite builtin, create a connection, or create a
  discovery database.
- `auto` attempts initialization once per Hono generation. A missing builtin
  produces `unsupported`; an open, filesystem, lock, or migration failure
  produces `error`. Either state preserves ordinary server operation.
- The desktop launcher supplies `auto` when `YEP_SQLITE` is absent and preserves
  an explicit inherited value, including `off`. `YEP_DESKTOP` alone is not a
  storage override.

The service retains status; version requests do not probe storage or retry
initialization. Restarting after correcting an error performs another attempt.
Server logs retain initialization error details; wire status contains no paths
or raw exception messages.

Close failures are also logged and do not interrupt the remaining app teardown.
The service clears its connection and reports `error` after a failed close.

## Runtime adapters

The server selects `bun:sqlite` when running under Bun and otherwise attempts
`node:sqlite`. Loading is guarded and deferred until storage is enabled. No
SQLite package, native installer, sidecar, or compiler is added to the core
distribution. Desktop's pinned Bun is tested directly, independently of claims
about newer Bun versions' Node compatibility.

The adapter exposes synchronous prepared statements with positional parameters,
SQL execution, transactions, and idempotent close. Values are strings, null,
byte arrays, and numbers; integer inputs/results must fit JavaScript's safe
integer range. A missing single row is `undefined` on both runtimes. Transaction
callbacks must be synchronous; nested transactions and thenable results are
rejected. Callers must not begin/commit transactions manually within a callback.
Future indexing consumers must bound their synchronous work rather than place
large scans on request paths.

Callers finalize statements when finished. Finalization drops the statement on
Node and explicitly releases its native resources on Bun. Closing the adapter
also finalizes outstanding Bun statements before closing the database; Bun
1.3.14's default close otherwise leaves them and the Windows file handle alive.
Using a finalized statement or one belonging to a closed adapter throws.

Node versions without an accessible SQLite builtin still load the published
modules and report `unsupported` in auto mode. Node's experimental-module notice
on applicable versions is not suppressed by the service.

## Database ownership and migration

The database is `{dataDir}/discovery.sqlite`, using the existing profile and
`YEP_DATA_DIR` resolution. No project or Git-metadata writes are introduced.
One connection belongs to each Hono generation and closes during the existing
reload/shutdown disposal path. Separate profiles have separate databases.

The initial schema reserves a YA application identity (`0x59414449`, ASCII
`YADI`) and schema version 1; it creates no session, PR, or ticket tables.
Ordered migrations update SQLite's `user_version` in one immediate transaction.
Foreign keys are enabled and lock waits are bounded to 250 ms, including the
migration lock. The initial implementation uses SQLite's default rollback
journal; a future indexing workload may justify changing journal policy.

An existing foreign database, malformed database, or newer schema is refused.
YA does not reset or delete it. A failed migration rolls back its statements
and schema version. Initialization closes a partially opened connection before
retaining error status. The database is not declared disposable: future feature
contracts must distinguish reconstructable indexes from manual links and
historical evidence that cannot be reconstructed.

Existing JSON metadata/caches, OpenCode's independently owned database and
reader, and the relay/push-broker SQLite dependencies are unaffected.

## Availability and frontend compatibility

`GET /api/version` has an additive optional field:

```ts
sqlite?: { state: "disabled" | "unsupported" | "ready" | "error" };
```

An absent field means that source server does not report SQLite state. A
frontend must not infer readiness from its own runtime, desktop presence, or
server semver. The field passes through the existing source-scoped version
snapshot, including legacy and negotiated capability encodings.

No generic SQLite capability ID is allocated. Future session discovery routes
must receive their own exact optional capability, advertised only when their
implementation and required storage are available. Storage readiness alone
does not enable discovery UI. Old/disabled servers receive no new requests;
older clients can ignore the new field. Existing capability meanings, protocol
levels, and supported runtime floors are unchanged.

The approved optional-feature corpus is v0.8.0 (2026-08-31) and v0.8.1
(2026-09-05): the latest two stable server releases and all stable server
releases within the preceding 14 days on 2026-09-08. Both lack SQLite status.
This change adds no frontend consumer, endpoint, or unsupported fallback call.

## Verification

`scripts/test-discovery-sqlite.mjs` runs the same storage contract against built
modules on Node 24, desktop's pinned Bun, and the Node 20.12 engines floor.
It covers persistence, parameters, rollback, migration failure, newer/corrupt
files, lock contention, teardown, and unsupported/off behavior. Its optional
shared-file argument verifies Node/Bun file interoperability.

`scripts/test-sqlite-startup.mjs` starts the npm distribution in a disposable
home/data directory using a mock provider and blocked outbound fetch. It checks
actual `/api/version` state for disabled, enabled/unsupported, and failed-open
configurations. The Optional SQLite workflow runs the storage contract on
Linux, macOS, and Windows; full-server startup runs on Linux and macOS.
Windows full boot currently fails in existing provider coordination before
SQLite initialization, so that smoke is gated pending the
[Windows startup gap](../gaps/windows-packaged-startup-provider-identity.md).
Windows still checks the packaged modules, Node/Bun file interoperability,
and Node 20 fallback. The general server suite retains its existing Node floor.
Packaged-module tests attach the locked workspace runtime dependencies; they do
not validate fresh npm registry resolution. The separate
[npm runtime-floor gap](../gaps/npm-runtime-dependency-node20-floor.md) records
the install failures found when attempting fresh dependency resolution.

Related: [server capabilities](server-capabilities.md),
[YA environment variables](ya-env-vars.md),
[OpenCode storage](opencode-backend.md).
