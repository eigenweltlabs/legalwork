import type { MailDatabase } from '../storage/database-interface.js';
import { MailExtractionStore, type ExtractionLease } from '../storage/extraction.js';
import { extractInProcess } from '../extraction/client.js';
import { ExtractionError, EXTRACTION_LIMITS } from '../extraction/contract.js';
/** One physical extraction process across all accounts; no queue draining inside a transaction. */
export class MailExtractionRunner {
    private readonly store: MailExtractionStore;
    private closed = false;
    private timer: ReturnType<typeof setTimeout> | undefined;
    private abort: AbortController | undefined;
    private active: Promise<void> | undefined;
    private after = '';
    private activeAccount: string | undefined;
    constructor(database: MailDatabase, ownerId: string) { this.store = new MailExtractionStore(database, ownerId); }
    start() { if (!this.closed && !this.timer && !this.active)
        this.schedule(0); }
    cancelAccount(accountId: string) { if (this.activeAccount === accountId)
        this.abort?.abort(); }
    async close() { this.closed = true; clearTimeout(this.timer); this.timer = undefined; this.abort?.abort(); await this.active; }
    private schedule(ms: number) { this.timer = setTimeout(() => { this.timer = undefined; this.active = this.tick().finally(() => { this.active = undefined; if (!this.closed)
        this.schedule(250); }); }, ms); this.timer.unref(); }
    private async tick() {
        let lease: ExtractionLease | null = null;
        try {
            lease = this.store.claim(this.after);
            if (!lease)
                return;
            this.after = lease.accountId;
            this.activeAccount = lease.accountId;
            this.abort = new AbortController();
            if (lease.bytes > EXTRACTION_LIMITS.inputBytes) {
                this.store.finish(lease, 'limit');
                return;
            }
            const result = await extractInProcess({ bytes: this.store.bytes(lease), filename: lease.filename, contentType: lease.contentType, signal: this.abort.signal });
            if (!this.closed && !this.abort.signal.aborted)
                this.store.finish(lease, result);
        }
        catch (error) {
            if (lease && !this.closed)
                try {
                    this.store.finish(lease, error instanceof ExtractionError ? error.code : 'runtime_failed');
                }
                catch { /* Stale refs/credentials remain retained; an expired lease can be reclaimed after restart. */ }
        }
        finally {
            this.abort = undefined;
            this.activeAccount = undefined;
        }
    }
}
