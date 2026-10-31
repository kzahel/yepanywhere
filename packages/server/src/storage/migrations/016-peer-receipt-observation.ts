export const PEER_RECEIPT_OBSERVATION_SCHEMA = `
ALTER TABLE peer_api_outbound ADD COLUMN destination_server_id TEXT;
ALTER TABLE peer_api_outbound ADD COLUMN remote_receipt_id TEXT;
UPDATE peer_api_outbound SET
  destination_server_id = json_extract(record_json, '$.destinationServerId'),
  remote_receipt_id = json_extract(record_json, '$.receipt.id'),
  record_json = json_set(record_json, '$.destinationSessionId', json_extract(record_json, '$.receipt.sessionId'));
CREATE INDEX peer_api_outbound_receipt ON peer_api_outbound(destination_server_id, remote_receipt_id);
`;
