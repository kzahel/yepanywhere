/** Durable seen state and feature-only metadata reads. Frozen migration SQL. */
export const SESSION_COLD_STATE_SCHEMA = `
CREATE TABLE session_last_seen (
 session_id TEXT PRIMARY KEY,
 entry_json TEXT NOT NULL CHECK(json_valid(entry_json))
);
CREATE TABLE session_last_seen_import (
 id INTEGER PRIMARY KEY CHECK(id = 1), source TEXT NOT NULL
);
CREATE INDEX session_metadata_clearloop_running ON session_metadata(session_id)
 WHERE CASE WHEN json_valid(extra) THEN json_extract(extra, '$.clearloop.state') END = 'running';
CREATE INDEX session_metadata_display_objects ON session_metadata(session_id)
 WHERE CASE WHEN json_valid(extra) THEN json_array_length(extra, '$.transcriptDisplayObjects') ELSE 0 END > 0;
CREATE INDEX session_metadata_billing_events ON session_metadata(session_id)
 WHERE CASE WHEN json_valid(extra) THEN json_array_length(extra, '$.cacheMissBillingEvents') ELSE 0 END > 0;
`;
