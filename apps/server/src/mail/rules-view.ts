import { z } from 'zod';
import { mailLocalVersionSchema } from './local-view.js';
import { mailTimeSchema } from './scheduling-view.js';

const accountId = z.string().min(1).max(4096);
export const mailRuleDefinitionSchema = z.object({
  name: z.string().trim().min(1).max(80), enabled: z.boolean(), order: z.number().int().min(1).max(20),
  sender: z.string().trim().max(254).refine(value => value === '' || z.string().email().safeParse(value).success),
  subject: z.string().trim().max(200),
  action: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('read') }).strict(),
    z.object({ kind: z.literal('flag') }).strict(),
    z.object({ kind: z.literal('archive') }).strict(),
    z.object({ kind: z.literal('snooze'), minutes: z.number().int().min(1).max(525600), timeZone: mailTimeSchema.shape.timeZone }).strict(),
  ]),
}).strict().refine(value => value.sender !== '' || value.subject !== '');
export type MailRuleDefinition = z.infer<typeof mailRuleDefinitionSchema>;
export const mailRulesReadSchema = z.object({}).strict();
export const mailRuleSaveSchema = z.object({ id: z.string().uuid(), expected: mailLocalVersionSchema.nullable(), definition: mailRuleDefinitionSchema }).strict();
export const mailRuleDeleteSchema = z.object({ id: z.string().uuid(), expected: mailLocalVersionSchema }).strict();
export type MailRuleSave = z.infer<typeof mailRuleSaveSchema>;
export type MailRuleDelete = z.infer<typeof mailRuleDeleteSchema>;
export const mailRuleStatusSchema = z.enum(['ready', 'disabled', 'waiting_sync', 'paused', 'unavailable', 'connection_changed', 'write_permission']);
export const mailRuleSchema = z.object({ id: z.string().uuid(), version: mailLocalVersionSchema, definition: mailRuleDefinitionSchema, status: mailRuleStatusSchema }).strict();
export type MailRule = z.infer<typeof mailRuleSchema>;
export const mailRulesSchema = z.object({
  accountId, items: z.array(mailRuleSchema).max(20),
  activity: z.array(z.object({ id: z.number().int().positive(), ruleName: z.string().max(80), at: z.number().int().nonnegative(), action: z.enum(['read', 'flag', 'archive', 'snooze']),
    outcome: z.enum(['queued', 'running', 'dispatching', 'retry', 'succeeded', 'failed', 'conflict', 'uncertain', 'cancelled', 'snoozed', 'unavailable']) }).strict()).max(25),
}).strict();
export type MailRules = z.infer<typeof mailRulesSchema>;
export const mailRulesErrorSchema = z.enum(['invalid_input', 'not_found', 'conflict', 'unavailable', 'limit']);
export class MailRulesError extends Error {
  constructor(readonly code: z.infer<typeof mailRulesErrorSchema>) { super('mail_rules_' + code); }
}
export const mailRulesCommandSchema = z.discriminatedUnion('operation', [
  z.object({ operation: z.literal('mail.rules.read'), accountId, input: mailRulesReadSchema }).strict(),
  z.object({ operation: z.literal('mail.rules.save'), accountId, input: mailRuleSaveSchema }).strict(),
  z.object({ operation: z.literal('mail.rules.delete'), accountId, input: mailRuleDeleteSchema }).strict(),
]);
export type MailRulesCommand = z.infer<typeof mailRulesCommandSchema>;
