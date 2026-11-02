import { z } from 'zod';
import { providerMessageLocatorSchema, providerMessageKey } from './model.js';
import { mailLocalVersionSchema } from './local-view.js';
import { mailProjectReferenceSchema, mailProjectDestinationSchema } from './project-association-view.js';
import { mailClassifierThresholdSchema,mailClassifierReasonSchema } from './project-decision-view.js';
import {mailClassifierCandidateSchema,mailClassifierReviewCommandSchema,mailClassifierReviewResultSchema,classifierIncomingMatches} from './classifier-incoming-view.js';
export {mailClassifierReasonSchema} from './project-decision-view.js';

const id = z.string().min(1).max(4096);
const sender = z.string().trim().toLowerCase().max(254).refine(value => !value || z.string().email().safeParse(value).success);
export const mailClassifierAddressSchema = sender.refine(value => value !== '');
const domain = z.string().trim().toLowerCase().max(253).refine(value => !value || /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(value));
const phrase = z.string().trim().min(1).max(200);
export const mailClassifierCriteriaSchema = z.object({ sender, domain, reference: z.string().trim().max(80), subject: z.string().trim().max(200) }).strict().refine(value => !!(value.sender || value.domain || value.reference || value.subject));
export type MailClassifierCriteria = z.infer<typeof mailClassifierCriteriaSchema>;
export const mailClassifierRuleSchema = z.object({ id: z.string().uuid(), name: z.string().trim().min(1).max(80), enabled: z.boolean(), order: z.number().int().min(1).max(20), project: mailProjectReferenceSchema, criteria: mailClassifierCriteriaSchema }).strict();
export type MailClassifierRule = z.infer<typeof mailClassifierRuleSchema>;
export const mailClassifierDefinitionSchema = z.object({
  mode: z.enum(['off', 'suggestions','automatic']),automaticThreshold:mailClassifierThresholdSchema.optional(), rules: z.array(mailClassifierRuleSchema).max(20),
  exclusions: z.object({ senders: z.array(sender.refine(value => value !== '')).max(20), domains: z.array(domain.refine(value => value !== '')).max(20), subjects: z.array(phrase).max(20) }).strict(),
}).strict().refine(value => new Set(value.rules.map(rule => rule.id)).size === value.rules.length)
  .refine(value => new TextEncoder().encode(JSON.stringify(value)).byteLength <= 24000);
