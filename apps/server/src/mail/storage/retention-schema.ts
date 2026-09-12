/** Schema25: explicit retention preferences and durable no-replay recovery fences. */
export const MAIL_RETENTION_SCHEMA_SQL=`
CREATE TABLE mail_retention_settings (
 account_id TEXT PRIMARY KEY NOT NULL,removed_days INTEGER CHECK(removed_days BETWEEN 1 AND 36500),revision INTEGER NOT NULL DEFAULT 1,
 FOREIGN KEY(account_id) REFERENCES mail_accounts(id) ON DELETE CASCADE
);
CREATE TABLE mail_recovery_quarantine (
 account_id TEXT NOT NULL,kind TEXT NOT NULL CHECK(kind IN ('submission','draft','portability','filing')),entity_id TEXT NOT NULL,restored_at INTEGER NOT NULL,
 PRIMARY KEY(account_id,kind,entity_id),FOREIGN KEY(account_id) REFERENCES mail_accounts(id) ON DELETE CASCADE
);
`;
