/** Source titles follow the same accepted generation as public identity and project. */
export const RECENT_SOURCE_TITLE_SCHEMA = `
ALTER TABLE collection_cache_sources ADD COLUMN recent_title_json TEXT;
UPDATE collection_checkpoint SET valid=0 WHERE id=1;
`;
