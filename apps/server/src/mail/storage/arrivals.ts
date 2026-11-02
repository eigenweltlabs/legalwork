import type { MailDatabase } from './database-interface.js';
import type { ProviderMessageLocator } from '../model.js';
import { captureMailRuleArrival } from './rules.js';
import { captureMailProjectArrival } from './classifier-arrivals.js';
/** Both consumers share the providers' existing incremental arrival boundary. */
export function captureMailArrival(db: MailDatabase, ownerId: string, accountId: string, locator: ProviderMessageLocator, now = Date.now()) {
    captureMailRuleArrival(db, ownerId, accountId, locator, now);
    captureMailProjectArrival(db, ownerId, accountId, locator, now);
}
