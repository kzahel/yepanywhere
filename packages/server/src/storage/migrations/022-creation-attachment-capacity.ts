/** Attachment claims share the creation transaction and profile capacity. */
export const CREATION_ATTACHMENT_CAPACITY_SCHEMA = `
ALTER TABLE session_creation_capacity ADD COLUMN attachment_bytes INTEGER NOT NULL DEFAULT 0 CHECK (attachment_bytes >= 0);
`;
