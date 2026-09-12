export const EXTRACTION_SCHEMA_SQL = `
CREATE TABLE mail_attachment_extractions(
 account_id TEXT NOT NULL,message_key TEXT NOT NULL,part_id TEXT NOT NULL,ref_id TEXT NOT NULL,extractor TEXT NOT NULL,
 state TEXT NOT NULL CHECK(state IN ('queued','running','complete','failed')),attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts BETWEEN 0 AND 3),
 lease_token TEXT,lease_until INTEGER,error TEXT,result_json TEXT,
 PRIMARY KEY(account_id,message_key,part_id,ref_id,extractor),
 FOREIGN KEY(account_id,message_key) REFERENCES mail_messages(account_id,message_key),
 FOREIGN KEY(account_id,ref_id) REFERENCES mail_content_refs(account_id,id),
 CHECK((state='running' AND lease_token IS NOT NULL AND lease_until IS NOT NULL) OR (state!='running' AND lease_token IS NULL AND lease_until IS NULL)),
 CHECK((state='complete' AND result_json IS NOT NULL AND error IS NULL) OR (state!='complete' AND result_json IS NULL))
);
CREATE INDEX mail_attachment_extractions_queue ON mail_attachment_extractions(state,account_id,message_key);
INSERT INTO mail_attachment_extractions(account_id,message_key,part_id,ref_id,extractor,state)
 SELECT account_id,message_key,part_id,ref_id,'local-text-v1','queued' FROM mail_content_manifests WHERE kind='attachment' AND state='stored' AND ref_id IS NOT NULL;
CREATE TRIGGER mail_extraction_manifest_insert AFTER INSERT ON mail_content_manifests WHEN NEW.kind='attachment' AND NEW.state='stored' AND NEW.ref_id IS NOT NULL BEGIN
 INSERT OR IGNORE INTO mail_attachment_extractions(account_id,message_key,part_id,ref_id,extractor,state) VALUES(NEW.account_id,NEW.message_key,NEW.part_id,NEW.ref_id,'local-text-v1','queued');
END;
CREATE TRIGGER mail_extraction_manifest_update AFTER UPDATE ON mail_content_manifests WHEN NEW.kind='attachment' AND NEW.state='stored' AND NEW.ref_id IS NOT NULL BEGIN
 INSERT OR IGNORE INTO mail_attachment_extractions(account_id,message_key,part_id,ref_id,extractor,state) VALUES(NEW.account_id,NEW.message_key,NEW.part_id,NEW.ref_id,'local-text-v1','queued');
END;
CREATE TRIGGER mail_extraction_changed AFTER UPDATE ON mail_attachment_extractions BEGIN
 INSERT OR IGNORE INTO mail_search_dirty VALUES(NEW.account_id,NEW.message_key);
 INSERT INTO mail_local_events SELECT NEW.account_id,coalesce(max(sequence),0)+1,'message.changed',NEW.message_key,NULL,NULL,NULL FROM mail_local_events WHERE account_id=NEW.account_id;
END;
`;

/** An outer manifest UPSERT overrides trigger OR IGNORE; explicit UPSERT keeps
 * already extracted or failed same-reference work intact during provider replay. */
export const EXTRACTION_REPLAY_SCHEMA_SQL = `
DROP TRIGGER mail_extraction_manifest_insert;
DROP TRIGGER mail_extraction_manifest_update;
CREATE TRIGGER mail_extraction_manifest_insert AFTER INSERT ON mail_content_manifests WHEN NEW.kind='attachment' AND NEW.state='stored' AND NEW.ref_id IS NOT NULL BEGIN
 INSERT INTO mail_attachment_extractions(account_id,message_key,part_id,ref_id,extractor,state) VALUES(NEW.account_id,NEW.message_key,NEW.part_id,NEW.ref_id,'local-text-v1','queued') ON CONFLICT(account_id,message_key,part_id,ref_id,extractor) DO NOTHING;
END;
CREATE TRIGGER mail_extraction_manifest_update AFTER UPDATE ON mail_content_manifests WHEN NEW.kind='attachment' AND NEW.state='stored' AND NEW.ref_id IS NOT NULL BEGIN
 INSERT INTO mail_attachment_extractions(account_id,message_key,part_id,ref_id,extractor,state) VALUES(NEW.account_id,NEW.message_key,NEW.part_id,NEW.ref_id,'local-text-v1','queued') ON CONFLICT(account_id,message_key,part_id,ref_id,extractor) DO NOTHING;
END;
`;
