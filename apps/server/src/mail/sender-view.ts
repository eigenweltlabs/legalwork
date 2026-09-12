import {z} from 'zod';
const address=z.string().email().max(254).regex(/^[\x21-\x7e]+$/).transform(value=>value.toLowerCase());
export const senderIdentitySchema=z.object({id:z.string().min(1).max(256),accountId:z.string().min(1).max(4096),address,displayName:z.string().max(512),
  source:z.enum(['provider_verified','administrator_confirmed','user_confirmed']),available:z.boolean(),signature:z.string().max(4000),defaultNew:z.boolean(),defaultReply:z.boolean(),
  sendMode:z.enum(['self','send_as','send_on_behalf']),}).strict();
export const senderSettingsSchema=z.object({identityId:z.string().min(1).max(256),signature:z.string().max(4000),defaultNew:z.boolean(),defaultReply:z.boolean()}).strict();
export const senderConfigureSchema=z.object({address,confirmed:z.literal(true),remove:z.boolean().optional()}).strict();
export const senderListSchema=z.array(senderIdentitySchema).max(100);
export type SenderIdentity=z.infer<typeof senderIdentitySchema>;
export type SenderSettings=z.infer<typeof senderSettingsSchema>;
export type SenderConfigure=z.infer<typeof senderConfigureSchema>;
