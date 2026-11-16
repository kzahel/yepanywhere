/**
 * v0 API receipts became per-process memory. Their creator relationships stay
 * in the relationship tables; `agent_api_session_aliases` is still read for
 * public ids remapped by older builds. Frozen SQL.
 */
export const DROP_AGENT_API_RECEIPTS_SCHEMA = `
DROP TABLE IF EXISTS agent_api_receipts;
`;
