import type { MailDatabase } from "./database-interface.js";

export const MAIL_SCHEMA_VERSION = 2;

/** Dedicated mail database only. Every DDL/version write shares one transaction. */
export function migrateMailSchema(database: MailDatabase): void {
  database.exec("PRAGMA foreign_keys = ON");
  if (database.get("PRAGMA foreign_keys")?.foreign_keys !== 1) throw new Error("Mail storage requires foreign keys");
  database.transaction(() => {
    database.exec("CREATE TABLE IF NOT EXISTS mail_schema_version (singleton INTEGER PRIMARY KEY CHECK(singleton = 1), version INTEGER NOT NULL CHECK(version >= 0))");
    const row = database.get("SELECT version FROM mail_schema_version WHERE singleton = 1");
    const version = row?.version ?? 0;
    if (typeof version !== "number" || !Number.isSafeInteger(version) || version < 0 || version > MAIL_SCHEMA_VERSION) throw new Error("Unsupported mail schema version");
    if (version === MAIL_SCHEMA_VERSION) return;
    if (version === 0) database.exec(`
      CREATE TABLE mail_accounts (
        id TEXT PRIMARY KEY NOT NULL, owner_id TEXT NOT NULL, provider TEXT NOT NULL CHECK(provider IN ('gmail','graph','imap')),
        display_name TEXT NOT NULL, UNIQUE(id,provider)
      );
      CREATE INDEX mail_accounts_owner ON mail_accounts(owner_id);
      CREATE TABLE mail_folders (
        account_id TEXT NOT NULL, id TEXT NOT NULL, name TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('folder','label')),
        parent_id TEXT, PRIMARY KEY(account_id,id), CHECK(parent_id IS NULL OR parent_id != id),
        FOREIGN KEY(account_id) REFERENCES mail_accounts(id) ON DELETE CASCADE,
        FOREIGN KEY(account_id,parent_id) REFERENCES mail_folders(account_id,id) DEFERRABLE INITIALLY DEFERRED
      );
      CREATE TABLE mail_threads (
        account_id TEXT NOT NULL, id TEXT NOT NULL, PRIMARY KEY(account_id,id),
        FOREIGN KEY(account_id) REFERENCES mail_accounts(id) ON DELETE CASCADE
      );
      CREATE TABLE mail_messages (
        account_id TEXT NOT NULL, message_key TEXT NOT NULL, provider TEXT NOT NULL, locator_json TEXT NOT NULL,
        rfc_message_id TEXT, subject TEXT NOT NULL, thread_id TEXT, attachments_enumerated INTEGER NOT NULL DEFAULT 0 CHECK(attachments_enumerated IN (0,1)),
        PRIMARY KEY(account_id,message_key),
        FOREIGN KEY(account_id,provider) REFERENCES mail_accounts(id,provider) ON DELETE CASCADE,
        FOREIGN KEY(account_id,thread_id) REFERENCES mail_threads(account_id,id)
      );
      CREATE TABLE mail_memberships (
        account_id TEXT NOT NULL, message_key TEXT NOT NULL, folder_id TEXT NOT NULL,
        PRIMARY KEY(account_id,message_key,folder_id),
        FOREIGN KEY(account_id,message_key) REFERENCES mail_messages(account_id,message_key) ON DELETE CASCADE,
        FOREIGN KEY(account_id,folder_id) REFERENCES mail_folders(account_id,id) ON DELETE CASCADE
      );
      CREATE TABLE mail_content_refs (
        account_id TEXT NOT NULL, id TEXT NOT NULL, bytes INTEGER NOT NULL CHECK(bytes >= 0 AND bytes <= 9007199254740991),
        sha256 TEXT NOT NULL CHECK(length(sha256) = 64 AND sha256 NOT GLOB '*[^0-9a-f]*'),
        PRIMARY KEY(account_id,id), FOREIGN KEY(account_id) REFERENCES mail_accounts(id) ON DELETE CASCADE
      );
      CREATE TABLE mail_content_manifests (
        account_id TEXT NOT NULL, message_key TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('raw','body','attachment')), part_id TEXT NOT NULL,
        state TEXT NOT NULL CHECK(state IN ('pending','stored','unavailable')), ref_id TEXT,
        PRIMARY KEY(account_id,message_key,kind,part_id),
        CHECK((kind = 'attachment' AND length(part_id) > 0) OR (kind != 'attachment' AND part_id = '')),
        CHECK((state = 'stored' AND ref_id IS NOT NULL) OR (state != 'stored' AND ref_id IS NULL)),
        FOREIGN KEY(account_id,message_key) REFERENCES mail_messages(account_id,message_key) ON DELETE CASCADE,
        FOREIGN KEY(account_id,ref_id) REFERENCES mail_content_refs(account_id,id)
      );
      CREATE TABLE mail_cursors (
        account_id TEXT NOT NULL, scope_id TEXT NOT NULL, cursor TEXT NOT NULL, PRIMARY KEY(account_id,scope_id),
        FOREIGN KEY(account_id) REFERENCES mail_accounts(id) ON DELETE CASCADE
      );
      CREATE TABLE mail_drafts (
        account_id TEXT NOT NULL, id TEXT NOT NULL, revision INTEGER NOT NULL CHECK(revision >= 0), content_ref_id TEXT,
        PRIMARY KEY(account_id,id), FOREIGN KEY(account_id) REFERENCES mail_accounts(id) ON DELETE CASCADE,
        FOREIGN KEY(account_id,content_ref_id) REFERENCES mail_content_refs(account_id,id)
      );
      CREATE TABLE mail_actions (
        account_id TEXT NOT NULL, id TEXT NOT NULL, kind TEXT NOT NULL, payload_json TEXT NOT NULL,
        state TEXT NOT NULL CHECK(state IN ('queued','running','succeeded','failed','uncertain')), PRIMARY KEY(account_id,id),
        FOREIGN KEY(account_id) REFERENCES mail_accounts(id) ON DELETE CASCADE
      );
      CREATE TABLE mail_tombstones (
        account_id TEXT NOT NULL, message_key TEXT NOT NULL, reason TEXT NOT NULL, observed_at TEXT NOT NULL,
        PRIMARY KEY(account_id,message_key), FOREIGN KEY(account_id) REFERENCES mail_accounts(id) ON DELETE CASCADE
      );
    `);
    if (version < 2) database.exec(`
      CREATE TABLE mail_blob_objects (
        account_id TEXT NOT NULL, id TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN ('staging','published')),
        bytes INTEGER NOT NULL DEFAULT 0 CHECK(bytes >= 0 AND bytes <= 9007199254740991),
        chunk_count INTEGER NOT NULL DEFAULT 0 CHECK(chunk_count >= 0 AND chunk_count <= 9007199254740991),
        PRIMARY KEY(account_id,id), FOREIGN KEY(account_id) REFERENCES mail_accounts(id) ON DELETE CASCADE
      );
      CREATE TABLE mail_blob_chunks (
        account_id TEXT NOT NULL, object_id TEXT NOT NULL, ordinal INTEGER NOT NULL CHECK(ordinal >= 0 AND ordinal <= 9007199254740991),
        data BLOB NOT NULL CHECK(typeof(data) = 'blob' AND length(data) BETWEEN 1 AND 65536),
        PRIMARY KEY(account_id,object_id,ordinal),
        FOREIGN KEY(account_id,object_id) REFERENCES mail_blob_objects(account_id,id) ON DELETE CASCADE
      );
      CREATE TABLE mail_blob_publications (
        account_id TEXT NOT NULL, ref_id TEXT NOT NULL, object_id TEXT NOT NULL,
        PRIMARY KEY(account_id,ref_id), UNIQUE(account_id,object_id),
        FOREIGN KEY(account_id,ref_id) REFERENCES mail_content_refs(account_id,id),
        FOREIGN KEY(account_id,object_id) REFERENCES mail_blob_objects(account_id,id)
      );
    `);
    database.run("INSERT INTO mail_schema_version(singleton,version) VALUES(1,?) ON CONFLICT(singleton) DO UPDATE SET version=excluded.version", [MAIL_SCHEMA_VERSION]);
  });
}
