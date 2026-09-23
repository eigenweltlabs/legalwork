/** v31. Personal provider contacts only; no directory data or local provider edits. */
export const MAIL_CONTACTS_SCHEMA_SQL = `
CREATE TABLE mail_contact_books (
 account_id TEXT PRIMARY KEY REFERENCES mail_accounts(id) ON DELETE CASCADE,
 cursor TEXT,last_sync_at INTEGER,attempt_at INTEGER NOT NULL DEFAULT 0,
 error TEXT CHECK(error IN ('permission','unavailable','limit','invalid_response'))
);
CREATE TABLE mail_contact_entries (
 account_id TEXT NOT NULL REFERENCES mail_contact_books(account_id) ON DELETE CASCADE,
 provider_id TEXT NOT NULL,name TEXT NOT NULL,addresses_json TEXT NOT NULL,
 PRIMARY KEY(account_id,provider_id)
);
`;
