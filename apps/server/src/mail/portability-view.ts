import {z} from 'zod';
const id=z.string().min(1).max(4096),size=z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const archiveFolderSchema=z.object({id,name:z.string().max(4096),kind:z.enum(['folder','label']),parentId:id.nullable(),role:z.literal('inbox').nullable()}).strict();
export const archiveHeaderSchema=z.object({type:z.literal('legalwork-mail-archive'),version:z.literal(1),namespace:z.string().uuid(),format:z.enum(['eml','mboxrd'])}).strict();
export const archiveEntrySchema=z.object({type:z.literal('message'),entryId:id,path:z.string().max(4096).optional(),start:size.optional(),end:size.optional(),bytes:size,sha256:z.string().regex(/^[a-f0-9]{64}$/),receivedAt:size.nullable(),isRead:z.boolean().nullable(),folders:z.array(archiveFolderSchema).max(256),memberships:z.array(id).max(256),origin:z.object({provider:z.string().max(32),sourceAccountId:id,identity:z.string().max(16384)}).strict()}).strict();
export type ArchiveEntry=z.infer<typeof archiveEntrySchema>;
export const portabilityStatusSchema=z.object({id:z.string().uuid(),accountId:id,direction:z.enum(['import','export']),format:z.enum(['eml','mboxrd','bundle']),state:z.enum(['ready','running','paused','interrupted','complete','attention']),completed:size,bytes:size,failed:size,error:z.enum(['source_changed','invalid_archive','storage_failed','content_unavailable','interrupted']).nullable(),label:z.string().max(4096)}).strict();
export type PortabilityStatus=z.infer<typeof portabilityStatusSchema>;
/** Paths enter only through the trusted desktop file picker, never the HTTP surface. */
export const portabilityCommandSchema=z.discriminatedUnion('operation',[
 z.object({operation:z.literal('mail.portability.list')}).strict(),
 z.object({operation:z.literal('mail.portability.import'),path:id,format:z.enum(['eml','mboxrd','bundle']),label:z.string().min(1).max(4096)}).strict(),
 z.object({operation:z.literal('mail.portability.export'),path:id,accountId:id,format:z.enum(['eml','mboxrd'])}).strict(),
 z.object({operation:z.literal('mail.portability.resume'),id:z.string().uuid()}).strict(),
 z.object({operation:z.literal('mail.portability.pause'),id:z.string().uuid()}).strict(),
]);
export type PortabilityCommand=z.infer<typeof portabilityCommandSchema>;
