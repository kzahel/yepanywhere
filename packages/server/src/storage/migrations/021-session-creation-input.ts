/** Stable logical first input survives startup retries and lost responses. */
export const SESSION_CREATION_INPUT_SCHEMA = `
ALTER TABLE session_creations ADD COLUMN initial_input_id TEXT;
CREATE UNIQUE INDEX session_creation_input_identity ON session_creations (initial_input_id)
  WHERE initial_input_id IS NOT NULL;
`;
