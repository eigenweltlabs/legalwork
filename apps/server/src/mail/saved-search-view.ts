import { z } from 'zod';
import { mailSearchInputSchema } from './search-view.js';
const id = z.string().uuid(), revision = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
export const savedQuerySchema = mailSearchInputSchema.refine(value => value.offset === undefined && value.limit === undefined && new TextEncoder().encode(JSON.stringify(value)).length <= 8192, 'Invalid saved query');
export const savedSearchSchema = z.object({ id, name: z.string().trim().min(1).max(120), revision, query: savedQuerySchema }).strict();
export type SavedSearch = z.infer<typeof savedSearchSchema>;
export const savedSearchInputSchema = z.discriminatedUnion('action', [
    z.object({ action: z.literal('list'), after: id.optional(), limit: z.number().int().min(1).max(20).default(10) }).strict(),
    z.object({ action: z.literal('save'), id, expectedRevision: revision.nullable(), name: z.string().trim().min(1).max(120), query: savedQuerySchema }).strict(),
    z.object({ action: z.literal('delete'), id, expectedRevision: revision }).strict(),
]);
export type SavedSearchInput = z.input<typeof savedSearchInputSchema>;
export const savedSearchResultSchema = z.discriminatedUnion('action', [
    z.object({ action: z.literal('list'), items: z.array(savedSearchSchema).max(20), nextCursor: id.nullable() }).strict(),
    z.object({ action: z.literal('save'), item: savedSearchSchema }).strict(),
    z.object({ action: z.literal('delete'), id, deleted: z.literal(true) }).strict(),
]);
export type SavedSearchResult = z.infer<typeof savedSearchResultSchema>;
export function savedSearchResultMatches(input: SavedSearchInput, result: SavedSearchResult): boolean {
    const command = savedSearchInputSchema.parse(input);
    if (command.action === 'save')
        return result.action === 'save' && result.item.id === command.id && result.item.revision === (command.expectedRevision ?? 0) + 1 && result.item.name === command.name && JSON.stringify(result.item.query) === JSON.stringify(command.query);
    if (command.action === 'delete')
        return result.action === 'delete' && result.id === command.id;
    return result.action === 'list' && result.items.length <= command.limit && result.items.every((item, index) => item.id > (index ? result.items[index - 1].id : command.after ?? '')) && (result.nextCursor === null || result.nextCursor === result.items.at(-1)?.id);
}
