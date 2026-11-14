# One conflicting session identity can fail an entire collection read

`projectCatalogIdentities` sends unmatched native rows through
`SessionIdentityStore.adoptDiscoveredBatch`. One genuine project/native binding
conflict throws and rolls back the publication, failing otherwise unrelated
Inbox, Projects, Sessions, Issues and v0 session reads rather than exposing the
valid portion with explicit uncertainty.

The November 14 macOS `/tmp` versus `/private/tmp` incident is repaired by
verifying physical path equivalence for already bound Claude rows. Different
physical directories, missing paths and different native scopes still refuse;
weakening those identity checks or silently omitting conflicted rows would hide
ambiguity and could make an incomplete catalogue look authoritative for access
or missing-session decisions.

Keep the narrow incident repair separate from collection error semantics. A
follow-up should isolate conflicted rows, retain bounded diagnostic evidence,
and propagate explicit incomplete/ambiguous results through list and direct
resolution consumers. Review supported client fallback and authorization
behavior before changing that contract. Preserve exact native scope/public
ownership and cover mixed valid/conflicted publications and later recovery.

Found 2026-11-14 while repairing a live Claude probe's project alias conflict on
the local development server.
