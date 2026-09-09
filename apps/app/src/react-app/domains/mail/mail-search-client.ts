import { MailClient } from './mail-client';
import { mailSearchInputSchema, mailSearchResultSchema, type MailSearchInput, type MailSearchResult } from '../../../../../server/src/mail/search-view';
import { savedSearchInputSchema, savedSearchResultSchema, type SavedSearchInput, type SavedSearch } from '../../../../../server/src/mail/saved-search-view';
import { extractionReadSchema, extractionTextSchema, type MailExtractionRead } from '../../../../../server/src/mail/extraction-view';
export type { MailSearchInput, MailSearchResult, SavedSearch };
export function runMailSearch(client: MailClient, input: MailSearchInput, signal: AbortSignal) {
    const checked = mailSearchInputSchema.safeParse(input);
    if (!checked.success)
        throw Error('Invalid search filters. Check dates, text lengths and the 20-keyword limit.');
    return client.request('/search', mailSearchResultSchema, signal, checked.data);
}
export function savedMailSearch(client: MailClient, input: SavedSearchInput, signal: AbortSignal) {
    const checked = savedSearchInputSchema.safeParse(input);
    if (!checked.success)
        throw Error('Invalid saved search. Check the name and filters.');
    return client.request('/search/saved', savedSearchResultSchema, signal, checked.data);
}
export function readExtraction(client: MailClient, accountId: string, input: MailExtractionRead, signal: AbortSignal) { return client.request(`/accounts/${encodeURIComponent(accountId)}/attachments/extraction/read`, extractionTextSchema, signal, extractionReadSchema.parse(input)); }
/** Late transport settlements cannot restore an older query, page or selection. */
export class SearchRequests {
    private controller = new AbortController();
    private version = 0;
    get generation() { return this.version; }
    start() { this.version++; this.controller.abort(); this.controller = new AbortController(); return this.controller.signal; }
    cancel() { this.version++; this.controller.abort(); }
}
