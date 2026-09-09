-- Frozen executed migration SQL from b4f3d33ba:apps/server/src/mail/storage/schema.ts
-- Existing version 0; target version 5. No current schema imports.
PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS mail_schema_version (singleton INTEGER PRIMARY KEY CHECK(singleton = 1), version INTEGER NOT NULL CHECK(version >= 0));
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
      );;
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
      );;
CREATE TABLE mail_sync_scopes (
        account_id TEXT NOT NULL, scope_id TEXT NOT NULL, generation TEXT NOT NULL, cursor TEXT,
        revision INTEGER NOT NULL CHECK(revision >= 0 AND revision <= 9007199254740991),
        discovery_complete INTEGER NOT NULL CHECK(discovery_complete IN (0,1)),
        PRIMARY KEY(account_id,scope_id,generation), FOREIGN KEY(account_id) REFERENCES mail_accounts(id) ON DELETE CASCADE
      );
      CREATE TABLE mail_sync_jobs (
        account_id TEXT NOT NULL, id TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('raw','body','attachment')),
        message_key TEXT NOT NULL, part_id TEXT NOT NULL, generation TEXT NOT NULL,
        state TEXT NOT NULL CHECK(state IN ('queued','running','retry','succeeded','failed')),
        attempts INTEGER NOT NULL CHECK(attempts BETWEEN 0 AND 20),
        max_attempts INTEGER NOT NULL CHECK(max_attempts BETWEEN 1 AND 20 AND attempts <= max_attempts),
        retry_base_ms INTEGER NOT NULL CHECK(retry_base_ms BETWEEN 1 AND 3600000),
        retry_max_ms INTEGER NOT NULL CHECK(retry_max_ms BETWEEN retry_base_ms AND 86400000),
        available_at INTEGER NOT NULL CHECK(available_at BETWEEN 0 AND 9007199254740991),
        lease_token TEXT, lease_until INTEGER CHECK(lease_until BETWEEN 0 AND 9007199254740991),
        last_error TEXT CHECK(last_error IN ('retryable','permanent','lease_expired')),
        PRIMARY KEY(account_id,id), UNIQUE(account_id,id,generation), UNIQUE(account_id,kind,message_key,part_id,generation),
        CHECK((state='queued' AND attempts=0) OR (state!='queued' AND attempts>0)),
        CHECK((kind='attachment' AND length(part_id)>0) OR (kind!='attachment' AND part_id='')),
        CHECK((state='running' AND lease_token IS NOT NULL AND lease_until IS NOT NULL) OR
          (state!='running' AND lease_token IS NULL AND lease_until IS NULL)),
        FOREIGN KEY(account_id,message_key) REFERENCES mail_messages(account_id,message_key) ON DELETE CASCADE
      );
      CREATE INDEX mail_sync_jobs_due ON mail_sync_jobs(account_id,state,available_at,id);
      CREATE INDEX mail_sync_jobs_expiry ON mail_sync_jobs(account_id,state,lease_until,id);
      CREATE TABLE mail_sync_scope_jobs (
        account_id TEXT NOT NULL, scope_id TEXT NOT NULL, generation TEXT NOT NULL, job_id TEXT NOT NULL,
        PRIMARY KEY(account_id,scope_id,generation,job_id),
        FOREIGN KEY(account_id,scope_id,generation) REFERENCES mail_sync_scopes(account_id,scope_id,generation) ON DELETE CASCADE,
        FOREIGN KEY(account_id,job_id,generation) REFERENCES mail_sync_jobs(account_id,id,generation) ON DELETE CASCADE
      );;
CREATE TABLE mail_account_credentials (
        account_id TEXT PRIMARY KEY NOT NULL, provider TEXT NOT NULL CHECK(provider IN ('gmail','graph')),
        client_id TEXT NOT NULL, authority TEXT NOT NULL, provider_subject TEXT NOT NULL,
        generation TEXT NOT NULL, revision INTEGER NOT NULL CHECK(revision BETWEEN 1 AND 9007199254740991),
        state TEXT NOT NULL CHECK(state IN ('connected','disconnected')),
        archive_locked INTEGER NOT NULL CHECK(archive_locked IN (0,1)),
        access_token TEXT CHECK(length(access_token) BETWEEN 1 AND 16384),
        refresh_token TEXT CHECK(length(refresh_token) BETWEEN 1 AND 16384),
        expires_at INTEGER CHECK(expires_at BETWEEN 1 AND 9007199254740991), granted_scopes_json TEXT,
        CHECK((state='connected' AND archive_locked=0 AND access_token IS NOT NULL AND expires_at IS NOT NULL) OR
          (state='disconnected' AND archive_locked=1 AND access_token IS NULL AND refresh_token IS NULL AND expires_at IS NULL AND granted_scopes_json IS NULL)),
        FOREIGN KEY(account_id,provider) REFERENCES mail_accounts(id,provider)
      );;
CREATE TABLE mail_action_jobs (
        account_id TEXT NOT NULL, id TEXT NOT NULL, replay_key TEXT NOT NULL,
        kind TEXT NOT NULL CHECK(kind IN ('mutation','submission')),
        payload_json TEXT NOT NULL CHECK(length(CAST(payload_json AS BLOB)) BETWEEN 2 AND 32768), precondition TEXT,
        conflict_policy TEXT NOT NULL CHECK(conflict_policy IN ('manual','refresh_then_reapply')),
        generation TEXT NOT NULL, revision INTEGER NOT NULL CHECK(revision BETWEEN 1 AND 9007199254740991),
        state TEXT NOT NULL CHECK(state IN ('queued','running','dispatching','retry','succeeded','failed','cancelled','uncertain')),
        attempts INTEGER NOT NULL CHECK(attempts BETWEEN 0 AND 20), max_attempts INTEGER NOT NULL CHECK(max_attempts BETWEEN 1 AND 20),
        retry_base_ms INTEGER NOT NULL CHECK(retry_base_ms BETWEEN 1 AND 3600000),
        retry_max_ms INTEGER NOT NULL CHECK(retry_max_ms BETWEEN retry_base_ms AND 86400000),
        available_at INTEGER NOT NULL CHECK(available_at BETWEEN 0 AND 9007199254740991),
        lease_token TEXT, lease_until INTEGER CHECK(lease_until BETWEEN 0 AND 9007199254740991),
        cancel_requested INTEGER NOT NULL DEFAULT 0 CHECK(cancel_requested IN (0,1)),
        last_error TEXT CHECK(last_error IN ('preflight_retryable','preflight_permanent','lease_expired','outcome_unknown','rejected','conflict','cancelled','reconciled')),
        PRIMARY KEY(account_id,id), UNIQUE(account_id,replay_key),
        CHECK(attempts <= max_attempts),
        CHECK(kind!='submission' OR conflict_policy='manual'),
        CHECK((state IN ('running','dispatching') AND lease_token IS NOT NULL AND lease_until IS NOT NULL) OR
          (state NOT IN ('running','dispatching') AND lease_token IS NULL AND lease_until IS NULL)),
        FOREIGN KEY(account_id) REFERENCES mail_accounts(id)
      );
      CREATE INDEX mail_action_jobs_ready ON mail_action_jobs(account_id,state,available_at,id);
      CREATE INDEX mail_action_jobs_expired ON mail_action_jobs(account_id,state,lease_until,id);;
INSERT INTO mail_schema_version(singleton,version) VALUES(1,5) ON CONFLICT(singleton) DO UPDATE SET version=excluded.version;
