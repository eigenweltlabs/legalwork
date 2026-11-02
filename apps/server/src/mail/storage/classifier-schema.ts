export const MAIL_CLASSIFIER_SQL = `
CREATE TABLE mail_project_classifiers (
  account_id TEXT PRIMARY KEY REFERENCES mail_accounts(id) ON DELETE CASCADE,
  generation TEXT NOT NULL, revision INTEGER NOT NULL CHECK(revision > 0 AND revision <= 9007199254740991),
  definition_json TEXT NOT NULL CHECK(json_valid(definition_json)),
  updated_at INTEGER NOT NULL CHECK(updated_at >= 0)
);
`;
