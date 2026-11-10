# Canonical cold metadata and seen state in SQL

Plan: [190](../tactical/190-active-session-cost-at-scale.md), architectural
stage 2. This slice removes canonical metadata/seen corpus residency and the
whole notification JSON writer. It follows the retained query consumer in
`3c90fbb89`; [required SQLite](../../topics/required-sqlite.md) owns the durable
contract, and [collection queries](../../topics/session-collection-queries.md)
own the derived query boundary.

## Ownership and scope

Metadata's queried columns already existed. Ordinary startup now acquires only
import state and interrupted-display owners. Clean objects and absent lookups
share a 256-entry / 8 MiB estimated string-payload working set. Dirty updates
and deletion tombstones remain pinned through pressure and failed commits.
Cache accounting is a bound on retained clean payload and entry count, not an
exact V8 heap meter; dirty mutations and bounded request snapshots are separate.
Reference equality is useful while hot, never the persistence authority.
Goal observation retry compares values so eviction cannot strand its semantic
pending state.

Clearloop IDs, display/billing owners and recovery select scoped rows through
SQL partial indexes, omitting full prompt data from feature views. Explicit
complete exports remain available without becoming retained mirrors. Billing
still visits its matching feature owners before its existing result limit;
normalization into an event table remains independent work.

Metadata batch reads return at most 256 keys as a local snapshot independently
of clean-cache admission. The retained projection consumes it directly for
native and creation fields, recaps, attention and archive state. Adoption
batches legacy metadata only for identities that need adoption; already bound
identities acquire none for repeat identity projection. A profile-wide row
traversal costs more than the old RAM lookup; ordinary retained polls already
avoid that traversal through their shared SQL query owner.

Migration 32 adds canonical per-session seen JSON rows/import markers and
metadata feature indexes. Seen mutations compare/update one key atomically,
then publish events and keyed invalidations. Failed seen mutations leave the
previous committed value visible and publish no success. The former JSON save
loop and resident seen map are removed. One-time import preserves escaped
message IDs, rechecks its marker in the transaction, and refuses unreadable or
invalid input without replacing it. Marker/rows roll back together on failure.
A committed marker prevents cleared rows being resurrected by a leftover file.

Startup-only metadata import statements are finalized immediately, rather than
occupying profile query slots for its lifetime. The existing statement ceiling
64 and query LRU 8 remain unchanged. Two behavior-preserving legacy-import and
display-recovery extractions land before this change to retire the frozen
metadata file budget. A separate mechanical cleanup removes pre-existing
tracked import/const lint warnings; neither preparation changes behavior.

The native catalog still retains a full publication. The derived list-query
index is still TEMP and still constructs the population on first read. Saving
its current response JSON would also save volatile ownership/attention/unread
state: durable reuse needs transactional dirty/version tracking plus recovery.
This slice deliberately leaves that separate work open. No public protocol,
provider format, runtime adapter, client or real profile is changed here.

## Measurement protocol

`scripts/perf-repro/session-cold-state.mjs` creates an isolated profile with
50,000 metadata rows, half Claude/half Codex provider labels, unique ~1 KiB
prompts and 50,000 seen entries. A separate seed process performs the one-time
seen adoption; ordinary restart runs in a fresh process so the fixture/import
allocation high-water mark cannot contaminate its RSS. Seed/adoption time is
reported separately. Database opening/module loading are outside the timed
service initialization: these are service-only figures, never whole-server
readiness or plan 190 acceptance.

After initialization, the harness traverses every metadata/seen key and pressures
50,000 absent metadata keys, samples seven forced-GC process-memory readings per
stage, performs twelve monotonic mark-seen writes, clears one key and verifies
metadata/seen persistence through another service instance. No provider,
transcript, server, browser or network is needed. Temporary profiles are deleted.

Before is `3c90fbb89`. After is the reviewed implementation with source/compiled
fingerprints in the [raw evidence](190-cold-state-sql.evidence.json). The same
harness runs before/after/before/after on fresh profiles, Node 25.8.2, profiler
off. Capacity, start/end host observations and native Darwin CPU/swap samples
are recorded. Missing suite Darwin CPU/swap eligibility and visible contention
make these diagnostic observations, not ratchets. Pilot runs that seeded in the
same process were used for attribution only and are excluded from this table.

## Observations

