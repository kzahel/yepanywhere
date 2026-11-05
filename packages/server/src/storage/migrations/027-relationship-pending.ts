/** Restart reconciliation must not scan completed extraction checkpoints. */
export const RELATIONSHIP_PENDING_SCHEMA = `
CREATE INDEX session_relationship_pending
ON session_relationship_checkpoints(producer, source_key) WHERE state = 'partial';
`;
