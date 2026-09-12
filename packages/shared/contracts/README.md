# Experimental simple-client contract spike

Status: TypeScript/Android decoding proof and offline server producer, 2026-09-12. This is a
reviewable candidate for [plan 130](../../../docs/tactical/130-simple-client-api-and-three-client-demo.md),
not an advertised capability, endpoint, transport adapter, or shipped client.
iOS is deferred; no Swift transport or decoding evidence is claimed.

## Source and generation decision

[`simple-client.schema.json`](simple-client.schema.json) is the source. A small,
closed-subset emitter generates TypeScript types/Zod decoders and Kotlin
models/`org.json` decoders. Both runtimes already exist in their packages; the
spike adds no dependency. Neither renderer nor provider interpretation is
shared through this generator.

This selects JSON Schema for the experiment, not an obligation to maintain a
general-purpose schema compiler. Unsupported vocabulary fails generation,
including ignored `$ref` siblings, optional fields, unbounded collections, and
inline enums. Recursive definitions and records belonging to multiple unions
are also outside this emitter. Keep additions within the tested subset or
explicitly extend the emitter and both conformance tests first.

The open tagged unions are standard JSON Schema `oneOf`: known records plus an
object whose `kind` excludes every known discriminator. This makes the branches
mutually exclusive, as required by [JSON Schema's combining rules](https://json-schema.org/understanding-json-schema/reference/combining).
The `x-open-kind` annotation tells the emitter to generate an opaque fallback.
All known properties are explicitly required, while additive properties are
permitted, following [JSON Schema's object rules](https://json-schema.org/understanding-json-schema/reference/object).

Run from the repository root:

```sh
pnpm simple-client:generate
pnpm simple-client:check
pnpm --filter shared test simple-client-contract.test.ts
pnpm --filter server test simple-client-examples.test.ts simple-client-projection.test.ts
```

The normal `pnpm lint` path checks schema validation tests and generated-file
drift. Android's existing shared test-resource directory supplies the identical
JSON files to its JVM tests. From `packages/android`, with the normal JDK/SDK
configured:

```sh
./gradlew :app:testHostedLatestDebugUnitTest --tests 'com.yepanywhere.mobile.experimental.*'
```

Generated files are checked in. They are not exported from the shared package's
public barrel. The internal server producer imports the experimental subpath;
no route or client screen consumes it yet. Use the generated
`decodeSnapshot` entry point for the encoded-byte check as well as structure
validation; individual type decoders only validate their structure.

## Payload corpus and evidence limits

The [shared corpus](../test/fixtures/simple-client/examples.json) identifies
provenance and client-owned source keys separately from each server payload.

| Payload | What it demonstrates |
| --- | --- |
| `claude-conversation.json`, `codex-conversation.json` | Locked outputs of the server producer over the real captures in tactical 127: two user inputs, agent prose, four tools then one tool, and the intentional failure |
| `claude-tail.json` | Actual anchored-window selector output for the two-message Claude tail |
| `overview-disabled.json` | Synthetic overview metadata using the real session IDs; honest disabled issue discovery |
| `overview-peer.json` | Synthetic second source with colliding project/session/display names, partial overview/issue coverage, and equal short issue keys on different tracker sites |
| `waiting-history.json` | Synthetic growing/truncated reply, two-compaction coverage, unavailable media, known read-only question and unknown content/pending request |
| `unknown-view.json` | Synthetic future top-level view preserved opaquely |
| `invalid-snapshots.json` | Shared rejection cases for missing/null fields, wrong revision, malformed known content, invalid counts, and forbidden action enablement |

The Conversation fixtures are actual outputs of
[`prepareConversation` and `selectConversation`](../../server/src/experimental/conversation-projection.ts).
The provenance tests replay native recordings through production normalization,
augmentation and the shared compiler, then compare the complete producer output
to these locked snapshots. Adapter replay also checks grouped IDs, prose, tool
counts and failures using explicitly supplied recorded user inputs. The provider
logs do not record YA's input queue, so this does not establish live queue
reconciliation or cold-reader identity continuity.

The same valid/invalid payload corpus is decoded in TypeScript and Kotlin.
Additional tests cover additive fields, unknown raw-object preservation,
Unicode code-point limits, source collisions, and the UTF-8 byte ceiling.
Decoders enforce structural rules; the producer and its tests enforce counts,
unique IDs, failure ordering, honest truncation, and fixed-anchor selection.
Synthetic producer tests cover compaction scope, bounded prefix identity,
interruptions, retries, missing results and oversized inputs. The real captures
contain no compaction or permission prompt. No live synchronization, subscriber
ownership, measured performance budget, or new UI is proved by this checkpoint.

## Initial schema-spike verification (2026-09-12)

- 27 TypeScript contract checks and 9 Android test methods pass over the shared
  corpus and limit/unknown-variant cases; 2 server replay provenance checks pass.
- 10 schema-emitter guard tests pass; generated-file drift check passes.
- Repository lint, formatting and typecheck pass. `pnpm test` passes 11,837
  tests, with 29 existing skips.
- All 75 hostedLatest Android JVM tests and `lintHostedLatestDebug` pass.
  No emulator or live client API was exercised by this spike.

## Server-producer checkpoint verification (2026-09-12)

- 25 focused producer tests and 4 capture/provenance tests pass, alongside the
  13 existing captured-provider tests.
- Repository lint has no errors or warnings; formatting and typecheck pass.
  The full workspace unit run passed 11,868 tests with 29 existing skips;
  the subsequent failure-truncation regression also passes in the focused run.
- Browser regression evidence: 220 passed and 8 skipped in the full run. Seven
  cases encountered the development reload banner during source edits; all
  nine tests in their three files pass when rerun with source held steady.
- All 75 hostedLatest Android JVM tests and Android lint pass with the actual
  producer payload corpus. No emulator or live experimental API was exercised.
- The client-only console scanner counts one fewer warning call because the
  compiler moved into shared; this records ownership, not lower runtime volume.

## Candidate data rules

- Known fields are required. Nullable values use explicit JSON `null`; absent
  fields reject. Known additive fields are ignored by these readers.
- Content, pending requests, and top-level views are open unions. A malformed
  **known** kind rejects; an **unknown** kind retains the full object and original
  discriminator. TypeScript exposes `{kind: "unknown", originalKind, raw}`;
  Kotlin exposes the union's `Unknown` subtype. Renderers must show an unsupported
  fallback, never execute or render raw payloads as HTML or actions. All known
  questions in this read-only revision have `canAnswer: false`.
- Other enums are closed; new enum values need a new experimental revision.
  `apiRevision` must equal `simple-client-spike-1`. Revision mismatch is a
  source-scoped preview mismatch, not permission to treat the envelope as an
  unknown view. Generated decoders reject it; connection-state mapping follows
  with the first binding.
- IDs are opaque, source-local strings. A client's entity key is the tuple of
  saved-source key and server entity ID. Server payloads do not echo or invent a
  client profile identity. Issue IDs come from the existing association service;
  display keys do not determine identity.
- Timestamps are nullable UTC strings with millisecond precision. Generated
  decoders check the lexical shape, not calendar validity. Producers must emit
  actual instants; do not fabricate timestamps when the source has none.
- A message is one user submission or the agent response associated with it.
  Consecutive agent prose and tool activity before the next user submission
  belong to that agent message. Tool calls/chunks consume no message slots.
  Compact consecutive routine activity in place and keep failures visible.
  Pending requests/current activity remain outside the historical window.
- The producer uses the normalized user message ID for the user
  row and `agent:<user ID>` for its agent response. Growing content keeps that
  ID, with a deterministic hash for a derived ID beyond the schema limit.
  Orphan responses are explicitly incomplete; bounded readers may supply the
  preceding user identity as a prefix fact. Tests cover interruption and retry.
  Live queue and cold-reader identity remain integration obligations. Clients
  never derive these IDs or use array positions as fallback identities.

## History decision

Apply the existing two-compaction session-detail scope first, then group logical
messages, then select at most `maxMessages` from within that scope. This does
not authorize reading older history or changing the current web API. A group
cut by the scope boundary is incomplete and must be marked `truncated`.

The screen-facing default is 20 messages; requests carry an explicit integer
from 1 through 100. `anchorMessageId: null` means follow the latest tail. A
non-null anchor is the fixed newest message, inclusive, in the requested window.
Increasing the count reveals earlier messages within the same scope. New
messages do not slide an anchored window forward. If an anchor is no longer
available, return `anchorUnavailable`; never silently jump to the tail. The
client can deliberately resume following or reopen the full web client.

`coverage` keeps the units separate:

- `earlierInScope`: more logical messages exist before this window inside the
  scoped input.
- `earlierOutsideScope`: `yes`, `no`, or `unknown`; do not scan older history just
  to turn unknown into a boolean.
- `completeForRequest`: the selected view is represented without omitted or
  truncated content. A complete two-message tail can still have older history.
- `limitedBy`: `maxMessages`, `compactionScope`, `bytes`, and/or `unavailable`.
  The ordinary count/scope boundaries do not alone imply an incomplete view;
  missing content within a selected message does.
- `returnedMessages`, the count requested, the fixed two-compaction scope, and
  the anchor make the selection explicit without exposing provider offsets.

The waiting fixture is a synthetic combination of incomplete content and older
scoped/out-of-scope history. The Claude tail fixture is a complete request with
older messages in scope and is generated by the implemented selector. Bounded
history acquisition remains a service-layer task.

## Bounds and replacement-snapshot candidate

The schema caps overview collections at 200 sessions/100 projects, issue links
at 16 per session, a window at 100 messages, content at 64 items per message,
and pending requests at 16. Text content is at most 16,000 Unicode code points.
Encoded snapshots, including unknown variants, are at most 256 KiB in UTF-8.
Count bounds alone do not ensure that byte limit. The server must omit older
window rows and then bound individual content, mark truncated messages and
coverage honestly, and retain a safe visible indication of omitted failures.
An overview uses its own incomplete coverage when its row/byte cap is reached;
it cannot claim a complete attention census. Media is an authenticated reference,
not inline data. Details and deeper history can use the full-client handoff.

Every delivery is an authoritative replacement, including initial load and
recovery. The client binds a new `subscriptionId` for every query, reconnect,
or continuity reset. The server echoes it and starts `sequence` at zero, then
increments within that binding. Accept only the current binding and strictly
newer sequence numbers. Sequence gaps are safe for replacement snapshots; no
patch is missing. Rebind before Int32 exhaustion. Query binding, atomic
snapshot/live acquisition, cancellation, and stale completion suppression are
still implementation tasks. The envelope alone does not prove them.

Gate 2 must measure these **acceptance budgets**, not report them as achieved:

- Coalesce content changes at 200 ms, at most five replacement publications per
  second while changing; publish nothing for unchanged views. Deliver an observed
  terminal/waiting state within 250 ms on an uncongested local connection.
- For a recorded benchmark with 20 messages, 1 KiB prose per message and compact
  activity/failure rows: at most 32 KiB per encoded snapshot and 160 KiB/s at
  five publications/s. The independent hard maximum remains 256 KiB.
- With one versus ten subscribers, normalize/project the session once per
  source revision and share results. Different window requests may slice shared
  scoped results; they must not repeat provider reads or full-history work.
- Projection plus encoding p95 at most 20 ms on a documented test host for that
  workload; teardown the final subscriber's demand. Record counters, wire bytes,
  latency, and host details. No provider-token-triggered history reload.

If these bounds fail, change the cadence/representation or add bounded row
updates with snapshot recovery before increasing scope. Sparse network delivery
alone does not establish bounded server work.

## Next checkpoint

The [shared compiler core](../src/transcript/README.md) and condensed producer
are implemented. See the [owning checkpoint contract](../../../topics/simple-client-api.md#implemented-projection-checkpoint-2026-09-12)
for input budgets, failure/media handling, prefix facts and evidence limits.
Next, connect bounded normalized acquisition and one shared per-session owner;
the pure prepare/select split enables reuse but does not implement ownership.

Before implementing any `/api/experimental/` route or capability, finish plan
130's exact operation and release-compatibility review. Then connect a minimal
multi-source web consumer and the existing Android transport in the same small
slice. A Swift transport port and Swift emitter/conformance proof can be scoped
when iOS is scheduled; Android is the current native gate.
