/** Compact collection projection must not parse saved prompts to recognize empty preparation. */
export const CREATION_INPUT_EXPECTATION_SCHEMA = `
ALTER TABLE session_creations ADD COLUMN input_expected INTEGER NOT NULL DEFAULT 1 CHECK (input_expected IN (0, 1));
`;
