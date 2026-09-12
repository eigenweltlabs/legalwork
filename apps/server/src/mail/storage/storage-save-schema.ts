/** Provider-neutral save receipts pin the same immutable encrypted mail snapshot. */
export const MAIL_STORAGE_SAVE_SCHEMA_SQL=`
CREATE TABLE mail_storage_saves(
 id TEXT PRIMARY KEY NOT NULL,snapshot_id TEXT NOT NULL,workspace_id TEXT NOT NULL,storage_id TEXT NOT NULL,
 root_revision TEXT NOT NULL,folder_path TEXT NOT NULL,selection_json TEXT NOT NULL CHECK(json_valid(selection_json)),
 state TEXT NOT NULL CHECK(state IN ('queued','uploading','uncertain','complete','cancelled')),
 generation TEXT NOT NULL,revision INTEGER NOT NULL DEFAULT 1 CHECK(revision>0),error TEXT,
 created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,
 FOREIGN KEY(snapshot_id) REFERENCES mail_filing_snapshots(id),
 UNIQUE(snapshot_id,workspace_id,storage_id,root_revision,folder_path,selection_json)
);
CREATE TABLE mail_storage_save_parts(
 save_id TEXT NOT NULL,ordinal INTEGER NOT NULL CHECK(ordinal>=0),part_index INTEGER NOT NULL CHECK(part_index>=-1),
 path TEXT NOT NULL,bytes INTEGER NOT NULL CHECK(bytes>=0),sha256 TEXT NOT NULL CHECK(length(sha256)=64),mime_type TEXT NOT NULL,
 state TEXT NOT NULL CHECK(state IN ('queued','uploading','uncertain','saved')),version TEXT,
 PRIMARY KEY(save_id,ordinal),UNIQUE(save_id,path),FOREIGN KEY(save_id) REFERENCES mail_storage_saves(id)
);
CREATE INDEX mail_storage_save_workspace ON mail_storage_saves(workspace_id,id);
`;
