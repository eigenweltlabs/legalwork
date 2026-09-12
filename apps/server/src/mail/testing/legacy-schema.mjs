/** Test fixtures only: remove later additions before reconstructing an older
 * database. Keep production migrations additive; never call this on user data. */
export function removeLaterMailSchema(db, version) {
  if(version<28)db.exec('DROP INDEX IF EXISTS mail_sync_scope_job_lookup');
  if(version<27)db.exec('DROP TABLE IF EXISTS mail_agent_proposals; DROP TABLE IF EXISTS mail_agent_drafts; DROP TABLE IF EXISTS mail_agent_grants');
  if(version<26)db.exec('DROP TABLE IF EXISTS mail_storage_save_parts; DROP TABLE IF EXISTS mail_storage_saves');
  if(version<25)db.exec('DROP TABLE IF EXISTS mail_recovery_quarantine; DROP TABLE IF EXISTS mail_retention_settings');
  if(version<24)db.exec('DROP TABLE IF EXISTS mail_matter_filings; DROP TABLE IF EXISTS mail_filing_parts; DROP TABLE IF EXISTS mail_filing_snapshots');
  if(version<23)db.exec('DROP TRIGGER IF EXISTS mail_archive_smtp_insert; DROP TRIGGER IF EXISTS mail_archive_smtp_update; DROP TRIGGER IF EXISTS mail_archive_credentials_update; DROP TRIGGER IF EXISTS mail_archive_actions_update; DROP TRIGGER IF EXISTS mail_archive_credentials_insert; DROP TRIGGER IF EXISTS mail_archive_actions_insert; DROP TABLE IF EXISTS mail_portability_folders; DROP TABLE IF EXISTS mail_portability_entries; DROP TABLE IF EXISTS mail_archive_messages; DROP TABLE IF EXISTS mail_portability_jobs');
  if(version<22)db.exec('DROP TABLE IF EXISTS mail_notification_claims; DROP TABLE IF EXISTS mail_notification_accounts');
  if (version < 21) db.exec('DROP TABLE IF EXISTS mail_outbox_attempts; DROP TABLE IF EXISTS mail_outbox; DROP TABLE IF EXISTS mail_smtp_credentials');
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
