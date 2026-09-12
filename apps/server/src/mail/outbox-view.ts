import {z} from 'zod';
import {mailAddressSchema,mailLocalVersionSchema,mailSubmissionSchema} from './local-view.js';
const id=z.string().min(1).max(4096);
export const smtpSettingsSchema=z.object({host:z.string().min(1).max(253).regex(/^[a-zA-Z0-9.:-]+$/),port:z.number().int().min(1).max(65535),username:z.string().min(1).max(512).refine(value=>!/[\x00\r\n]/.test(value)),security:z.enum(['tls','starttls']),sentCopy:z.enum(['provider','append']).default('append')}).strict();
export const smtpConfigureSchema=smtpSettingsSchema.extend({password:z.string().min(1).max(4096).refine(value=>!value.includes('\0'))}).strict();
export const smtpStatusSchema=z.object({configured:z.boolean(),settings:smtpSettingsSchema.nullable(),current:z.boolean()}).strict();
export type SmtpSettings=z.infer<typeof smtpSettingsSchema>;export type SmtpConfigure=z.infer<typeof smtpConfigureSchema>;export type SmtpStatus=z.infer<typeof smtpStatusSchema>;
export const outboxResultSchema=z.object({accepted:z.array(mailAddressSchema).max(150),rejected:z.array(z.object({address:mailAddressSchema,code:z.string().max(32)}).strict()).max(150),providerId:id.nullable(),sentCopy:z.enum(['provider','pending','saved','unavailable']),delivery:z.literal('unknown'),reconciled:z.boolean().default(false)}).strict();
export type OutboxResult=z.infer<typeof outboxResultSchema>;
export const outboxErrorSchema=z.enum(['sender_unavailable','credentials_changed','smtp_unconfigured','invalid_message','too_large','large_shared_unsupported','large_inline_unsupported','authentication','certificate','permission','rejected','retryable','outcome_unknown','preparation_unknown','sent_copy_unavailable']);
export type OutboxErrorCode=z.infer<typeof outboxErrorSchema>;
export const outboxItemSchema=z.object({id,accountId:id,draftId:id,version:mailLocalVersionSchema,subject:z.string().max(512),from:mailAddressSchema,state:z.enum(['queued','sending','accepted','failed','uncertain','cancelled']),attempts:z.number().int().nonnegative(),createdAt:z.number(),updatedAt:z.number(),error:outboxErrorSchema.nullable(),result:outboxResultSchema.nullable(),cancellationGuaranteed:z.boolean()}).strict();
export type OutboxItem=z.infer<typeof outboxItemSchema>;
export const outboxActionSchema=z.object({actionId:id,action:z.enum(['cancel','retry','reconcile'])}).strict();
export const outboxCommandSchema=z.discriminatedUnion('operation',[
 z.object({operation:z.literal('mail.outbox.queue'),accountId:id,input:mailSubmissionSchema}).strict(),
 z.object({operation:z.literal('mail.outbox.list'),accountId:id}).strict(),
 z.object({operation:z.literal('mail.outbox.action'),accountId:id,input:outboxActionSchema}).strict(),
 z.object({operation:z.literal('mail.smtp.status'),accountId:id}).strict(),
 z.object({operation:z.literal('mail.smtp.configure'),accountId:id,input:smtpConfigureSchema}).strict(),
 z.object({operation:z.literal('mail.smtp.remove'),accountId:id}).strict(),
]);
export type OutboxCommand=z.infer<typeof outboxCommandSchema>;
export class OutboxError extends Error{constructor(readonly code:OutboxErrorCode){super('mail_outbox_'+code);}}
