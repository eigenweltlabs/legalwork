export const MAIL_CLASSIFIER_ARRIVALS_SQL = `
ALTER TABLE mail_project_classifiers ADD COLUMN credential_generation TEXT;
ALTER TABLE mail_project_classifiers ADD COLUMN activated_at INTEGER NOT NULL DEFAULT 0;
ALTER TABLE mail_project_associations ADD COLUMN source TEXT NOT NULL DEFAULT 'manual' CHECK(source IN ('manual','automatic'));
ALTER TABLE mail_project_associations ADD COLUMN decision_id INTEGER CHECK((source='manual' AND decision_id IS NULL) OR (source='automatic' AND decision_id IS NOT NULL AND decision_id > 0));
ALTER TABLE mail_project_changes ADD COLUMN source TEXT NOT NULL DEFAULT 'manual' CHECK(source IN ('manual','automatic'));
ALTER TABLE mail_project_changes ADD COLUMN evidence_json TEXT CHECK((source='manual' AND evidence_json IS NULL) OR (source='automatic' AND evidence_json IS NOT NULL AND json_valid(evidence_json)));
CREATE TABLE mail_project_arrivals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id TEXT NOT NULL REFERENCES mail_accounts(id) ON DELETE CASCADE,
  message_key TEXT NOT NULL, generation TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1 CHECK(revision > 0 AND revision <= 9007199254740991),
  config_generation TEXT NOT NULL, config_revision INTEGER NOT NULL, credential_generation TEXT NOT NULL,
  observed_at INTEGER NOT NULL, available_at INTEGER NOT NULL,
  state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','review','assigned','dismissed','undone','skipped')),
  outcome TEXT, project_id TEXT, project_binding TEXT,
  CHECK((project_id IS NULL AND project_binding IS NULL) OR (project_id IS NOT NULL AND project_binding IS NOT NULL AND length(project_binding)=64 AND project_binding NOT GLOB '*[^0-9a-f]*')),
  UNIQUE(account_id,message_key)
);
CREATE INDEX mail_project_arrival_pending ON mail_project_arrivals(state,available_at,id);
CREATE INDEX mail_project_arrival_activity ON mail_project_arrivals(account_id,id);
CREATE TRIGGER mail_project_arrival_purge AFTER DELETE ON mail_messages BEGIN
  DELETE FROM mail_project_arrivals WHERE account_id=OLD.account_id AND message_key=OLD.message_key;
END;
`;
