/** All content and SMTP secrets live exclusively in the encrypted mail database. */
export const OUTBOX_SCHEMA_SQL=`
CREATE TABLE mail_smtp_credentials(
 account_id TEXT PRIMARY KEY REFERENCES mail_accounts(id),generation TEXT NOT NULL,revision INTEGER NOT NULL CHECK(revision>0),
 account_generation TEXT NOT NULL,settings_json TEXT NOT NULL CHECK(json_valid(settings_json)),password TEXT NOT NULL
);
CREATE TABLE mail_outbox(
 account_id TEXT NOT NULL,action_id TEXT NOT NULL,draft_id TEXT NOT NULL,draft_generation TEXT NOT NULL,draft_revision INTEGER NOT NULL,
 message_id TEXT NOT NULL,mime_bytes BLOB NOT NULL CHECK(length(mime_bytes)<=33554432),api_mime_bytes BLOB NOT NULL CHECK(length(api_mime_bytes)<=33554432),
 envelope_json TEXT NOT NULL CHECK(json_valid(envelope_json)),content_json TEXT NOT NULL CHECK(json_valid(content_json)),
 credential_generation TEXT NOT NULL,smtp_generation TEXT,preparation_json TEXT CHECK(preparation_json IS NULL OR json_valid(preparation_json)),
 result_json TEXT CHECK(result_json IS NULL OR json_valid(result_json)),error TEXT,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,
 PRIMARY KEY(account_id,action_id),UNIQUE(account_id,draft_id,draft_generation,draft_revision),UNIQUE(account_id,message_id),
 FOREIGN KEY(account_id,action_id) REFERENCES mail_action_jobs(account_id,id),
 FOREIGN KEY(account_id,draft_id,draft_generation,draft_revision) REFERENCES mail_local_draft_versions(account_id,draft_id,generation,revision)
);
CREATE INDEX mail_outbox_created ON mail_outbox(account_id,created_at,action_id);
CREATE TABLE mail_outbox_attempts(
 account_id TEXT NOT NULL,action_id TEXT NOT NULL,attempt INTEGER NOT NULL,started_at INTEGER NOT NULL,finished_at INTEGER,
 phase TEXT NOT NULL CHECK(phase IN ('preparing','dispatching','accepted','failed','uncertain')),error TEXT,
 PRIMARY KEY(account_id,action_id,attempt),FOREIGN KEY(account_id,action_id) REFERENCES mail_outbox(account_id,action_id)
);
`;
