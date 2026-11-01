export const MAIL_RULES_SQL = `
CREATE TABLE mail_local_rules (
  account_id TEXT NOT NULL REFERENCES mail_accounts(id) ON DELETE CASCADE,
  id TEXT NOT NULL, generation TEXT NOT NULL, revision INTEGER NOT NULL CHECK(revision > 0),
  definition_json TEXT NOT NULL CHECK(json_valid(definition_json)),
  credential_generation TEXT, activated_at INTEGER NOT NULL, after_arrival INTEGER NOT NULL,
  deleted INTEGER NOT NULL DEFAULT 0 CHECK(deleted IN (0,1)),
  PRIMARY KEY(account_id,id)
);
CREATE TABLE mail_rule_arrivals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id TEXT NOT NULL REFERENCES mail_accounts(id) ON DELETE CASCADE,
  message_key TEXT NOT NULL, credential_generation TEXT NOT NULL,
  observed_at INTEGER NOT NULL, available_at INTEGER NOT NULL,
  state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','done')),
  rule_name TEXT, action TEXT, outcome TEXT, action_id TEXT,
  UNIQUE(account_id,message_key),
  FOREIGN KEY(account_id,action_id) REFERENCES mail_action_jobs(account_id,id)
);
CREATE INDEX mail_rule_pending ON mail_rule_arrivals(state,available_at,id);
CREATE INDEX mail_rule_activity ON mail_rule_arrivals(account_id,id);
ALTER TABLE mail_imap_folders ADD COLUMN rules_uid_floor INTEGER;
ALTER TABLE mail_imap_folders ADD COLUMN rules_uid_validity INTEGER;
`;
