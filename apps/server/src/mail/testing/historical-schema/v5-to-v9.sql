-- Frozen executed migration SQL from 82ad798dc:apps/server/src/mail/storage/schema.ts
-- Existing version 5; target version 9. No current schema imports.
PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS mail_schema_version (singleton INTEGER PRIMARY KEY CHECK(singleton = 1), version INTEGER NOT NULL CHECK(version >= 0));
CREATE TABLE mail_gmail_runs (
        account_id TEXT PRIMARY KEY NOT NULL, generation TEXT NOT NULL, revision INTEGER NOT NULL CHECK(revision BETWEEN 1 AND 9007199254740991),
        state TEXT NOT NULL CHECK(state IN ('active','paused','complete','attention')), failure_count INTEGER NOT NULL DEFAULT 0 CHECK(failure_count BETWEEN 0 AND 5), recent_after INTEGER NOT NULL CHECK(recent_after BETWEEN 0 AND 9007199254740991),
        next_retry_at INTEGER CHECK(next_retry_at BETWEEN 0 AND 9007199254740991),
        error TEXT CHECK(error IN ('reconsent_required','configuration_invalid','provider_unavailable','rate_limited','message_unavailable','content_incomplete','storage_unavailable','sync_failed')),
        FOREIGN KEY(account_id) REFERENCES mail_accounts(id)
      );
      CREATE TABLE mail_gmail_metadata (
        account_id TEXT NOT NULL, message_key TEXT NOT NULL, internal_date INTEGER NOT NULL CHECK(internal_date BETWEEN 0 AND 9007199254740991),
        thread_id TEXT NOT NULL, label_ids_json TEXT NOT NULL, PRIMARY KEY(account_id,message_key),
        FOREIGN KEY(account_id,message_key) REFERENCES mail_messages(account_id,message_key) ON DELETE CASCADE
      );
      CREATE TABLE mail_mime_projections (
        account_id TEXT NOT NULL, message_key TEXT NOT NULL, raw_ref_id TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN ('complete','error')),
        metadata_json TEXT, body_ref_id TEXT, error TEXT CHECK(error IN ('invalid_input','limit','timeout','cancelled','malformed','unsupported','source_failed','sink_failed','hash_mismatch')),
        PRIMARY KEY(account_id,message_key,raw_ref_id),
        CHECK((state='complete' AND metadata_json IS NOT NULL AND body_ref_id IS NOT NULL AND error IS NULL) OR
          (state='error' AND metadata_json IS NULL AND body_ref_id IS NULL AND error IS NOT NULL)),
        FOREIGN KEY(account_id,message_key) REFERENCES mail_messages(account_id,message_key) ON DELETE CASCADE,
        FOREIGN KEY(account_id,raw_ref_id) REFERENCES mail_content_refs(account_id,id),
        FOREIGN KEY(account_id,body_ref_id) REFERENCES mail_content_refs(account_id,id)
      );
      CREATE TABLE mail_mime_parts (
        account_id TEXT NOT NULL, message_key TEXT NOT NULL, raw_ref_id TEXT NOT NULL, part_id TEXT NOT NULL, metadata_json TEXT NOT NULL, content_ref_id TEXT NOT NULL,
        PRIMARY KEY(account_id,message_key,raw_ref_id,part_id),
        FOREIGN KEY(account_id,message_key,raw_ref_id) REFERENCES mail_mime_projections(account_id,message_key,raw_ref_id) ON DELETE CASCADE,
        FOREIGN KEY(account_id,content_ref_id) REFERENCES mail_content_refs(account_id,id)
      );
      CREATE TRIGGER mail_raw_projection_insert AFTER INSERT ON mail_content_manifests WHEN NEW.kind='raw' BEGIN
        DELETE FROM mail_content_manifests WHERE account_id=NEW.account_id AND message_key=NEW.message_key AND kind!='raw';
        UPDATE mail_messages SET attachments_enumerated=0 WHERE account_id=NEW.account_id AND message_key=NEW.message_key;
      END;
      CREATE TRIGGER mail_raw_projection_update AFTER UPDATE ON mail_content_manifests
        WHEN NEW.kind='raw' AND (OLD.ref_id IS NOT NEW.ref_id OR OLD.state IS NOT NEW.state) BEGIN
        DELETE FROM mail_content_manifests WHERE account_id=NEW.account_id AND message_key=NEW.message_key AND kind!='raw';
        UPDATE mail_messages SET attachments_enumerated=0 WHERE account_id=NEW.account_id AND message_key=NEW.message_key;
      END;;
