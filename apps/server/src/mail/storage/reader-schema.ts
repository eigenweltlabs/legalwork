/** EIG-139: schema v13, following the IMAP migration. */
export const MAIL_READER_SCHEMA_SQL = `
  ALTER TABLE mail_folders ADD COLUMN role TEXT CHECK(role IS NULL OR role='inbox');
  UPDATE mail_folders SET role='inbox' WHERE
    (id='INBOX' AND account_id IN (SELECT id FROM mail_accounts WHERE provider='gmail')) OR
    (lower(id)='inbox' AND account_id IN (SELECT id FROM mail_accounts WHERE provider='imap'));
  UPDATE mail_folders SET role='inbox' WHERE EXISTS(SELECT 1 FROM mail_imap_folders f WHERE f.account_id=mail_folders.account_id AND f.path=mail_folders.id AND (lower(f.path)='inbox' OR f.special_use='\\Inbox'));
  CREATE INDEX mail_folder_role ON mail_folders(account_id,role,id);
  CREATE TRIGGER mail_known_inbox AFTER INSERT ON mail_folders WHEN
    (NEW.id='INBOX' AND EXISTS(SELECT 1 FROM mail_accounts WHERE id=NEW.account_id AND provider='gmail')) OR
    (lower(NEW.id)='inbox' AND EXISTS(SELECT 1 FROM mail_accounts WHERE id=NEW.account_id AND provider='imap'))
  BEGIN UPDATE mail_folders SET role='inbox' WHERE account_id=NEW.account_id AND id=NEW.id; END;
`;
