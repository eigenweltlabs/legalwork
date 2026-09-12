import type { MailDatabase } from './database-interface.js';
import { savedSearchInputSchema, savedSearchSchema, savedSearchResultSchema, type SavedSearchInput, type SavedSearch } from '../saved-search-view.js';
import { z } from 'zod';
export class SavedSearchError extends Error {
    constructor(readonly code: 'conflict' | 'not_found' | 'locked' | 'invalid_input') { super('mail_saved_search_' + code); }
}
export class MailSavedSearchStore {
    constructor(private readonly db: MailDatabase, private readonly ownerId: string) { }
    private scope(query: SavedSearch['query']) { for (const id of query.accountIds ?? []) {
        const row = this.db.get("SELECT a.id,c.state,i.archive_locked FROM mail_accounts a LEFT JOIN mail_account_access c ON c.account_id=a.id LEFT JOIN mail_imap_credentials i ON i.account_id=a.id WHERE a.owner_id=? AND a.id=?", [this.ownerId, id]);
        if (!row)
            throw new SavedSearchError('not_found');
        if (row.state === 'disconnected' || row.archive_locked === 1)
            throw new SavedSearchError('locked');
    } }
    execute(input: SavedSearchInput) {
        const checked = savedSearchInputSchema.safeParse(input);
        if (!checked.success)
            throw new SavedSearchError('invalid_input');
        const value = checked.data;
        return this.db.transaction(() => {
            if (value.action === 'list') {
                const rows = this.db.all('SELECT id,name,revision,query_json FROM mail_saved_searches WHERE owner_id=? AND id>? ORDER BY id LIMIT ?', [this.ownerId, value.after ?? '', value.limit + 1]);
                const items: SavedSearch[] = [];
                let cursor: string | null = null;
                for (const row of rows.slice(0, value.limit)) {
                    const item = savedSearchSchema.parse({ id: row.id, name: row.name, revision: row.revision, query: JSON.parse(z.string().parse(row.query_json)) });
                    if (items.length && Buffer.byteLength(JSON.stringify([...items, item])) > 40 * 1024)
                        break;
                    items.push(item);
                    cursor = item.id;
                }
                return savedSearchResultSchema.parse({ action: 'list', items, nextCursor: rows.length > items.length ? cursor : null });
            }
            const old = this.db.get('SELECT revision FROM mail_saved_searches WHERE owner_id=? AND id=?', [this.ownerId, value.id]);
            if (value.action === 'delete') {
                if (!old)
                    throw new SavedSearchError('not_found');
                if (old.revision !== value.expectedRevision)
                    throw new SavedSearchError('conflict');
                this.db.run('DELETE FROM mail_saved_searches WHERE owner_id=? AND id=?', [this.ownerId, value.id]);
                return savedSearchResultSchema.parse({ action: 'delete', id: value.id, deleted: true });
            }
            this.scope(value.query);
            if ((old?.revision ?? null) !== value.expectedRevision)
                throw new SavedSearchError('conflict');
            if (!old && z.number().parse(this.db.get('SELECT count(*) AS n FROM mail_saved_searches WHERE owner_id=?', [this.ownerId])?.n) >= 100)
                throw new SavedSearchError('invalid_input');
            const revision = old ? z.number().int().positive().max(Number.MAX_SAFE_INTEGER - 1).parse(old.revision) + 1 : 1;
            this.db.run('INSERT INTO mail_saved_searches(owner_id,id,name,revision,query_json) VALUES(?,?,?,?,?) ON CONFLICT(owner_id,id) DO UPDATE SET name=excluded.name,revision=excluded.revision,query_json=excluded.query_json', [this.ownerId, value.id, value.name, revision, JSON.stringify(value.query)]);
            return savedSearchResultSchema.parse({ action: 'save', item: { id: value.id, name: value.name, revision, query: value.query } });
        });
    }
}
