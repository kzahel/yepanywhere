# All Sessions turn search still requires transcript sweeps

The initial All Sessions implementation pulls bounded native-record batches
from disk. It has no efficient disk-backed substring index for either explicit
selected sessions or the complete session catalog. Broader or unrelated needles
repeat acquisition. Appended characters refine retained whole text in uncapped
sessions; reaching 1024 matches or a text-byte cap stops that session and makes
the next needle rescan it. Batches rotate among eligible sessions; appends resume at
saved tails, and catalog changes no longer restart unchanged sessions.

The proposed [provider history architecture](../topics/provider-history-facts.md#consumers-own-their-projections)
treats this index as a separate downstream consumer. It may reuse source
identity, generations, locators and reset evidence; search owns its matching
and indexed-through progress. Source-position indexes do not close this gap,
and this gap does not block them.

Build the index behind the existing capability/coverage boundary in
[all-session content search](../topics/all-session-content-search.md). Evaluate
full substring candidates against token-begin-anchored search, including disk
amplification, short needles, Unicode boundaries, selected-session intersections,
append/rewrite invalidation and exact verification. A token-begin restriction
would be an explicit product contract, not a silent optimization. Worker or
off-node acquisition remains an option if measured disk/parse cost warrants it.

The first bounded native reader covers Claude and Codex families. Other
providers are marked title-only in the Providers menu and excluded from turn
acquisition; oversized/malformed records report partial coverage below results.
Extend their native bounded readers instead of falling back
to unbounded whole-session reads. Match ordinals currently count visible
records, not coalesced conversational turns; normalization parity across record
boundaries and Markdown display delimiters remains to be established.
Tail continuation detects inode replacement, truncation, layout changes and
saved-boundary changes. A rewrite of earlier bytes followed by growth that
preserves the saved boundary needs stronger native mutation evidence for exact
invalidation; the index must not treat boundary sampling as a full-prefix hash.

The index should return low-latency session-grouped matches with original
timestamps, stable IDs and on-demand context, while keeping coverage explicit.
Cap retained memory, share identical source-version work across clients, stop
unused work, and measure query/cancellation cost against the reference scan.
Diagnostic details need a separate retention/aggregation budget for heavily
corrupt transcripts; the current match and text-byte limits do not bound them.
Oversized native JSONL records are skipped before classification, so diagnostics
can incorrectly suggest lost searchable turn content for command-output records.
Bounded classification/extraction should distinguish these without unbounded
JSON parsing or silently hiding possible User/Ass. coverage loss.

The requested one-active-needle-per-viewer server guard is not implemented.
Current client generations share configurable slots (default four), and the
server separately caps batches; neither establishes viewer/revision ownership.
The canonical
[stopgap contract](../topics/all-session-content-search.md#server-needle-ownership-requested-stopgap-not-yet-enforced)
allows an initial global last-writer-wins guard, requires stale-owner teardown,
and preserves parallel session fan-out. Implement behind a reviewed compatible
protocol before claiming that invariant; client cancellation alone is insufficient.
The [index sketches](../topics/all-session-content-search.sketches.md) preserve
candidate structures and measurement gates.

## Optional backing storage for old turns

Evaluate a reasonable disk-backed store (DuckDB is a candidate) for searchable
historical turns on the server. Keep provider transcripts canonical, store
derived state only in YA app data, and cover append/rewrite invalidation,
stable turn IDs, exact substring verification and bounded on-demand context.
Ship it as a configurable, default-disabled feature until query latency,
ingest cost, memory and concurrent search behavior are measured against scans.
Later conditional default enablement may distinguish local app-data storage
from NFS; filesystem detection and crash/locking behavior must be established
before relying on that distinction. NFS must retain the explicit opt-in path.

Requested 2026-09-30 while improving all-session search.
Contributing-model: 6.1-Sol.

Found 2026-09-14 while implementing the approved All Sessions search design.
