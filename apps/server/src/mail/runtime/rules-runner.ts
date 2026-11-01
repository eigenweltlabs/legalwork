import { MailRulesStore } from '../storage/rules.js';
import type { MailDatabase } from '../storage/database-interface.js';

/** Local queue evaluation only. The existing sync engines own every provider request. */
export class MailRulesRunner {
  private timer?: ReturnType<typeof setInterval>;
  private store: MailRulesStore;
  constructor(db: MailDatabase, ownerId: string, private wake: (accountId: string) => void, private canRun: () => boolean = () => true) { this.store = new MailRulesStore(db, ownerId); }
  resume() {
    if (this.timer) return;
    const turn = () => { if (!this.canRun()) return; try { for (const accountId of this.store.run()) { try { this.wake(accountId); } catch { /* The journal retains queued work. */ } } } catch { /* Retry local evaluation on the next bounded turn. */ } };
    this.timer = setInterval(turn, 2000); this.timer.unref(); turn();
  }
  suspend() { clearInterval(this.timer); this.timer = undefined; }
}
