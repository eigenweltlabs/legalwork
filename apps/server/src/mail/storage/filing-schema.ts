/** Immutable mail sources and deliberate, independently authorized matter filing receipts. */
export const MAIL_FILING_SCHEMA_SQL=`
CREATE TABLE mail_filing_snapshots(
 id TEXT PRIMARY KEY NOT NULL,account_id TEXT NOT NULL,source_message_key TEXT NOT NULL,
 manifest_json TEXT NOT NULL CHECK(json_valid(manifest_json)),manifest_hash TEXT NOT NULL CHECK(length(manifest_hash)=64),
 created_at INTEGER NOT NULL CHECK(created_at>=0),UNIQUE(id,account_id),
 FOREIGN KEY(account_id) REFERENCES mail_accounts(id)
);
CREATE TABLE mail_filing_parts(
 snapshot_id TEXT NOT NULL,ordinal INTEGER NOT NULL CHECK(ordinal>=0),account_id TEXT NOT NULL,ref_id TEXT NOT NULL,
 kind TEXT NOT NULL CHECK(kind IN ('original','attachment')),metadata_json TEXT NOT NULL CHECK(json_valid(metadata_json)),
 bytes INTEGER NOT NULL CHECK(bytes>=0),sha256 TEXT NOT NULL CHECK(length(sha256)=64),
 PRIMARY KEY(snapshot_id,ordinal),FOREIGN KEY(snapshot_id,account_id) REFERENCES mail_filing_snapshots(id,account_id),
 FOREIGN KEY(account_id,ref_id) REFERENCES mail_content_refs(account_id,id)
);
CREATE INDEX mail_filing_retained_refs ON mail_filing_parts(account_id,ref_id);
CREATE TABLE mail_matter_filings(
 id TEXT PRIMARY KEY NOT NULL,snapshot_id TEXT NOT NULL,workspace_id TEXT NOT NULL,backend_key TEXT NOT NULL,principal_key TEXT NOT NULL,matter_id TEXT NOT NULL,
 state TEXT NOT NULL CHECK(state IN ('queued','uploading','uncertain','filed','error','cancelled')),
 remote_id TEXT,receipt_json TEXT CHECK(receipt_json IS NULL OR json_valid(receipt_json)),error TEXT,
 generation TEXT NOT NULL,revision INTEGER NOT NULL DEFAULT 1 CHECK(revision>0),created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,
 UNIQUE(snapshot_id,workspace_id,backend_key,principal_key,matter_id),FOREIGN KEY(snapshot_id) REFERENCES mail_filing_snapshots(id)
);
CREATE INDEX mail_filing_matter_scope ON mail_matter_filings(workspace_id,backend_key,matter_id,state,remote_id);
`;
