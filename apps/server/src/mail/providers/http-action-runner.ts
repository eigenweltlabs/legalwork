import { GraphMailboxRepository } from '../storage/graph-mailboxes.js';
import { z } from 'zod';
import { mailMutationSchema } from '../local-view.js';
import { MailActionJournal } from '../storage/action-journal.js';
import { MailCredentialRepository, type MailCredentialVersion } from '../storage/credentials.js';
import type { MailDatabase } from '../storage/database-interface.js';
import { MailHttpActions, MailMutationHttpError, type MutationOutcome } from './http-actions.js';

const payload = z.object({version:z.literal(1),credentialGeneration:z.string().uuid(),intent:z.object({kind:z.literal('mutation'),locator:mailMutationSchema.shape.locator,precondition:z.string(),change:mailMutationSchema.shape.change}).strict()}).strict();
/** One mutation per sync turn, sharing the engine's account/run ownership fence. */
export class MailHttpActionRunner {
  private readonly journal: MailActionJournal;
  private readonly credentials: MailCredentialRepository;
  constructor(private readonly db: MailDatabase, private readonly ownerId: string) {
    this.journal=new MailActionJournal(db,ownerId);
    this.credentials=new MailCredentialRepository(db,ownerId);
  }
  ready(accountId: string) {
    if (this.credentials.status(accountId).state!=='connected') return false;
    this.journal.recoverExpired(accountId);
    return !!this.db.get("SELECT 1 FROM mail_action_jobs WHERE account_id=? AND kind='mutation' AND state IN ('queued','retry') AND available_at<=? LIMIT 1",[accountId,Date.now()]);
  }
  async turn(accountId:string, version:MailCredentialVersion, transport:Pick<MailHttpActions,'mutate'>, signal:AbortSignal, fence:()=>void) {
    fence(); this.journal.recoverExpired(accountId);
    const claimed=this.journal.claim(accountId,60000,'mutation');
    if (!claimed) return false;
    let dispatched=false;
    const current=()=>{
      fence();
      const status=this.credentials.status(accountId);
      if (signal.aborted||status.state!=='connected'||status.version.generation!==version.generation||status.version.revision!==version.revision) throw Error('mail_action_retired');
      this.journal.renew(claimed.lease,60000);
    };
    const result=(outcome:MutationOutcome)=>{
      this.db.transaction(()=>{
        current();
        if (dispatched) this.journal.recordOutcome(claimed.lease,outcome==='confirmed'?'succeeded':outcome==='conflict'?'conflict':outcome==='rejected'?'rejected':'unknown');
        else this.journal.failBeforeDispatch(claimed.lease,false);
        // The existing result relation is account/action scoped for every provider.
        this.db.run('INSERT INTO mail_imap_action_results(account_id,id,result) VALUES(?,?,?) ON CONFLICT(account_id,id) DO UPDATE SET result=excluded.result',[accountId,claimed.lease.id,outcome]);
      });
    };
    try {
      const value=payload.parse(JSON.parse(claimed.payloadJson));
      current();
      if (value.credentialGeneration!==version.generation) {result('conflict');return true;}
      const input=mailMutationSchema.parse({replayKey:'internal',locator:value.intent.locator,precondition:value.intent.precondition,change:value.intent.change});
      const outcome=await transport.mutate(input,signal,()=>{current();if(this.db.get('SELECT provider FROM mail_accounts WHERE id=?',[accountId])?.provider==='graph')new GraphMailboxRepository(this.db,this.ownerId).assertWrite(accountId);this.journal.markDispatched(claimed.lease);dispatched=true;});
      result(outcome);
    } catch(error) {
      try {
        current();
        if (dispatched) result(error instanceof MailMutationHttpError&&error.rejected?'rejected':'unknown');
        else this.journal.failBeforeDispatch(claimed.lease,error instanceof MailMutationHttpError&&error.retryable);
      } catch { /* A newer owner retires publication; durable lease recovery preserves uncertainty. */ }
    }
    return true;
  }
}
