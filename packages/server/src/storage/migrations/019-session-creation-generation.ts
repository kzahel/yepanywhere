/** Independent control-state changes participate in collection conditionals. */
export const SESSION_CREATION_GENERATION_SCHEMA = `
ALTER TABLE session_creation_capacity ADD COLUMN generation INTEGER NOT NULL DEFAULT 1
  CHECK (generation BETWEEN 1 AND 9007199254740991);
`;
