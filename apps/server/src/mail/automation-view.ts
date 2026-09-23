/** Dormant EIG-161 contracts. No route or worker command currently exposes these operations. */
import { z } from 'zod';
import { mailLocalVersionSchema, mailSubmissionSchema } from './local-view.js';
import { providerMessageLocatorSchema } from './model.js';
import { outboxItemSchema } from './outbox-view.js';

const id = z.string().min(1).max(4096);
const integer = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const mutableLocator = providerMessageLocatorSchema.refine(value => value.provider !== 'archive');

export const mailTimeZoneSchema = z.string().min(1).max(100).refine(value => {
  try {
    new Intl.DateTimeFormat('en', { timeZone: value });
    return true;
  } catch {
    return false;
  }
}, 'Choose a valid time zone.');

/** A fixed UTC instant plus its display zone; changing the system zone must not move the instant. */
export const mailTimeSchema = z.object({ at: integer, timeZone: mailTimeZoneSchema }).strict();
export type MailTime = z.infer<typeof mailTimeSchema>;

export const localRuleDefinitionSchema = z.object({
  name: z.string().trim().min(1).max(80),
  enabled: z.boolean(),
  from: z.string().trim().max(320),
  subject: z.string().trim().max(160),
  action: z.enum(['read', 'flag', 'archive', 'snooze']),
  snoozeMinutes: z.number().int().min(5).max(10080).default(60),
}).strict().refine(value => !!value.from || !!value.subject, 'Add a sender or subject condition.');

export const localRuleSchema = z.object({
  id: z.string().uuid(),
  revision: integer.min(1),
  createdAt: integer,
  activatedAt: integer,
  definition: localRuleDefinitionSchema,
  credentialCurrent: z.boolean(),
}).strict();
export type LocalMailRule = z.infer<typeof localRuleSchema>;

export const snoozeItemSchema = z.object({
  accountId: id,
  key: z.string().max(32768),
  locator: mutableLocator,
  subject: z.string().max(512),
  until: integer,
  timeZone: mailTimeZoneSchema,
  revision: integer.min(1),
}).strict();
export type MailSnooze = z.infer<typeof snoozeItemSchema>;

export const ruleActivitySchema = z.object({
  key: z.string().max(32768),
  ruleName: z.string().max(80),
  subject: z.string().max(512),
  at: integer,
  actionId: id.nullable(),
  outcome: z.enum(['queued', 'snoozed', 'unavailable']),
}).strict();

export const automationInputSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('schedule'), submission: mailSubmissionSchema, time: mailTimeSchema }).strict(),
  z.object({
    action: z.literal('reschedule'),
    actionId: id,
    expected: mailLocalVersionSchema,
    time: mailTimeSchema,
  }).strict(),
  z.object({ action: z.literal('snooze-read'), locator: mutableLocator }).strict(),
  z.object({
    action: z.literal('snooze-set'),
    locator: mutableLocator,
    expected: integer.nullable(),
    time: mailTimeSchema.nullable(),
  }).strict(),
  z.object({ action: z.literal('snoozes'), after: z.string().max(32768).optional() }).strict(),
  z.object({ action: z.literal('rules') }).strict(),
  z.object({
    action: z.literal('rule-save'),
    id: z.string().uuid(),
    expected: integer.nullable(),
    definition: localRuleDefinitionSchema,
  }).strict(),
  z.object({ action: z.literal('rule-delete'), id: z.string().uuid(), expected: integer.min(1) }).strict(),
  z.object({ action: z.literal('rule-activity') }).strict(),
]);
export type MailAutomationInput = z.infer<typeof automationInputSchema>;

export const automationResultSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('scheduled'), item: outboxItemSchema }).strict(),
  z.object({ kind: z.literal('snooze'), item: snoozeItemSchema.nullable() }).strict(),
  z.object({
    kind: z.literal('snoozes'),
    items: z.array(snoozeItemSchema).max(25),
    nextCursor: z.string().max(32768).nullable(),
  }).strict(),
  z.object({ kind: z.literal('rules'), items: z.array(localRuleSchema).max(20), ready: z.boolean() }).strict(),
  z.object({ kind: z.literal('rule'), item: localRuleSchema }).strict(),
  z.object({ kind: z.literal('rule-removed'), id: z.string().uuid() }).strict(),
  z.object({ kind: z.literal('rule-activity'), items: z.array(ruleActivitySchema).max(25) }).strict(),
]);
export type MailAutomationResult = z.infer<typeof automationResultSchema>;

export const automationErrorSchema = z.enum(['invalid_input', 'conflict', 'locked', 'not_found', 'limit', 'unavailable']);
export class MailAutomationError extends Error {
  constructor(readonly code: z.infer<typeof automationErrorSchema>) {
    super('mail_automation_' + code);
  }
}

export const automationCommandSchema = z.object({
  operation: z.literal('mail.automation'),
  accountId: id,
  input: automationInputSchema,
}).strict();
export type MailAutomationCommand = z.infer<typeof automationCommandSchema>;

export function validateMailTime(time: MailTime, now = Date.now()): void {
  const checked = mailTimeSchema.safeParse(time);
  if (!checked.success || checked.data.at <= now || checked.data.at > now + 366 * 86400000) {
    throw new MailAutomationError('invalid_input');
  }
}
