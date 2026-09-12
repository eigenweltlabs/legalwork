import {randomUUID} from 'node:crypto';
import type {MailDatabase} from './database-interface.js';
/** Trusted offline restore fence. Evidence remains immutable; old work never gains fresh authority. */
export function quarantineRestoredMail(db:MailDatabase){
 const at=Date.now();
 db.run("INSERT OR IGNORE INTO mail_recovery_quarantine SELECT account_id,'submission',id,? FROM mail_action_jobs WHERE kind='submission'",[at]);
 db.run("INSERT OR IGNORE INTO mail_recovery_quarantine SELECT account_id,'draft',draft_id,? FROM mail_draft_sync",[at]);
 db.run("INSERT OR IGNORE INTO mail_recovery_quarantine SELECT account_id,'portability',id,? FROM mail_portability_jobs",[at]);
 db.run("INSERT OR IGNORE INTO mail_recovery_quarantine SELECT s.account_id,'filing',f.id,? FROM mail_matter_filings f JOIN mail_filing_snapshots s ON s.id=f.snapshot_id",[at]);
 db.run('DELETE FROM mail_smtp_credentials');
 db.run("UPDATE mail_graph_mailboxes SET state='disconnected',generation=?,revision=revision+1",[randomUUID()]);
 db.run("UPDATE mail_draft_sync SET enabled=0,state=CASE WHEN state IN ('queued','syncing') THEN 'uncertain' ELSE state END,error='restore_review',revision=revision+1");
 db.run("UPDATE mail_portability_jobs SET state='interrupted',error='interrupted' WHERE state<>'complete'");
 db.run("UPDATE mail_matter_filings SET state='uncertain',error='restore_review',generation=?,revision=revision+1 WHERE state IN ('queued','uploading')",[randomUUID()]);
 db.run('DELETE FROM mail_notification_accounts');
}
export function isRestoredMailWork(db:MailDatabase,accountId:string,kind:'submission'|'draft'|'portability'|'filing',id:string){return !!db.get('SELECT 1 FROM mail_recovery_quarantine WHERE account_id=? AND kind=? AND entity_id=?',[accountId,kind,id]);}
