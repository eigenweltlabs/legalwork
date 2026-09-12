import { z } from 'zod';
import { providerMessageLocatorSchema } from './model.js';
export const mailNotificationPreferencesSchema = z.object({ enabled: z.boolean(), preview: z.enum(['none', 'sender', 'subject']), sound: z.boolean(), paused: z.boolean() }).strict();
export type MailNotificationPreferences = z.infer<typeof mailNotificationPreferencesSchema>;
export const mailNotificationPollSchema = z.object({ sessionId: z.string().uuid(), enabled: z.boolean(), preview: z.enum(['none', 'sender', 'subject']) }).strict();
export type MailNotificationPoll = z.infer<typeof mailNotificationPollSchema>;
export const mailNotificationTargetSchema = z.object({ accountId: z.string().min(1).max(4096), locator: providerMessageLocatorSchema }).strict();
export const mailNotificationItemSchema = z.object({ id: z.string().uuid(), target: mailNotificationTargetSchema, title: z.string().max(200), body: z.string().max(300) }).strict();
export const mailNotificationBatchSchema = z.object({ items: z.array(mailNotificationItemSchema).max(5), suppressed: z.number().int().nonnegative() }).strict();
export type MailNotificationBatch = z.infer<typeof mailNotificationBatchSchema>;
export const mailLifecycleSchema = z.object({ suspended: z.boolean() }).strict();
export const mailLifecycleStatusSchema = z.object({ state: z.enum(['running', 'suspended']) }).strict();
export const mailDesktopCommandSchema = z.discriminatedUnion('operation', [
    z.object({ operation: z.literal('mail.notifications.poll'), input: mailNotificationPollSchema }).strict(),
    z.object({ operation: z.literal('mail.lifecycle.set'), input: mailLifecycleSchema }).strict(),
    z.object({ operation: z.literal('mail.lifecycle.status') }).strict(),
]);
export type MailDesktopCommand = z.infer<typeof mailDesktopCommandSchema>;
export const mailNotificationOpenSchema = mailNotificationTargetSchema.extend({ serverOrigin: z.string().url() }).strict();
