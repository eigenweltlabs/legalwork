export const MAIL_PROJECT_ASSOCIATION_SQL = `
CREATE TABLE mail_project_associations (
  account_id TEXT NOT NULL, message_key TEXT NOT NULL,
  generation TEXT NOT NULL, revision INTEGER NOT NULL CHECK(revision > 0),
  project_id TEXT, project_binding TEXT, updated_at INTEGER NOT NULL CHECK(updated_at >= 0),
  PRIMARY KEY(account_id,message_key),
  CHECK((project_id IS NULL AND project_binding IS NULL) OR (project_id IS NOT NULL AND project_binding IS NOT NULL AND length(project_binding)=64 AND project_binding NOT GLOB '*[^0-9a-f]*')),
  FOREIGN KEY(account_id,message_key) REFERENCES mail_messages(account_id,message_key) ON DELETE CASCADE
);
CREATE INDEX mail_project_association_project ON mail_project_associations(account_id,project_id,project_binding);
CREATE TABLE mail_project_changes (
  account_id TEXT NOT NULL, message_key TEXT NOT NULL,
  generation TEXT NOT NULL, revision INTEGER NOT NULL CHECK(revision > 0),
  project_id TEXT, project_binding TEXT, changed_at INTEGER NOT NULL CHECK(changed_at >= 0),
  PRIMARY KEY(account_id,message_key,revision),
  CHECK((project_id IS NULL AND project_binding IS NULL) OR (project_id IS NOT NULL AND project_binding IS NOT NULL AND length(project_binding)=64 AND project_binding NOT GLOB '*[^0-9a-f]*')),
  FOREIGN KEY(account_id,message_key) REFERENCES mail_project_associations(account_id,message_key) ON DELETE CASCADE
);
`;
