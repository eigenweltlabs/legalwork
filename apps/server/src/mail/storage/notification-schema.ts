/** Main-process delivery epochs suppress relaunch/backfill; claims precede OS delivery. */
export const MAIL_NOTIFICATION_SCHEMA_SQL=`
CREATE TABLE mail_notification_accounts(
 account_id TEXT PRIMARY KEY,session_id TEXT NOT NULL,credential_generation TEXT NOT NULL,event_generation TEXT NOT NULL,
 baseline_at INTEGER NOT NULL CHECK(baseline_at>=0),after_sequence INTEGER NOT NULL CHECK(after_sequence>=0),
 FOREIGN KEY(account_id) REFERENCES mail_accounts(id) ON DELETE CASCADE
);
CREATE TABLE mail_notification_claims(
 account_id TEXT NOT NULL,message_key TEXT NOT NULL,claimed_at INTEGER NOT NULL CHECK(claimed_at>=0),
 PRIMARY KEY(account_id,message_key),FOREIGN KEY(account_id,message_key) REFERENCES mail_messages(account_id,message_key) ON DELETE CASCADE
);
`;