ALTER TABLE mail_gmail_runs ADD COLUMN phase TEXT NOT NULL DEFAULT 'backfill' CHECK(phase IN ('backfill','history'));
      ALTER TABLE mail_gmail_runs ADD COLUMN history_id TEXT;
      ALTER TABLE mail_gmail_runs ADD COLUMN history_page_token TEXT;
      ALTER TABLE mail_gmail_runs ADD COLUMN poll_at INTEGER CHECK(poll_at BETWEEN 0 AND 9007199254740991);
      CREATE TABLE mail_gmail_presence (
        account_id TEXT NOT NULL, message_key TEXT NOT NULL, seen_generation TEXT, remote_present INTEGER NOT NULL CHECK(remote_present IN (0,1)), history_id TEXT,
        PRIMARY KEY(account_id,message_key), FOREIGN KEY(account_id,message_key) REFERENCES mail_messages(account_id,message_key) ON DELETE CASCADE
      );
      CREATE INDEX mail_gmail_presence_scan ON mail_gmail_presence(account_id,remote_present,seen_generation,message_key);
      INSERT INTO mail_gmail_presence(account_id,message_key,seen_generation,remote_present,history_id)
        SELECT account_id,message_key,NULL,1,NULL FROM mail_messages WHERE provider='gmail';;
ALTER TABLE mail_messages ADD COLUMN is_read INTEGER CHECK(is_read IN (0,1));
      CREATE TABLE mail_search_documents (
        id INTEGER PRIMARY KEY, account_id TEXT NOT NULL, message_key TEXT NOT NULL,
        subject TEXT NOT NULL, body TEXT NOT NULL, names TEXT NOT NULL, addresses TEXT NOT NULL,
        senders_json TEXT NOT NULL, recipients_json TEXT NOT NULL, filenames_json TEXT NOT NULL,
        normalized_text TEXT NOT NULL, has_attachment INTEGER CHECK(has_attachment IN (0,1)),
        date TEXT, incomplete INTEGER NOT NULL CHECK(incomplete IN (0,1)),
        UNIQUE(account_id,message_key), FOREIGN KEY(account_id,message_key) REFERENCES mail_messages(account_id,message_key) ON DELETE CASCADE
      );
      CREATE VIRTUAL TABLE mail_search_fts USING fts5(subject,body,names,addresses,content='mail_search_documents',content_rowid='id',tokenize='unicode61 remove_diacritics 0');
      CREATE TRIGGER mail_search_insert AFTER INSERT ON mail_search_documents BEGIN
        INSERT INTO mail_search_fts(rowid,subject,body,names,addresses) VALUES(NEW.id,NEW.subject,NEW.body,NEW.names,NEW.addresses);
      END;
      CREATE TRIGGER mail_search_delete AFTER DELETE ON mail_search_documents BEGIN
        INSERT INTO mail_search_fts(mail_search_fts,rowid,subject,body,names,addresses) VALUES('delete',OLD.id,OLD.subject,OLD.body,OLD.names,OLD.addresses);
      END;
      CREATE TABLE mail_search_dirty(account_id TEXT NOT NULL,message_key TEXT NOT NULL,PRIMARY KEY(account_id,message_key),FOREIGN KEY(account_id,message_key) REFERENCES mail_messages(account_id,message_key) ON DELETE CASCADE);
      INSERT INTO mail_search_dirty SELECT account_id,message_key FROM mail_messages;;
CREATE TRIGGER mail_search_dirty_mail_messages_INSERT AFTER INSERT ON mail_messages BEGIN
            INSERT INTO mail_search_dirty(account_id,message_key) SELECT NEW.account_id,NEW.message_key WHERE EXISTS(SELECT 1 FROM mail_messages WHERE account_id=NEW.account_id AND message_key=NEW.message_key) ON CONFLICT(account_id,message_key) DO NOTHING;
          END;
