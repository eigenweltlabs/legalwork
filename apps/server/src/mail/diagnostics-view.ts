import { z } from 'zod';

const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const actions = z.object({ queued: count, running: count, dispatching: count, retry: count,
  succeeded: count, failed: count, cancelled: count, uncertain: count }).strict();
const content = z.object({ pending: count, stored: count, unavailable: count }).strict();
export const mailDiagnosticSnapshotSchema = z.object({
  schemaVersion: count,
  lifecycle: z.enum(['running', 'suspended']),
  accounts: z.object({ gmail: count, graph: count, imap: count, archive: count, retainedCopies: count }).strict(),
  messages: z.object({ total: count, attachmentsEnumerated: count }).strict(),
  originals: content,
  attachments: content,
  syncJobs: z.object({ queued: count, running: count, retry: count, succeeded: count, failed: count }).strict(),
  mutations: actions,
  submissions: actions,
  drafts: z.object({ active: count, deleted: count }).strict(),
  schedules: z.object({ queued: count, due: count }).strict(),
  search: z.object({ indexed: count, pending: count }).strict(),
  invitationReplies: z.object({ confirmed: count, rejected: count, uncertain: count }).strict(),
}).strict();

/** A closed allowlist: no account/message IDs, addresses, arbitrary errors, paths or text. */
export const mailDiagnosticsSchema = z.object({
  format: z.literal('legalwork-mail-diagnostics'),
  version: z.literal(1),
  generatedAt: z.string().datetime(),
  state: z.enum(['locked', 'unlocking', 'ready', 'unavailable', 'locking', 'stopped']),
  snapshot: mailDiagnosticSnapshotSchema.nullable(),
}).strict().superRefine((value, context) => {
  if ((value.state === 'ready') !== (value.snapshot !== null)) context.addIssue({ code: 'custom', message: 'Snapshot requires ready storage' });
});
export type MailDiagnosticSnapshot = z.infer<typeof mailDiagnosticSnapshotSchema>;
export type MailDiagnostics = z.infer<typeof mailDiagnosticsSchema>;
