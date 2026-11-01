/** Saved creation control state; native transcripts remain authoritative history. */
export const SESSION_CREATIONS_SCHEMA = `
CREATE TABLE session_creation_capacity (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  operations INTEGER NOT NULL DEFAULT 0 CHECK (operations BETWEEN 0 AND 10000),
  payload_bytes INTEGER NOT NULL DEFAULT 0 CHECK (payload_bytes BETWEEN 0 AND 536870912),
  attempt_bytes INTEGER NOT NULL DEFAULT 0 CHECK (attempt_bytes BETWEEN 0 AND 67108864)
);
INSERT INTO session_creation_capacity (id) VALUES (1);
CREATE TABLE session_creations (
  id TEXT PRIMARY KEY NOT NULL,
  owner_key TEXT NOT NULL,
  request_key TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  session_id TEXT NOT NULL UNIQUE REFERENCES session_identities(session_id),
  payload_json TEXT,
  payload_bytes INTEGER NOT NULL,
  context_json TEXT NOT NULL,
  current_attempt TEXT NOT NULL,
  attempt_count INTEGER NOT NULL CHECK (attempt_count BETWEEN 1 AND 64),
  deleted INTEGER NOT NULL DEFAULT 0 CHECK (deleted IN (0, 1)),
  created_at TEXT NOT NULL,
  UNIQUE (owner_key, request_key)
);
CREATE TABLE session_creation_attempts (
  id TEXT PRIMARY KEY NOT NULL,
  creation_id TEXT NOT NULL REFERENCES session_creations(id),
  generation INTEGER NOT NULL DEFAULT 0,
  state TEXT NOT NULL CHECK (state IN ('saved', 'queued', 'dispatching', 'bound', 'failed', 'uncertain', 'deleted')),
  delivery TEXT NOT NULL CHECK (delivery IN ('not-admitted', 'uncertain', 'consumed')),
  detail_json TEXT NOT NULL,
  detail_bytes INTEGER NOT NULL CHECK (detail_bytes BETWEEN 0 AND 8192),
  updated_at TEXT NOT NULL
);
CREATE INDEX session_creation_attempt_operation ON session_creation_attempts (creation_id);
CREATE TABLE session_creation_retries (
  creation_id TEXT NOT NULL REFERENCES session_creations(id),
  retry_key TEXT NOT NULL,
  failed_attempt TEXT NOT NULL,
  result_attempt TEXT NOT NULL REFERENCES session_creation_attempts(id),
  PRIMARY KEY (creation_id, retry_key)
) WITHOUT ROWID;
`;
