export const MAIL_DRAFT_SYNC_SCHEMA_SQL=`
CREATE TABLE mail_draft_sync (
 account_id TEXT NOT NULL,draft_id TEXT NOT NULL,enabled INTEGER NOT NULL DEFAULT 0 CHECK(enabled IN (0,1)),
 state TEXT NOT NULL DEFAULT 'local' CHECK(state IN ('local','queued','syncing','synced','conflict','uncertain','error','removed')),revision INTEGER NOT NULL DEFAULT 0 CHECK(revision BETWEEN 0 AND 9007199254740991),operation TEXT NOT NULL DEFAULT 'upsert' CHECK(operation IN ('upsert','delete','cleanup','adopt')),
 generation TEXT,local_revision INTEGER,remote_json TEXT,baseline_hash TEXT,conflict_hash TEXT,conflict_raw BLOB,
 dispatch_id TEXT,dispatch_raw BLOB,dispatch_generation TEXT,dispatch_revision INTEGER,credential_generation TEXT,
 replacement_json TEXT,replacement_hash TEXT,error TEXT,updated_at INTEGER NOT NULL DEFAULT 0 CHECK(updated_at BETWEEN 0 AND 9007199254740991),
 PRIMARY KEY(account_id,draft_id),FOREIGN KEY(account_id,draft_id) REFERENCES mail_local_drafts(account_id,id),
 FOREIGN KEY(account_id,draft_id,dispatch_generation,dispatch_revision) REFERENCES mail_local_draft_versions(account_id,draft_id,generation,revision)
);
CREATE INDEX mail_draft_sync_pending ON mail_draft_sync(enabled,state,updated_at);
`;