| Fresh process | Metadata / seen restart ms | Seen-write median ms | Post-traversal heap MiB | Post-traversal RSS MiB | Full point traversal ms | One-time seen import ms |
|---|---:|---:|---:|---:|---:|---:|
| measured-before1 | 122.14 / 15.99 | 11.03 | 81.8 | 268.5 | 17 | 17 |
| measured-after1 | 0.46 / 0.06 | 0.25 | 14.1 | 202.6 | 538 | 76 |
| measured-before2 | 129.57 / 16.55 | 10.70 | 81.8 | 261.9 | 19 | 19 |
| measured-after2 | 0.44 / 0.06 | 0.24 | 14.1 | 203.6 | 542 | 76 |

The after processes retain ~68 MiB less heap after traversal. RSS also falls,
with visible arena variation; these component-only figures do not certify
whole-server memory. Service restart drops from 138–146 ms combined to ~0.5 ms.
Seen-write medians are ~11 ms before and ~0.25 ms after. The one-time seen-import
component costs ~76 ms after versus the old 17–19 ms file load; schema migration
and fixture creation are outside that component. The full point traversal is
deliberately slower (538–542 ms versus 17–19 ms), illustrating why whole-corpus
consumers had to move before lazy loading.

Final 50k-row retained-route smoke observes list median 1.1 ms and Inbox
2.6 ms, with zero cold metadata getter calls on warm polls. The first list
still constructs the population; its unpaired timing is recorded as functional
smoke under concurrent full tests, not a before/after latency qualification.
Pinned-Bun 1.3.14 also passes the 400-row cold-state and list/Inbox/archive
round-trip checks; no cross-runtime speed comparison is claimed.

Restart parsing falls from 50,001 JSON decodes to zero. At the end of the full
sweep/miss pressure, the clean metadata working set has 256 absent entries and
~135 KiB estimated payload, with no dirty pins. The seen service has zero
resident corpus entries. This does not bound native catalog or whole-process
memory and does not certify the full plan's memory target.

The initial seen import is a one-time cost; ordinary writes no longer scale
with the seen corpus. A deliberately forced full traversal is slower with SQL
point reads than RAM lookups. Bounded metadata snapshots serve initial/changed
list construction, while warmed retained list/Inbox queries remain SQL-selected.
The first derived projection still has population-sized work; cold list/detail
and full active-tab targets remain open.

## Checks and review

Three metadata working-set scenarios cover lazy initialization, entry/byte/miss
bounds, snapshot results larger than the clean cache, hot references, pinned
failed updates/deletions, retry, SQL feature views and interrupted recovery.
The lazy-start regression fails on the previous implementation's complete
`SessionMetadataRows.all` read. The snapshot regression fails on the first
candidate with 40 unexpected point reads, and passes after the review fix.
Tests run on isolated source copies, without stashing or swapping shared files.

Notification cases now exercise actual SQL adoption, corrupt-input repair,
rollback, concurrent connections, reopen, monotonic timestamps and failed-write
publication. They replace redundant predicate cases and the obsolete mocked
asynchronous JSON-save-loop test. Focused metadata/seen/creation/native-allocation
checks pass 148 cases in about 3.6 seconds; the baseline move-only extraction
passes 85 metadata cases in 1.3 seconds. Client tests pass 7,331 cases.

YA review session `2df6a241-bff9-477f-a339-e2b6d21fb696` used Codex
`gpt-6.1-sol`, high effort, bypass permissions, review-only. It found one
should-fix: constructing and consuming batch results via the LRU caused point
rereads when pinned or large objects displaced the batch. The bounded snapshot
fix and direct native/creation consumption resolve it. Follow-up reports no
remaining must-fix, should-fix or nit findings, including statement lifetime,
adoption batching and the move-only extraction seam.

The full suite exposed the pre-existing 64-statement ceiling in a native
allocation scenario after new reads were added. Startup import statements now
have their correct shorter lifetime; no ceiling was raised. Final full server rerun exits 1 with 7,256 passing, 94 skipped and only the
same 11 Claude native-version guards (fixture 2.1.322, installed 2.1.321).
Root lint, formatting, typecheck and source budgets pass; lint retains one
unrelated info-level client regex diagnostic. Node 25.8.2 and checksum-verified
repository-pinned Bun 1.3.14 pass the portable SQLite contract.

The passing client run retains the two known unowned jsdom navigation
errors documented in [the existing gap](../../gaps/client-unit-navigation-diagnostics.md).
No client behavior changed; changing global links or suppressing unattributed
navigation would be unsafe without tracing their owner. No user server was
stopped/restarted, no working-tree client was built, and no primary profile or
provider store was written directly.
