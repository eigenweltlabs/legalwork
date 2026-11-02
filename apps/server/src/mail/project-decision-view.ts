import { z } from 'zod';
import { mailLocalVersionSchema } from './local-view.js';
export const mailClassifierThresholdSchema = z.enum(['reference_sender', 'reference', 'any_rule']);
export const mailClassifierReasonSchema = z.enum(['sender', 'domain', 'reference', 'subject']);
export const mailClassifierEvidenceRuleSchema = z.object({ id: z.string().uuid(), name: z.string().min(1).max(80), reasons: z.array(mailClassifierReasonSchema).min(1).max(4) }).strict();
export const mailProjectDecisionSchema = z.object({ arrivalId: z.number().int().positive(), configVersion: mailLocalVersionSchema, threshold: mailClassifierThresholdSchema, rules: z.array(mailClassifierEvidenceRuleSchema).min(1).max(20) }).strict();
export type MailProjectDecision = z.infer<typeof mailProjectDecisionSchema>;
export const mailProjectSourceSchema = z.enum(['manual', 'automatic']);
