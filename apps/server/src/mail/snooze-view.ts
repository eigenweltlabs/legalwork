import { z } from 'zod';
import { providerMessageLocatorSchema } from './model.js';
import { mailLocalVersionSchema } from './local-view.js';
import { mailTimeSchema } from './scheduling-view.js';

const locator = providerMessageLocatorSchema.refine(value => value.provider !== 'archive');
export const mailSnoozeReadSchema = z.object({ locator }).strict();
export const mailSnoozeSetSchema = mailSnoozeReadSchema.extend({ expected: mailLocalVersionSchema.nullable(), time: mailTimeSchema.nullable() }).strict();
export type MailSnoozeSet = z.infer<typeof mailSnoozeSetSchema>;
export const mailSnoozeSchema = z.object({
  accountId: z.string().min(1).max(4096), locator,
  version: mailLocalVersionSchema.nullable(), time: mailTimeSchema.nullable(),
  scope: z.enum(['message', 'conversation']), count: z.number().int().min(0).max(1000), available: z.boolean(),
}).strict().refine(value=>value.time===null||value.version!==null);
export type MailSnooze = z.infer<typeof mailSnoozeSchema>;
export const mailSnoozeErrorSchema = z.enum(['invalid_time', 'conflict', 'not_found', 'unavailable', 'limit']);
export class MailSnoozeError extends Error {
  constructor(readonly code: z.infer<typeof mailSnoozeErrorSchema>) { super('mail_snooze_' + code); }
}
export const mailSnoozeCommandSchema = z.discriminatedUnion('operation', [
  z.object({ operation: z.literal('mail.snooze.read'), accountId: z.string().min(1).max(4096), input: mailSnoozeReadSchema }).strict(),
  z.object({ operation: z.literal('mail.snooze.set'), accountId: z.string().min(1).max(4096), input: mailSnoozeSetSchema }).strict(),
]);
export type MailSnoozeCommand = z.infer<typeof mailSnoozeCommandSchema>;
