import type { MailDatabase } from "./database-interface.js";
/** Additive v10: local drafts never replace provider originals or legacy draft rows. */
export const MAIL_LOCAL_SCHEMA_SQL=`
CREATE TABLE mail_local_drafts (
 account_id TEXT NOT NULL,id TEXT NOT NULL,generation TEXT NOT NULL,
 revision INTEGER NOT NULL CHECK(revision BETWEEN 1 AND 9007199254740991),
 updated_at INTEGER NOT NULL CHECK(updated_at BETWEEN 0 AND 9007199254740991),deleted INTEGER NOT NULL CHECK(deleted IN (0,1)),
 PRIMARY KEY(account_id,id),FOREIGN KEY(account_id) REFERENCES mail_accounts(id) ON DELETE CASCADE
);
CREATE TABLE mail_local_draft_versions (
 account_id TEXT NOT NULL,draft_id TEXT NOT NULL,generation TEXT NOT NULL,revision INTEGER NOT NULL CHECK(revision BETWEEN 1 AND 9007199254740991),updated_at INTEGER NOT NULL CHECK(updated_at BETWEEN 0 AND 9007199254740991),content_json TEXT NOT NULL,
 PRIMARY KEY(account_id,draft_id,generation,revision),FOREIGN KEY(account_id,draft_id) REFERENCES mail_local_drafts(account_id,id)
);
CREATE TABLE mail_local_draft_parts (
 account_id TEXT NOT NULL,draft_id TEXT NOT NULL,generation TEXT NOT NULL,revision INTEGER NOT NULL,ordinal INTEGER NOT NULL CHECK(ordinal BETWEEN 0 AND 19),ref_id TEXT NOT NULL,
 PRIMARY KEY(account_id,draft_id,generation,revision,ordinal),
 FOREIGN KEY(account_id,draft_id,generation,revision) REFERENCES mail_local_draft_versions(account_id,draft_id,generation,revision),
 FOREIGN KEY(account_id,ref_id) REFERENCES mail_content_refs(account_id,id)
);
CREATE TABLE mail_local_action_drafts (
 account_id TEXT NOT NULL,action_id TEXT NOT NULL,draft_id TEXT NOT NULL,generation TEXT NOT NULL,revision INTEGER NOT NULL,
 PRIMARY KEY(account_id,action_id),FOREIGN KEY(account_id,action_id) REFERENCES mail_action_jobs(account_id,id),
 FOREIGN KEY(account_id,draft_id,generation,revision) REFERENCES mail_local_draft_versions(account_id,draft_id,generation,revision)
);
CREATE TABLE mail_local_event_streams(account_id TEXT PRIMARY KEY,generation TEXT NOT NULL,FOREIGN KEY(account_id) REFERENCES mail_accounts(id) ON DELETE CASCADE);
INSERT INTO mail_local_event_streams SELECT id,lower(hex(randomblob(16))) FROM mail_accounts;
CREATE TRIGGER mail_local_account_insert AFTER INSERT ON mail_accounts BEGIN
 INSERT INTO mail_local_event_streams VALUES(NEW.id,lower(hex(randomblob(16))));
END;
CREATE TABLE mail_local_events (
 account_id TEXT NOT NULL,sequence INTEGER NOT NULL CHECK(sequence BETWEEN 1 AND 9007199254740991),
 kind TEXT NOT NULL CHECK(kind IN ('draft.saved','draft.deleted','action.changed','message.changed')),
 entity_id TEXT NOT NULL,state TEXT,generation TEXT,revision INTEGER,
 PRIMARY KEY(account_id,sequence),FOREIGN KEY(account_id) REFERENCES mail_accounts(id) ON DELETE CASCADE
);
CREATE TRIGGER mail_local_draft_insert AFTER INSERT ON mail_local_drafts BEGIN
 INSERT INTO mail_local_events SELECT NEW.account_id,coalesce(max(sequence),0)+1,'draft.saved',NEW.id,'active',NEW.generation,NEW.revision FROM mail_local_events WHERE account_id=NEW.account_id;
END;
CREATE TRIGGER mail_local_draft_update AFTER UPDATE ON mail_local_drafts BEGIN
 INSERT INTO mail_local_events SELECT NEW.account_id,coalesce(max(sequence),0)+1,CASE WHEN NEW.deleted=1 THEN 'draft.deleted' ELSE 'draft.saved' END,NEW.id,CASE WHEN NEW.deleted=1 THEN 'deleted' ELSE 'active' END,NEW.generation,NEW.revision FROM mail_local_events WHERE account_id=NEW.account_id;
END;
CREATE TRIGGER mail_local_action_insert AFTER INSERT ON mail_action_jobs BEGIN
 INSERT INTO mail_local_events SELECT NEW.account_id,coalesce(max(sequence),0)+1,'action.changed',NEW.id,NEW.state,NEW.generation,NEW.revision FROM mail_local_events WHERE account_id=NEW.account_id;
END;
CREATE TRIGGER mail_local_action_update AFTER UPDATE ON mail_action_jobs BEGIN
 INSERT INTO mail_local_events SELECT NEW.account_id,coalesce(max(sequence),0)+1,'action.changed',NEW.id,NEW.state,NEW.generation,NEW.revision FROM mail_local_events WHERE account_id=NEW.account_id;
END;
CREATE TRIGGER mail_local_message_insert AFTER INSERT ON mail_messages BEGIN
 INSERT INTO mail_local_events SELECT NEW.account_id,coalesce(max(sequence),0)+1,'message.changed',NEW.message_key,NULL,NULL,NULL FROM mail_local_events WHERE account_id=NEW.account_id;
END;
CREATE TRIGGER mail_local_message_update AFTER UPDATE ON mail_messages BEGIN
 INSERT INTO mail_local_events SELECT NEW.account_id,coalesce(max(sequence),0)+1,'message.changed',NEW.message_key,NULL,NULL,NULL FROM mail_local_events WHERE account_id=NEW.account_id;
END;
CREATE TRIGGER mail_local_memberships_insert AFTER INSERT ON mail_memberships BEGIN
 INSERT INTO mail_local_events SELECT NEW.account_id,coalesce(max(sequence),0)+1,'message.changed',NEW.message_key,NULL,NULL,NULL FROM mail_local_events WHERE account_id=NEW.account_id;
END;
CREATE TRIGGER mail_local_memberships_update AFTER UPDATE ON mail_memberships BEGIN
 INSERT INTO mail_local_events SELECT NEW.account_id,coalesce(max(sequence),0)+1,'message.changed',NEW.message_key,NULL,NULL,NULL FROM mail_local_events WHERE account_id=NEW.account_id;
END;
CREATE TRIGGER mail_local_memberships_delete AFTER DELETE ON mail_memberships BEGIN
 INSERT INTO mail_local_events SELECT OLD.account_id,coalesce(max(sequence),0)+1,'message.changed',OLD.message_key,NULL,NULL,NULL FROM mail_local_events WHERE account_id=OLD.account_id;
END;
CREATE TRIGGER mail_local_content_manifests_insert AFTER INSERT ON mail_content_manifests BEGIN
 INSERT INTO mail_local_events SELECT NEW.account_id,coalesce(max(sequence),0)+1,'message.changed',NEW.message_key,NULL,NULL,NULL FROM mail_local_events WHERE account_id=NEW.account_id;
END;
CREATE TRIGGER mail_local_content_manifests_update AFTER UPDATE ON mail_content_manifests BEGIN
 INSERT INTO mail_local_events SELECT NEW.account_id,coalesce(max(sequence),0)+1,'message.changed',NEW.message_key,NULL,NULL,NULL FROM mail_local_events WHERE account_id=NEW.account_id;
END;
CREATE TRIGGER mail_local_content_manifests_delete AFTER DELETE ON mail_content_manifests BEGIN
 INSERT INTO mail_local_events SELECT OLD.account_id,coalesce(max(sequence),0)+1,'message.changed',OLD.message_key,NULL,NULL,NULL FROM mail_local_events WHERE account_id=OLD.account_id;
END;
CREATE TRIGGER mail_local_mime_projections_insert AFTER INSERT ON mail_mime_projections BEGIN
 INSERT INTO mail_local_events SELECT NEW.account_id,coalesce(max(sequence),0)+1,'message.changed',NEW.message_key,NULL,NULL,NULL FROM mail_local_events WHERE account_id=NEW.account_id;
END;
CREATE TRIGGER mail_local_mime_projections_update AFTER UPDATE ON mail_mime_projections BEGIN
 INSERT INTO mail_local_events SELECT NEW.account_id,coalesce(max(sequence),0)+1,'message.changed',NEW.message_key,NULL,NULL,NULL FROM mail_local_events WHERE account_id=NEW.account_id;
END;
CREATE TRIGGER mail_local_mime_projections_delete AFTER DELETE ON mail_mime_projections BEGIN
 INSERT INTO mail_local_events SELECT OLD.account_id,coalesce(max(sequence),0)+1,'message.changed',OLD.message_key,NULL,NULL,NULL FROM mail_local_events WHERE account_id=OLD.account_id;
END;
CREATE TRIGGER mail_local_tombstones_insert AFTER INSERT ON mail_tombstones BEGIN
 INSERT INTO mail_local_events SELECT NEW.account_id,coalesce(max(sequence),0)+1,'message.changed',NEW.message_key,NULL,NULL,NULL FROM mail_local_events WHERE account_id=NEW.account_id;
END;
CREATE TRIGGER mail_local_tombstones_update AFTER UPDATE ON mail_tombstones BEGIN
 INSERT INTO mail_local_events SELECT NEW.account_id,coalesce(max(sequence),0)+1,'message.changed',NEW.message_key,NULL,NULL,NULL FROM mail_local_events WHERE account_id=NEW.account_id;
END;
CREATE TRIGGER mail_local_tombstones_delete AFTER DELETE ON mail_tombstones BEGIN
 INSERT INTO mail_local_events SELECT OLD.account_id,coalesce(max(sequence),0)+1,'message.changed',OLD.message_key,NULL,NULL,NULL FROM mail_local_events WHERE account_id=OLD.account_id;
END;
CREATE TRIGGER mail_local_gmail_presence_insert AFTER INSERT ON mail_gmail_presence BEGIN
 INSERT INTO mail_local_events SELECT NEW.account_id,coalesce(max(sequence),0)+1,'message.changed',NEW.message_key,NULL,NULL,NULL FROM mail_local_events WHERE account_id=NEW.account_id;
END;
CREATE TRIGGER mail_local_gmail_presence_update AFTER UPDATE ON mail_gmail_presence WHEN OLD.remote_present IS NOT NEW.remote_present BEGIN
 INSERT INTO mail_local_events SELECT NEW.account_id,coalesce(max(sequence),0)+1,'message.changed',NEW.message_key,NULL,NULL,NULL FROM mail_local_events WHERE account_id=NEW.account_id;
END;
CREATE TRIGGER mail_local_gmail_presence_delete AFTER DELETE ON mail_gmail_presence BEGIN
 INSERT INTO mail_local_events SELECT OLD.account_id,coalesce(max(sequence),0)+1,'message.changed',OLD.message_key,NULL,NULL,NULL FROM mail_local_events WHERE account_id=OLD.account_id;
END;
CREATE TRIGGER mail_local_graph_messages_insert AFTER INSERT ON mail_graph_messages BEGIN
 INSERT INTO mail_local_events SELECT NEW.account_id,coalesce(max(sequence),0)+1,'message.changed',NEW.message_key,NULL,NULL,NULL FROM mail_local_events WHERE account_id=NEW.account_id;
END;
CREATE TRIGGER mail_local_graph_messages_update AFTER UPDATE ON mail_graph_messages BEGIN
 INSERT INTO mail_local_events SELECT NEW.account_id,coalesce(max(sequence),0)+1,'message.changed',NEW.message_key,NULL,NULL,NULL FROM mail_local_events WHERE account_id=NEW.account_id;
END;
CREATE TRIGGER mail_local_graph_messages_delete AFTER DELETE ON mail_graph_messages BEGIN
 INSERT INTO mail_local_events SELECT OLD.account_id,coalesce(max(sequence),0)+1,'message.changed',OLD.message_key,NULL,NULL,NULL FROM mail_local_events WHERE account_id=OLD.account_id;
END;
`;

/** Trusted restore transaction only: restored sequence numbers cannot reuse a prior stream cursor. */
export function resetMailLocalEventStreams(database:MailDatabase):void{database.run("UPDATE mail_local_event_streams SET generation=lower(hex(randomblob(16)))");}
