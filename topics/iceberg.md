# Iceberg adoption decision

> Apache Iceberg is a snapshot-based table format rejected for YA's current local app-data workloads, with reconsideration tied to a concrete shared analytical dataset.

Topic: iceberg

## Decision

Reject adoption for current workloads (2026-09-26); no implementation gap is
warranted. Iceberg manages table metadata, snapshots, and atomic publication
over data files, supporting concurrent writers and consistent readers. It is
not restricted to frozen datasets, but neither does it automatically maintain
derived tables from externally appended provider JSONL.
See [Iceberg's reliability model](https://iceberg.apache.org/docs/latest/reliability/).

YA already has narrower mechanisms: `SessionCatalogService` publishes catalog
generations through a manifest and pins generations for readers;
[cache publication](server-cache-publication.md) serializes mutable writes;
[SQLite](required-sqlite.md) serves local relational state. Iceberg has no
demonstrated advantage here sufficient to justify another storage layer.
The [DuckDB file-query sketch](../gaps/sketches/duckdb-transcript-queries.md)
does not depend on Iceberg.

## DuckLake distinction

[DuckLake](https://ducklake.select/manifesto/) puts table metadata in a SQL
database instead of Iceberg's JSON metadata and Avro manifest files, while
keeping bulk data in Parquet. Compatible data and positional-delete files
permit metadata-only migration without rewriting the bulk data: the cheap
part is reusing Parquet, not moving its contents into the database. This is
an alternative table format, not merely a different Iceberg catalog backend.
Its simpler metadata design is relevant to any future review, but does not
establish a current YA need for a lakehouse format.

## Conditions for review

Revisit for an actual analytical archive where one or more of these matter:

- Independent engines or writers must share a large file-backed table.
- Object-store storage needs atomic table publication and consistent snapshots.
- Historical snapshots or schema/partition evolution become concrete requirements.

A review should identify the workload and show why local SQLite or simple
file/manifest publication is insufficient, including ingestion, compaction,
catalog, and operational costs. JSONL files or SQL queries alone are not a
reason to reopen the decision.
