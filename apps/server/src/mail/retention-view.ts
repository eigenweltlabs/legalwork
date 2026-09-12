import {z} from 'zod';
const id=z.string().min(1).max(4096),count=z.number().int().nonnegative();
export const retentionSettingsSchema=z.object({removedDays:z.number().int().min(1).max(36500).nullable()}).strict();
export const retentionScopeSchema=z.object({scope:z.enum(['removed','mirror','account']),before:z.string().datetime().nullable().default(null),includeArchive:z.boolean().default(false)}).strict();
export const retentionPreviewSchema=z.object({accountId:id,token:z.string().regex(/^[a-f0-9]{64}$/),expiresAt:count,scope:retentionScopeSchema,messages:count,references:count,bytes:count,protectedReferences:count,retainedRecords:count,drafts:count,submissions:count,blockers:z.array(z.enum(['connected','active_work','retained_records','shared_children','unfinished_import','archive_not_selected'])),accountGeneration:z.string(),settings:retentionSettingsSchema}).strict();
export const retentionApplySchema=z.object({token:z.string().regex(/^[a-f0-9]{64}$/),confirmation:z.literal('DELETE LOCAL COPIES')}).strict();
export const retentionResultSchema=z.object({accountId:id,removedAccount:z.boolean(),messages:count,references:count,bytes:count,protectedReferences:count}).strict();
export const retentionCommandSchema=z.discriminatedUnion('operation',[
 z.object({operation:z.literal('mail.retention.read'),accountId:id}).strict(),
 z.object({operation:z.literal('mail.retention.preview'),accountId:id,input:retentionScopeSchema}).strict(),
 z.object({operation:z.literal('mail.retention.apply'),accountId:id,input:retentionApplySchema}).strict(),
 z.object({operation:z.literal('mail.retention.settings'),accountId:id,input:retentionSettingsSchema}).strict(),
]);
export type RetentionScope=z.infer<typeof retentionScopeSchema>;export type RetentionPreview=z.infer<typeof retentionPreviewSchema>;export type RetentionCommand=z.infer<typeof retentionCommandSchema>;
export class MailRetentionError extends Error{constructor(readonly code:'conflict'|'locked'|'not_found'|'invalid_input'){super('mail_retention_'+code);}}
