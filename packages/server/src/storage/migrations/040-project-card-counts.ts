/** Derived facts mirror the retained query owner; the next read rebuilds older checkpoints. */
export const PROJECT_CARD_COUNTS_SCHEMA = `
ALTER TABLE collection_cache_sources ADD COLUMN card_provider TEXT;
CREATE TABLE collection_cache_cards (key TEXT PRIMARY KEY, session_id TEXT NOT NULL,
 project_id TEXT NOT NULL, provider TEXT, control_provider TEXT, control_order INTEGER, control_updated TEXT);
UPDATE collection_checkpoint SET valid=0 WHERE id=1;
`;
