/** Scoped structural facts; evidence and progress share the profile transaction. */
export const SESSION_RELATIONSHIPS_SCHEMA = `
CREATE TABLE session_relationship_edges (
  id TEXT PRIMARY KEY NOT NULL,
  type TEXT NOT NULL,
  source TEXT NOT NULL,
  target TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 0 CHECK(active IN (0, 1))
) WITHOUT ROWID;
CREATE INDEX session_relationship_outgoing ON session_relationship_edges(source, id) WHERE active = 1;
CREATE INDEX session_relationship_outgoing_type ON session_relationship_edges(source, type, id) WHERE active = 1;
CREATE INDEX session_relationship_incoming ON session_relationship_edges(target, id) WHERE active = 1;
CREATE INDEX session_relationship_incoming_type ON session_relationship_edges(target, type, id) WHERE active = 1;
CREATE TABLE session_relationship_evidence (
  producer TEXT NOT NULL,
  source_key TEXT NOT NULL,
  record_key TEXT NOT NULL,
  source_version TEXT NOT NULL,
  extractor_version INTEGER NOT NULL,
  edge_id TEXT NOT NULL REFERENCES session_relationship_edges(id),
  trust TEXT NOT NULL CHECK(trust IN ('local-authenticated', 'peer-attested', 'provider-observed', 'command-observed')),
  state TEXT NOT NULL CHECK(state IN ('active', 'superseded', 'retracted')),
  metadata TEXT NOT NULL,
  observed_at TEXT NOT NULL,
  PRIMARY KEY(producer, source_key, record_key, edge_id)
) WITHOUT ROWID;
CREATE INDEX session_relationship_support ON session_relationship_evidence(edge_id, state);
CREATE INDEX session_relationship_evidence_order ON session_relationship_evidence(edge_id, producer, source_key, record_key);
CREATE INDEX session_relationship_active_source ON session_relationship_evidence(producer, source_key) WHERE state = 'active';
CREATE TRIGGER session_relationship_evidence_insert AFTER INSERT ON session_relationship_evidence
BEGIN
  UPDATE session_relationship_edges SET active = 1 WHERE id = NEW.edge_id AND NEW.state = 'active';
END;
CREATE TRIGGER session_relationship_evidence_state AFTER UPDATE OF state ON session_relationship_evidence
WHEN OLD.state != NEW.state
BEGIN
  UPDATE session_relationship_edges SET active = EXISTS (
    SELECT 1 FROM session_relationship_evidence WHERE edge_id = NEW.edge_id AND state = 'active'
  ) WHERE id = NEW.edge_id;
END;
CREATE TABLE session_relationship_checkpoints (
  producer TEXT NOT NULL,
  source_key TEXT NOT NULL,
  revision INTEGER NOT NULL,
  source_version TEXT NOT NULL,
  extractor_version INTEGER NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('partial', 'complete')),
  cursor TEXT NOT NULL,
  PRIMARY KEY(producer, source_key)
) WITHOUT ROWID;
`;
