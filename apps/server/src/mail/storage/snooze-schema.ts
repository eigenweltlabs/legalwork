export const MAIL_SNOOZE_SQL = `
CREATE TABLE mail_snoozes (
  account_id TEXT NOT NULL,
  scope_key TEXT NOT NULL,
  anchor_key TEXT NOT NULL,
  thread_id TEXT,
  generation TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK(revision > 0),
  until_at INTEGER,
  time_zone TEXT,
  woke_at INTEGER CHECK(woke_at IS NULL OR woke_at >= 0),
  PRIMARY KEY(account_id, scope_key),
  FOREIGN KEY(account_id, anchor_key) REFERENCES mail_messages(account_id, message_key) ON DELETE CASCADE,
  CHECK((until_at IS NULL AND time_zone IS NULL) OR (until_at >= 0 AND time_zone IS NOT NULL))
);
CREATE INDEX mail_snooze_due ON mail_snoozes(until_at, account_id);
CREATE TABLE mail_snooze_members (
  account_id TEXT NOT NULL,
  message_key TEXT NOT NULL,
  scope_key TEXT NOT NULL,
  PRIMARY KEY(account_id, message_key),
  FOREIGN KEY(account_id, message_key) REFERENCES mail_messages(account_id, message_key) ON DELETE CASCADE,
  FOREIGN KEY(account_id, scope_key) REFERENCES mail_snoozes(account_id, scope_key) ON DELETE CASCADE
);
CREATE INDEX mail_snooze_scope ON mail_snooze_members(account_id, scope_key);
CREATE TRIGGER mail_snooze_member_insert AFTER INSERT ON mail_snooze_members BEGIN
  INSERT INTO mail_local_events SELECT NEW.account_id,coalesce(max(sequence),0)+1,'message.changed',NEW.message_key,NULL,NULL,NULL FROM mail_local_events WHERE account_id=NEW.account_id;
END;
CREATE TRIGGER mail_snooze_member_delete AFTER DELETE ON mail_snooze_members BEGIN
  INSERT INTO mail_local_events SELECT OLD.account_id,coalesce(max(sequence),0)+1,'message.changed',OLD.message_key,NULL,NULL,NULL FROM mail_local_events WHERE account_id=OLD.account_id;
END;
`;
