/** Unresolved native allocation is control state, never provider history. */
export const NATIVE_SESSION_ALLOCATIONS_SCHEMA = `
CREATE TABLE native_session_allocations (
  creation_id TEXT PRIMARY KEY NOT NULL REFERENCES session_creations(id),
  attempt_id TEXT NOT NULL REFERENCES session_creation_attempts(id),
  generation INTEGER NOT NULL,
  native_family TEXT NOT NULL CHECK (native_family IN ('claude', 'codex', 'gemini', 'opencode', 'pi', 'grok')),
  native_scope TEXT NOT NULL CHECK (length(native_scope) BETWEEN 1 AND 4096)
) WITHOUT ROWID;
CREATE INDEX native_session_allocation_scope ON native_session_allocations (native_family, native_scope);
`;