export type MailClassifierDefinition = z.infer<typeof mailClassifierDefinitionSchema>;
export const emptyMailClassifier: MailClassifierDefinition = { mode: 'off', rules: [], exclusions: { senders: [], domains: [], subjects: [] } };
export const mailClassifierStatusSchema=z.enum(['off','ready','waiting_sync','paused','connection_changed','unavailable']);
export const mailClassifierConfigSchema = z.object({ accountId: id, version: mailLocalVersionSchema.nullable(), definition: mailClassifierDefinitionSchema,automaticStatus:mailClassifierStatusSchema.optional(),automaticEligible:z.boolean().optional() }).strict();
export type MailClassifierConfig = z.infer<typeof mailClassifierConfigSchema>;
export const mailClassifierEditableRuleSchema = mailClassifierRuleSchema.extend({ project: mailProjectReferenceSchema.nullable() });
const editableDefinition = z.object({ mode: z.enum(['off', 'suggestions','automatic']),automaticThreshold:mailClassifierThresholdSchema.optional(), rules: z.array(mailClassifierEditableRuleSchema).max(20), exclusions: mailClassifierDefinitionSchema.shape.exclusions }).strict();
export const mailClassifierSaveSchema = z.object({ expected: mailLocalVersionSchema.nullable(), definition: editableDefinition.refine(value => new Set(value.rules.map(rule => rule.id)).size === value.rules.length && new TextEncoder().encode(JSON.stringify(value)).byteLength <= 24000) }).strict();
export type MailClassifierSave = z.infer<typeof mailClassifierSaveSchema>;
export type MailClassifierReason = z.infer<typeof mailClassifierReasonSchema>;
export const mailClassifierPreviewInputSchema = z.object({ locator: providerMessageLocatorSchema }).strict();
const previewBase = z.object({
  accountId: id, locator: providerMessageLocatorSchema, version: mailLocalVersionSchema.nullable(),
  status: z.enum(['off', 'manual', 'unavailable', 'excluded', 'unmatched', 'suggested', 'ambiguous']), candidates: z.array(mailClassifierCandidateSchema).max(20),
}).strict();
export const mailClassifierPreviewSchema = previewBase.refine(value => value.status === 'suggested' ? value.candidates.length === 1 : value.status === 'ambiguous' ? value.candidates.length > 1 : value.candidates.length === 0);
export type MailClassifierPreview = z.infer<typeof mailClassifierPreviewSchema>;
const displayRuleSchema = mailClassifierRuleSchema.omit({ project: true }).extend({ project: mailProjectDestinationSchema.nullable(), unavailable: z.boolean() }).strict().refine(value => value.unavailable ? value.project === null : value.project !== null);
export const mailClassifierDisplaySchema = z.object({ accountId: id, version: mailLocalVersionSchema.nullable(), definition: editableDefinition.omit({ rules: true }).extend({ rules: z.array(displayRuleSchema).max(20) }),automaticStatus:mailClassifierStatusSchema.optional(),automaticEligible:z.boolean().optional() }).strict();
export type MailClassifierDisplay = z.infer<typeof mailClassifierDisplaySchema>;
export const mailClassifierDisplayPreviewSchema = previewBase.omit({ candidates: true }).extend({
  candidates: z.array(mailClassifierCandidateSchema.extend({ project: mailProjectDestinationSchema })).max(20), unavailable: z.number().int().min(0).max(20),
}).strict().refine(value => value.status === 'suggested' ? value.candidates.length === 1 && value.unavailable === 0 : value.status === 'ambiguous' ? value.candidates.length + value.unavailable > 1 : value.status === 'unavailable' ? value.candidates.length === 0 : value.candidates.length === 0 && value.unavailable === 0);
export type MailClassifierDisplayPreview = z.infer<typeof mailClassifierDisplayPreviewSchema>;
export const mailClassifierCommandSchema = z.discriminatedUnion('operation', [
  z.object({ operation: z.literal('mail.classifier.read'), accountId: id }).strict(),
  z.object({ operation: z.literal('mail.classifier.save'), accountId: id, input: mailClassifierSaveSchema }).strict(),
  z.object({ operation: z.literal('mail.classifier.preview'), accountId: id, input: mailClassifierPreviewInputSchema }).strict(),
  ...mailClassifierReviewCommandSchema.options,
]);
export type MailClassifierCommand = z.infer<typeof mailClassifierCommandSchema>;
export const mailClassifierErrorSchema = z.enum(['invalid_input', 'not_found', 'conflict', 'unavailable']);
export class MailClassifierError extends Error { constructor(readonly code: z.infer<typeof mailClassifierErrorSchema>) { super('mail_classifier_' + code); } }
export const mailClassifierResultSchema = z.union([z.object({ classifier: mailClassifierConfigSchema }).strict(), z.object({ classification: mailClassifierPreviewSchema }).strict(), z.object({ classifierFailure: mailClassifierErrorSchema }).strict(),mailClassifierReviewResultSchema]);
export type MailClassifierResult = z.infer<typeof mailClassifierResultSchema>;
export function mailClassifierResultMatches(command: MailClassifierCommand, value: unknown) {
  const parsed = mailClassifierResultSchema.safeParse(value); if (!parsed.success) return false;
  const result = parsed.data; if ('classifierFailure' in result) return true;
  if(command.operation==='mail.classifier.activity'||command.operation==='mail.classifier.dismiss'||command.operation==='mail.classifier.undo')return classifierIncomingMatches(command,value);
  if (command.operation === 'mail.classifier.preview') return 'classification' in result && result.classification.accountId === command.accountId && providerMessageKey(result.classification.locator) === providerMessageKey(command.input.locator);
  if (!('classifier' in result) || result.classifier.accountId !== command.accountId) return false;
  if (command.operation === 'mail.classifier.read') return true;
  const config = result.classifier, expected = command.input.expected;
  return (expected ? config.version?.generation === expected.generation && config.version.revision === expected.revision + 1 : config.version?.revision === 1)
    && config.definition.mode === command.input.definition.mode&&config.definition.automaticThreshold===command.input.definition.automaticThreshold && JSON.stringify(config.definition.exclusions) === JSON.stringify(command.input.definition.exclusions)
    && config.definition.rules.length === command.input.definition.rules.length && config.definition.rules.every((rule, index) => {
      const input = command.input.definition.rules[index];
      return rule.id === input.id && rule.name === input.name && rule.enabled === input.enabled && rule.order === input.order && JSON.stringify(rule.criteria) === JSON.stringify(input.criteria) && (!input.project || rule.project.id === input.project.id && rule.project.binding === input.project.binding);
    });
}
