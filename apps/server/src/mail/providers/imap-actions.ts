import { z } from 'zod';
import { MailActionJournal } from '../storage/action-journal.js';
import { ImapCustody, type ImapVersion } from '../storage/imap-custody.js';
import { mailMutationSchema } from '../local-view.js';
import type { MailDatabase } from '../storage/database-interface.js';
import type { ImapReadTransport } from './imap.js';
import { imapFailure } from './imap.js';
const payloadSchema = z.object({ version: z.literal(1), credentialGeneration: z.string().uuid(), intent: z.object({ kind: z.literal('mutation'), locator: mailMutationSchema.shape.locator, precondition: z.string(), change: mailMutationSchema.shape.change }).strict() }).strict();
/** One durable action per turn. No submission claim and no uncertain replay. */
export class ImapActions {
    private readonly journal: MailActionJournal;
    private readonly custody: ImapCustody;
    constructor(private readonly db: MailDatabase, ownerId: string) { this.journal = new MailActionJournal(db, ownerId); this.custody = new ImapCustody(db, ownerId); }
    ready(accountId:string):boolean {
        this.custody.account(accountId);this.journal.recoverExpired(accountId);
        return !!this.db.get("SELECT 1 FROM mail_action_jobs WHERE account_id=? AND kind='mutation' AND state IN ('queued','retry') AND available_at<=? LIMIT 1",[accountId,Date.now()]);
    }
    async turn(accountId: string, version: ImapVersion, transport: Pick<ImapReadTransport, 'mutate'>, signal: AbortSignal, fence: () => void): Promise<boolean> {
        fence();
        this.journal.recoverExpired(accountId);
        const action = this.journal.claim(accountId, 60000, 'mutation');
        if (!action)
            return false;
        let dispatched = false;
        try {
            const payload = payloadSchema.parse(JSON.parse(action.payloadJson));
            if (payload.credentialGeneration !== version.generation) {
                this.journal.failBeforeDispatch(action.lease, false);
                return true;
            }
            const input = mailMutationSchema.parse({ replayKey: 'internal', locator: payload.intent.locator, precondition: payload.intent.precondition, change: payload.intent.change });
            const current = () => { fence(); this.custody.assert(accountId, version); this.journal.renew(action.lease, 60000); };
            const result = await transport.mutate(input, signal, () => { current(); this.journal.markDispatched(action.lease); dispatched = true; });
            current();
            this.db.transaction(() => {
                current();
                if (dispatched)
                    this.journal.recordOutcome(action.lease, result === 'confirmed' ? 'succeeded' : 'unknown');
                else
                    this.journal.failBeforeDispatch(action.lease, false);
                this.db.run('INSERT INTO mail_imap_action_results(account_id,id,result) VALUES(?,?,?) ON CONFLICT(account_id,id) DO UPDATE SET result=excluded.result', [accountId, action.lease.id, result]);
            });
        }
        catch (error) {
            // A revoked lease/generation prevents publishing even a diagnostic. Recovery keeps
            // dispatching uncertain; it never grants permission to resend.
            try {
                fence();
                this.custody.assert(accountId, version);
                if (dispatched)
                    this.journal.recordOutcome(action.lease, 'unknown');
                else
                    this.journal.failBeforeDispatch(action.lease, imapFailure(error).retryable && !(error instanceof z.ZodError));
            }
            catch { /* fenced; durable recovery owns it */ }
        }
        return true;
    }
}
