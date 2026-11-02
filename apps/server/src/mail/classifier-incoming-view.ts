import { z } from 'zod';
import { providerMessageLocatorSchema } from './model.js';
import { mailLocalVersionSchema } from './local-view.js';
import { mailProjectReferenceSchema, mailProjectDestinationSchema } from './project-association-view.js';
import { mailClassifierEvidenceRuleSchema, mailClassifierThresholdSchema } from './project-decision-view.js';
const number = z.number().int().positive().max(Number.MAX_SAFE_INTEGER), accountId = z.string().min(1).max(4096);
export const mailClassifierCandidateSchema = z.object({ project: mailProjectReferenceSchema, rules: z.array(mailClassifierEvidenceRuleSchema).min(1).max(20) }).strict();
export const mailClassifierPlanSchema = z.object({ id: number, version: mailLocalVersionSchema, accountId, locator: providerMessageLocatorSchema, configVersion: mailLocalVersionSchema, fingerprint: z.string().regex(/^[a-f0-9]{64}$/), project: mailProjectReferenceSchema, threshold: mailClassifierThresholdSchema, rules: z.array(mailClassifierEvidenceRuleSchema).min(1).max(20) }).strict();
export type MailClassifierPlan = z.infer<typeof mailClassifierPlanSchema>;
export const mailClassifierOutcomeSchema = z.enum(['pending', 'assigned', 'ambiguous', 'below_threshold', 'unmatched', 'excluded', 'manual', 'connection_changed', 'config_changed', 'removed', 'unavailable', 'expired', 'not_inbox', 'historical', 'corrected', 'cleared', 'dismissed', 'undone']);
export const mailClassifierActivityInputSchema = z.object({ filter: z.enum(['review', 'assigned', 'all']).default('review'), beforeId: number.optional() }).strict();
export const mailClassifierActivityItemSchema = z.object({ id: number, version: mailLocalVersionSchema, locator: providerMessageLocatorSchema, subject: z.string().max(200), at: z.number().int().nonnegative(), outcome: mailClassifierOutcomeSchema, project: mailProjectReferenceSchema.nullable(), assignmentVersion: mailLocalVersionSchema.nullable(), canUndo: z.boolean(), canDismiss: z.boolean() }).strict();
export const mailClassifierActivitySchema = z.object({ accountId, items: z.array(mailClassifierActivityItemSchema).max(20), nextCursor: number.nullable() }).strict();
export type MailClassifierActivity = z.infer<typeof mailClassifierActivitySchema>;
export const mailClassifierDisplayActivitySchema = z.object({ accountId, items: z.array(mailClassifierActivityItemSchema.omit({ project: true }).extend({ project: mailProjectDestinationSchema.nullable(), unavailable: z.boolean() })).max(20), nextCursor: number.nullable() }).strict();
export const mailClassifierReviewActionSchema = z.object({ id: number, expected: mailLocalVersionSchema, assignmentVersion: mailLocalVersionSchema.nullable() }).strict();
export const mailClassifierActionResultSchema = z.object({ accountId, id: number, version: mailLocalVersionSchema, outcome: z.enum(['dismissed', 'undone']) }).strict();
export const mailClassifierReviewCommandSchema = z.discriminatedUnion('operation', [
    z.object({ operation: z.literal('mail.classifier.activity'), accountId, input: mailClassifierActivityInputSchema }).strict(),
    z.object({ operation: z.literal('mail.classifier.dismiss'), accountId, input: mailClassifierReviewActionSchema }).strict(),
    z.object({ operation: z.literal('mail.classifier.undo'), accountId, input: mailClassifierReviewActionSchema }).strict(),
]);
export type MailClassifierReviewCommand = z.infer<typeof mailClassifierReviewCommandSchema>;
export const mailClassifierAutomationCommandSchema = z.discriminatedUnion('operation', [
    z.object({ operation: z.literal('mail.classifier.pending') }).strict(),
    z.object({ operation: z.literal('mail.classifier.commit'), plan: mailClassifierPlanSchema, project: mailProjectReferenceSchema.nullable() }).strict(),
]);
export type MailClassifierAutomationCommand = z.infer<typeof mailClassifierAutomationCommandSchema>;
export const mailClassifierCommitSchema = z.object({ accountId, id: number, outcome: z.enum(['assigned', 'review', 'skipped', 'pending']) }).strict();
export const mailClassifierAutomationResultSchema = z.union([
    z.object({ classifierPending: z.object({ items: z.array(mailClassifierPlanSchema).max(5).refine(items => new Set(items.map(item => item.id)).size === items.length) }).strict() }).strict(),
    z.object({ classifierCommit: mailClassifierCommitSchema }).strict(),
]);
export const mailClassifierReviewResultSchema = z.union([
    z.object({ classifierActivity: mailClassifierActivitySchema }).strict(),
    z.object({ classifierAction: mailClassifierActionResultSchema }).strict(),
]);
export const mailClassifierIncomingResultSchema = z.union([mailClassifierAutomationResultSchema, mailClassifierReviewResultSchema]);
export type MailClassifierIncomingResult = z.infer<typeof mailClassifierIncomingResultSchema>;
export function classifierIncomingMatches(command: MailClassifierAutomationCommand | MailClassifierReviewCommand, value: unknown) {
    const parsed = mailClassifierIncomingResultSchema.safeParse(value);
    if (!parsed.success)
        return false;
    const result = parsed.data;
    if (command.operation === 'mail.classifier.pending')
        return 'classifierPending' in result;
    if (command.operation === 'mail.classifier.commit')
        return 'classifierCommit' in result && result.classifierCommit.accountId === command.plan.accountId && result.classifierCommit.id === command.plan.id;
    if (command.operation === 'mail.classifier.activity') {
        if (!('classifierActivity' in result) || result.classifierActivity.accountId !== command.accountId)
            return false;
        const page = result.classifierActivity, before = command.input.beforeId;
        return page.items.every((item, index) => (before === undefined || item.id < before) && (index === 0 || page.items[index - 1].id > item.id)) && (page.nextCursor === null || (!before || page.nextCursor < before) && (!page.items.length || page.nextCursor <= page.items[page.items.length - 1].id));
    }
    return 'classifierAction' in result && result.classifierAction.accountId === command.accountId && result.classifierAction.id === command.input.id && result.classifierAction.version.generation === command.input.expected.generation && result.classifierAction.version.revision === command.input.expected.revision + 1 && result.classifierAction.outcome === (command.operation === 'mail.classifier.undo' ? 'undone' : 'dismissed');
}