CREATE TRIGGER mail_search_dirty_mail_messages_UPDATE AFTER UPDATE ON mail_messages BEGIN
            INSERT INTO mail_search_dirty(account_id,message_key) SELECT NEW.account_id,NEW.message_key WHERE EXISTS(SELECT 1 FROM mail_messages WHERE account_id=NEW.account_id AND message_key=NEW.message_key) ON CONFLICT(account_id,message_key) DO NOTHING;
          END;
CREATE TRIGGER mail_search_dirty_mail_content_manifests_INSERT AFTER INSERT ON mail_content_manifests BEGIN
            INSERT INTO mail_search_dirty(account_id,message_key) SELECT NEW.account_id,NEW.message_key WHERE EXISTS(SELECT 1 FROM mail_messages WHERE account_id=NEW.account_id AND message_key=NEW.message_key) ON CONFLICT(account_id,message_key) DO NOTHING;
          END;
CREATE TRIGGER mail_search_dirty_mail_content_manifests_UPDATE AFTER UPDATE ON mail_content_manifests BEGIN
            INSERT INTO mail_search_dirty(account_id,message_key) SELECT NEW.account_id,NEW.message_key WHERE EXISTS(SELECT 1 FROM mail_messages WHERE account_id=NEW.account_id AND message_key=NEW.message_key) ON CONFLICT(account_id,message_key) DO NOTHING;
          END;
CREATE TRIGGER mail_search_dirty_mail_content_manifests_DELETE AFTER DELETE ON mail_content_manifests BEGIN
            INSERT INTO mail_search_dirty(account_id,message_key) SELECT OLD.account_id,OLD.message_key WHERE EXISTS(SELECT 1 FROM mail_messages WHERE account_id=OLD.account_id AND message_key=OLD.message_key) ON CONFLICT(account_id,message_key) DO NOTHING;
          END;
CREATE TRIGGER mail_search_dirty_mail_mime_projections_INSERT AFTER INSERT ON mail_mime_projections BEGIN
            INSERT INTO mail_search_dirty(account_id,message_key) SELECT NEW.account_id,NEW.message_key WHERE EXISTS(SELECT 1 FROM mail_messages WHERE account_id=NEW.account_id AND message_key=NEW.message_key) ON CONFLICT(account_id,message_key) DO NOTHING;
          END;
CREATE TRIGGER mail_search_dirty_mail_mime_projections_UPDATE AFTER UPDATE ON mail_mime_projections BEGIN
            INSERT INTO mail_search_dirty(account_id,message_key) SELECT NEW.account_id,NEW.message_key WHERE EXISTS(SELECT 1 FROM mail_messages WHERE account_id=NEW.account_id AND message_key=NEW.message_key) ON CONFLICT(account_id,message_key) DO NOTHING;
          END;
CREATE TRIGGER mail_search_dirty_mail_mime_projections_DELETE AFTER DELETE ON mail_mime_projections BEGIN
            INSERT INTO mail_search_dirty(account_id,message_key) SELECT OLD.account_id,OLD.message_key WHERE EXISTS(SELECT 1 FROM mail_messages WHERE account_id=OLD.account_id AND message_key=OLD.message_key) ON CONFLICT(account_id,message_key) DO NOTHING;
          END;
CREATE TRIGGER mail_search_dirty_mail_mime_parts_INSERT AFTER INSERT ON mail_mime_parts BEGIN
            INSERT INTO mail_search_dirty(account_id,message_key) SELECT NEW.account_id,NEW.message_key WHERE EXISTS(SELECT 1 FROM mail_messages WHERE account_id=NEW.account_id AND message_key=NEW.message_key) ON CONFLICT(account_id,message_key) DO NOTHING;
          END;
CREATE TRIGGER mail_search_dirty_mail_mime_parts_UPDATE AFTER UPDATE ON mail_mime_parts BEGIN
            INSERT INTO mail_search_dirty(account_id,message_key) SELECT NEW.account_id,NEW.message_key WHERE EXISTS(SELECT 1 FROM mail_messages WHERE account_id=NEW.account_id AND message_key=NEW.message_key) ON CONFLICT(account_id,message_key) DO NOTHING;
          END;
