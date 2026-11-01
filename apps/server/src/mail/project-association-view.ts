import { z } from 'zod';
import { providerMessageKey, providerMessageLocatorSchema } from './model.js';
import { mailLocalVersionSchema } from './local-view.js';

const id = z.string().min(1).max(4096);
export const mailProjectReferenceSchema = z.object({ id, binding: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
export type MailProjectReference = z.infer<typeof mailProjectReferenceSchema>;
export const mailProjectReadSchema = z.object({ locator: providerMessageLocatorSchema }).strict();
export const mailProjectSetSchema = mailProjectReadSchema.extend({ expected: mailLocalVersionSchema.nullable(), project: mailProjectReferenceSchema.nullable() }).strict();
export type MailProjectSet = z.infer<typeof mailProjectSetSchema>;
export const mailProjectHistoryInputSchema = mailProjectReadSchema.extend({ beforeRevision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional() }).strict();
export const mailProjectAssociationSchema = z.object({
  accountId: id, locator: providerMessageLocatorSchema,
  version: mailLocalVersionSchema.nullable(), project: mailProjectReferenceSchema.nullable(), updatedAt: z.number().int().nonnegative().nullable(),
}).strict().refine(value => value.version === null ? value.project === null && value.updatedAt === null : value.updatedAt !== null);
export type MailProjectAssociation = z.infer<typeof mailProjectAssociationSchema>;
export const mailProjectChangeSchema = z.object({ version: mailLocalVersionSchema, project: mailProjectReferenceSchema.nullable(), at: z.number().int().nonnegative(), source: z.literal('manual') }).strict();
export const mailProjectHistorySchema = z.object({ accountId: id, locator: providerMessageLocatorSchema, items: z.array(mailProjectChangeSchema).max(20), nextRevision: z.number().int().positive().nullable() }).strict();
export type MailProjectHistory = z.infer<typeof mailProjectHistorySchema>;
export const mailProjectErrorSchema = z.enum(['not_found', 'conflict', 'unavailable']);
export class MailProjectError extends Error {
  constructor(readonly code: z.infer<typeof mailProjectErrorSchema>) { super('mail_project_' + code); }
}
export const mailProjectCommandSchema = z.discriminatedUnion('operation', [
  z.object({ operation: z.literal('mail.project.read'), accountId: id, input: mailProjectReadSchema }).strict(),
  z.object({ operation: z.literal('mail.project.set'), accountId: id, input: mailProjectSetSchema }).strict(),
  z.object({ operation: z.literal('mail.project.history'), accountId: id, input: mailProjectHistoryInputSchema }).strict(),
]);
export type MailProjectCommand = z.infer<typeof mailProjectCommandSchema>;
export const mailProjectDestinationSchema = mailProjectReferenceSchema.extend({ name: z.string().min(1).max(256) }).strict();
export type MailProjectDestination = z.infer<typeof mailProjectDestinationSchema>;
export const mailProjectCatalogSchema = z.object({ items: z.array(mailProjectDestinationSchema).max(20), nextCursor: id.nullable() }).strict();
export const mailProjectDisplaySchema = z.object({
  accountId: id, locator: providerMessageLocatorSchema, version: mailLocalVersionSchema.nullable(),
  project: mailProjectDestinationSchema.nullable(), unavailable: z.boolean(), updatedAt: z.number().int().nonnegative().nullable(),
}).strict().refine(value => (value.unavailable ? value.project === null : true) && (value.version === null ? value.project === null && value.updatedAt === null && !value.unavailable : value.updatedAt !== null));
export type MailProjectDisplay = z.infer<typeof mailProjectDisplaySchema>;
export const mailProjectDisplayHistorySchema = z.object({
  accountId: id, locator: providerMessageLocatorSchema,
  items: z.array(z.object({ version: mailLocalVersionSchema, project: mailProjectDestinationSchema.nullable(), unavailable: z.boolean(), at: z.number().int().nonnegative(), source: z.literal('manual') }).strict()).max(20),
  nextRevision: z.number().int().positive().nullable(),
}).strict();
export const mailProjectHostInputSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('catalog'), after: id.optional() }).strict(),
  z.object({ action: z.literal('read'), accountId: id, input: mailProjectReadSchema }).strict(),
  z.object({ action: z.literal('set'), accountId: id, input: mailProjectSetSchema }).strict(),
  z.object({ action: z.literal('history'), accountId: id, input: mailProjectHistoryInputSchema }).strict(),
]);
export const mailProjectResultSchema = z.union([
  z.object({ projectAssociation: mailProjectAssociationSchema }).strict(),
  z.object({ projectHistory: mailProjectHistorySchema }).strict(),
  z.object({ projectFailure: mailProjectErrorSchema }).strict(),
]);
export function mailProjectResultMatches(command: MailProjectCommand, value: unknown) {
  const parsed = mailProjectResultSchema.safeParse(value);
  if (!parsed.success) return false;
  const result = parsed.data;
  if ('projectFailure' in result) return true;
  const record = 'projectAssociation' in result ? result.projectAssociation : result.projectHistory;
  if (record.accountId !== command.accountId || providerMessageKey(record.locator) !== providerMessageKey(command.input.locator)) return false;
  if (command.operation === 'mail.project.history') {
    if (!('projectHistory' in result)) return false;
    const page = result.projectHistory, items = page.items;
    return items.every((item, index) => (!command.input.beforeRevision || item.version.revision < command.input.beforeRevision) && (index === 0 || items[index - 1].version.revision > item.version.revision)) && (page.nextRevision === null || items.length > 0 && page.nextRevision === items[items.length - 1].version.revision);
  }
  if (!('projectAssociation' in result)) return false;
  if (command.operation === 'mail.project.read') return true;
  const association = result.projectAssociation, expected = command.input.expected;
  if (JSON.stringify(association.project) !== JSON.stringify(command.input.project)) return false;
  return expected ? association.version?.generation === expected.generation && [expected.revision, expected.revision + 1].includes(association.version.revision) : association.version?.revision === 1 || association.version === null && command.input.project === null;
}
