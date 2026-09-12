/** Test fixtures only: remove later additions before reconstructing an older
 * database. Keep production migrations additive; never call this on user data. */
export function removeLaterMailSchema(db, version) {
  if (version < 20) db.exec('DROP TABLE IF EXISTS mail_sender_identities');
  if (version < 19) db.exec(`
    DROP TRIGGER IF EXISTS mail_search_trigram_insert;
    DROP TRIGGER IF EXISTS mail_search_trigram_delete;
    DROP TABLE IF EXISTS mail_search_trigram;
    DROP INDEX IF EXISTS mail_search_embedded_nul;
    DROP INDEX IF EXISTS mail_search_identity;
    DROP INDEX IF EXISTS mail_search_incomplete;
    DROP INDEX IF EXISTS mail_search_date;
  `);
  if (version < 18) db.exec('DROP TABLE IF EXISTS mail_draft_sync');
  if (version < 15) db.exec('DROP TABLE IF EXISTS mail_imap_action_results');
}
