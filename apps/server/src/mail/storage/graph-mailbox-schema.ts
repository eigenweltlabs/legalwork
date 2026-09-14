export const GRAPH_MAILBOX_SCHEMA_SQL = `
CREATE TABLE mail_graph_mailboxes (
 account_id TEXT PRIMARY KEY REFERENCES mail_accounts(id),
 credential_account_id TEXT NOT NULL REFERENCES mail_accounts(id),
 mailbox_address TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('shared','delegated')),
 state TEXT NOT NULL CHECK(state IN ('connected','revoked','disconnected')),
 generation TEXT NOT NULL, revision INTEGER NOT NULL CHECK(revision>0),
 write_confirmed INTEGER NOT NULL CHECK(write_confirmed IN (0,1)),
 send_mode TEXT NOT NULL CHECK(send_mode IN ('none','send_as','send_on_behalf')),
 UNIQUE(credential_account_id,mailbox_address), CHECK(account_id<>credential_account_id)
);
CREATE INDEX mail_graph_mailbox_parent ON mail_graph_mailboxes(credential_account_id);
CREATE VIEW mail_account_access AS
 SELECT account_id,state,archive_locked,generation,revision FROM mail_account_credentials
 UNION ALL SELECT s.account_id,CASE WHEN s.state='connected' AND c.state='connected' AND c.archive_locked=0 AND EXISTS(SELECT 1 FROM json_each(c.granted_scopes_json) WHERE value IN ('Mail.Read.Shared','Mail.ReadWrite.Shared','https://graph.microsoft.com/Mail.Read.Shared','https://graph.microsoft.com/Mail.ReadWrite.Shared')) THEN 'connected' ELSE 'disconnected' END,
 CASE WHEN s.state='connected' AND c.state='connected' AND c.archive_locked=0 AND EXISTS(SELECT 1 FROM json_each(c.granted_scopes_json) WHERE value IN ('Mail.Read.Shared','Mail.ReadWrite.Shared','https://graph.microsoft.com/Mail.Read.Shared','https://graph.microsoft.com/Mail.ReadWrite.Shared')) THEN 0 ELSE 1 END,s.generation,s.revision
 FROM mail_graph_mailboxes s LEFT JOIN mail_account_credentials c ON c.account_id=s.credential_account_id;

`;
