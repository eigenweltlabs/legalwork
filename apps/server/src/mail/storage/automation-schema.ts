import type { MailDatabase } from './database-interface.js';

/** Proposed v33 tables. Deliberately NOT registered in migrateMailSchema. */
export const MAIL_AUTOMATION_SCHEMA_SQL = `
CREATE TABLE mail_outbox_schedules (
  account_id TEXT NOT NULL,
  action_id TEXT NOT NULL,
  scheduled_at INTEGER NOT NULL CHECK(scheduled_at >= 0),
  time_zone TEXT NOT NULL,
  PRIMARY KEY(account_id, action_id),
  FOREIGN KEY(account_id, action_id) REFERENCES mail_outbox(account_id, action_id) ON DELETE CASCADE
);
CREATE TABLE mail_snoozes (
  account_id TEXT NOT NULL,
  message_key TEXT NOT NULL,
  until_at INTEGER NOT NULL CHECK(until_at >= 0),
  time_zone TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK(revision > 0),
  PRIMARY KEY(account_id, message_key),
  FOREIGN KEY(account_id, message_key) REFERENCES mail_messages(account_id, message_key) ON DELETE CASCADE
);
CREATE INDEX mail_snooze_due ON mail_snoozes(until_at);
CREATE TABLE mail_local_rules (
  account_id TEXT NOT NULL,
  id TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK(revision > 0),
  created_at INTEGER NOT NULL,
  activated_at INTEGER NOT NULL,
  after_sequence INTEGER NOT NULL CHECK(after_sequence >= 0),
  credential_generation TEXT NOT NULL,
  definition_json TEXT NOT NULL CHECK(json_valid(definition_json)),
  PRIMARY KEY(account_id, id),
  FOREIGN KEY(account_id) REFERENCES mail_accounts(id) ON DELETE CASCADE
);
CREATE TABLE mail_rule_accounts (
  account_id TEXT PRIMARY KEY,
  event_generation TEXT NOT NULL,
  credential_generation TEXT NOT NULL,
  after_sequence INTEGER NOT NULL CHECK(after_sequence >= 0),
  ready_at INTEGER,
  FOREIGN KEY(account_id) REFERENCES mail_accounts(id) ON DELETE CASCADE
);
CREATE TABLE mail_rule_claims (
  account_id TEXT NOT NULL,
  message_key TEXT NOT NULL,
  rule_id TEXT NOT NULL,
  rule_name TEXT NOT NULL,
  subject TEXT NOT NULL,
  applied_at INTEGER NOT NULL,
  action_id TEXT,
  outcome TEXT NOT NULL CHECK(outcome IN ('queued', 'snoozed', 'unavailable')),
  PRIMARY KEY(account_id, message_key),
  FOREIGN KEY(account_id, message_key) REFERENCES mail_messages(account_id, message_key) ON DELETE CASCADE
);
CREATE INDEX mail_rule_activity ON mail_rule_claims(account_id, applied_at DESC);
CREATE TRIGGER mail_snooze_insert AFTER INSERT ON mail_snoozes BEGIN
  INSERT INTO mail_local_events
    SELECT NEW.account_id, coalesce(max(sequence), 0) + 1, 'message.changed', NEW.message_key, NULL, NULL, NULL
    FROM mail_local_events WHERE account_id = NEW.account_id;
END;
CREATE TRIGGER mail_snooze_update AFTER UPDATE ON mail_snoozes BEGIN
  INSERT INTO mail_local_events
    SELECT NEW.account_id, coalesce(max(sequence), 0) + 1, 'message.changed', NEW.message_key, NULL, NULL, NULL
    FROM mail_local_events WHERE account_id = NEW.account_id;
END;
CREATE TRIGGER mail_snooze_delete AFTER DELETE ON mail_snoozes BEGIN
  INSERT INTO mail_local_events
    SELECT OLD.account_id, coalesce(max(sequence), 0) + 1, 'message.changed', OLD.message_key, NULL, NULL, NULL
    FROM mail_local_events WHERE account_id = OLD.account_id;
END;
`;

/** Prototype/testing entry point only. It does not advance the production schema version. */
export function installMailAutomationPrototype(database: MailDatabase): void {
  database.transaction(() => database.exec(MAIL_AUTOMATION_SCHEMA_SQL));
}
