/** Schema 23. Imported identities are offline, unrelated to any provider authorization. */
export const ARCHIVE_SCHEMA_SQL=`
 CREATE TABLE mail_accounts_archive_upgrade (
  id TEXT PRIMARY KEY NOT NULL,owner_id TEXT NOT NULL,provider TEXT NOT NULL CHECK(provider IN ('gmail','graph','imap','archive')),
  display_name TEXT NOT NULL,UNIQUE(id,provider)
 );
 INSERT INTO mail_accounts_archive_upgrade SELECT id,owner_id,provider,display_name FROM mail_accounts;
 DROP TABLE mail_accounts;
 ALTER TABLE mail_accounts_archive_upgrade RENAME TO mail_accounts;
 CREATE INDEX mail_accounts_owner ON mail_accounts(owner_id);
 CREATE TABLE mail_portability_jobs (
  id TEXT PRIMARY KEY NOT NULL,account_id TEXT NOT NULL,direction TEXT NOT NULL CHECK(direction IN ('import','export')),
  format TEXT NOT NULL CHECK(format IN ('eml','mboxrd','bundle')),path TEXT NOT NULL,namespace TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('ready','running','paused','interrupted','complete','attention')),
  source_hash TEXT,source_bytes INTEGER,checkpoint TEXT,output_offset INTEGER NOT NULL DEFAULT 0,manifest_offset INTEGER NOT NULL DEFAULT 0,
  completed INTEGER NOT NULL DEFAULT 0,bytes INTEGER NOT NULL DEFAULT 0,failed INTEGER NOT NULL DEFAULT 0,
  error TEXT CHECK(error IN ('source_changed','invalid_archive','storage_failed','content_unavailable','interrupted')),
  label TEXT NOT NULL,FOREIGN KEY(account_id) REFERENCES mail_accounts(id)
 );
 CREATE TABLE mail_portability_folders (
  job_id TEXT NOT NULL,id TEXT NOT NULL,manifest_json TEXT NOT NULL,state TEXT NOT NULL CHECK(state IN ('pending','complete')),
  PRIMARY KEY(job_id,id),FOREIGN KEY(job_id) REFERENCES mail_portability_jobs(id) ON DELETE CASCADE
 );
 CREATE TABLE mail_archive_messages (
  account_id TEXT NOT NULL,message_key TEXT NOT NULL,namespace TEXT NOT NULL,entry_id TEXT NOT NULL,
  received_at INTEGER,provenance_json TEXT NOT NULL,PRIMARY KEY(account_id,message_key),UNIQUE(account_id,namespace,entry_id),
  FOREIGN KEY(account_id,message_key) REFERENCES mail_messages(account_id,message_key) ON DELETE CASCADE
 );
 CREATE TABLE mail_portability_entries (
  job_id TEXT NOT NULL,entry_id TEXT NOT NULL,message_key TEXT NOT NULL,reference_id TEXT,
  manifest_json TEXT NOT NULL,state TEXT NOT NULL CHECK(state IN ('pending','complete','failed')),
  PRIMARY KEY(job_id,entry_id),FOREIGN KEY(job_id) REFERENCES mail_portability_jobs(id) ON DELETE CASCADE
 );
 CREATE INDEX mail_portability_entries_ready ON mail_portability_entries(job_id,state,entry_id);
 CREATE INDEX mail_portability_folders_ready ON mail_portability_folders(job_id,state,id);
 CREATE TRIGGER mail_archive_credentials_insert BEFORE INSERT ON mail_imap_credentials
 WHEN EXISTS(SELECT 1 FROM mail_accounts WHERE id=NEW.account_id AND provider='archive')
 BEGIN SELECT RAISE(ABORT,'Offline archives cannot have provider credentials');END;
 CREATE TRIGGER mail_archive_smtp_insert BEFORE INSERT ON mail_smtp_credentials
 WHEN EXISTS(SELECT 1 FROM mail_accounts WHERE id=NEW.account_id AND provider='archive')
 BEGIN SELECT RAISE(ABORT,'Offline archives cannot have SMTP credentials');END;
 CREATE TRIGGER mail_archive_smtp_update BEFORE UPDATE ON mail_smtp_credentials
 WHEN EXISTS(SELECT 1 FROM mail_accounts WHERE id=NEW.account_id AND provider='archive')
 BEGIN SELECT RAISE(ABORT,'Offline archives cannot have SMTP credentials');END;
 CREATE TRIGGER mail_archive_credentials_update BEFORE UPDATE ON mail_imap_credentials
 WHEN EXISTS(SELECT 1 FROM mail_accounts WHERE id=NEW.account_id AND provider='archive')
 BEGIN SELECT RAISE(ABORT,'Offline archives cannot have provider credentials');END;
 CREATE TRIGGER mail_archive_actions_update BEFORE UPDATE ON mail_action_jobs
 WHEN EXISTS(SELECT 1 FROM mail_accounts WHERE id=NEW.account_id AND provider='archive')
 BEGIN SELECT RAISE(ABORT,'Offline archives cannot queue outbound actions');END;
 CREATE TRIGGER mail_archive_actions_insert BEFORE INSERT ON mail_action_jobs
 WHEN EXISTS(SELECT 1 FROM mail_accounts WHERE id=NEW.account_id AND provider='archive')
 BEGIN SELECT RAISE(ABORT,'Offline archives cannot queue outbound actions');END;
`;
