export const SAVED_SEARCH_SCHEMA_SQL = `
CREATE TABLE mail_saved_searches(owner_id TEXT NOT NULL,id TEXT NOT NULL,name TEXT NOT NULL,revision INTEGER NOT NULL CHECK(revision BETWEEN 1 AND 9007199254740991),query_json TEXT NOT NULL CHECK(json_valid(query_json)),PRIMARY KEY(owner_id,id));
`;