CREATE TRIGGER mail_search_dirty_mail_mime_parts_DELETE AFTER DELETE ON mail_mime_parts BEGIN
            INSERT INTO mail_search_dirty(account_id,message_key) SELECT OLD.account_id,OLD.message_key WHERE EXISTS(SELECT 1 FROM mail_messages WHERE account_id=OLD.account_id AND message_key=OLD.message_key) ON CONFLICT(account_id,message_key) DO NOTHING;
          END;
CREATE TABLE mail_graph_runs(account_id TEXT PRIMARY KEY,generation TEXT NOT NULL,revision INTEGER NOT NULL CHECK(revision BETWEEN 1 AND 9007199254740991),state TEXT NOT NULL CHECK(state IN ('active','paused','complete','attention')),failures INTEGER NOT NULL DEFAULT 0 CHECK(failures BETWEEN 0 AND 5),retry_at INTEGER CHECK(retry_at BETWEEN 0 AND 9007199254740991),error TEXT,FOREIGN KEY(account_id) REFERENCES mail_accounts(id));
 CREATE TABLE mail_graph_folder_queue(account_id TEXT NOT NULL,id TEXT NOT NULL,parent_id TEXT,depth INTEGER NOT NULL CHECK(depth BETWEEN 0 AND 33),metadata_json TEXT CHECK(metadata_json IS NULL OR json_valid(metadata_json)),cursor TEXT,done INTEGER NOT NULL DEFAULT 0 CHECK(done IN (0,1)),error TEXT,PRIMARY KEY(account_id,id),FOREIGN KEY(account_id) REFERENCES mail_accounts(id));
 CREATE INDEX mail_graph_folder_pending ON mail_graph_folder_queue(account_id,done,depth,id);
 CREATE TABLE mail_graph_messages(account_id TEXT NOT NULL,message_key TEXT NOT NULL,metadata_json TEXT NOT NULL CHECK(json_valid(metadata_json)),raw_change_key TEXT,parts_complete INTEGER NOT NULL DEFAULT 0 CHECK(parts_complete IN (0,1)),error TEXT,PRIMARY KEY(account_id,message_key),FOREIGN KEY(account_id,message_key) REFERENCES mail_messages(account_id,message_key));
 CREATE TABLE mail_graph_attachments(account_id TEXT NOT NULL,message_key TEXT NOT NULL,id TEXT NOT NULL,raw_ref_id TEXT NOT NULL,metadata_json TEXT NOT NULL CHECK(json_valid(metadata_json)),ref_id TEXT,error TEXT,PRIMARY KEY(account_id,message_key,id),FOREIGN KEY(account_id,message_key) REFERENCES mail_messages(account_id,message_key),FOREIGN KEY(account_id,raw_ref_id) REFERENCES mail_content_refs(account_id,id),FOREIGN KEY(account_id,ref_id) REFERENCES mail_content_refs(account_id,id));
 CREATE TRIGGER mail_graph_attachment_search_INSERT AFTER INSERT ON mail_graph_attachments BEGIN INSERT INTO mail_search_dirty(account_id,message_key) SELECT NEW.account_id,NEW.message_key WHERE EXISTS(SELECT 1 FROM mail_messages WHERE account_id=NEW.account_id AND message_key=NEW.message_key) ON CONFLICT DO NOTHING; END;
 CREATE TRIGGER mail_graph_attachment_search_UPDATE AFTER UPDATE ON mail_graph_attachments BEGIN INSERT INTO mail_search_dirty(account_id,message_key) SELECT NEW.account_id,NEW.message_key WHERE EXISTS(SELECT 1 FROM mail_messages WHERE account_id=NEW.account_id AND message_key=NEW.message_key) ON CONFLICT DO NOTHING; END;
 CREATE TRIGGER mail_graph_attachment_search_DELETE AFTER DELETE ON mail_graph_attachments BEGIN INSERT INTO mail_search_dirty(account_id,message_key) SELECT OLD.account_id,OLD.message_key WHERE EXISTS(SELECT 1 FROM mail_messages WHERE account_id=OLD.account_id AND message_key=OLD.message_key) ON CONFLICT DO NOTHING; END;;
INSERT INTO mail_schema_version(singleton,version) VALUES(1,9) ON CONFLICT(singleton) DO UPDATE SET version=excluded.version;
