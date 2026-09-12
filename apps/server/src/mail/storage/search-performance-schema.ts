/** Compact candidate and coverage indexes; original text remains the exact-match authority. */
export const SEARCH_PERFORMANCE_SCHEMA_SQL = `
 CREATE INDEX mail_search_embedded_nul ON mail_search_documents(id) WHERE instr(normalized_text,char(0))>0;
 CREATE INDEX mail_search_identity ON mail_search_documents(id,account_id,message_key,date,has_attachment);
 CREATE INDEX mail_search_incomplete ON mail_search_documents(account_id,incomplete,message_key);
 CREATE INDEX mail_search_date ON mail_search_documents(date DESC,account_id,message_key);
 CREATE VIRTUAL TABLE mail_search_trigram USING fts5(normalized_text,content='mail_search_documents',content_rowid='id',tokenize='trigram case_sensitive 1',detail='none');
 CREATE TRIGGER mail_search_trigram_insert AFTER INSERT ON mail_search_documents BEGIN
  INSERT INTO mail_search_trigram(rowid,normalized_text) VALUES(new.id,new.normalized_text);
 END;
 CREATE TRIGGER mail_search_trigram_delete AFTER DELETE ON mail_search_documents BEGIN
  INSERT INTO mail_search_trigram(mail_search_trigram,rowid,normalized_text) VALUES('delete',old.id,old.normalized_text);
 END;
 INSERT INTO mail_search_trigram(mail_search_trigram) VALUES('rebuild');
`;
