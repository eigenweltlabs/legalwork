/** Schema27: encrypted, explicitly granted agent scope and immutable approval evidence. */
export const MAIL_AGENT_SCHEMA_SQL=`
CREATE TABLE mail_agent_grants (
 id TEXT PRIMARY KEY,account_id TEXT NOT NULL REFERENCES mail_accounts(id),token_hash TEXT NOT NULL UNIQUE,
 workspace_id TEXT NOT NULL,directory TEXT NOT NULL,matter_id TEXT,permissions_json TEXT NOT NULL,
 credential_generation TEXT NOT NULL,state TEXT NOT NULL CHECK(state IN ('active','revoked')),
 created_at INTEGER NOT NULL,expires_at INTEGER NOT NULL,revision INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE mail_agent_drafts (
 account_id TEXT NOT NULL,grant_id TEXT NOT NULL REFERENCES mail_agent_grants(id),draft_id TEXT NOT NULL,
 source_json TEXT,source_version TEXT,PRIMARY KEY(grant_id,draft_id),
 FOREIGN KEY(account_id,draft_id) REFERENCES mail_local_drafts(account_id,id)
);
CREATE TABLE mail_agent_proposals (
 id TEXT PRIMARY KEY,account_id TEXT NOT NULL REFERENCES mail_accounts(id),grant_id TEXT NOT NULL REFERENCES mail_agent_grants(id),
 grant_revision INTEGER NOT NULL,kind TEXT NOT NULL CHECK(kind IN ('send','trash')),payload_json TEXT NOT NULL,
 session_id TEXT NOT NULL,message_id TEXT NOT NULL,created_at INTEGER NOT NULL,expires_at INTEGER NOT NULL,
 state TEXT NOT NULL CHECK(state IN ('pending','approved','rejected','revoked')),action_id TEXT
);
`;
