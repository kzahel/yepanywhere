export const PEER_OUTBOUND_SCHEMA = `
CREATE TABLE IF NOT EXISTS peer_api_outbound (
  id TEXT PRIMARY KEY,
  scope_key TEXT NOT NULL UNIQUE,
  payload_hash TEXT NOT NULL,
  source_session_id TEXT,
  record_json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS peer_api_outbound_source ON peer_api_outbound(source_session_id);
`;
